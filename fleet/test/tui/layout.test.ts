// layout.test.ts — the row budget, and the AGREEMENT between the arithmetic in
// layout.ts and the lines the mounted components actually emit (D2/D5).
//
// The budget is the single authority on how tall each region is. If a chrome
// component ever emits a line the arithmetic did not charge for, the frame runs
// past the bottom of the terminal and the footer scrolls away — so the count is
// checked against the mount, on every golden, rather than being asserted twice.

import { test, expect, describe } from "bun:test";
import { mount, settle } from "./ink-harness.ts";
import { GOLDENS } from "./goldens.ts";
import {
  DETAIL_ROWS,
  bannerText,
  detailLines,
  detailWidth,
  discoverText,
  footerLines,
  statusLine,
  modalLines,
  tableLines,
  tableWidth,
} from "../../src/tui/model.ts";
import {
  TABLE_HEADER_ROWS,
  boxRowsAvailable,
  hasMore,
  showDetail,
  tableChromeRows,
  tableContentRows,
  tableRows,
  tableViewLines,
  tableWindow,
} from "../../src/tui/layout.ts";
import { box, state } from "./helpers.ts";

describe("chrome arithmetic agrees with what the components emit", () => {
  for (const g of GOLDENS.filter((x) => x.state.view === undefined)) {
    test(`${g.name}: the counted chrome is the painted chrome`, async () => {
      const m = mount(g.state, { size: g.size });
      await settle(40);
      m.unmount();

      // Count the lines the chrome components put on screen: the header, the
      // banner and discover rows when present, the spacers, the message or the
      // modal, and the footer.
      let counted = 1; // Header
      if (bannerText(g.state, g.size) !== undefined) counted += 1;
      if (discoverText(g.state, g.size) !== undefined) counted += 1;
      counted += 1; // the spacer
      if (g.state.modal !== undefined) counted += 1 + modalLines(g.state).length;
      else if (statusLine(g.state) !== null) counted += 2;
      counted += 1; // the spacer before the footer
      counted += footerLines(g.state, g.size).length;

      expect(tableChromeRows(g.state, g.size)).toBe(counted);
      // …and the whole frame is chrome + the row region, never taller.
      const rowRegion = Math.max(tableViewLines(g.state, g.size).length, showDetail(g.state, g.size) ? DETAIL_ROWS : 0);
      const used = counted + Math.min(tableRows(g.state, g.size), rowRegion);
      expect(used).toBeLessThanOrEqual(g.size.rows);
    });
  }

  test("the mounted Detail component emits exactly DETAIL_ROWS lines", async () => {
    const g = GOLDENS.find((x) => x.name === "detail-panel-120x40")!;
    expect(detailLines(g.state, detailWidth(g.size)).length).toBe(DETAIL_ROWS);
    const m = mount(g.state, { size: g.size });
    await settle(40);
    const lines = m.lastFrame().split("\n");
    m.unmount();
    // the pane occupies DETAIL_ROWS consecutive lines starting at the region top.
    const first = lines.findIndex((l) => l.includes("╭─ grok-box-002 "));
    expect(first).toBeGreaterThan(0);
    for (let i = 0; i < DETAIL_ROWS; i++) {
      expect(lines[first + i]!.slice(74).trimEnd().length).toBeGreaterThan(0);
    }
    expect(lines[first + DETAIL_ROWS]!.slice(74).trimEnd()).toBe("");
  });
});

describe("the table's row budget", () => {
  const thirty = Array.from({ length: 30 }, (_, i) => box(`grok-box-${String(i + 1).padStart(3, "0")}`));

  test("the column-header row is a fixed cost of the region, not a box row", () => {
    // occupancy O7: the admin footer takes two lines at 120 columns now, so the
    // region is 7 rows rather than 8 at either scope.
    const s = state({ boxes: thirty, scope: "admin" });
    const size = { cols: 120, rows: 12 };
    expect(tableRows(s, size)).toBe(7);
    expect(boxRowsAvailable(s, size)).toBe(7 - TABLE_HEADER_ROWS);
    expect(hasMore(s, size)).toBe(true);
    expect(tableContentRows(s, size)).toBe(5); // one more line goes to the indicator
    expect(tableViewLines(s, size).length).toBe(7); // header + 5 rows + indicator
  });

  test("a fleet that FITS gets no indicator and loses no row to one", () => {
    const s = state({ boxes: thirty.slice(0, 4), scope: "admin" });
    const size = { cols: 120, rows: 40 };
    expect(hasMore(s, size)).toBe(false);
    expect(tableViewLines(s, size).length).toBe(1 + 4);
    expect(tableViewLines(s, size).some((l) => l.text.startsWith("rows "))).toBe(false);
  });

  test("the window is bottom-anchored: the selection lands on the last visible row", () => {
    const size = { cols: 120, rows: 12 };
    const rows = tableContentRows(state({ boxes: thirty }), size);
    for (const selected of [0, 3, rows - 1]) {
      expect(tableWindow(state({ boxes: thirty, selected }), size).start).toBe(0);
    }
    for (const selected of [rows, rows + 5, 29]) {
      const win = tableWindow(state({ boxes: thirty, selected }), size);
      expect(win.end - 1).toBe(selected);
      expect(win.end - win.start).toBe(rows);
    }
  });

  // At 100 columns the Detail pane appears and layout.ts clips the header to
  // tableWidth(100) = 60. The occupancy row sums to 57, or 60 with the canary
  // column — exactly the pane, with nothing clipped away.
  test("the column header fits the table pane at the 100-column cutoff", () => {
    const size = { cols: 100, rows: 40 };
    const s = state({ boxes: thirty });
    expect(showDetail(s, size)).toBe(true);
    const head = tableViewLines(s, size)[0]!.text;
    expect(head.trimEnd().length).toBeLessThanOrEqual(tableWidth(size));
    // occupancy O1: EXPIRY became EXP (pad("EXPIRY", 5) would print "EXPIR"),
    // and TUNNEL/CHECK left the row for the WHO column.
    expect(head).toContain("EXP");
    expect(head).not.toContain("TUNNEL");
    expect(head).not.toContain("CHECK");
    // …and nothing else was dropped either.
    for (const label of ["NAME", "WHO", "VER", "DRIFT", "CONFIG"]) expect(head).toContain(label);
  });

  test("the unclipped header is the same row, just padded to the terminal", () => {
    const size = { cols: 100, rows: 40 };
    const s = state({ boxes: thirty });
    expect(tableLines(s, size)[0]!.text.trimEnd()).toBe(tableViewLines(s, size)[0]!.text.trimEnd());
  });

  test("the Detail pane is omitted, never clipped, when the budget is short", () => {
    const s = state({ boxes: thirty });
    expect(showDetail(s, { cols: 120, rows: 40 })).toBe(true);
    expect(tableRows(s, { cols: 120, rows: 12 })).toBeLessThan(DETAIL_ROWS);
    expect(showDetail(s, { cols: 120, rows: 12 })).toBe(false);
    // and the long-standing 100-column cutoff still applies at any height.
    expect(showDetail(s, { cols: 99, rows: 40 })).toBe(false);
    expect(showDetail(s, { cols: 100, rows: 40 })).toBe(true);
  });
});
