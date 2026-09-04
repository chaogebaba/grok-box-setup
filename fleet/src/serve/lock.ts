// lock.ts — the in-process reconcile.lock holder for API mutations (TUI-D3, B1).
//
// A mutation endpoint MUST hold `${FLEET_STATE}/reconcile.lock` for the whole
// operation so it cannot race the timer's `grokfleet reconcile` tick (which takes
// the SAME advisory lock via util-linux `flock`). We hold it IN-PROCESS via
// `bun:ffi` flock(2): open an fd on the lock file, loop
// `flock(fd, LOCK_EX|LOCK_NB)` at 250ms intervals up to T=30s; on timeout close
// the fd and signal 423 lock_busy; on success run the op and `close(fd)` in a
// `finally`. No helper child exists to orphan — the kernel releases the lock on
// ANY process death (the r2 child-holder was rejected for orphaning `sleep`).
// This is compatible with the CLI/timer's util-linux `flock` (same advisory
// lock on the same file).
//
// An in-process async mutex sits AHEAD of the ffi lock so two concurrent API
// mutations in the SAME process serialise; the mutex wait shares the SAME
// T=30s budget as the ffi acquisition — one ceiling for the whole request, so
// a held mutex past T returns 423 too (no unbounded client hang, R3-A3).
//
// The ffi is behind the `FlockSyscalls` seam so tests can inject; acceptance
// item 4 tests the REAL compiled mechanism (openLibcFlock).

import { log } from "../log.ts";

/** Total acquisition ceiling shared by the mutex wait + the ffi flock (R3-A3). */
export const LOCK_TIMEOUT_MS = 30_000;
/** flock(2) NB retry interval. */
export const LOCK_RETRY_MS = 250;

// flock(2) operation constants (Linux asm-generic).
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/**
 * The syscalls the holder needs. `open` returns an fd (>=0) or -1; `flockNB`
 * returns 0 on success or -1 when the lock is held elsewhere (EWOULDBLOCK);
 * `close` releases the fd (and, being the last fd, the lock). A seam so tests
 * inject a fake, and so a platform without a usable libc refuses cleanly.
 */
export interface FlockSyscalls {
  open(path: string): number;
  /** non-blocking LOCK_EX; true iff the lock was acquired. */
  flockNB(fd: number): boolean;
  close(fd: number): void;
}

export class LockUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "LockUnavailableError";
  }
}

let cached: FlockSyscalls | undefined;

/**
 * openLibcFlock — resolve open/flock/close from libc via bun:ffi. dlopen chain
 * (R3-A2): `libc.so.6` → `libc.so`; if neither yields the symbols, throw
 * LockUnavailableError with a clear reason (serve refuses to start). Cached
 * after the first success.
 */
export function openLibcFlock(): FlockSyscalls {
  if (cached !== undefined) return cached;
  // Lazy import so a fake-injected test never touches bun:ffi.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { dlopen, FFIType, suffix } = require("bun:ffi") as typeof import("bun:ffi");
  const candidates = ["libc.so.6", "libc.so", `libc.${suffix}`];
  const symbols = {
    open: { args: [FFIType.cstring, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  } as const;
  // `dlopen` is generic over the symbol map: without the instantiation the
  // resolved symbols lose their signatures and every argument types as `never`.
  let lib: ReturnType<typeof dlopen<typeof symbols>> | undefined;
  let lastErr = "";
  for (const name of candidates) {
    try {
      lib = dlopen(name, symbols);
      // The runtime guard stays (a libc that resolved but is missing a symbol
      // must fall through to the next candidate); `typeof` rather than
      // truthiness because the typed symbols are declared always-defined.
      const { open, flock, close } = lib.symbols;
      if (typeof open === "function" && typeof flock === "function" && typeof close === "function") break;
      lib = undefined;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      lib = undefined;
    }
  }
  if (lib === undefined) {
    throw new LockUnavailableError(
      `serve: cannot resolve flock(2) from libc (tried ${candidates.join(", ")}${lastErr ? `; last error: ${lastErr}` : ""}) — refusing to start`,
    );
  }
  const O_RDWR = 2;
  const O_CREAT = 0o100;
  const MODE = 0o600;
  const sys: FlockSyscalls = {
    open(path) {
      return lib!.symbols.open(Buffer.from(path + "\0", "utf8"), O_RDWR | O_CREAT, MODE) as number;
    },
    flockNB(fd) {
      return (lib!.symbols.flock(fd, LOCK_EX | LOCK_NB) as number) === 0;
    },
    close(fd) {
      // Explicitly LOCK_UN then close — close alone releases, but LOCK_UN is
      // belt-and-braces and mirrors util-linux's teardown.
      try {
        lib!.symbols.flock(fd, LOCK_UN);
      } catch {
        /* ignore */
      }
      lib!.symbols.close(fd);
    },
  };
  cached = sys;
  return sys;
}

/** In-process async mutex (single-writer) — serialises SAME-process mutations. */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  /**
   * Acquire within `deadline` (epoch ms per the SAME clock the caller uses).
   * Returns a release fn, or "timeout" when the wait exceeds the deadline. The
   * `now` clock is injected so a fake-clock caller and the mutex agree (a real
   * `Date.now()` here with a fake caller deadline would spuriously time out).
   */
  async acquire(deadlineMs: number, now: () => number = () => Date.now()): Promise<(() => void) | "timeout"> {
    // Snapshot the current tail; append our gate.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const prior = this.tail;
    this.tail = prior.then(() => gate);
    const remaining = deadlineMs - now();
    if (remaining <= 0) {
      // We must still not deadlock the chain: release immediately.
      release();
      return "timeout";
    }
    const timed = await Promise.race([
      prior.then(() => "ok" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), remaining)),
    ]);
    if (timed === "timeout") {
      // Release our gate so a subsequent waiter is not blocked by us, then bail.
      release();
      return "timeout";
    }
    return release;
  }
}

/** Result of a lock attempt. */
export type LockOutcome<T> = { ok: true; value: T } | { ok: false; reason: "lock_busy" };

export interface WithLockDeps {
  /** injectable syscalls (tests); defaults to the real libc ffi. */
  syscalls?: FlockSyscalls;
  /** injectable clock (ms); defaults to Date.now. */
  now?: () => number;
  /** injectable sleep (ms); defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  retryMs?: number;
  /** shared per-process mutex (defaults to the module singleton). */
  mutex?: AsyncMutex;
}

const moduleMutex = new AsyncMutex();

/**
 * withReconcileLock — run `fn` while holding `${lockPath}` exclusively. Acquires
 * the in-process mutex first (SAME budget), then the ffi flock (NB retry loop).
 * On timeout at EITHER stage returns `{ok:false, reason:"lock_busy"}` (⇒ 423).
 * On success runs `fn`, then close(fd) + mutex release in `finally`.
 *
 * Throws LockUnavailableError only when the ffi itself is unavailable (serve
 * would have refused to start; this is defensive).
 */
export async function withReconcileLock<T>(
  lockPath: string,
  fn: () => Promise<T> | T,
  deps: WithLockDeps = {},
): Promise<LockOutcome<T>> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.timeoutMs ?? LOCK_TIMEOUT_MS;
  const retryMs = deps.retryMs ?? LOCK_RETRY_MS;
  const sys = deps.syscalls ?? openLibcFlock();
  const mutex = deps.mutex ?? moduleMutex;

  const deadline = now() + timeoutMs;

  // Stage 1: in-process mutex, sharing the deadline.
  const release = await mutex.acquire(deadline, now);
  if (release === "timeout") {
    return { ok: false, reason: "lock_busy" };
  }

  let fd = -1;
  try {
    // Stage 2: ffi flock NB retry loop, same deadline.
    fd = sys.open(lockPath);
    if (fd < 0) {
      // Opening the lock file failed — treat as busy (never a silent success).
      log(`serve: could not open lock file ${lockPath} (fd=${fd}) — reporting busy`);
      return { ok: false, reason: "lock_busy" };
    }
    for (;;) {
      if (sys.flockNB(fd)) {
        const value = await fn();
        return { ok: true, value };
      }
      if (now() >= deadline) {
        return { ok: false, reason: "lock_busy" };
      }
      await sleep(retryMs);
    }
  } finally {
    if (fd >= 0) {
      try {
        sys.close(fd);
      } catch {
        /* best-effort — process death would release anyway */
      }
    }
    release();
  }
}
