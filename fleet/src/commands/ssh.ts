// ssh.ts — `fleet2 ssh <box> [cmd...]` (D15/F15), the laptop-side tailnet ssh.
//
// Ports cmd_ssh (main:694-712) + box_ssh (main:206-215): `sshpass -e ssh` with
// -o StrictHostKeyChecking=accept-new -o ConnectTimeout=6 -o BatchMode=no to
// box@<box>. No box ⇒ `usage: fleet2 ssh <box> [cmd...]` rc 2 (main:696-699).
// With a command ⇒ run it (rc = ssh's). No command ⇒ interactive session with
// inherited stdio (rc = ssh's).
//
// F15/M11 SECRET CONTRACT: the password reaches sshpass ONLY through the spawned
// child's env (SSHPASS), never process.env of the parent, never argv, never a
// log line. `resolveSshPassword` returns the value; callers pass it as
// `env: { SSHPASS }` to Bun.spawn / the Runner.

import type { Runner } from "../runner.ts";
import type { ParsedConfig } from "../config.ts";
import { log } from "../log.ts";

const BOX_USER = "box";
const DEFAULT_SSH_PASSWORD = "12345678";
const SSH_TIMEOUT_MS = 0; // 0 ⇒ no fleet2 deadline for an interactive/user ssh

const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "ConnectTimeout=6",
  "-o",
  "BatchMode=no",
];

/** ssh_password (main:108): FLEET_SSH_PASSWORD env > [ssh].password > default. */
export function resolveSshPassword(
  cfg: ParsedConfig,
  source: Record<string, string | undefined> = process.env,
): string {
  const envPw = source["FLEET_SSH_PASSWORD"];
  if (envPw !== undefined && envPw !== "") return envPw;
  const sshTable = cfg.raw["ssh"];
  if (sshTable !== null && typeof sshTable === "object" && !Array.isArray(sshTable)) {
    const p = (sshTable as Record<string, unknown>)["password"];
    if (typeof p === "string" && p !== "") return p;
  }
  return DEFAULT_SSH_PASSWORD;
}

/** Build the ssh argv (box@<box> + opts + optional command). No password here. */
export function sshCmdArgv(box: string, command: string | undefined): string[] {
  const argv = ["sshpass", "-e", "ssh", ...SSH_OPTS, `${BOX_USER}@${box}`];
  if (command !== undefined) argv.push(command);
  return argv;
}

/** Spawner seam for the interactive form (inherited stdio). Injectable for tests. */
export interface InteractiveSpawner {
  /** Spawn ssh with inherited stdio; SSHPASS lives ONLY in `env`. Returns rc. */
  spawn(argv: string[], env: Record<string, string>): Promise<number>;
}

/** Production interactive spawner: Bun.spawn with inherited stdio. */
export const bunInteractiveSpawner: InteractiveSpawner = {
  async spawn(argv, env) {
    const proc = Bun.spawn(argv, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      // SSHPASS is scoped to the CHILD only (F15): never assigned to the parent
      // process.env, never on argv.
      env: { ...process.env, ...env },
    });
    const code = await proc.exited;
    return code ?? 1;
  },
};

export interface SshDeps {
  runner: Runner;
  cfg: ParsedConfig;
  /** interactive spawner (inherited stdio); defaults to Bun.spawn. */
  interactive?: InteractiveSpawner;
  /** env source for the password (tests inject). */
  envSource?: Record<string, string | undefined>;
}

/** cmd_ssh <box> [cmd...]. */
export async function cmdSsh(args: string[], deps: SshDeps): Promise<number> {
  const box = args[0];
  if (box === undefined || box === "") {
    log("usage: fleet2 ssh <box> [cmd...]");
    return 2;
  }
  const rest = args.slice(1);
  const pw = resolveSshPassword(deps.cfg, deps.envSource);

  if (rest.length > 0) {
    // Non-interactive: `box_ssh "$box" "$*"` — join the remaining args with a
    // single space, exactly like bash's "$*" (main:701).
    const command = rest.join(" ");
    const r = await deps.runner.run(sshCmdArgv(box, command), {
      timeoutMs: SSH_TIMEOUT_MS,
      env: { SSHPASS: pw }, // child-only (F15)
    });
    return r.code ?? 1;
  }

  // Interactive: inherit stdio, rc = ssh's.
  const spawner = deps.interactive ?? bunInteractiveSpawner;
  return spawner.spawn(sshCmdArgv(box, undefined), { SSHPASS: pw });
}
