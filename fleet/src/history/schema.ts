// schema.ts — the TUI-D4 history snapshot line schema (v:1).
//
// The reconcile tick appends ONE JSON line per run to
// `${FLEET_STATE}/history/<YYYY-MM-DD>.jsonl` (daily files). `GET /v1/fleet`
// reads the last line of the newest file and merges live state markers over it
// (TUI-D4). This module defines the wire shape ONLY — no I/O — so both the
// writer (history/write.ts) and the reader (history/read.ts, serve handlers)
// agree on the contract. Lane B's render layer consumes exactly these fields.

/** A box's per-tick snapshot fields (TUI-D4 field contracts). */
export interface SnapshotBox {
  name: string;
  /** tunnel up/down at tick time. */
  tunnel: "up" | "down";
  /** fleet-status CHECK semantics: OK when the box is healthy, FAIL when the
   *  check failed, "-" when never probed (tunnel down). */
  check: "OK" | "FAIL" | "-";
  /** the human version from splitVersion (NOT just the sha), or "-". */
  ver: string;
  /** VERSION drift vs targetSha: "yes"|"no"|"unknown". */
  drift: "yes" | "no" | "unknown";
  /** per-box config verdict from the config pass, or null when no managed
   *  files / the box was never visited. */
  config: "in-sync" | "drift" | "skip" | null;
  /** live-marker mirrors captured at snapshot time (GET /v1/fleet lets the
   *  live markers override these). */
  checkfail: boolean;
  asleep: boolean;
  /** days until the box's key expires, or null when unknown. */
  expiry_days: number | null;
}

/** One reconcile-tick snapshot line (the daily jsonl record). */
export interface SnapshotLine {
  v: 1;
  /** ISO8601Z at tick end. */
  ts: string;
  /** true iff the tick ran in --apply mode. */
  apply: boolean;
  /** the box the config pass ACTUALLY used this tick (config-pass canary), or
   *  null when no managed files / no reachable box. NOT the rollout canary. */
  canary: string | null;
  boxes: SnapshotBox[];
}
