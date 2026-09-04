#!/bin/bash
# run-tests.sh — the bun suite, ONE FILE PER PROCESS.
#
# Why not plain `bun test`: a single-process run of this suite dies SILENTLY
# part-way through on every machine except the laptop it was developed on. It
# prints no `(fail)` line and no error — the process simply stops after N files
# and exits non-zero. Observed on grok-box-010 (rc 1 after 54 of 99 files, at
# test/store/rename.test.ts) and on ubuntu-latest in GitHub Actions (rc 2, at
# test/tui/visual.test.ts). It reproduces identically on `main` at the commit
# before this script existed, so it is not caused by any change here. It is
# cumulative (the files that die pass when run as a pair) and deterministic per
# environment, which points at a resource the runner does not release between
# files rather than at a test.
#
# The laptop that completes the suite in one process runs bun 1.4.1-canary.1;
# the machines that do not run bun 1.4.1 release. That is the likeliest
# difference, but it has not been confirmed upstream.
#
# Running each file in its own process sidesteps it AND is strictly better
# diagnostics: a crash in one file no longer takes the remaining 45 with it, so
# the report below is always complete. Cost is ~99 bun startups (~40 s).
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
