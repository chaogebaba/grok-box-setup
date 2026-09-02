// frames.test.ts — the Ink frame goldens (fleet-tui-ink D5).
//
// Every golden in `goldens.ts` is mounted through the app's own render-options
// factory and compared against the fixture captured from the hand-rolled
// painter before it was deleted. A golden with NO declared exception must match
// byte for byte once trailing whitespace is stripped; a golden WITH one names
// the exception at the assertion that applies it.

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { frameOf, mount, settle } from "./ink-harness.ts";
import { GOLDENS, type Golden } from "./goldens.ts";
import { detailLines, footerLines, tableLines, type Size } from "../../src/tui/model.ts";
import { DETAIL_GAP, showDetail, tableViewLines, tableWindow, hasMore, tableWidth } from "../../src/tui/layout.ts";
import type { TuiState } from "../../src/tui/state.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

function fixture(name: string): string[] {
  return strip(readFileSync(`${FIXTURES}${name}.txt`, "utf8"));
}

/** The comparison rule: trailing spaces per line, and trailing blank lines. */
function strip(frame: string): string[] {
  const lines = frame.split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * EXCEPTION "detail-column". The hand-rolled painter composed each side-by-side
 * row as `padVisible(left, leftW) + "  " + right`, so its Detail column started
 * at a DIFFERENT screen column on every line whose left cell was not exactly
 * `leftW` wide: at 120 columns the data rows put it at 74 and the table's
 * column-header row — padded to the full 120 before the join — put it at 122,
 * which also ran the line 21 columns past the terminal. At 100 columns there
 * were three positions: 62, 65 and 102.
 *
 * Ink also BOUNDS the pane: a detail line wider than `cols - leftW -
 * DETAIL_GAP` is truncated with an ellipsis instead of running past the
 * terminal edge and being wrapped by it.
 *
 * Ink puts the Detail column at ONE column, `leftW + DETAIL_GAP`. So on these
 * goldens the fixture pins the model's TEXT (this function reproduces the old
 * composition from `tableLines` + `detailLines` and compares that), and the
 * mounted frame is checked separately for the single-column geometry.
 */
function composeOldRowRegion(state: TuiState, size: Size): string[] {
  const leftW = tableWidth(size);
  const table = tableLines(state, size).map((l) => l.text);
  const detail = detailLines(state).map((l) => l.text);
  const n = Math.max(table.length, detail.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const l = table[i] ?? "";
    const r = detail[i] ?? "";
    out.push(`${l.length >= leftW ? l : l + " ".repeat(leftW - l.length)}  ${r}`);
  }
  return out.map((l) => l.replace(/[ \t]+$/, ""));
}

/** The fixture's row region: the lines between the blank spacer after the
 *  header/banner/discover block and the blank before the message/footer. */
function fixtureRowRegion(name: string, rowCount: number): string[] {
  const lines = fixture(name);
  const start = lines.indexOf("") + 1;
  return lines.slice(start, start + rowCount);
}

describe("frame goldens", () => {
  for (const g of GOLDENS) {
    test(`${g.name}${g.exceptions.length > 0 ? ` (exceptions: ${g.exceptions.join(", ")})` : ""}`, async () => {
      const frame = await frameOf(g.state, g.size);
      const lines = frame.split("\n");

      // --- invariants asserted on EVERY golden (D2) --------------------------
      expect(lines.length).toBeLessThanOrEqual(g.size.rows);
      const painted = strip(frame);
      const footer = footerLines(g.state, g.size).map((l) => l.replace(/[ \t]+$/, ""));
      expect(painted.slice(painted.length - footer.length)).toEqual(footer);

      if (g.exceptions.length === 0) {
        // No declared change applies: byte-for-byte against the hand-rolled
        // painter, modulo trailing whitespace.
        expect(painted).toEqual(fixture(g.name));
        return;
      }

      if (g.exceptions.includes("detail-column")) {
        // The fixture pins the model's text through the OLD composition …
        const region = composeOldRowRegion(g.state, g.size);
        expect(fixtureRowRegion(g.name, region.length)).toEqual(region);
        // … and the mounted frame carries the same strings in ONE column each.
        const leftW = tableWidth(g.size);
        const tableText = tableViewLines(g.state, g.size).map((l) => l.text);
        const detailText = detailLines(g.state).map((l) => l.text);
        const start = painted.indexOf("") + 1;
        for (const [i, t] of tableText.entries()) {
          expect(lines[start + i]!.slice(0, leftW).replace(/[ \t]+$/, "")).toBe(t.replace(/[ \t]+$/, ""));
        }
        if (showDetail(g.state, g.size)) {
          const detailW = g.size.cols - leftW - DETAIL_GAP;
          for (const [i, d] of detailText.entries()) {
            const painted = lines[start + i]!.slice(leftW + DETAIL_GAP).replace(/[ \t]+$/, "");
            if (d.length <= detailW) {
              expect(painted).toBe(d.replace(/[ \t]+$/, ""));
            } else {
              // Same exception, second half: the pane now BOUNDS its text. The
              // old painter let a long detail line run past the terminal edge
              // (at 100 columns its `drift:` row was 106 characters wide and
              // the terminal wrapped it, corrupting the row alignment).
              expect(painted.length).toBeLessThanOrEqual(detailW);
              expect(painted.endsWith("…")).toBe(true);
              expect(d.startsWith(painted.slice(0, -1))).toBe(true);
            }
          }
        }
      }

      if (g.exceptions.includes("table-window")) {
        // The window, and the `rows a–b of N` indicator that names it.
        const win = tableWindow(g.state, g.size);
        const all = g.state.boxes;
        expect(hasMore(g.state, g.size)).toBe(true);
        for (const b of all.slice(win.start, win.end)) expect(frame).toContain(b.name);
        for (const b of all.slice(0, win.start)) expect(frame).not.toContain(b.name);
        for (const b of all.slice(win.end)) expect(frame).not.toContain(b.name);
        expect(frame).toContain(`rows ${win.start + 1}–${win.end} of ${all.length}`);
        // …and against the LITERAL window the golden declares, which no change
        // to the arithmetic can move.
        expect(g.window).toBeDefined();
        expect(frame).toContain(g.window!.indicator);
        expect(frame).toContain(g.window!.first);
        expect(frame).toContain(g.window!.last);
        // the chrome is unchanged: the header and the footer come from the fixture.
        expect(lines[0]!.replace(/[ \t]+$/, "")).toBe(fixture(g.name)[0]!);
      }

      if (g.exceptions.includes("detail-omitted")) {
        // The row budget cannot hold the pane's fixed height, so it is omitted
        // ENTIRELY rather than clipped: not one Detail line is in the frame.
        expect(showDetail(g.state, g.size)).toBe(false);
        for (const d of detailLines(g.state)) expect(frame).not.toContain(d.text);
      }
    });
  }
});

describe("the 30-box fleet's window is bottom-anchored on the selection", () => {
  const at = (name: string): Golden => GOLDENS.find((g) => g.name === name)!;

  test("admin at 120x12: 8 table rows — the column header, 6 box rows and the indicator", async () => {
    const g = at("fleet30-admin-120x12-top");
    expect(tableViewLines(g.state, g.size).length).toBe(8);
    const frame = await frameOf(g.state, g.size);
    expect(frame).toContain("rows 1–6 of 30");
    expect(frame).toContain("grok-box-006");
    expect(frame).not.toContain("grok-box-007");
  });

  test("readonly at 120x12: the two-line footer costs one row — 5 box rows", async () => {
    const g = at("fleet30-readonly-120x12-top");
    expect(footerLines(g.state, g.size).length).toBe(2);
    expect(tableViewLines(g.state, g.size).length).toBe(7);
    const frame = await frameOf(g.state, g.size);
    expect(frame).toContain("rows 1–5 of 30");
    expect(frame).not.toContain("grok-box-006");
  });

  test("the selection sits on the LAST visible row once it scrolls", async () => {
    const mid = at("fleet30-admin-120x12-middle");
    const win = tableWindow(mid.state, mid.size);
    expect(win.end - 1).toBe(mid.state.selected); // bottom-anchored
    expect(await frameOf(mid.state, mid.size)).toContain("rows 11–16 of 30");

    const bottom = at("fleet30-admin-120x12-bottom");
    expect(await frameOf(bottom.state, bottom.size)).toContain("rows 25–30 of 30");
  });
});

test("NO_COLOR: the frame carries no ANSI at all", async () => {
  const g = GOLDENS.find((x) => x.name === "no-color-120x40")!;
  expect(await frameOf(g.state, g.size)).not.toContain("\x1b[");
});

test("a resize re-lays out the frame and drops the Detail pane below 100 columns", async () => {
  const g = GOLDENS.find((x) => x.name === "healthy-120x40")!;
  const m = mount(g.state, { size: g.size });
  await settle(40);
  expect(m.lastFrame()).toContain("── grok-box-001 ─────");
  await m.resize(80, 20);
  const frame = m.lastFrame();
  expect(frame).not.toContain("── grok-box-001 ─────");
  expect(frame.split("\n").length).toBeLessThanOrEqual(20);
  expect(frame).toContain("grok-box-001  up"); // the table is still there
  m.unmount();
});
