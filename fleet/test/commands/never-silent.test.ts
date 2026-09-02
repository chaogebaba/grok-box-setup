// never-silent.test.ts — agent-ux U4/U6: no command returns a non-zero rc
// without saying why on STDERR, and no error text is written to stdout.
//
// The walker drives every command entry point in `src/commands/*` (and the
// cli.ts dispatch) with seams rigged to fail, capturing BOTH stderr channels
// fleet2 uses: `log()` (the timestamped journal line) and direct
// `process.stderr.write` calls. Each case is NAMED, so mutant (d) — delete one
// stderr line — fails pointing at the path that went quiet.
//
// ONE documented exemption: `fleet2 ssh <box> <cmd>` passing through a non-zero
// REMOTE rc. U1 makes that form a transparent exec — fleet2 must not inject a
// line into streams the caller is parsing, and ssh's own stderr is inherited, so
// the failure is never actually silent. fleet2's OWN ssh failures (usage, the
// --timeout kill) do print, and are covered here.

import { describe, test, expect } from "bun:test";
import { setLogSink } from "../../src/log.ts";
import { RC } from "../../src/upgrade.ts";
import { parseConfig } from "../../src/config.ts";
import { FakeRunner, result } from "../fake-runner.ts";
import { testEnv } from "../helpers.ts";

import { decide, emit } from "../../src/commands/dispatch.ts";
import { rolloutRefusal } from "../../src/commands/aliases.ts";
import { refuseVpsOnly } from "../../src/commands/locality.ts";
import { cmdConfig } from "../../src/commands/config.ts";
import { cmdSsh, type ExecChild, type ExecSpawner, type TimerSeam } from "../../src/commands/ssh.ts";
import { cmdMintKey } from "../../src/commands/mint-key.ts";
import { cmdInstallTimer, cmdRemoveTimer } from "../../src/commands/timers.ts";
import { cmdEnroll } from "../../src/commands/enroll.ts";
import { cmdRename } from "../../src/commands/rename.ts";
import { cmdState } from "../../src/commands/state.ts";
import { renderManaged } from "../../src/managed/render.ts";
import { textSha256 } from "../../src/managed/remote-script.ts";

const EMPTY_CFG = parseConfig(undefined, "/x");

/** Fixtures for the one case that needs a healthy tunnel and a real diff(1). */
const CFG_DIFF_FLEET_TOML = '[ssh]\npassword = "abc"\n';
const SS_UP_20008 = 'LISTEN 0 128 127.0.0.1:20008 0.0.0.0:* users:(("sshd",pid=41,fd=7))\n';

/** Capture everything fleet2 sends to stderr, whichever channel it uses. */
function capture<T>(fn: (out: (s: string) => void) => Promise<T> | T): Promise<{ rc: T; err: string; out: string }> {
  const errParts: string[] = [];
  const outParts: string[] = [];
  const prevSink = setLogSink((l) => errParts.push(l + "\n"));
  const realWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    errParts.push(String(s));
    return true;
  };
  const restore = () => {
    setLogSink(prevSink);
    (process.stderr as unknown as { write: typeof realWrite }).write = realWrite;
  };
  return Promise.resolve(fn((s) => outParts.push(s)))
    .then((rc) => {
      restore();
      return { rc, err: errParts.join(""), out: outParts.join("") };
    })
    .catch((e) => {
      restore();
      throw e;
    });
}

/** A child that runs until it is signalled, then exits killed (code null). */
function stuckExec(): { spawner: ExecSpawner; kills: string[] } {
  const kills: string[] = [];
  return {
    kills,
    spawner: {
      spawn(): ExecChild {
        let done!: (c: number | null) => void;
        const exited = new Promise<number | null>((r) => (done = r));
        return {
          exited,
          kill: (s) => {
            kills.push(String(s));
            done(null);
          },
        };
      },
    },
  };
}

/** Timers the test fires by hand. */
function handTimers(): { seam: TimerSeam; fireAll: () => void } {
  const pending: Array<() => void> = [];
  return {
    seam: {
      set(fn) {
        pending.push(fn);
        return pending.length;
      },
      clear() {},
    },
    fireAll() {
      while (pending.length > 0) pending.shift()!();
    },
  };
}

/** Every NAMED non-zero path the walker can reach without a real box. */
const CASES: Array<{
  name: string;
  /**
   * The distinctive text this path MUST put on stderr. gate-r1 found mutant (d)
   * surviving on a box because the walker only asserted that stderr was
   * non-empty: an unrelated log line emitted somewhere in the same call (a
   * tunnel probe, a store migration) satisfied that even with the real line
   * deleted. Naming the expected text makes each case kill exactly its own line
   * and nothing else's, on any host.
   */
  expect: string;
  run: () => Promise<{ rc: number; err: string; out: string }>;
}> = [
  {
    name: "dispatch: unknown command",
    expect: "unknown command: frobnicate",
    run: () =>
      capture(() => {
        let err = "";
        const rc = emit(decide("frobnicate"), "", () => {}, (s) => void (err += s));
        // emit writes through its own sinks; re-route into the captured stream.
        process.stderr.write(err);
        return rc;
      }),
  },
  {
    name: "rollout: bare rollout refusal",
    expect: "refusing to guess targets",
    run: () => capture(() => rolloutRefusal()),
  },
  {
    name: "locality: VPS-only refusal",
    expect: "VPS-only in fleet2",
    run: () => capture(() => (refuseVpsOnly("status", false) ? RC.REFUSED : RC.OK)),
  },
  {
    name: "ssh: no box (usage)",
    expect: "usage: fleet2 ssh",
    run: () => capture(() => cmdSsh([], { runner: new FakeRunner(), cfg: EMPTY_CFG })),
  },
  {
    name: "ssh: bad --timeout value",
    expect: "is not a positive number of seconds",
    run: () => capture(() => cmdSsh(["grok-box-001", "x", "--timeout", "nope"], { runner: new FakeRunner(), cfg: EMPTY_CFG })),
  },
  {
    name: "ssh: unknown flag before the box",
    expect: "unknown flag --wat",
    run: () => capture(() => cmdSsh(["--wat", "grok-box-001"], { runner: new FakeRunner(), cfg: EMPTY_CFG })),
  },
  {
    name: "ssh: --timeout elapsed (rc 124)",
    expect: "timed out after 1s",
    run: () =>
      capture(() => {
        const ex = stuckExec();
        const t = handTimers();
        const p = cmdSsh(["grok-box-001", "sleep 99", "--timeout", "1"], {
          runner: new FakeRunner(),
          cfg: EMPTY_CFG,
          exec: ex.spawner,
          timers: t.seam,
        });
        t.fireAll();
        return p;
      }),
  },
  {
    name: "config: bad subcommand",
    expect: "usage: config render|diff|push",
    run: () => capture((out) => cmdConfig(["frob", "grok-box-001"], { runner: new FakeRunner(), env: testEnv(), write: out })),
  },
  {
    name: "config: missing box name",
    expect: "need a box name",
    run: () => capture((out) => cmdConfig(["diff"], { runner: new FakeRunner(), env: testEnv(), write: out })),
  },
  {
    name: "config: box not enrolled",
    expect: "is not enrolled",
    run: () =>
      capture((out) =>
        cmdConfig(["diff", "grok-box-001"], { runner: new FakeRunner(), env: testEnv(), enrolled: [], write: out }),
      ),
  },
  {
    name: "config diff: diff(1) missing",
    expect: "diff(1) not found",
    run: () =>
      capture((out) =>
        cmdConfig(["diff", "grok-box-001"], {
          runner: new FakeRunner(),
          env: testEnv(),
          enrolled: ["grok-box-001"],
          source: { fleetToml: () => undefined, boxToml: () => undefined },
          whichDiff: async () => undefined,
          write: out,
        }),
      ),
  },
  {
    name: "config diff: tunnel down",
    expect: "tunnel down",
    run: () =>
      capture((out) =>
        cmdConfig(["diff", "grok-box-001"], {
          // tunnelUp probes `ss`; an empty listener table reads as down.
          runner: new FakeRunner(() => result({ code: 0, stdout: "" })),
          env: testEnv(),
          enrolled: ["grok-box-001"],
          source: { fleetToml: () => undefined, boxToml: () => undefined },
          whichDiff: async () => "/usr/bin/diff",
          write: out,
        }),
      ),
  },
  {
    name: "config diff: DRIFT (rc 1 with the diff body on stdout)",
    expect: "DRIFTS from the rendered config",
    run: async () => {
      // The one path where stdout legitimately carries data AND the rc is
      // non-zero, so the reason has nowhere to go but stderr.
      const text = renderManaged(CFG_DIFF_FLEET_TOML, undefined);
      const want = await textSha256(text);
      const onbox = text.replace(/\n$/, "") + '\nextra = "1"\n';
      const dryFixture = `cur=stalesha want=${want} support=yes enabled=true\n---FILE---\n${onbox}`;
      const runner = new FakeRunner((argv) => {
        if (argv[0] === "ss") return result({ stdout: SS_UP_20008 });
        if (argv[0] === "/usr/bin/diff") {
          const r = Bun.spawnSync(argv);
          return result({ code: r.exitCode ?? 0, stdout: r.stdout.toString() });
        }
        return result({ code: 0, stdout: dryFixture });
      });
      return capture((out) =>
        cmdConfig(["diff", "grok-box-8"], {
          runner,
          env: testEnv(),
          enrolled: ["grok-box-8"],
          source: { fleetToml: () => CFG_DIFF_FLEET_TOML, boxToml: () => undefined },
          whichDiff: async () => "/usr/bin/diff",
          write: out,
        }),
      );
    },
  },
  {
    name: "mint-key: empty box (usage)",
    expect: "usage: fleet2 mint-key",
    run: () => capture(() => cmdMintKey("", { env: testEnv(), cfg: EMPTY_CFG, runner: new FakeRunner() })),
  },
  {
    name: "mint-key: non-grok box",
    expect: "refusing non-grok box",
    run: () => capture(() => cmdMintKey("laptop", { env: testEnv(), cfg: EMPTY_CFG, runner: new FakeRunner() })),
  },
  {
    name: "install-timer: retired",
    expect: "install-timer was retired",
    run: () => capture(() => cmdInstallTimer()),
  },
  {
    name: "remove-timer: systemctl absent",
    expect: "systemctl not found",
    run: () =>
      capture(() =>
        cmdRemoveTimer({
          runner: new FakeRunner(),
          which: async () => undefined,
          unitDir: "/nonexistent",
          removeFile: async () => {},
        }),
      ),
  },
  {
    name: "enroll: no box (usage)",
    expect: "usage: fleet2 enroll",
    run: () =>
      capture(async () => {
        const r = await cmdEnroll([], stubEnrollSideEffects());
        return r;
      }),
  },
  {
    name: "enroll: non-grok box",
    expect: "refusing non-grok box",
    run: () => capture(() => cmdEnroll(["laptop"], stubEnrollSideEffects())),
  },
  {
    name: "rename: usage (missing operands)",
    expect: "usage: rename",
    run: () => capture(() => cmdRename([], stubRenameDeps())),
  },
  {
    name: "rename: non-canonical <new>",
    expect: "is not canonical grok-box-NNN",
    run: () => capture(() => cmdRename(["grok-box-3", "grok-box-x"], stubRenameDeps())),
  },
  {
    name: "state: unknown subcommand (usage)",
    expect: "usage: fleet2 state",
    run: () => capture((out) => cmdState(["nonsense"], stubStateDeps(out))),
  },
  {
    name: "state restore: missing file operand",
    expect: "usage: fleet2 state restore",
    run: () => capture((out) => cmdState(["restore"], stubStateDeps(out))),
  },
  {
    name: "state import: unknown flag",
    expect: "state import: unknown flag",
    run: () => capture((out) => cmdState(["import", "--wat"], stubStateDeps(out))),
  },
  {
    name: "state reconcile-files: unknown flag",
    expect: "state reconcile-files: unknown flag",
    run: () => capture((out) => cmdState(["reconcile-files", "--wat"], stubStateDeps(out))),
  },
];

// --- stub seams ---------------------------------------------------------------

function stubEnrollSideEffects() {
  // Only the argument-validation arms are reached; the rest never runs.
  return {
    onVps: async () => false,
    permitlistenOut: async () => undefined,
    resolveVpsAddr: () => undefined,
    vpsPort: () => "22",
    aclHasFleetBrainTagowner: async () => 2 as const,
    lastApiCode: () => 0,
    readBoxPubkey: async () => undefined,
    installAuthorizedKeysLine: async () => false,
    writeEtcMapping: async () => false,
    boxKeyPub: async () => undefined,
    installBoxKey: async () => false,
    writeBoxConfig: async () => 1 as const,
    recordEnrolled: async () => undefined,
    tunnelWaitBudget: () => "0",
    tunnelUp: async () => false,
    sleep5: async () => {},
  } as unknown as Parameters<typeof cmdEnroll>[1];
}

function stubRenameDeps() {
  return {
    store: { enrolledPort: () => undefined, copyState: () => false, deleteOldState: () => false },
    ops: {
      acquireLock: async () => "busy" as const,
      tunnelUp: async () => false,
      boxBoxupVersion: async () => "",
      writeHostnameAndOnce: async () => false,
      pollDevices: async () => ({ ok: false, code: 0 }),
      forceName: async () => ({ ok: false, code: 0 }),
      sleep: async () => {},
    },
    paths: { state: "/var/lib/grok-fleet", akDir: "/etc/grok-fleet/authorized-keys" },
  } as unknown as Parameters<typeof cmdRename>[1];
}

function stubStateDeps(out: (s: string) => void) {
  return {
    env: testEnv({ FLEET_STATE: "/nonexistent/state", FLEET_ETC: "/nonexistent/etc" }),
    runner: new FakeRunner(),
    version: "0.0.0",
    notify: async () => {},
    acquireLock: async () => "ok" as const,
    out,
  } as unknown as Parameters<typeof cmdState>[1];
}

// --- the walker ----------------------------------------------------------------

describe("U4 never a silent non-zero (mutant (d))", () => {
  for (const c of CASES) {
    test(`${c.name} — rc≠0 carries a stderr line`, async () => {
      const { rc, err, out } = await c.run();
      expect(rc).not.toBe(RC.OK);
      // the killer: the path's OWN line must be there. Asserting only that
      // stderr is non-empty let an unrelated log line stand in for it, which is
      // how mutant (d) survived the r1 gate on a box.
      expect(err).toContain(c.expect);
      // stdout is DATA: no error prose there.
      expect(out).not.toMatch(/refus|error|failed|usage:/i);
    });
  }

  test("the ssh remote-rc pass-through is the ONE exemption, and is deliberate", async () => {
    const exec: ExecSpawner = {
      spawn(): ExecChild {
        return { exited: Promise.resolve(3), kill: () => {} };
      },
    };
    const { rc, err } = await capture(() =>
      cmdSsh(["grok-box-001", "false"], { runner: new FakeRunner(), cfg: EMPTY_CFG, exec }),
    );
    expect(rc).toBe(3);
    expect(err).toBe("");
  });
});
