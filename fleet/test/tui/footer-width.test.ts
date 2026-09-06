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
//
// jobs J12 (D2): `B jobs` joined VIEW_KEYS. The nav line grew from 87 to 95
// columns and the combined admin one-line form from 138 to 146, so the footer
// STAYS two lines at 100 and at 120 (its one-line rule needs `cols >= 120` AND
// the combined length to fit, and 146 > 120). This file pins the new numbers,
// AND the presence of the `B jobs` legend itself — the footer-legend-missing-B
// mutant dies here.

import { test, expect, describe } from "bun:test";
import { footerLines } from "../../src/tui/model.ts";
import { state } from "./helpers.ts";

const ADMIN_ONE_LINE =
  "↑↓ select  / filter  f free  r refresh  q quit │ D diff  J journal  H history  L leases  B jobs │ P push  M rotate  R rename  T check  C reconcile";
const NAV_LINE = "↑↓ select  / filter  f free  r refresh  q quit │ D diff  J journal  H history  L leases  B jobs";
const READONLY_ACTIONS = "P push  M rotate  R rename  T check  C reconcile  (admin token required)";

describe("footer widths", () => {
  test("the admin one-line footer is 146 characters and needs a 146-column terminal", () => {
    expect(ADMIN_ONE_LINE.length).toBe(146);
    // 120 columns can no longer hold it: admin splits exactly as readonly does.
    const narrow = footerLines(state({ scope: "admin" }), { cols: 120, rows: 40 });
    expect(narrow.length).toBe(2);
    expect(narrow[0]!.trimEnd()).toBe(NAV_LINE);
    expect(narrow[1]!.trimEnd()).toBe("P push  M rotate  R rename  T check  C reconcile");
    // …and at exactly 146 it is one line again.
    const wide = footerLines(state({ scope: "admin" }), { cols: 146, rows: 40 });
    expect(wide.length).toBe(1);
    expect(wide[0]!.trimEnd()).toBe(ADMIN_ONE_LINE);
    expect(footerLines(state({ scope: "admin" }), { cols: 145, rows: 40 }).length).toBe(2);
  });

  // jobs J12 (D2): the nav line carries the `B jobs` legend at 100 and 120 — the
  // footer-legend-missing-B mutant dies here (and the frames/goldens carry it in
  // every fixture too).
  test("the `B jobs` legend is present in the nav line at 100 and 120", () => {
    expect(NAV_LINE.length).toBe(95);
    for (const cols of [100, 120] as const) {
      const f = footerLines(state({ scope: "admin" }), { cols, rows: 40 });
      expect(f[0]!).toContain("B jobs");
    }
    // and in the readonly footer too.
    expect(footerLines(state({ scope: "readonly" }), { cols: 120, rows: 40 })[0]!).toContain("B jobs");
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
    const f = footerLines(state({ scope: "admin" }), { cols: 146, rows: 40 })[0]!;
    expect(f.split("│").length - 1).toBe(2);
    for (const w of ["select", "filter", "free", "refresh", "quit", "diff", "journal", "history", "leases", "jobs", "push", "rotate", "rename", "check", "reconcile"]) {
      expect(f).toContain(w);
    }
  });

  test("every footer line is padded to exactly the width", () => {
    for (const cols of [80, 100, 119, 120, 146, 148]) {
      for (const scope of ["admin", "readonly"] as const) {
        for (const line of footerLines(state({ scope }), { cols, rows: 40 })) {
          expect(line.length).toBe(cols);
        }
      }
    }
  });
});
