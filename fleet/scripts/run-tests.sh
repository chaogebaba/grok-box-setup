#!/bin/bash
# run-tests.sh — the bun suite, ONE FILE PER PROCESS.
#
# HISTORY (issue #16), root-caused: a plain single-process `bun test` used to
# die SILENTLY part-way through the suite (no `(fail)` line, no error, just a
# non-zero rc after N files) on every environment except the laptop it was
# developed on. The real cause was `installCrashBarrier`'s fallback timer in
# `src/tui/main.ts` (`setTimeout(() => process.exit(1), 200).unref()`):
# `test/tui/main.test.ts`'s crash-barrier test fired that handler on the REAL
# process, stubbed `process.exit` only for its own body, and restored the real
# `process.exit` in its `finally` — but never cancelled the 200ms fallback
# timer the handler had already armed. ~200ms later, wherever the run happened
# to be, that timer called the real `process.exit(1)` on the whole bun test
# process: rc 1, zero output (the timer prints nothing), and "cumulative"/
# "environment-dependent" because the death always landed ~200ms of wall time
# after that one test, which is a different file on every machine (file 54 on
# grok-box-010, `visual.test.ts` on CI, file 56 or 89 depending on box).
# Fixed at the source (`src/tui/main.ts`): the barrier's exit function is now
# injectable, and `detach()` clears the armed fallback timer, so the crash-
# barrier test can drive `onFatal` without arming a real process exit. Plain
# single-process `bun test` is green as of that fix.
#
# This script (one bun process per test file) is KEPT ANYWAY, not because the
# above bug needs it: it is strictly better crash-isolation diagnostics for
# anything else that calls `process.exit` from inside a test (a `--isolate`
# single-process run was tried during r1 of this issue and lost that property —
# a hard exit in one file truncates the whole run and drops every later file's
# result, uncredited as a crash). A crash in one file here still cannot take
# the rest of the suite down with it, and the report below is always complete.
# Cost is ~99 bun startups (~40s) versus ~20s for a single `bun test` process.
#
# Usage: bash fleet/scripts/run-tests.sh [extra bun test args...]
# Exit 0 = every file passed; 1 = at least one file failed or crashed.
set -u

cd "$(dirname "$0")/.." || exit 1

total_pass=0
total_fail=0
crashed=""
failed=""

while IFS= read -r f; do
  out="$(bun test "$f" "$@" 2>&1)"
  rc=$?
  line="$(printf '%s\n' "$out" | grep -E '^ *[0-9]+ (pass|fail)')"
  p="$(printf '%s\n' "$line" | sed -n 's/^ *\([0-9]*\) pass/\1/p')"
  fl="$(printf '%s\n' "$line" | sed -n 's/^ *\([0-9]*\) fail/\1/p')"
  total_pass=$((total_pass + ${p:-0}))
  total_fail=$((total_fail + ${fl:-0}))

  if [ "${fl:-0}" != 0 ]; then
    failed="$failed $f"
    printf '%s\n' "$out" | grep -E '^\(fail\)' | sed 's/^/    /'
    echo "FAIL: $f"
  elif [ "$rc" != 0 ] || [ -z "$p" ]; then
    # No summary line, or a non-zero rc with no counted failure: the file did
    # not finish. Never let that read as a pass.
    crashed="$crashed $f"
    echo "CRASH: $f (rc $rc, no test failure reported)"
    printf '%s\n' "$out" | tail -5 | sed 's/^/    /'
  fi
done < <(find test -name '*.test.ts' | sort)

echo
echo "run-tests: $total_pass pass, $total_fail fail"
[ -n "$failed" ]  && echo "run-tests: FAILED FILES:$failed"
[ -n "$crashed" ] && echo "run-tests: CRASHED FILES:$crashed"
if [ -n "$failed" ] || [ -n "$crashed" ]; then exit 1; fi
exit 0
