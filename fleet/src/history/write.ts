// write.ts — the reconcile-tick history hook (TUI-D4).
//
// Appends ONE snapshot line to `${FLEET_STATE}/history/<YYYY-MM-DD>.jsonl`. The
// daily file is created 0600; the append is best-effort — a write failure NEVER
// fails the tick (warn-only, matching the state-file idiom). The line is capped
// at ≤2KB (TUI-D4): if the JSON exceeds the cap the boxes array is dropped to a
// count-only stub so the tick_age freshness signal survives even for a huge
// fleet. The hook runs on the finally/every-return path of runReconcile so an
// early-return tick (empty targetBoxes) STILL appends (R2-A4).

import type { SnapshotLine } from "./schema.ts";
import { log } from "../log.ts";

/** ≤2KB cap on a single snapshot line (TUI-D4). */
export const MAX_LINE_BYTES = 2048;

/** Injectable fs seam so tests run against a tmp dir. */
export interface HistoryFs {
  mkdirp(path: string): void;
  /** append `data` to `path`, creating it 0600 if absent. */
  appendFile(path: string, data: string, mode: number): void;
}

import { appendFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";

/** Production fs seam over node:fs; every failure is thrown up to the caller,
 *  which swallows it (warn-only) — the tick must never abort on a write. */
export const nodeHistoryFs: HistoryFs = {
  mkdirp(path) {
    mkdirSync(path, { recursive: true });
  },
  appendFile(path, data, mode) {
    const fresh = !existsSync(path);
    appendFileSync(path, data);
    if (fresh) {
      try {
        chmodSync(path, mode);
      } catch {
        /* best-effort; the append already succeeded */
      }
    }
  },
};

/** The UTC day stamp (YYYY-MM-DD) for a snapshot ts / clock. */
export function dayStamp(iso: string): string {
  return iso.slice(0, 10);
}

/** The daily file path for a given day stamp under FLEET_STATE. */
export function historyFile(fleetState: string, day: string): string {
  return `${fleetState}/history/${day}.jsonl`;
}

/**
 * Serialise a snapshot line, enforcing the ≤2KB cap. When the full line would
 * exceed MAX_LINE_BYTES, the boxes array is replaced by a `boxes_dropped` count
 * so the freshness `ts`/`apply` still land. Always ends with exactly one `\n`.
 */
export function serializeLine(line: SnapshotLine): string {
  const full = JSON.stringify(line) + "\n";
  if (Buffer.byteLength(full, "utf8") <= MAX_LINE_BYTES) return full;
  const stub = JSON.stringify({
    v: line.v,
    ts: line.ts,
    apply: line.apply,
    canary: line.canary,
    boxes: [],
    boxes_dropped: line.boxes.length,
  }) + "\n";
  return stub;
}

/**
 * Append a snapshot line to today's daily file. Best-effort: catches and
 * WARNS on any failure (never throws — the tick must complete). Returns true
 * iff the line was written.
 */
export function appendSnapshot(
  fleetState: string,
  line: SnapshotLine,
  fs: HistoryFs = nodeHistoryFs,
): boolean {
  try {
    const dir = `${fleetState}/history`;
    fs.mkdirp(dir);
    const file = historyFile(fleetState, dayStamp(line.ts));
    fs.appendFile(file, serializeLine(line), 0o600);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`reconcile: history append failed (${msg}) — snapshot not recorded this tick`);
    return false;
  }
}
