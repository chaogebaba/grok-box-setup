// T5/T6/T10/T11/T11b/T13 — the upgrade pass: order, canary abort, verify loop,
// lock re-exec, exit codes. All box-free via FakeRunner.

import { test, expect, describe } from "bun:test";
import {
  runUpgradePass,
  verifyBox,
  reexecArgv,
  takeLockAndReexec,
  orderForApply,
  RC,
  type UpgradeArgs,
  type UpgradeDeps,
} from "../src/upgrade.ts";
import { CHECK_COMMAND, POLL_COMMAND, renderInstallCommand } from "../src/remote.ts";
import { FakeRunner, result, isSs, isScp } from "./fake-runner.ts";
import { testEnv, testRollout } from "./helpers.ts";
import type { FsSeam, Inventory } from "../src/state.ts";
import type { StageFs, Target } from "../src/stage.ts";

const KEY = "/etc/grok-fleet/box_access_ed25519";
const TARGET: Target = { ref: "main", sha: "abc1234", version: "5.3.0" };

/** A memFs that exposes its backing store so tests can read what was written. */
function memFsWithStore(): { fs: FsSeam; store: Map<string, string> } {
  const store = new Map<string, string>();
  const fs: FsSeam = {
    async writeFile(p, d) { store.set(p, d); },
    async chmod() {},
    async rename(f, t) { const v = store.get(f); if (v !== undefined) { store.set(t, v); store.delete(f); } },
    async readFile(p) { return store.get(p); },
  };
  return { fs, store };
}

function readInv(store: Map<string, string>): Inventory {
  return JSON.parse(store.get("/var/lib/grok-fleet/inventory.json")!) as Inventory;
}

function memFs(): FsSeam {
  const store = new Map<string, string>();
  return {
    async writeFile(p, d) { store.set(p, d); },
    async chmod() {},
    async rename(f, t) { const v = store.get(f); if (v !== undefined) { store.set(t, v); store.delete(f); } },
    async readFile(p) { return store.get(p); },
  };
}

const fakeStageFs: StageFs = {
  async mktempTar() { return "/tmp/fake-stage.tar"; },
  async sizeOf() { return 1024; },
  async remove() {},
};

function baseDeps(runner: FakeRunner, over: Partial<UpgradeDeps> = {}): UpgradeDeps {
  return {
    runner,
    env: testEnv({ FLEET_BOX_KEY: KEY, FLEET2_LOCKED: true }),
    rollout: testRollout(),
    fs: memFs(),
    stageFs: fakeStageFs,
    sleep: async () => {},
    notifyDeps: { telegramEnvPath: "/x", source: { async read() { return undefined; } } },
    resolveTargetFn: async () => TARGET,
    ...over,
  };
}

function args(over: Partial<UpgradeArgs> = {}): UpgradeArgs {
  return {
    to: undefined,
    boxes: ["grok-box-008", "grok-box-009", "grok-box-011"],
    all: true,
    apply: false,
    canary: "grok-box-008",
    json: false,
    debugExec: false,
    ...over,
  };
}

// port → box helper for the responder (ssh uses -p, scp uses -P)
function boxOf(argv: string[]): string {
  const i = argv.indexOf("-p") >= 0 ? argv.indexOf("-p") : argv.indexOf("-P");
  const port = argv[i + 1];
  return `grok-box-${String(Number(port) - 20000).padStart(3, "0")}`;
}

// Build a responder driven by per-box scripts.
type BoxScript = {
  tunnel?: boolean; // listener present (default true)
  sha?: string; // status/check sha (default != target so it drifts)
  done?: number | null; // DONE rc emitted by the poll (default 0)
  checkOk?: boolean; // check rc (default true)
  scpCode?: number; // scp rc (default 0)
  installCode?: number; // install rc (default 0)
};

function responder(scripts: Record<string, BoxScript>) {
  // Track which boxes have had their install command run: BEFORE install the
  // box reports its running (drifted) sha so the plan says "upgrade"; AFTER a
  // successful install+DONE the check reports the TARGET sha (converged), so a
  // healthy deploy verifies. A script with done:1 / checkOk:false stays failing.
  const installed = new Set<string>();
  return (argv: string[]) => {
    // git archive/rev-parse/etc. succeed (staging goes through the runner even
    // though the tarball itself is faked via stageFs).
    if (argv[0] === "git") return result({ code: 0, stdout: "abc1234\n" });
    if (isSs(argv)) {
      const lines: string[] = [];
      for (const [box, s] of Object.entries(scripts)) {
        if (s.tunnel !== false) {
          const port = 20000 + Number(box.slice("grok-box-".length));
          lines.push(`LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:*`);
        }
      }
      return result({ stdout: lines.join("\n") + "\n" });
    }
    if (isScp(argv)) {
      const box = boxOf(argv);
      return result({ code: scripts[box]?.scpCode ?? 0 });
    }
    if (argv[0] === "ssh") {
      const box = boxOf(argv);
      const s = scripts[box] ?? {};
      const cmd = argv[argv.length - 1] ?? "";
      if (cmd.startsWith("set -e;")) {
        installed.add(box);
        return result({ code: s.installCode ?? 0 });
      }
      if (cmd === POLL_COMMAND) {
        const done = s.done === undefined ? 0 : s.done;
        return result({ stdout: done === null ? "still running\n" : `install: DONE (rc=${done})\n` });
      }
      if (cmd === CHECK_COMMAND) {
        const ok = s.checkOk ?? true;
        // Converged sha after a successful install; else the running (drift) sha.
        const runningSha = s.sha ?? "abc1234";
        const sha = installed.has(box) ? "abc1234" : runningSha;
        return ok
          ? result({ code: 0, stdout: `check=OK name=${box} v=5.3.0/${sha} tunnel=up` })
          : result({ code: 1, stdout: "check=FAIL reason=x" });
      }
    }
    return result({ code: 1 });
  };
}

describe("orderForApply", () => {
  test("canary first when present, else unchanged", () => {
    expect(orderForApply(["a", "b", "grok-box-008"], "grok-box-008")).toEqual([
      "grok-box-008",
      "a",
      "b",
    ]);
    expect(orderForApply(["a", "b"], "grok-box-008")).toEqual(["a", "b"]);
    expect(orderForApply(["a", "b"], undefined)).toEqual(["a", "b"]);
  });
});

describe("T5 upgrade order + skip + dry-run", () => {
  test("dry-run: zero runner calls except reads (m4)", async () => {
    // running sha == target for one box (in-sync), drift for the others.
    const r = new FakeRunner(
      responder({
        "grok-box-008": { sha: "abc1234" }, // in-sync
        "grok-box-009": { sha: "old9999" },
        "grok-box-011": { sha: "old9999" },
      }),
    );
    const res = await runUpgradePass(baseDeps(r), args({ apply: false }));
    expect(res.rc).toBe(RC.OK);
    expect(res.mode).toBe("dry-run");
    // No scp, no install command — only ss + check reads.
    expect(r.calls.some((c) => isScp(c.argv))).toBe(false);
    expect(r.calls.some((c) => (c.argv[c.argv.length - 1] ?? "").startsWith("set -e;"))).toBe(false);
    const plan = Object.fromEntries(res.plan.map((p) => [p.box, p.action]));
    expect(plan["grok-box-008"]).toBe("in-sync");
    expect(plan["grok-box-009"]).toBe("upgrade");
  });

  test("apply: canary first, then enrolled order (m6 order)", async () => {
    const r = new FakeRunner(
      responder({
        "grok-box-008": { sha: "old" },
        "grok-box-009": { sha: "old" },
        "grok-box-011": { sha: "old" },
      }),
    );
    // canary 008 is NOT first in the input order — it must be pulled to front,
    // and the deploys must be SERIAL in that order (m6: parallel/reorder breaks
    // this exact-sequence assertion).
    const res = await runUpgradePass(
      baseDeps(r),
      args({ apply: true, boxes: ["grok-box-009", "grok-box-008", "grok-box-011"], canary: "grok-box-008" }),
    );
    expect(res.rc).toBe(RC.OK);
    const scpBoxes = r.calls.filter((c) => isScp(c.argv)).map((c) => boxOf(c.argv));
    expect(scpBoxes[0]).toBe("grok-box-008");
    expect(scpBoxes).toEqual(["grok-box-008", "grok-box-009", "grok-box-011"]);
    expect(res.summary).toContain("ok=3");
    expect(res.summary).toContain("failed=0");
  });

  test("tunnel-down non-canary → skip and continue (m3)", async () => {
    const r = new FakeRunner(
      responder({
        "grok-box-008": { sha: "old" },
        "grok-box-009": { tunnel: false }, // down
        "grok-box-011": { sha: "old" },
      }),
    );
    const res = await runUpgradePass(baseDeps(r), args({ apply: true }));
    const scpBoxes = r.calls.filter((c) => isScp(c.argv)).map((c) => boxOf(c.argv));
    // 009 skipped, 008 + 011 deployed
    expect(scpBoxes).toEqual(["grok-box-008", "grok-box-011"]);
    expect(res.summary).toContain("skipped=1");
    expect(res.rc).toBe(RC.OK);
  });

  test("in-sync → skip (no deploy)", async () => {
    const r = new FakeRunner(
      responder({
        "grok-box-008": { sha: "old" },
        "grok-box-009": { sha: "abc1234" }, // in-sync
        "grok-box-011": { sha: "old" },
      }),
    );
    const res = await runUpgradePass(baseDeps(r), args({ apply: true }));
    const scpBoxes = r.calls.filter((c) => isScp(c.argv)).map((c) => boxOf(c.argv));
    expect(scpBoxes).toEqual(["grok-box-008", "grok-box-011"]);
    expect(res.summary).toContain("skipped=1");
  });

  test("m1: canary verified-failure → ABORT with zero further deploys", async () => {
    const r = new FakeRunner(
      responder({
        "grok-box-008": { sha: "old", done: 1 }, // canary DONE rc=1 → verified failure
        "grok-box-009": { sha: "old" },
        "grok-box-011": { sha: "old" },
      }),
    );
    const res = await runUpgradePass(baseDeps(r), args({ apply: true }));
    expect(res.rc).toBe(RC.FAILURE);
    // only the canary was scp'd; no others
    const scpBoxes = r.calls.filter((c) => isScp(c.argv)).map((c) => boxOf(c.argv));
    expect(scpBoxes).toEqual(["grok-box-008"]);
    expect(res.outcomes.find((o) => o.box === "grok-box-008")!.result).toBe("failed");
  });

  test("m12: canary tunnel-down → ABORT (not skip), zero deploys", async () => {
    const r = new FakeRunner(
      responder({
        "grok-box-008": { tunnel: false }, // canary down
        "grok-box-009": { sha: "old" },
        "grok-box-011": { sha: "old" },
      }),
    );
    const res = await runUpgradePass(baseDeps(r), args({ apply: true }));
    expect(res.rc).toBe(RC.FAILURE);
    expect(r.calls.some((c) => isScp(c.argv))).toBe(false);
    expect(res.outcomes[0]!.result).toBe("aborted");
  });

  test("later verified-failure → stop, no further deploys", async () => {
    const r = new FakeRunner(
      responder({
        "grok-box-008": { sha: "old" }, // canary ok
        "grok-box-009": { sha: "old", done: 1 }, // fails
        "grok-box-011": { sha: "old" },
      }),
    );
    const res = await runUpgradePass(baseDeps(r), args({ apply: true }));
    expect(res.rc).toBe(RC.FAILURE);
    const scpBoxes = r.calls.filter((c) => isScp(c.argv)).map((c) => boxOf(c.argv));
    // 008 ok, 009 fails → stop; 011 never deployed
    expect(scpBoxes).toEqual(["grok-box-008", "grok-box-009"]);
  });
});

describe("T6/T13 verify loop", () => {
  test("m2/m13: two consecutive passes required; single pass is NOT enough", async () => {
    // A single passing poll followed by a failure must NOT verify — the mutant
    // that returns on the FIRST passing poll (m13 / drops the two-pass rule m2)
    // would wrongly succeed here. verifyTries=2 so there is no later recovery.
    let n = 0;
    const seq = [true, false]; // pass then fail, then exhausted
    const r = new FakeRunner((argv) => {
      const cmd = argv[argv.length - 1] ?? "";
      if (cmd === POLL_COMMAND) return result({ stdout: "install: DONE (rc=0)\n" });
      if (cmd === CHECK_COMMAND) {
        const ok = seq[n++] ?? false;
        return ok
          ? result({ code: 0, stdout: "check=OK v=5.3.0/abc1234 tunnel=up" })
          : result({ code: 1, stdout: "check=FAIL reason=x" });
      }
      return result({ code: 1 });
    });
    const v = await verifyBox(
      baseDeps(r, { rollout: testRollout({ verifyTries: 2 }) }),
      "grok-box-008",
      "abc1234",
    );
    expect(v.ok).toBe(false);
  });

  test("two consecutive passes DO verify (happy path)", async () => {
    // pass, fail, pass, pass → the final two consecutive passes verify.
    let n = 0;
    const seq = [true, false, true, true];
    const r = new FakeRunner((argv) => {
      const cmd = argv[argv.length - 1] ?? "";
      if (cmd === POLL_COMMAND) return result({ stdout: "install: DONE (rc=0)\n" });
      if (cmd === CHECK_COMMAND) {
        const ok = seq[n++] ?? false;
        return ok
          ? result({ code: 0, stdout: "check=OK v=5.3.0/abc1234 tunnel=up" })
          : result({ code: 1, stdout: "check=FAIL reason=x" });
      }
      return result({ code: 1 });
    });
    const v = await verifyBox(baseDeps(r, { rollout: testRollout({ verifyTries: 6 }) }), "grok-box-008", "abc1234");
    expect(v.ok).toBe(true);
  });

  test("T13/m16: DONE never appears → verified FAILURE 'no DONE marker'", async () => {
    const r = new FakeRunner((argv) => {
      const cmd = argv[argv.length - 1] ?? "";
      if (cmd === POLL_COMMAND) return result({ stdout: "still converging...\n" });
      return result({ code: 0 });
    });
    const v = await verifyBox(baseDeps(r), "grok-box-008", "abc1234");
    expect(v.ok).toBe(false);
    expect(v.detail).toBe("verify: no DONE marker");
  });

  test("DONE rc=1 → verified FAILURE carrying the rc", async () => {
    const r = new FakeRunner((argv) => {
      const cmd = argv[argv.length - 1] ?? "";
      if (cmd === POLL_COMMAND) return result({ stdout: "install: DONE (rc=1)\n" });
      return result({ code: 0 });
    });
    const v = await verifyBox(baseDeps(r), "grok-box-008", "abc1234");
    expect(v.ok).toBe(false);
    expect(v.detail).toBe("install: DONE (rc=1)");
  });

  test("check rc 1 after DONE rc 0 → sha mismatch failure", async () => {
    const r = new FakeRunner((argv) => {
      const cmd = argv[argv.length - 1] ?? "";
      if (cmd === POLL_COMMAND) return result({ stdout: "install: DONE (rc=0)\n" });
      if (cmd === CHECK_COMMAND) return result({ code: 1, stdout: "check=FAIL reason=x" });
      return result({ code: 1 });
    });
    const v = await verifyBox(baseDeps(r), "grok-box-008", "abc1234");
    expect(v.ok).toBe(false);
    expect(v.detail).toBe("verify: sha mismatch after DONE");
  });

  test("m2: sha must match target (check rc 0 but wrong sha) → failure", async () => {
    const r = new FakeRunner((argv) => {
      const cmd = argv[argv.length - 1] ?? "";
      if (cmd === POLL_COMMAND) return result({ stdout: "install: DONE (rc=0)\n" });
      if (cmd === CHECK_COMMAND) return result({ code: 0, stdout: "check=OK v=5.3.0/WRONG tunnel=up" });
      return result({ code: 1 });
    });
    const v = await verifyBox(baseDeps(r), "grok-box-008", "abc1234");
    expect(v.ok).toBe(false);
  });
});

describe("T11/T11b lock re-exec (F2/G3/H2)", () => {
  test("reexecArgv shape: compiled vs dev (G3)", () => {
    const argv = ["/usr/local/bin/fleet2", "/synthetic/entry", "upgrade", "--all", "--apply"];
    // compiled: execPath IS fleet2; argv[1] NOT re-passed
    expect(reexecArgv("/lock", "/usr/local/bin/fleet2", argv, true)).toEqual([
      "flock", "-n", "-E", "6", "/lock", "/usr/local/bin/fleet2", "upgrade", "--all", "--apply",
    ]);
    // dev: execPath is bun; argv[1] (entry .ts) re-passed
    expect(reexecArgv("/lock", "/usr/bin/bun", ["/usr/bin/bun", "src/cli.ts", "upgrade", "--apply"], false)).toEqual([
      "flock", "-n", "-E", "6", "/lock", "/usr/bin/bun", "src/cli.ts", "upgrade", "--apply",
    ]);
  });

  test("T11: --apply first runner call is the flock re-exec; held (rc 6) → zero further calls", async () => {
    const r = new FakeRunner(() => result({ code: 6 })); // flock: lock held
    const lr = await takeLockAndReexec(baseDeps(r), ["bun", "cli.ts", "upgrade", "--all", "--apply"], false);
    expect(lr.rc).toBe(RC.REFUSED);
    expect(lr.ran).toBe(false);
    // exactly one runner call — the flock re-exec — and it IS flock
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.argv[0]).toBe("flock");
    expect(r.calls[0]!.argv.slice(0, 5)).toEqual(["flock", "-n", "-E", "6", "/var/lib/grok-fleet/reconcile.lock"]);
  });

  test("T11b/m18: flock ENOENT (rc 127) → refused rc 6, never unlocked", async () => {
    const r = new FakeRunner(() => result({ code: 127 }));
    const lr = await takeLockAndReexec(baseDeps(r), ["bun", "cli.ts", "upgrade", "--apply"], false);
    expect(lr.rc).toBe(RC.REFUSED);
    expect(lr.ran).toBe(false);
  });

  test("lock acquired → child rc is returned", async () => {
    const r = new FakeRunner(() => result({ code: 0 }));
    const lr = await takeLockAndReexec(baseDeps(r), ["bun", "cli.ts", "upgrade", "--apply"], false);
    expect(lr.rc).toBe(RC.OK);
    expect(lr.ran).toBe(true);
  });

  test("H2 --debug-exec: prints `exec: <argv>` equal to the computed child argv", async () => {
    const r = new FakeRunner(() => result({ code: 0 }));
    const argv = ["/usr/bin/bun", "src/cli.ts", "upgrade", "--all", "--apply", "--debug-exec"];
    // capture stderr
    const orig = process.stderr.write.bind(process.stderr);
    const seen: string[] = [];
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      seen.push(s);
      return true;
    };
    try {
      await takeLockAndReexec(baseDeps(r), argv, true);
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    }
    const line = seen.find((s) => s.startsWith("exec: "));
    expect(line).toBeDefined();
    const printed = JSON.parse(line!.slice("exec: ".length));
    // dev-mode reexec argv shape (IS_COMPILED is false under bun test)
    expect(printed).toEqual(reexecArgv("/var/lib/grok-fleet/reconcile.lock", process.execPath, argv, false));
  });
});

describe("T10 exit codes", () => {
  test("target resolution error → rc 3 (dry-run included, F7.9)", async () => {
    const r = new FakeRunner(() => result({ code: 1 }));
    const deps = baseDeps(r, {
      resolveTargetFn: async () => { throw new (await import("../src/config.ts")).ConfigError("stage: bad src"); },
    });
    const res = await runUpgradePass(deps, args({ apply: false }));
    expect(res.rc).toBe(RC.TARGET);
  });

  test("m10: --to overrides the config target (ref reaches resolveTarget)", async () => {
    let seenRef = "";
    const r = new FakeRunner(responder({ "grok-box-008": { sha: "old" } }));
    const deps = baseDeps(r, {
      resolveTargetFn: async (_runner, _src, ref) => {
        seenRef = ref;
        return TARGET;
      },
    });
    await runUpgradePass(deps, args({ apply: false, to: "v9.9.9", boxes: ["grok-box-008"], canary: "grok-box-008" }));
    expect(seenRef).toBe("v9.9.9");
  });

  test("scp failure → per-box failure (F4)", async () => {
    const r = new FakeRunner(
      responder({ "grok-box-008": { sha: "old", scpCode: 1 } }),
    );
    const res = await runUpgradePass(baseDeps(r), args({ apply: true, boxes: ["grok-box-008"], canary: "grok-box-008" }));
    expect(res.rc).toBe(RC.FAILURE);
    expect(res.outcomes[0]!.detail).toContain("scp");
  });
});

describe("T12 timeout classification (F4)", () => {
  test("install timeout (code null + timedOut) is NOT a failure → verify runs", async () => {
    let verifyRan = false;
    let installedFlag = false;
    const r = new FakeRunner((argv) => {
      if (argv[0] === "git") return result({ code: 0, stdout: "abc1234\n" });
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:*\n" });
      if (isScp(argv)) return result({ code: 0 });
      const cmd = argv[argv.length - 1] ?? "";
      if (cmd.startsWith("set -e;")) {
        installedFlag = true;
        return result({ code: null, signal: "SIGKILL", timedOut: true });
      }
      if (cmd === POLL_COMMAND) {
        verifyRan = true;
        return result({ stdout: "install: DONE (rc=0)\n" });
      }
      if (cmd === CHECK_COMMAND) {
        // drift before deploy, converged after
        const sha = installedFlag ? "abc1234" : "old9999";
        return result({ code: 0, stdout: `check=OK v=5.3.0/${sha} tunnel=up` });
      }
      return result({ code: 1 });
    });
    const res = await runUpgradePass(baseDeps(r), args({ apply: true, boxes: ["grok-box-008"], canary: "grok-box-008" }));
    // install "killed" is not itself a failure — verify decides, and it passes.
    expect(verifyRan).toBe(true);
    expect(res.rc).toBe(RC.OK);
  });

  test("scp timeout (killed) → immediate per-box failure, verify NOT run", async () => {
    let verifyRan = false;
    const r = new FakeRunner((argv) => {
      if (argv[0] === "git") return result({ code: 0, stdout: "abc1234\n" });
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:*\n" });
      if (isScp(argv)) return result({ code: null, signal: "SIGKILL", timedOut: true });
      const cmd = argv[argv.length - 1] ?? "";
      if (cmd === CHECK_COMMAND) return result({ code: 0, stdout: "check=OK v=5.3.0/old tunnel=up" });
      if (cmd === POLL_COMMAND) { verifyRan = true; return result({ stdout: "install: DONE (rc=0)\n" }); }
      return result({ code: 1 });
    });
    const res = await runUpgradePass(baseDeps(r), args({ apply: true, boxes: ["grok-box-008"], canary: "grok-box-008" }));
    expect(res.rc).toBe(RC.FAILURE);
    expect(verifyRan).toBe(false);
    expect(res.outcomes[0]!.detail).toContain("scp");
  });
});

// keep imports referenced
void renderInstallCommand;

describe("T13 (H1): truncate is inside the install command, which precedes the poll", () => {
  test("deploy issues the install command (with truncate) BEFORE any poll", async () => {
    const r = new FakeRunner(
      responder({ "grok-box-008": { sha: "old", done: 0 } }),
    );
    await runUpgradePass(baseDeps(r), args({ apply: true, boxes: ["grok-box-008"], canary: "grok-box-008" }));
    const sshCmds = r.calls
      .filter((c) => c.argv[0] === "ssh")
      .map((c) => c.argv[c.argv.length - 1] ?? "");
    const installIdx = sshCmds.findIndex((c) => c.startsWith("set -e; sudo truncate -s 0"));
    const pollIdx = sshCmds.findIndex((c) => c === POLL_COMMAND);
    expect(installIdx).toBeGreaterThanOrEqual(0);
    expect(pollIdx).toBeGreaterThanOrEqual(0);
    // H1: the truncate (inside install) runs before the DONE-match poll window.
    expect(installIdx).toBeLessThan(pollIdx);
    // the install command carries the H1 self-truncate.
    expect(sshCmds[installIdx]).toContain("sudo truncate -s 0 /var/log/boxup-install.log");
  });
});


describe("gate-r1 fix 2: --apply persists inventory.json with lastUpgrade (F7.6/S-E)", () => {
  test("every deployed box records lastUpgrade{target,result:ok,at,detail} and sha=target", async () => {
    const r = new FakeRunner(
      responder({
        "grok-box-008": { sha: "old" },
        "grok-box-009": { sha: "old" },
        "grok-box-011": { sha: "old" },
      }),
    );
    const { fs, store } = memFsWithStore();
    const res = await runUpgradePass(baseDeps(r, { fs }), args({ apply: true }));
    expect(res.rc).toBe(RC.OK);

    const inv = readInv(store);
    // written after the applied pass, with the target recorded
    expect(inv.target).toEqual({ ref: "main", sha: "abc1234", version: "5.3.0" });
    for (const box of ["grok-box-008", "grok-box-009", "grok-box-011"]) {
      const e = inv.boxes[box]!;
      expect(e.lastUpgrade).toBeDefined();
      expect(e.lastUpgrade!.target).toBe("abc1234");
      expect(e.lastUpgrade!.result).toBe("ok");
      expect(e.lastUpgrade!.detail).toBe("verified");
      expect(typeof e.lastUpgrade!.at).toBe("string");
      // a converged box's sha is the target sha
      expect(e.sha).toBe("abc1234");
    }
  });

  test("mixed pass: skip + fail + not-reached all recorded per box", async () => {
    // 008 canary ok, 009 in-sync (skip), 011 tunnel-down (skip) — but reorder so
    // a LATER box fails to exercise not-reached. Use 4 boxes.
    const r = new FakeRunner(
      responder({
        "grok-box-008": { sha: "old" }, // canary, ok
        "grok-box-009": { sha: "abc1234" }, // in-sync → skip
        "grok-box-010": { sha: "old", done: 1 }, // verified failure → stop
        "grok-box-011": { sha: "old" }, // never reached
      }),
    );
    const { fs, store } = memFsWithStore();
    const res = await runUpgradePass(
      baseDeps(r, { fs }),
      args({
        apply: true,
        boxes: ["grok-box-008", "grok-box-009", "grok-box-010", "grok-box-011"],
        canary: "grok-box-008",
      }),
    );
    expect(res.rc).toBe(RC.FAILURE);

    const inv = readInv(store);
    expect(inv.boxes["grok-box-008"]!.lastUpgrade!.result).toBe("ok");
    expect(inv.boxes["grok-box-009"]!.lastUpgrade!.result).toBe("skipped");
    expect(inv.boxes["grok-box-009"]!.lastUpgrade!.detail).toBe("in-sync");
    expect(inv.boxes["grok-box-010"]!.lastUpgrade!.result).toBe("failed");
    // 011 was never reached (loop stopped at 010's failure)
    expect(inv.boxes["grok-box-011"]!.lastUpgrade!.result).toBe("skipped");
    expect(inv.boxes["grok-box-011"]!.lastUpgrade!.detail).toBe("not-reached (pass aborted)");
  });

  test("canary abort records aborted for the canary and not-reached for the rest", async () => {
    const r = new FakeRunner(
      responder({
        "grok-box-008": { tunnel: false }, // canary down → abort
        "grok-box-009": { sha: "old" },
        "grok-box-011": { sha: "old" },
      }),
    );
    const { fs, store } = memFsWithStore();
    const res = await runUpgradePass(baseDeps(r, { fs }), args({ apply: true }));
    expect(res.rc).toBe(RC.FAILURE);

    const inv = readInv(store);
    expect(inv.boxes["grok-box-008"]!.lastUpgrade!.result).toBe("aborted");
    expect(inv.boxes["grok-box-009"]!.lastUpgrade!.result).toBe("skipped");
    expect(inv.boxes["grok-box-009"]!.lastUpgrade!.detail).toBe("not-reached (pass aborted)");
  });

  test("dry-run does NOT write inventory.json", async () => {
    const r = new FakeRunner(responder({ "grok-box-008": { sha: "old" } }));
    const { fs, store } = memFsWithStore();
    await runUpgradePass(baseDeps(r, { fs }), args({ apply: false, boxes: ["grok-box-008"], canary: "grok-box-008" }));
    expect(store.has("/var/lib/grok-fleet/inventory.json")).toBe(false);
  });
});
