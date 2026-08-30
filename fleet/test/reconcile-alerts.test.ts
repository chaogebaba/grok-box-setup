// T8 — asleep/incoherent throttles (D6), transcribing asleep_test (tests:1785-1833).

import { test, expect, describe } from "bun:test";
import { alertAsleep, alertIncoherent } from "../src/reconcile/alerts.ts";
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
