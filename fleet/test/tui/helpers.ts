// helpers.ts — shared fixtures for the lane-B TUI tests.

import type { SnapshotBox } from "../../src/history/schema.ts";
import type { TuiState } from "../../src/tui/state.ts";
import type { Size } from "../../src/tui/model.ts";

export type { TuiState } from "../../src/tui/state.ts";
export type { Size } from "../../src/tui/model.ts";

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

/** A TuiState with NO_COLOR on (deterministic snapshots), a fixed clock and a
 *  fixed ZONE. The zone is pinned to UTC here rather than left to the host, so
 *  the frame fixtures render one byte-identical frame on any machine — a golden
 *  captured in America/New_York would not match on a grok box. */
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
    freeOnly: false,
    noColor: true,
    tz: "UTC",
    ...over,
  };
}

export const SIZE_80x24: Size = { cols: 80, rows: 24 };
export const SIZE_120x40: Size = { cols: 120, rows: 40 };
