// T1 (+ T1b) — status parser (D6, F8/S1) and check interpretation (G4/S-C).

import { test, expect, describe } from "bun:test";
import { parseStatusLine, splitVersion, parseCheck } from "../src/status.ts";
import { FULL_STATUS_LINE } from "./helpers.ts";

describe("T1 status parser", () => {
  test("full line → all fields", () => {
    const s = parseStatusLine(FULL_STATUS_LINE);
    expect(s.version).toBe("5.3.0");
    expect(s.sha).toBe("abc1234");
    expect(s.name).toBe("grok-box-008");
    expect(s.boxTunnel).toBe("up");
    expect(s.tags).toBe("tag:box");
    expect(s.keyexpiry).toBe("disabled");
  });

  test("v=5.3.0 (no sha) → version 5.3.0, sha unknown", () => {
    const s = parseStatusLine("name=grok-box-008 v=5.3.0 tunnel=down");
    expect(s.version).toBe("5.3.0");
    expect(s.sha).toBe("unknown");
    expect(s.boxTunnel).toBe("down");
  });

  test("missing v= → both unknown", () => {
    const s = parseStatusLine("name=grok-box-008 tunnel=up");
    expect(s.version).toBe("unknown");
    expect(s.sha).toBe("unknown");
  });

  test("garbage → never throws", () => {
    for (const junk of ["", "   ", "=====", "no tokens here", "v= = = =", "\n\t"]) {
      expect(() => parseStatusLine(junk)).not.toThrow();
    }
    // A line with conditional tokens (refresh/repair/authkey) still parses tunnel LAST.
    const s = parseStatusLine(
      "name=grok-box-011 v=5.3.0/deadbee refresh=failing:3 repair=failing:1 " +
        "authkey=EXPIRED:2026-11-27 tunnel=up",
    );
    expect(s.version).toBe("5.3.0");
    expect(s.sha).toBe("deadbee");
    expect(s.authkey).toBe("EXPIRED:2026-11-27");
    expect(s.boxTunnel).toBe("up");
    expect(s.tokens["refresh"]).toBe("failing:3");
    expect(s.tokens["repair"]).toBe("failing:1");
  });

  test("splitVersion edge cases", () => {
    expect(splitVersion(undefined)).toEqual({ version: "unknown", sha: "unknown" });
    expect(splitVersion("5.3.0")).toEqual({ version: "5.3.0", sha: "unknown" });
    expect(splitVersion("5.3.0/abc")).toEqual({ version: "5.3.0", sha: "abc" });
  });

  test("m7 guard: v=5.3.0 must NOT yield a sha", () => {
    const s = parseStatusLine("v=5.3.0 tunnel=up");
    expect(s.sha).not.toBe("5.3.0");
    expect(s.sha).toBe("unknown");
  });
});

describe("T1b check interpretation", () => {
  test("rc 0 → ok + status from the check=OK line", () => {
    const c = parseCheck(0, "check=OK " + FULL_STATUS_LINE);
    expect(c.ok).toBe(true);
    expect(c.status?.version).toBe("5.3.0");
    expect(c.status?.sha).toBe("abc1234");
    expect(c.reason).toBeUndefined();
  });

  test("rc 1 → FAIL with reason, no status", () => {
    const c = parseCheck(1, "check=FAIL reason=tailscaled-down");
    expect(c.ok).toBe(false);
    expect(c.reason).toBe("tailscaled-down");
    expect(c.status).toBeUndefined();
  });
});
