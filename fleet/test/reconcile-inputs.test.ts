// T3 — devFields (dev_field port), tests:561-583 transcribed; daysUntil edges.

import { test, expect, describe } from "bun:test";
import { devFields, daysUntil } from "../src/reconcile/inputs.ts";

// Fixture mirroring devfield_test (tests:571-574): grok-box-8 live + grok-box-8-1
// corpse. Use a fixed "now" so freshness is deterministic.
const NOW = Date.parse("2026-08-30T12:00:00Z") / 1000;
const nowIso = "2026-08-30T12:00:00Z";
const oldIso = "2026-08-30T11:00:00Z"; // -1 hour ⇒ stale (> 600s)
const DEVS = JSON.stringify({
  devices: [
    { hostname: "grok-box-8", nodeId: "LIVE", online: true, lastSeen: nowIso, created: nowIso },
    { hostname: "grok-box-8-1", nodeId: "STALE", online: false, lastSeen: oldIso, created: oldIso },
  ],
});

describe("T3 devFields (tests:561-583)", () => {
  const f = devFields(DEVS, "grok-box-8", { nowSec: NOW, staleSecs: 600 });
  test("dupcount counts grok-box-8 + the -1 corpse => 2", () => {
    expect(f.dupcount).toBe(2);
  });
  test("online=yes (the live node)", () => {
    expect(f.online).toBe("yes");
  });
  test("both_online=no (only one online)", () => {
    expect(f.bothOnline).toBe("no");
  });
  test("stale_id = the OLDER OFFLINE device (delete target)", () => {
    expect(f.staleId).toBe("STALE");
  });
  test("live_id = the ONLINE device (rename target)", () => {
    expect(f.liveId).toBe("LIVE");
  });
  test("fresh=yes (live node lastSeen within 600s)", () => {
    expect(f.fresh).toBe("yes");
  });
});

describe("devFields edge cases", () => {
  test("empty body ⇒ all-unknown defaults (never 'absent')", () => {
    expect(devFields("", "grok-box-8")).toEqual({
      online: "no",
      fresh: "no",
      dupcount: 0,
      bothOnline: "no",
      staleId: "",
      liveId: "",
    });
  });
  test("malformed body ⇒ defaults, never throws", () => {
    expect(() => devFields("{not json", "grok-box-8")).not.toThrow();
    expect(devFields("{not json", "grok-box-8").dupcount).toBe(0);
  });
  test("both online ⇒ bothOnline=yes, no staleId", () => {
    const two = JSON.stringify({
      devices: [
        { hostname: "grok-box-8", nodeId: "A", online: true, lastSeen: nowIso },
        { hostname: "grok-box-8", nodeId: "B", online: true, lastSeen: nowIso },
      ],
    });
    const g = devFields(two, "grok-box-8", { nowSec: NOW, staleSecs: 600 });
    expect(g.bothOnline).toBe("yes");
    expect(g.staleId).toBe("");
  });
  test("no matching device ⇒ dupcount 0, online no", () => {
    expect(devFields(DEVS, "grok-box-9", { nowSec: NOW }).dupcount).toBe(0);
  });
  test("stale live node ⇒ fresh=no", () => {
    const stale = JSON.stringify({
      devices: [{ hostname: "grok-box-8", nodeId: "A", online: true, lastSeen: oldIso }],
    });
    expect(devFields(stale, "grok-box-8", { nowSec: NOW, staleSecs: 600 }).fresh).toBe("no");
  });
});

describe("daysUntil (main:3263-3268)", () => {
  test("+3 days ⇒ 3", () => {
    const base = Date.parse("2026-08-30T00:00:00Z") / 1000;
    expect(daysUntil("2026-09-02", base)).toBe(3);
  });
  test("past date ⇒ negative", () => {
    const base = Date.parse("2026-08-30T00:00:00Z") / 1000;
    expect(daysUntil("2026-08-20", base)).toBe(-10);
  });
  test("unparseable ⇒ unknown", () => {
    expect(daysUntil("not-a-date")).toBe("unknown");
    expect(daysUntil("")).toBe("unknown");
  });
  test("6d23h ⇒ 6 (trunc), 7d0h ⇒ 7", () => {
    const base = Date.parse("2026-08-30T00:00:00Z") / 1000;
    // 2026-09-05T23:00 is 6d23h ahead ⇒ trunc = 6
    expect(daysUntil("2026-09-05T23:00:00Z", base)).toBe(6);
    // exactly 7d ⇒ 7
    expect(daysUntil("2026-09-06T00:00:00Z", base)).toBe(7);
  });
});
