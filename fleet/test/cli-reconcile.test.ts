// T13/m15 — cliReconcile lock semantics (D12/F4): reconcile maps a held lock
// (flock rc 6) to rc 0 (a skipped tick is success), distinct from upgrade's rc 6.
// Lock-file open failure / flock missing ⇒ rc 1. Uses an injected spawner so no
// real flock/process runs.

import { test, expect, describe } from "bun:test";
import { cliReconcile, type ReconcileCliDeps } from "../src/reconcile/cli-reconcile.ts";
import { parseConfig } from "../src/config.ts";
import { testEnv, testRollout } from "./helpers.ts";
import type { ReexecResult } from "../src/reexec.ts";

function deps(spawnRes: ReexecResult, over: Partial<ReconcileCliDeps> = {}): ReconcileCliDeps {
  return {
    env: testEnv({ FLEET2_LOCKED: false }),
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
