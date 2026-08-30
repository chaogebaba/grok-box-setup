// T3 — enrolled.tsv parsing (dedup, numeric sort, blank/comment ignored) and
// explicit-target ordering (F7.4).

import { test, expect, describe } from "bun:test";
import { parseEnrolled, resolveMembership, orderExplicit, isValidBoxName } from "../src/boxes.ts";

describe("T3 enrolled.tsv parsing", () => {
  test("dedup, numeric sort, blank + comment lines ignored", () => {
    const tsv = [
      "grok-box-011\t20011",
      "",
      "# a comment",
      "grok-box-008\t20008",
      "grok-box-009\t20009",
      "grok-box-008\t20008", // duplicate
      "   ",
    ].join("\n");
    // numeric order 008, 009, 011 — dedup drops the second 008
    expect(parseEnrolled(tsv)).toEqual(["grok-box-008", "grok-box-009", "grok-box-011"]);
  });

  test("legacy grok-box-3 sorts between 002 and 010 by decimal index", () => {
    const tsv = ["grok-box-010\t20010", "grok-box-002\t20002", "grok-box-3\t20003"].join("\n");
    expect(parseEnrolled(tsv)).toEqual(["grok-box-002", "grok-box-3", "grok-box-010"]);
  });

  test("an unparseable name is emitted last, never dropped", () => {
    const tsv = ["weird-name\t9\t", "grok-box-008\t20008"].join("\n");
    expect(parseEnrolled(tsv)).toEqual(["grok-box-008", "weird-name"]);
  });

  test("phase-2 I2/P4: equal-index tie broken by NAME ASCENDING (003 before 3)", () => {
    // grok-box-3 and grok-box-003 both parse to index 3; GNU coreutils yields
    // name-ascending within the tie, so grok-box-003 sorts before grok-box-3.
    const tsv = [
      "grok-box-3\t20003",
      "grok-box-004\t20004",
      "grok-box-003\t20003",
      "grok-box-002\t20002",
    ].join("\n");
    expect(parseEnrolled(tsv)).toEqual([
      "grok-box-002",
      "grok-box-003",
      "grok-box-3",
      "grok-box-004",
    ]);
  });
});

describe("membership override", () => {
  test("FLEET_BOXES (space-separated) overrides enrolled.tsv", () => {
    expect(resolveMembership("grok-box-008 grok-box-009", "grok-box-011\t20011")).toEqual([
      "grok-box-008",
      "grok-box-009",
    ]);
  });
  test("no override → parse enrolled content", () => {
    expect(resolveMembership(undefined, "grok-box-008\t20008")).toEqual(["grok-box-008"]);
  });
  test("no override + no content → empty", () => {
    expect(resolveMembership(undefined, undefined)).toEqual([]);
  });
});

describe("F7.4 explicit ordering", () => {
  test("canary first, then argv order, deduped", () => {
    const { ordered, invalid } = orderExplicit(
      ["grok-box-009", "grok-box-008", "grok-box-011", "grok-box-009"],
      "grok-box-008",
    );
    expect(invalid).toEqual([]);
    expect(ordered).toEqual(["grok-box-008", "grok-box-009", "grok-box-011"]);
  });
  test("invalid names are reported, not sent", () => {
    const { ordered, invalid } = orderExplicit(["grok-box-008", "rm -rf /"], undefined);
    expect(invalid).toEqual(["rm -rf /"]);
    expect(ordered).toEqual([]);
  });
  test("isValidBoxName", () => {
    expect(isValidBoxName("grok-box-008")).toBe(true);
    expect(isValidBoxName("grok-box-8")).toBe(true);
    expect(isValidBoxName("grok-box-")).toBe(false);
    expect(isValidBoxName("box-8")).toBe(false);
    expect(isValidBoxName("grok-box-8; rm")).toBe(false);
  });
});
