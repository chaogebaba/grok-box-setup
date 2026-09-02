// status-alias.test.ts — T6 status summary lines from inventory (D3/F2 Q1).

import { describe, test, expect } from "bun:test";
import { statusSummaryLines } from "../../src/commands/aliases.ts";
import type { InventoryResult, ProbeResult } from "../../src/inventory.ts";

/**
 * D5: `version` is now what decides the drift half of the summary (the MIXED
 * half still counts distinct shas, and says so in its own line). It defaults to
 * the target's 5.3.0 so a row is in-sync unless a test asks otherwise.
 */
function row(
  box: string,
  sha: string,
  tunnel: "up" | "down" = "up",
  version?: string,
): ProbeResult {
  return {
    box,
    api: "online",
    lastSeen: null,
    tunnel,
    check: tunnel === "up" ? "OK" : "-",
    version: sha === "-" ? "-" : (version ?? "5.3.0"),
    sha,
    status: undefined,
    checkReason: undefined,
    expires: undefined,
  };
}

function res(rows: ProbeResult[], targetSha: string | null): InventoryResult {
  return {
    inventory: { generatedAt: "t", target: { ref: "main", sha: targetSha, version: "5.3.0" }, boxes: {} },
    rows,
    target: targetSha === null ? null : { ref: "main", sha: targetSha, version: "5.3.0" },
    previousGeneratedAt: null,
  };
}

describe("T6 status summary (F2 Q1 addendum, main:303/306)", () => {
  test("MIXED-version when >1 distinct sha; drift when a box differs from target", () => {
    // D5: the drift half needs a VERSION difference, so 005 is one release back.
    const r = res([row("grok-box-3", "aaa"), row("grok-box-5", "bbb", "up", "5.2.0")], "aaa");
    const lines = statusSummaryLines(r);
    expect(lines).toContain("status: fleet is MIXED-version (2 distinct shas); target=aaa");
    expect(lines).toContain("status: some boxes drift from target=aaa");
  });

  test("D5: differing shas at the SAME version are MIXED but NOT drift", () => {
    // The empirical r1 case at the status call site: two boxes on boxup 5.3.0
    // stamped from different commits. The fleet is genuinely mixed-sha and the
    // line says so, but neither box is drifted and neither will be rolled.
    const r = res([row("grok-box-3", "aaa"), row("grok-box-5", "bbb")], "aaa");
    const lines = statusSummaryLines(r);
    expect(lines).toContain("status: fleet is MIXED-version (2 distinct shas); target=aaa");
    expect(lines.some((l) => l.includes("drift"))).toBe(false);
  });

  test("all on target, single sha ⇒ no summary lines", () => {
    const r = res([row("grok-box-3", "aaa"), row("grok-box-5", "aaa")], "aaa");
    expect(statusSummaryLines(r)).toEqual([]);
  });

  test("tunnel-down boxes (sha '-') are not counted as drift or mixed", () => {
    const r = res([row("grok-box-3", "aaa"), row("grok-box-5", "-", "down")], "aaa");
    expect(statusSummaryLines(r)).toEqual([]);
  });
});
