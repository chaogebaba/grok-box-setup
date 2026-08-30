// lock.test.ts — §7.4: the REAL ffi flock mechanism (not a fake) + cross-tool
// compatibility, and the finally-close mutant. Uses the COMPILED-equivalent
// openLibcFlock() against a real tmp lock file and a real util-linux `flock`
// child (skipped if flock(1) is absent).

import { test, expect, describe, afterEach } from "bun:test";
import { withReconcileLock, openLibcFlock, LOCK_RETRY_MS } from "../../src/serve/lock.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLogSink } from "../../src/log.ts";

const dirs: string[] = [];
function tmpLock(): string {
  const d = mkdtempSync(join(tmpdir(), "fleet2-lock-"));
  dirs.push(d);
  return join(d, "reconcile.lock");
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

const hasFlock = Bun.which("flock") !== null;

describe("§7.4 REAL ffi flock", () => {
  test("openLibcFlock resolves open/flock/close and gives exclusive NB locking", () => {
    const sys = openLibcFlock();
    const path = tmpLock();
    const fd1 = sys.open(path);
    expect(fd1).toBeGreaterThanOrEqual(0);
    expect(sys.flockNB(fd1)).toBe(true);
    const fd2 = sys.open(path);
    expect(sys.flockNB(fd2)).toBe(false); // held by fd1
    sys.close(fd1);
    expect(sys.flockNB(fd2)).toBe(true); // released
    sys.close(fd2);
  });

  test("withReconcileLock runs fn under the REAL lock and releases (finally-close mutant)", async () => {
    const path = tmpLock();
    const sys = openLibcFlock();
    // Hold nothing; the op runs.
    const r1 = await withReconcileLock(path, async () => "ran", { timeoutMs: 2000 });
    expect(r1).toEqual({ ok: true, value: "ran" });
    // Immediately-following op ALSO succeeds — proves the fd was closed in
    // `finally` (a leaked fd would keep the exclusive lock and 423 here).
    const r2 = await withReconcileLock(path, async () => "again", { timeoutMs: 2000 });
    expect(r2).toEqual({ ok: true, value: "again" });
    // And a manual probe confirms the lock is free now.
    const fd = sys.open(path);
    expect(sys.flockNB(fd)).toBe(true);
    sys.close(fd);
  });

  test.if(hasFlock)(
    "held by an external util-linux flock child ⇒ 423 within T; release ⇒ 200; next op succeeds",
    async () => {
      const restore = setLogSink(() => {});
      try {
        const path = tmpLock();
        // Hold the lock with a real external `flock` child for ~1.2s.
        const child = Bun.spawn(["flock", "-x", path, "-c", "sleep 1.2"]);
        // Give the child time to actually acquire before we race it.
        await new Promise((r) => setTimeout(r, 200));

        // A mutation with a SHORT ceiling must time out ⇒ lock_busy (423 path).
        const busy = await withReconcileLock(path, async () => "should-not-run", {
          timeoutMs: 400,
          retryMs: LOCK_RETRY_MS,
        });
        expect(busy).toEqual({ ok: false, reason: "lock_busy" });

        // Wait for the child to release.
        await child.exited;

        // Now the mutation acquires and runs.
        const ok = await withReconcileLock(path, async () => "ran", { timeoutMs: 2000 });
        expect(ok).toEqual({ ok: true, value: "ran" });

        // And an immediately-following mutation also succeeds (fd closed).
        const ok2 = await withReconcileLock(path, async () => "ran2", { timeoutMs: 2000 });
        expect(ok2).toEqual({ ok: true, value: "ran2" });
      } finally {
        setLogSink(restore);
      }
    },
  );

  test.if(hasFlock)("cross-tool: the ffi lock BLOCKS an external `flock -n`", async () => {
    const path = tmpLock();
    const sys = openLibcFlock();
    const fd = sys.open(path);
    expect(sys.flockNB(fd)).toBe(true);
    // external non-blocking flock must fail to acquire while we hold it.
    const blocked = Bun.spawnSync(["flock", "-n", path, "-c", ":"]);
    expect(blocked.exitCode).not.toBe(0);
    sys.close(fd);
    // after release it succeeds.
    const free = Bun.spawnSync(["flock", "-n", path, "-c", ":"]);
    expect(free.exitCode).toBe(0);
  });
});

describe("NB-retry timeout bound (mutant: unbounded retry loop)", () => {
  test("a permanently-held lock returns lock_busy at the deadline, never hangs", async () => {
    // A fake syscalls where flockNB ALWAYS fails (someone else holds it forever).
    let t = 0;
    const sys = {
      open: () => 3,
      flockNB: () => false,
      close: () => {},
    };
    const r = await withReconcileLock("/tmp/never.lock", async () => "x", {
      syscalls: sys,
      now: () => t,
      sleep: async (ms) => {
        t += ms; // advance the fake clock so the deadline is reached
      },
      timeoutMs: 30_000,
      retryMs: 250,
    });
    expect(r).toEqual({ ok: false, reason: "lock_busy" });
    // The loop advanced the clock in 250ms steps to the 30s ceiling, then bailed.
    expect(t).toBeGreaterThanOrEqual(30_000);
  });
});
