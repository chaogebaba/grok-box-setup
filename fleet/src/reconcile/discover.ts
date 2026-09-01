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
import type { ReconcileState, DiscoverRecord } from "./state.ts";
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
}

/** Per-tick facts the caller supplies. */
export interface DiscoverTick {
  state: ReconcileState;
  /** the tick ordinal (ReconcileState.bumpTick). */
  tick: number;
  /** the run-wide read-only latch (D4). */
  readonly: boolean;
  apply: boolean;
  /** the resolved membership for THIS tick. */
  membership: string[];
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
export function selectCandidates(rows: DiscoverRow[], membership: string[]): CandidateSelection {
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

  // --- adopt -----------------------------------------------------------------

  async adoptPass(): Promise<void> {
    if (this.latched()) return;

    const peers = await this.budget.spend("shared", () => this.deps.listPeers());
    const sel = selectCandidates(peers, this.tick.membership);
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

    const pending = this.pendingRepairBox();
    if (pending !== undefined) {
      log(`discover: adopt deferred (repair pending on ${pending})`);
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
      const p = await this.budget.spend("adopt", () => this.deps.probe(name));
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
    const due = this.tick.membership.filter((box) => {
      const m = this.tick.state.readRepairPending(box);
      return m !== undefined && m.tick === this.tick.tick && m.runs >= 2;
    });
    if (due.length === 0) return;
    if (!this.preflight(due)) return;

    for (const box of due) {
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
