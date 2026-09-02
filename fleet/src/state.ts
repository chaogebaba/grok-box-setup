// state.ts — the `grokfleet inventory` VIEW types.
//
// This module used to own `inventory.json`: a per-box snapshot the CLI wrote
// after every inventory pass and the upgrade pass rewrote after every applied
// rollout. The file is RETIRED in 5.9.0 (blueprint fleet2-state-store D3/D7): it
// was a SECOND per-box view of the same fleet, written by a different path from
// the tick's snapshot, and readers picked one of the two. The store's `boxes`
// rows plus the last tick's snapshot are the one view now, and the applied
// pass's `lastUpgrade` block became an `audit` row (upgrade.ts).
//
// What survives is the SHAPE, because `grokfleet inventory --json` and
// `grokfleet status --json` still print it. Nothing persists it any more.

export interface BoxEntry {
  api: string | null;
  /** ISO8601 lastSeen from the Tailscale API, or null (F7: null when API `?`). */
  lastSeen?: string | null;
  tunnel: string | null;
  check: string | null;
  version: string | null;
  sha: string | null;
  /** the box's own tunnel= token (F7.1), never the table TUNNEL column. */
  boxTunnel?: string | null;
  checkReason?: string | null;
  expires?: string | null;
  checkedAt: string;
  /** reason string when a field is `?`/null (F7.3). */
  reason?: string | null;
}

export interface Inventory {
  generatedAt: string;
  target: { ref: string | null; sha: string | null; version: string | null };
  boxes: Record<string, BoxEntry>;
}
