// term.test.ts — §7.6 TTY-refusal + restore-on-SIGTERM/SIGHUP/unhandledRejection.
// Uses a fake TermIo (no real TTY / signals).

import { test, expect, describe, spyOn, afterEach } from "bun:test";
import { Terminal, NotATtyError } from "../../src/tui/term.ts";
import { fakeTermIo } from "./helpers.ts";

describe("TTY refusal (A14)", () => {
  test("start() throws NotATtyError when stdin is not a TTY", () => {
    const { io } = fakeTermIo({ tty: false });
    const term = new Terminal(io);
    expect(() => term.start()).toThrow(NotATtyError);
    expect(term.isStarted).toBe(false);
  });
  test("start() enters raw mode + alt screen on a TTY", () => {
    const f = fakeTermIo({ tty: true });
    const term = new Terminal(f.io);
    term.start();
    expect(f.rawModeCalls).toContain(true);
    expect(f.writes.join("")).toContain("\x1b[?1049h"); // alt screen on
    expect(term.isStarted).toBe(true);
    term.restore();
  });
});

describe("restore on every exit path", () => {
  test("restore() leaves raw mode + alt screen, shows cursor; idempotent", () => {
    const f = fakeTermIo({ tty: true });
    const term = new Terminal(f.io);
    term.start();
    f.writes.length = 0;
    f.rawModeCalls.length = 0;
    term.restore();
    expect(f.rawModeCalls).toContain(false); // raw mode off
    expect(f.writes.join("")).toContain("\x1b[?1049l"); // alt screen off
    expect(f.writes.join("")).toContain("\x1b[?25h"); // cursor shown
    // idempotent: a second restore is a no-op (no extra writes).
    f.writes.length = 0;
    term.restore();
    expect(f.writes.length).toBe(0);
  });

  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    test(`restore fires on ${sig}`, () => {
      const f = fakeTermIo({ tty: true });
      const exitSpy = spyOn(process, "exit").mockImplementation(((): never => undefined as never));
      try {
        const term = new Terminal(f.io);
        term.start();
        f.writes.length = 0;
        f.fireSignal(sig);
        expect(f.writes.join("")).toContain("\x1b[?1049l"); // restored
        expect(exitSpy).toHaveBeenCalled();
      } finally {
        exitSpy.mockRestore();
      }
    });
  }

  test("restore fires on unhandledRejection", () => {
    const f = fakeTermIo({ tty: true });
    const exitSpy = spyOn(process, "exit").mockImplementation(((): never => undefined as never));
    try {
      const term = new Terminal(f.io);
      term.start();
      f.writes.length = 0;
      f.fireUnhandled();
      expect(f.writes.join("")).toContain("\x1b[?1049l");
    } finally {
      exitSpy.mockRestore();
    }
  });

  test("restore fires on process exit", () => {
    const f = fakeTermIo({ tty: true });
    const term = new Terminal(f.io);
    term.start();
    f.writes.length = 0;
    f.fireExit();
    expect(f.writes.join("")).toContain("\x1b[?1049l");
  });
});

describe("paint", () => {
  test("full repaint clears + writes the frame", () => {
    const f = fakeTermIo({ tty: true });
    const term = new Terminal(f.io);
    term.start();
    f.writes.length = 0;
    term.paint("HELLO FRAME");
    const out = f.writes.join("");
    expect(out).toContain("\x1b[2J"); // clear
    expect(out).toContain("HELLO FRAME");
    term.restore();
  });
});

afterEach(() => {});
