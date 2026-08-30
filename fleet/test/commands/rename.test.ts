// rename.test.ts — T3 rename (D11/F11). Drives cmdRename with fake store+ops.

import { describe, test, expect } from "bun:test";
import { cmdRename, renameVerGe, renamePlanPaths, type RenameStore, type RenameOps, type PollResult } from "../../src/commands/rename.ts";
import { makeRenameDeps } from "../../src/commands/rename-wiring.ts";
import { testEnv } from "../helpers.ts";
import { parseConfig } from "../../src/config.ts";
import { FakeRunner, result } from "../fake-runner.ts";
import { setLogSink } from "../../src/log.ts";

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  return { lines, restore: () => setLogSink(prev) };
}

const PATHS = { state: "/s", akDir: "/e/authorized-keys.d", etc: "/e", managedBoxDir: "/e/boxes" };

interface StoreRec {
  copied: boolean;
  deleted: boolean;
}

function fakeStore(enrolledOld: boolean, hasNewRow: boolean, rec: StoreRec): RenameStore {
  return {
    enrolledPort: (b) => (b === "grok-box-3" && enrolledOld ? "20003" : undefined),
    hasEnrolledRow: () => hasNewRow,
    copyState: () => {
      rec.copied = true;
      return true;
    },
    deleteOldState: () => {
      rec.deleted = true;
      return true;
    },
  };
}

function okPoll(hostname: string, dnslabel: string, oldLive = "", newLive = "n1"): PollResult {
  return { ok: true, malformed: false, code: 200, hostname, dnslabel, oldLiveId: oldLive, newLiveId: newLive };
}

/** default-happy ops: tunnel up, boxup 5.3.0, box step ok, poll converged. */
function happyOps(over: Partial<RenameOps> = {}): RenameOps {
  const base: RenameOps = {
    async tunnelUp() { return true; },
    async boxBoxupVersion() { return "5.3.0"; },
    async writeHostnameAndOnce() { return true; },
    async pollDevices() { return okPoll("grok-box-003", "grok-box-003"); },
    async forceName() { return { ok: true, code: 200 }; },
    async reapCorpse() { return { ok: true, code: 200 }; },
    async acquireLock() { return "ok"; },
    async sleepInterval() {},
  };
  return { ...base, ...over };
}

describe("T3 rename pure helpers", () => {
  test("renameVerGe dotted compare (missing parts 0)", () => {
    expect(renameVerGe("5.3.0", "5.3.0")).toBe(true);
    expect(renameVerGe("5.3.1", "5.3.0")).toBe(true);
    expect(renameVerGe("5.2.9", "5.3.0")).toBe(false);
    expect(renameVerGe("5", "5.0.0")).toBe(true);
  });
  test("renamePlanPaths lists the 7 artefacts incl .toml overlay (F11)", () => {
    const pairs = renamePlanPaths(PATHS, "grok-box-3", "grok-box-003");
    const flat = pairs.map((p) => p[0]);
    expect(flat).toContain("/e/boxes/grok-box-3.toml"); // F11 managed overlay
    expect(flat).toContain("/s/grok-box-3.expires");
    expect(flat.some((f) => f.includes("enrolled.tsv (row grok-box-3)"))).toBe(true);
  });
});

describe("T3 validation (rc 2)", () => {
  const rec: StoreRec = { copied: false, deleted: false };
  const deps = { store: fakeStore(true, false, rec), ops: happyOps(), paths: PATHS };

  test("non-canonical <new> ⇒ rc 2", async () => {
    const cap = captureLog();
    const rc = await cmdRename(["grok-box-3", "grok-box-3"], deps);
    cap.restore();
    // grok-box-3 is not canonical NNN.
    expect(rc).toBe(2);
    expect(cap.lines.some((l) => l.includes("is not canonical grok-box-NNN"))).toBe(true);
  });

  test("index change ⇒ rc 2 (never changes port)", async () => {
    const cap = captureLog();
    const rc = await cmdRename(["grok-box-3", "grok-box-004"], deps);
    cap.restore();
    expect(rc).toBe(2);
    expect(cap.lines.some((l) => l.includes("index change"))).toBe(true);
  });

  test("not enrolled ⇒ rc 2", async () => {
    const cap = captureLog();
    const rc = await cmdRename(["grok-box-9", "grok-box-009"], { store: fakeStore(false, false, rec), ops: happyOps(), paths: PATHS });
    cap.restore();
    expect(rc).toBe(2);
    expect(cap.lines.some((l) => l.includes("is not enrolled"))).toBe(true);
  });

  test("unknown flag ⇒ rc 2", async () => {
    const rc = await cmdRename(["--bogus", "grok-box-3", "grok-box-003"], deps);
    expect(rc).toBe(2);
  });
});

describe("T3 --dry-run (F4)", () => {
  test("plan lines printed, state NOT mutated", async () => {
    const rec: StoreRec = { copied: false, deleted: false };
    const cap = captureLog();
    const rc = await cmdRename(["--dry-run", "grok-box-3", "grok-box-003"], { store: fakeStore(true, false, rec), ops: happyOps(), paths: PATHS });
    cap.restore();
    expect(rc).toBe(0);
    expect(cap.lines.some((l) => l.includes("DRY-RUN plan grok-box-3 -> grok-box-003"))).toBe(true);
    expect(rec.copied).toBe(false);
    expect(rec.deleted).toBe(false);
  });
});

describe("T3 lock + precheck aborts (rc 1)", () => {
  test("lock busy ⇒ 'reconcile busy' rc 1 (m6)", async () => {
    const rec: StoreRec = { copied: false, deleted: false };
    const cap = captureLog();
    const rc = await cmdRename(["grok-box-3", "grok-box-003"], { store: fakeStore(true, false, rec), ops: happyOps({ async acquireLock() { return "busy"; } }), paths: PATHS });
    cap.restore();
    expect(rc).toBe(1);
    expect(cap.lines.some((l) => l.includes("reconcile busy — could not acquire the reconcile lock within 90s"))).toBe(true);
    expect(rec.copied).toBe(false);
  });

  test("boxup < 5.3.0 ⇒ ABORT rc 1", async () => {
    const rec: StoreRec = { copied: false, deleted: false };
    const cap = captureLog();
    const rc = await cmdRename(["grok-box-3", "grok-box-003"], { store: fakeStore(true, false, rec), ops: happyOps({ async boxBoxupVersion() { return "5.2.0"; } }), paths: PATHS });
    cap.restore();
    expect(rc).toBe(1);
    expect(cap.lines.some((l) => l.includes("< 5.3.0"))).toBe(true);
  });

  test("tunnel down ⇒ ABORT rc 1", async () => {
    const rec: StoreRec = { copied: false, deleted: false };
    const rc = await cmdRename(["grok-box-3", "grok-box-003"], { store: fakeStore(true, false, rec), ops: happyOps({ async tunnelUp() { return false; } }), paths: PATHS });
    expect(rc).toBe(1);
  });
});

describe("T3 verify FAIL leaves OLD state intact (m5)", () => {
  test("post-rename verify (tunnelUp new) fails ⇒ rc 1, deleteOldState NOT called", async () => {
    const rec: StoreRec = { copied: false, deleted: false };
    // tunnelUp: true for old (precheck), false for new (final verify).
    let calls = 0;
    const ops = happyOps({
      async tunnelUp() {
        calls++;
        return calls === 1; // first (old precheck) up; second (new verify) down
      },
    });
    const cap = captureLog();
    const rc = await cmdRename(["grok-box-3", "grok-box-003"], { store: fakeStore(true, false, rec), ops, paths: PATHS });
    cap.restore();
    expect(rc).toBe(1);
    expect(rec.copied).toBe(true); // copy happened (copy-first)
    expect(rec.deleted).toBe(false); // OLD state NOT deleted (m5)
    expect(cap.lines.some((l) => l.includes("tunnel not up after rename"))).toBe(true);
  });
});

describe("T3 happy path + resume", () => {
  test("full happy rename ⇒ rc 0, copy then delete, DONE line", async () => {
    const rec: StoreRec = { copied: false, deleted: false };
    const cap = captureLog();
    const rc = await cmdRename(["grok-box-3", "grok-box-003"], { store: fakeStore(true, false, rec), ops: happyOps(), paths: PATHS });
    cap.restore();
    expect(rc).toBe(0);
    expect(rec.copied).toBe(true);
    expect(rec.deleted).toBe(true);
    expect(cap.lines.some((l) => l.includes("DONE grok-box-3 -> grok-box-003"))).toBe(true);
  });

  test("resume: <new> row already exists ⇒ logs resuming, still completes", async () => {
    const rec: StoreRec = { copied: false, deleted: false };
    const cap = captureLog();
    const rc = await cmdRename(["grok-box-3", "grok-box-003"], { store: fakeStore(true, /*hasNewRow*/ true, rec), ops: happyOps(), paths: PATHS });
    cap.restore();
    expect(rc).toBe(0);
    expect(cap.lines.some((l) => l.includes("resuming — grok-box-003 state already copied"))).toBe(true);
  });

  test("poll timeout ⇒ rc 1, diagnosis line, OLD state intact", async () => {
    const rec: StoreRec = { copied: false, deleted: false };
    const cap = captureLog();
    // poll never converges; forceName ok so posted=true; small pollSecs to end fast.
    const ops = happyOps({ async pollDevices() { return okPoll("grok-box-3", "grok-box-3", "old1", "old1"); } });
    const rc = await cmdRename(["grok-box-3", "grok-box-003"], { store: fakeStore(true, false, rec), ops, paths: PATHS, pollSecs: 5, pollInterval: 5 });
    cap.restore();
    expect(rc).toBe(1);
    expect(rec.deleted).toBe(false);
    expect(cap.lines.some((l) => l.includes("timed out (5s) waiting for HostName/DNS=grok-box-003"))).toBe(true);
  });
});


describe("T3 m6: rename lock wiring uses flock -w 90 (bounded wait), never -n", () => {
  test("acquireLock runs `flock -w 90 <lock> -c :` (the real RenameOps wiring)", async () => {
    // The gate memo m6: the cited rename test stubbed the lock RESULT and never
    // asserted the wiring argv, so a `-n` (non-blocking, no 90s wait) mutation
    // survived. Drive the REAL makeRenameDeps().ops.acquireLock() through a
    // FakeRunner and assert the argv carries `-w 90` and NOT `-n`.
    const env = testEnv({ FLEET_STATE: "/var/lib/grok-fleet" });
    const cfg = parseConfig(undefined, "/x");
    const runner = new FakeRunner(() => result({ code: 0 }));
    const deps = makeRenameDeps(env, cfg, runner);
    const verdict = await deps.ops.acquireLock();
    // flock is present on the CI/dev box; the lock argv must have been run.
    const flockCall = runner.calls.find((c) => c.argv[0] === "flock");
    expect(flockCall).toBeDefined();
    const argv = flockCall!.argv;
    // -w 90 present as adjacent tokens.
    const wIdx = argv.indexOf("-w");
    expect(wIdx).toBeGreaterThanOrEqual(0);
    expect(argv[wIdx + 1]).toBe("90");
    // never the non-blocking -n form (m6 kill).
    expect(argv).not.toContain("-n");
    // and the lock file is the reconcile.lock under FLEET_STATE.
    expect(argv.some((a) => a.endsWith("/reconcile.lock"))).toBe(true);
    expect(verdict).toBe("ok"); // FakeRunner rc 0 ⇒ lock acquired
  });
});
