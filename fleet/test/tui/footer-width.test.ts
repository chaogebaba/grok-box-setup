// footer-width.test.ts — the footer's LENGTHS, pinned (fleet-tui-ink D5).
//
// Why a whole file for this: the admin footer's single line is 119 characters
// against the 120-column one-line rule — ONE character of slack. Add a key, or
// a space, and the footer silently becomes two lines, the row budget loses a
// row, and every 120-column golden re-lays out. This test makes that loud.

import { test, expect, describe } from "bun:test";
import { footerLines } from "../../src/tui/model.ts";
import { state } from "./helpers.ts";

const ADMIN_ONE_LINE =
  "↑/↓ select  / filter  r refresh  q quit  D diff  J journal  H history  P push  M rotate  R rename  T check  C reconcile";
const NAV_LINE = "↑/↓ select  / filter  r refresh  q quit  D diff  J journal  H history";
const READONLY_ACTIONS = "P push  M rotate  R rename  T check  C reconcile  (admin token required)";

describe("footer widths", () => {
  test("the admin one-line footer is 119 characters — one short of 120", () => {
    expect(ADMIN_ONE_LINE.length).toBe(119);
    const f = footerLines(state({ scope: "admin" }), { cols: 120, rows: 40 });
    expect(f.length).toBe(1);
    expect(f[0]!.trimEnd()).toBe(ADMIN_ONE_LINE);
  });

  test("the readonly footer cannot fit one line at 120 and splits into two", () => {
    expect(`${NAV_LINE}  ${READONLY_ACTIONS}`.length).toBeGreaterThan(120);
    const f = footerLines(state({ scope: "readonly" }), { cols: 120, rows: 40 });
    expect(f.length).toBe(2);
    expect(f[0]!.trimEnd()).toBe(NAV_LINE);
    expect(f[1]!.trimEnd()).toBe(READONLY_ACTIONS);
  });

  test("one character narrower than 120 and even admin splits", () => {
    expect(footerLines(state({ scope: "admin" }), { cols: 119, rows: 40 }).length).toBe(2);
  });

  test("every footer line is padded to exactly the width", () => {
    for (const cols of [80, 100, 119, 120, 140]) {
      for (const scope of ["admin", "readonly"] as const) {
        for (const line of footerLines(state({ scope }), { cols, rows: 40 })) {
          expect(line.length).toBe(cols);
        }
      }
    }
  });
});
