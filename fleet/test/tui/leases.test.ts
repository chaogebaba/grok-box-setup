// leases.test.ts — the TUI's lease surfaces (blueprint fleet2-lease-api L5).
//
// All three come from the SINGLE `/v1/fleet` poll's per-box `lease` field
// (r10-B1): the header count, the `⚑` in the NAME cell, and the detail card row.

import { describe, expect, test } from "bun:test";
import {
  detailLines,
  detailWidth,
  GLYPH,
  headerText,
  headerSegments,
  leasedCount,
  leaseTone,
  tableLines,
} from "../../src/tui/model.ts";
import type { BoxLease } from "../../src/tui/api-client.ts";
import { box, state, SIZE_120x40 } from "./helpers.ts";

/** The detail card is framed to the pane, so a long row needs a wide terminal to
 *  be read in full — the same reason the state-store D4 rows use one. */
const SIZE_300x50 = { cols: 300, rows: 50 };

function lease(over: Partial<BoxLease> = {}): BoxLease {
  return {
    lease_id: "LEASEID0000000000000A",
    state: "active",
    holder: "ci:runner-3",
    purpose: "gate",
    kind: "ephemeral",
    expires_at: "2026-06-01T02:00:00Z",
    grace_ends_at: null,
    ...over,
  };
}

describe("L5 — the header count", () => {
  test("`⚑ <n> leased` appears in the ACCENT tone once a box is in use", () => {
    const s = state({ boxes: [{ ...box("grok-box-1"), lease: lease() }, box("grok-box-2")] });
    expect(leasedCount(s.boxes)).toBe(1);
    expect(headerText(s, SIZE_120x40)).toContain(`${GLYPH.leased} 1 leased`);
    const seg = headerSegments(s, SIZE_120x40).find((x) => x.text.includes("leased"));
    expect(seg?.tone).toBe("accent");
  });

  test("a fleet nobody is using shows NO counter — quiet is the goal state", () => {
    const s = state({ boxes: [box("grok-box-1")] });
    expect(leasedCount(s.boxes)).toBe(0);
    expect(headerText(s, SIZE_120x40)).not.toContain("leased");
  });

  test("every DEFERRING state counts, not just `active` (the L3 rule)", () => {
    const s = state({
      boxes: [
        { ...box("grok-box-1"), lease: lease({ state: "active" }) },
        { ...box("grok-box-2"), lease: lease({ state: "lost", lost_reason: "asleep" } as Partial<BoxLease>) },
        { ...box("grok-box-3"), lease: lease({ state: "expired" }) },
        box("grok-box-4"),
      ],
    });
    expect(leasedCount(s.boxes)).toBe(3);
  });
});

describe("L5 — the table flag and its tone (r2-n3)", () => {
  test("the NAME cell carries `⚑` and the row keeps its 14-column budget", () => {
    const s = state({ boxes: [{ ...box("grok-box-011"), lease: lease() }, box("grok-box-2")] });
    const rows = tableLines(s, SIZE_120x40);
    const leased = rows[1]!;
    const free = rows[2]!;
    expect(leased.text).toContain(`grok-box-011 ${GLYPH.leased}`);
    expect(free.text).not.toContain(GLYPH.leased);
    // The columns after NAME still line up: both rows put TUNNEL at the same
    // offset, which is what the fixed 14-wide budget buys.
    expect(leased.text.indexOf("up")).toBe(free.text.indexOf("up"));
  });

  test("the flag's tone follows the lease STATE, not the row's health", () => {
    expect(leaseTone(lease({ state: "active" }))).toBe("main");
    expect(leaseTone(lease({ state: "lost" }))).toBe("down");
    expect(leaseTone(lease({ state: "expired" }))).toBe("warn");
    expect(leaseTone(null)).toBe("plain");

    const s = state({ boxes: [{ ...box("grok-box-1"), lease: lease({ state: "lost" }) }] });
    const seg = tableLines(s, SIZE_120x40)[1]!.segments!.find((x) => x.text.includes(GLYPH.leased));
    expect(seg?.tone).toBe("down");
  });
});

describe("L5 — the detail card row", () => {
  test("a leased box reads holder · purpose · kind · expires", () => {
    const s = state({ boxes: [{ ...box("grok-box-1"), lease: lease() }], utcRaw: true });
    const pane = detailLines(s, detailWidth(SIZE_300x50)).map((l) => l.text).join("\n");
    expect(pane).toContain("lease ci:runner-3 · gate · ephemeral · expires 2026-06-01T02:00:00Z");
    // …and at 120 columns it is TRUNCATED into the frame, never wrapped out of it.
    const narrow = detailLines(s, detailWidth(SIZE_120x40));
    for (const l of narrow) expect(l.text.length).toBe(detailWidth(SIZE_120x40));
  });

  test("a free box reads `lease —`", () => {
    const s = state({ boxes: [box("grok-box-1")] });
    const pane = detailLines(s, detailWidth(SIZE_120x40)).map((l) => l.text).join("\n");
    expect(pane).toContain("lease —");
  });

  test("a non-active lease names its state on the card", () => {
    const s = state({ boxes: [{ ...box("grok-box-1"), lease: lease({ state: "lost" }) }], utcRaw: true });
    const pane = detailLines(s, detailWidth(SIZE_300x50)).map((l) => l.text).join("\n");
    expect(pane).toContain("lost");
  });

  test("a `service` lease shows no expiry field at all", () => {
    const s = state({
      boxes: [{ ...box("grok-box-1"), lease: lease({ kind: "service", expires_at: null }) }],
      utcRaw: true,
    });
    const pane = detailLines(s, detailWidth(SIZE_300x50)).map((l) => l.text).join("\n");
    expect(pane).toContain("lease ci:runner-3 · gate · service");
    expect(pane).not.toContain("expires 2026");
  });
});
