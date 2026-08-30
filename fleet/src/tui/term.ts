// term.ts — the hand-rolled ANSI terminal core (TUI-D5, A14).
//
// Alt-screen + raw mode (REFUSE if stdin is not a TTY), full repaint on each
// frame, SIGWINCH resize. The terminal is RESTORED on every exit path:
// normal exit, uncaught crash, SIGTERM, SIGHUP, and an unhandledRejection — so
// a killed/crashed TUI never leaves the user's terminal in raw/alt-screen mode.
//
// The raw I/O is behind the `TermIo` seam so tests drive it without a real TTY.

import type { Size } from "./render.ts";

const CSI = "\x1b[";
const ALT_ON = "\x1b[?1049h"; // enter alt screen
const ALT_OFF = "\x1b[?1049l"; // leave alt screen
const CLEAR = "\x1b[2J\x1b[H"; // clear + home
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export interface TermIo {
  isTTY(): boolean;
  setRawMode(on: boolean): void;
  write(s: string): void;
  size(): Size;
  /** register a key data callback; returns an unsubscribe fn. */
  onKey(cb: (data: string) => void): () => void;
  /** register a resize callback; returns an unsubscribe fn. */
  onResize(cb: () => void): () => void;
  /** register a process-exit-ish signal handler; returns an unsubscribe fn. */
  onSignal(sig: NodeJS.Signals, cb: () => void): () => void;
  onExit(cb: () => void): () => void;
  onUnhandledRejection(cb: () => void): () => void;
}

export class NotATtyError extends Error {
  constructor() {
    super("tui: refusing to start — stdin is not a TTY (run in an interactive terminal)");
    this.name = "NotATtyError";
  }
}

/** Production TermIo over process.stdin/stdout. */
export const nodeTermIo: TermIo = {
  isTTY() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  },
  setRawMode(on) {
    if (typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(on);
  },
  write(s) {
    process.stdout.write(s);
  },
  size() {
    return { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 };
  },
  onKey(cb) {
    const handler = (buf: Buffer | string) => cb(typeof buf === "string" ? buf : buf.toString("utf8"));
    process.stdin.on("data", handler);
    process.stdin.resume();
    return () => process.stdin.off("data", handler);
  },
  onResize(cb) {
    const handler = () => cb();
    process.stdout.on("resize", handler);
    return () => process.stdout.off("resize", handler);
  },
  onSignal(sig, cb) {
    process.on(sig, cb);
    return () => process.off(sig, cb);
  },
  onExit(cb) {
    process.on("exit", cb);
    return () => process.off("exit", cb);
  },
  onUnhandledRejection(cb) {
    process.on("unhandledRejection", cb);
    return () => process.off("unhandledRejection", cb);
  },
};

/**
 * A Terminal owns the alt-screen/raw-mode lifecycle. `start()` refuses (throws
 * NotATtyError) when stdin is not a TTY. `restore()` is idempotent and safe to
 * call from any exit path; it is wired to exit/SIGTERM/SIGHUP/unhandledRejection.
 */
export class Terminal {
  private started = false;
  private unsubs: Array<() => void> = [];

  constructor(private readonly io: TermIo = nodeTermIo) {}

  /** Enter raw mode + alt screen. Refuses if not a TTY (A14). */
  start(): void {
    if (!this.io.isTTY()) throw new NotATtyError();
    this.io.setRawMode(true);
    this.io.write(ALT_ON + HIDE_CURSOR + CLEAR);
    this.started = true;
    // Wire restore to EVERY exit path (A14).
    this.unsubs.push(this.io.onExit(() => this.restore()));
    this.unsubs.push(this.io.onSignal("SIGTERM", () => this.onFatal()));
    this.unsubs.push(this.io.onSignal("SIGHUP", () => this.onFatal()));
    this.unsubs.push(this.io.onSignal("SIGINT", () => this.onFatal()));
    this.unsubs.push(this.io.onUnhandledRejection(() => this.onFatal()));
  }

  private onFatal(): void {
    this.restore();
    // best-effort: exit non-zero so a supervising shell sees the interruption.
    try {
      process.exit(130);
    } catch {
      /* in tests process.exit is stubbed/absent */
    }
  }

  /** Restore the terminal: leave raw mode + alt screen, show cursor. Idempotent. */
  restore(): void {
    if (!this.started) return;
    this.started = false;
    try {
      this.io.setRawMode(false);
      this.io.write(SHOW_CURSOR + ALT_OFF);
    } catch {
      /* best-effort */
    }
    for (const u of this.unsubs.splice(0)) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
  }

  /** Full-repaint a frame (clear + home + write). */
  paint(frame: string): void {
    this.io.write(CLEAR + frame);
  }

  size(): Size {
    return this.io.size();
  }

  onKey(cb: (data: string) => void): () => void {
    return this.io.onKey(cb);
  }
  onResize(cb: () => void): () => void {
    return this.io.onResize(cb);
  }

  get isStarted(): boolean {
    return this.started;
  }
}

void CSI;
