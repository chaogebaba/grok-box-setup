// rc-table.test.ts — agent-ux U3/U6: `grokfleet rc` renders from the ONE constant.
//
// Mutant (c): replace renderRcTable's body with a hardcoded table (e.g. the
// pre-agent-ux list without 124/255) ⇒ "renders EVERY distinct RC value" and
// "the rendering is derived, not transcribed" both fail.

import { describe, test, expect } from "bun:test";
import { RC } from "../../src/upgrade.ts";
import { RC_MEANING, RC_POINTER_LINE, rcCodes, renderRcJson, renderRcTable } from "../../src/commands/rc.ts";
import { USAGE } from "../../src/commands/usage.ts";

describe("U3 the exit-code table cannot drift", () => {
  test("renders EVERY distinct RC value, and nothing that is not in RC", () => {
    const table = renderRcTable();
    const inRc = new Set(Object.values(RC).map(Number));
    for (const code of inRc) {
      expect(table).toContain(`  ${String(code).padEnd(3)}  `);
    }
    // every rendered code is a real RC value (no invented rows).
    const rendered = [...table.matchAll(/^ {2}(\d+) {2}/gm)].map((m) => Number(m[1]));
    expect(new Set(rendered)).toEqual(inRc);
    expect(rendered).toEqual([...rendered].sort((a, b) => a - b));
  });

  test("the rendering is DERIVED: every line is code + its RC_MEANING", () => {
    const lines = renderRcTable().split("\n");
    for (const code of rcCodes()) {
      const line = lines.find((l) => l.startsWith(`  ${String(code).padEnd(3)}  `));
      expect(line).toBeDefined();
      expect(line).toContain(RC_MEANING[code]);
    }
  });

  test("124 (ssh --timeout) and 255 (ssh transport) are listed", () => {
    const table = renderRcTable();
    expect(RC.TIMEOUT).toBe(124);
    expect(RC.TRANSPORT).toBe(255);
    expect(table).toContain("124");
    expect(table).toContain("--timeout");
    expect(table).toContain("255");
    expect(table).toContain("transport");
  });

  test("6 appears ONCE even though two RC keys carry it", () => {
    expect(RC.REFUSED).toBe(6);
    expect(RC.LOCK_BUSY).toBe(6);
    const sixes = renderRcTable().split("\n").filter((l) => /^ {2}6 {3}/.test(l));
    expect(sixes.length).toBe(1);
  });

  test("--json emits one parseable document with the same codes", () => {
    const doc = JSON.parse(renderRcJson()) as { codes: Array<{ code: number; meaning: string }> };
    expect(doc.codes.map((c) => c.code)).toEqual(rcCodes());
    for (const c of doc.codes) expect(typeof c.meaning).toBe("string");
  });

  test("help ends with the rc pointer (U3)", () => {
    expect(USAGE.trimEnd().endsWith(RC_POINTER_LINE)).toBe(true);
  });
});
