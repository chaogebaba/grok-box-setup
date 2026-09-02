// T3 — devFields (dev_field port), tests:561-583 transcribed; daysUntil edges.

import { test, expect, describe } from "bun:test";
import { devFields, daysUntil } from "../src/reconcile/inputs.ts";
import { decide } from "../src/reconcile/decide.ts";

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
  test("a NOT-live node with a stale lastSeen ⇒ fresh=no", () => {
    const stale = JSON.stringify({
      devices: [{ hostname: "grok-box-8", nodeId: "A", connectedToControl: false, lastSeen: oldIso }],
    });
    expect(devFields(stale, "grok-box-8", { nowSec: NOW, staleSecs: 600 }).fresh).toBe("no");
  });

  test("D12: a LIVE node is fresh whatever its lastSeen says", () => {
    // CHANGED by D12 (was "stale live node ⇒ fresh=no"). The API omits lastSeen
    // for some connected devices, and a stale timestamp on a device that is
    // talking to the control server is not evidence of anything — treating it
    // as stale would mint a key at every tick for a perfectly healthy box.
    const stale = JSON.stringify({
      devices: [{ hostname: "grok-box-8", nodeId: "A", online: true, lastSeen: oldIso }],
    });
    expect(devFields(stale, "grok-box-8", { nowSec: NOW, staleSecs: 600 }).fresh).toBe("yes");
  });
});

// --- D12: the fields the Tailscale API actually returns ----------------------
//
// Fixtures captured from the LIVE `GET /tailnet/{t}/devices` response shape,
// measured on the production VPS on 2026-09-02: a box with a healthy tunnel
// carries `connectedToControl: true`, and the one asleep box carried
// `connectedToControl: false` with `lastSeen` 477 s old. There is no `online`
// field in that response and there never was.

describe("D12 online is derived from connectedToControl", () => {
  const at = (secsAgo: number) => new Date((NOW - secsAgo) * 1000).toISOString();
  const one = (d: Record<string, unknown>) => JSON.stringify({ devices: [{ hostname: "grok-box-8", ...d }] });
  const f = (body: string) => devFields(body, "grok-box-8", { nowSec: NOW, staleSecs: 600 });

  test("connected WITHOUT lastSeen ⇒ online yes, fresh yes (kills mutant t)", () => {
    // tailscale/tailscale#17504: lastSeen may be omitted for a connected device.
    const g = f(one({ nodeId: "A", connectedToControl: true }));
    expect(g.online).toBe("yes");
    expect(g.fresh).toBe("yes");
  });

  test("connected WITH a fresh lastSeen ⇒ online yes, fresh yes", () => {
    const g = f(one({ nodeId: "A", connectedToControl: true, lastSeen: at(5) }));
    expect(g.online).toBe("yes");
    expect(g.fresh).toBe("yes");
  });

  test("NOT connected, lastSeen 477 s old ⇒ online no, fresh yes (the asleep box)", () => {
    // grok-box-006 as measured: no listener, connectedToControl false. Row e
    // reads this as asleep, not incoherent.
    const g = f(one({ nodeId: "A", connectedToControl: false, lastSeen: at(477) }));
    expect(g.online).toBe("no");
    expect(g.fresh).toBe("yes");
  });

  test("NOT connected, lastSeen two days old ⇒ online no, fresh no", () => {
    const g = f(one({ nodeId: "A", connectedToControl: false, lastSeen: at(2 * 86400) }));
    expect(g.online).toBe("no");
    expect(g.fresh).toBe("no");
  });

  test("the legacy `online: true` alone is still honoured", () => {
    // Kept so the day the API grows the field it is used without another change.
    const g = f(one({ nodeId: "A", online: true }));
    expect(g.online).toBe("yes");
  });

  test("two devices, one connected ⇒ liveId is the CONNECTED one", () => {
    const two = JSON.stringify({
      devices: [
        { hostname: "grok-box-8-1", nodeId: "STALE", connectedToControl: false, lastSeen: oldIso },
        { hostname: "grok-box-8", nodeId: "LIVE", connectedToControl: true, lastSeen: nowIso },
      ],
    });
    const g = devFields(two, "grok-box-8", { nowSec: NOW, staleSecs: 600 });
    expect(g.dupcount).toBe(2);
    expect(g.liveId).toBe("LIVE");
    expect(g.staleId).toBe("STALE");
    expect(g.bothOnline).toBe("no");
  });
});

describe("D12 the decision table finally sees a true `online`", () => {
  const at = (secsAgo: number) => new Date((NOW - secsAgo) * 1000).toISOString();
  const row = (d: Record<string, unknown>) => {
    const g = devFields(JSON.stringify({ devices: [{ hostname: "grok-box-8", nodeId: "A", ...d }] }), "grok-box-8", {
      nowSec: NOW,
      staleSecs: 600,
    });
    return decide({
      online: g.online,
      lastseenFresh: g.fresh,
      dupcount: g.dupcount,
      bothOnlineDup: g.bothOnline,
      tunnel: "down",
      checkfail: "no",
      expiryDays: "unknown",
      drift: "no",
      checkfailRuns: 0,
    });
  };

  test("tunnel down + connected to control ⇒ incoherent-both-dead", () => {
    // The whole point of D12: this branch was unreachable in production, so D5
    // hysteresis, D6(c) repair priority and repair itself never fired.
    expect(row({ connectedToControl: true, lastSeen: at(5) })).toEqual([
      "alert-incident:incoherent-both-dead",
    ]);
  });

  test("tunnel down + NOT connected ⇒ alert-asleep (text unchanged)", () => {
    expect(row({ connectedToControl: false, lastSeen: at(477) })).toEqual(["alert-asleep"]);
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
