// snapshots.test.ts — D9 (m) the snapshot round-trip and (k)'s v2 half, the
// 92-day retention (blueprint fleet2-state-store D3, Phase B).
//
// The round-trip IS the compatibility contract: `GET /v1/fleet` and
// `GET /v1/history` must serve byte-identical `SnapshotLine` JSON before and
// after the storage swap, or every client of the 5.8.0 API is broken by an
// internal refactor. Each fixture below is written into the three tables and
// read back, and the assertion is on `JSON.stringify` — not on a field-by-field
// comparison, which would let a reordered or an extra key through.
//
// The three `target_*` columns are EXCLUDED from the round-trip by design
// (r2-n3): they are the tick's resolved rollout target, which the line never
// carried, and `readLatestMeta` is what serves them.

import { describe, expect, test } from "bun:test";
import type { SnapshotBox, SnapshotLine } from "../../src/history/schema.ts";
import type { Observed } from "../../src/reconcile/observe.ts";
import {
  observedFor,
  pruneSnapshots,
  readLatestMeta,
  readLatestSnapshot,
  readSnapshotSlice,
  writeSnapshot,
} from "../../src/store/snapshots.ts";
import { SNAPSHOT_RETENTION_DAYS } from "../../src/store/schema.ts";
import { memStore, T0 } from "./helpers.ts";

function box(name: string, over: Partial<SnapshotBox> = {}): SnapshotBox {
  return {
    name,
    tunnel: "up",
    check: "OK",
    ver: "5.3.0",
    drift: "no",
    config: "in-sync",
    checkfail: false,
    asleep: false,
    expiry_days: 40,
    ...over,
  };
}

const HEALTHY = new Map<string, Observed>([["grok-box-008", "healthy"]]);

/** Every fixture the round-trip must reproduce exactly. */
const FIXTURES: Array<{ name: string; line: SnapshotLine }> = [
  {
    name: "a plain healthy tick",
    line: {
      v: 1,
      ts: "2026-09-01T12:00:00Z",
      apply: true,
      canary: "grok-box-008",
      boxes: [box("grok-box-008")],
    },
  },
  {
    name: "every nullable field at null and every value-set edge",
    line: {
      v: 1,
      ts: "2026-09-01T12:05:00Z",
      apply: false,
      canary: null,
      boxes: [
        box("grok-box-008", { tunnel: "down", check: "-", ver: "-", drift: "unknown", config: null, expiry_days: null }),
        box("grok-box-009", { check: "FAIL", drift: "yes", config: "drift", checkfail: true, asleep: true, expiry_days: 0 }),
        box("grok-box-010", { config: "skip", expiry_days: -3 }),
      ],
    },
  },
  {
    name: "an EMPTY fleet (the early-return tick still records)",
    line: { v: 1, ts: "2026-09-01T12:10:00Z", apply: true, canary: null, boxes: [] },
  },
  {
    name: "a discover block WITH a skip list",
    line: {
      v: 1,
      ts: "2026-09-01T12:15:00Z",
      apply: true,
      canary: null,
      boxes: [box("grok-box-008")],
      discover: {
        candidates: 3,
        adopted: 1,
        repaired: 0,
        skipped: [
          { name: "grok-box-004", reason: "unreachable" },
          { name: "grok-box-005", reason: "backoff" },
        ],
      },
    },
  },
  {
    name: "a discover block that saw NOTHING (three zeros, not three nulls)",
    line: {
      v: 1,
      ts: "2026-09-01T12:20:00Z",
      apply: false,
      canary: null,
      boxes: [],
      discover: { candidates: 0, adopted: 0, repaired: 0, skipped: [] },
    },
  },
];

describe("(m) snapshot round-trip", () => {
  for (const [i, f] of FIXTURES.entries()) {
    test(`byte-identical JSON: ${f.name}`, () => {
      const s = memStore();
      const observed = new Map(f.line.boxes.map((b) => [b.name, "healthy" as Observed]));
      writeSnapshot(s, { tick: i + 1, line: f.line, observed });
      const back = readLatestSnapshot(s)!;
      expect(JSON.stringify(back)).toBe(JSON.stringify(f.line));
      s.close();
    });
  }

  test("a tick with NO discover pass reassembles WITHOUT the key, not with null", () => {
    const s = memStore();
    const line: SnapshotLine = { v: 1, ts: "2026-09-01T12:00:00Z", apply: true, canary: null, boxes: [] };
    writeSnapshot(s, { tick: 1, line, observed: new Map() });
    const back = readLatestSnapshot(s)!;
    expect("discover" in back).toBe(false);
    s.close();
  });

  test("box ORDER is the tick's visit order, not alphabetical", () => {
    const s = memStore();
    // The tick visits by index; a fixture in reverse name order proves the read
    // preserves insertion order (`ORDER BY rowid`) rather than sorting.
    const line: SnapshotLine = {
      v: 1,
      ts: "2026-09-01T12:00:00Z",
      apply: true,
      canary: null,
      boxes: [box("grok-box-011"), box("grok-box-003"), box("grok-box-007")],
    };
    writeSnapshot(s, { tick: 1, line, observed: new Map() });
    expect(readLatestSnapshot(s)!.boxes.map((b) => b.name)).toEqual([
      "grok-box-011",
      "grok-box-003",
      "grok-box-007",
    ]);
    s.close();
  });

  test("the three target_* columns are EXCLUDED from the line and served separately", () => {
    const s = memStore();
    const line: SnapshotLine = { v: 1, ts: "2026-09-01T12:00:00Z", apply: true, canary: null, boxes: [] };
    writeSnapshot(s, {
      tick: 7,
      line,
      observed: new Map(),
      target: { ref: "main", sha: "abc1234", version: "5.9.0" },
    });
    expect(JSON.stringify(readLatestSnapshot(s))).toBe(JSON.stringify(line));
    expect(readLatestMeta(s)).toEqual({
      tick: 7,
      ts: "2026-09-01T12:00:00Z",
      apply: true,
      target: { ref: "main", sha: "abc1234", version: "5.9.0" },
    });
    s.close();
  });

  // (m9): a write that replaces the PARENT only leaves the tick with no boxes.
  test("(m9) a RETRIED tick yields exactly the SECOND line's children", () => {
    const s = memStore();
    const first: SnapshotLine = {
      v: 1,
      ts: "2026-09-01T12:00:00Z",
      apply: false,
      canary: null,
      boxes: [box("grok-box-008"), box("grok-box-009"), box("grok-box-010")],
      discover: { candidates: 2, adopted: 0, repaired: 0, skipped: [{ name: "grok-box-004", reason: "unreachable" }] },
    };
    const second: SnapshotLine = {
      v: 1,
      ts: "2026-09-01T12:00:30Z",
      apply: true,
      canary: "grok-box-008",
      boxes: [box("grok-box-008", { drift: "yes" })],
      discover: { candidates: 0, adopted: 0, repaired: 1, skipped: [] },
    };
    writeSnapshot(s, { tick: 42, line: first, observed: HEALTHY });
    writeSnapshot(s, { tick: 42, line: second, observed: HEALTHY });

    // exactly one parent, and its children are the SECOND line's
    expect((s.db.query("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number }).n).toBe(1);
    const back = readLatestSnapshot(s)!;
    expect(JSON.stringify(back)).toBe(JSON.stringify(second));
    // never an EMPTY box list — the failure mode (m9) produces
    expect(back.boxes).toHaveLength(1);
    expect((s.db.query("SELECT COUNT(*) AS n FROM snapshot_boxes").get() as { n: number }).n).toBe(1);
    expect((s.db.query("SELECT COUNT(*) AS n FROM snapshot_skipped").get() as { n: number }).n).toBe(0);
    s.close();
  });

  test("`observed` is stored per box and served by name, newest tick wins", () => {
    const s = memStore();
    const line = (ts: string): SnapshotLine => ({
      v: 1,
      ts,
      apply: true,
      canary: null,
      boxes: [box("grok-box-008"), box("grok-box-009")],
    });
    writeSnapshot(s, {
      tick: 1,
      line: line("2026-09-01T12:00:00Z"),
      observed: new Map<string, Observed>([
        ["grok-box-008", "healthy"],
        ["grok-box-009", "drifted"],
      ]),
    });
    writeSnapshot(s, {
      tick: 2,
      line: line("2026-09-01T12:05:00Z"),
      observed: new Map<string, Observed>([["grok-box-008", "hostkey_mismatch"]]),
    });
    expect(observedFor(s, "grok-box-008")).toBe("hostkey_mismatch");
    // 009 was absent from the second tick's map ⇒ recorded as api_unknown
    expect(observedFor(s, "grok-box-009")).toBe("api_unknown");
    expect(observedFor(s, "grok-box-404")).toBeUndefined();
    s.close();
  });

  test("no snapshots at all ⇒ undefined, never a throw", () => {
    const s = memStore();
    expect(readLatestSnapshot(s)).toBeUndefined();
    expect(readLatestMeta(s)).toBeUndefined();
    expect(readSnapshotSlice(s, { hours: 24, nowIso: "2026-09-01T12:00:00Z" })).toEqual([]);
    s.close();
  });
});

describe("(m) the history slice", () => {
  /** Twelve ticks, five minutes apart, ending at T. 008 in all, 009 in half. */
  function seed(s: ReturnType<typeof memStore>): void {
    for (let i = 0; i < 12; i++) {
      const ts = new Date((T0 + i * 300) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const boxes = i % 2 === 0 ? [box("grok-box-008"), box("grok-box-009")] : [box("grok-box-008")];
      writeSnapshot(s, { tick: i + 1, line: { v: 1, ts, apply: true, canary: null, boxes }, observed: new Map() });
    }
  }

  test("newest-first, windowed by hours", () => {
    const s = memStore();
    seed(s);
    const now = new Date((T0 + 11 * 300) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const all = readSnapshotSlice(s, { hours: 24, nowIso: now });
    expect(all).toHaveLength(12);
    expect(all[0]!.ts > all[1]!.ts).toBe(true); // newest FIRST
    // a 10-minute window admits the last three ticks (0, 5 and 10 minutes back)
    expect(readSnapshotSlice(s, { hours: 10 / 60, nowIso: now })).toHaveLength(3);
    s.close();
  });

  test("the box filter keeps only ticks that RECORDED that box", () => {
    const s = memStore();
    seed(s);
    const now = new Date((T0 + 11 * 300) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    expect(readSnapshotSlice(s, { hours: 24, box: "grok-box-008", nowIso: now })).toHaveLength(12);
    expect(readSnapshotSlice(s, { hours: 24, box: "grok-box-009", nowIso: now })).toHaveLength(6);
    expect(readSnapshotSlice(s, { hours: 24, box: "grok-box-404", nowIso: now })).toHaveLength(0);
    s.close();
  });
});

describe("(k) v2 retention: 92 days of snapshots, children cascade", () => {
  test("93 days old goes, 91 days old stays, and the child rows go with it", () => {
    const s = memStore();
    const day = 86400;
    const write = (tick: number, ageDays: number): void =>
      writeSnapshot(s, {
        tick,
        line: {
          v: 1,
          ts: new Date((T0 - ageDays * day) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
          apply: true,
          canary: null,
          boxes: [box("grok-box-008")],
          discover: { candidates: 0, adopted: 0, repaired: 0, skipped: [{ name: "grok-box-004", reason: "backoff" }] },
        },
        observed: HEALTHY,
      });
    write(1, 93);
    write(2, 91);
    write(3, 0);

    const removed = pruneSnapshots(s, SNAPSHOT_RETENTION_DAYS, T0);
    expect(removed).toBe(1);
    const ticks = (s.db.query("SELECT tick FROM snapshots ORDER BY tick").all() as Array<{ tick: number }>).map(
      (r) => r.tick,
    );
    expect(ticks).toEqual([2, 3]);
    // ON DELETE CASCADE took the 93-day-old tick's children with it, so the
    // retention rule is the single DELETE and not a three-table sweep.
    expect((s.db.query("SELECT COUNT(*) AS n FROM snapshot_boxes").get() as { n: number }).n).toBe(2);
    expect((s.db.query("SELECT COUNT(*) AS n FROM snapshot_skipped").get() as { n: number }).n).toBe(2);
    s.close();
  });
});
