// T8 — asleep/incoherent throttles (D6), transcribing asleep_test (tests:1785-1833).

import { test, expect, describe } from "bun:test";
import {
  alertAsleep,
  alertIncoherent,
  alertBoxConditions,
  statelessConditions,
  shortCondition,
  CONDITION_KINDS,
  KEEPAWAKE_STALE_SECS,
  INCIDENT_KINDS,
  INCIDENT_RENOTIFY_SECS,
} from "../src/reconcile/alerts.ts";
import { readFileSync } from "node:fs";
import { ReconcileState, type StateFs } from "../src/reconcile/state.ts";
import type { BoxReport } from "../src/status.ts";

function memState(): { fs: StateFs; store: Map<string, string> } {
  const store = new Map<string, string>();
  const fs: StateFs = {
    read: (p) => store.get(p),
    write: (p, d) => store.set(p, d),
    remove: (p) => store.delete(p),
    mkdirp: () => {},
    chmod: () => {},
    rename: (f, t) => {
      const v = store.get(f);
      if (v !== undefined) {
        store.set(t, v);
        store.delete(f);
      }
    },
    exists: (p) => store.has(p),
    tmpname: (dir, prefix) => `${dir}/${prefix}x`,
  };
  return { fs, store };
}

const SD = "/var/lib/grok-fleet";

describe("T8 asleep throttle", () => {
  test("fresh (no file), T=0 ⇒ fires first alert and stamps last=now", async () => {
    const { fs, store } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: Array<[string, string]> = [];
    await alertAsleep("grok-box-1", {
      state: s,
      notify: (lvl, msg) => {
        notes.push([lvl, msg]);
      },
      nowSec: 1000,
      asleepTSecs: 0,
    });
    expect(notes.length).toBe(1);
    expect(notes[0]![0]).toBe("info");
    expect(notes[0]![1]).toContain("asleep — both paths dead");
    // state: "<since> <last>" with since=now (1000), last=now (1000)
    expect(store.get(`${SD}/grok-box-1.asleep`)).toBe("1000 1000\n");
  });

  test("not yet T ⇒ no alert, since stamped, last stays 0", async () => {
    const { fs, store } = memState();
    const s = new ReconcileState(SD, fs);
    let fired = false;
    await alertAsleep("grok-box-1", {
      state: s,
      notify: () => {
        fired = true;
      },
      nowSec: 1000,
      asleepTSecs: 7200,
    });
    expect(fired).toBe(false);
    expect(store.get(`${SD}/grok-box-1.asleep`)).toBe("1000 0\n");
  });

  test("existing '100 4000000000' within digest window ⇒ last preserved, no alert", async () => {
    const { fs, store } = memState();
    const s = new ReconcileState(SD, fs);
    store.set(`${SD}/grok-box-1.asleep`, "100 4000000000\n");
    let fired = false;
    await alertAsleep("grok-box-1", {
      state: s,
      notify: () => {
        fired = true;
      },
      nowSec: 4000000100, // only 100s since last, < 86400 digest
      asleepTSecs: 0,
      asleepDigestSecs: 86400,
    });
    expect(fired).toBe(false);
    expect(store.get(`${SD}/grok-box-1.asleep`)).toBe("100 4000000000\n");
  });

  test("digest window elapsed ⇒ digest alert, last advanced", async () => {
    const { fs, store } = memState();
    const s = new ReconcileState(SD, fs);
    store.set(`${SD}/grok-box-1.asleep`, "100 1000\n");
    const notes: string[] = [];
    await alertAsleep("grok-box-1", {
      state: s,
      notify: (_l, m) => {
        notes.push(m);
      },
      nowSec: 1000 + 86400,
      asleepDigestSecs: 86400,
    });
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("still asleep (daily digest)");
    expect(store.get(`${SD}/grok-box-1.asleep`)).toBe(`100 ${1000 + 86400}\n`);
  });
});

describe("T8 incoherent throttle", () => {
  test("first run ⇒ count 1, NO notify; second run ⇒ notify warn", async () => {
    const { fs, store } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: Array<[string, string]> = [];
    const deps = { state: s, notify: (l: "info" | "warn", m: string) => void notes.push([l, m]), nowSec: 0 };
    await alertIncoherent("grok-box-1", deps);
    expect(notes.length).toBe(0);
    expect(store.get(`${SD}/grok-box-1.incoherent`)).toBe("1\n");
    await alertIncoherent("grok-box-1", deps);
    expect(notes.length).toBe(1);
    expect(notes[0]![0]).toBe("warn");
    expect(notes[0]![1]).toContain("incoherent-both-dead (API online yet both paths dead for 2 consecutive runs)");
  });
});

// --- alert dedup -----------------------------------------------------------
//
// Before this, an incident that nobody had fixed yet was re-sent on every tick.
// At a 5-minute timer that is 288 identical messages a day per box, which is how
// a real half-dead box (009, 2026-09-02) buried everything else in the channel.

describe("incident dedup", () => {
  const TICK = 300; // the reconcile timer

  test("a CONTINUING incoherent condition sends once, not once per tick", async () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: string[] = [];
    const at = (nowSec: number) =>
      alertIncoherent("grok-box-1", { state: s, notify: (_l, m) => void notes.push(m), nowSec });

    await at(0); // run 1: count 1, below the >= 2 gate
    expect(notes.length).toBe(0);
    await at(TICK); // run 2: fires
    expect(notes.length).toBe(1);
    // Twelve more ticks of the same unresolved condition: silence.
    for (let i = 2; i < 14; i++) await at(TICK * i);
    expect(notes.length).toBe(1);
    // A day later it repeats, as a digest.
    await at(TICK + INCIDENT_RENOTIFY_SECS);
    expect(notes.length).toBe(2);
  });

  test("the run count in the message keeps advancing while the SEND is throttled", async () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: string[] = [];
    const at = (nowSec: number) =>
      alertIncoherent("grok-box-1", { state: s, notify: (_l, m) => void notes.push(m), nowSec });
    for (let i = 0; i < 10; i++) await at(TICK * i);
    await at(TICK + INCIDENT_RENOTIFY_SECS);
    // Throttling the send must not stop the counter: the digest has to say how
    // long this has been going on, not repeat the number it first reported.
    expect(notes[0]).toContain("for 2 consecutive runs");
    expect(notes[1]).toContain("for 11 consecutive runs");
  });

  test("a cleared incident re-arms immediately — the window does not outlive it", () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    expect(s.alertDue("grok-box-1", "incident:x", INCIDENT_RENOTIFY_SECS, 1000)).toBe(true);
    expect(s.alertDue("grok-box-1", "incident:x", INCIDENT_RENOTIFY_SECS, 1300)).toBe(false);
    s.alertClear("grok-box-1", "incident:x");
    // A NEW occurrence is news even one tick after the last one was reported.
    expect(s.alertDue("grok-box-1", "incident:x", INCIDENT_RENOTIFY_SECS, 1600)).toBe(true);
  });

  test("an unreadable throttle row fails OPEN", () => {
    const { fs, store } = memState();
    const s = new ReconcileState(SD, fs);
    store.set(`${SD}/grok-box-1.alert-incident-x`, "garbage\n");
    // Never go quiet on state we cannot read: send, and rewrite the row.
    expect(s.alertDue("grok-box-1", "incident:x", INCIDENT_RENOTIFY_SECS, 1000)).toBe(true);
    expect(s.alertDue("grok-box-1", "incident:x", INCIDENT_RENOTIFY_SECS, 1001)).toBe(false);
  });

  test("kinds that differ only in punctuation do not collide in the file layout", () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    expect(s.alertDue("grok-box-1", "incident:incoherent-both-dead", 99999, 1000)).toBe(true);
    // A different kind is a different row, so it is not swallowed by the first.
    expect(s.alertDue("grok-box-1", "incident:reachable-cannot-converge", 99999, 1000)).toBe(true);
  });

  test("INCIDENT_KINDS + CONDITION_KINDS cover every kind the source can raise (exhaustiveness)", () => {
    // Decision.4. The re-arm/clear loops walk these lists; a kind raised but
    // missing dedups yet never re-arms — a quiet failure no other test catches.
    //
    // Two changes over the pre-5.13.0 scan restore the property that BOTH
    // directions testify:
    //   1. The corpus is decide.ts AND alerts.ts (the post-verdict pass raises
    //      bare literals in alerts.ts, outside decide.ts's reach), with the
    //      INCIDENT_KINDS/CONDITION_KINDS array literals STRIPPED — otherwise a
    //      declared kind lands in `emitted` from its own declaration and
    //      direction 2 would vouch for the array using the array.
    //   2. The regex is prefix-optional and admits digits/`condition:`.
    const DECL = /export const (?:INCIDENT|CONDITION)_KINDS = \[[^\]]*\]/g;
    const files = ["../src/reconcile/decide.ts", "../src/reconcile/alerts.ts"];
    const emitted = new Set<string>();
    for (const f of files) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8").replace(DECL, "");
      for (const m of src.matchAll(/"(?:alert-)?((?:incident|condition):[a-z0-9-]+)"/g)) {
        emitted.add(m[1] as string);
      }
    }
    const known = new Set<string>([...INCIDENT_KINDS, ...CONDITION_KINDS]);
    // With the strip, `emitted` counts RAISED kinds and `known` counts DECLARED
    // kinds; in the healthy state they are equal. This is a strictly earlier,
    // stronger form of direction 2 for the "declare a kind nothing raises"
    // mutant (F29): that mutant makes known.size exceed emitted.size, so this
    // SIZE assertion fires FIRST, before direction 2 below runs.
    expect(emitted.size).toBeGreaterThanOrEqual(INCIDENT_KINDS.length + CONDITION_KINDS.length);
    // direction 1: every kind the source can raise is declared. (Catches the
    // "drop a kind from CONDITION_KINDS" mutant: the raise-site literal survives
    // the array edit, so `emitted` carries a kind `known` no longer has.)
    for (const kind of emitted) expect([...known]).toContain(kind);
    // direction 2: and no declared kind is dead.
    for (const kind of [...INCIDENT_KINDS, ...CONDITION_KINDS]) expect([...emitted]).toContain(kind);
  });
});


// --- box-reported conditions (5.13.0 D2/D3a) ---------------------------------

/** A BoxReport with all-clear defaults; override the field under test. */
function rpt(over: Partial<BoxReport> = {}): BoxReport {
  return {
    tickwedge: 0,
    tunnelfail: 0,
    disk: { pct: 5, level: "ok" },
    keepawakeOn: false,
    keepawakeRc: null,
    keepawakeLast: null,
    jumps: 0,
    jobState: null,
    refreshFailing: 0,
    repairFailing: 0,
    ...over,
  };
}

/** collect notify() calls while running the pass once. */
async function runPass(
  box: string,
  s: ReconcileState,
  report: BoxReport,
  nowSec: number,
  notes: Array<[string, string]>,
  over: { keepawakeStaleSecs?: number } = {},
): Promise<string[]> {
  return alertBoxConditions(box, report, {
    state: s,
    notify: (lvl, msg) => {
      notes.push([lvl, msg]);
    },
    nowSec,
    ...over,
  });
}

describe("alertBoxConditions — raises, clears, and the conditions array", () => {
  test("disk-fail raises warn and appears in conditions; clears when level drops", async () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: Array<[string, string]> = [];
    const active = await runPass("grok-box-1", s, rpt({ disk: { pct: 93, level: "fail" } }), 1000, notes);
    expect(active).toContain("disk-fail");
    expect(notes.some(([l, m]) => l === "warn" && m.includes("condition:disk-fail"))).toBe(true);
    // level drops ⇒ cleared, absent from conditions
    const active2 = await runPass("grok-box-1", s, rpt({ disk: { pct: 5, level: "ok" } }), 2000, notes);
    expect(active2).not.toContain("disk-fail");
  });

  test("disk-warn raises INFO (not warn) on warn level only", async () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: Array<[string, string]> = [];
    const active = await runPass("grok-box-1", s, rpt({ disk: { pct: 82, level: "warn" } }), 1000, notes);
    expect(active).toEqual(["disk-warn"]);
    expect(notes[0]![0]).toBe("info");
    // MUTANT (disk-warn on fail level only): a fail-level report must NOT raise
    // disk-warn. This is what that mutant breaks.
    const active2 = await runPass("grok-box-2", s, rpt({ disk: { pct: 93, level: "fail" } }), 1000, notes);
    expect(active2).not.toContain("disk-warn");
  });

  test("repair-failing raises on refresh>=3 OR repair>=3", async () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: Array<[string, string]> = [];
    expect(await runPass("grok-box-1", s, rpt({ refreshFailing: 3 }), 1000, notes)).toContain("repair-failing");
    expect(await runPass("grok-box-2", s, rpt({ repairFailing: 3 }), 1000, notes)).toContain("repair-failing");
    // below threshold ⇒ nothing
    expect(await runPass("grok-box-3", s, rpt({ refreshFailing: 2, repairFailing: 2 }), 1000, notes)).not.toContain(
      "repair-failing",
    );
  });

  test("24 ticks of a persisting condition ⇒ ONE message (dedup)", async () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: Array<[string, string]> = [];
    let now = 1000;
    for (let i = 0; i < 24; i++) {
      await runPass("grok-box-1", s, rpt({ disk: { pct: 93, level: "fail" } }), now, notes);
      now += 300; // 5-minute ticks; 24 ticks = 2h, well inside the 24h window
    }
    expect(notes.filter(([, m]) => m.includes("condition:disk-fail")).length).toBe(1);
  });

  test("clear then re-raise inside the window ⇒ alerts AGAIN", async () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: Array<[string, string]> = [];
    await runPass("grok-box-1", s, rpt({ disk: { pct: 93, level: "fail" } }), 1000, notes); // raise
    await runPass("grok-box-1", s, rpt({ disk: { pct: 5, level: "ok" } }), 1300, notes); // clear
    await runPass("grok-box-1", s, rpt({ disk: { pct: 93, level: "fail" } }), 1600, notes); // re-raise
    expect(notes.filter(([, m]) => m.includes("condition:disk-fail")).length).toBe(2);
  });
});

describe("condition:keepawake-failing — the 3-tick streak and its gates", () => {
  const LAST = "2026-09-06T05:52:58Z";
  const NOW = Math.floor(Date.parse(LAST) / 1000) + 60; // 1 min after last

  test("3 consecutive qualifying status-seen ticks ⇒ fires on the THIRD", async () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: Array<[string, string]> = [];
    const r = rpt({ keepawakeOn: true, keepawakeRc: "refused", keepawakeLast: LAST });
    expect(await runPass("grok-box-1", s, r, NOW, notes)).not.toContain("keepawake-failing");
    expect(await runPass("grok-box-1", s, r, NOW + 300, notes)).not.toContain("keepawake-failing");
    const third = await runPass("grok-box-1", s, r, NOW + 600, notes);
    expect(third).toContain("keepawake-failing");
    expect(notes.some(([l, m]) => l === "info" && m.includes("condition:keepawake-failing"))).toBe(true);
  });

  test("2 then ok then 2 ⇒ NOTHING (the streak resets on the ok tick)", async () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: Array<[string, string]> = [];
    const bad = rpt({ keepawakeOn: true, keepawakeRc: "unreachable", keepawakeLast: LAST });
    const ok = rpt({ keepawakeOn: true, keepawakeRc: "ok", keepawakeLast: LAST });
    await runPass("grok-box-1", s, bad, NOW, notes);
    await runPass("grok-box-1", s, bad, NOW + 300, notes);
    await runPass("grok-box-1", s, ok, NOW + 600, notes); // resets
    await runPass("grok-box-1", s, bad, NOW + 900, notes);
    const last = await runPass("grok-box-1", s, bad, NOW + 1200, notes);
    expect(last).not.toContain("keepawake-failing");
    expect(notes.length).toBe(0);
  });

  test("keepawake=off with a sticky failing rc ⇒ SILENT on 20 ticks (the 004/006 case)", async () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: Array<[string, string]> = [];
    // 004: refused ×; 006: unreachable × — but keepawake=OFF fleet-wide after 5.12.1.
    const off = rpt({ keepawakeOn: false, keepawakeRc: "refused", keepawakeLast: LAST });
    let now = NOW;
    for (let i = 0; i < 20; i++) {
      const active = await runPass("grok-box-004", s, off, now, notes);
      expect(active).not.toContain("keepawake-failing");
      now += 300;
    }
    expect(notes.length).toBe(0);
  });

  test("keepawake_last older than KEEPAWAKE_STALE_SECS ⇒ never counts", async () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: Array<[string, string]> = [];
    // last is fresh's epoch, but now is far in the future ⇒ stale
    const r = rpt({ keepawakeOn: true, keepawakeRc: "refused", keepawakeLast: LAST });
    const farFuture = NOW + KEEPAWAKE_STALE_SECS + 3600;
    for (let i = 0; i < 5; i++) {
      const active = await runPass("grok-box-1", s, r, farFuture + i * 300, notes);
      expect(active).not.toContain("keepawake-failing");
    }
    expect(notes.length).toBe(0);
  });
});

describe("condition:tick-wedged — a DELTA, not a level", () => {
  test("first sight records and stays silent; 1->2 alerts; 2->2 silent; 2->0 records and clears", async () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: Array<[string, string]> = [];
    // first sight of tickwedge=1: record, silent
    expect(await runPass("grok-box-7", s, rpt({ tickwedge: 1 }), 1000, notes)).not.toContain("tick-wedged");
    expect(notes.length).toBe(0);
    expect(s.lastTickwedge("grok-box-7")).toBe(1);
    // 1 -> 2: alert, names both numbers
    const active = await runPass("grok-box-7", s, rpt({ tickwedge: 2 }), 1300, notes);
    expect(active).toContain("tick-wedged");
    expect(notes.some(([, m]) => m.includes("condition:tick-wedged (2, was 1)"))).toBe(true);
    // 2 -> 2 for 20 ticks: silent
    let now = 1600;
    for (let i = 0; i < 20; i++) {
      expect(await runPass("grok-box-7", s, rpt({ tickwedge: 2 }), now, notes)).not.toContain("tick-wedged");
      now += 300;
    }
    expect(notes.filter(([, m]) => m.includes("tick-wedged")).length).toBe(1);
    // 2 -> 0 (image swap): record 0, clear, silent
    expect(await runPass("grok-box-7", s, rpt({ tickwedge: 0 }), now, notes)).not.toContain("tick-wedged");
    expect(s.lastTickwedge("grok-box-7")).toBe(0);
  });

  test("a latched tickwedge=1 seen for the first time pages NOTHING (007's live state)", async () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: Array<[string, string]> = [];
    await runPass("grok-box-007", s, rpt({ tickwedge: 1 }), 1000, notes);
    expect(notes.length).toBe(0);
  });

  // A28: the two cases the "treat null as 0" mutant must fail on. A recorded 0
  // and a never-recorded box are DIFFERENT; only the latter is silent on 1.
  test("recorded 0 then 1 ⇒ ALERTS (a real 0→1 wedge)", async () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: Array<[string, string]> = [];
    // first sight is 0: recorded (silently). Now lastTickwedge === 0, not null.
    await runPass("grok-box-1", s, rpt({ tickwedge: 0 }), 1000, notes);
    expect(s.lastTickwedge("grok-box-1")).toBe(0);
    // 0 -> 1 pages, because last (0) !== null and 1 > 0.
    const active = await runPass("grok-box-1", s, rpt({ tickwedge: 1 }), 1300, notes);
    expect(active).toContain("tick-wedged");
    expect(notes.some(([, m]) => m.includes("condition:tick-wedged (1, was 0)"))).toBe(true);
  });

  test("never recorded then 1 ⇒ SILENT (lastTickwedge is null, not 0) — A28 mutant killer", async () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    const notes: Array<[string, string]> = [];
    expect(s.lastTickwedge("grok-box-2")).toBeNull(); // never recorded
    const active = await runPass("grok-box-2", s, rpt({ tickwedge: 1 }), 1000, notes);
    expect(active).not.toContain("tick-wedged");
    expect(notes.length).toBe(0);
    // the value is now recorded (as 1), so a later 1->2 would page.
    expect(s.lastTickwedge("grok-box-2")).toBe(1);
  });
});

describe("statelessConditions — fleet-status subset", () => {
  test("stateless kinds are exact; stateful kinds carry a trailing ?", () => {
    expect(statelessConditions(rpt({ disk: { pct: 93, level: "fail" } }))).toContain("disk-fail");
    expect(statelessConditions(rpt({ disk: { pct: 82, level: "warn" } }))).toContain("disk-warn");
    expect(statelessConditions(rpt({ refreshFailing: 3 }))).toContain("repair-failing");
    // stateful: shown with ? because the streak/delta cannot be evaluated live
    expect(statelessConditions(rpt({ tickwedge: 1 }))).toContain("tick-wedged?");
    expect(statelessConditions(rpt({ keepawakeOn: true, keepawakeRc: "refused" }))).toContain("keepawake-failing?");
    // a clean report ⇒ nothing
    expect(statelessConditions(rpt())).toEqual([]);
  });

  test("shortCondition strips the condition: prefix and CONDITION_KINDS is in the fixed order", () => {
    expect(shortCondition("condition:disk-fail")).toBe("disk-fail");
    expect(CONDITION_KINDS.map(shortCondition)).toEqual([
      "disk-fail",
      "disk-warn",
      "tick-wedged",
      "keepawake-failing",
      "repair-failing",
    ]);
  });
});
