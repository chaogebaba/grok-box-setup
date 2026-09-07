// keystale.ts — "is this box's recorded key from a PREVIOUS incarnation?"
//
// r2/R2(a). This predicate exists in exactly ONE place on purpose. It is asked
// by three callers that must never disagree:
//
//   - `mintWindowValid` (actions/mint.ts), which decides whether the tick skips
//     a mint;
//   - the AUTHKEY column of `grokfleet fleet-status`;
//   - the AUTHKEY column of `grokfleet status` (inventory).
//
// The r1 gate found the disagreement that motivates it: on the production VPS,
// `grok-box-011` had a key row minted 2026-08-30 against a binding established
// 2026-09-06, no `secrets/ts-authkey` on the box at all, and the AUTHKEY column
// printing `2026-11-28` as though that key meant something. The engine would
// refuse that key the moment it were asked; the column said it was fine for
// eighty-three more days. A column that reports a date the engine would reject
// is worse than a column with no data, because it reads as reassurance.
//
// A key minted BEFORE the current binding belongs to the box that existed
// before the re-image. Its expiry date is real and irrelevant.
//
// UNKNOWABLE is not stale. Both instants come from the store; the 5.7.1 file
// layout records neither, and `store/legacy.ts` imports rows with a NULL
// `enrolled_at` on purpose. When either is undefined the answer is "not stale",
// which keeps a legacy-imported fleet out of both the re-mint path and the
// `stale` column.

import type { Env } from "./env.ts";
import { openReadHandle } from "./store/membership.ts";

/** The two store reads this predicate needs — a subset of ReconcileStateApi. */
export interface KeyTimes {
  keyMintedAt(box: string): number | undefined;
  bindingAt(box: string): number | undefined;
}

/** What the AUTHKEY column prints instead of a date for a stale key. */
export const STALE_AUTHKEY = "stale";

/** True iff the box has a key row minted before its CURRENT binding. */
export function keyStale(state: KeyTimes, box: string): boolean {
  const mintedAt = state.keyMintedAt(box);
  const boundAt = state.bindingAt(box);
  if (mintedAt === undefined || boundAt === undefined) return false;
  return mintedAt < boundAt;
}

/**
 * The production staleness reader: ONE read-only store handle for a whole
 * table, closed before anything is rendered. A handle per row would open eleven
 * databases to answer eleven booleans.
 *
 * r4: this lived in `fleet-status.ts` and again, verbatim, in `inventory.ts`.
 * Two copies of a fail-open catch is two places to get the failure semantics
 * wrong, so it is one function here beside the predicate it wraps.
 *
 * FAIL-OPEN, and the catch is load-bearing — but not for the reason it looks
 * like. `openStore` wraps every open-time failure (a directory where the file
 * should be, a non-database file, unwritable pragmas) in `ConfigError`, and
 * `openReadHandle` swallows exactly that class and hands back a file-backed
 * handle with `store === undefined`. So an unopenable file never reaches here.
 *
 * What DOES reach here is a store that opens cleanly, reports a schema version
 * this binary knows, and then throws on the first query — `no such table:
 * box_keys` from a truncated file, an interrupted `state restore`, or a
 * hand-made database. That throw happens inside the per-box loop, one query at
 * a time, and without this catch it would propagate out of `grokfleet status`
 * and `grokfleet fleet-status` and take the whole table down. These are the
 * read-only surfaces an operator reaches for WHEN something is wrong; they must
 * render what they can (F7.2), so a store that cannot answer means "no
 * staleness claim", not "no output".
 */
export function storeKeyStale(env: Env, boxes: string[]): (box: string) => boolean {
  const stale = new Set<string>();
  try {
    const h = openReadHandle(env);
    try {
      // `h.state` IS a ReconcileStateApi, which carries both timestamp
      // accessors; `h.store` being undefined means there is no store to ask.
      if (h.store !== undefined) {
        for (const b of boxes) if (keyStale(h.state, b)) stale.add(b);
      }
    } finally {
      h.close();
    }
  } catch {
    /* a store that cannot answer makes no staleness claim */
  }
  return (box: string) => stale.has(box);
}

/** The one store read the tickwedge display rule needs — a subset of
 *  ReconcileStateApi. `null` is the store's own "never recorded" answer. */
export interface TickwedgeSeen {
  lastTickwedge(box: string): number | null;
}

/**
 * The tickwedge sibling of `storeKeyStale`, for the COND column of
 * `grokfleet fleet-status`. It answers, per box, "what is the highest tickwedge
 * this brain has RECORDED?" — the datum `statelessConditions` needs to tell a
 * real increase (page-worthy) from a latched-but-seen counter (grok-box-007's
 * `tickwedge=1`, stale since 2026-09-04). Without it the column prints a stale
 * `tick-wedged?` forever, because boxup never resets `$RUN_DIR/tickwedge`.
 *
 * Same shape as `storeKeyStale`, for the same reasons: ONE read-only handle for
 * the whole table, closed before anything renders; injectable for tests; and
 * FAIL-OPEN. The three outcomes the caller distinguishes:
 *   - a number  → the recorded high-water (drives the `> seen` / `<= seen` rule);
 *   - `null`    → the store opened and answered "never recorded" for this box
 *                 (first sight — the reconciler records silently, so the column
 *                 keeps the `?`);
 *   - `undefined` → NO store, or a store that opened and then threw on the query
 *                 (the load-bearing catch, exactly as keystale.ts:60-75 explains
 *                 — a read-only surface must render what it can, F7.2). The
 *                 caller treats this identically to `null`: today's `?`.
 * fleet-status NEVER writes to the store; this only reads.
 */
export function storeTickwedgeSeen(env: Env, boxes: string[]): (box: string) => number | null | undefined {
  const seen = new Map<string, number | null>();
  try {
    const h = openReadHandle(env);
    try {
      if (h.store !== undefined) {
        for (const b of boxes) seen.set(b, h.state.lastTickwedge(b));
      }
    } finally {
      h.close();
    }
  } catch {
    /* a store that cannot answer makes no tickwedge claim: undefined ⇒ `?` */
  }
  // A box present in the map carries the store's answer (number or null); a box
  // absent (no store, or the query threw before it was reached) is `undefined`.
  return (box: string) => seen.get(box);
}
