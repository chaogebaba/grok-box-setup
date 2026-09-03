// journal.ts — `GET /v1/boxes/:name/journal` backend (§3, admin scope, B6).
//
// Reads the last 4000 lines of BOTH units, then filters to lines mentioning the
// box name by a WORD-BOUNDARY regex (so `grok-box-1` never matches
// `grok-box-12`), then returns the last N (default 50, max 500 — may be fewer
// for a quiet box). journalctl absent ⇒ 200 {rc:1, log:["journalctl
// unavailable"]} (never a 500). The filter runs BEFORE the truncate-to-N so N
// counts MATCHING lines, not raw lines (mutant: filter-before-truncate).

import type { Runner } from "../runner.ts";

const JOURNAL_TIMEOUT_MS = 20_000;
const JOURNAL_FETCH_LINES = 4000; // R2-A6
export const JOURNAL_DEFAULT_N = 50;
export const JOURNAL_MAX_N = 500;

/**
 * The journalctl argv (R2-A6): both units, short-iso, last 4000 lines.
 *
 * TWO `-u` pairs again. The 5.10.0 release carried four, because journalctl
 * matches the unit a line was LOGGED under — `_SYSTEMD_UNIT` — so history
 * written before the rename was only reachable under the pre-rename names. That
 * was the one-release compatibility window (N2) and 5.11.0 closes it: those
 * lines are now months old and outside the 4000-line fetch anyway. An operator
 * who wants them runs `journalctl -u fleet-reconcile` by hand.
 */
export function journalArgv(): string[] {
  return [
    "journalctl",
    "-u",
    "grokfleet-reconcile.service",
    "-u",
    "grokfleet-api.service",
    "-o",
    "short-iso",
    "-n",
    String(JOURNAL_FETCH_LINES),
  ];
}

/** Escape a box name for a literal regex match. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary filter: a line matches iff the box name appears delimited so a
 * numeric-suffix superstring never matches (grok-box-1 ∌ grok-box-12). We treat
 * a trailing digit as extending the token, so require the char AFTER the name
 * to not be a digit (and the char before to not be a name char).
 */
export function boxLineFilter(box: string): (line: string) => boolean {
  // (?<![A-Za-z0-9-]) name (?![0-9]) — no name-char before, no digit after.
  const re = new RegExp(`(?<![A-Za-z0-9-])${escapeRe(box)}(?![0-9])`);
  return (line) => re.test(line);
}

/** Clamp the requested N into [1, JOURNAL_MAX_N], default when absent/invalid. */
export function clampLines(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n < 1) return JOURNAL_DEFAULT_N;
  return Math.min(Math.floor(n), JOURNAL_MAX_N);
}

export interface JournalResult {
  rc: number;
  log: string[];
}

/**
 * Fetch + filter + tail. `which` resolves journalctl (absent ⇒ rc 1 stub). The
 * FILTER runs before the tail-to-N so N counts matching lines.
 */
export async function readJournal(
  box: string,
  linesN: number | undefined,
  deps: { runner: Runner; which?: (bin: string) => boolean },
): Promise<JournalResult> {
  const which = deps.which ?? ((bin: string) => Bun.which(bin) !== null);
  if (!which("journalctl")) {
    return { rc: 1, log: ["journalctl unavailable"] };
  }
  const n = clampLines(linesN);
  const r = await deps.runner.run(journalArgv(), { timeoutMs: JOURNAL_TIMEOUT_MS });
  const matches = r.stdout.split("\n").filter((l) => l !== "").filter(boxLineFilter(box));
  const tail = matches.slice(Math.max(0, matches.length - n));
  return { rc: r.code ?? 1, log: tail };
}
