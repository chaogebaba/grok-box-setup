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
    // No Detail pane (cols < 100) ⇒ the header clips to the FULL terminal width,
    // which comfortably holds the row (NAME…EXP COND), so the view header is the
    // model header merely padded — nothing is lost. 5.13.0's COND column widened
    // the row past tableWidth(100), so at 100 cols WITH the Detail pane the
    // header is legitimately clipped to the narrower table region (asserted
    // separately below); this invariant is about the no-Detail case.
    const size = { cols: 99, rows: 40 };
    const s = state({ boxes: thirty });
    expect(showDetail(s, size)).toBe(false);
    expect(tableLines(s, size)[0]!.text.trimEnd()).toBe(tableViewLines(s, size)[0]!.text.trimEnd());
  });

  test("with the Detail pane (cols >= 100) the wider COND table clips to the table region", () => {
    // 5.13.0 D3e: the COND column pushes the untruncated table past
    // tableWidth(100)=60, so the shared-row header is clipped to the table
    // region rather than padded. The `cols >= 100` detail cutoff itself is
    // unchanged (the detail-cutoff-99/100 fixtures prove it).
    const size = { cols: 100, rows: 40 };
    const s = state({ boxes: thirty });
    expect(showDetail(s, size)).toBe(true);
    expect(tableViewLines(s, size)[0]!.text.length).toBeLessThanOrEqual(tableWidth(size));
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

// --- jobs J12 (A20): JOB and COND are OMITTED (never clipped) by width -------
describe("A20 — the painted header gains JOB and drops COND by width", () => {
  const thirty = Array.from({ length: 30 }, (_, i) => box(`grok-box-${String(i + 1).padStart(3, "0")}`));
  // The A26/A27 worked values, read straight off the PAINTED header the view
  // region emits (tableViewLines[0]), which is the evidence the goldens capture:
  //   99  ⇒ no JOB (below 110), COND SHOWN  (99−57 = 42 ≥ 8)
  //   100 ⇒ no JOB, no COND     (60−57 = 3  < 8; Detail pane clips to 60)
  //   110 ⇒ JOB shown, no COND  (66−66 = 0  < 8)
  //   120 ⇒ JOB shown, no COND  (72−66 = 6  < 8)
  //   123 ⇒ JOB shown, no COND  (73−66 = 7  < 8)  ← COND_MIN_VISIBLE boundary
  //   124 ⇒ JOB shown, COND back (74−66 = 8 ≥ 8)  ← the pair that pins it = 8
  //   137 ⇒ JOB shown, COND shown (82−66 = 16 ≥ 8)
  const s = state({ boxes: thirty });
  const head = (cols: number): string => tableViewLines(s, { cols, rows: 40 })[0]!.text;

  test("100 columns: neither COND nor JOB (EXPIRY intact, proven separately)", () => {
    expect(head(100)).not.toContain("JOB");
    expect(head(100)).not.toContain("COND");
  });

  test("110 columns: JOB present, COND omitted", () => {
    expect(head(110)).toContain("JOB");
    expect(head(110)).not.toContain("COND");
  });

  test("120 and 123 columns: JOB present, COND still omitted", () => {
    expect(head(120)).toContain("JOB");
    expect(head(120)).not.toContain("COND");
    expect(head(123)).toContain("JOB");
    expect(head(123)).not.toContain("COND");
  });

  // MUTANT: COND_MIN_VISIBLE is 7 instead of 8 — the 123/124 pair must move.
  test("124 columns: COND returns (the 123/124 pair pins COND_MIN_VISIBLE = 8)", () => {
    expect(head(123)).not.toContain("COND");
    expect(head(124)).toContain("COND");
    expect(head(124)).toContain("JOB");
  });

  test("137 columns: both JOB and COND present", () => {
    expect(head(137)).toContain("JOB");
    expect(head(137)).toContain("COND");
  });
});

