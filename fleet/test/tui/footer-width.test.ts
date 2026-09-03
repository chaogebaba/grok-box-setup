// footer-width.test.ts — the footer's LENGTHS, pinned (fleet-tui-ink D5,
// fleet-tui-visual V6).
//
// Why a whole file for this: the admin footer's single line used to be EXACTLY
// 120 characters against the 120-column one-line rule — zero slack. Occupancy
// O7 spent that and more: `f free` and `L leases` add 18, so the one line is now
// 138 characters and 120-column admin frames take the TWO-line footer, losing
// one table row and collapsing the `fleet30-admin-120x12` windows onto the
// readonly ones. This test makes the number loud, whichever way it moves next.
//
// V6 spent the last character of the old slack on purpose: the two group
// separators ` │ ` cost two characters more than the `  ` joins they replaced,
// and the navigation key went from `↑/↓` to `↑↓` to pay for them.

import { test, expect, describe } from "bun:test";
import { footerLines } from "../../src/tui/model.ts";
import { state } from "./helpers.ts";

const ADMIN_ONE_LINE =
  "↑↓ select  / filter  f free  r refresh  q quit │ D diff  J journal  H history  L leases │ P push  M rotate  R rename  T check  C reconcile";
const NAV_LINE = "↑↓ select  / filter  f free  r refresh  q quit │ D diff  J journal  H history  L leases";
const READONLY_ACTIONS = "P push  M rotate  R rename  T check  C reconcile  (admin token required)";

describe("footer widths", () => {
  test("the admin one-line footer is 138 characters and needs a 138-column terminal", () => {
    expect(ADMIN_ONE_LINE.length).toBe(138);
    // 120 columns can no longer hold it: admin splits exactly as readonly does.
    const narrow = footerLines(state({ scope: "admin" }), { cols: 120, rows: 40 });
    expect(narrow.length).toBe(2);
    expect(narrow[0]!.trimEnd()).toBe(NAV_LINE);
    expect(narrow[1]!.trimEnd()).toBe("P push  M rotate  R rename  T check  C reconcile");
    // …and at exactly 138 it is one line again.
    const wide = footerLines(state({ scope: "admin" }), { cols: 138, rows: 40 });
    expect(wide.length).toBe(1);
    expect(wide[0]!.trimEnd()).toBe(ADMIN_ONE_LINE);
    expect(footerLines(state({ scope: "admin" }), { cols: 137, rows: 40 }).length).toBe(2);
  });

  test("the readonly footer cannot fit one line at 120 and splits into two", () => {
    expect(`${NAV_LINE}  ${READONLY_ACTIONS}`.length).toBeGreaterThan(120);
    const f = footerLines(state({ scope: "readonly" }), { cols: 120, rows: 40 });
    expect(f.length).toBe(2);
    expect(f[0]!.trimEnd()).toBe(NAV_LINE);
    expect(f[1]!.trimEnd()).toBe(READONLY_ACTIONS);
  });

  test("below the 120-column one-line rule nothing is one line, at either scope", () => {
    expect(footerLines(state({ scope: "admin" }), { cols: 119, rows: 40 }).length).toBe(2);
    expect(footerLines(state({ scope: "readonly" }), { cols: 119, rows: 40 }).length).toBe(2);
  });

  test("V6: the groups are separated by │, and no key word is lost", () => {
    const f = footerLines(state({ scope: "admin" }), { cols: 138, rows: 40 })[0]!;
    expect(f.split("│").length - 1).toBe(2);
    for (const w of ["select", "filter", "free", "refresh", "quit", "diff", "journal", "history", "leases", "push", "rotate", "rename", "check", "reconcile"]) {
      expect(f).toContain(w);
    }
  });

  test("every footer line is padded to exactly the width", () => {
    for (const cols of [80, 100, 119, 120, 138, 140]) {
      for (const scope of ["admin", "readonly"] as const) {
        for (const line of footerLines(state({ scope }), { cols, rows: 40 })) {
          expect(line.length).toBe(cols);
        }
      }
    }
  });
});
