// ink-harness.ts — mounting Ink without a TTY (fleet-tui-ink D5).
//
// This replaces ink-testing-library, which is dropped: the goldens must be
// rendered through the app's OWN `makeRenderOptions`, so that what the frame
// tests exercise (`exitOnCtrlC`, `patchConsole`, `alternateScreen`) is the
// production factory and not a hardcoded copy of it.
//
// CAVEAT, recorded deliberately: `stdout.isTTY` is false here, which puts Ink
// in non-interactive/debug painting and makes `alternateScreen` a no-op. These
// frames are evidence of LAYOUT, not of live ANSI painting — the pty smoke in
// tests/test-makefile-targets.sh covers the painting and the alt-screen bytes.

import { EventEmitter } from "node:events";
import React from "react";
import { render, type Instance } from "ink";
import App, { type AppDeps } from "../../src/tui/app.tsx";
import { makeRenderOptions } from "../../src/tui/render-options.ts";
import type { TuiState } from "../../src/tui/state.ts";
import type { ApiClient } from "../../src/tui/api-client.ts";

export class FakeStdout extends EventEmitter {
  columns: number;
  rows: number;
  readonly isTTY = false;
  readonly writes: string[] = [];

  constructor(columns = 120, rows = 40) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  write(data: string, cb?: () => void): boolean {
    this.writes.push(data);
    cb?.();
    return true;
  }

  /** The last frame Ink painted (debug mode writes the whole frame each time). */
  lastFrame(): string {
    return this.writes[this.writes.length - 1] ?? "";
  }

  /** Change the terminal size and tell Ink about it. */
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

export class FakeStdin extends EventEmitter {
  readonly isTTY = true;
  readonly rawModeCalls: boolean[] = [];
  private chunk: string | null = null;

  setRawMode(on: boolean): this {
    this.rawModeCalls.push(on);
    return this;
  }
  setEncoding(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }

  /**
   * Deliver bytes. Ink 7 reads through `readable` + `read()`, so a stub that
   * only emits `data` delivers nothing at all — this stores the chunk, emits
   * both events, and `read()` returns-and-clears it.
   */
  write(bytes: string): void {
    this.chunk = bytes;
    this.emit("readable");
    this.emit("data", bytes);
  }

  read(): string | null {
    const c = this.chunk;
    this.chunk = null;
    return c;
  }
}

export class FakeStderr extends EventEmitter {
  readonly isTTY = false;
  readonly writes: string[] = [];
  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }
}

/** An API client that answers nothing and reaches no network. */
export function silentClient(over: Partial<ApiClient> = {}): ApiClient {
  const never = async (): Promise<never> => new Promise<never>(() => {});
  return {
    fleet: never,
    box: never,
    history: never,
    diff: never,
    journal: never,
    check: never,
    configPush: never,
    rotateKey: never,
    rename: never,
    reconcile: never,
    ...over,
  } as ApiClient;
}

export interface Mounted {
  instance: Instance;
  stdout: FakeStdout;
  stdin: FakeStdin;
  stderr: FakeStderr;
  lastFrame: () => string;
  /** the painted lines of the last frame. */
  lines: () => string[];
  press: (bytes: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  unmount: () => void;
}

/** Let Ink's throttled render and any queued microtasks settle. */
export async function settle(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Mount one golden, wait for the frame, unmount, and return what was painted. */
export async function frameOf(state: TuiState, size: { cols: number; rows: number }): Promise<string> {
  const m = mount(state, { size });
  await settle(40);
  const f = m.lastFrame();
  m.unmount();
  await settle(5);
  return f;
}

export function mount(
  initial: TuiState,
  deps: Partial<AppDeps> & { size?: { cols: number; rows: number } } = {},
): Mounted {
  const size = deps.size ?? { cols: 120, rows: 40 };
  const stdout = new FakeStdout(size.cols, size.rows);
  const stdin = new FakeStdin();
  const stderr = new FakeStderr();
  const appDeps: AppDeps = {
    client: deps.client ?? silentClient(),
    now: deps.now ?? ((): number => Date.parse("2026-05-01T00:00:10Z")),
    // long enough that no test trips over the poll unless it asks to.
    pollIntervalMs: deps.pollIntervalMs ?? 3_600_000,
    onQuit: deps.onQuit,
  };
  const instance = render(
    React.createElement(App, { initial, deps: appDeps }),
    makeRenderOptions(
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, stderr: stderr as unknown as NodeJS.WriteStream },
      { debug: true },
    ),
  );
  return {
    instance,
    stdout,
    stdin,
    stderr,
    lastFrame: () => stdout.lastFrame(),
    lines: () => stdout.lastFrame().split("\n"),
    press: async (bytes: string) => {
      stdin.write(bytes);
      await settle();
    },
    resize: async (cols: number, rows: number) => {
      stdout.resize(cols, rows);
      await settle();
    },
    unmount: () => instance.unmount(),
  };
}
