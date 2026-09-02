// status-alias.test.ts — T6 status summary lines from inventory (D3/F2 Q1).

import { describe, test, expect } from "bun:test";
import { statusSummaryLines } from "../../src/commands/aliases.ts";
import type { InventoryResult, ProbeResult } from "../../src/inventory.ts";

/**
 * D5: `version` decides BOTH halves of the summary — the drift half and the
 * MIXED-version count. It defaults to the target's 5.3.0 so a row is in-sync
 * unless a test asks otherwise; `sha` varies freely and must not move the
 * MIXED line.
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
  test("MIXED-version when >1 distinct version; drift when a box differs from target", () => {
    // D5: both halves need a VERSION difference, so 005 is one release back.
    const r = res([row("grok-box-3", "aaa"), row("grok-box-5", "bbb", "up", "5.2.0")], "aaa");
    const lines = statusSummaryLines(r);
    expect(lines).toContain("status: fleet is MIXED-version (2 distinct versions); target=aaa");
    expect(lines).toContain("status: some boxes drift from target=aaa");
  });

  test("same version, different shas ⇒ no MIXED line", () => {
    // The empirical case at the status call site: after any fleet2-only commit
    // to main every box runs the same boxup version but carries a fresh stamped
    // repo sha. That is neither mixed nor drifted, and the summary must be silent.
    const r = res([row("grok-box-3", "aaa"), row("grok-box-5", "bbb")], "aaa");
    expect(statusSummaryLines(r)).toEqual([]);
  });

  test("three boxes, two versions ⇒ MIXED counts versions, not the three shas", () => {
    const r = res(
      [row("grok-box-3", "aaa"), row("grok-box-5", "bbb"), row("grok-box-9", "ccc", "up", "5.2.0")],
      "aaa",
    );
    const lines = statusSummaryLines(r);
    expect(lines).toContain("status: fleet is MIXED-version (2 distinct versions); target=aaa");
  });

  test("unknown/'?' versions are excluded from the MIXED count", () => {
    const r = res(
      [row("grok-box-3", "aaa"), row("grok-box-5", "bbb", "up", "unknown"), row("grok-box-9", "ccc", "up", "?")],
      "aaa",
    );
    expect(statusSummaryLines(r).some((l) => l.includes("MIXED-version"))).toBe(false);
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
