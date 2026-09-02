// ssh-exec.test.ts — agent-ux U1/U6: `fleet2 ssh <box> <cmd>` is a TRANSPARENT
// remote exec, not a captured Runner call.
//
// Mutant (a) in ANY shape — back through the capturing Runner, or across to the
// interactive/pty spawner — is killed by the "seam selection" table below, which
// injects every seam and asserts which one ran. The r1 version only asserted
// that the Runner had not been called, so the interactive re-route slipped past
// it on the gate box; asserting the positive is what makes this deterministic.

import { describe, test, expect } from "bun:test";
import {
  cmdSsh,
  parseSshArgs,
  KILL_GRACE_MS,
  SSH_HELP,
  type ExecChild,
  type ExecSpawner,
  type InteractiveSpawner,
  type TimerSeam,
} from "../../src/commands/ssh.ts";
import { parseConfig } from "../../src/config.ts";
import { FakeRunner } from "../fake-runner.ts";
import { setLogSink } from "../../src/log.ts";
import { RC } from "../../src/upgrade.ts";

const EMPTY_CFG = parseConfig(undefined, "/x");

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  return { lines, restore: () => setLogSink(prev) };
}

interface Spawned {
  argv: string[];
  env: Record<string, string>;
  stdin: "inherit" | "ignore";
  kills: string[];
}

/**
 * An InteractiveSpawner that records calls and NEVER spawns anything.
 *
 * Every non-interactive test injects this even though it must not be used.
 * gate-r1 found mutant (a) surviving on a box: the earlier tests only asserted
 * "the Runner was not called", so re-routing the non-interactive form to the
 * INTERACTIVE spawner went unnoticed — and on a host where the production
 * spawner's `sshpass` is missing or a connection fails fast, the mutated code
 * happened to return rcs the assertions tolerated. Injecting both seams and
 * asserting which one ran makes the check positive, instant and box-independent.
 */
function spySpawner(rc = 0): { spawner: InteractiveSpawner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    spawner: {
      async spawn(argv) {
        calls.push(argv);
        return rc;
      },
    },
  };
}

/** A fake ExecSpawner whose child exits with `code` (or never, when undefined). */
function fakeExec(code: number | null | undefined): { spawner: ExecSpawner; seen: Spawned[]; finish: (c: number | null) => void } {
  const seen: Spawned[] = [];
  let resolve!: (c: number | null) => void;
  const spawner: ExecSpawner = {
    spawn(argv, env, opts) {
      const rec: Spawned = { argv, env, stdin: opts.stdin, kills: [] };
      seen.push(rec);
      const child: ExecChild = {
        exited: new Promise<number | null>((r) => {
          resolve = r;
          if (code !== undefined) r(code);
        }),
        kill: (sig) => void rec.kills.push(String(sig)),
      };
      return child;
    },
  };
  return { spawner, seen, finish: (c) => resolve(c) };
}

/** Timers that never fire on their own; the test fires them by hand. */
function fakeTimers(): { seam: TimerSeam; fire: (ms: number) => void; cleared: number[] } {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const cleared: number[] = [];
  let next = 1;
  const seam: TimerSeam = {
    set(fn, ms) {
      const h = next++;
      pending.set(h, { fn, ms });
      return h;
    },
    clear(h) {
      cleared.push(h as number);
      pending.delete(h as number);
    },
  };
  return {
    seam,
    fire(ms) {
      for (const [h, p] of [...pending]) {
        if (p.ms === ms) {
          pending.delete(h);
          p.fn();
        }
      }
    },
    cleared,
  };
}

describe("U1 argument parsing", () => {
  test("box + '$*' join; flags are recognised BEFORE and AFTER the command", () => {
    const a = parseSshArgs(["grok-box-001", "echo", "hi"]);
    expect("plan" in a && a.plan.box).toBe("grok-box-001");
    expect("plan" in a && a.plan.command).toBe("echo hi");

    // the natural agent form: the flag trails the quoted command string.
    const b = parseSshArgs(["grok-box-001", "sleep 30", "--timeout", "2"]);
    expect("plan" in b && b.plan.command).toBe("sleep 30");
    expect("plan" in b && b.plan.timeoutSecs).toBe(2);

    const c = parseSshArgs(["--tty", "--no-stdin", "grok-box-001", "top"]);
    expect("plan" in c && c.plan.tty).toBe(true);
    expect("plan" in c && c.plan.stdin).toBe("ignore");
  });

  test("an UNKNOWN flag after the box belongs to the remote command (main:701 parity)", () => {
    const p = parseSshArgs(["grok-box-001", "ls", "--color", "-l"]);
    expect("plan" in p && p.plan.command).toBe("ls --color -l");
  });

  test("an unknown flag BEFORE the box is a usage error; `--` ends flag scanning", () => {
    expect(parseSshArgs(["--nope", "grok-box-001"])).toEqual({ err: "unknown flag --nope" });
    const p = parseSshArgs(["grok-box-001", "--", "--tty", "x"]);
    expect("plan" in p && p.plan.command).toBe("--tty x");
    expect("plan" in p && p.plan.tty).toBe(false);
  });

  test("--timeout validates its value", () => {
    expect("err" in parseSshArgs(["grok-box-001", "x", "--timeout"])).toBe(true);
    expect("err" in parseSshArgs(["grok-box-001", "x", "--timeout", "0"])).toBe(true);
    expect("err" in parseSshArgs(["grok-box-001", "x", "--timeout", "abc"])).toBe(true);
    const p = parseSshArgs(["grok-box-001", "x", "--timeout=1.5"]);
    expect("plan" in p && p.plan.timeoutSecs).toBe(1.5);
  });

  test("no box ⇒ usage rc 2 with one stderr line, and NOTHING is spawned", async () => {
    const cap = captureLog();
    const ex = fakeExec(0);
    const rc = await cmdSsh([], { runner: new FakeRunner(), cfg: EMPTY_CFG, exec: ex.spawner });
    cap.restore();
    expect(rc).toBe(RC.USAGE);
    expect(cap.lines.length).toBe(1);
    expect(cap.lines[0]).toContain("usage: fleet2 ssh");
    expect(ex.seen.length).toBe(0);
  });

  test("--help prints the greppable ssh help ending in the rc pointer, rc 0", async () => {
    let text = "";
    const rc = await cmdSsh(["--help"], {
      runner: new FakeRunner(),
      cfg: EMPTY_CFG,
      write: (s) => void (text += s),
    });
    expect(rc).toBe(RC.OK);
    expect(text).toBe(SSH_HELP);
    expect(text).toContain("exit codes: fleet2 rc");
    expect(text).toContain("--timeout <s>");
  });
});

describe("U1 seam selection (mutant (a), any shape)", () => {
  // A table over all four invocation forms: exactly one seam may run, and every
  // other seam must be untouched. Re-routing the non-interactive form anywhere
  // else — the capturing Runner, the interactive/pty spawner, a new helper —
  // fails here immediately, with no process spawned and no network touched.
  const FORMS: Array<{ name: string; args: string[]; seam: "exec" | "interactive" }> = [
    { name: "plain command", args: ["grok-box-001", "echo hi"], seam: "exec" },
    { name: "command + --no-stdin", args: ["grok-box-001", "echo hi", "--no-stdin"], seam: "exec" },
    { name: "command + --timeout", args: ["grok-box-001", "echo hi", "--timeout", "30"], seam: "exec" },
    { name: "command + --tty", args: ["grok-box-001", "top", "--tty"], seam: "interactive" },
    { name: "no command (session)", args: ["grok-box-001"], seam: "interactive" },
  ];

  for (const f of FORMS) {
    test(`${f.name} ⇒ ONLY the ${f.seam} seam runs`, async () => {
      const runner = new FakeRunner(() => ({ code: 0 }));
      const ex = fakeExec(0);
      const isp = spySpawner(0);
      const rc = await cmdSsh(f.args, { runner, cfg: EMPTY_CFG, exec: ex.spawner, interactive: isp.spawner });
      expect(rc).toBe(0);
      // the capturing Runner is never right for any form of `fleet2 ssh`.
      expect(runner.calls.length).toBe(0);
      expect(ex.seen.length).toBe(f.seam === "exec" ? 1 : 0);
      expect(isp.calls.length).toBe(f.seam === "interactive" ? 1 : 0);
    });
  }

  test("the non-interactive form NEVER touches the capturing Runner", async () => {
    const runner = new FakeRunner(() => ({ code: 0 }));
    const ex = fakeExec(0);
    const isp = spySpawner(0);
    const rc = await cmdSsh(["grok-box-001", "echo hi"], {
      runner,
      cfg: EMPTY_CFG,
      exec: ex.spawner,
      interactive: isp.spawner,
    });
    expect(rc).toBe(0);
    expect(runner.calls.length).toBe(0);
    expect(isp.calls.length).toBe(0);
    expect(ex.seen.length).toBe(1);
  });

  test("stdio: stdin INHERITED by default, IGNORED with --no-stdin", async () => {
    const a = fakeExec(0);
    await cmdSsh(["grok-box-001", "cat"], { runner: new FakeRunner(), cfg: EMPTY_CFG, exec: a.spawner, interactive: spySpawner(0).spawner });
    expect(a.seen[0]!.stdin).toBe("inherit");

    const b = fakeExec(0);
    await cmdSsh(["grok-box-001", "cat", "--no-stdin"], { runner: new FakeRunner(), cfg: EMPTY_CFG, exec: b.spawner, interactive: spySpawner(0).spawner });
    expect(b.seen[0]!.stdin).toBe("ignore");
  });

  test("rc pass-through: 0, 3 and 255 reach the caller unchanged", async () => {
    for (const code of [0, 3, 255]) {
      const ex = fakeExec(code);
      const rc = await cmdSsh(["grok-box-001", "exit-with"], {
        runner: new FakeRunner(),
        cfg: EMPTY_CFG,
        exec: ex.spawner,
        interactive: spySpawner(0).spawner,
      });
      expect(rc).toBe(code);
    }
  });

  test("a non-zero REMOTE rc prints NO fleet2 line (the documented U4 exemption)", async () => {
    const cap = captureLog();
    const ex = fakeExec(3);
    const rc = await cmdSsh(["grok-box-001", "false"], {
      runner: new FakeRunner(),
      cfg: EMPTY_CFG,
      exec: ex.spawner,
    });
    cap.restore();
    expect(rc).toBe(3);
    // fleet2 adds nothing to the child's streams; ssh's own stderr is inherited.
    expect(cap.lines).toEqual([]);
  });

  test("SSHPASS reaches the child ONLY through its env, never argv or the parent", async () => {
    const ex = fakeExec(0);
    await cmdSsh(["grok-box-001", "uptime"], {
      runner: new FakeRunner(),
      cfg: EMPTY_CFG,
      exec: ex.spawner,
      interactive: spySpawner(0).spawner,
      envSource: { FLEET_SSH_PASSWORD: "sekret" },
    });
    const s = ex.seen[0]!;
    expect(s.env).toEqual({ SSHPASS: "sekret" });
    expect(s.argv.join(" ")).not.toContain("sekret");
    expect(process.env.SSHPASS).toBeUndefined();
    expect(s.argv[s.argv.length - 1]).toBe("uptime");
  });
});

describe("U1 --timeout ⇒ 124", () => {
  test("SIGTERM at the deadline, SIGKILL after the grace window, rc 124, one stderr line", async () => {
    const cap = captureLog();
    const ex = fakeExec(undefined); // the child does not exit on its own
    const t = fakeTimers();
    const p = cmdSsh(["grok-box-001", "sleep 30", "--timeout", "2"], {
      runner: new FakeRunner(),
      cfg: EMPTY_CFG,
      exec: ex.spawner,
      interactive: spySpawner(0).spawner,
      timers: t.seam,
    });
    // the deadline fires: SIGTERM first.
    t.fire(2000);
    expect(ex.seen[0]!.kills).toEqual(["SIGTERM"]);
    // still alive after the grace window: SIGKILL.
    t.fire(KILL_GRACE_MS);
    expect(ex.seen[0]!.kills).toEqual(["SIGTERM", "SIGKILL"]);
    ex.finish(null); // killed by a signal ⇒ no exit code
    const rc = await p;
    cap.restore();
    expect(rc).toBe(RC.TIMEOUT);
    expect(rc).toBe(124);
    expect(cap.lines.length).toBe(1);
    expect(cap.lines[0]).toContain("timed out after 2s");
  });

  test("a command that finishes inside the window keeps its own rc and is not killed", async () => {
    const cap = captureLog();
    const ex = fakeExec(7);
    const t = fakeTimers();
    const rc = await cmdSsh(["grok-box-001", "quick", "--timeout", "30"], {
      runner: new FakeRunner(),
      cfg: EMPTY_CFG,
      exec: ex.spawner,
      interactive: spySpawner(0).spawner,
      timers: t.seam,
    });
    cap.restore();
    expect(rc).toBe(7);
    expect(ex.seen[0]!.kills).toEqual([]);
    expect(t.cleared.length).toBeGreaterThan(0); // the deadline timer was cleared
    expect(cap.lines).toEqual([]);
  });
});

describe("U1 --tty", () => {
  test("--tty routes to the pty spawner and puts -tt (not -t) on the argv", async () => {
    const isp = spySpawner(0);
    const ex = fakeExec(0);
    const rc = await cmdSsh(["grok-box-001", "top", "--tty"], {
      runner: new FakeRunner(),
      cfg: EMPTY_CFG,
      interactive: isp.spawner,
      exec: ex.spawner,
    });
    expect(rc).toBe(0);
    const argv = isp.calls[0]!;
    // `-t` alone only asks; ssh declines with "Pseudo-terminal will not be
    // allocated because stdin is not a terminal" whenever the caller is not at
    // a terminal — which is every agent that reaches for --tty. `-tt` forces it.
    expect(argv).toContain("-tt");
    expect(argv).not.toContain("-t");
    expect(argv[argv.length - 1]).toBe("top");
    // -tt is spliced BEFORE the shared SSH_OPTS, never after.
    expect(argv.indexOf("-tt")).toBeLessThan(argv.indexOf("StrictHostKeyChecking=accept-new"));
    expect(ex.seen.length).toBe(0); // the streaming spawner is not used for a pty
  });
});

describe("U1 the first-use known-host banner (gate-r1 finding 4)", () => {
  test("the non-interactive form asks ssh for LogLevel=ERROR", async () => {
    const ex = fakeExec(0);
    await cmdSsh(["grok-box-001", "true"], {
      runner: new FakeRunner(),
      cfg: EMPTY_CFG,
      exec: ex.spawner,
      interactive: spySpawner(0).spawner,
    });
    const argv = ex.seen[0]!.argv;
    expect(argv).toContain("LogLevel=ERROR");
    // spliced before the shared opts, like every other extra option: ssh keeps
    // the FIRST value it sees for an option.
    expect(argv.indexOf("LogLevel=ERROR")).toBeLessThan(argv.indexOf("StrictHostKeyChecking=accept-new"));
    // the pinning behaviour itself is unchanged.
    expect(argv).toContain("StrictHostKeyChecking=accept-new");
    // D11(a) still holds: no known-hosts redirection on this human-facing command.
    expect(argv.join(" ")).not.toContain("UserKnownHostsFile");
  });

  test("the INTERACTIVE forms keep ssh's default log level, banner included", async () => {
    for (const args of [["grok-box-001"], ["grok-box-001", "top", "--tty"]]) {
      const isp = spySpawner(0);
      await cmdSsh(args, {
        runner: new FakeRunner(),
        cfg: EMPTY_CFG,
        interactive: isp.spawner,
        exec: fakeExec(0).spawner,
      });
      // A person opening a session SHOULD see "Permanently added …".
      expect(isp.calls[0]!.join(" ")).not.toContain("LogLevel");
    }
  });
});
