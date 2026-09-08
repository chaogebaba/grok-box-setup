// main.test.ts — cmdTui's rc contract and the crash barrier (D3).
//
// The rc contract is unchanged by the Ink port: rc 2 for a bad/absent config,
// rc 1 for a non-interactive terminal, and the same refusal text. What changed
// is who owns the terminal afterwards — Ink — so the only lifecycle code left
// here is the uncaught-exception barrier, which is tested directly.

import { test, expect, describe, afterEach } from "bun:test";
import { cmdTui, installCrashBarrier, NOT_A_TTY_MESSAGE } from "../../src/tui/main.ts";
import { hostZone, resolveTsOptions } from "../../src/tui/ts-options.ts";
import { setLogSink } from "../../src/log.ts";
import type { ConfigFs } from "../../src/tui/config.ts";
import type { Env } from "../../src/env.ts";

function fs(over: { body?: string; mode?: number; missing?: boolean; env?: Record<string, string | undefined> } = {}): ConfigFs {
  return {
    stat: () => (over.missing ? undefined : { mode: over.mode ?? 0o600 }),
    read: () => over.body ?? "",
    env: (n) => over.env?.[n],
    configPath: () => "/home/u/.config/grok-fleet/tui.toml",
  };
}

const GOOD_CONFIG = fs({ body: `url = "http://127.0.0.1:1"\ntoken = "T"\n`, mode: 0o600, env: {} });

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  return { lines, restore: () => void setLogSink(prev) };
}

const io = (opts: { stdin?: boolean; stdout?: boolean } = {}): Parameters<typeof installCrashBarrier>[1] => ({
  stdin: { isTTY: opts.stdin ?? false } as unknown as NodeJS.ReadStream,
  stdout: { isTTY: opts.stdout ?? false, write: () => true } as unknown as NodeJS.WriteStream,
  stderr: { write: () => true } as unknown as NodeJS.WriteStream,
});

describe("cmdTui rc contract", () => {
  test("a bad/absent config is rc 2, and Ink is never started", async () => {
    const cap = capture();
    try {
      const rc = await cmdTui([], { env: {} as Env, io: io({ stdin: true, stdout: true }), configFs: fs({ missing: true, env: {} }) });
      expect(rc).toBe(2);
      expect(cap.lines.join("\n")).toContain("url, token");
    } finally {
      cap.restore();
    }
  });

  test("a non-TTY stdin is refused with rc 1 and the unchanged message", async () => {
    const cap = capture();
    try {
      const rc = await cmdTui([], { env: {} as Env, io: io({ stdin: false, stdout: true }), configFs: GOOD_CONFIG });
      expect(rc).toBe(1);
      expect(cap.lines.join("\n")).toContain(NOT_A_TTY_MESSAGE);
      expect(NOT_A_TTY_MESSAGE).toBe("tui: refusing to start — stdin is not a TTY (run in an interactive terminal)");
    } finally {
      cap.restore();
    }
  });

  test("a non-TTY stdout is refused too", async () => {
    const cap = capture();
    try {
      expect(await cmdTui([], { env: {} as Env, io: io({ stdin: true, stdout: false }), configFs: GOOD_CONFIG })).toBe(1);
    } finally {
      cap.restore();
    }
  });
});

describe("the crash barrier", () => {
  const detachers: Array<() => void> = [];
  afterEach(() => {
    for (const d of detachers.splice(0)) d();
  });

  // Issue #16: this test used to monkeypatch the REAL `process.exit` for its
  // own body only, then restore it in `finally` — but `onFatal` had already
  // armed an unref'd 200ms fallback `setTimeout(() => process.exit(1), 200)`,
  // which nothing here ever cancelled. ~200ms later, against the REAL
  // (restored) `process.exit`, that timer fired and killed the whole `bun
  // test` process silently: no `(fail)` line, no error, whatever file the run
  // happened to be on next. `installCrashBarrier` now takes an injectable
  // `exit` so this test drives `onFatal` on the real `process` event emitter
  // (the ordering guarantee under test) without ever touching the real
  // `process.exit`, and `detach()` cancels the fallback timer it armed.
  // r2 gate SHOULD: `toBeGreaterThanOrEqual(1)` passes whether the write
  // callback's own `clearTimeout` actually cancelled the 200ms fallback or
  // not, so a mutant that deletes that `clearTimeout` (the fallback then
  // fires a SECOND exit at 200ms) was never caught. Waiting past 200ms and
  // asserting an EXACT count closes that.
  test("an uncaught exception unmounts Ink BEFORE the process is allowed to exit, and exits exactly once", async () => {
    let unmounts = 0;
    let exits = 0;
    const writes: Array<string> = [];
    const stdout = {
      isTTY: true,
      write: (s: string, cb?: () => void) => {
        writes.push(s);
        cb?.(); // the barrier's ordering hinge: it fires only after the teardown bytes
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const cap = capture();
    try {
      const detach = installCrashBarrier(
        () => {
          unmounts++;
          stdout.write("\x1b[?1049l\x1b[?25h");
        },
        { stdin: {} as NodeJS.ReadStream, stdout, stderr: {} as NodeJS.WriteStream },
        { exit: () => void exits++ },
      );
      detachers.push(detach);
      process.emit("uncaughtException", new Error("boom"));
      expect(unmounts).toBe(1);
      // the teardown bytes were written before the empty write whose callback exits.
      expect(writes[0]).toContain("\x1b[?1049l");
      expect(writes[writes.length - 1]).toBe("");
      expect(exits).toBe(1);
      expect(cap.lines.join("\n")).toContain("boom");
      // the write callback fired synchronously and cleared the fallback: waiting
      // past its 200ms does not produce a second exit.
      await new Promise((r) => setTimeout(r, 260));
      expect(exits).toBe(1);
    } finally {
      cap.restore();
    }
  });

  // r2 gate SHOULD: nothing exercised the `catch` arm, so a mutant that made
  // it call the real `process.exit` instead of the injected `exit` survived.
  test("a stdout that throws on write exits through the injected exit, synchronously, exactly once", async () => {
    let unmounts = 0;
    const exits: number[] = [];
    const stdout = {
      isTTY: true,
      write: (): boolean => {
        throw new Error("EPIPE");
      },
    } as unknown as NodeJS.WriteStream;
    const cap = capture();
    try {
      const detach = installCrashBarrier(
        () => void unmounts++,
        { stdin: {} as NodeJS.ReadStream, stdout, stderr: {} as NodeJS.WriteStream },
        { exit: (code) => void exits.push(code) },
      );
      detachers.push(detach);
      process.emit("uncaughtException", new Error("boom"));
      expect(unmounts).toBe(1);
      // the catch arm ran synchronously — the process (this test) is still
      // alive to make this assertion, and it went through the injected exit.
      expect(exits).toEqual([1]);
      await new Promise((r) => setTimeout(r, 260));
      expect(exits).toEqual([1]); // the catch arm also disarms the fallback: no second exit
    } finally {
      cap.restore();
    }
  });

  test("detaching removes both handlers", () => {
    const before = process.listenerCount("uncaughtException");
    const detach = installCrashBarrier(() => {}, io());
    expect(process.listenerCount("uncaughtException")).toBe(before + 1);
    detach();
    expect(process.listenerCount("uncaughtException")).toBe(before);
  });

  // A destroyed/errored stdout whose write callback never fires is exactly
  // what the 200ms fallback timer is for (see the doc comment on
  // `installCrashBarrier`). This drives that path directly and proves the
  // fallback goes through the INJECTED exit, never the real `process.exit` —
  // if the timer site called `process.exit` directly instead of `exit`, this
  // test would kill the whole `bun test` process instead of asserting cleanly.
  test("a stuck stdout falls back to the 200ms timer, through the injected exit", async () => {
    let unmounts = 0;
    const exits: number[] = [];
    const stdout = { isTTY: true, write: (): boolean => true } as unknown as NodeJS.WriteStream; // callback never called
    const cap = capture();
    try {
      const detach = installCrashBarrier(
        () => void unmounts++,
        { stdin: {} as NodeJS.ReadStream, stdout, stderr: {} as NodeJS.WriteStream },
        { exit: (code) => void exits.push(code) },
      );
      detachers.push(detach);
      process.emit("uncaughtException", new Error("stuck stdout"));
      expect(unmounts).toBe(1);
      expect(exits).toEqual([]); // nothing has exited yet — the write callback never ran
      await new Promise((r) => setTimeout(r, 260));
      expect(exits).toEqual([1]); // the fallback timer fired, through the injected exit
    } finally {
      cap.restore();
    }
  });

  // The r1 bug in one line: the fallback timer this handler arms MUST be
  // cancellable, or nothing detach() does can stop a later real process exit.
  test("detach() disarms the fallback timer before it fires", async () => {
    const exits: number[] = [];
    const stdout = { isTTY: true, write: (): boolean => true } as unknown as NodeJS.WriteStream; // callback never called
    const cap = capture();
    try {
      const detach = installCrashBarrier(
        () => {},
        { stdin: {} as NodeJS.ReadStream, stdout, stderr: {} as NodeJS.WriteStream },
        { exit: (code) => void exits.push(code) },
      );
      process.emit("uncaughtException", new Error("stuck stdout"));
      detach();
      await new Promise((r) => setTimeout(r, 260));
      expect(exits).toEqual([]); // detach() cleared the armed fallback: it never fires
    } finally {
      cap.restore();
    }
  });

  // r2 gate SHOULD: `onFatal` used to overwrite `fallback` on every call, so
  // only the MOST RECENT timer was reachable by `detach()` — a fatal event
  // before the one that gets detached would leave its own 200ms timer
  // orphaned. Two fatal events (an uncaughtException a real crash could well
  // be followed by an unhandledRejection mid-unmount), then an immediate
  // detach(), must leave nothing armed at all.
  test("two fatal events before detach() do not orphan a timer", async () => {
    const exits: number[] = [];
    const stdout = { isTTY: true, write: (): boolean => true } as unknown as NodeJS.WriteStream; // callback never called
    const cap = capture();
    try {
      const detach = installCrashBarrier(
        () => {},
        { stdin: {} as NodeJS.ReadStream, stdout, stderr: {} as NodeJS.WriteStream },
        { exit: (code) => void exits.push(code) },
      );
      process.emit("uncaughtException", new Error("first"));
      process.emit("unhandledRejection", new Error("second"), Promise.resolve());
      detach();
      await new Promise((r) => setTimeout(r, 260));
      expect(exits).toEqual([]); // neither the first nor the second fallback survives detach()
    } finally {
      cap.restore();
    }
  });
});


describe("timestamp rendering options for the run", () => {
  const zone = (): string => "America/New_York";

  test("by default the viewer's zone is used and timestamps are localised", () => {
    expect(resolveTsOptions([], undefined, zone)).toEqual({ tz: "America/New_York", utcRaw: false });
  });

  test("--utc keeps the raw UTC ISO strings", () => {
    expect(resolveTsOptions(["--utc"], undefined, zone)).toEqual({ tz: "America/New_York", utcRaw: true });
  });

  test("FLEET_TUI_UTC=1 does the same, and only the exact value 1", () => {
    expect(resolveTsOptions([], "1", zone).utcRaw).toBe(true);
    expect(resolveTsOptions([], "0", zone).utcRaw).toBe(false);
    expect(resolveTsOptions([], "yes", zone).utcRaw).toBe(false);
    expect(resolveTsOptions([], undefined, zone).utcRaw).toBe(false);
  });

  test("hostZone reads the host's zone and honours TZ", async () => {
    expect(hostZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // TZ is the documented third way to get UTC clock readings, so prove it
    // reaches hostZone rather than asserting it from the same process.
    const p = Bun.spawn([process.execPath, "-e", 'import{hostZone}from"./src/tui/ts-options.ts";console.log(hostZone())'], {
      env: { ...process.env, TZ: "Asia/Tokyo" },
      cwd: new URL("../..", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(p.stdout).text()).toContain("Asia/Tokyo");
    expect(await p.exited).toBe(0);
  });
});
