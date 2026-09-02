// store/snapshots.ts — the per-tick snapshot, in the store (blueprint
// fleet2-state-store D3/D7, Phase B).
//
// 5.8.0 appended one JSON line per tick to `$FLEET_STATE/history/<day>.jsonl`
// and the API read the last line of the newest file. Two per-box views of the
// same tick therefore existed — `inventory.json` written by the CLI, the daily
// jsonl written by the tick — and a reader picked one. From 5.9.0 there is ONE:
// three tables, written in ONE transaction, read back into the SAME
// `SnapshotLine` shape the 5.8.0 API served.
//
// Three properties this file is responsible for:
//
//  1. **Byte-identical reassembly.** `toSnapshotLine` reproduces the 5.8.0 wire
//     shape field for field — `v`, `ts`, `apply`, `canary`, `boxes[]` and the
//     OPTIONAL `discover` block, present iff the tick ran discovery. The three
//     `target_*` columns are NOT on the line (they are the tick's resolved
//     rollout target, which `inventory.json` used to carry) and neither is
//     `snapshot_boxes.observed`, which `GET /v1/boxes/:name` serves instead. A
//     round-trip test is the proof (D9 (m)).
//  2. **A retried tick replaces its snapshot, or nothing.** `INSERT OR REPLACE`
//     on the parent cascade-deletes the children (foreign_keys is ON, so the
//     implicit DELETE fires the CASCADE), then every child row is re-inserted —
//     all inside one transaction. Writing the parent alone would leave the
//     tick's box list empty, which is what mutant (m9) does.
//  3. **Order is the tick's order.** `snapshot_boxes` has no ordinal column, so
//     reads are `ORDER BY rowid` — a STRICT table still has a rowid, and it
//     follows insertion order, which IS the order the tick visited the boxes in.
//
// Sub-second precision is not preserved: `ts` is integer epoch seconds (D3), and
// the engine has only ever written second-granularity ISO8601Z.
//
// The ≤2KB per-line cap the jsonl writer enforced is GONE. It existed because a
// single oversized line could make a daily file unparseable; a row per box has
// no such failure mode, so a large fleet's snapshot is now recorded in full and
// the `boxes_dropped` stub no longer exists.

import type { Store } from "./db.ts";
import type { SnapshotBox, SnapshotLine } from "../history/schema.ts";
import type { Observed } from "../reconcile/observe.ts";

/** The tick's resolved rollout target — the three `target_*` columns (D3). */
export interface SnapshotTarget {
  ref: string | null;
  sha: string | null;
  version: string | null;
}

export interface WriteSnapshotOptions {
  /** the tick ordinal (`engine.tick_seq`), the snapshot's primary key. */
  tick: number;
  line: SnapshotLine;
  /** D4: the liveness label per box name. A box absent from the map is
   *  recorded as `api_unknown` — "not named this tick" is exactly that. */
  observed: Map<string, Observed>;
  target?: SnapshotTarget;
}

/** ISO8601Z (no milliseconds), the shape every reader has always seen. */
export function isoSec(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function epochOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

/**
 * Write one tick's snapshot: ONE transaction over `snapshots`,
 * `snapshot_boxes` and `snapshot_skipped`.
 *
 * A retried tick (the same ordinal written twice) therefore yields exactly the
 * SECOND line's children, never a merge and never an empty box list.
 */
export function writeSnapshot(store: Store, opts: WriteSnapshotOptions): void {
  const { tick, line } = opts;
  const d = line.discover;
  const t = opts.target;
  store.tx(() => {
    store.db
      .query(
        `INSERT OR REPLACE INTO snapshots(
           tick, ts, apply, canary,
           discover_candidates, discover_adopted, discover_repaired,
           target_ref, target_sha, target_version)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        tick,
        epochOf(line.ts),
        line.apply ? 1 : 0,
        line.canary,
        d?.candidates ?? null,
        d?.adopted ?? null,
        d?.repaired ?? null,
        t?.ref ?? null,
        t?.sha ?? null,
        t?.version ?? null,
      );

    const insBox = store.db.query(
      `INSERT INTO snapshot_boxes(tick,name,tunnel,"check",ver,drift,config,checkfail,asleep,expiry_days,observed)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const b of line.boxes) {
      insBox.run(
        tick,
        b.name,
        b.tunnel,
        b.check,
        b.ver,
        b.drift,
        b.config,
        b.checkfail ? 1 : 0,
        b.asleep ? 1 : 0,
        b.expiry_days,
        opts.observed.get(b.name) ?? "api_unknown",
      );
    }

    if (d !== undefined) {
      const insSkip = store.db.query("INSERT INTO snapshot_skipped(tick,name,reason) VALUES(?,?,?)");
      for (const s of d.skipped) insSkip.run(tick, s.name, s.reason);
    }
  });
}

// --- reading ------------------------------------------------------------------

interface SnapshotRow {
  tick: number;
  ts: number;
  apply: number;
  canary: string | null;
  discover_candidates: number | null;
  discover_adopted: number | null;
  discover_repaired: number | null;
  target_ref: string | null;
  target_sha: string | null;
  target_version: string | null;
}

interface BoxRow {
  name: string;
  tunnel: string;
  check: string;
  ver: string;
  drift: string;
  config: string | null;
  checkfail: number;
  asleep: number;
  expiry_days: number | null;
  observed: string;
}

/** Rebuild the 5.8.0 `SnapshotLine` for one parent row (`target_*` excluded). */
function toSnapshotLine(store: Store, row: SnapshotRow): SnapshotLine {
  const boxes = store.db
    .query(
      `SELECT name, tunnel, "check" AS "check", ver, drift, config, checkfail, asleep, expiry_days, observed
       FROM snapshot_boxes WHERE tick = ? ORDER BY rowid`,
    )
    .all(row.tick) as BoxRow[];

  const line: SnapshotLine = {
    v: 1,
    ts: isoSec(row.ts),
    apply: row.apply !== 0,
    canary: row.canary,
    boxes: boxes.map(
      (b): SnapshotBox => ({
        name: b.name,
        tunnel: b.tunnel as SnapshotBox["tunnel"],
        check: b.check as SnapshotBox["check"],
        ver: b.ver,
        drift: b.drift as SnapshotBox["drift"],
        config: b.config as SnapshotBox["config"],
        checkfail: b.checkfail !== 0,
        asleep: b.asleep !== 0,
        expiry_days: b.expiry_days,
      }),
    ),
  };

  // D7: the `discover` block is OPTIONAL and ABSENT when the tick ran no
  // discovery. NULL counts are the discriminator — a discover pass that saw
  // nothing records three zeros, not three NULLs.
  if (row.discover_candidates !== null) {
    const skipped = store.db
      .query("SELECT name, reason FROM snapshot_skipped WHERE tick = ? ORDER BY rowid")
      .all(row.tick) as Array<{ name: string; reason: string }>;
    line.discover = {
      candidates: row.discover_candidates,
      adopted: row.discover_adopted ?? 0,
      repaired: row.discover_repaired ?? 0,
      skipped,
    };
  }
  return line;
}

/** The newest snapshot, or undefined when the store holds none. */
export function readLatestSnapshot(store: Store): SnapshotLine | undefined {
  const row = (store.db.query("SELECT * FROM snapshots ORDER BY ts DESC, tick DESC LIMIT 1").get() ??
    undefined) as SnapshotRow | undefined;
  return row === undefined ? undefined : toSnapshotLine(store, row);
}

/** The newest snapshot's parent row, for callers that want `target_*` / `tick`. */
export function readLatestMeta(
  store: Store,
): { tick: number; ts: string; apply: boolean; target: SnapshotTarget } | undefined {
  const row = (store.db.query("SELECT * FROM snapshots ORDER BY ts DESC, tick DESC LIMIT 1").get() ??
    undefined) as SnapshotRow | undefined;
  if (row === undefined) return undefined;
  return {
    tick: row.tick,
    ts: isoSec(row.ts),
    apply: row.apply !== 0,
    target: { ref: row.target_ref, sha: row.target_sha, version: row.target_version },
  };
}

/**
 * A slice of snapshots, NEWEST-FIRST, within the last `hours` of `nowIso`,
 * optionally restricted to ticks that recorded `box` — the same contract
 * `GET /v1/history` served from the daily files.
 */
export function readSnapshotSlice(
  store: Store,
  opts: { hours: number; box?: string; nowIso: string },
): SnapshotLine[] {
  const cutoff = Math.floor((Date.parse(opts.nowIso) - opts.hours * 3600_000) / 1000);
  const rows =
    opts.box === undefined
      ? (store.db.query("SELECT * FROM snapshots WHERE ts >= ? ORDER BY ts DESC, tick DESC").all(cutoff) as SnapshotRow[])
      : (store.db
          .query(
            `SELECT s.* FROM snapshots s
             WHERE s.ts >= ? AND EXISTS (SELECT 1 FROM snapshot_boxes b WHERE b.tick = s.tick AND b.name = ?)
             ORDER BY s.ts DESC, s.tick DESC`,
          )
          .all(cutoff, opts.box) as SnapshotRow[]);
  return rows.map((r) => toSnapshotLine(store, r));
}

/**
 * The D4 liveness label for a box, from the newest snapshot that recorded it.
 * `undefined` when the store has never recorded the box (a brand-new member, or
 * a store still on schema v1 after a rollback).
 */
export function observedFor(store: Store, box: string): Observed | undefined {
  const r = store.db
    .query(
      `SELECT b.observed AS o FROM snapshot_boxes b JOIN snapshots s ON s.tick = b.tick
       WHERE b.name = ? ORDER BY s.ts DESC, s.tick DESC LIMIT 1`,
    )
    .get(box) as { o?: string } | null;
  return (r?.o as Observed | undefined) ?? undefined;
}

/**
 * D3 retention: 92 days of snapshots, once per tick. Children cascade.
 *
 * The count is taken with a SELECT rather than read off the DELETE: bun's
 * `changes` includes the rows the ON DELETE CASCADE removed, so a naive read
 * would report "pruned 13 snapshots" for one snapshot of twelve boxes.
 */
export function pruneSnapshots(store: Store, retentionDays: number, at: number): number {
  const cutoff = at - retentionDays * 86400;
  const n = (store.db.query("SELECT COUNT(*) AS n FROM snapshots WHERE ts < ?").get(cutoff) as { n: number }).n;
  if (n > 0) store.db.query("DELETE FROM snapshots WHERE ts < ?").run(cutoff);
  return n;
}
