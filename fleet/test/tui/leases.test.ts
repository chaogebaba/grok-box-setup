// leases.test.ts — the TUI's lease surfaces (blueprint fleet2-lease-api L5).
//
// All three come from the SINGLE `/v1/fleet` poll's per-box `lease` field
// (r10-B1): the header count, the flag — which occupancy O1 moved out of the
// NAME cell and into the WHO column — and the detail card's lease lines, which
// occupancy O6 rewrote into two.

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

describe("L5/O1 — the WHO cell and its tone (r2-n3)", () => {
  test("the WHO cell carries `⚑ <holder>`, and NAME keeps its full 14 columns", () => {
    const s = state({ boxes: [{ ...box("grok-box-011"), lease: lease() }, box("grok-box-2")] });
    const rows = tableLines(s, SIZE_120x40);
    const leased = rows[1]!;
    const free = rows[2]!;
    // `ci:runner-3` is 11, so it is cut to 8 + `…` inside the 12-wide cell.
    expect(leased.text).toContain(`grok-box-011  ${GLYPH.leased} ci:runne…`);
    expect(free.text).toContain("grok-box-2    -");
    expect(free.text).not.toContain(GLYPH.leased);
    // The columns after WHO still line up: both rows put VER at the same
    // offset, which is what the fixed 14 + 12 budget buys.
    expect(leased.text.indexOf("5.3.0")).toBe(free.text.indexOf("5.3.0"));
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

describe("L5/O6 — the detail card's two lease lines", () => {
  test("a leased box reads `lease ⚑ holder · kind · purpose`, kind before purpose", () => {
    const s = state({ boxes: [{ ...box("grok-box-1"), lease: lease() }], utcRaw: true });
    const pane = detailLines(s, detailWidth(SIZE_300x50)).map((l) => l.text).join("\n");
    expect(pane).toContain(`lease ${GLYPH.leased} ci:runner-3 · ephemeral · gate`);
    // …and at 120 columns it is TRUNCATED into the frame, never wrapped out of it.
    const narrow = detailLines(s, detailWidth(SIZE_120x40));
    for (const l of narrow) expect(l.text.length).toBe(detailWidth(SIZE_120x40));
  });

  test("a FREE box reads `free`, and says the API may still refuse", () => {
    const s = state({ boxes: [box("grok-box-1")] });
    const pane = detailLines(s, detailWidth(SIZE_300x50)).map((l) => l.text).join("\n");
    expect(pane).toContain("free");
    expect(pane).toContain("acquire may still refuse: /v1/leases 409 reasons");
    expect(pane).not.toContain("lease —");
  });

  test("an unleased box that is NOT free reads `no lease`, never `free`", () => {
    for (const over of [{ asleep: true }, { check: "FAIL" as const }, { drift: "yes" as const }]) {
      const s = state({ boxes: [box("grok-box-1", over)] });
      const pane = detailLines(s, detailWidth(SIZE_300x50)).map((l) => l.text).join("\n");
      expect(pane).toContain("no lease");
      expect(pane).not.toContain("acquire may still refuse");
    }
  });

  test("a non-active lease names its state, and a LOST grace is an upper bound", () => {
    const lost = state({
      boxes: [{ ...box("grok-box-1"), lease: lease({ state: "lost", grace_ends_at: "2026-05-01T00:17:00Z" }) }],
    });
    const pane = detailLines(lost, detailWidth(SIZE_300x50)).map((l) => l.text).join("\n");
    expect(pane).toContain("grace ≤16m · lost");

    const exp = state({
      boxes: [{ ...box("grok-box-1"), lease: lease({ state: "expired", grace_ends_at: "2026-05-01T00:17:00Z" }) }],
    });
    const p2 = detailLines(exp, detailWidth(SIZE_300x50)).map((l) => l.text).join("\n");
    expect(p2).toContain("grace 16m · expired");
    expect(p2).not.toContain("≤");
  });

  test("an active lease's second line counts down and names the expiry clock", () => {
    const s = state({ boxes: [{ ...box("grok-box-1"), lease: lease({ expires_at: "2026-05-01T01:12:00Z" }) }] });
    const pane = detailLines(s, detailWidth(SIZE_300x50)).map((l) => l.text).join("\n");
    expect(pane).toContain("in 1h11 · expires 01:12");
  });

  test("a `service` lease shows no expiry at all", () => {
    const s = state({
      boxes: [{ ...box("grok-box-1"), lease: lease({ kind: "service", expires_at: null }) }],
      utcRaw: true,
    });
    const pane = detailLines(s, detailWidth(SIZE_300x50)).map((l) => l.text).join("\n");
    expect(pane).toContain(`lease ${GLYPH.leased} ci:runner-3 · service · gate`);
    expect(pane).toContain("no expiry");
    expect(pane).not.toContain("expires 2026");
  });
});
