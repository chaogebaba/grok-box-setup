#!/bin/bash
# test-boxup-recycle-quiet.sh — boxup 5.6.3 R6: the post-recycle NoState/
# Starting window is not a fault.
# Run from anywhere:  bash tests/test-boxup-recycle-quiet.sh   (or: make test)
# Exit 0 = all pass, 1 = a failure. No root, no network, no box.
#
# WHAT THIS IS ABOUT (audit report log-audit-r3/report-boxes.md, R6). After
# boxup itself recycles tailscaled (selfheal's recycle_tailscaled, which
# stamps $RUN_DIR/last-recycle and honors RECYCLE_COOLDOWN=120s), the daemon
# spends the next 2-3 ticks at backend=NoState/Starting before it reaches
# Running — that is normal restart latency, not a fault. Before this fix every
# one of those ticks logged "tick: unhealthy (reason=backend=NoState ...)" and
# the THIRD tick ran a full do_ensure_body and incremented fail.repair, arming
# the 60s backoff right when a REAL fault might land next.
#
# The function under test, tick_handle_reason, is EXTRACTED from the
# repo-root `boxup` (same technique as test-boxup-watchdog.sh's
# run_tick_bounded): only its dependencies (log, do_ensure_body,
# repair_fail_count, refresh_backoff_window) are stubbed. recycled_recently
# is ALSO extracted for real, so the window arithmetic under test is the
# production arithmetic, not a re-implementation of it.
#
# Cases (brief boxup-5.6.3, R6 test list):
#   (d) NoState inside the recycle window: logs ONE "...waiting" line (a
#       second tick logs nothing more), does not call do_ensure_body, does not
#       touch fail.repair                                    [mutants M3, M5]
#   (e) NoState AFTER the window (recycled_recently false): the existing
#       unhealthy path fires unchanged — do_ensure_body runs, fail.repair is
#       evaluated                                                  [mutant M3]
#   (f) a reason OTHER than backend=NoState/Starting (here: online=no) inside
#       the same recycle window is NOT suppressed — normal path fires
#                                                                    [mutant M4]
set -u

BOXUP="$(cd "$(dirname "$0")/.." && pwd)/boxup"
[ -f "$BOXUP" ] || { echo "no boxup at $BOXUP" >&2; exit 1; }

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

extract_fn_from() {
  awk -v fn="$2" '$0 ~ "^"fn"\\(\\) \\{"{i=1} i{print} i&&/^\}$/{exit}' "$1"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- the environment the extracted functions read ---------------------------
RUN_DIR="$TMP/run"; mkdir -p "$RUN_DIR"
# shellcheck disable=SC2034  # read inside recycled_recently, extracted below
RECYCLE_COOLDOWN=120
LOGLINES="$TMP/log"; : > "$LOGLINES"
log() { printf '%s\n' "$*" >> "$LOGLINES"; }

# --- stubs for tick_handle_reason's dependencies ----------------------------
ENSURE_CALLS="$TMP/ensure-calls"; : > "$ENSURE_CALLS"
do_ensure_body() { echo call >> "$ENSURE_CALLS"; return 0; }

# The re-evaluation check_reason call inside the normal (non-suppressed)
# repair path — set by each scenario to whatever the predicate should read
# AFTER do_ensure_body "ran".
REASON_REEVAL=""
check_reason() { printf '%s' "$REASON_REEVAL"; }

repair_fail_count() {
  [ -f "$RUN_DIR/fail.repair" ] || { echo 0; return; }
  tr -d '[:space:]' < "$RUN_DIR/fail.repair"
}
# A fixed, tiny window so the backoff itself never blocks a repair in these
# tests — the thing under test is the R6 suppression, not the backoff ladder
# (that is refresh_backoff_window's own suite, unchanged here).
refresh_backoff_window() { echo 0; }
# The "healthy" branch of tick_handle_reason (empty reason) touches these —
# stub them so the sanity case below is quiet and asserts nothing about them.
read_box_name() { :; }
pgrep() { return 1; }
refresh_exitnode() { :; }

eval "$(extract_fn_from "$BOXUP" recycled_recently)"
eval "$(extract_fn_from "$BOXUP" tick_handle_reason)"

backdate() { echo $(( $(date +%s) - "$2" )) > "$1"; }
fail_repair() { [ -f "$RUN_DIR/fail.repair" ] && tr -d '[:space:]' < "$RUN_DIR/fail.repair" || echo NONE; }
ensure_calls() { wc -l < "$ENSURE_CALLS" | tr -d '[:space:]'; }
reset_env() {
  rm -f "$RUN_DIR"/* 2>/dev/null || true
  : > "$LOGLINES"
  : > "$ENSURE_CALLS"
}

# ===========================================================================
# (d) inside the window: NoState right after a recycle. First tick logs the
# single waiting line; a second tick (still inside the window) logs nothing
# more. do_ensure_body is never called, fail.repair is never written.
# ===========================================================================
reset_env
backdate "$RUN_DIR/last-recycle" 5   # 5s ago, well inside RECYCLE_COOLDOWN=120
tick_handle_reason "backend=NoState (want Running)"
tick_handle_reason "backend=NoState (want Running)"
if [ "$(printf '%s\n' "$(cat "$LOGLINES")" | grep -c 'tick: tailscaled starting after recycle')" = 1 ] \
   && [ -z "$(grep 'tick: unhealthy' "$LOGLINES" || true)" ] \
   && [ "$(ensure_calls)" = 0 ] \
   && [ "$(fail_repair)" = NONE ]; then
  ok "(d) NoState inside the recycle window: ONE waiting line, no do_ensure_body, fail.repair untouched  [mutants M3, M5]"
else
  bad "(d) window suppression wrong: log=[$(cat "$LOGLINES")] ensure_calls=$(ensure_calls) fail.repair=$(fail_repair)"
fi

# Starting behaves the same as NoState.
reset_env
backdate "$RUN_DIR/last-recycle" 5
tick_handle_reason "backend=Starting (want Running)"
if [ "$(printf '%s\n' "$(cat "$LOGLINES")" | grep -c 'tick: tailscaled starting after recycle')" = 1 ] \
   && [ "$(ensure_calls)" = 0 ] \
   && [ "$(fail_repair)" = NONE ]; then
  ok "(d2) Starting inside the recycle window is suppressed the same way as NoState"
else
  bad "(d2) Starting inside the window wrong: log=[$(cat "$LOGLINES")]"
fi

# ===========================================================================
# (e) after the window: recycled_recently is false (last-recycle older than
# RECYCLE_COOLDOWN), so a persistent NoState is a REAL fault — the existing
# unhealthy path fires unchanged: do_ensure_body runs, and since the
# predicate is still failing on re-check, fail.repair is incremented.
# A mutant that suppresses on reason alone (M3: ignores recycled_recently)
# would wrongly stay silent and skip do_ensure_body here.
# ===========================================================================
reset_env
backdate "$RUN_DIR/last-recycle" 300   # 300s ago > RECYCLE_COOLDOWN=120
REASON_REEVAL="backend=NoState (want Running)"
tick_handle_reason "backend=NoState (want Running)"
if grep -q 'tick: unhealthy (reason=backend=NoState (want Running))' "$LOGLINES" \
   && [ "$(ensure_calls)" = 1 ] \
   && [ "$(fail_repair)" = 1 ]; then
  ok "(e) NoState after the recycle window: unhealthy path fires unchanged, do_ensure_body runs, fail.repair=1  [mutant M3]"
else
  bad "(e) post-window path wrong: log=[$(cat "$LOGLINES")] ensure_calls=$(ensure_calls) fail.repair=$(fail_repair)"
fi

# ===========================================================================
# (f) inside the window, but the reason is NOT backend=NoState/Starting (here
# online=no). Must NOT be suppressed — the normal unhealthy path runs, exactly
# as it would with no recycle in play. [mutant M4: suppression also swallows
# online=no]
# ===========================================================================
reset_env
backdate "$RUN_DIR/last-recycle" 5   # inside the window
REASON_REEVAL=""                     # the repair "fixes" it
tick_handle_reason "online=no (want yes)"
if grep -q 'tick: unhealthy (reason=online=no (want yes))' "$LOGLINES" \
   && [ "$(ensure_calls)" = 1 ] \
   && [ "$(fail_repair)" = 0 ]; then
  ok "(f) online=no inside the recycle window is NOT suppressed — normal unhealthy path fires  [mutant M4]"
else
  bad "(f) online=no wrongly suppressed: log=[$(cat "$LOGLINES")] ensure_calls=$(ensure_calls) fail.repair=$(fail_repair)"
fi

# ===========================================================================
# sanity: a healthy tick (empty reason) is untouched by any of this — resets
# fail.repair and does not go near the recycle-wait path.
# ===========================================================================
reset_env
echo 3 > "$RUN_DIR/fail.repair"
tick_handle_reason ""
if [ "$(fail_repair)" = 0 ] && [ -z "$(cat "$LOGLINES")" ] && [ "$(ensure_calls)" = 0 ]; then
  ok "(sanity) a healthy tick (empty reason) resets fail.repair to 0 and logs nothing"
else
  bad "(sanity) healthy tick wrong: fail.repair=$(fail_repair) log=[$(cat "$LOGLINES")]"
fi

echo
echo "-----"
if [ "$FAIL" = 0 ]; then
  echo "ALL PASS ($PASS)"
  exit 0
fi
echo "$FAIL FAILED, $PASS passed"
exit 1
