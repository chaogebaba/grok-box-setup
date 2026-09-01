// discover-line.test.ts — D7: the optional `discover` object on a snapshot
// line, its overflow ORDER, and every reader's tolerance of its absence.

import { test, expect, describe } from "bun:test";
import { serializeLine, MAX_LINE_BYTES } from "../../src/history/write.ts";
import type { SnapshotBox, SnapshotLine } from "../../src/history/schema.ts";
import { renderDiscover, renderFrame } from "../../src/tui/render.ts";
import type { TuiState } from "../../src/tui/render.ts";

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

function line(over: Partial<SnapshotLine> = {}): SnapshotLine {
  return {
    v: 1,
    ts: "2026-09-01T12:00:00Z",
    apply: true,
    canary: null,
    boxes: [box("grok-box-008")],
    ...over,
  };
}

describe("D7 snapshot line", () => {
  test("`discover` is OPTIONAL — a line without it round-trips unchanged", () => {
    const s = serializeLine(line());
    expect(JSON.parse(s).discover).toBeUndefined();
    expect(JSON.parse(s).v).toBe(1); // no `v` bump for the new field
  });

  test("a small discover object rides along on the line", () => {
    const s = serializeLine(
      line({ discover: { candidates: 1, adopted: 1, repaired: 0, skipped: [] } }),
    );
    expect(JSON.parse(s).discover).toEqual({ candidates: 1, adopted: 1, repaired: 0, skipped: [] });
  });

  test("overflow order: `discover` is dropped FIRST and `boxes` survives", () => {
    // A skip list long enough to blow the 2 KB cap on its own.
    const skipped = Array.from({ length: 200 }, (_, i) => ({
      name: `grok-box-${100 + i}`,
      reason: "unreachable",
    }));
    const l = line({ boxes: [box("grok-box-008"), box("grok-box-009")], discover: { candidates: 200, adopted: 0, repaired: 0, skipped } });
    const s = serializeLine(l);
    expect(Buffer.byteLength(s, "utf8")).toBeLessThanOrEqual(MAX_LINE_BYTES);
    const parsed = JSON.parse(s);
    expect(parsed.discover).toBeUndefined(); // sacrificed
    expect(parsed.boxes.map((b: SnapshotBox) => b.name)).toEqual(["grok-box-008", "grok-box-009"]); // kept
    expect(parsed.boxes_dropped).toBeUndefined(); // the stub was not needed
  });

  test("when the BOXES alone overflow, the existing boxes_dropped stub still applies", () => {
    const many = Array.from({ length: 400 }, (_, i) => box(`grok-box-${100 + i}`));
    const s = serializeLine(line({ boxes: many, discover: { candidates: 0, adopted: 0, repaired: 0, skipped: [] } }));
    expect(Buffer.byteLength(s, "utf8")).toBeLessThanOrEqual(MAX_LINE_BYTES);
    const parsed = JSON.parse(s);
    expect(parsed.boxes).toEqual([]);
    expect(parsed.boxes_dropped).toBe(400);
  });
});

function tuiState(over: Partial<TuiState> = {}): TuiState {
  return {
    boxes: [box("grok-box-008")],
    snapshotTs: "2026-09-01T12:00:00Z",
    apply: true,
    applySource: "config",
    canary: null,
    scope: "admin",
    tickAgeS: 10,
    link: { up: true },
    nowMs: Date.parse("2026-09-01T12:00:10Z"),
    selected: 0,
    filter: "",
    filtering: false,
    noColor: true,
    ...over,
  };
}

describe("D7 TUI row", () => {
  const size = { cols: 120, rows: 40 };

  test("no discover ⇒ NO row at all (a pre-5.6.0 snapshot renders exactly as before)", () => {
    expect(renderDiscover(tuiState(), size)).toBeUndefined();
    expect(renderDiscover(tuiState({ discover: null }), size)).toBeUndefined();
    expect(renderFrame(tuiState(), size)).not.toContain("discover:");
  });

  test("one summary row, no new view", () => {
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
    const frame = renderFrame(s, size).split("\n");
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
