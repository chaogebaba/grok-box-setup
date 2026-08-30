#!/usr/bin/env bun
// cli.ts — fleet2 entry. Hand-rolled arg parsing: `fleet2 <cmd> [flags]`.
//
// Commands: version | inventory [--json] [box…] | upgrade [--to REF]
// [--all|box…] [--apply] [--canary BOX] [--json] [--debug-exec].
// Exit codes (D9): 0 ok, 1 verified failure/abort, 2 usage, 3 target/staging,
// 6 refused (not on VPS / missing key / lock held / flock missing).

import { resolveEnv } from "./env.ts";
import { BunRunner } from "./runner.ts";
import { loadConfig, resolveRollout } from "./config.ts";
import { resolveMembership, orderExplicit, isValidBoxName } from "./boxes.ts";
import { nodeFs } from "./state.ts";
import {
  runInventory,
  renderTable,
  fsReadExpires,
  type DevicesApi,
} from "./inventory.ts";
import { tailscaleDevicesApi } from "./tailscale.ts";
import {
  runUpgradePass,
  takeLockAndReexec,
  RC,
  type UpgradeArgs,
  type UpgradeDeps,
} from "./upgrade.ts";
import { fsTelegramSource, fetchPoster } from "./notify.ts";
import { cliReconcile } from "./reconcile/cli-reconcile.ts";
import { buildGitSha } from "./build-flags.ts";
import { log } from "./log.ts";

const PKG_VERSION = "5.3.0";

function usage(): string {
  return [
    "fleet2 — grok-fleet brain (phase 1: inventory + batch upgrade)",
    "",
    "usage:",
    "  fleet2 version",
    "  fleet2 inventory [--json] [box…]",
    "  fleet2 upgrade [--to REF] [--all | box…] [--apply] [--canary BOX] [--json]",
    "  fleet2 reconcile [--apply | --dry-run]",
    "",
    "exit codes: 0 ok, 1 failure/abort, 2 usage, 3 target/staging, 6 refused",
  ].join("\n");
}

/**
 * Resolve the git sha for `fleet2 version` (gate-r1 finding 1). Precedence:
 *  - the BUILD-embedded sha (`buildGitSha`, injected by `--define FLEET2_GIT_SHA`)
 *    when non-empty — the compiled binary prints its OWN build sha regardless of
 *    the invocation directory;
 *  - otherwise (dev/test) fall back to `git rev-parse --short HEAD` at runtime.
 * Pure/injectable so the build-flag path is unit-testable without a compile.
 */
export async function resolveGitSha(
  buildSha: string,
  runGit: () => Promise<string>,
): Promise<string> {
  if (buildSha !== "") return buildSha;
  return runGit();
}

/** Runtime `git rev-parse --short HEAD`, "unknown" on any failure. */
async function gitShaFromGit(): Promise<string> {
  try {
    const r = new BunRunner();
    const res = await r.run(["git", "rev-parse", "--short", "HEAD"], { timeoutMs: 5000 });
    return res.code === 0 ? res.stdout.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

async function readEnrolled(fleetState: string): Promise<string | undefined> {
  const file = Bun.file(`${fleetState}/enrolled.tsv`);
  if (!(await file.exists())) return undefined;
  return file.text();
}

/** Refuse (rc 6) unless the box key file exists — the VPS-only precondition (D9). */
async function refuseIfNoKey(boxKey: string): Promise<boolean> {
  const exists = await Bun.file(boxKey).exists();
  if (!exists) {
    log(`refused — box access key not found at ${boxKey} (not on the VPS?)`);
    return true;
  }
  return false;
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const cmd = args[0];

  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(usage() + "\n");
    return cmd === undefined ? RC.USAGE : RC.OK;
  }

  if (cmd === "version") {
    const sha = await resolveGitSha(buildGitSha, gitShaFromGit);
    process.stdout.write(`fleet2 ${PKG_VERSION} (${sha}) (bun ${Bun.version})\n`);
    return RC.OK;
  }

  const env = resolveEnv();
  const cfg = await loadConfig(env.FLEET_CONFIG);
  const rollout = resolveRollout(cfg, {
    FLEET_ROLLOUT_SRC: env.FLEET_ROLLOUT_SRC,
    FLEET_TARGET_REF: env.FLEET_TARGET_REF,
  });
  const runner = new BunRunner();

  if (cmd === "inventory") {
    const rest = args.slice(1);
    let json = false;
    const explicit: string[] = [];
    for (const a of rest) {
      if (a === "--json") json = true;
      else if (a === "--help" || a === "-h") {
        process.stdout.write(usage() + "\n");
        return RC.OK;
      } else if (a.startsWith("--")) {
        log(`inventory: unknown flag ${a}`);
        return RC.USAGE;
      } else if (isValidBoxName(a)) {
        explicit.push(a);
      } else {
        log(`inventory: invalid box name '${a}'`);
        return RC.USAGE;
      }
    }
    if (await refuseIfNoKey(env.FLEET_BOX_KEY)) return RC.REFUSED;

    const enrolled = await readEnrolled(env.FLEET_STATE);
    const boxes = explicit.length > 0 ? explicit : resolveMembership(env.FLEET_BOXES, enrolled);
    const api: DevicesApi = tailscaleDevicesApi(env, cfg);
    const res = await runInventory(boxes, {
      runner,
      env,
      rollout,
      fs: nodeFs,
      api,
      readExpires: fsReadExpires,
    });
    if (json) process.stdout.write(JSON.stringify(res.inventory, null, 2) + "\n");
    else process.stdout.write(renderTable(res) + "\n");
    return RC.OK;
  }

  if (cmd === "upgrade") {
    const rest = args.slice(1);
    let to: string | undefined;
    let all = false;
    let apply = false;
    let json = false;
    let debugExec = false;
    let canaryOverride: string | undefined;
    const explicit: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--to") to = rest[++i];
      else if (a === "--all") all = true;
      else if (a === "--apply") apply = true;
      else if (a === "--json") json = true;
      else if (a === "--debug-exec") debugExec = true;
      else if (a === "--canary") canaryOverride = rest[++i];
      else if (a === "--help" || a === "-h") {
        process.stdout.write(usage() + "\n");
        return RC.OK;
      } else if (a.startsWith("--")) {
        log(`upgrade: unknown flag ${a}`);
        return RC.USAGE;
      } else {
        explicit.push(a);
      }
    }
    if (await refuseIfNoKey(env.FLEET_BOX_KEY)) return RC.REFUSED;

    const canary = canaryOverride ?? rollout.canary;

    // Resolve the target box list.
    let boxes: string[];
    if (all) {
      const enrolled = await readEnrolled(env.FLEET_STATE);
      boxes = resolveMembership(env.FLEET_BOXES, enrolled);
    } else if (explicit.length > 0) {
      const { ordered, invalid } = orderExplicit(explicit, canary);
      if (invalid.length > 0) {
        log(`upgrade: invalid box name(s): ${invalid.join(", ")}`);
        return RC.USAGE;
      }
      boxes = ordered;
    } else {
      log("upgrade: specify --all or one or more box names");
      return RC.USAGE;
    }

    const upgradeArgs: UpgradeArgs = { to, boxes, all, apply, canary, json, debugExec };
    const deps: UpgradeDeps = {
      runner,
      env,
      rollout,
      fs: nodeFs,
      notifyDeps: {
        telegramEnvPath: env.FLEET_TELEGRAM_ENV,
        source: fsTelegramSource,
        poster: fetchPoster,
      },
    };

    // F2/G3: --apply runs the whole pass under the reconcile.lock via a flock
    // re-exec. The child (FLEET2_LOCKED=1) runs the pass directly.
    if (apply && !env.FLEET2_LOCKED) {
      const lr = await takeLockAndReexec(deps, argv, debugExec);
      return lr.rc;
    }
    if (apply && env.FLEET2_LOCKED && debugExec) {
      process.stderr.write(`exec: locked pid=${process.pid}\n`);
    }

    const res = await runUpgradePass(deps, upgradeArgs);
    if (json) {
      process.stdout.write(
        JSON.stringify({ summary: res.summary, plan: res.plan, outcomes: res.outcomes }, null, 2) +
          "\n",
      );
    } else {
      for (const p of res.plan) {
        process.stdout.write(
          `${p.box}\t${p.runningVersion}/${p.runningSha}\t${
            res.target ? res.target.version + "/" + res.target.sha : "?"
          }\t${p.action}\n`,
        );
      }
      process.stdout.write(res.summary + "\n");
    }
    return res.rc;
  }

  if (cmd === "reconcile") {
    const rest = args.slice(1);
    let apply = false;
    let debugExec = false;
    for (const a of rest) {
      if (a === "--apply") apply = true;
      else if (a === "--dry-run") apply = false;
      else if (a === "--debug-exec") debugExec = true;
      else if (a === "--help" || a === "-h") {
        process.stdout.write(usage() + "\n");
        return RC.OK;
      } else {
        // unknown arg ⇒ rc 2 BEFORE the lock (main:2527-2534)
        log(`reconcile: unknown arg '${a}'`);
        return RC.USAGE;
      }
    }
    return cliReconcile({
      env,
      cfg,
      rollout,
      apply,
      debugExec,
      argv,
    });
  }

  log(`unknown command '${cmd}'`);
  process.stdout.write(usage() + "\n");
  return RC.USAGE;
}

// Only auto-run when executed as the entry point — importing this module (e.g.
// from a test) must NOT kick off the CLI.
if (import.meta.main) {
  main(process.argv)
    .then((rc) => process.exit(rc))
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      log(`fatal: ${msg}`);
      process.exit(1);
    });
}
