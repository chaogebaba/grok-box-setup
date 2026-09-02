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

  // boxup-disk-guard G5(c). boxup 5.3.2 appends a `disk=` token AFTER tunnel=,
  // which was safe only because this parser is token-keyed and drops unknown
  // keys. The build proved that by driving the parser once by hand; this is the
  // permanent version, so a future parser change cannot regress it silently.
  // The contract is two-sided: every pre-existing field keeps its value, AND
  // the new key is reachable ONLY through `tokens`.
  test("boxup 5.3.2 disk= token: ignored as a field, present in tokens", () => {
    const line =
      "backend=Running online=yes exit-node=yes sshd=up ipfwd=4:1,6:1 " +
      "tailscaled=42 selfheal=43 worker=43 hb=3s name=grok-box-005 " +
      "v=5.3.2/deadbee tags=tag:grok-box keyexpiry=disabled " +
      "tunnel=up tunnelfail=0 disk=93%/fail";
    const s = parseStatusLine(line);
    expect(s.version).toBe("5.3.2");
    expect(s.sha).toBe("deadbee");
    expect(s.name).toBe("grok-box-005");
    expect(s.boxTunnel).toBe("up");
    expect(s.tags).toBe("tag:grok-box");
    expect(s.keyexpiry).toBe("disabled");
    expect(s.authkey).toBeUndefined();
    expect(s.tokens["disk"]).toBe("93%/fail");
    expect(s.tokens["tunnelfail"]).toBe("0");
    // `disk` must not have leaked into a typed field.
    expect(Object.keys(s)).not.toContain("disk");
  });

  test("the disk= token's three shapes all round-trip through tokens", () => {
    for (const [tok, want] of [
      ["disk=22%", "22%"],
      ["disk=85%/warn", "85%/warn"],
      ["disk=93%/fail", "93%/fail"],
      ["disk=unknown", "unknown"],
    ] as const) {
      const s = parseStatusLine(`name=grok-box-005 v=5.3.2/abc tunnel=up ${tok}`);
      expect(s.tokens["disk"]).toBe(want);
      expect(s.version).toBe("5.3.2");
      expect(s.boxTunnel).toBe("up");
    }
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

  // boxup-disk-guard G5(c), the check side. boxup 5.3.2's disk FAIL reason
  // contains spaces, so `reason=(\S+)` captures only its first run — `disk`.
  // That is pre-existing behaviour (`name: unnamed` behaves the same way) and
  // the alert path keys on the leading word, so it is pinned here deliberately
  // rather than left to be rediscovered.
  test("boxup 5.3.2 disk FAIL reason: first token captured, no status", () => {
    const c = parseCheck(1, "check=FAIL reason=disk 93% (after truncation) want < 90%");
    expect(c.ok).toBe(false);
    expect(c.reason).toBe("disk");
    expect(c.status).toBeUndefined();
  });

  test("rc 0 with a disk= token still parses the whole status", () => {
    const c = parseCheck(0, "check=OK " + FULL_STATUS_LINE + " disk=22%");
    expect(c.ok).toBe(true);
    expect(c.status?.version).toBe("5.3.0");
    expect(c.status?.sha).toBe("abc1234");
    expect(c.status?.tokens["disk"]).toBe("22%");
  });
});
