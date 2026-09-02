// ssh.ts — `fleet2 ssh [flags] <box> [cmd...]` (D15/F15 + agent-ux U1), the
// laptop-side tailnet ssh AND the fleet's transparent remote-exec primitive.
//
// Ports cmd_ssh (main:694-712) + box_ssh (main:206-215): `sshpass -e ssh` with
// -o StrictHostKeyChecking=accept-new -o ConnectTimeout=6 -o BatchMode=no to
// box@<box>. No box ⇒ `usage: fleet2 ssh <box> [cmd...]` rc 2 (main:696-699).
//
// agent-ux U1 — the non-interactive form is a TRANSPARENT remote exec, not a
// captured Runner call. It used to run through the Runner, which buffers stdout
// and stderr into a result object that cmd_ssh then THREW AWAY, so a
// non-interactive caller (an agent verifying a change) saw nothing at all. Now:
//   * stdout/stderr are "inherit" — bytes stream through unbuffered, in order;
//   * stdin is "inherit" (or "ignore" with --no-stdin);
//   * the process rc is the REMOTE command's rc exactly, and ssh's own 255
//     (transport failure) stays 255;
//   * there is NO fleet2 deadline by default. `--timeout <seconds>` kills the
//     child (SIGTERM, then SIGKILL after 5 s) and exits 124, the timeout(1)
//     convention (`fleet2 rc`);
//   * `--tty` forces the interactive form (`ssh -t`) for programs needing a pty.
//
// U4 exemption, deliberate: a non-zero REMOTE rc gets NO `fleet2: ssh: …` line.
// The whole point of the command is that fleet2 adds nothing to the child's
// streams — ssh's own stderr is inherited, so a transport failure is never
// silent, and inventing a line would corrupt the output an agent is parsing.
// fleet2's OWN failures (usage, --timeout) do print one line, as U4 requires.
//
// F15/M11 SECRET CONTRACT (unchanged): the password reaches sshpass ONLY through
// the spawned child's env (SSHPASS), never process.env of the parent, never
// argv, never a log line. `resolveSshPassword` returns the value; callers pass
// it as `env: { SSHPASS }` to the spawner seam.

import type { Runner } from "../runner.ts";
import type { ParsedConfig } from "../config.ts";
import { log } from "../log.ts";
import { RC } from "../upgrade.ts";
import { RC_POINTER_LINE } from "./rc.ts";

const BOX_USER = "box";
const DEFAULT_SSH_PASSWORD = "12345678";

/** Grace between SIGTERM and SIGKILL when `--timeout` fires. */
export const KILL_GRACE_MS = 5_000;

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

/**
 * Build the ssh argv (box@<box> + opts + optional command). No password here.
 *
 * `extraOpts` is spliced in BEFORE `SSH_OPTS`, never after: ssh resolves each
 * option to the FIRST value it obtains, so an `-o ConnectTimeout=20` appended
 * after SSH_OPTS' `ConnectTimeout=6` would be silently ignored. The discover
 * transport (D2) relies on this ordering to raise its connect timeout WITHOUT
 * changing SSH_OPTS, which `fleet2 ssh` and enroll share.
 */
export function sshCmdArgv(box: string, command: string | undefined, extraOpts: string[] = []): string[] {
  const argv = ["sshpass", "-e", "ssh", ...extraOpts, ...SSH_OPTS, `${BOX_USER}@${box}`];
  if (command !== undefined) argv.push(command);
  return argv;
}

// --- argument parsing --------------------------------------------------------

export interface SshPlan {
  box: string;
  /** The remote command ("$*" join), or undefined for an interactive session. */
  command?: string;
  /** --tty: use `ssh -t` and the interactive (pty) form even with a command. */
  tty: boolean;
  /** stdin mode for the non-interactive form. */
  stdin: "inherit" | "ignore";
  /** --timeout, in seconds; undefined ⇒ no fleet2 deadline (the default). */
  timeoutSecs?: number;
}

export type SshParse = { plan: SshPlan } | { err: string } | { help: true };

/**
 * Parse `[flags] <box> [cmd...]`.
 *
 * fleet2's own flags (`--tty`, `--no-stdin`, `--timeout <s>`, `--json` is not
 * one of them) are recognised ANYWHERE in the list, because the natural agent
 * form puts them last: `fleet2 ssh box 'sleep 30' --timeout 2`. An UNKNOWN
 * `--flag` before the box is a usage error; after the box it belongs to the
 * remote command (`fleet2 ssh box ls --color` must work, main:701 parity).
 * `--` ends fleet2 flag scanning: everything after it is command text verbatim.
 */
export function parseSshArgs(args: string[]): SshParse {
  let box: string | undefined;
  const words: string[] = [];
  let tty = false;
  let stdin: "inherit" | "ignore" = "inherit";
  let timeoutSecs: number | undefined;
  let endOfFlags = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!endOfFlags) {
      if (a === "--") {
        endOfFlags = true;
        continue;
      }
      if (a === "--help" || a === "-h") return { help: true };
      if (a === "--tty") {
        tty = true;
        continue;
      }
      if (a === "--no-stdin") {
        stdin = "ignore";
        continue;
      }
      if (a === "--timeout") {
        const v = args[++i];
        if (v === undefined) return { err: "--timeout needs a value in seconds" };
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return { err: `--timeout '${v}' is not a positive number of seconds` };
        timeoutSecs = n;
        continue;
      }
      if (a.startsWith("--timeout=")) {
        const v = a.slice("--timeout=".length);
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return { err: `--timeout '${v}' is not a positive number of seconds` };
        timeoutSecs = n;
        continue;
      }
      // An unknown fleet2 flag is only an error BEFORE the box name.
      if (box === undefined && a.startsWith("-") && a !== "-") return { err: `unknown flag ${a}` };
    }
    if (box === undefined) box = a;
    else words.push(a);
  }

  if (box === undefined || box === "") return { err: "usage: fleet2 ssh [--tty] [--no-stdin] [--timeout <s>] <box> [cmd...]" };
  return {
    plan: { box, command: words.length > 0 ? words.join(" ") : undefined, tty, stdin, timeoutSecs },
  };
}

/** `fleet2 ssh --help` (U3/U5): greppable, one line per flag, rc pointer last. */
export const SSH_HELP = [
  "fleet2 ssh [--tty] [--no-stdin] [--timeout <s>] <box> [cmd...]  — run a command on a box, or open a session",
  "",
  "  no cmd            interactive session (inherited stdio)",
  "  <cmd...>          transparent remote exec: stdout/stderr stream through, rc is the REMOTE rc",
  "  --tty             force a pty (ssh -t) for programs that need one",
  "  --no-stdin        close the child's stdin instead of inheriting it",
  "  --timeout <s>     kill the remote command after <s> seconds (SIGTERM, SIGKILL after 5s) and exit 124",
  "  --                end fleet2 flags; everything after it is command text",
  "",
  "Pass ONE quoted command string: the words are joined with a single space and",
  "run by the remote login shell, exactly like bash's \"$*\".",
  "",
  RC_POINTER_LINE,
  "",
].join("\n");

// --- spawner seams -----------------------------------------------------------

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

/** A spawned child fleet2 can wait on and signal (the --timeout path). */
export interface ExecChild {
  /** Resolves when the child exits: the rc, or null iff a signal killed it. */
  readonly exited: Promise<number | null>;
  kill(signal: NodeJS.Signals): void;
}

/**
 * Spawner seam for the STREAMING non-interactive form (U1). Separate from
 * `InteractiveSpawner` because this one must be signalled while it runs.
 */
export interface ExecSpawner {
  spawn(argv: string[], env: Record<string, string>, opts: { stdin: "inherit" | "ignore" }): ExecChild;
}

/** Production exec spawner: Bun.spawn, stdout/stderr INHERITED (never piped). */
export const bunExecSpawner: ExecSpawner = {
  spawn(argv, env, opts) {
    const proc = Bun.spawn(argv, {
      stdin: opts.stdin,
      stdout: "inherit",
      stderr: "inherit",
      // SSHPASS is scoped to the CHILD only (F15).
      env: { ...process.env, ...env },
    });
    return {
      exited: proc.exited.then((code) => {
        const signal = (proc as unknown as { signalCode: string | null }).signalCode ?? null;
        return signal ? null : (code ?? null);
      }),
      kill: (signal) => proc.kill(signal),
    };
  },
};

/** Timer seam so the --timeout escalation is testable without real waiting. */
export interface TimerSeam {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: TimerSeam = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface SshDeps {
  runner: Runner;
  cfg: ParsedConfig;
  /** interactive spawner (inherited stdio); defaults to Bun.spawn. */
  interactive?: InteractiveSpawner;
  /** streaming spawner for the non-interactive form; defaults to Bun.spawn. */
  exec?: ExecSpawner;
  /** timer seam for --timeout (tests inject). */
  timers?: TimerSeam;
  /** env source for the password (tests inject). */
  envSource?: Record<string, string | undefined>;
  /** stdout sink for --help (tests inject). */
  write?: (s: string) => void;
}

/** cmd_ssh [flags] <box> [cmd...]. */
export async function cmdSsh(args: string[], deps: SshDeps): Promise<number> {
  const parsed = parseSshArgs(args);
  if ("help" in parsed) {
    (deps.write ?? ((s: string) => process.stdout.write(s)))(SSH_HELP);
    return RC.OK;
  }
  if ("err" in parsed) {
    // U4: exactly one stderr line before a non-zero return.
    log(parsed.err.startsWith("usage:") ? parsed.err : `ssh: ${parsed.err}`);
    return RC.USAGE;
  }
  const plan = parsed.plan;
  const pw = resolveSshPassword(deps.cfg, deps.envSource);

  // Interactive: no command at all, or --tty (a pty program). Inherited stdio,
  // rc = ssh's.
  if (plan.command === undefined || plan.tty) {
    const spawner = deps.interactive ?? bunInteractiveSpawner;
    const extra = plan.tty ? ["-t"] : [];
    return spawner.spawn(sshCmdArgv(plan.box, plan.command, extra), { SSHPASS: pw });
  }

  // Non-interactive: TRANSPARENT exec. No Runner (it captures and discards).
  const spawner = deps.exec ?? bunExecSpawner;
  const child = spawner.spawn(sshCmdArgv(plan.box, plan.command), { SSHPASS: pw }, { stdin: plan.stdin });

  if (plan.timeoutSecs === undefined) {
    const code = await child.exited;
    return code ?? RC.FAILURE;
  }

  const timers = deps.timers ?? realTimers;
  let firedTimeout = false;
  let killHandle: unknown;
  const handle = timers.set(() => {
    firedTimeout = true;
    child.kill("SIGTERM");
    killHandle = timers.set(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  }, plan.timeoutSecs * 1000);

  const code = await child.exited;
  timers.clear(handle);
  if (killHandle !== undefined) timers.clear(killHandle);

  if (firedTimeout) {
    // fleet2's OWN failure, so U4 applies: one stderr line naming the reason.
    log(`ssh: ${plan.box}: timed out after ${plan.timeoutSecs}s — remote command killed`);
    return RC.TIMEOUT;
  }
  return code ?? RC.FAILURE;
}
