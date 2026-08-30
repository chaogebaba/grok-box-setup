// status-alias.test.ts — T6 status summary lines from inventory (D3/F2 Q1).

import { describe, test, expect } from "bun:test";
import { statusSummaryLines } from "../../src/commands/aliases.ts";
import type { InventoryResult, ProbeResult } from "../../src/inventory.ts";

function row(box: string, sha: string, tunnel: "up" | "down" = "up"): ProbeResult {
  return {
    box,
    api: "online",
    lastSeen: null,
    tunnel,
    check: tunnel === "up" ? "OK" : "-",
    version: sha === "-" ? "-" : "5.3.0",
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
    const r = res([row("grok-box-3", "aaa"), row("grok-box-5", "bbb")], "aaa");
    const lines = statusSummaryLines(r);
    expect(lines).toContain("status: fleet is MIXED-version (2 distinct shas); target=aaa");
    expect(lines).toContain("status: some boxes drift from target=aaa");
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
