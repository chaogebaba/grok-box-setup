#!/usr/bin/env bun
// cli.ts — grokfleet entry. Hand-rolled arg parsing: `grokfleet <cmd> [flags]`.
//
// Phase 3 (D1): the full operator surface. Commands: version | help | list |
// status | check | rollout | ssh | remove-timer | install-timer(retired) |
// enroll | reconcile | rename | config | mint-key | fleet-status | inventory |
// upgrade. Dispatch decisions live in commands/dispatch.ts (F10); the engine
// wiring is here.
//
// Exit codes (D9): the table is NOT duplicated here. `RC` in upgrade.ts is the
// one constant and `commands/rc.ts` renders it — run `grokfleet rc` (agent-ux U3).
// Notable entries: 6 covers both the VPS-only refusal and the state-store D8
// reconcile-lock timeout ("refused, nothing done"), and 7 is state-store
// D6/r6-B2 "recorded; export failed" — the store write COMMITTED and the
// mutation succeeded, but the legacy export a rolled-back 5.7.1 would read is
// stale. `grokfleet-reconcile.service` carries SuccessExitStatus=7 so a lagging
// export does not park the oneshot unit in `failed` every five minutes.
//
// For agents (agent-ux): stdout is DATA, stderr is diagnostics; every read
// command takes `--json` (or GROKFLEET_JSON=1); no non-zero rc is silent.

import { resolveEnv } from "./env.ts";
import { BunRunner } from "./runner.ts";
import { loadConfig, resolveRollout, configCanary, type ParsedConfig } from "./config.ts";
import { orderExplicit, isValidBoxName } from "./boxes.ts";
import { readMembership } from "./store/membership.ts";
import { runInventory, renderTable, fsReadExpires, type DevicesApi } from "./inventory.ts";
import { tailscaleDevicesApi, resolveTokenFile, fetchTransport } from "./tailscale.ts";
import { runUpgradePass, takeLockAndReexec, RC, type UpgradeArgs, type UpgradeDeps } from "./upgrade.ts";
import { fsTelegramSource, fetchPoster, notify as notifyFn } from "./notify.ts";
import { cliReconcile } from "./reconcile/cli-reconcile.ts";
import { buildGitSha } from "./build-flags.ts";
import { log } from "./log.ts";

import { decide, emit, versionString } from "./commands/dispatch.ts";
import { cmdList } from "./commands/list.ts";
import { cmdSsh } from "./commands/ssh.ts";
import { cmdInstallTimer, cmdRemoveTimer } from "./commands/timers.ts";
import { cmdConfig } from "./commands/config.ts";
import { cmdFleetStatus, type DevicesBodySource } from "./commands/fleet-status.ts";
import { cmdMintKey } from "./commands/mint-key.ts";
import { cmdEnroll } from "./commands/enroll.ts";
import { cmdRename } from "./commands/rename.ts";
import { refuseVpsOnly } from "./commands/locality.ts";
import {
  rolloutRefusal,
  rolloutCanaryLine,
  ROLLOUT_DIRTY_COMPAT_LINE,
  statusSummaryLines,
  checkVerdict,
  checkSummaryLine,
} from "./commands/aliases.ts";
import { makeEnrollSideEffects } from "./commands/enroll-wiring.ts";
import { makeRenameDeps } from "./commands/rename-wiring.ts";
import { renderRcTable, renderRcJson } from "./commands/rc.ts";
import { wantsJson } from "./commands/json-flag.ts";

const PKG_VERSION = "5.12.0"; // 5.12.0: brain-side jobs — schema v4, the poll tick, /v1/jobs and `grokfleet job`.

async function gitShaFromGit(): Promise<string> {
  try {
    const r = new BunRunner();
    const res = await r.run(["git", "rev-parse", "--short", "HEAD"], { timeoutMs: 5000 });
    return res.code === 0 ? res.stdout.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

/** Resolve the git sha for `grokfleet version` (build-embedded, else runtime git). */
export async function resolveGitSha(buildSha: string, runGit: () => Promise<string>): Promise<string> {
  if (buildSha !== "") return buildSha;
  return runGit();
}

// Membership comes from the STORE from 5.8.0 on (state-store D4/D7); the
// exported `enrolled.tsv` is a rollback artefact, not the source of truth.
// `readMembership` keeps the FLEET_BOXES override and falls back to the file
// only for the window before the first tick creates the store.

/** VPS-only refusal (F2/M2): rc 6 when the box key is absent. */
async function refuseIfNoKey(cmd: string, boxKey: string): Promise<boolean> {
  const exists = await Bun.file(boxKey).exists();
  return refuseVpsOnly(cmd, exists);
}

function stdout(s: string): void {
  process.stdout.write(s);
}
function stderr(s: string): void {
  process.stderr.write(s);
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  const cmd = args[0];
  const decision = decide(cmd);

  if (decision.kind === "version") {
    const sha = await resolveGitSha(buildGitSha, gitShaFromGit);
    // U2: `--json` (or GROKFLEET_JSON) ⇒ {name, version, sha, bun}.
    if (wantsJson(args.slice(1))) {
      stdout(JSON.stringify({ name: "grokfleet", version: PKG_VERSION, sha, bun: Bun.version }, null, 2) + "\n");
      return RC.OK;
    }
    return emit(decision, versionString(PKG_VERSION, sha, Bun.version), stdout, stderr);
  }
  if (decision.kind === "help" || decision.kind === "unknown") {
    return emit(decision, "", stdout, stderr);
  }
  // `rc` (U3) is answered before any env/config resolution: it is a pure
  // constant-renderer, and an agent must be able to look the table up on a host
  // where the brain config does not exist.
  if (decision.command === "rc") {
    stdout(wantsJson(args.slice(1)) ? renderRcJson() : renderRcTable());
    return RC.OK;
  }

  const env = resolveEnv();
  const cfg = await loadConfig(env.FLEET_CONFIG);
  const rollout = resolveRollout(cfg, {
    FLEET_ROLLOUT_SRC: env.FLEET_ROLLOUT_SRC,
    FLEET_TARGET_REF: env.FLEET_TARGET_REF,
  });
  const runner = new BunRunner();
  const rest = args.slice(1);

  switch (decision.command) {
    // --- laptop-runnable (M1): no locality guard ---
    case "list":
      return cmdList(runner, stdout, wantsJson(rest));
    case "ssh":
      // lease-api L4: `env` is what makes `--via tunnel` and its rc-6 refusal
      // possible; without it the transport resolves to tailnet as before.
      return cmdSsh(rest, { runner, cfg, env });
    case "remove-timer": {
      const { existsSync, unlinkSync } = await import("node:fs");
      const home = process.env.HOME ?? "";
      return cmdRemoveTimer({
        runner,
        which: async (b) => Bun.which(b) ?? undefined,
        unitDir: `${home}/.config/systemd/user`,
        removeFile: async (p) => {
          try {
            if (existsSync(p)) unlinkSync(p);
          } catch {
            /* best-effort */
          }
        },
      });
    }
    case "install-timer":
      return cmdInstallTimer();

    // --- VPS-side inventory/upgrade engine ---
    case "inventory":
      return runInventoryCmd(rest, env, cfg, rollout, runner, "inventory");
    case "status":
      return runStatusCmd(rest, env, cfg, rollout, runner);
    case "check":
      return runCheckCmd(rest, env, cfg, rollout, runner);
    case "upgrade":
      return runUpgradeCmd(rest, env, cfg, rollout, runner, /*alias*/ false);
    case "rollout":
      return runRolloutCmd(rest, env, cfg, rollout, runner);
    case "reconcile":
      return runReconcileCmd(rest, env, cfg, rollout, argv);

    // --- VPS-side operator commands ---
    case "config":
      if (await refuseIfNoKey("config", env.FLEET_BOX_KEY)) return RC.REFUSED;
      return cmdConfig(rest, { runner, env });
    case "fleet-status":
      return cmdFleetStatus({ runner, env, devices: devicesBodySource(env, cfg) }, stdout);
    case "mint-key":
      return cmdMintKey(rest[0] ?? "", { env, cfg, runner });
    case "enroll":
      return cmdEnroll(rest, makeEnrollSideEffects(env, cfg, runner, { version: PKG_VERSION }));
    case "rename":
      return cmdRename(rest, makeRenameDeps(env, cfg, runner, PKG_VERSION));
    case "retire": {
      // state-store D4: a membership mutation, so VPS-only for the same reason
      // `enroll` and `state` are — it rewrites the fleet user's authorized_keys
      // and the store under $FLEET_STATE.
      if (await refuseIfNoKey("retire", env.FLEET_BOX_KEY)) return RC.REFUSED;
      const { cmdRetire } = await import("./commands/retire.ts");
      const { makeRetireOps, makeRetireOpen } = await import("./commands/retire-wiring.ts");
      return cmdRetire(rest, {
        env,
        runner,
        ops: makeRetireOps(env, cfg, runner),
        open: makeRetireOpen(env, PKG_VERSION),
        notify: (level, msg) =>
          notifyFn(level, msg, {
            telegramEnvPath: env.FLEET_TELEGRAM_ENV,
            source: fsTelegramSource,
            poster: fetchPoster,
          }),
      });
    }

    // --- grokfleet admin panel (TUI-D11) ---
    case "serve": {
      // VPS-only (refuseVpsOnly precedent, rc 6) — the API drives boxes over the
      // reverse tunnels, so it only makes sense on the VPS.
      if (await refuseIfNoKey("serve", env.FLEET_BOX_KEY)) return RC.REFUSED;
      const { cmdServe } = await import("./serve/server.ts");
      return cmdServe(rest, { env, cfg, rollout, runner });
    }
    case "tui": {
      // Laptop-runnable (lane B) — no locality guard.
      const { cmdTui } = await import("./tui/main.ts");
      return cmdTui(rest, { env });
    }
    case "lease": {
      // Laptop-runnable, exactly like `tui`: the lease CLI talks to the admin
      // API and never reads the store, so ONE code path serves both machines
      // (r5-B1). No locality guard.
      const { makeLeaseDeps } = await import("./commands/lease-wiring.ts");
      const { cmdLease } = await import("./commands/lease.ts");
      return cmdLease(rest, makeLeaseDeps(env, cfg, runner, stdout));
    }
    case "job": {
      // Laptop-runnable, exactly like `lease`: the job CLI talks to the admin
      // API and never reads the store, so ONE code path serves both machines.
      const { makeJobDeps } = await import("./commands/job-wiring.ts");
      const { cmdJob } = await import("./commands/job.ts");
      return cmdJob(rest, makeJobDeps(stdout));
    }
    case "state": {
      // state-store D8. VPS-only for the same reason `serve` is: the store lives
      // under $FLEET_STATE on the VPS and these subcommands mutate it.
      if (await refuseIfNoKey("state", env.FLEET_BOX_KEY)) return RC.REFUSED;
      const { cmdState } = await import("./commands/state.ts");
      return cmdState(rest, {
        env,
        runner,
        version: PKG_VERSION,
        json: wantsJson(rest),
        notify: (level, msg) =>
          notifyFn(level, msg, {
            telegramEnvPath: env.FLEET_TELEGRAM_ENV,
            source: fsTelegramSource,
            poster: fetchPoster,
          }),
      });
    }
  }

  // Unreachable (decide() only routes KNOWN_COMMANDS), but keep the compiler
  // happy — and U4-compliant if a future command is ever routed without a case.
  log(`${String(decision.command)}: routed but not wired in cli.ts (internal error)`);
  return RC.USAGE;
}

/** A DevicesBodySource for fleet-status: the raw devices GET body or undefined. */
function devicesBodySource(env: ReturnType<typeof resolveEnv>, cfg: ParsedConfig): DevicesBodySource {
  return {
    async body() {
      const tokenFile = resolveTokenFile(env, cfg);
      let token: string | undefined;
      try {
        token = await fetchTransport.readToken(tokenFile);
      } catch {
        token = undefined;
      }
      if (token === undefined) return undefined;
      const url = `${env.FLEET_TS_API}/tailnet/${env.FLEET_TS_TAILNET}/devices?fields=all`;
      const r = await fetchTransport.get(url, { Authorization: `Bearer ${token}`, Accept: "application/json" }, 20_000);
      if (r.code < 200 || r.code >= 300) return undefined;
      return r.body;
    },
  };
}

// --- inventory / status / check / upgrade / rollout wiring ------------------

function parseBoxArgs(rest: string[], label: string): { boxes: string[]; json: boolean } | number {
  // U2: GROKFLEET_JSON=1 is equivalent to --json wherever --json exists.
  let json = wantsJson(rest);
  const explicit: string[] = [];
  for (const a of rest) {
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") {
      stdout(`see \`grokfleet help\`\nexit codes: grokfleet rc\n`);
      return RC.OK;
    } else if (a.startsWith("--")) {
      log(`${label}: unknown flag ${a}`);
      return RC.USAGE;
    } else if (isValidBoxName(a)) explicit.push(a);
    else {
      log(`${label}: invalid box name '${a}'`);
      return RC.USAGE;
    }
  }
  return { boxes: explicit, json };
}

async function inventoryPass(
  rest: string[],
  env: ReturnType<typeof resolveEnv>,
  cfg: ParsedConfig,
  rollout: ReturnType<typeof resolveRollout>,
  runner: BunRunner,
) {
  const parsed = parseBoxArgs(rest, "inventory");
  if (typeof parsed === "number") return { rc: parsed as number };
  const boxes = parsed.boxes.length > 0 ? parsed.boxes : readMembership(env);
  const api: DevicesApi = tailscaleDevicesApi(env, cfg);
  const res = await runInventory(boxes, { runner, env, rollout, api, readExpires: fsReadExpires });
  return { rc: RC.OK, res, json: parsed.json };
}

async function runInventoryCmd(
  rest: string[],
  env: ReturnType<typeof resolveEnv>,
  cfg: ParsedConfig,
  rollout: ReturnType<typeof resolveRollout>,
  runner: BunRunner,
  cmd: string,
): Promise<number> {
  if (await refuseIfNoKey(cmd, env.FLEET_BOX_KEY)) return RC.REFUSED;
  const r = await inventoryPass(rest, env, cfg, rollout, runner);
  if (r.res === undefined) return r.rc;
  if (r.json) stdout(JSON.stringify(r.res.inventory, null, 2) + "\n");
  else stdout(renderTable(r.res) + "\n");
  return RC.OK;
}

async function runStatusCmd(
  rest: string[],
  env: ReturnType<typeof resolveEnv>,
  cfg: ParsedConfig,
  rollout: ReturnType<typeof resolveRollout>,
  runner: BunRunner,
): Promise<number> {
  if (await refuseIfNoKey("status", env.FLEET_BOX_KEY)) return RC.REFUSED;
  const r = await inventoryPass(rest, env, cfg, rollout, runner);
  if (r.res === undefined) return r.rc;
  if (r.json) stdout(JSON.stringify(r.res.inventory, null, 2) + "\n");
  else stdout(renderTable(r.res) + "\n");
  for (const line of statusSummaryLines(r.res)) log(line);
  return RC.OK;
}

async function runCheckCmd(
  rest: string[],
  env: ReturnType<typeof resolveEnv>,
  cfg: ParsedConfig,
  rollout: ReturnType<typeof resolveRollout>,
  runner: BunRunner,
): Promise<number> {
  let notify = false;
  const boxArgs: string[] = [];
  for (const a of rest) {
    if (a === "--notify") notify = true;
    else boxArgs.push(a);
  }
  if (await refuseIfNoKey("check", env.FLEET_BOX_KEY)) return RC.REFUSED;
  const r = await inventoryPass(boxArgs, env, cfg, rollout, runner);
  if (r.res === undefined) return r.rc;
  const v = checkVerdict(r.res.rows);
  if (v.rc === 1) {
    const summary = checkSummaryLine(v.unhealthy);
    log(summary);
    if (notify) {
      await notifyFn("warn", summary, {
        telegramEnvPath: env.FLEET_TELEGRAM_ENV,
        source: fsTelegramSource,
        poster: fetchPoster,
      });
    }
  }
  return v.rc;
}

function parseUpgradeArgs(rest: string[], canaryDefault: string): {
  to?: string;
  all: boolean;
  apply: boolean;
  json: boolean;
  debugExec: boolean;
  canaryOverride?: string;
  explicit: string[];
  dirty: boolean;
  err?: string;
} {
  let to: string | undefined;
  let all = false;
  let apply = false;
  // U2: GROKFLEET_JSON=1 is equivalent to --json here too.
  let json = wantsJson(rest);
  let debugExec = false;
  let dirty = false;
  let canaryOverride: string | undefined;
  const explicit: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--to") to = rest[++i];
    else if (a === "--all") all = true;
    else if (a === "--apply") apply = true;
    else if (a === "--json") json = true;
    else if (a === "--debug-exec") debugExec = true;
    else if (a === "--dirty") dirty = true;
    else if (a === "--canary") canaryOverride = rest[++i];
    else if (a.startsWith("--")) return { all, apply, json, debugExec, explicit, dirty, err: a };
    else explicit.push(a);
  }
  void canaryDefault;
  return { to, all, apply, json, debugExec, canaryOverride, explicit, dirty };
}

async function runUpgradeCmd(
  rest: string[],
  env: ReturnType<typeof resolveEnv>,
  cfg: ParsedConfig,
  rollout: ReturnType<typeof resolveRollout>,
  runner: BunRunner,
  alias: boolean,
): Promise<number> {
  const p = parseUpgradeArgs(rest, rollout.canary);
  if (p.err) {
    log(`upgrade: unknown flag ${p.err}`);
    return RC.USAGE;
  }
  if (await refuseIfNoKey(alias ? "rollout" : "upgrade", env.FLEET_BOX_KEY)) return RC.REFUSED;

  const canary = p.canaryOverride ?? rollout.canary;
  let boxes: string[];
  if (p.all) {
    boxes = readMembership(env);
  } else if (p.explicit.length > 0) {
    const { ordered, invalid } = orderExplicit(p.explicit, canary);
    if (invalid.length > 0) {
      log(`upgrade: invalid box name(s): ${invalid.join(", ")}`);
      return RC.USAGE;
    }
    boxes = ordered;
  } else {
    log("upgrade: specify --all or one or more box names");
    return RC.USAGE;
  }

  const upgradeArgs: UpgradeArgs = { to: p.to, boxes, all: p.all, apply: p.apply, canary, json: p.json, debugExec: p.debugExec };
  const deps: UpgradeDeps = {
    runner,
    env,
    rollout,
    notifyDeps: { telegramEnvPath: env.FLEET_TELEGRAM_ENV, source: fsTelegramSource, poster: fetchPoster },
  };

  if (p.apply && !env.GROKFLEET_LOCKED) {
    // U4: every arm of takeLockAndReexec that refuses already logs its reason,
    // and the child that DID run owns its own diagnostics on inherited stderr.
    const lr = await takeLockAndReexec(deps, process.argv, p.debugExec);
    return lr.rc;
  }
  if (p.apply && env.GROKFLEET_LOCKED && p.debugExec) {
    process.stderr.write(`exec: locked pid=${process.pid}\n`);
  }

  const res = await runUpgradePass(deps, upgradeArgs);
  if (p.json) {
    stdout(JSON.stringify({ summary: res.summary, plan: res.plan, outcomes: res.outcomes }, null, 2) + "\n");
  } else {
    for (const pl of res.plan) {
      stdout(
        `${pl.box}\t${pl.runningVersion}/${pl.runningSha}\t${res.target ? res.target.version + "/" + res.target.sha : "?"}\t${pl.action}\n`,
      );
    }
    stdout(res.summary + "\n");
  }
  // U4: the summary is DATA on stdout, so a non-zero rc still needs its one
  // stderr line — otherwise `grokfleet upgrade --apply` fails silently for anyone
  // reading only stderr (a systemd unit, an agent checking rc).
  if (res.rc !== RC.OK) log(`${alias ? "rollout" : "upgrade"}: ${res.summary}`);
  return res.rc;
}

async function runRolloutCmd(
  rest: string[],
  env: ReturnType<typeof resolveEnv>,
  cfg: ParsedConfig,
  rollout: ReturnType<typeof resolveRollout>,
  runner: BunRunner,
): Promise<number> {
  const p = parseUpgradeArgs(rest, rollout.canary);
  if (p.err) {
    if (p.err === "--canary") {
      log("rollout: --canary needs a box");
      return RC.USAGE;
    }
    log(`rollout: unknown flag ${p.err}`);
    return RC.USAGE;
  }
  // Bare rollout (no targets, no --all) ⇒ 3-line refusal rc 2 (F9), UNLESS
  // FLEET_BOXES provides a membership override (bash resolve_targets semantics).
  if (!p.all && p.explicit.length === 0 && (env.FLEET_BOXES === undefined || env.FLEET_BOXES.trim() === "")) {
    return rolloutRefusal();
  }
  // --dirty is accepted for compatibility (M4): log, do not refuse.
  if (p.dirty) log(ROLLOUT_DIRTY_COMPAT_LINE);
  // canary policy log (F9).
  const cfgCanary = configCanary(cfg);
  const canary = p.canaryOverride ?? rollout.canary;
  log(rolloutCanaryLine(canary, cfgCanary !== undefined || p.canaryOverride !== undefined ? "config" : "dynamic"));
  // rollout = upgrade --apply. Force apply on for the alias.
  const forced = p.apply ? rest : [...rest, "--apply"];
  return runUpgradeCmd(forced, env, cfg, rollout, runner, /*alias*/ true);
}

async function runReconcileCmd(
  rest: string[],
  env: ReturnType<typeof resolveEnv>,
  cfg: ParsedConfig,
  rollout: ReturnType<typeof resolveRollout>,
  argv: string[],
): Promise<number> {
  let apply = false;
  let debugExec = false;
  for (const a of rest) {
    if (a === "--apply") apply = true;
    else if (a === "--dry-run") apply = false;
    else if (a === "--debug-exec") debugExec = true;
    else if (a === "--help" || a === "-h") {
      stdout("see `grokfleet help`\nexit codes: grokfleet rc\n");
      return RC.OK;
    } else {
      log(`reconcile: unknown arg '${a}'`);
      return RC.USAGE;
    }
  }
  const rc = await cliReconcile({ env, cfg, rollout, apply, debugExec, argv, version: PKG_VERSION });
  // U4: cliReconcile's own arms log, but a rc it invents without a line would
  // otherwise be silent — name the code so the tick is never a mystery.
  if (rc !== RC.OK) log(`reconcile: pass finished with rc ${rc} (see the lines above; grokfleet rc)`);
  return rc;
}

if (import.meta.main) {
  main(process.argv)
    .then((rc) => process.exit(rc))
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      log(`fatal: ${msg}`);
      process.exit(1);
    });
}
