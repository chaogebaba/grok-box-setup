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
import { ConfigError, openStore, storePath, type Store } from "../store/db.ts";
import { StoreState } from "../store/state.ts";
import { importLegacy } from "../store/legacy.ts";
import { runReconcile } from "./run.ts";
import { makeDiscoverDeps } from "./discover-wiring.ts";
import type { ReconcileDeps } from "./run.ts";
import { appendSnapshot } from "../history/write.ts";
import { resolveTarget } from "../stage.ts";
import { fsTelegramSource, fetchPoster, notify as notifyFn } from "../notify.ts";
import { nodeFs } from "../state.ts";
import type { UpgradeDeps } from "../upgrade.ts";
import { log } from "../log.ts";
import { existsSync, readFileSync, mkdirSync } from "node:fs";

export const RECONCILE_RC = {
  OK: 0,
  FAILURE: 1,
  USAGE: 2,
  LOCK_OPEN_FAIL: 1,
  /** state-store D1/D8: the store refused to open, or declared itself corrupt. */
  STORE: 3,
  /** state-store D6/r6-B2: everything committed; the legacy export lagged. */
  EXPORT_FAILED: 7,
} as const;

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
  /** PKG_VERSION, stamped into the legacy export header (state-store D6). */
  version?: string;
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
 * assembleTickDeps (R2-A5) — build the full ReconcileDeps for one tick from the
 * env/config/rollout, EXACTLY as the CHILD side of cliReconcile does. Extracted
 * so the /v1/reconcile job handler (TUI-D3) runs `runReconcile(assembleTickDeps(
 * ...))` DIRECTLY — never `cliReconcile` (whose flock re-exec would silently
 * skip) — with NO parallel dep assembly. Behavior-preserving: the CHILD branch
 * of cliReconcile now delegates here.
 *
 * Async because it reads the API token once (F13). `apply`/`nowSec` are the
 * per-call knobs the caller supplies.
 */
export async function assembleTickDeps(
  env: Env,
  cfg: ParsedConfig,
  rollout: RolloutConfig,
  opts: { apply: boolean; nowSec?: number; runner?: BunRunner; version?: string } = { apply: false },
): Promise<ReconcileDeps> {
  const runner = opts.runner ?? new BunRunner();
  const ctx = new RunContext();

  // --- state store (state-store D1/D6/D7 Phase A) ---
  //
  // The TICK is the one path that opens the store read-write, so it is also the
  // one path that creates it, migrates it and imports the 5.7.1 files into it.
  // `openStore` throws ConfigError (rc 3) when $FLEET_STATE is unwritable or the
  // file's `min_reader` says this binary must not operate it; the caller maps
  // that to rc 3 rather than running a tick that cannot persist.
  const store = openStore({ path: storePath(env.FLEET_STATE), dir: env.FLEET_STATE, now: opts.nowSec === undefined ? undefined : () => opts.nowSec! });
  // Import ONCE, gated on `meta.legacy_imported_at` being ABSENT — not on the
  // files being absent, because a crashed import leaves an empty file behind.
  const imported = importLegacy(store, { fleetState: env.FLEET_STATE, etc: env.FLEET_ETC });
  const state = new StoreState(store, {
    paths: { fleetState: env.FLEET_STATE, etc: env.FLEET_ETC, version: opts.version ?? "5.8.0" },
  });
  // Export straight after an import so a rollback to 5.7.1 in the next minute
  // reads files the store itself wrote (D6).
  if (imported.kind === "imported") state.exportAll();

  // Tailscale client — token read once (F13). Missing token ⇒ READ-ONLY run.
  const tokenFile = resolveTokenFile(env, cfg);
  let token: string | undefined;
  try {
    token = await fetchTransport.readToken(tokenFile);
  } catch {
    token = undefined;
  }
  const keys =
    token !== undefined
      ? new TailscaleKeys(fetchTransport, env.FLEET_TS_API, env.FLEET_TS_TAILNET, token, ctx)
      : missingTokenKeys(ctx);

  // Target boxes. MEMBERSHIP IS `phase='enrolled'` from 5.8.0 on (D4/D7/r2-B5);
  // FLEET_BOXES still overrides it, and that override deliberately bypasses the
  // store (it is the explicit membership seam, and D6(e) disables discovery with
  // it). The `excluded` map is read ONCE here, with membership.
  const targetBoxes =
    env.FLEET_BOXES !== undefined && env.FLEET_BOXES.trim() !== ""
      ? resolveMembership(env.FLEET_BOXES, undefined)
      : state.membership();
  const excluded = state.excludedNames();

  // Zero-touch join (D1/P1/D6e). The token was read ONCE above; discover is
  // told the RESULT rather than reading it again. D6(e): an explicit
  // FLEET_BOXES membership seam disables discovery entirely.
  const discoverEnabled = env.FLEET_BOXES === undefined || env.FLEET_BOXES.trim() === "";
  const discover = discoverEnabled
    ? makeDiscoverDeps({ env, cfg, runner, apiToken: token !== undefined, state })
    : undefined;

  // Best-effort target sha (F8).
  let targetSha: string | undefined;
  let targetVersion: string | undefined;
  try {
    const t = await resolveTarget(runner, rollout.src, rollout.target);
    targetSha = t.sha;
    targetVersion = t.version;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`reconcile: rollout target unresolved (${msg}) — drift unknown this tick`);
  }

  const managed = managedSourceFor(env);
  const notify = (level: "info" | "warn", msg: string) =>
    notifyFn(level, msg, { telegramEnvPath: env.FLEET_TELEGRAM_ENV, source: fsTelegramSource, poster: fetchPoster });

  const upgradeDeps: UpgradeDeps = {
    runner,
    env,
    rollout,
    fs: nodeFs,
    notifyDeps: { telegramEnvPath: env.FLEET_TELEGRAM_ENV, source: fsTelegramSource, poster: fetchPoster },
  };

  return {
    runner,
    env,
    rollout,
    state,
    store,
    storeState: state,
    excluded,
    keys,
    ctx,
    notify,
    targetBoxes,
    configCanary: configCanary(cfg),
    managedSource: managed,
    managedFilesPresent: managed.present,
    upgradeDeps,
    targetSha,
    targetVersion,
    apply: opts.apply,
    nowSec: opts.nowSec,
    discover,
    // TUI-D4: production tick appends a snapshot line under FLEET_STATE/history.
    history: (line) => {
      appendSnapshot(env.FLEET_STATE, line);
    },
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
  let deps2;
  try {
    deps2 = await assembleTickDeps(deps.env, deps.cfg, deps.rollout, {
      apply: deps.apply,
      nowSec: deps.nowSec,
      version: deps.version,
    });
  } catch (e) {
    // state-store D1: an unwritable $FLEET_STATE, or a file whose `min_reader`
    // says this binary must not operate it, is rc 3 with the reason named. A
    // tick that cannot persist must not pretend it did.
    if (e instanceof ConfigError) {
      log(e.message);
      return RECONCILE_RC.STORE;
    }
    throw e;
  }
  try {
    const res = await runReconcile(deps2);
    return res.rc;
  } finally {
    deps2.store?.close();
  }
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
