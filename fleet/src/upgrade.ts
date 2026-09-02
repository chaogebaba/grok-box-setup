// upgrade.ts — `fleet2 upgrade [--to REF] [--all|box…] [--apply] [--canary BOX]
// [--json] [--debug-exec]` (D8, F1-F6, G1-G4, H1-H2).
//
// Dry-run is the DEFAULT (M01 precedent): print the plan, exit 0, stage nothing.
// --apply: take the reconciler's lock (F2/G3), stage ONCE, deploy SERIALLY —
// canary first (F3: canary tunnel-down ⇒ ABORT), then the rest in enrolled
// order; tunnel-down non-canary ⇒ skip; in-sync ⇒ skip. Deploy = scp tarball →
// install command (G1/H1) → verify (F1: wait for DONE marker rc, then require
// check rc 0 AND sha==target on TWO consecutive polls). Exactly ONE fleet pass.

import type { Runner } from "./runner.ts";
import type { Env } from "./env.ts";
import type { RolloutConfig } from "./config.ts";
import type { FsSeam, Inventory, BoxEntry } from "./state.ts";
import { inventoryPath, writeInventory, readInventory } from "./state.ts";
import type { Target } from "./stage.ts";
import { classify } from "./runner.ts";
import { tunnelUp, tunnelScp, tunnelSsh } from "./tunnel.ts";
import { knownHostsFile } from "./hostkey.ts";
import {
  REMOTE_TAR,
  renderInstallCommand,
  POLL_COMMAND,
  CHECK_COMMAND,
  matchDoneRc,
  assertRemoteValue,
} from "./remote.ts";
import { parseCheck } from "./status.ts";
import { resolveTarget, stageTree, nodeStageFs, type StageFs } from "./stage.ts";
import { probeBox, type ProbeResult } from "./inventory.ts";
import { isCompiled } from "./build-flags.ts";
import { spawnReexec, type Spawner } from "./reexec.ts";
import { log } from "./log.ts";
import { notify, type NotifyDeps } from "./notify.ts";

const SCP_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 300_000;
const POLL_TIMEOUT_MS = 20_000;
const CHECK_TIMEOUT_MS = 20_000;

/** Exit codes (D9). */
export const RC = {
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  TARGET: 3,
  REFUSED: 6,
} as const;

export type BoxAction = "upgrade" | "in-sync" | "skip:tunnel-down";
export type BoxResult = "ok" | "failed" | "skipped" | "aborted";

export interface PlanRow {
  box: string;
  runningVersion: string;
  runningSha: string;
  action: BoxAction;
}

export interface DeployOutcome {
  box: string;
  result: BoxResult;
  detail: string;
}

export interface Sleeper {
  (ms: number): Promise<void>;
}

export const realSleep: Sleeper = (ms) => new Promise((r) => setTimeout(r, ms));

export interface UpgradeArgs {
  to: string | undefined;
  boxes: string[]; // resolved membership OR explicit (already ordered elsewhere)
  all: boolean;
  apply: boolean;
  canary: string | undefined; // resolved canary name
  json: boolean;
  debugExec: boolean;
}

export interface UpgradeDeps {
  runner: Runner;
  env: Env;
  rollout: RolloutConfig;
  fs: FsSeam;
  stageFs?: StageFs;
  sleep?: Sleeper;
  notifyDeps: NotifyDeps;
  /** Provided so tests can inject a Target without a real git repo. */
  resolveTargetFn?: (runner: Runner, src: string, ref: string) => Promise<Target>;
  /** Spawner for the flock re-exec (fix 3); default inherits stdio (F2). */
  spawner?: Spawner;
}

// --------------------------------------------------------------------------
// F2/G3/H2: the flock re-exec.
// --------------------------------------------------------------------------

/**
 * Compute the flock child argv (G3). In a compiled binary process.execPath IS
 * fleet2 and argv[1] must NOT be re-passed; under `bun run` execPath is bun and
 * argv[1] (the entry .ts) MUST be re-passed.
 */
export function reexecArgv(
  lockfile: string,
  execPath: string,
  argv: string[],
  isCompiled: boolean,
): string[] {
  const self = isCompiled ? [execPath] : [execPath, argv[1]!];
  const passthrough = argv.slice(2);
  return ["flock", "-n", "-E", "6", lockfile, ...self, ...passthrough];
}

export interface LockResult {
  /** rc to exit with (the child's rc, or 6 when held / flock missing). */
  rc: number;
  /** true when the lock was acquired and the child ran. */
  ran: boolean;
}

/**
 * Take the reconcile.lock via a flock re-exec (F2/G3), spawning the child with
 * INHERITED stdio so its plan/per-box/summary/notify output reaches the operator
 * and the journal (gate-r1 fix 3 — the child is NOT run through the piping
 * Runner). Returns the child's rc. flock returns 6 when held ⇒ refused. flock
 * ENOENT/127 ⇒ refused (rc 6, G3), NEVER proceeds unlocked.
 */
export async function takeLockAndReexec(
  deps: UpgradeDeps,
  argv: string[],
  debugExec: boolean,
): Promise<LockResult> {
  const lockfile = `${deps.env.FLEET_STATE}/reconcile.lock`;
  const child = reexecArgv(lockfile, process.execPath, argv, isCompiled);
  if (debugExec) {
    process.stderr.write(`exec: ${JSON.stringify(child)}\n`);
  }
  // Spawn OUTSIDE the Runner seam with inherited stdio (F2). The child owns the
  // whole locked pass; there is no fleet2 deadline on it.
  const r = await spawnReexec(child, { FLEET2_LOCKED: "1" }, deps.spawner);
  if (!r.launched) {
    // ENOENT — flock not on PATH.
    log("upgrade: refused — util-linux flock not found on PATH (needed for reconcile.lock)");
    return { rc: RC.REFUSED, ran: false };
  }
  if (r.code === 127) {
    log("upgrade: refused — util-linux flock not found on PATH (needed for reconcile.lock)");
    return { rc: RC.REFUSED, ran: false };
  }
  if (r.code === 6) {
    log("upgrade: refused — reconcile.lock held (reconciler tick or another fleet2 running)");
    return { rc: RC.REFUSED, ran: false };
  }
  return { rc: r.code ?? RC.FAILURE, ran: true };
}

// --------------------------------------------------------------------------
// F1/G1/G2/H1: verify a single deployed box.
// --------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean;
  detail: string;
}

/**
 * Verify a deploy (F1 + H1): (1) poll the install log tail until the LAST
 * `DONE (rc=N)` line appears — rc≠0 ⇒ FAILURE, no DONE within verify_tries ⇒
 * FAILURE; (2) then require `boxup check` rc 0 AND parsed sha == target on TWO
 * consecutive polls; a pass then a fail resets the count; exhaustion ⇒ FAILURE.
 */
export async function verifyBox(
  deps: UpgradeDeps,
  box: string,
  targetSha: string,
): Promise<VerifyResult> {
  const { runner, env, rollout } = deps;
  const sleep = deps.sleep ?? realSleep;
  const key = env.FLEET_BOX_KEY;

  // Phase 1: wait for this run's DONE marker.
  let doneRc: number | null = null;
  for (let i = 0; i < rollout.verifyTries; i++) {
    await sleep(rollout.verifyInterval * 1000);
    const r = await tunnelSsh(runner, box, key, POLL_COMMAND, {
      timeoutMs: POLL_TIMEOUT_MS,
      knownHosts: knownHostsFile(env),
    });
    // transport/killed consumes a try but is not itself a failure here.
    const cls = classify(r);
    if (cls === "transport" || cls === "killed") continue;
    const rc = matchDoneRc(r.stdout);
    if (rc !== null) {
      doneRc = rc;
      break;
    }
  }
  if (doneRc === null) {
    return { ok: false, detail: "verify: no DONE marker" };
  }
  if (doneRc !== 0) {
    return { ok: false, detail: `install: DONE (rc=${doneRc})` };
  }

  // Phase 2: two consecutive passing checks (rc 0 AND sha == target).
  let consecutive = 0;
  for (let i = 0; i < rollout.verifyTries; i++) {
    const r = await tunnelSsh(runner, box, key, CHECK_COMMAND, {
      timeoutMs: CHECK_TIMEOUT_MS,
      knownHosts: knownHostsFile(env),
    });
    const cls = classify(r);
    if (cls === "transport" || cls === "killed") {
      consecutive = 0;
      await sleep(rollout.verifyInterval * 1000);
      continue;
    }
    const checkRes = parseCheck(r.code, r.stdout + (r.stderr ? "\n" + r.stderr : ""));
    const passes = checkRes.ok && checkRes.status?.sha === targetSha;
    if (passes) {
      consecutive++;
      if (consecutive >= 2) return { ok: true, detail: "verified" };
    } else {
      consecutive = 0;
    }
    await sleep(rollout.verifyInterval * 1000);
  }
  return { ok: false, detail: "verify: sha mismatch after DONE" };
}

// --------------------------------------------------------------------------
// Deploy one box: scp → install → verify.
// --------------------------------------------------------------------------

export async function deployBox(
  deps: UpgradeDeps,
  box: string,
  tar: string,
  targetSha: string,
): Promise<DeployOutcome> {
  const { runner, env } = deps;
  const key = env.FLEET_BOX_KEY;

  // scp: any non-zero (incl. 255/killed) ⇒ per-box FAILURE, nothing landed (F4).
  const scp = await tunnelScp(runner, box, key, tar, REMOTE_TAR, {
    timeoutMs: SCP_TIMEOUT_MS,
    knownHosts: knownHostsFile(env),
  });
  if (scp.code !== 0) {
    const cls = classify(scp);
    return { box, result: "failed", detail: `scp: ${cls}` };
  }

  // install command (G1/H1). F6-validates the sha (throws ⇒ caller catches).
  const installCmd = renderInstallCommand(targetSha);
  const install = await tunnelSsh(runner, box, key, installCmd, {
    timeoutMs: INSTALL_TIMEOUT_MS,
    knownHosts: knownHostsFile(env),
  });
  const icls = classify(install);
  // transport/killed on install is NOT itself a failure — verify decides (F4).
  if (icls === "remote") {
    return { box, result: "failed", detail: `install: remote rc=${install.code}` };
  }

  const v = await verifyBox(deps, box, targetSha);
  return { box, result: v.ok ? "ok" : "failed", detail: v.detail };
}

// --------------------------------------------------------------------------
// The pass.
// --------------------------------------------------------------------------

export interface PassResult {
  rc: number;
  mode: "dry-run" | "apply";
  plan: PlanRow[];
  outcomes: DeployOutcome[];
  target: Target | null;
  summary: string;
}

/** Build the plan by probing each box's running state (reads only). */
async function buildPlan(
  deps: UpgradeDeps,
  boxes: string[],
  target: Target,
): Promise<{ plan: PlanRow[]; probes: Map<string, ProbeResult> }> {
  const probes = new Map<string, ProbeResult>();
  const plan: PlanRow[] = [];
  for (const box of boxes) {
    const p = await probeBox(deps.runner, deps.env, box, undefined, undefined);
    probes.set(box, p);
    let action: BoxAction;
    // D5 — one rule, two call sites: in-sync is a boxup VERSION match, the same
    // key row-d drift uses (reconcile/run.ts). The stamped sha is informational:
    // a fleet2-only commit moves it without changing the box payload, and
    // planning on it made every box look upgradeable after every release.
    // Unknown on either side ("-" not probed, "?" unparsed, target "unknown" when
    // the ref has no VERSION file) is NOT in-sync — `fleet2 upgrade` is an
    // explicit operator command on a named set, so it deploys rather than
    // silently skipping a box it could not read. (Reconcile's automatic row d
    // takes the opposite default: unknown never rolls.)
    const versionsKnown =
      p.version !== "-" && p.version !== "?" && p.version !== "unknown" && target.version !== "unknown";
    if (p.tunnel === "down") action = "skip:tunnel-down";
    else if (versionsKnown && p.version === target.version) action = "in-sync";
    else action = "upgrade";
    plan.push({ box, runningVersion: p.version, runningSha: p.sha, action });
  }
  return { plan, probes };
}

/**
 * Run the upgrade pass. This is the CHILD side (already locked, or dry-run). The
 * lock re-exec is handled by the CLI before calling this in --apply mode.
 */
export async function runUpgradePass(deps: UpgradeDeps, args: UpgradeArgs): Promise<PassResult> {
  const { runner, rollout } = deps;
  const ref = args.to ?? rollout.target;
  const resolveFn = deps.resolveTargetFn ?? resolveTarget;

  // Dry-run DOES resolve the target (F7.9) — inherits rc 3 when src is missing.
  let target: Target;
  try {
    target = await resolveFn(runner, rollout.src, ref);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(msg);
    return {
      rc: RC.TARGET,
      mode: args.apply ? "apply" : "dry-run",
      plan: [],
      outcomes: [],
      target: null,
      summary: `upgrade: target error`,
    };
  }

  // Validate the target sha for the remote charset up-front (F6).
  try {
    assertRemoteValue("sha", target.sha);
  } catch {
    log(`upgrade: refused — target sha '${target.sha}' fails the remote charset check`);
    return {
      rc: RC.USAGE,
      mode: args.apply ? "apply" : "dry-run",
      plan: [],
      outcomes: [],
      target,
      summary: "upgrade: bad target sha",
    };
  }

  const { plan, probes } = await buildPlan(deps, args.boxes, target);

  if (!args.apply) {
    return {
      rc: RC.OK,
      mode: "dry-run",
      plan,
      outcomes: [],
      target,
      summary: `upgrade: pass done (dry-run) target=${target.version}/${target.sha}`,
    };
  }

  // --apply: stage ONCE, deploy serially.
  const stageFs = deps.stageFs ?? nodeStageFs;
  let tar: string;
  try {
    tar = await stageTree(runner, stageFs, rollout.src, target.sha);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(msg);
    return {
      rc: RC.TARGET,
      mode: "apply",
      plan,
      outcomes: [],
      target,
      summary: "upgrade: staging error",
    };
  }

  const outcomes: DeployOutcome[] = [];
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  let aborted = false;
  try {
    // Order: canary first (if in targets), then the rest in given order (F3/D8).
    const ordered = orderForApply(args.boxes, args.canary);
    const canary = args.canary;
    for (const box of ordered) {
      const row = plan.find((p) => p.box === box)!;
      const isCanary = box === canary;

      if (row.action === "skip:tunnel-down") {
        if (isCanary) {
          // F3: canary tunnel-down ⇒ ABORT the pass, zero deploys.
          await notify(
            "warn",
            `upgrade: canary ${box} tunnel-down — ABORT, zero boxes deployed`,
            deps.notifyDeps,
          );
          outcomes.push({ box, result: "aborted", detail: "canary tunnel-down" });
          aborted = true;
          break;
        }
        outcomes.push({ box, result: "skipped", detail: "tunnel-down" });
        skipped++;
        continue;
      }
      if (row.action === "in-sync") {
        outcomes.push({ box, result: "skipped", detail: "in-sync" });
        skipped++;
        continue;
      }

      const outcome = await deployBox(deps, box, tar, target.sha);
      outcomes.push(outcome);
      if (outcome.result === "ok") {
        ok++;
      } else {
        failed++;
        if (isCanary) {
          await notify(
            "warn",
            `upgrade: canary ${box} verified FAILURE (${outcome.detail}) — ABORT, zero others touched`,
            deps.notifyDeps,
          );
          aborted = true;
          break;
        }
        // later verified failure ⇒ stop, no further deploys (D8).
        await notify(
          "warn",
          `upgrade: ${box} verified FAILURE (${outcome.detail}) — stopping, no further deploys`,
          deps.notifyDeps,
        );
        break;
      }
    }
  } finally {
    await stageFs.remove(tar);
  }

  const rc = failed > 0 || aborted ? RC.FAILURE : RC.OK;
  const summary = `upgrade: pass done (apply) target=${target.version}/${target.sha} ok=${ok} skipped=${skipped} failed=${failed}`;

  // F7.6 / G4-S-E: rewrite inventory.json after the applied pass, recording a
  // per-box lastUpgrade{target,result,at,detail} for EVERY box probed in the
  // plan (including untouched/aborted ones) so a partial/aborted rollout is
  // visible. Best-effort: a write failure logs but does not change the pass rc.
  await persistApplyInventory(deps, args.boxes, target, probes, outcomes).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e);
    log(`upgrade: inventory.json write failed after apply — ${msg}`);
  });

  return { rc, mode: "apply", plan, outcomes, target, summary };
}

/**
 * Persist inventory.json after an applied pass (F7.6/S-E). Merges over any
 * existing inventory so untouched boxes keep their last snapshot, and stamps a
 * `lastUpgrade` on every box in this pass's target set from its outcome (a box
 * with no outcome — e.g. after an abort short-circuited the loop — records
 * `result:"skipped", detail:"not-reached (pass aborted)"`). Atomic (tmp→rename,
 * 0600) via the same state seam inventory uses.
 */
export async function persistApplyInventory(
  deps: UpgradeDeps,
  boxes: string[],
  target: Target,
  probes: Map<string, ProbeResult>,
  outcomes: DeployOutcome[],
): Promise<void> {
  const path = inventoryPath(deps.env.FLEET_STATE);
  const prev = await readInventory(deps.fs, path);
  const at = new Date().toISOString();
  const outcomeByBox = new Map<string, DeployOutcome>(outcomes.map((o) => [o.box, o]));

  const boxesObj: Record<string, BoxEntry> = { ...(prev?.boxes ?? {}) };
  for (const box of boxes) {
    const p = probes.get(box);
    const o = outcomeByBox.get(box);
    const result = o?.result ?? "skipped";
    const detail = o?.detail ?? "not-reached (pass aborted)";
    // The recorded sha is the TARGET on success, else the box's last-known sha.
    const runningSha = p && p.sha !== "-" && p.sha !== "?" ? p.sha : null;
    const entry: BoxEntry = {
      ...(boxesObj[box] ?? {
        api: null,
        tunnel: p?.tunnel ?? null,
        check: p && p.check !== "-" ? p.check : null,
        version: p && p.version !== "-" && p.version !== "?" ? p.version : null,
        sha: runningSha,
        checkedAt: at,
      }),
      sha: result === "ok" ? target.sha : (boxesObj[box]?.sha ?? runningSha),
      lastUpgrade: { target: target.sha, result, at, detail },
    };
    boxesObj[box] = entry;
  }

  const inventory: Inventory = {
    generatedAt: at,
    target: { ref: target.ref, sha: target.sha, version: target.version },
    boxes: boxesObj,
  };
  await writeInventory(deps.fs, path, inventory);
}

/** Ordering for --apply: canary first (if present), then the rest in order. */
export function orderForApply(boxes: string[], canary: string | undefined): string[] {
  if (!canary || !boxes.includes(canary)) return boxes.slice();
  return [canary, ...boxes.filter((b) => b !== canary)];
}
