// ssh.test.ts — T-ssh usage + secret contract (D15/F15, m10/m18).

import { describe, test, expect } from "bun:test";
import {
  cmdSsh,
  resolveSshPassword,
  sshCmdArgv,
  type ExecChild,
  type ExecSpawner,
  type InteractiveSpawner,
} from "../../src/commands/ssh.ts";
import { parseConfig } from "../../src/config.ts";
import { FakeRunner } from "../fake-runner.ts";
import { setLogSink } from "../../src/log.ts";

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  return { lines, restore: () => setLogSink(prev) };
}

const EMPTY_CFG = parseConfig(undefined, "/x");

describe("T-ssh usage + argv", () => {
  test("no box ⇒ usage rc 2", async () => {
    const cap = captureLog();
    const runner = new FakeRunner();
    const rc = await cmdSsh([], { runner, cfg: EMPTY_CFG });
    cap.restore();
    expect(rc).toBe(2);
    // agent-ux U5 names the new flags in the usage line; the operand tail keeps
    // its bash shape (main:696-699).
    expect(cap.lines.some((l) => l.includes("usage: fleet2 ssh"))).toBe(true);
    expect(cap.lines.some((l) => l.includes("<box> [cmd...]"))).toBe(true);
    expect(cap.lines.some((l) => l.includes("--timeout <s>"))).toBe(true);
    expect(runner.calls.length).toBe(0);
  });

  test("argv carries the ssh options and box@<box>, NO password (m10)", () => {
    const argv = sshCmdArgv("grok-box-8", "uptime");
    expect(argv).toEqual([
      "sshpass",
      "-e",
      "ssh",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=6",
      "-o",
      "BatchMode=no",
      "box@grok-box-8",
      "uptime",
    ]);
    expect(argv.join(" ")).not.toContain("12345678");
  });

  test("D11(a): the INTERACTIVE forms carry NO known-hosts option (kills mutant l)", () => {
    // `fleet2 ssh` is human-invoked, often from a laptop where FLEET_STATE does
    // not exist. It keeps ssh's defaults, the user's own ~/.ssh/known_hosts, no
    // auto-forget and a visible banner. Both forms.
    for (const argv of [sshCmdArgv("grok-box-8", "uptime"), sshCmdArgv("grok-box-8", undefined)]) {
      const joined = argv.join(" ");
      expect(joined).not.toContain("UserKnownHostsFile");
      expect(joined).not.toContain("GlobalKnownHostsFile");
      expect(joined).not.toContain("HashKnownHosts");
      expect(joined).not.toContain("CheckHostIP");
      expect(joined).not.toContain("known_hosts");
    }
  });
});

describe("T-ssh password resolution (main:108)", () => {
  test("FLEET_SSH_PASSWORD env > config > default", () => {
    expect(resolveSshPassword(EMPTY_CFG, { FLEET_SSH_PASSWORD: "envpw" })).toBe("envpw");
    const cfg = parseConfig('[ssh]\npassword = "cfgpw"\n', "/x");
    expect(resolveSshPassword(cfg, {})).toBe("cfgpw");
    expect(resolveSshPassword(EMPTY_CFG, {})).toBe("12345678");
  });
});

describe("T-ssh secret contract (F15/m18)", () => {
  test("non-interactive: SSHPASS only in the child env, never argv/parent, rc = ssh's", async () => {
    // agent-ux U1 moved this form off the capturing Runner and onto the
    // streaming ExecSpawner. The CONTRACT is unchanged and asserted here on the
    // new seam: the password reaches the child through env and nowhere else.
    const runner = new FakeRunner(() => ({ code: 0 }));
    let seen: { argv: string[]; env: Record<string, string> } | undefined;
    const exec: ExecSpawner = {
      spawn(argv, env): ExecChild {
        seen = { argv, env };
        return { exited: Promise.resolve(0), kill: () => {} };
      },
    };
    const rc = await cmdSsh(["grok-box-8", "echo", "hi"], {
      runner,
      cfg: EMPTY_CFG,
      exec,
      envSource: { FLEET_SSH_PASSWORD: "sekret" },
    });
    expect(rc).toBe(0);
    // password ONLY in the child env, never argv, never the parent process.env.
    expect(seen!.env).toEqual({ SSHPASS: "sekret" });
    expect(seen!.argv.join(" ")).not.toContain("sekret");
    expect(process.env.SSHPASS).toBeUndefined();
    // "$*" join: the command is the remaining args joined with a space.
    expect(seen!.argv[seen!.argv.length - 1]).toBe("echo hi");
    // the Runner (which buffers and discards) is never involved.
    expect(runner.calls.length).toBe(0);
  });

  test("interactive: inherited-stdio spawner gets SSHPASS in env, rc = ssh's; parent env clean", async () => {
    let capturedEnv: Record<string, string> = {};
    let capturedArgv: string[] = [];
    const spawner: InteractiveSpawner = {
      async spawn(argv, env) {
        capturedArgv = argv;
        capturedEnv = env;
        return 42;
      },
    };
    const rc = await cmdSsh(["grok-box-8"], {
      runner: new FakeRunner(),
      cfg: EMPTY_CFG,
      interactive: spawner,
      envSource: { FLEET_SSH_PASSWORD: "sekret2" },
    });
    expect(rc).toBe(42);
    expect(capturedEnv).toEqual({ SSHPASS: "sekret2" });
    expect(capturedArgv.join(" ")).not.toContain("sekret2");
    expect(process.env.SSHPASS).toBeUndefined();
  });
});
