// T8 — asleep/incoherent throttles (D6), transcribing asleep_test (tests:1785-1833).

import { test, expect, describe } from "bun:test";
import {
  alertAsleep,
  alertIncoherent,
  INCIDENT_KINDS,
  INCIDENT_RENOTIFY_SECS,
} from "../src/reconcile/alerts.ts";
import { readFileSync } from "node:fs";
import { ReconcileState, type StateFs } from "../src/reconcile/state.ts";

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

  test("INCIDENT_KINDS covers every alert-incident token decide.ts can emit", () => {
    // The re-arm loop walks INCIDENT_KINDS. A token missing from it still
    // dedups but never clears, so a resolved-then-recurring incident would stay
    // silent for a day — a quiet failure no other test would catch.
    const src = readFileSync(new URL("../src/reconcile/decide.ts", import.meta.url), "utf8");
    const emitted = new Set(
      [...src.matchAll(/"alert-(incident:[a-z-]+)"/g)].map((m) => m[1] as string),
    );
    expect(emitted.size).toBeGreaterThan(0);
    for (const kind of emitted) expect(INCIDENT_KINDS as readonly string[]).toContain(kind);
  });
});
