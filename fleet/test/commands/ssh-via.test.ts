// ssh-via.test.ts — `grokfleet ssh --via tailnet|tunnel` and `--lease <id>`
// (blueprint fleet2-lease-api L4/r2-B2/r3-B1/r4-B2/r6-B1).

import { describe, expect, test } from "bun:test";
import {
  cmdSsh,
  defaultVia,
  parseSshArgs,
  tunnelFormArgv,
  type ExecChild,
  type ExecSpawner,
  type InteractiveSpawner,
} from "../../src/commands/ssh.ts";
import { scpArgv, sshArgv, tunnelSshOpts } from "../../src/tunnel.ts";
import { parseConfig } from "../../src/config.ts";
import { testEnv } from "../helpers.ts";
import { FakeRunner, result } from "../fake-runner.ts";
import { RC } from "../../src/upgrade.ts";
import { setLogSink } from "../../src/log.ts";
import type { ApiClient, ClientResult, Lease } from "../../src/tui/api-client.ts";

const CFG = parseConfig("", "/fake.toml");
const ENV = testEnv({ FLEET_ETC: "/etc/gf", FLEET_STATE: "/var/gf", FLEET_BOX_KEY: "/etc/gf/box_access_ed25519" });
const KNOWN_HOSTS = "/var/gf/known_hosts";
const KEY = "/etc/gf/box_access_ed25519";

/** The seven options the D11(a) contract pins, in order, below the port flag. */
const PREFIX = tunnelSshOpts(KEY, KNOWN_HOSTS);

function fakeInteractive(): { spawner: InteractiveSpawner; argvs: string[][]; envs: Array<Record<string, string>> } {
  const argvs: string[][] = [];
  const envs: Array<Record<string, string>> = [];
  return {
    argvs,
    envs,
    spawner: {
      async spawn(argv, env) {
        argvs.push(argv);
        envs.push(env);
        return 0;
      },
    },
  };
}

function fakeExec(rc = 0): { spawner: ExecSpawner; argvs: string[][]; envs: Array<Record<string, string>> } {
  const argvs: string[][] = [];
  const envs: Array<Record<string, string>> = [];
  return {
    argvs,
    envs,
    spawner: {
      spawn(argv, env): ExecChild {
        argvs.push(argv);
        envs.push(env);
        return { exited: Promise.resolve(rc), kill: () => {} };
      },
    },
  };
}

function fakeLeaseApi(r: ClientResult<Lease>): ApiClient {
  const notImpl = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    async getLease() {
      return r;
    },
    fleet: notImpl,
    box: notImpl,
    diff: notImpl,
    history: notImpl,
    journal: notImpl,
    check: notImpl,
    configPush: notImpl,
    rotateKey: notImpl,
    rename: notImpl,
    reconcile: notImpl,
    acquireLease: notImpl,
    renewLease: notImpl,
    releaseLease: notImpl,
    listLeases: notImpl,
  } as unknown as ApiClient;
}

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  return { lines, restore: () => setLogSink(prev) };
}

describe("r4-B2/r6-B1 — ONE option prefix, three forms, two builders", () => {
  test("MUTANT (l12): all three `--via tunnel` forms carry EXACTLY tunnelSshOpts after the port", () => {
    const forms = [
      tunnelFormArgv("grok-box-003", KEY, KNOWN_HOSTS, { command: "true", tty: false }),
      tunnelFormArgv("grok-box-003", KEY, KNOWN_HOSTS, { command: undefined, tty: false }),
      tunnelFormArgv("grok-box-003", KEY, KNOWN_HOSTS, { command: "true", tty: true }),
    ];
    for (const argv of forms) {
      expect(argv.slice(0, 3)).toEqual(["ssh", "-p", "20003"]);
      expect(argv.slice(3, 3 + PREFIX.length)).toEqual(PREFIX);
    }
    // The prefix really is the D11(a) set, in order — a rebuilt list that
    // dropped KNOWN_HOSTS_OPTS would not deep-equal it.
    expect(PREFIX).toEqual([
      "-i",
      KEY,
      "-o",
      "BatchMode=yes",
      "-o",
      `UserKnownHostsFile=${KNOWN_HOSTS}`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "HashKnownHosts=no",
      "-o",
      "CheckHostIP=no",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=8",
    ]);
  });

  test("the ENGINE's own builders carry the same prefix — `-p` for ssh, `-P` for scp", () => {
    const s = sshArgv("grok-box-003", KEY, "true", KNOWN_HOSTS);
    expect(s.slice(0, 3)).toEqual(["ssh", "-p", "20003"]);
    expect(s.slice(3, 3 + PREFIX.length)).toEqual(PREFIX);

    // r6-B1: the copy builder is asserted TOO, and its port flag is UPPERCASE —
    // a helper that owned the port would have made this `-p`, scp's
    // preserve-times flag, and broken the copy silently.
    const c = scpArgv("grok-box-003", KEY, "/l", "/r", KNOWN_HOSTS);
    expect(c.slice(0, 3)).toEqual(["scp", "-P", "20003"]);
    expect(c.slice(3, 3 + PREFIX.length)).toEqual(PREFIX);
  });

  test("MUTANT (l13): the INTERACTIVE form appends `-t`, never an empty command", () => {
    const argv = tunnelFormArgv("grok-box-003", KEY, KNOWN_HOSTS, { command: undefined, tty: false });
    expect(argv.slice(-2)).toEqual(["-t", "box@127.0.0.1"]);
    expect(argv).not.toContain("");

    // The command form has NO -t and ends with the command.
    const cmd = tunnelFormArgv("grok-box-003", KEY, KNOWN_HOSTS, { command: "make test", tty: false });
    expect(cmd).not.toContain("-t");
    expect(cmd.slice(-2)).toEqual(["box@127.0.0.1", "make test"]);

    // --tty is both: a pty AND the command.
    const tty = tunnelFormArgv("grok-box-003", KEY, KNOWN_HOSTS, { command: "top", tty: true });
    expect(tty.slice(-3)).toEqual(["-t", "box@127.0.0.1", "top"]);
  });
});

describe("r2-B2 — the --via default and its refusals", () => {
  test("the default is `tunnel` iff the identity file is readable", () => {
    expect(defaultVia(true)).toBe("tunnel");
    expect(defaultVia(false)).toBe("tailnet");
  });

  test("`--via tunnel` with an UNREADABLE identity file refuses rc 6 and names --via tailnet", async () => {
    const cap = capture();
    const rc = await cmdSsh(["--via", "tunnel", "grok-box-003", "true"], {
      runner: new FakeRunner(() => result({})),
      cfg: CFG,
      env: ENV,
      readable: () => false,
    });
    cap.restore();
    expect(rc).toBe(RC.REFUSED);
    expect(cap.lines.join("\n")).toContain("--via tunnel needs a readable box-access identity file");
    expect(cap.lines.join("\n")).toContain("--via tailnet");
  });

  test("r4-n5: a readable identity file but NOTHING LISTENING is also rc 6", async () => {
    const cap = capture();
    const rc = await cmdSsh(["--via", "tunnel", "grok-box-003", "true"], {
      runner: new FakeRunner(() => result({})),
      cfg: CFG,
      env: ENV,
      readable: () => true,
      tunnelUp: async () => false,
    });
    cap.restore();
    expect(rc).toBe(RC.REFUSED);
    expect(cap.lines.join("\n")).toContain("nothing is listening on 127.0.0.1:20003 for grok-box-003");
  });

  test("`--via tunnel` runs the key-auth argv with NO SSHPASS in the child env", async () => {
    const ex = fakeExec(0);
    const rc = await cmdSsh(["--via", "tunnel", "grok-box-003", "make", "test"], {
      runner: new FakeRunner(() => result({})),
      cfg: CFG,
      env: ENV,
      readable: () => true,
      tunnelUp: async () => true,
      exec: ex.spawner,
    });
    expect(rc).toBe(0);
    expect(ex.argvs[0]!.slice(3, 3 + PREFIX.length)).toEqual(PREFIX);
    expect(ex.envs[0]).toEqual({}); // key auth: the password never appears
  });

  test("`--via tailnet` keeps the sshpass form and the SSHPASS child env", async () => {
    const ex = fakeExec(0);
    await cmdSsh(["--via", "tailnet", "grok-box-003", "true"], {
      runner: new FakeRunner(() => result({})),
      cfg: CFG,
      env: ENV,
      readable: () => true, // would default to tunnel; --via overrides
      exec: ex.spawner,
      envSource: {},
    });
    expect(ex.argvs[0]![0]).toBe("sshpass");
    expect(ex.envs[0]!["SSHPASS"]).toBe("12345678");
  });

  test("the interactive tunnel form goes through the INTERACTIVE spawner", async () => {
    const it = fakeInteractive();
    await cmdSsh(["--via", "tunnel", "grok-box-003"], {
      runner: new FakeRunner(() => result({})),
      cfg: CFG,
      env: ENV,
      readable: () => true,
      tunnelUp: async () => true,
      interactive: it.spawner,
    });
    expect(it.argvs[0]!.slice(-2)).toEqual(["-t", "box@127.0.0.1"]);
  });

  test("a bad --via value is a usage error", async () => {
    const cap = capture();
    const rc = await cmdSsh(["--via", "carrier-pigeon", "grok-box-003"], { runner: new FakeRunner(() => result({})), cfg: CFG });
    cap.restore();
    expect(rc).toBe(RC.USAGE);
    expect(cap.lines.join("\n")).toContain("--via must be 'tailnet' or 'tunnel'");
  });
});

describe("L4 — `--lease <id>` resolves the box through the API", () => {
  test("the lease's box becomes the target, and the words stay the command", async () => {
    const ex = fakeExec(0);
    const lease: Lease = {
      lease_id: "L1",
      box: "grok-box-007",
      kind: "ephemeral",
      holder: "admin-one",
      purpose: "gate",
      state: "active",
      created_at: "2026-06-01T00:00:00Z",
      expires_at: null,
      renewed_at: null,
      released_at: null,
      expired_at: null,
      lost_at: null,
      lost_reason: null,
      grace_ends_at: null,
    };
    const rc = await cmdSsh(["--lease", "L1", "--via", "tailnet", "echo", "hi"], {
      runner: new FakeRunner(() => result({})),
      cfg: CFG,
      env: ENV,
      api: () => fakeLeaseApi({ ok: true, value: lease }),
      exec: ex.spawner,
      envSource: {},
    });
    expect(rc).toBe(0);
    expect(ex.argvs[0]).toContain("box@grok-box-007");
    expect(ex.argvs[0]!.at(-1)).toBe("echo hi");
  });

  test("an unknown lease is rc 6 with one stderr line", async () => {
    const cap = capture();
    const rc = await cmdSsh(["--lease", "nope", "true"], {
      runner: new FakeRunner(() => result({})),
      cfg: CFG,
      env: ENV,
      api: () => fakeLeaseApi({ ok: false, kind: "error", status: 404, message: "unknown lease 'nope'" }),
    });
    cap.restore();
    expect(rc).toBe(RC.REFUSED);
    expect(cap.lines.join("\n")).toContain("ssh: lease nope: unknown lease 'nope'");
  });

  test("parseSshArgs: `--lease` takes the box's place, before OR after the command", () => {
    const a = parseSshArgs(["--lease", "L1", "echo", "hi"]);
    expect("plan" in a && a.plan.lease).toBe("L1");
    expect("plan" in a && a.plan.command).toBe("echo hi");
    const b = parseSshArgs(["echo", "hi", "--lease", "L1"]);
    expect("plan" in b && b.plan.command).toBe("echo hi");
    // …and an interactive session on a lease needs no words at all.
    const c = parseSshArgs(["--lease", "L1"]);
    expect("plan" in c && c.plan.command).toBeUndefined();
    // `--lease` with no value is a usage error.
    expect(parseSshArgs(["--lease"])).toEqual({ err: "--lease needs a lease id" });
  });
});
