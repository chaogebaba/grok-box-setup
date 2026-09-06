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
