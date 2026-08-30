// check.test.ts — T6 check verdict + summary (D3/F5).

import { describe, test, expect } from "bun:test";
import { checkVerdict, checkSummaryLine } from "../../src/commands/aliases.ts";
import type { ProbeResult } from "../../src/inventory.ts";

function row(box: string, check: "OK" | "FAIL" | "-"): ProbeResult {
  return {
    box,
    api: "online",
    lastSeen: null,
    tunnel: check === "-" ? "down" : "up",
    check,
    version: "5.3.0",
    sha: "aaa",
    status: undefined,
    checkReason: undefined,
    expires: undefined,
  };
}

describe("T6 check (F5)", () => {
  test("all OK ⇒ rc 0, no unhealthy", () => {
    const v = checkVerdict([row("grok-box-3", "OK"), row("grok-box-5", "OK")]);
    expect(v.rc).toBe(0);
    expect(v.unhealthy).toEqual([]);
  });

  test("any not-OK ⇒ rc 1, names the unhealthy boxes", () => {
    const v = checkVerdict([row("grok-box-3", "OK"), row("grok-box-901", "FAIL"), row("grok-box-7", "-")]);
    expect(v.rc).toBe(1);
    expect(v.unhealthy).toEqual(["grok-box-901", "grok-box-7"]);
  });

  test("summary line shape: 'check: N unhealthy: <boxes>' (F5)", () => {
    expect(checkSummaryLine(["grok-box-901"])).toBe("check: 1 unhealthy: grok-box-901");
    expect(checkSummaryLine(["grok-box-3", "grok-box-5"])).toBe("check: 2 unhealthy: grok-box-3 grok-box-5");
  });
});
