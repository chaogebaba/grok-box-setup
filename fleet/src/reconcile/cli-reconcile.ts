// cli-reconcile.ts — the `fleet2 reconcile` CLI entry (D12/F4).
//
// Arg parsing (--apply/--dry-run, unknown ⇒ rc 2) happens in the CLI BEFORE this
// is called. This function: mkdir FLEET_STATE (swallowed) → take the reconcile
// lock UNCONDITIONALLY via the phase-1 flock re-exec (P3/F4) → on the CHILD side
// assemble deps and run the tick. Lock-held ⇒ rc 0 for reconcile (a skipped tick
// is success, main:2548-2551) — DISTINCT from upgrade's rc 6. Lock-file open
// failure ⇒ rc 1.

import type { Env } from "../env.ts";
import type { ParsedConfig, RolloutConfig } from "../config.ts";
import { resolveRollout, configCanary } from "../config.ts";
import { BunRunner } from "../runner.ts";
import { reexecArgv } from "../upgrade.ts";
import { spawnReexec, type Spawner } from "../reexec.ts";
import { isCompiled } from "../build-flags.ts";
import { resolveMembership } from "../boxes.ts";
import { resolveTokenFile, fetchTransport } from "../tailscale.ts";
import { RunContext, TailscaleKeys } from "./tailscale-keys.ts";
import { ReconcileState, nodeStateFs } from "./state.ts";
import { runReconcile } from "./run.ts";
import { resolveTarget } from "../stage.ts";
import { fsTelegramSource, fetchPoster, notify as notifyFn } from "../notify.ts";
import { nodeFs } from "../state.ts";
import type { UpgradeDeps } from "../upgrade.ts";
import { log } from "../log.ts";
import { existsSync, readFileSync, mkdirSync } from "node:fs";

export const RECONCILE_RC = { OK: 0, FAILURE: 1, USAGE: 2, LOCK_OPEN_FAIL: 1 } as const;

export interface ReconcileCliDeps {
  env: Env;
  cfg: ParsedConfig;
  rollout: RolloutConfig;
  apply: boolean;
  debugExec: boolean;
  argv: string[];
  /** injectable for tests. */
  spawner?: Spawner;
  nowSec?: number;
}

/** managed_files_present + a ManagedSource backed by $FLEET_ETC files. */
function managedSourceFor(env: Env): { present: boolean; fleetToml: () => string | undefined; boxToml: (b: string) => string | undefined } {
  const fleetPath = `${env.FLEET_ETC}/fleet.toml`;
  const boxDir = `${env.FLEET_ETC}/boxes`;
  const readIf = (p: string): string | undefined => {
    try {
      return existsSync(p) ? readFileSync(p, "utf8") : undefined;
    } catch {
      return undefined;
    }
  };
  let present = existsSync(fleetPath);
  if (!present && existsSync(boxDir)) {
    try {
      const { readdirSync } = require("node:fs") as typeof import("node:fs");
      present = readdirSync(boxDir).some((f) => f.endsWith(".toml"));
    } catch {
      present = false;
    }
  }
  return {
    present,
    fleetToml: () => readIf(fleetPath),
    boxToml: (b) => readIf(`${boxDir}/${b}.toml`),
  };
}

/**
 * Run `fleet2 reconcile`. Takes the lock unconditionally; lock-held ⇒ rc 0.
 * On the CHILD side (FLEET2_LOCKED) it runs the tick directly.
 */
export async function cliReconcile(deps: ReconcileCliDeps): Promise<number> {
  // mkdir -p FLEET_STATE (failure swallowed, main:2536).
  try {
    mkdirSync(deps.env.FLEET_STATE, { recursive: true });
  } catch {
    /* swallowed */
  }

  // P3/F4: take the lock UNCONDITIONALLY (apply AND dry-run).
  if (!deps.env.FLEET2_LOCKED) {
    const lockfile = `${deps.env.FLEET_STATE}/reconcile.lock`;
    const child = reexecArgv(lockfile, process.execPath, deps.argv, isCompiled);
    if (deps.debugExec) process.stderr.write(`exec: ${JSON.stringify(child)}\n`);
    const r = await spawnReexec(child, { FLEET2_LOCKED: "1" }, deps.spawner);
    if (!r.launched || r.code === 127) {
      log("reconcile: refused — util-linux flock not found on PATH (needed for reconcile.lock)");
      return RECONCILE_RC.LOCK_OPEN_FAIL; // cannot lock ⇒ rc 1
    }
    if (r.code === 6) {
      // lock held by another run ⇒ rc 0 (a skipped tick is success — F4/main:2548-2551)
      log("reconcile: another reconcile holds the lock — skipping this run");
      return RECONCILE_RC.OK;
    }
    return r.code ?? RECONCILE_RC.FAILURE;
  }

  // --- CHILD side (locked): assemble deps + run the tick. ---
  const runner = new BunRunner();
  const state = new ReconcileState(deps.env.FLEET_STATE, nodeStateFs);
  const ctx = new RunContext();

  // Tailscale client — token read once (F13). Missing token ⇒ READ-ONLY run.
  const tokenFile = resolveTokenFile(deps.env, deps.cfg);
  let token: string | undefined;
  try {
    token = await fetchTransport.readToken(tokenFile);
  } catch {
    token = undefined;
  }
  const keys =
    token !== undefined
      ? new TailscaleKeys(fetchTransport, deps.env.FLEET_TS_API, deps.env.FLEET_TS_TAILNET, token, ctx)
      : missingTokenKeys(ctx);

  // Target boxes.
  const enrolled = readIfExists(`${deps.env.FLEET_STATE}/enrolled.tsv`);
  const targetBoxes = resolveMembership(deps.env.FLEET_BOXES, enrolled);

  // Best-effort target sha (F8).
  let targetSha: string | undefined;
  let targetVersion: string | undefined;
  try {
    const t = await resolveTarget(runner, deps.rollout.src, deps.rollout.target);
    targetSha = t.sha;
    targetVersion = t.version;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`reconcile: rollout target unresolved (${msg}) — drift unknown this tick`);
  }

  const managed = managedSourceFor(deps.env);
  const notify = (level: "info" | "warn", msg: string) =>
    notifyFn(level, msg, { telegramEnvPath: deps.env.FLEET_TELEGRAM_ENV, source: fsTelegramSource, poster: fetchPoster });

  const upgradeDeps: UpgradeDeps = {
    runner,
    env: deps.env,
    rollout: deps.rollout,
    fs: nodeFs,
    notifyDeps: { telegramEnvPath: deps.env.FLEET_TELEGRAM_ENV, source: fsTelegramSource, poster: fetchPoster },
  };

  const res = await runReconcile({
    runner,
    env: deps.env,
    rollout: deps.rollout,
    state,
    keys,
    ctx,
    notify,
    targetBoxes,
    configCanary: configCanary(deps.cfg),
    managedSource: managed,
    managedFilesPresent: managed.present,
    upgradeDeps,
    targetSha,
    targetVersion,
    apply: deps.apply,
    nowSec: deps.nowSec,
  });
  return res.rc;
}

/** A TailscaleKeys whose GET always fails (missing token ⇒ READ-ONLY run). */
function missingTokenKeys(ctx: RunContext): TailscaleKeys {
  const deadTransport = {
    async request() {
      return { code: 0, body: "" };
    },
  };
  log("reconcile: API token file missing/unreadable — READ-ONLY run");
  return new TailscaleKeys(deadTransport, "", "-", "", ctx);
}

function readIfExists(p: string): string | undefined {
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve rollout config (thin wrapper for the CLI). */
export function reconcileRollout(cfg: ParsedConfig, env: Env): RolloutConfig {
  return resolveRollout(cfg, { FLEET_ROLLOUT_SRC: env.FLEET_ROLLOUT_SRC, FLEET_TARGET_REF: env.FLEET_TARGET_REF });
}
