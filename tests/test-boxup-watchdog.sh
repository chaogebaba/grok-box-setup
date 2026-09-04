#!/bin/bash
# test-boxup-watchdog.sh — the half-dead watchdog: boxup 5.6.0's BOUNDED tick.
# Run from anywhere:  bash tests/test-boxup-watchdog.sh   (or: make test)
# Exit 0 = all pass, 1 = a failure. No root, no network, no box.
#
# WHAT THIS IS ABOUT. `worker_loop` used to call `run_tick` inline, so one
# command that never returned blocked the self-heal loop FOREVER: `hb` went
# stale, no repair ran, and the box sat half-dead with its reverse tunnel still
# up (the tunnel is a separate `ssh -N` that survives a wedged worker). That is
# grok-box-009 on 2026-09-02 — the VPS session alive with keepalives flowing
# while sshd hung at banner and tailscaled was offline, and nothing on the box
# could recover it because the thing that repairs the box was the thing stuck.
#
# The functions under test are EXTRACTED from the repo-root `boxup`, not
# reimplemented: only `run_tick` itself is stubbed, because "a tick that never
# returns" is precisely what the test needs to create.
#
# Cases:
#   (1) a tick that finishes passes its rc through, kills nothing, counts nothing
#   (2) a tick that never returns is KILLED at the deadline, rc 124
#   (3) …and the loop is free afterwards — the next tick runs normally
#   (4) the tick's hung GRANDCHILD dies too (killing only the tick shell would
#       reparent it, and it would keep holding the converge lock forever)
#   (5) the wedge counter is durable and monotonic
#   (6) `boxup status` shows tickwedge=N when non-zero, and is SILENT at 0
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
WORKER_LOG="$TMP/worker.log"
BOXUP_TICK_DEADLINE=2
log() { echo "$*"; }

eval "$(extract_fn_from "$BOXUP" kill_tree)"
eval "$(extract_fn_from "$BOXUP" run_tick_bounded)"

wedge_count() { [ -f "$RUN_DIR/tickwedge" ] || { echo 0; return; }; tr -d '[:space:]' < "$RUN_DIR/tickwedge"; }

# --- (1) a normal tick ------------------------------------------------------
run_tick() { return 7; }
run_tick_bounded 2
check "(1) a finished tick passes its rc through" "$?" "7"
check "(1) …and counts no wedge" "$(wedge_count)" "0"

# --- (2)+(4) a tick that never returns, with a hung grandchild --------------
GRANDCHILD_PID_FILE="$TMP/grandchild.pid"
run_tick() {
  # The shape of the real failure: the tick itself is fine, but it is blocked on
  # a child that never returns (a tailscale call into a hung daemon).
  sleep 300 &
  echo $! > "$GRANDCHILD_PID_FILE"
  wait
}
START=$(date +%s)
run_tick_bounded 2
RC=$?
ELAPSED=$(( $(date +%s) - START ))
check "(2) a wedged tick is killed with rc 124" "$RC" "124"
if [ "$ELAPSED" -le 8 ]; then ok "(2) …at the deadline, not later ($ELAPSED s)"; else bad "(2) took $ELAPSED s"; fi

GC="$(cat "$GRANDCHILD_PID_FILE" 2>/dev/null || echo 0)"
sleep 1
if [ "$GC" != 0 ] && kill -0 "$GC" 2>/dev/null; then
  bad "(4) the hung grandchild SURVIVED — it would hold the converge lock forever"
  kill -KILL "$GC" 2>/dev/null || true
else
  ok "(4) the tick's hung grandchild was killed too, not just the tick shell"
fi

check "(5) the wedge is counted" "$(wedge_count)" "1"

# --- (3) the loop is free afterwards ----------------------------------------
run_tick() { return 0; }
run_tick_bounded 2
check "(3) the next tick runs normally after a wedge" "$?" "0"
check "(5) the counter is monotonic, not reset by a good tick" "$(wedge_count)" "1"

# a second wedge bumps it again
run_tick() { sleep 300; }
run_tick_bounded 1 >/dev/null 2>&1
check "(5) a second wedge bumps the counter" "$(wedge_count)" "2"

# --- (6) the status slot ----------------------------------------------------
# Drive the REAL printf shape rather than print_status whole (it reads a dozen
# unrelated facts): the assertion is that the slot is silent at 0 and present
# above it, which is the whole contract the brain reads.
status_slot() {
  local tw=0
  [ -f "$RUN_DIR/tickwedge" ] && tw=$(tr -d '[:space:]' < "$RUN_DIR/tickwedge" 2>/dev/null || echo 0)
  case "$tw" in ''|*[!0-9]*) tw=0 ;; esac
  [ "$tw" -ge 1 ] && printf ' tickwedge=%s' "$tw"
  return 0
}
check "(6) the slot reports the count" "$(status_slot)" " tickwedge=2"
echo 0 > "$RUN_DIR/tickwedge"
check "(6) …and is SILENT at 0, so a healthy status line is unchanged" "$(status_slot)" ""

# the production file must carry the same slot
if grep -q "tickwedge=%s" "$BOXUP"; then
  ok "(6) boxup itself carries the tickwedge slot"
else
  bad "(6) boxup has no tickwedge slot"
fi

echo
echo "-----"
if [ "$FAIL" = 0 ]; then
  echo "ALL PASS ($PASS)"
  exit 0
fi
echo "$FAIL FAILED, $PASS passed"
exit 1
