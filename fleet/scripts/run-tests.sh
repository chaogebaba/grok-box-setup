#!/bin/bash
# run-tests.sh — the bun suite, single process, with per-file global isolation.
#
# HISTORY (issue #16): a plain single-process `bun test` used to die SILENTLY
# part-way through on every machine except the laptop it was developed on —
# no `(fail)` line, no error, just a non-zero rc after N of the suite's files.
# Observed on grok-box-010 (rc 1 after 54 of 99 files, at test/store/rename.test.ts)
# and on ubuntu-latest CI (rc 2, at test/tui/visual.test.ts). Root-caused
# 2026-09-08 (report: /data/claude-scratch/grok-box-setup/issue-16/report.md):
# bisection showed the death point tracks the TOTAL number of files bun has
# matched (all ~107), not just the ones already executed — a plain 55-file
# explicit list runs clean 3/3 while the full ~107-file glob dies at file
# 55-56 3/3, with no fd, RSS, sqlite-handle, or dmesg/OOM signal anywhere near
# a limit (peak observed: ~150 fds, ~250MB RSS, 24 in-memory sqlite handles on
# an 8-core/15GB box). That is consistent with bun's own stated reason for
# shipping `--isolate` on `bun test`: "Leaked handles from one file cannot
# affect another." `--isolate` resets the global object per file, which
# eliminates the death outright (verified 3/3 clean runs) instead of merely
# working around it.
#
# So: one bun process, `--isolate` for per-file isolation. This is faster than
# one-process-per-file (no repeated bun startup) AND keeps the diagnostic value
# that motivated the original per-file split — a leak or crash in one file
# still cannot take any other file down with it.
#
# Usage: bash fleet/scripts/run-tests.sh [extra bun test args...]
# Exit code is bun's own: 0 = every file passed, non-zero otherwise.
set -eu

cd "$(dirname "$0")/.." || exit 1

exec bun test --isolate "$@"
