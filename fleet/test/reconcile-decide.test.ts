// T1 — reconcile_decide table, every row of tests:484-523 transcribed verbatim
// as fixtures, plus the FLEET_ROTATE_BEFORE_SECS override (D3) and the day-edge
// cases (F10-S2/T7).

import { test, expect, describe } from "bun:test";
import { decide, type DecideInputs } from "../src/reconcile/decide.ts";

// Positional helper mirroring the bash `decide` harness arg order:
// online lastseen_fresh dupcount both_online_dup tunnel checkfail expiry_days drift [checkfail_runs]
function d(
  online: DecideInputs["online"],
  lastseenFresh: DecideInputs["lastseenFresh"],
  dupcount: number,
  bothOnlineDup: DecideInputs["bothOnlineDup"],
  tunnel: DecideInputs["tunnel"],
  checkfail: DecideInputs["checkfail"],
  expiryDays: number | "unknown",
  drift: DecideInputs["drift"],
  checkfailRuns = 0,
  rotateBeforeDays?: number,
): string[] {
  return decide({
    online,
    lastseenFresh,
    dupcount,
    bothOnlineDup,
    tunnel,
    checkfail,
    expiryDays,
    drift,
    checkfailRuns,
    rotateBeforeDays,
  });
}

describe("T1 reconcile_decide (tests:484-523)", () => {
  test("row a: offline + tunnel up => mint", () => {
    expect(d("no", "yes", 1, "no", "up", "no", "unknown", "unknown", 0)).toContain("mint");
  });
  test("row a: stale lastSeen + tunnel up => mint", () => {
    expect(d("yes", "no", 1, "no", "up", "no", "unknown", "unknown", 0)).toContain("mint");
  });
  test("row b: dup (not both online) => delete-then-rename", () => {
    expect(d("yes", "yes", 2, "no", "up", "no", "unknown", "unknown", 0)).toContain(
      "delete-then-rename",
    );
  });
  test("row b: BOTH online => incident, NEVER delete", () => {
    const out = d("yes", "yes", 2, "yes", "up", "no", "unknown", "unknown", 0);
    expect(out).toContain("alert-incident:duplicate-both-online");
    expect(out).not.toContain("delete-then-rename");
  });
  test("row c: expiry 3d + tunnel => rotate", () => {
    expect(d("yes", "yes", 1, "no", "up", "no", 3, "no", 0)).toContain("rotate");
  });
  test("row c: expiry 30d => no rotate", () => {
    expect(d("yes", "yes", 1, "no", "up", "no", 30, "no", 0)).not.toContain("rotate");
  });
  test("row d: drift + tunnel => rollout", () => {
    expect(d("yes", "yes", 1, "no", "up", "no", "unknown", "yes", 0)).toContain("rollout");
  });
  test("row e: both paths dead (offline) => alert-asleep", () => {
    expect(d("no", "yes", 1, "no", "down", "no", "unknown", "unknown", 0)).toContain("alert-asleep");
  });
  test("row e: online + both-dead => incoherent incident", () => {
    expect(d("yes", "yes", 1, "no", "down", "no", "unknown", "unknown", 0)).toContain(
      "alert-incident:incoherent-both-dead",
    );
  });
  test("N-1: check FAIL > 3 runs => reachable-cannot-converge", () => {
    expect(d("yes", "yes", 1, "no", "up", "yes", "unknown", "no", 4)).toContain(
      "alert-incident:reachable-cannot-converge",
    );
  });
  test("N-1: check FAIL only 2 runs => no incident yet", () => {
    expect(d("yes", "yes", 1, "no", "up", "yes", "unknown", "no", 2)).not.toContain(
      "alert-incident:reachable-cannot-converge",
    );
  });
  test("fully healthy => noop", () => {
    expect(d("yes", "yes", 1, "no", "up", "no", 30, "no", 0)).toEqual(["noop"]);
  });
  test("row e: tunnel down but online unknown (no API) => no classify (noop)", () => {
    // main:2510 — online=unknown means row e does NOT classify.
    expect(d("unknown", "unknown", 0, "no", "down", "no", "unknown", "unknown", 0)).toEqual([
      "noop",
    ]);
  });
});

describe("T1/T7 day-edge + FLEET_ROTATE_BEFORE_SECS override (F10-S2)", () => {
  test("6d (< 7) => rotate; 7d (>= 7) => no rotate at default threshold", () => {
    expect(d("yes", "yes", 1, "no", "up", "no", 6, "no", 0)).toContain("rotate");
    expect(d("yes", "yes", 1, "no", "up", "no", 7, "no", 0)).not.toContain("rotate");
  });
  test("override threshold: 10d rotates when rotateBeforeDays=14", () => {
    // FLEET_ROTATE_BEFORE_SECS=1209600 (14d) ⇒ floor/86400 = 14
    expect(d("yes", "yes", 1, "no", "up", "no", 10, "no", 0, 14)).toContain("rotate");
  });
});

describe("multiple tokens fire together", () => {
  test("dup + mint-worthy + drift all emit", () => {
    const out = d("no", "no", 2, "no", "up", "no", 3, "yes", 0);
    expect(out).toContain("delete-then-rename");
    expect(out).toContain("mint");
    expect(out).toContain("rotate");
    expect(out).toContain("rollout");
    expect(out).not.toContain("noop");
  });
});
