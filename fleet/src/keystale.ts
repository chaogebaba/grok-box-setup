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
