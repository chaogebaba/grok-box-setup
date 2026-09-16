// T13/m15 — cliReconcile lock semantics (D12/F4): reconcile maps a held lock
// (flock rc 6) to rc 0 (a skipped tick is success), distinct from upgrade's rc 6.
// Lock-file open failure / flock missing ⇒ rc 1. Uses an injected spawner so no
// real flock/process runs.

import { test, expect, describe } from "bun:test";
import { cliReconcile, assembleTickDeps, type ReconcileCliDeps } from "../src/reconcile/cli-reconcile.ts";
import { runReconcileCmd } from "../src/cli.ts";
import { parseConfig, loadConfig } from "../src/config.ts";
import { testEnv, testRollout } from "./helpers.ts";
import { setLogSink } from "../src/log.ts";
import type { ReexecResult } from "../src/reexec.ts";

function deps(spawnRes: ReexecResult, over: Partial<ReconcileCliDeps> = {}): ReconcileCliDeps {
  return {
    env: testEnv({ GROKFLEET_LOCKED: false }),
    cfg: parseConfig("", "/x"),
    rollout: testRollout(),
    apply: false,
    debugExec: false,
    argv: ["bun", "cli.ts", "reconcile", "--dry-run"],
    spawner: async () => spawnRes,
    ...over,
  };
}

describe("T13/m15 cliReconcile lock rc", () => {
  test("lock held (flock rc 6) ⇒ rc 0 (skipped tick is success)", async () => {
    const rc = await cliReconcile(deps({ code: 6, launched: true }));
    expect(rc).toBe(0); // m15: mapping to 6 would fail here
  });

  test("flock ENOENT (launched=false) ⇒ rc 1 (cannot lock)", async () => {
    const rc = await cliReconcile(deps({ code: null, launched: false }));
    expect(rc).toBe(1);
  });

  test("flock rc 127 ⇒ rc 1 (cannot lock)", async () => {
    const rc = await cliReconcile(deps({ code: 127, launched: true }));
    expect(rc).toBe(1);
  });

  test("child rc is returned when the lock is acquired", async () => {
    // The spawner represents the flock child having run the locked tick to rc 0.
    const rc = await cliReconcile(deps({ code: 0, launched: true }));
    expect(rc).toBe(0);
  });
});

// --- F3: "pass finished with rc N" logs once per failed tick, not twice ----
// (VPS audit r3). The unlocked parent re-execs under flock and forwards the
// locked child's rc; only the process that actually ran the tick should name
// it (gated on GROKFLEET_LOCKED, mirroring runUpgradeCmd's early-return).

describe("F3 reconcile pass-finished line logs once", () => {
  test("unlocked parent forwarding a failed child's rc does NOT log the summary", async () => {
    const logs: string[] = [];
    const prev = setLogSink((l) => logs.push(l));
    try {
      // Spawner stands in for a re-exec whose locked child ran the tick and
      // exited 1 — the child, in its own separate process, owns the summary.
      const rc = await runReconcileCmd(
        ["--dry-run"],
        testEnv({ GROKFLEET_LOCKED: false }),
        parseConfig("", "/x"),
        testRollout(),
        ["bun", "cli.ts", "reconcile", "--dry-run"],
        async () => ({ code: 1, launched: true }),
      );
      expect(rc).toBe(1);
      expect(logs.filter((l) => l.includes("pass finished with rc"))).toHaveLength(0);
    } finally {
      setLogSink(prev);
    }
  });

  test("locked child that fails the tick logs the summary exactly once", async () => {
    const logs: string[] = [];
    const prev = setLogSink((l) => logs.push(l));
    try {
      // GROKFLEET_LOCKED: true ⇒ this IS the re-exec'd child; an unwritable
      // FLEET_STATE makes assembleTickDeps throw ConfigError (rc 3 / STORE).
      const rc = await runReconcileCmd(
        ["--dry-run"],
        testEnv({ GROKFLEET_LOCKED: true, FLEET_STATE: "/proc/1/grokfleet-nope" }),
        await loadConfig("/nonexistent-config.toml"),
        testRollout(),
        ["bun", "cli.ts", "reconcile", "--dry-run"],
      );
      expect(rc).toBe(3);
      expect(logs.filter((l) => l.includes("pass finished with rc"))).toHaveLength(1);
    } finally {
      setLogSink(prev);
    }
  });
});

// --- D6(e): FLEET_BOXES disables discovery entirely --------------------------

describe("D6e discovery seam", () => {
  test("FLEET_BOXES set ⇒ assembleTickDeps builds NO discover deps", async () => {
    const deps = await assembleTickDeps(
      testEnv({ FLEET_BOXES: "grok-box-008", FLEET_STATE: "/tmp/does-not-exist-ztj" }),
      await loadConfig("/nonexistent-config.toml"),
      testRollout(),
      { apply: false },
    );
    expect(deps.discover).toBeUndefined();
    expect(deps.targetBoxes).toEqual(["grok-box-008"]);
  });

  test("no FLEET_BOXES ⇒ discovery is wired, and its apiToken mirrors the ONE token read", async () => {
    const deps = await assembleTickDeps(
      testEnv({ FLEET_STATE: "/tmp/does-not-exist-ztj", FLEET_API_TOKEN_FILE: "/nonexistent-token" }),
      await loadConfig("/nonexistent-config.toml"),
      testRollout(),
      { apply: false },
    );
    expect(deps.discover).toBeDefined();
    // P1: no readable token this tick ⇒ discover is told so rather than reading again.
    expect(deps.discover!.apiToken).toBe(false);
  });
});
