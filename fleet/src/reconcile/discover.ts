// discover.ts — zero-touch join: discover, adopt and repair (blueprint
// fleet2-zero-touch-join, 5.6.0 r7).
//
// Membership used to be a static enrolled.tsv: a box on the tailnet with sshd
// up but no enrolment was invisible to the tick, and after an image swap
// nothing repaired a lost VPS-side artefact or [fleet] block. This module makes
// the engine do both itself.
//
// Two passes, deliberately on opposite sides of the membership loop (D1):
//   adopt  — BEFORE the loop and before the empty-membership early return, so a
//            brand-new VPS with an empty enrolled.tsv still adopts;
//   repair — AFTER the loop, because its trigger is this tick's per-box
//            tunnel/online reading and row-e outcome, which only exist once the
//            loop has run.
// They share one mutation slot per tick (D6c, repair outranks adopt), one time
// budget (D6d) and one backoff ledger (D4).
//
// Everything that touches a box or the API is behind the DiscoverDeps seam, so
// the whole file is unit-testable with stubbed transports.

import type { DiscoverRow } from "../commands/list.ts";
import { boxIndex } from "../boxes.ts";
import type { ReconcileStateApi, DiscoverRecord } from "./state.ts";
import { log } from "../log.ts";

// --- constants ---------------------------------------------------------------

/** D2: an explicit -o ConnectTimeout for discover calls only. */
export const DISCOVER_CONNECT_TIMEOUT_S = 20;
/** D6d: cumulative discover-work budget for a tick (probes + checks + status). */
export const DISCOVER_BUDGET_MS = 60_000;
/** D6d: the adopt side's share of it. The remaining 30 s is RESERVED for repair. */
export const DISCOVER_ADOPT_BUDGET_MS = 30_000;
/** The repair side's reserved share (the remainder of the pool). */
export const DISCOVER_REPAIR_BUDGET_MS = DISCOVER_BUDGET_MS - DISCOVER_ADOPT_BUDGET_MS;
/** Ceiling of one tailnet probe / content check (the box-ssh deadline). */
export const DISCOVER_PROBE_CEILING_MS = 20_000;
/** Ceiling of the `tailscale status --json` parse. */
export const DISCOVER_LIST_CEILING_MS = 15_000;
/** D4: backoff doubles 1,2,4,… ticks and is capped here. */
export const DISCOVER_BACKOFF_CAP_TICKS = 12;
/** Ledger prune: forget a record untouched for this many ticks (~24 h at 5 min). */
export const DISCOVER_PRUNE_TICKS = 288;
/** Ledger file cap: keep at most this many records, most-recent first. */
export const DISCOVER_MAX_RECORDS = 64;
/** P3: advisory only — a lower boxup is logged, never a skip. */
export const DISCOVER_MIN_BOXUP = "5.3.0";

/** Candidate name shape (D1). A 3-digit name is the only adoptable one. */
const CANDIDATE_RE = /^grok-box-[0-9]{3}$/;
/** Legacy 1–2 digit name ⇒ skipped:needs-rename, never adopted (D1). */
const LEGACY_RE = /^grok-box-[0-9]{1,2}$/;

// --- wire shapes -------------------------------------------------------------

/** D7: the optional `discover` object on a snapshot line. */
export interface DiscoverSummary {
  candidates: number;
  adopted: number;
  repaired: number;
  skipped: Array<{ name: string; reason: string }>;
}

/** What a reachability probe learned about a candidate. */
export interface ProbeOutcome {
  /** `ssh … true` succeeded. */
  reachable: boolean;
  /**
   * `/workspace/box-setup/hostname` content, "" when the file is absent or
   * empty. install.sh's default IS empty, and an empty file is NO OPINION
   * (D6b) — only a NON-EMPTY mismatch is a rail.
   */
  hostname: string;
  /** parsed `boxup version`, or undefined when missing/unparsable (P3). */
  boxup: string | undefined;
  /**
   * D11(c): the probe hit OpenSSH's REMOTE HOST IDENTIFICATION HAS CHANGED
   * banner on the TAILNET spec — a reused NAME, not a reused port. Only ever
   * true together with `reachable: false`.
   */
  hostkeyMismatch?: boolean;
}

/** What the repair content checks found (D5). */
export interface RepairFindings {
  /** false ⇒ the checks could not be completed (box unreachable). */
  ok: boolean;
  /** true iff every content check matched. */
  coherent: boolean;
  /** the first mismatching check, for the log line. */
  reason: string;
}

/** The result of one in-process adoption (D3/D6d). */
export interface AdoptOutcome {
  /** cmdEnroll's rc (its rc map is preserved). */
  rc: number;
  /** the named abort point when a remote step hit its ceiling (D6d). */
  timeoutPoint?: string;
  /**
   * state-store D6/r5-B4: the enrolment COMMITTED to the store and the legacy
   * export lagged. `rc` is still 0, so this is an ADOPTION — one warning line,
   * never a ledger failure and never a wasted slot.
   */
  exportError?: string;
}

/** The injectable transport/orchestration seam. */
export interface DiscoverDeps {
  /** P1: a readable Tailscale API token was found THIS tick (preflighted once). */
  apiToken: boolean;
  /** P2: the resolved box ssh password; undefined ⇒ refuse (no ssh at all). */
  boxPassword: string | undefined;
  /** the VPS's own `tailscale status --json`, already parsed (D1). */
  listPeers(): Promise<DiscoverRow[]>;
  /** reachability + advisory reads over the tailnet (D2). */
  probe(box: string): Promise<ProbeOutcome>;
  /** the D3 path: cmdEnroll in-process with tunnel wait 0. */
  adopt(box: string): Promise<AdoptOutcome>;
  /** the D5 content checks. */
  inspect(box: string): Promise<RepairFindings>;
  /**
   * D11(b): forget a box's known_hosts pins at an identity-binding moment.
   * "tailnet" is the candidate re-probe (an unenrolled box has no tunnel of
   * ours); "both" is the repair, which is about the tunnel spec.
   */
  forgetHostKeys(box: string, scope: "both" | "tailnet"): Promise<void>;
}

/**
 * state-store D5: the `enrolling` rows the RESUME pass owns, and the enrol-stuck
 * alert. Absent on a caller with no store (the box-free discover tests), which
 * is exactly the 5.8.0 behaviour: no resume pass and no enrolling rows.
 */
export interface EnrolSurface {
  /** `enrolling` rows, OLDEST `created_at` first. */
  rows(): Array<{ name: string; stage: number; streak: number; created_at: number }>;
  /**
   * An attempted stage just FAILED. Fires `enrol-stuck` when the row's streak
   * has reached 3 — three attempted-and-failed STAGES, not three ticks — and
   * then at most once per 24 h, throttled through the `alerts` table.
   */
  stuck(box: string): Promise<void>;
}

/** Per-tick facts the caller supplies. */
export interface DiscoverTick {
  state: ReconcileStateApi;
  /** the tick ordinal (ReconcileState.bumpTick). */
  tick: number;
  /** the run-wide read-only latch (D4). */
  readonly: boolean;
  apply: boolean;
  /** the resolved membership for THIS tick (`phase='enrolled'` from 5.8.0). */
  membership: string[];
  /**
   * state-store D4: names the store holds as `retired` or `enrolling`, read ONCE
   * per tick with membership. `selectCandidates` drops them silently. Absent on
   * a caller that has no store (tests) — the default is an empty map, so every
   * existing two-argument call keeps its behaviour.
   */
  excluded?: Map<string, "retired" | "enrolling">;
  /** state-store D5: the resume pass's view of the store. Omitted ⇒ no resumes. */
  enrol?: EnrolSurface;
  nowSec: number;
  /** monotonic milliseconds; injected so the budget is deterministic in tests. */
  nowMs(): number;
}

// --- pure helpers ------------------------------------------------------------

/** D4: 1,2,4,… ticks, capped at DISCOVER_BACKOFF_CAP_TICKS. */
export function backoffTicks(failures: number): number {
  if (failures <= 0) return 0;
  const exp = 2 ** Math.min(failures - 1, 30);
  return Math.min(exp, DISCOVER_BACKOFF_CAP_TICKS);
}

/** `boxup version` prints `boxup <x.y.z>`; anything else is unparsable (P3). */
export function parseBoxupVersion(out: string): string | undefined {
  for (const line of out.split("\n")) {
    const m = /^boxup\s+([0-9]+\.[0-9]+\.[0-9]+)\s*$/.exec(line.trim());
    if (m) return m[1];
  }
  return undefined;
}

/** The base64 key material of an authorized_keys / pubkey line. */
export function keyMaterial(line: string): string {
  const f = line.trim().split(/\s+/);
  // a restricted line is `<options> ssh-ed25519 <material> [comment]`; a bare
  // pubkey is `ssh-ed25519 <material> [comment]`.
  for (let i = 0; i < f.length - 1; i++) {
    if (f[i]!.startsWith("ssh-")) return f[i + 1]!;
  }
  return "";
}

/**
 * D5 content check: the fleet user's authorized_keys must carry EXACTLY ONE
 * line for this port, and that line's key material must be the box's CURRENT
 * tunnel pubkey. Presence alone is not enough — a box that regenerated its key
 * leaves a line that looks right and authenticates nothing.
 */
export function authorizedKeysCoherent(content: string, port: number, pubkey: string): boolean {
  const needle = `permitlisten="127.0.0.1:${port}"`;
  const lines = content.split("\n").filter((l) => l.includes(needle));
  if (lines.length !== 1) return false;
  const want = keyMaterial(pubkey);
  return want !== "" && keyMaterial(lines[0]!) === want;
}

/** D5 content check: the /etc mapping must name this box, port and key. */
export function mapCoherent(content: string, box: string, port: number, pubkey: string): boolean {
  const want = keyMaterial(pubkey);
  if (want === "") return false;
  const rows = content.split("\n").filter((l) => l.startsWith(`${box}\t`));
  if (rows.length !== 1) return false;
  const f = rows[0]!.split("\t");
  return f[1] === String(port) && (f[2] ?? "").trim() === want;
}

/**
 * D5 content check: the box's `[fleet]` block must name THIS VPS and the
 * correct box_index. Section-scoped and comment-blind, mirroring the awk in
 * WRITE_BOX_CONFIG_REMOTE (an active `key = value` inside `[fleet]`).
 */
export function fleetBlockCoherent(configToml: string, vps: string, index: number): boolean {
  let inFleet = false;
  let sawVps = false;
  let sawIdx = false;
  for (const raw of configToml.split("\n")) {
    const t = raw.trim();
    if (t.startsWith("[")) {
      inFleet = t === "[fleet]";
      continue;
    }
    if (!inFleet || t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
    if (k === "vps") sawVps = v === vps;
    if (k === "box_index") sawIdx = v === String(index);
  }
  return sawVps && sawIdx;
}

export interface CandidateSelection {
  candidates: string[];
  skipped: Array<{ name: string; reason: string }>;
  /** names skipped with an ERROR-severity reason (D6a). */
  errors: string[];
}

/**
 * D1 candidate rule + the D6a index rail, pure.
 *
 * A peer is a candidate iff its name matches ^grok-box-\d{3}$, it is online,
 * it is NOT in the resolved membership, and its index collides with no enrolled
 * box's index. Tags are NOT gated — a URL-approved box arrives untagged and
 * tagging happens after adoption through the existing mint/retag path.
 *
 * `DiscoverRow.online` is the STRING "yes"/"no" (parseDiscover), not a boolean.
 */
export function selectCandidates(
  rows: DiscoverRow[],
  membership: string[],
  excluded: Map<string, "retired" | "enrolling"> = new Map(),
): CandidateSelection {
  const enrolled = new Set(membership);
  const enrolledIdx = new Map<number, string>();
  for (const m of membership) {
    const i = boxIndex(m);
    if (i !== undefined && !enrolledIdx.has(i)) enrolledIdx.set(i, m);
  }
  const candidates: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const errors: string[] = [];
  for (const r of [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (enrolled.has(r.name)) continue; // already a member — not a discovery concern
    if (r.online !== "yes") continue; // offline peers are silently uninteresting
    // state-store D4/r3-B5: a name the store holds as `retired` or `enrolling`
    // is NOT adoptable and is dropped SILENTLY — no `skipped` entry. A skip
    // reason is a transient fact; a retired box parked on the tailnet would
    // otherwise emit ~26k `snapshot_skipped` rows per retention window. The
    // retire audit row and `fleet2 state check` are the record instead.
    //
    // This exclusion ships in PHASE A (the `phase` column is in schema v1), so a
    // 5.8.0 binary rolled back from Phase B never adopts an `enrolling` or
    // `retired` name and never spends the mutation slot on it. Removing the VPS
    // authorized_keys line alone would not stop re-adoption: the discover probe
    // reaches boxes by PASSWORD over the tailnet, not through the tunnel.
    if (excluded.has(r.name)) continue;
    if (!CANDIDATE_RE.test(r.name)) {
      // A legacy 1–2 digit name is REPORTED (an operator must rename it); any
      // other shape parseDiscover let through is simply not ours.
      if (LEGACY_RE.test(r.name)) skipped.push({ name: r.name, reason: "needs-rename" });
      continue;
    }
    const idx = boxIndex(r.name);
    if (idx === undefined) continue;
    const clash = enrolledIdx.get(idx);
    if (clash !== undefined) {
      skipped.push({ name: r.name, reason: "index-collision" });
      errors.push(`${r.name} (index ${idx} already held by ${clash})`);
      continue;
    }
    candidates.push(r.name);
  }
  return { candidates, skipped, errors };
}

/**
 * D6d budget. One CUMULATIVE accumulator over discover work only — it is never
 * running while the membership loop is, so a slow or unhealthy fleet cannot
 * starve repair. The pool is SPLIT, not first-come: adopt-side probes may spend
 * at most DISCOVER_ADOPT_BUDGET_MS and the remainder is RESERVED for repair,
 * unused reserve simply going unused.
 *
 * "Past its share, each side stops STARTING new probes" is enforced as: a probe
 * may start only when its own CEILING still fits in the side's share and in the
 * pool. That is the reading D6d's own arithmetic requires — with the looser
 * "start if any share remains" a probe begun at share-ε overruns it, and the
 * stated 60 s + 30 s + 3 × 20 s = 2.5 min worst case would not hold.
 */
export class DiscoverBudget {
  private total = 0;
  private adopt = 0;
  private repair = 0;
  constructor(private readonly clock: () => number) {}

  /** May this side start a piece of work with the given ceiling? */
  canStart(side: "adopt" | "repair", ceilingMs: number): boolean {
    if (this.total + ceilingMs > DISCOVER_BUDGET_MS) return false;
    const spent = side === "adopt" ? this.adopt : this.repair;
    const share = side === "adopt" ? DISCOVER_ADOPT_BUDGET_MS : DISCOVER_REPAIR_BUDGET_MS;
    return spent + ceilingMs <= share;
  }

  /** Time one piece of work, charging the pool and (optionally) a side. */
  async spend<T>(side: "adopt" | "repair" | "shared", fn: () => Promise<T>): Promise<T> {
    const t0 = this.clock();
    try {
      return await fn();
    } finally {
      const dt = Math.max(0, this.clock() - t0);
      this.total += dt;
      if (side === "adopt") this.adopt += dt;
      else if (side === "repair") this.repair += dt;
    }
  }

  /** Milliseconds of discover work charged so far (for the log line). */
  spent(): { total: number; adopt: number; repair: number } {
    return { total: this.total, adopt: this.adopt, repair: this.repair };
  }
}

// --- the run -----------------------------------------------------------------

/**
 * One tick's discovery. Construct it after the devices GET (so the read-only
 * latch is final), run `adoptPass()` before the membership loop and
 * `repairPass()` after it, then `finish()` before the snapshot is written.
 */
export class DiscoverRun {
  readonly summary: DiscoverSummary = { candidates: 0, adopted: 0, repaired: 0, skipped: [] };
  private readonly budget: DiscoverBudget;
  private ledger: DiscoverRecord[];
  private slotUsed = false;
  private latchLogged = false;

  constructor(
    private readonly deps: DiscoverDeps,
    private readonly tick: DiscoverTick,
  ) {
    this.budget = new DiscoverBudget(tick.nowMs);
    this.ledger = tick.state.readDiscoverLedger();
  }

  // --- ledger ----------------------------------------------------------------

  private record(name: string): DiscoverRecord | undefined {
    return this.ledger.find((r) => r.name === name);
  }

  /** D4: is this box still inside its backoff window? */
  private inBackoff(name: string): number | undefined {
    const rec = this.record(name);
    if (rec === undefined || rec.failures <= 0) return undefined;
    const wait = backoffTicks(rec.failures);
    const elapsed = this.tick.tick - rec.last_tick;
    return elapsed >= wait ? undefined : rec.failures;
  }

  /** D4: record a per-box failure (never under the read-only latch). */
  private recordFailure(name: string, reason: string): void {
    const rec = this.record(name);
    if (rec === undefined) {
      this.ledger.push({
        name,
        last_attempt: this.tick.nowSec,
        failures: 1,
        reason,
        last_tick: this.tick.tick,
      });
    } else {
      rec.failures += 1;
      rec.reason = reason;
      rec.last_attempt = this.tick.nowSec;
      rec.last_tick = this.tick.tick;
    }
  }

  /** D4: success clears the record. */
  private clearFailure(name: string): void {
    this.ledger = this.ledger.filter((r) => r.name !== name);
  }

  private skip(name: string, reason: string, detail?: string): void {
    this.summary.skipped.push({ name, reason });
    log(`discover: skipped ${name} (${detail ?? reason})`);
  }

  // --- preconditions ---------------------------------------------------------

  /** D4: a tick that reports itself read-only never adopts and never repairs. */
  private latched(): boolean {
    if (!this.tick.readonly) return false;
    if (!this.latchLogged) {
      log("discover: skipped (readonly latch)");
      this.latchLogged = true;
    }
    return true;
  }

  /**
   * P1/P2 preflight. Absent token or absent password ⇒ every name is skipped
   * with the stated reason, NO ssh is performed and NO backoff record is
   * written (a precondition failure is not the box's fault).
   */
  private preflight(names: string[]): boolean {
    if (!this.deps.apiToken) {
      for (const n of names) this.skip(n, "no-api-token", "no-api-token: no readable Tailscale API token this tick");
      return false;
    }
    if (this.deps.boxPassword === undefined) {
      for (const n of names) {
        this.skip(n, "no-box-password", "no-box-password: set BOX_PASSWD via vps/install-vps.sh");
      }
      return false;
    }
    return true;
  }

  /**
   * D6c slot priority: repair outranks adopt. Adopt runs first by placement, so
   * it YIELDS whenever any box carries a LIVE repair_pending_runs marker >= 1
   * stamped by the IMMEDIATELY PRECEDING tick — i.e. a repair is possibly due
   * this tick. If the repair then does not fire, the slot is simply unused.
   */
  private pendingRepairBox(): string | undefined {
    for (const box of this.tick.membership) {
      const m = this.tick.state.readRepairPending(box);
      if (m !== undefined && m.runs >= 1 && m.tick === this.tick.tick - 1) return box;
    }
    return undefined;
  }

  /**
   * state-store D5: an `enrolling` row that is NOT inside its backoff window,
   * i.e. one the resume pass may actually spend the slot on this tick.
   *
   * The backoff test is what stops a permanently unreachable half-enrolled box
   * from starving every candidate behind it: the row is due on the ticks its
   * ladder allows and invisible to this check on the rest, so adopt runs then.
   * Mutant (m14) drops the test and the starvation ladder fails.
   */
  private pendingEnrolRow(): string | undefined {
    for (const r of this.tick.enrol?.rows() ?? []) {
      if (this.inBackoff(r.name) === undefined) return r.name;
    }
    return undefined;
  }

  // --- adopt -----------------------------------------------------------------

  async adoptPass(): Promise<void> {
    if (this.latched()) return;

    const peers = await this.budget.spend("shared", () => this.deps.listPeers());
    const sel = selectCandidates(peers, this.tick.membership, this.tick.excluded ?? new Map());
    this.summary.candidates = sel.candidates.length;
    for (const s of sel.skipped) {
      const err = sel.errors.find((e) => e.startsWith(`${s.name} `));
      if (s.reason === "index-collision") {
        this.summary.skipped.push(s);
        log(`discover: ERROR ${s.reason} — ${err ?? s.name}`);
      } else {
        this.skip(s.name, s.reason);
      }
    }
    if (sel.candidates.length === 0) return;
    if (!this.preflight(sel.candidates)) return;

    // D6c + state-store D5/r4-B3/r5-B1/r6-B1: the yield is a DISJUNCTION. Adopt
    // yields when the EXISTING tick-1 repair probe fires (unchanged, so repair's
    // priority over adopt from the zero-touch-join work is intact on a fleet
    // with no enrolling rows) OR when an `enrolling` row exists and is not in
    // backoff. Parity plays NO part here — it is only the tie-break INSIDE
    // repairPass. Mutant (m16) drops the repair disjunct.
    const pending = this.pendingRepairBox() ?? this.pendingEnrolRow();
    if (pending !== undefined) {
      log(`discover: adopt deferred (repair/resume pending on ${pending})`);
      return;
    }

    for (const name of sel.candidates) {
      const failures = this.inBackoff(name);
      if (failures !== undefined) {
        this.skip(name, "backoff", `backoff after ${failures} failures`);
        continue;
      }
      if (!this.budget.canStart("adopt", DISCOVER_PROBE_CEILING_MS)) {
        log(`discover: adopt budget spent (${this.budget.spent().adopt}ms) — ${name} and any remaining candidates deferred`);
        return;
      }
      let p = await this.budget.spend("adopt", () => this.deps.probe(name));
      // D11(c) candidate re-probe. A CANDIDATE is not in membership, so a banner
      // on its tailnet name is a reused NAME — a retired record, or a box that
      // lost /workspace. D2 already concedes tailnet membership plus the
      // password as the identity boundary for an unenrolled box, and accept-new
      // pins whatever it sees on first contact, so forgetting the tailnet pin
      // and probing ONCE more is the same trust decision made twice. One added
      // remote call, on the candidate path only, inside the adopt share.
      if (!p.reachable && p.hostkeyMismatch === true) {
        await this.deps.forgetHostKeys(name, "tailnet");
        p = await this.budget.spend("adopt", () => this.deps.probe(name));
      }
      if (!p.reachable) {
        this.recordFailure(name, "unreachable");
        this.skip(name, "unreachable");
        continue;
      }
      // D6b: a NON-EMPTY hostname file that disagrees with the tailscale name is
      // a rail; absent or empty (install.sh's default) is NO OPINION.
      if (p.hostname !== "" && p.hostname !== name) {
        this.skip(name, "name-mismatch", `name-mismatch: box-setup/hostname says '${p.hostname}'`);
        continue;
      }
      // P3: reachability implies boxup, so a missing/unparsable version is an
      // operator signal, not an install trigger — discover has no install path.
      if (p.boxup === undefined) {
        this.skip(name, "boxup-missing");
        continue;
      }
      if (!this.tick.apply) {
        // Dry-run reports EVERY eligible candidate, not just the one the cap
        // would admit, so the operator sees the whole picture before flipping
        // apply. Nothing on the mutation surface is touched.
        log(`discover: would adopt ${name} (online, unenrolled, boxup ${p.boxup})`);
        continue;
      }
      if (this.slotUsed) return; // D6c: at most one mutation per tick
      const r = await this.deps.adopt(name);
      this.slotUsed = true; // a partial enrol IS a mutation — the slot is spent
      if (r.rc === 0) {
        this.summary.adopted += 1;
        this.clearFailure(name);
        log(`discover: adopted ${name} (boxup ${p.boxup}) — tunnel proven on the next tick`);
        if (r.exportError !== undefined) {
          // The store row is committed; only the file a rolled-back 5.7.1 would
          // read is stale. The tick reports it once and returns rc 7.
          log(`discover: ${name} recorded; legacy export failed: ${r.exportError}`);
        }
      } else {
        const reason = r.timeoutPoint !== undefined ? `timeout-${r.timeoutPoint}` : `enroll-rc${r.rc}`;
        this.recordFailure(name, reason);
        this.skip(name, reason);
      }
      return;
    }
  }

  // --- repair ----------------------------------------------------------------

  /**
   * D5. A box IN membership whose tunnel is down while the box is live (row e)
   * becomes a repair candidate only after the condition has held for >= 2
   * CONSECUTIVE ticks. Repair fires only on a marker stamped by the CURRENT
   * tick — this tick's row-e evaluation has already stamped it inside the loop.
   * Repair does NOT suppress the row-e alert; it adds its own line.
   */
  async repairPass(): Promise<void> {
    if (this.latched()) return;
    const repairDue = this.tick.membership.filter((box) => {
      const m = this.tick.state.readRepairPending(box);
      return m !== undefined && m.tick === this.tick.tick && m.runs >= 2;
    });
    // state-store D5: the RESUME work lives in this pass — no third pass and no
    // third budget share. An `enrolling` row inside its backoff window is not
    // due (the ladder is what keeps it from starving the adopt slot).
    const resumeDue = (this.tick.enrol?.rows() ?? [])
      .filter((r) => this.inBackoff(r.name) === undefined)
      .map((r) => r.name);
    if (repairDue.length === 0 && resumeDue.length === 0) return;
    if (!this.preflight([...repairDue, ...resumeDue])) return;

    // D5 ordering: repair-marker boxes (enrolled boxes that are BROKEN) before
    // enrolling rows (oldest `created_at` first, the order the surface returns).
    // When BOTH are due they alternate by tick parity — even `tick_seq` repair
    // first, odd resume first — so neither starves the other across ticks.
    const repairItems = repairDue.map((name) => ({ name, resume: false }));
    const resumeItems = resumeDue.map((name) => ({ name, resume: true }));
    const order =
      this.tick.tick % 2 === 0 ? [...repairItems, ...resumeItems] : [...resumeItems, ...repairItems];

    for (const item of order) {
      const box = item.name;
      if (this.slotUsed) return; // D6c cap, shared with adopt
      const failures = this.inBackoff(box);
      if (failures !== undefined) {
        this.skip(box, "backoff", `backoff after ${failures} failures`);
        continue;
      }
      if (!this.budget.canStart("repair", DISCOVER_PROBE_CEILING_MS)) {
        log(`discover: repair budget spent (${this.budget.spent().repair}ms) — ${box} deferred`);
        return;
      }
      if (item.resume) {
        await this.resumeOne(box);
        if (this.slotUsed) return;
        continue;
      }
      // D11(b)(ii): a box carrying the mismatch marker gets its pins forgotten
      // BEFORE the content checks — otherwise the tailnet reads hit the banner
      // and the repair could never fire. For a mismatch the forget IS the cure:
      // the artefacts are coherent and `adopt` rewrites byte-identical content,
      // but the repair still consumes this tick's single mutation slot.
      //
      // The marker being CLEAR is load-bearing too (the flapping case): a box
      // whose counter reached 2 across alternating mismatch and row-e ticks
      // must NOT be forgotten here. `inspect` then finds a rotated box coherent
      // and the repair is a deliberate NO-OP that spends no slot; the cure
      // lands on the next mismatch tick.
      if (this.tick.state.readHostkeyMismatch(box)) {
        await this.deps.forgetHostKeys(box, "both");
      }
      const f = await this.budget.spend("repair", () => this.deps.inspect(box));
      if (!f.ok) {
        this.recordFailure(box, "unreachable");
        this.skip(box, "unreachable");
        continue;
      }
      if (f.coherent) {
        log(`repair: ${box} enrolment artefacts coherent — nothing to repair`);
        continue;
      }
      if (!this.tick.apply) {
        log(`repair: would repair ${box} (${f.reason})`);
        continue;
      }
      const r = await this.deps.adopt(box);
      this.slotUsed = true;
      if (r.rc === 0) {
        this.summary.repaired += 1;
        this.clearFailure(box);
        log(`repair: ${box} repaired (${f.reason})`);
      } else {
        const reason = r.timeoutPoint !== undefined ? `timeout-${r.timeoutPoint}` : `enroll-rc${r.rc}`;
        this.recordFailure(box, reason);
        this.skip(box, reason);
      }
      return;
    }
  }

  /**
   * state-store D5: RESUME one half-enrolled box. `deps.adopt` runs the SAME
   * enrol saga the adopt path runs — `beginEnrol` reads the row's recorded
   * `enrol_stage` and re-runs stages `enrol_stage+1 … 5`, so this needs no
   * separate transport.
   *
   * Two ssh stages rarely fit inside repair's 30 s reserve and `canStart`'s 20 s
   * ceiling, so a resume advances AT LEAST one stage per tick it runs. That is
   * stated behaviour, not a defect: the row records how far it got and the next
   * tick continues.
   *
   * FAILURE accounting (D5): only an ATTEMPTED stage that returned failure is a
   * failure. The saga hooks bump `enrol_fail_streak` and set `enrol_warn`; this
   * records the `discover_ledger` failure that drives the doubling backoff, and
   * asks the alert surface whether the streak has reached `enrol-stuck`. A
   * budget deferral, a preflight skip and a lost slot never reach here.
   */
  private async resumeOne(box: string): Promise<void> {
    if (!this.tick.apply) {
      const row = this.tick.enrol?.rows().find((r) => r.name === box);
      log(`resume: would resume ${box} from enrol stage ${row?.stage ?? 0} (dry-run/no-apply)`);
      return;
    }
    const r = await this.budget.spend("repair", () => this.deps.adopt(box));
    this.slotUsed = true; // a partial enrol IS a mutation — the slot is spent
    if (r.rc === 0) {
      this.summary.adopted += 1;
      this.clearFailure(box);
      log(`resume: ${box} enrolment completed — tunnel proven on the next tick`);
      if (r.exportError !== undefined) {
        log(`resume: ${box} recorded; legacy export failed: ${r.exportError}`);
      }
      return;
    }
    const reason = r.timeoutPoint !== undefined ? `timeout-${r.timeoutPoint}` : `enroll-rc${r.rc}`;
    this.recordFailure(box, reason);
    this.skip(box, reason);
    await this.tick.enrol?.stuck(box);
  }

  // --- finish ----------------------------------------------------------------

  /**
   * Prune and persist the ledger. Without a drop rule an indefinitely offline
   * box would accrue a record forever: anything untouched for
   * DISCOVER_PRUNE_TICKS is forgotten (its backoff has long since capped, so
   * re-learning costs one probe), and the file is capped at
   * DISCOVER_MAX_RECORDS, most-recently-attempted first.
   */
  finish(): void {
    let recs = this.ledger.filter((r) => this.tick.tick - r.last_tick <= DISCOVER_PRUNE_TICKS);
    if (recs.length > DISCOVER_MAX_RECORDS) {
      recs = [...recs].sort((a, b) => b.last_tick - a.last_tick).slice(0, DISCOVER_MAX_RECORDS);
    }
    this.ledger = recs;
    // D4: discover.json is written on EVERY tick, dry-run included — the same
    // normal engine behaviour as the snapshot line and the state markers.
    this.tick.state.writeDiscoverLedger(recs);
  }
}
