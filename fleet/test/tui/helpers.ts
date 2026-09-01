// helpers.ts — shared fixtures for the lane-B TUI tests.

import type { SnapshotBox } from "../../src/history/schema.ts";
import type { TuiState, Size } from "../../src/tui/render.ts";
import type { TermIo } from "../../src/tui/term.ts";

export type { TuiState, Size } from "../../src/tui/render.ts";

/** A snapshot box with sane defaults; override per test. */
export function box(name: string, over: Partial<SnapshotBox> = {}): SnapshotBox {
  return {
    name,
    tunnel: "up",
    check: "OK",
    ver: "5.3.0",
    drift: "no",
    config: "in-sync",
    checkfail: false,
    asleep: false,
    expiry_days: 40,
    ...over,
  };
}

/** A TuiState with NO_COLOR on (deterministic snapshots) and a fixed clock. */
export function state(over: Partial<TuiState> = {}): TuiState {
  return {
    boxes: [box("grok-box-1")],
    snapshotTs: "2026-05-01T00:00:00Z",
    apply: false,
    applySource: "config",
    canary: null,
    scope: "admin",
    tickAgeS: 10,
    link: { up: true },
    nowMs: Date.parse("2026-05-01T00:00:10Z"),
    selected: 0,
    filter: "",
    filtering: false,
    noColor: true,
    ...over,
  };
}

export const SIZE_80x24: Size = { cols: 80, rows: 24 };
export const SIZE_120x40: Size = { cols: 120, rows: 40 };

/** A fake TermIo that records writes + lets a test drive keys/resize/signals. */
export function fakeTermIo(opts: { tty?: boolean } = {}): {
  io: TermIo;
  writes: string[];
  rawModeCalls: boolean[];
  fireKey: (data: string) => void;
  fireResize: () => void;
  fireSignal: (sig: NodeJS.Signals) => void;
  fireExit: () => void;
  fireUnhandled: () => void;
} {
  const writes: string[] = [];
  const rawModeCalls: boolean[] = [];
  const keyCbs: Array<(d: string) => void> = [];
  const resizeCbs: Array<() => void> = [];
  const signalCbs = new Map<string, Array<() => void>>();
  const exitCbs: Array<() => void> = [];
  const rejCbs: Array<() => void> = [];
  const io: TermIo = {
    isTTY: () => opts.tty ?? true,
    setRawMode: (on) => rawModeCalls.push(on),
    write: (s) => writes.push(s),
    size: () => SIZE_120x40,
    onKey: (cb) => {
      keyCbs.push(cb);
      return () => {};
    },
    onResize: (cb) => {
      resizeCbs.push(cb);
      return () => {};
    },
    onSignal: (sig, cb) => {
      const arr = signalCbs.get(sig) ?? [];
      arr.push(cb);
      signalCbs.set(sig, arr);
      return () => {};
    },
    onExit: (cb) => {
      exitCbs.push(cb);
      return () => {};
    },
    onUnhandledRejection: (cb) => {
      rejCbs.push(cb);
      return () => {};
    },
  };
  return {
    io,
    writes,
    rawModeCalls,
    fireKey: (d) => keyCbs.forEach((c) => c(d)),
    fireResize: () => resizeCbs.forEach((c) => c()),
    fireSignal: (sig) => (signalCbs.get(sig) ?? []).forEach((c) => c()),
    fireExit: () => exitCbs.forEach((c) => c()),
    fireUnhandled: () => rejCbs.forEach((c) => c()),
  };
}
