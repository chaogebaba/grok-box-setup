// discover-line.test.ts — D7: the optional `discover` object on a snapshot
// line, and every reader's tolerance of its absence.
//
// state-store D3 (Phase B): the snapshot is a STORE row, so the line's own
// serialisation and its =<2KB cap are gone with `history/write.ts`. What the
// `discover` block round-trips through now is `snapshots` +
// `snapshot_skipped`, covered in test/store/snapshots.test.ts. What remains
// here is the READER half — the TUI row — which is unchanged.

import { test, expect, describe } from "bun:test";
import type { SnapshotBox } from "../../src/history/schema.ts";
import { discoverText as renderDiscover } from "../../src/tui/model.ts";
import type { TuiState } from "../../src/tui/state.ts";
import { frameOf } from "../tui/ink-harness.ts";
import { state as baseTuiState } from "../tui/helpers.ts";

function box(name: string): SnapshotBox {
  return {
    name,
    tunnel: "up",
    check: "OK",
    ver: "5.6.0",
    drift: "no",
    config: null,
    checkfail: false,
    asleep: false,
    expiry_days: 42,
  };
}

/**
 * This used to be a hand-copied TuiState that had silently drifted from
 * test/tui/helpers.ts — it was missing `freeOnly` and `tz`, which is what tsc
 * caught. It now DELEGATES, so a new TuiState field can never leave this
 * fixture behind again; only the values these tests actually pin are named.
 */
function tuiState(over: Partial<TuiState> = {}): TuiState {
  return baseTuiState({
    boxes: [box("grok-box-008")],
    snapshotTs: "2026-09-01T12:00:00Z",
    apply: true,
    nowMs: Date.parse("2026-09-01T12:00:10Z"),
    ...over,
  });
}

describe("D7 TUI row", () => {
  const size = { cols: 120, rows: 40 };

  test("no discover ⇒ NO row at all (a pre-5.6.0 snapshot renders exactly as before)", async () => {
    expect(renderDiscover(tuiState(), size)).toBeUndefined();
    expect(renderDiscover(tuiState({ discover: null }), size)).toBeUndefined();
    expect(await frameOf(tuiState(), size)).not.toContain("discover:");
  });

  test("one summary row, no new view", async () => {
    const s = tuiState({
      discover: {
        candidates: 3,
        adopted: 1,
        repaired: 0,
        skipped: [{ name: "grok-box-004", reason: "unreachable" }],
      },
    });
    const row = renderDiscover(s, size)!;
    expect(row).toContain("discover: 3 candidates");
    expect(row).toContain("1 adopted");
    expect(row).toContain("0 repaired");
    expect(row).toContain("1 skipped");
    expect(row).toContain("grok-box-004:unreachable");
    const frame = (await frameOf(s, size)).split("\n");
    expect(frame.filter((l) => l.includes("discover:"))).toHaveLength(1);
  });

  test("a long skip list is summarised, not spilled across the frame", () => {
    const skipped = Array.from({ length: 12 }, (_, i) => ({ name: `grok-box-${100 + i}`, reason: "unreachable" }));
    const st = tuiState({ discover: { candidates: 12, adopted: 0, repaired: 0, skipped } });
    // At a generous width the summary shows the first three plus a count.
    expect(renderDiscover(st, { cols: 300, rows: 40 })!).toContain("+9 more");
    // At a normal width it is still exactly ONE line, trimmed to the terminal.
    const row = renderDiscover(st, size)!;
    expect(row.split("\n")).toHaveLength(1);
    expect(row.length).toBe(size.cols);
  });
});
