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
import { tunnelUp, tunnelSsh } from "../tunnel.ts";
import { CHECK_COMMAND, STATUS_COMMAND } from "../remote.ts";
import { parseCheck, parseStatusLine } from "../status.ts";
import { boxIndex } from "../boxes.ts";
import { ReconcileState } from "./state.ts";
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

const CHECK_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 20_000;
const BOX_ROOT = "/workspace/box-setup";
const STALE_SECS = 600;
const BACKOFF_CAP_SECS = 1200; // 20-min cap (main:2750-2754); beyond ⇒ implausible (F5)

export interface ReconcileDeps {
  runner: Runner;
  env: Env;
  rollout: RolloutConfig;
  state: ReconcileState;
  keys: TailscaleKeys;
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
  rc: 0 | 1;
}

function now(deps: ReconcileDeps): number {
  return deps.nowSec ?? Math.floor(Date.now() / 1000);
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

  // D5: one tick ordinal per run, bumped BEFORE anything reads it, so
  // `repair_pending_runs` freshness ("the immediately preceding tick" / "the
  // current tick") is a total order with no holes — early-return ticks bump it
  // too.
  const tick = deps.state.bumpTick();

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
    return { rc: 0 };
  }

  // --- per-box loop (SERIAL) ---
  let rc: 0 | 1 = 0;
  const drifted: DriftedBox[] = [];
  const snapshots: SnapshotBox[] = [];
  for (const box of deps.targetBoxes) {
    const r = await reconcileOne(box, devs, deps, drifted, snapshots, tick);
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
  return { rc };
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
  const tunnel = (await tunnelUp(deps.runner, box)) ? "up" : "down";
  let checkfail: "yes" | "no" = "no";
  let checkfailRuns = 0;
  let checkSha = "unknown";
  let checkVersion = "unknown"; // TUI-D4: the human version (splitVersion.version)
  let checkHealthy = false; // TUI-D4: true iff `boxup check` returned OK
  if (tunnel === "up") {
    const chk = await tunnelSsh(deps.runner, box, deps.env.FLEET_BOX_KEY, CHECK_COMMAND, {
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    const parsed = parseCheck(chk.code, chk.stdout + (chk.stderr ? "\n" + chk.stderr : ""));
    if (!parsed.ok) {
      checkfail = "yes";
      checkfailRuns = deps.state.bumpCheckfail(box);
      // F8 drift probe on unhealthy: second boxup status to still compute drift.
      const st = await tunnelSsh(deps.runner, box, deps.env.FLEET_BOX_KEY, STATUS_COMMAND, {
        timeoutMs: STATUS_TIMEOUT_MS,
      });
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

  // Drift: tunnel up && target resolved ⇒ box sha vs target sha.
  let drift: "yes" | "no" | "unknown" = "unknown";
  if (tunnel === "up" && deps.targetSha !== undefined) {
    if (checkSha !== "unknown" && checkSha !== "-" && checkSha !== "?") {
      drift = checkSha === deps.targetSha ? "no" : "yes";
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
  const incoherent = actions.includes("alert-incident:incoherent-both-dead");
  if (incoherent) deps.state.bumpRepairPending(box, tick);
  else deps.state.resetRepairPending(box, tick);

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

    // row d: record the drift, the actual pass runs once after the loop (F8).
    if (a === "rollout") {
      drifted.push({ box, cur: checkSha });
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
