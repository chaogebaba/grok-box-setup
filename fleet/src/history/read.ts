// read.ts — history read/slice/prune (TUI-D4).
//
// `GET /v1/fleet` = the LAST line of the NEWEST daily file (readLatest).
// `GET /v1/history?box=&hours=H` = a tail-read slice, newest-first (readSlice).
// Prune: daily files whose day is >92 days old are removed at startup AND lazily
// on the first history read of a NEW day (no rollover timer — R3-A6).
//
// All I/O is behind a small injectable seam so tests run against a tmp dir.

import type { SnapshotLine } from "./schema.ts";

/** Retention window in days (TUI-D4). */
export const RETENTION_DAYS = 92;

/** Injectable fs seam for reads/prune. */
export interface HistoryReadFs {
  /** list `*.jsonl` basenames in the history dir (undefined ⇒ dir absent). */
  listDays(dir: string): string[] | undefined;
  /** read a file's full text, or undefined when absent/unreadable. */
  read(path: string): string | undefined;
  /** remove a file (best-effort). */
  remove(path: string): void;
}

import { readdirSync, readFileSync, rmSync, existsSync } from "node:fs";

export const nodeHistoryReadFs: HistoryReadFs = {
  listDays(dir) {
    try {
      if (!existsSync(dir)) return undefined;
      return readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      return undefined;
    }
  },
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  remove(path) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* best-effort */
    }
  },
};

/** Day stamp (YYYY-MM-DD) of a `<day>.jsonl` basename, or undefined. */
function dayOf(basename: string): string | undefined {
  const m = basename.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
  return m ? m[1]! : undefined;
}

/** Days between two YYYY-MM-DD stamps (a - b), integer, UTC midnight. */
export function dayDiff(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
  return Math.round((ta - tb) / 86400_000);
}

/**
 * Prune daily files older than RETENTION_DAYS relative to `today` (YYYY-MM-DD).
 * Returns the list of removed day stamps. Safe when the dir is absent.
 */
export function prune(
  fleetState: string,
  today: string,
  fs: HistoryReadFs = nodeHistoryReadFs,
): string[] {
  const dir = `${fleetState}/history`;
  const files = fs.listDays(dir);
  if (files === undefined) return [];
  const removed: string[] = [];
  for (const f of files) {
    const day = dayOf(f);
    if (day === undefined) continue; // leave foreign files alone
    if (dayDiff(today, day) > RETENTION_DAYS) {
      fs.remove(`${dir}/${f}`);
      removed.push(day);
    }
  }
  return removed;
}

/** Parse a jsonl body into lines (skipping blank/malformed lines). */
function parseLines(body: string): SnapshotLine[] {
  const out: SnapshotLine[] = [];
  for (const raw of body.split("\n")) {
    const l = raw.trim();
    if (l === "") continue;
    try {
      out.push(JSON.parse(l) as SnapshotLine);
    } catch {
      /* skip a corrupt line */
    }
  }
  return out;
}

/** Sorted day stamps present (ascending), from the history dir. */
export function listDayStamps(fleetState: string, fs: HistoryReadFs = nodeHistoryReadFs): string[] {
  const dir = `${fleetState}/history`;
  const files = fs.listDays(dir);
  if (files === undefined) return [];
  const days: string[] = [];
  for (const f of files) {
    const d = dayOf(f);
    if (d !== undefined) days.push(d);
  }
  days.sort();
  return days;
}

/**
 * The LAST snapshot line of the NEWEST daily file, or undefined when there is
 * no history yet. This is `GET /v1/fleet`'s file read (no ssh). Lazily prunes
 * when `today` is newer than the newest recorded day (first-read-of-new-day,
 * R3-A6) — pass `today` to enable it (omit in pure unit reads).
 */
export function readLatest(
  fleetState: string,
  opts: { today?: string; fs?: HistoryReadFs } = {},
): SnapshotLine | undefined {
  const fs = opts.fs ?? nodeHistoryReadFs;
  const days = listDayStamps(fleetState, fs);
  if (days.length === 0) return undefined;
  const newest = days[days.length - 1]!;
  // Lazy prune: first read of a new day (today strictly after newest recorded).
  if (opts.today !== undefined && dayDiff(opts.today, newest) > 0) {
    prune(fleetState, opts.today, fs);
  }
  const body = fs.read(`${fleetState}/history/${newest}.jsonl`);
  if (body === undefined) return undefined;
  const lines = parseLines(body);
  return lines.length > 0 ? lines[lines.length - 1] : undefined;
}

/**
 * A tail-read slice of snapshot lines, newest-first, within the last `hours`
 * relative to `nowIso`. Optionally filtered to lines that include `box`. Reads
 * only the daily files whose day could fall in the window. Lazily prunes on a
 * new day.
 */
export function readSlice(
  fleetState: string,
  opts: { hours: number; box?: string; nowIso: string; fs?: HistoryReadFs },
): SnapshotLine[] {
  const fs = opts.fs ?? nodeHistoryReadFs;
  const today = opts.nowIso.slice(0, 10);
  const days = listDayStamps(fleetState, fs);
  if (days.length === 0) return [];
  const newest = days[days.length - 1]!;
  if (dayDiff(today, newest) > 0) prune(fleetState, today, fs);

  const cutoffMs = Date.parse(opts.nowIso) - opts.hours * 3600_000;
  // Only files whose day is >= the cutoff day are candidates (a line's ts is on
  // its file's day, so a file older than the cutoff day cannot contribute).
  const cutoffDay = new Date(cutoffMs).toISOString().slice(0, 10);
  const candidates = listDayStamps(fleetState, fs).filter((d) => d >= cutoffDay);

  const all: SnapshotLine[] = [];
  for (const d of candidates) {
    const body = fs.read(`${fleetState}/history/${d}.jsonl`);
    if (body === undefined) continue;
    for (const line of parseLines(body)) {
      const t = Date.parse(line.ts);
      if (Number.isNaN(t) || t < cutoffMs) continue;
      if (opts.box !== undefined && !line.boxes.some((b) => b.name === opts.box)) continue;
      all.push(line);
    }
  }
  // newest-first
  all.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return all;
}
