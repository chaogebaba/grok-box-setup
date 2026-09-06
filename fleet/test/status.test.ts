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


// --- toReport (5.13.0 box-conditions D1) -------------------------------------

import { toReport } from "../src/status.ts";

describe("toReport — the typed BoxReport", () => {
  // The real grok-box-011 line from the 2026-09-06 audit raw pull: it carries
  // NO tickwedge, NO refresh=, NO repair= (those tokens are conditional), and a
  // healthy disk=5% keepawake=on/ok. It is the ABSENT-form fixture.
  const LINE_011 =
    "backend=Running online=yes exit-node=yes sshd=up ipfwd=4:1,6:1 " +
    "tailscaled=4499 selfheal=11022 worker=11022 hb=14s name=grok-box-011 " +
    "v=5.6.0/ed2834e tags=tag:grok-box keyexpiry=disabled tunnel=up " +
    "tunnelfail=0 disk=5% keepawake=on keepawake_last=2026-09-06T05:52:58Z " +
    "keepawake_rc=ok jumps=0 job=- job_state=-";

  test("the real 011 line: absent conditional tokens default SAFE", () => {
    const r = toReport(parseStatusLine(LINE_011));
    expect(r.tickwedge).toBe(0); // absent ⇒ 0
    expect(r.tunnelfail).toBe(0);
    expect(r.disk).toEqual({ pct: 5, level: "ok" });
    expect(r.keepawakeOn).toBe(true);
    expect(r.keepawakeRc).toBe("ok");
    expect(r.keepawakeLast).toBe("2026-09-06T05:52:58Z");
    expect(r.jumps).toBe(0);
    expect(r.jobState).toBe("-"); // job_state=- ⇒ the literal "-" (a value)
    expect(r.refreshFailing).toBe(0); // absent ⇒ 0
    expect(r.repairFailing).toBe(0);
  });

  test("a synthesised line carrying every PRESENT form", () => {
    const line =
      "name=grok-box-000 v=5.6.0/abc tunnel=up tunnelfail=7 disk=93%/fail " +
      "tickwedge=4 keepawake=on keepawake_last=2026-09-06T05:52:58Z " +
      "keepawake_rc=refused jumps=3 job=j1 job_state=running " +
      "refresh=failing:5 repair=failing:2";
    const r = toReport(parseStatusLine(line));
    expect(r.tickwedge).toBe(4);
    expect(r.tunnelfail).toBe(7);
    expect(r.disk).toEqual({ pct: 93, level: "fail" });
    expect(r.keepawakeOn).toBe(true);
    expect(r.keepawakeRc).toBe("refused");
    expect(r.keepawakeLast).toBe("2026-09-06T05:52:58Z");
    expect(r.jumps).toBe(3);
    expect(r.jobState).toBe("running");
    expect(r.refreshFailing).toBe(5);
    expect(r.repairFailing).toBe(2);
  });

  test("disk in all four shapes", () => {
    expect(toReport(parseStatusLine("v=5/a disk=unknown")).disk).toEqual({ pct: null, level: "unknown" });
    expect(toReport(parseStatusLine("v=5/a disk=5%")).disk).toEqual({ pct: 5, level: "ok" });
    expect(toReport(parseStatusLine("v=5/a disk=82%/warn")).disk).toEqual({ pct: 82, level: "warn" });
    expect(toReport(parseStatusLine("v=5/a disk=93%/fail")).disk).toEqual({ pct: 93, level: "fail" });
    // absent disk= ⇒ unknown
    expect(toReport(parseStatusLine("v=5/a tunnel=up")).disk).toEqual({ pct: null, level: "unknown" });
    // garbage disk= ⇒ unknown
    expect(toReport(parseStatusLine("v=5/a disk=weird")).disk).toEqual({ pct: null, level: "unknown" });
  });

  test("keepawake_rc domain: `-` and absence and off-domain values ⇒ null", () => {
    for (const rc of ["ok", "inert", "refused", "skip", "unreachable", "parked-ok", "parked-blocked"]) {
      expect(toReport(parseStatusLine(`v=5/a keepawake=on keepawake_rc=${rc}`)).keepawakeRc).toBe(rc);
    }
    // `-` ⇒ null (initialiser), absence ⇒ null, `off`/`error` are NOT this token
    expect(toReport(parseStatusLine("v=5/a keepawake=on keepawake_rc=-")).keepawakeRc).toBeNull();
    expect(toReport(parseStatusLine("v=5/a keepawake=on")).keepawakeRc).toBeNull();
    expect(toReport(parseStatusLine("v=5/a keepawake_rc=off")).keepawakeRc).toBeNull();
    expect(toReport(parseStatusLine("v=5/a keepawake_rc=error")).keepawakeRc).toBeNull();
  });

  test("keepawakeOn: only `keepawake=on` is true; off/absent ⇒ false", () => {
    expect(toReport(parseStatusLine("v=5/a keepawake=on")).keepawakeOn).toBe(true);
    expect(toReport(parseStatusLine("v=5/a keepawake=off")).keepawakeOn).toBe(false);
    expect(toReport(parseStatusLine("v=5/a")).keepawakeOn).toBe(false);
  });

  test("keepawake_last: `never`, garbage, and absence all ⇒ null", () => {
    expect(toReport(parseStatusLine("v=5/a keepawake_last=never")).keepawakeLast).toBeNull();
    expect(toReport(parseStatusLine("v=5/a keepawake_last=not-a-date")).keepawakeLast).toBeNull();
    expect(toReport(parseStatusLine("v=5/a")).keepawakeLast).toBeNull();
    expect(toReport(parseStatusLine("v=5/a keepawake_last=2026-09-06T05:52:58Z")).keepawakeLast).toBe(
      "2026-09-06T05:52:58Z",
    );
  });

  test("a defaulted status (garbage line) is all-clear — the D1b guard relies on this", () => {
    const r = toReport(parseStatusLine(""));
    expect(r.tickwedge).toBe(0);
    expect(r.disk.level).toBe("unknown");
    expect(r.keepawakeRc).toBeNull();
    expect(r.keepawakeOn).toBe(false);
    expect(r.repairFailing).toBe(0);
  });

  test("refresh=/repair= only match the failing:N shape", () => {
    expect(toReport(parseStatusLine("v=5/a refresh=failing:3")).refreshFailing).toBe(3);
    expect(toReport(parseStatusLine("v=5/a repair=failing:1")).repairFailing).toBe(1);
    // a non-failing value ⇒ 0
    expect(toReport(parseStatusLine("v=5/a refresh=ok")).refreshFailing).toBe(0);
  });
});
