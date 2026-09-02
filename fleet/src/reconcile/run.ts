// run.ts — cmd_reconcile port (main:2526-2616), the whole tick (D12/F4).
//
// Order: argparse (--apply/--dry-run/unknown⇒rc2) is done by the CLI BEFORE the
// lock. This function runs AFTER the lock is held (P3/F4: reconcile takes the
// lock UNCONDITIONALLY; lock-held⇒rc0 is the CLI's mapping). Steps:
//   1. RECONCILE_READONLY=0 (RunContext); D4/F5 backoff check → devices GET.
//   2. non-2xx / malformed 200 ⇒ record api failure + latch + devs="".
//   3. target boxes (parseEnrolled / FLEET_BOXES); none ⇒ rc 0.
//   4. per-box loop (SERIAL, F12): inputs → decide → dispatch. Any reconcile_one
//      failure ⇒ run rc 1.
//   5. rollout once (F8) over the collected drifted set.
//   6. config pass (rc LOGGED, never folded — D6c).
//   7. identity pass (log-only).
//   8. `reconcile: done (<MODE>)`; return rc.
// H1: reconcile mode token is UPPERCASE (DRY-RUN/APPLY). H2: the WOULD line's
// `read-only ` prefix is UNCONDITIONAL (bash bug preserved — see the comment).

import type { Runner } from "../runner.ts";
import type { Env } from "../env.ts";
import type { RolloutConfig } from "../config.ts";
import type { NotifyLevel } from "../notify.ts";
import { tunnelUp, tunnelSsh, makeWarnOnce, type TunnelDeps } from "../tunnel.ts";
import { isHostKeyMismatch, knownHostsFile } from "../hostkey.ts";
import { boxIndex, portFor } from "../boxes.ts";
import { CHECK_COMMAND, STATUS_COMMAND } from "../remote.ts";
import { parseCheck, parseStatusLine } from "../status.ts";
import type { ReconcileStateApi } from "./state.ts";
import { RunContext, TailscaleKeys } from "./tailscale-keys.ts";
import { decide } from "./decide.ts";
import { devFields, daysUntil } from "./inputs.ts";
import { alertAsleep, alertIncoherent } from "./alerts.ts";
import { identityPass } from "./identity.ts";
import { mintKey, mintWindowValid, type MintDeps } from "../actions/mint.ts";
import { rotate } from "../actions/rotate.ts";
import { dedup } from "../actions/dedup.ts";
import { runRolloutOnce, type DriftedBox } from "../actions/rollout.ts";
import { configPass, type ConfigPassDeps } from "../actions/config-pass.ts";
import type { ManagedSource } from "../actions/config-push.ts";
import type { UpgradeDeps } from "../upgrade.ts";
import { log } from "../log.ts";
import { splitVersion } from "../status.ts";
import type { SnapshotBox, SnapshotLine } from "../history/schema.ts";
import { DiscoverRun, type DiscoverDeps, type DiscoverSummary } from "./discover.ts";
import type { Store } from "../store/db.ts";
import type { StoreState } from "../store/state.ts";
import { checkDivergence } from "../store/divergence.ts";
import { dailyMaintenance } from "../store/backup.ts";
import { AUDIT_RETENTION_DAYS } from "../store/schema.ts";

const CHECK_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 20_000;
const BOX_ROOT = "/workspace/box-setup";
const STALE_SECS = 600;
const BACKOFF_CAP_SECS = 1200; // 20-min cap (main:2750-2754); beyond ⇒ implausible (F5)

/**
 * D11(c): every decision-table action that WRITES over a box's tunnel. The gate
 * is a property of the TUNNEL, not a list of action names that happens to be
 * complete today — row a seeds a key, row c rotates (the same mint code), row d
 * scps a tarball and row b renames over it. Read-only calls (check, status) are
 * deliberately absent: they run BEFORE this point and their result is what makes
 * the observation in the first place.
 */
export const TUNNEL_WRITING_ACTIONS = new Set(["mint", "rotate", "rollout", "delete-then-rename"]);

/** The log label each of those uses (the seed path logs as `mint-key`). */
export function actionLabel(a: string): string {
  return a === "mint" ? "mint-key" : a;
}

export interface ReconcileDeps {
  runner: Runner;
  env: Env;
  rollout: RolloutConfig;
  state: ReconcileStateApi;
  keys: TailscaleKeys;
  /**
   * state-store D7 Phase A: the open store, when the tick runs against one
   * (production from 5.8.0). Omitted ⇒ no integrity halt, no divergence check,
   * no audit retention and no daily backup — which is exactly what keeps the
   * existing box-free runReconcile tests hermetic against a fake file state.
   */
  store?: Store;
  /**
   * The same object as `state` when it is store-backed. Kept as its own field so
   * the tick can drain the EXPORT errors (D6) without narrowing `state`.
   */
  storeState?: StoreState;
  /**
   * state-store D4: names the store holds as `retired` or `enrolling`, read once
   * per tick with membership and handed to `selectCandidates` so neither is
   * adoptable and neither spends the mutation slot.
   */
  excluded?: Map<string, "retired" | "enrolling">;
  ctx: RunContext;
  notify: (level: NotifyLevel, msg: string) => Promise<void> | void;
  targetBoxes: string[];
  configCanary: string | undefined;
  managedSource: ManagedSource;
  managedFilesPresent: boolean;
  /** upgrade engine deps for auto-rollout (F8). */
  upgradeDeps: UpgradeDeps;
  /** target sha for drift (F8 best-effort); undefined ⇒ drift unknown. */
  targetSha: string | undefined;
  targetVersion: string | undefined;
  apply: boolean;
  /** injected clock (seconds) for deterministic tests. */
  nowSec?: number;
  keyExpirySecs?: number;
  /**
   * TUI-D4 history hook — append one snapshot line per tick. Injected so the
   * production tick (assembleTickDeps) writes to `${FLEET_STATE}/history/` and
   * the box-free tests can assert the line WITHOUT touching disk. Omitted ⇒ no
   * snapshot is written (the default keeps existing runReconcile tests
   * hermetic). Runs on EVERY return path (early-return ticks still append,
   * R2-A4); the writer itself must never throw (best-effort — see write.ts).
   */
  history?: (line: SnapshotLine) => void;
  /**
   * Zero-touch join (5.6.0). Present ⇒ the tick discovers, adopts and repairs;
   * omitted ⇒ no discovery at all, which is what keeps the existing box-free
   * runReconcile tests hermetic AND what D6(e) requires when FLEET_BOXES is set
   * (an explicit membership seam must not be second-guessed by discovery).
   */
  discover?: DiscoverDeps;
  /** monotonic clock (ms) for the discover budget; injected for tests. */
  nowMsFn?: () => number;
}

export interface ReconcileResult {
  /**
   * 0 ok, 1 a verified per-box failure, 3 the store declared itself corrupt and
   * the tick refused (state-store D8), 7 every write committed but the legacy
   * export lagged (D6/r6-B2 — `fleet-reconcile.service` treats 7 as success).
   */
  rc: number;
}

function now(deps: ReconcileDeps): number {
  return deps.nowSec ?? Math.floor(Date.now() / 1000);
}

/**
 * The tick's store epilogue (state-store D6/D8): the once-a-day backup step and
 * the export-lag verdict.
 *
 * A lagging export is NOT a failure of the tick: the store write committed, so
 * the mutation succeeded and the store is authoritative. rc 7 says exactly that
 * — "recorded; export failed" — and `fleet-reconcile.service` carries
 * `SuccessExitStatus=7` so it does not park the oneshot unit in `failed` every
 * five minutes. The notify is the signal; the next tick's divergence check
 * reports the lag until it clears.
 *
 * A per-box failure (rc 1) OUTRANKS the export lag: it is the more serious
 * verdict and the operator must not see it downgraded to a success code.
 */
function finishStore(deps: ReconcileDeps, rc: number): number {
  if (deps.store === undefined) return rc;
  const r = dailyMaintenance(deps.store, { fleetState: deps.env.FLEET_STATE, at: now(deps) });
  if (r.integrityFailed !== undefined) {
    void deps.notify(
      "warn",
      `state store: quick_check FAILED (${r.integrityFailed}) — the next tick will refuse; run 'fleet2 state check'`,
    );
    // The tick that DISCOVERS the corruption reports it too, so the signal does
    // not depend on the flag having been writable on a damaged file.
    return 3;
  }
  if (r.backupError !== undefined) {
    void deps.notify("warn", `state store: the daily backup failed (${r.backupError}) — the store itself is unaffected`);
  }
  const errs = deps.storeState?.takeExportErrors() ?? [];
  if (errs.length === 0) return rc;
  log(`reconcile: ${errs.length} legacy export failure(s) this tick — the store is authoritative; first: ${errs[0]}`);
  void deps.notify("warn", `state store: recorded, but the legacy export failed: ${errs[0]}`);
  return rc === 0 ? 7 : rc;
}

/** devices_json_valid: parses AND has a `.devices` array. */
function devicesValid(body: string): boolean {
  try {
    return Array.isArray((JSON.parse(body) as { devices?: unknown }).devices);
  } catch {
    return false;
  }
}

/** Run the tick AFTER the lock is held. */
export async function runReconcile(deps: ReconcileDeps): Promise<ReconcileResult> {
  const mode = deps.apply ? "APPLY" : "DRY-RUN"; // H1: UPPERCASE
  log(`reconcile: start (${mode})`);

  // --- state-store D8 halt rule ---
  // The flag says a `quick_check` declared this file corrupt. A tick that cannot
  // trust its own state must not write to it, so it refuses BEFORE the tick
  // ordinal is bumped: one log line, no writes, and NO backup step (the seven
  // existing backups are the recovery material). The flag is cleared only by a
  // passing `fleet2 state check` or by `fleet2 state restore <file>`.
  if (deps.store !== undefined) {
    const flagged = deps.store.integrityFailedAt();
    if (flagged !== undefined) {
      log(
        `reconcile: REFUSING — the state store failed quick_check at ` +
          `${new Date(flagged * 1000).toISOString()}; run 'fleet2 state check' or ` +
          `'fleet2 state restore <backup>' (no writes this tick)`,
      );
      return { rc: 3 };
    }
  }

  // D5: one tick ordinal per run, bumped BEFORE anything reads it, so
  // `repair_pending_runs` freshness ("the immediately preceding tick" / "the
  // current tick") is a total order with no holes — early-return ticks bump it
  // too.
  const tick = deps.state.bumpTick();

  // --- state-store D6 divergence check (ADVISORY, tick-only) ---
  // After membership is read (the caller resolved `targetBoxes` from the store)
  // and BEFORE any action. It never writes membership: it records findings and
  // notifies, and `fleet2 state reconcile-files` is how an operator resolves
  // one. A missing or unreadable file is "cannot compare" and is INERT.
  if (deps.store !== undefined) {
    const div = checkDivergence(deps.store, { enrolledPath: `${deps.env.FLEET_STATE}/enrolled.tsv`, now: now(deps) });
    for (const n of div.notifications) await deps.notify(n.level, n.msg);
    // D3 retention: 92 days of `audit`, once per tick. `audit.log` the FILE is
    // untouched and stays unbounded (operator logrotate).
    const pruned = deps.store.pruneAudit(AUDIT_RETENTION_DAYS, now(deps));
    if (pruned > 0) log(`reconcile: pruned ${pruned} audit row(s) older than ${AUDIT_RETENTION_DAYS} days`);
  }

  // --- devices GET with D4/F5 backoff ---
  let devs = "";
  const nextRetry = deps.state.nextRetry();
  const nowS = now(deps);
  let backoffActive = false;
  if (nextRetry !== undefined && nextRetry > nowS) {
    if (nextRetry - nowS > BACKOFF_CAP_SECS) {
      // F5 self-heal: an implausible marker (beyond the 20-min cap) is ignored.
      log(`reconcile: api.next_retry implausible (${nextRetry - nowS}s ahead) — ignoring backoff`);
    } else {
      backoffActive = true;
    }
  }

  if (backoffActive) {
    // READ-ONLY exactly as a failed GET: devs="", latch, no api.fails bump (D4).
    const fails = deps.state.nextRetry(); // informational
    void fails;
    log(
      `reconcile: api backoff active until ${new Date((nextRetry ?? 0) * 1000).toISOString()} — read-only run`,
    );
    deps.ctx.latch();
    devs = "";
  } else {
    const g = await deps.keys.getDevices();
    if (g.code < 200 || g.code >= 300) {
      const { n, mins } = deps.state.recordApiFailure(nowS);
      log(`reconcile: device list HTTP ${g.code} — READ-ONLY run (no mint/delete/rename)`);
      deps.ctx.latch();
      devs = "";
      if (n >= 3) await deps.notify("warn", `Tailscale API failing: ${n} consecutive non-2xx (backoff ${mins}m)`);
    } else if (!devicesValid(g.body)) {
      const { n, mins } = deps.state.recordApiFailure(nowS);
      log(`reconcile: device list HTTP 200 but body malformed/partial — READ-ONLY run (no mint/delete/rename)`);
      deps.ctx.latch();
      devs = "";
      if (n >= 3) await deps.notify("warn", `Tailscale API failing: ${n} consecutive non-2xx (backoff ${mins}m)`);
    } else {
      deps.state.resetApiFailure();
      devs = g.body;
    }
  }

  // --- discovery: ADOPT (D1 placement) ---
  // Before the membership loop AND before the empty-membership early return: a
  // brand-new VPS with an empty enrolled.tsv must still adopt. Constructed here
  // and not earlier because ctx.readonly is only final after the devices GET.
  const drun =
    deps.discover === undefined
      ? undefined
      : new DiscoverRun(deps.discover, {
          state: deps.state,
          tick,
          readonly: deps.ctx.readonly,
          apply: deps.apply,
          membership: deps.targetBoxes,
          excluded: deps.excluded,
          nowSec: nowS,
          nowMs: deps.nowMsFn ?? (() => Date.now()),
        });
  await drun?.adoptPass();

  // --- target boxes ---
  if (deps.targetBoxes.length === 0) {
    log("reconcile: no enrolled boxes");
    drun?.finish();
    // R2-A4: an early-return tick still appends a snapshot (empty boxes) so the
    // tick_age freshness signal / STALE banner works even for an empty fleet.
    writeSnapshot(deps, [], null, drun?.summary);
    return { rc: finishStore(deps, 0) };
  }

  // --- per-box loop (SERIAL) ---
  let rc: 0 | 1 = 0;
  const drifted: DriftedBox[] = [];
  const snapshots: SnapshotBox[] = [];
  // D11(c)/r12 note 2: `tunnelUp` may report an unverifiable listener owner
  // many times in one tick (once per box in the loop, again per box in the
  // config pass). tunnel.ts holds no module state, so the dedup lives HERE, for
  // exactly the scope of one tick.
  const tunnelDeps: TunnelDeps = { warnOnce: makeWarnOnce() };
  for (const box of deps.targetBoxes) {
    const r = await reconcileOne(box, devs, deps, drifted, snapshots, tick, tunnelDeps);
    if (r === 1) rc = 1;
  }

  // --- discovery: REPAIR (D1 placement) ---
  // After the loop, because its trigger is THIS tick's row-e outcome, which the
  // loop has just stamped into `repair_pending_runs`.
  await drun?.repairPass();
  drun?.finish();

  // --- rollout once (F8), BEFORE the config pass ---
  await runRolloutOnce(drifted, {
    rollout: deps.rollout,
    targetSha: deps.targetSha,
    targetVersion: deps.targetVersion,
    upgradeDeps: deps.upgradeDeps,
  });

  // --- config pass (rc LOGGED, never folded — D6c) ---
  const cpDeps: ConfigPassDeps = {
    runner: deps.runner,
    env: deps.env,
    source: deps.managedSource,
    state: deps.state,
    notify: deps.notify,
    targetBoxes: deps.targetBoxes,
    configCanary: deps.configCanary,
    managedFilesPresent: deps.managedFilesPresent,
    apply: deps.apply,
  };
  const cpRes = await configPass(cpDeps);

  // --- identity pass (log-only) ---
  identityPass({ devs, targetBoxes: deps.targetBoxes });

  // TUI-D4: fold the config-pass verdict into the per-box snapshot + record the
  // config-pass canary, then append the snapshot line (finally-path).
  for (const sb of snapshots) {
    sb.config = deps.managedFilesPresent ? (cpRes.perBox.get(sb.name) ?? null) : null;
  }
  writeSnapshot(deps, snapshots, deps.managedFilesPresent ? (cpRes.canary ?? null) : null, drun?.summary);

  log(`reconcile: done (${mode})`);
  return { rc: finishStore(deps, rc) };
}

/**
 * Build + emit the TUI-D4 snapshot line (best-effort). Runs on EVERY return
 * path of runReconcile so an early-return tick still appends (R2-A4). The
 * `history` writer is injected; omitted ⇒ no-op.
 */
function writeSnapshot(
  deps: ReconcileDeps,
  boxes: SnapshotBox[],
  canary: string | null,
  discover?: DiscoverSummary,
): void {
  if (deps.history === undefined) return;
  const line: SnapshotLine = {
    v: 1,
    ts: new Date((deps.nowSec ?? Math.floor(Date.now() / 1000)) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    apply: deps.apply,
    canary,
    boxes,
    // D7: OPTIONAL and absent when the tick ran no discovery — no `v` bump, and
    // every reader tolerates its absence.
    ...(discover === undefined ? {} : { discover }),
  };
  try {
    deps.history(line);
  } catch {
    /* the writer is best-effort; a snapshot failure never fails the tick */
  }
}

/** reconcile_one (main:2784-2898). Returns 0 ok / 1 on a decision-execute or
 *  box-index-parse failure. Records drifted boxes into `drifted` (F8). */
async function reconcileOne(
  box: string,
  devs: string,
  deps: ReconcileDeps,
  drifted: DriftedBox[],
  snapshots: SnapshotBox[],
  tick: number,
  tunnelDeps: TunnelDeps = {},
): Promise<0 | 1> {
  if (boxIndex(box) === undefined) return 1; // box_index fail ⇒ rc 1
  let rcOne: 0 | 1 = 0;
  const nowS = now(deps);

  // Inputs from the device list (unknown/0/no on a read-only run).
  const f =
    devs.trim() !== ""
      ? devFields(devs, box, { nowSec: nowS, staleSecs: STALE_SECS })
      : { online: "no" as const, fresh: "no" as const, dupcount: 0, bothOnline: "no" as const, staleId: "", liveId: "" };
  const online = devs.trim() !== "" ? f.online : ("unknown" as const);
  const lastseenFresh = devs.trim() !== "" ? f.fresh : ("unknown" as const);

  // Tunnel + check inputs.
  const tunnel = (await tunnelUp(deps.runner, box, tunnelDeps)) ? "up" : "down";
  let checkfail: "yes" | "no" = "no";
  let checkfailRuns = 0;
  let checkSha = "unknown";
  let checkVersion = "unknown"; // TUI-D4: the human version (splitVersion.version)
  let checkHealthy = false; // TUI-D4: true iff `boxup check` returned OK
  // D11(c): did ANY of this tick's tunnel calls meet the banner? A tunnel-down
  // tick makes no call at all and therefore reads false, which is what clears
  // the marker below.
  let hostkeyMismatch = false;
  if (tunnel === "up") {
    const chk = await tunnelSsh(deps.runner, box, deps.env.FLEET_BOX_KEY, CHECK_COMMAND, {
      timeoutMs: CHECK_TIMEOUT_MS,
      knownHosts: knownHostsFile(deps.env),
    });
    if (isHostKeyMismatch(chk)) hostkeyMismatch = true;
    const parsed = parseCheck(chk.code, chk.stdout + (chk.stderr ? "\n" + chk.stderr : ""));
    if (!parsed.ok) {
      checkfail = "yes";
      checkfailRuns = deps.state.bumpCheckfail(box);
      // F8 drift probe on unhealthy: second boxup status to still compute drift.
      const st = await tunnelSsh(deps.runner, box, deps.env.FLEET_BOX_KEY, STATUS_COMMAND, {
        timeoutMs: STATUS_TIMEOUT_MS,
        knownHosts: knownHostsFile(deps.env),
      });
      if (isHostKeyMismatch(st)) hostkeyMismatch = true;
      const sl = parseStatusLine(st.stdout);
      checkSha = sl.sha;
      checkVersion = sl.version;
    } else {
      deps.state.resetCheckfail(box);
      checkHealthy = true;
      checkSha = parsed.status?.sha ?? "unknown";
      checkVersion = parsed.status?.version ?? "unknown";
    }
  }

  // Expiry (days) from the brain-recorded per-box .expires.
  let expiryDays: number | "unknown" = "unknown";
  const d = deps.state.readExpiresDate(box);
  if (d !== undefined) expiryDays = daysUntil(d, nowS);

  // Drift (D5): tunnel up && target VERSION resolved ⇒ box boxup VERSION vs
  // target VERSION. NOT the stamped repo sha: every fleet2-only commit to main
  // (release pins, docs, fleet/ code) moves the target sha without changing the
  // box payload, and a sha comparison therefore marked the WHOLE fleet drifted
  // and — with auto=true — re-installed boxup everywhere after every fleet2
  // release. That is a fleet-wide write for a no-op (empirical r1 FAIL).
  //
  // Tri-state is unchanged: either side unknown ⇒ "unknown", and unknown never
  // rolls. Direction is irrelevant — a box AHEAD of target (a hand-installed
  // build) is drifted and converges back; target is the authority.
  //
  // `checkSha` stays informational (status/TUI/snapshot/lastUpgrade) and the
  // post-deploy verify in upgrade.ts still requires sha === target.sha: a fresh
  // deploy stamps the target sha, so sha equality is the right proof that THIS
  // deploy landed.
  let drift: "yes" | "no" | "unknown" = "unknown";
  const targetVersionKnown =
    deps.targetVersion !== undefined && deps.targetVersion !== "unknown" && deps.targetVersion !== "";
  const boxVersionKnown =
    checkVersion !== "unknown" && checkVersion !== "-" && checkVersion !== "?" && checkVersion !== "";
  if (tunnel === "up" && targetVersionKnown && boxVersionKnown) {
    drift = checkVersion === deps.targetVersion ? "no" : "yes";
    // D5: ONE debug line per box per tick when the versions agree but the
    // stamped shas do not — the case that used to force a pointless rollout.
    if (
      drift === "no" &&
      deps.targetSha !== undefined &&
      checkSha !== "unknown" &&
      checkSha !== "-" &&
      checkSha !== "?" &&
      checkSha !== deps.targetSha
    ) {
      log(
        `drift: ${box} same VERSION ${checkVersion}, sha ${checkSha}≠${deps.targetSha} — content drift ignored (D5)`,
      );
    }
  }

  // TUI-D4 snapshot mirror for this box. `check`: OK when healthy, FAIL when the
  // check failed, "-" when the tunnel is down (never probed — fleet-status
  // semantics). `ver`: the human version (splitVersion), "-" when unknown.
  // `config` is filled in by the caller after the config pass. `checkfail`/
  // `asleep` mirror the live markers at this instant (GET /v1/fleet lets the
  // live markers override). `expiry_days` null when unknown.
  const check: "OK" | "FAIL" | "-" =
    tunnel === "down" ? "-" : checkHealthy ? "OK" : "FAIL";
  const ver = checkVersion !== "unknown" && checkVersion !== "" ? checkVersion : "-";
  snapshots.push({
    name: box,
    tunnel,
    check,
    ver,
    drift,
    config: null,
    checkfail: deps.state.checkfailCount(box) > 0,
    asleep: deps.state.readAsleep(box) !== undefined,
    expiry_days: expiryDays === "unknown" ? null : expiryDays,
  });

  const actions = decide({
    online,
    lastseenFresh,
    dupcount: f.dupcount,
    bothOnlineDup: f.bothOnline,
    tunnel,
    checkfail,
    expiryDays,
    drift,
    checkfailRuns,
  });

  // D5 hysteresis marker, written HERE — at the row-e evaluation, inside the
  // loop — so `repair` (which runs after the loop) sees a CURRENT-tick stamp and
  // `adopt` (which ran before it) could only have seen the preceding tick's. The
  // marker is DISTINCT from `<box>.incoherent`, whose reset semantics differ.
  // Reset to 0 on ANY tick where the condition does not hold, which the row-e
  // test covers by construction: tunnel up, box asleep, an API outage or a
  // read-only run (online "unknown") and a box absent from the API all fail to
  // emit the token.
  //
  // D11(c) folds the host-key observation in at the SAME site: the marker is
  // written (or cleared) from this tick's tunnel results, and the D5 predicate
  // becomes `rowE || hostkeyMismatch`. The two are disjoint in practice — a
  // mismatch tick reads tunnel = up, which row e cannot — so EITHER alone bumps
  // the counter, and alternation between them still accumulates.
  if (hostkeyMismatch) deps.state.setHostkeyMismatch(box);
  else deps.state.clearHostkeyMismatch(box);

  const rowE = actions.includes("alert-incident:incoherent-both-dead");
  const incoherent = rowE || hostkeyMismatch;
  let repairRuns = 0;
  if (incoherent) repairRuns = deps.state.bumpRepairPending(box, tick);
  else deps.state.resetRepairPending(box, tick);

  if (hostkeyMismatch) {
    // The journal line IS the operator's signal for these ticks: row e does not
    // emit while the tunnel reads up, so no alert fires during the two mismatch
    // ticks. If the heal never completes, `checkfail` accumulates and row N-1
    // (`reachable-cannot-converge`) alerts past three runs anyway.
    log(
      `hostkey: ${box} host key changed on [127.0.0.1]:${portFor(box) ?? "?"} — refusing until repair re-binds (n=${repairRuns})`,
    );
  }

  for (const a of actions) {
    if (a === "noop") continue;
    if (a === "alert-asleep") {
      await alertAsleep(box, { state: deps.state, notify: deps.notify, nowSec: nowS });
      continue;
    }
    if (a === "alert-incident:incoherent-both-dead") {
      await alertIncoherent(box, { state: deps.state, notify: deps.notify, nowSec: nowS });
      continue;
    }
    if (a.startsWith("alert-")) {
      // other incidents are immediate + reset both timers
      deps.state.resetAsleep(box);
      deps.state.resetIncoherent(box);
      await deps.notify("warn", `${box}: ${a.slice("alert-".length)}`);
      continue;
    }
    // non-alert observation clears row-e timers.
    deps.state.resetAsleep(box);
    deps.state.resetIncoherent(box);

    // D11(c) tunnel-write gate. While the marker is set, EVERY action that
    // writes over this box's tunnel is deferred — including row d, which is
    // gated ABOVE the `drifted.push` below rather than at the execute call, or
    // the rollout pass would scp into the banner after the loop. So a rotation
    // can never cause the mint-seed-fail-revoke of empirical r2, on any row.
    if (hostkeyMismatch && TUNNEL_WRITING_ACTIONS.has(a)) {
      log(`${actionLabel(a)}: ${box} deferred — host key mismatch`);
      continue;
    }

    // row d: record the drift, the actual pass runs once after the loop (F8).
    // D5: `cur` is the box's boxup VERSION (the drift key), not its sha.
    if (a === "rollout") {
      drifted.push({ box, cur: checkVersion });
    }

    // mint-window guard (P1-1).
    if (a === "mint" && mintWindowValid(box, { state: deps.state, nowSec: nowS })) {
      log(`reconcile: ${box} mint SKIPPED — a valid key was already seeded this window (mint-window guard)`);
      continue;
    }

    // Mutation gate (main:2871-2874). D4/F3 fix (phase 3): the `read-only `
    // prefix is CONDITIONAL on the run-wide latch (ctx.readonly), NOT on
    // dry-run. A healthy dry-run (no latch) prints `(dry-run/no-apply)`; a
    // latched run (e.g. a fake-401 API failure) prints
    // `(read-only dry-run/no-apply)`. This is the ONE line the fix touches
    // (main:2872 / run.ts:286) — the config-pass and rollout WOULD lines carry
    // no prefix and MUST NOT gain one (F3). Kills m9 (unconditional again).
    if (deps.ctx.readonly || !deps.apply) {
      const prefix = deps.ctx.readonly ? "read-only " : "";
      log(`reconcile: ${box} WOULD ${a} (${prefix}dry-run/no-apply)`);
      continue;
    }

    // Execute (apply mode, not read-only). rollout is handled once after the loop.
    if (a === "rollout") continue;
    const okExec = await execute(box, a, deps);
    if (!okExec) {
      log(`reconcile: ${box} action '${a}' FAILED`);
      rcOne = 1;
      // P1-2 escalation: mint 2xx but seed never converges while old key OK.
      if (a === "mint" && checkfail === "no" && tunnel === "up") {
        const sf = deps.state.bumpSeedfail(box);
        if (sf > 3) {
          await deps.notify(
            "warn",
            `${box}: reachable-cannot-converge (mint seeded but boxup status never converged for ${sf} runs)`,
          );
        }
      }
    } else if (a === "mint") {
      deps.state.resetSeedfail(box);
    }
  }
  return rcOne;
}

/** reconcile_execute (main:2901-2918). Returns true on success. */
async function execute(box: string, action: string, deps: ReconcileDeps): Promise<boolean> {
  const mintDeps: MintDeps = {
    runner: deps.runner,
    env: deps.env,
    keys: deps.keys,
    state: deps.state,
    keyExpirySecs: deps.keyExpirySecs,
    nowMs: (deps.nowSec ?? Math.floor(Date.now() / 1000)) * 1000,
  };
  switch (action) {
    case "mint": {
      const r = await mintKey(box, mintDeps);
      if (r.rc !== 0) return false;
      // boxup once (result ignored, main:2905).
      await tunnelSsh(deps.runner, box, deps.env.FLEET_BOX_KEY, `sudo ${BOX_ROOT}/boxup once`, {
        timeoutMs: STATUS_TIMEOUT_MS,
        knownHosts: knownHostsFile(deps.env),
      }).catch(() => {});
      return true;
    }
    case "rotate":
      return (await rotate(box, mintDeps)).rc === 0;
    case "delete-then-rename":
      return (await dedup(box, { keys: deps.keys, nowSec: deps.nowSec, staleSecs: STALE_SECS })).rc === 0;
    default:
      log(`reconcile: ${box} unknown action '${action}'`);
      return false;
  }
}
