// backup.ts — the once-a-day integrity + backup step and the restore path
// (blueprint fleet2-state-store D8).
//
// `quick_check` is deliberately OFF the per-tick path. It runs:
//   - at `grokfleet serve` start — a FAILURE there SETS the flag and serve STARTS
//     in the flagged mode. The unit is Restart=on-failure with
//     StartLimitIntervalSec=0 on purpose (vps/install-vps.sh), so a serve that
//     refused would be an unbounded loop of full scans that never parks in
//     `failed`;
//   - at `grokfleet state check`;
//   - once per UTC DAY inside the tick's backup step — so it is on the tick path
//     exactly once a day, on the largest file, next to the VACUUM that already
//     reads every page.
//
// While `meta.integrity_failed_at` is set: the tick refuses (rc 3, one log line,
// no writes, and NO backup — the seven existing backups are the recovery
// material), API MUTATION endpoints return 503, and READONLY endpoints and the
// TUI keep serving the last data. The flag is cleared only by a passing
// `grokfleet state check` or by `grokfleet state restore <file>`.

import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, copyFileSync } from "node:fs";
import type { Store } from "./db.ts";
import { log } from "../log.ts";

/** How many dated backups are kept (D8). */
export const BACKUP_KEEP = 7;

export function backupDir(fleetState: string): string {
  return `${fleetState}/backup`;
}

/** UTC date stamp, `YYYY-MM-DD`. */
export function utcDate(at: number): string {
  return new Date(at * 1000).toISOString().slice(0, 10);
}

export interface MaintenanceResult {
  /** "skipped" when a backup already exists for today. */
  ran: boolean;
  /** the quick_check verdict when it ran. */
  quickCheck?: string;
  /** set when quick_check failed — the caller notifies and halts the tick. */
  integrityFailed?: string;
  /** the backup file written. */
  file?: string;
  /** files pruned by the keep-7 rule. */
  pruned?: string[];
  /** wall time of quick_check + backup, milliseconds. */
  ms?: number;
  /**
   * The backup itself could not be written (the state directory went away or
   * lost write permission after the store was opened). Maintenance is best
   * effort: the caller logs and notifies, and the tick's own verdict stands. It
   * must never take a tick down with an uncaught filesystem error.
   */
  backupError?: string;
}

/**
 * The daily step: `quick_check`, then `VACUUM INTO` a temp file in `backup/`,
 * chmod 0600, rename over `backup/fleet-<date>.db` (so a same-day re-run
 * REFRESHES rather than duplicating), keep the 7 newest by name.
 *
 * A failing `quick_check` sets the flag and returns WITHOUT backing up: copying
 * a database that has just declared itself corrupt over the recovery material is
 * the one thing this step must never do.
 */
export function dailyMaintenance(
  store: Store,
  opts: { fleetState: string; at?: number; force?: boolean },
): MaintenanceResult {
  const at = opts.at ?? store.now();
  const today = utcDate(at);
  if (opts.force !== true && store.meta("last_backup_date") === today) return { ran: false };

  const t0 = Date.now();
  const verdict = store.quickCheck();
  if (verdict !== "ok") {
    // Setting the flag is itself a write, and a file corrupt enough to fail
    // quick_check can reject it. That must not take the tick down with an
    // uncaught SQLite error: the VERDICT is what the caller acts on (it turns
    // this tick into rc 3), and the flag is the memory for the NEXT one.
    try {
      store.setIntegrityFailed(at);
    } catch (e) {
      log(`state store: quick_check FAILED and the integrity flag could not be written (${e instanceof Error ? e.message : String(e)})`);
    }
    log(`state store: quick_check FAILED (${verdict}) — integrity flag set; no backup taken this run`);
    return { ran: true, quickCheck: verdict, integrityFailed: verdict, ms: Date.now() - t0 };
  }

  const dir = backupDir(opts.fleetState);
  const target = `${dir}/fleet-${today}.db`;
  const tmp = `${dir}/.fleet-${today}.${process.pid}.tmp`;
  let pruned: string[];
  try {
    mkdirSync(dir, { recursive: true });
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    // VACUUM INTO writes a fresh, defragmented copy without holding a write
    // transaction open on the live file, so readers keep working throughout.
    store.db.run(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    chmodSync(tmp, 0o600);
    renameSync(tmp, target);
    pruned = pruneBackups(dir);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    log(`state store: backup FAILED (${msg}) — quick_check was ok; the store itself is unaffected`);
    return { ran: true, quickCheck: verdict, backupError: msg, ms: Date.now() - t0 };
  }
  store.setMeta("last_backup_date", today);
  const ms = Date.now() - t0;
  log(
    `state store: backup ${target} (quick_check ok, ${ms}ms)` +
      (pruned.length > 0 ? ` — pruned ${pruned.length} old backup(s)` : ""),
  );
  return { ran: true, quickCheck: verdict, file: target, pruned, ms };
}

/** Keep the BACKUP_KEEP newest by NAME (the names are ISO dates, so name order
 *  is date order); returns the files removed. */
export function pruneBackups(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => /^fleet-\d{4}-\d{2}-\d{2}\.db$/.test(f));
  } catch {
    return [];
  }
  names.sort();
  const doomed = names.slice(0, Math.max(0, names.length - BACKUP_KEEP));
  const gone: string[] = [];
  for (const f of doomed) {
    try {
      rmSync(`${dir}/${f}`, { force: true });
      gone.push(f);
    } catch {
      /* best-effort */
    }
  }
  return gone;
}

export interface RestoreResult {
  rc: 0 | 1 | 3;
  message: string;
}

/**
 * `grokfleet state restore <file>` — copy a backup over `fleet.db`, dropping the
 * stale `-wal`/`-shm` sidecars (they describe the file being replaced, not the
 * replacement), then reopen, `quick_check`, and clear the flag on `ok`.
 *
 * The caller is responsible for the operator precondition (the timer stopped)
 * and for reopening the store afterwards.
 */
export function restoreFile(opts: { fleetState: string; from: string; dbPath: string }): RestoreResult {
  if (!existsSync(opts.from)) {
    return { rc: 3, message: `state restore: ${opts.from} does not exist` };
  }
  try {
    copyFileSync(opts.from, opts.dbPath);
    chmodSync(opts.dbPath, 0o600);
    for (const s of [`${opts.dbPath}-wal`, `${opts.dbPath}-shm`]) rmSync(s, { force: true });
  } catch (e) {
    return { rc: 1, message: `state restore: could not copy ${opts.from} over ${opts.dbPath} — ${e instanceof Error ? e.message : String(e)}` };
  }
  return { rc: 0, message: `state restore: ${opts.from} -> ${opts.dbPath} (stale -wal/-shm removed)` };
}
