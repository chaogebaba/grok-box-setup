#!/bin/bash
# test-iter3-fixes.sh — local, box-free coverage for the iter3 fixes (#7, #9).
#
# These are the two claims the brief called out as cheaply testable off-box:
#   #7  the tailscaled daemon child does NOT inherit converge-lock fd 8
#   #9  the --force-reauth argv MENTIONS --hostname (and tags iff present)
#
# No real tailscale/box needed. Run from anywhere:
#   bash probes/test-iter3-fixes.sh
# Exit 0 = all pass, 1 = a failure.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
BOXUP="$HERE/../boxup"
fail=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; fail=1; }

[ -f "$BOXUP" ] || { echo "cannot find boxup at $BOXUP"; exit 1; }

# ---------------------------------------------------------------------------
# #7a — STATIC: spawn_detached (the single chokepoint) closes BOTH fd 8 and
# fd 9. Guards against a regression back to a fd-9-only close. The literal
# closes now live in the helper, not each call site (P0-A).
# ---------------------------------------------------------------------------
if awk '/^spawn_detached\(\) \{/{i=1} i{print} i&&/^\}$/{exit}' "$BOXUP" | grep -Eq '8>&-[[:space:]]+9>&-'; then
  pass "#7 spawn_detached closes both fd 8 and fd 9"
else
  bad  "#7 spawn_detached does NOT close both fd 8 and fd 9 (regression?)"
fi

# ---------------------------------------------------------------------------
# #7b — FUNCTIONAL: replicate boxup's exact fork pattern and prove a child
# spawned with `8>&- 9>&-` does not inherit fd 8. We open fd 8 -> a lock file
# (as run_with_converge_lock does), then spawn a child the same way boxup
# spawns tailscaled and inspect the child's /proc/PID/fd.
# ---------------------------------------------------------------------------
fdtest() {
  local lock child_pid inherited
  lock="$(mktemp)"
  # Parent holds fd 8 on the lock (mimics being under the converge lock).
  exec 8>"$lock"
  # Spawn a long-ish child exactly like the daemon: setsid + fd closes.
  # `sleep` stands in for tailscaled; we only care about its inherited fds.
  if command -v setsid >/dev/null 2>&1; then
    setsid -f env - sh -c 'sleep 3' 8>&- 9>&- &
  else
    env - sh -c 'sleep 3' 8>&- 9>&- &
  fi
  child_pid=$!
  # setsid -f reparents; find the actual sleep child if needed.
  sleep 0.3
  # Look for any sleeper whose fd set we can read; check none reference $lock.
  inherited=no
  local p link
  for p in $(pgrep -x sleep 2>/dev/null || true); do
    for link in "/proc/$p/fd/"*; do
      [ -e "$link" ] || continue
      if [ "$(readlink -f "$link" 2>/dev/null || true)" = "$(readlink -f "$lock")" ]; then
        inherited=yes
      fi
    done
  done
  exec 8>&-
  kill "$child_pid" 2>/dev/null || true
  pkill -x sleep 2>/dev/null || true
  rm -f "$lock"
  [ "$inherited" = no ]
}
if fdtest; then
  pass "#7 child spawned with 8>&- 9>&- does not inherit the lock fd"
else
  bad  "#7 child INHERITED the lock fd despite 8>&- 9>&-"
fi

# ---------------------------------------------------------------------------
# #7/P0-A — FUNCTIONAL: the REAL spawn_detached helper must not leak fd 8 to
# any child (this is the single chokepoint all four long-lived spawns —
# tailscaled, sshd x2, worker — now route through). We hold fd 8 on a lock,
# spawn a sleeper via the actual boxup spawn_detached, and assert fd 8 is
# absent from that child's /proc/PID/fd. Covers the sshd case the brief called
# out: sshd goes through the same helper, so proving the helper is clean proves
# every routed spawn is clean.
spawn_detached_test() {
  local inner
  inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
extract_fn(){ awk -v fn="\$1" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$BOXUP"; }
eval "\$(extract_fn spawn_detached)"
LOCK="\$(mktemp)"
exec 8>"\$LOCK"                # parent holds fd 8 (mimics under converge lock)
marker="\$(mktemp)"
# Launch a sleeper via the REAL helper; it should close fd 8/9 on the child.
spawn_detached "" sh -c "echo \\\$\\\$ > '\$marker'; exec sleep 5"
sleep 0.4
child="\$(cat "\$marker" 2>/dev/null)"
leaked=no
if [ -n "\$child" ] && [ -d "/proc/\$child" ]; then
  for l in "/proc/\$child/fd/"*; do
    [ -e "\$l" ] || continue
    if [ "\$(readlink -f "\$l" 2>/dev/null)" = "\$(readlink -f "\$LOCK")" ]; then leaked=yes; fi
  done
else
  leaked=unknown
fi
exec 8>&-
[ -n "\$child" ] && kill "\$child" 2>/dev/null
rm -f "\$LOCK" "\$marker"
echo "\$leaked"
INNER
  timeout 20 bash "$inner"
  rm -f "$inner"
}
sd_leak="$(spawn_detached_test)"
if [ "$sd_leak" = no ]; then
  pass "#7 spawn_detached (tailscaled/sshd/worker chokepoint) does not leak fd 8"
else
  bad  "#7 spawn_detached leaked fd 8 to its child (result=[$sd_leak])"
fi

# ---------------------------------------------------------------------------
# #9 — FUNCTIONAL: exercise the real run_reauth_up with stubs, capture argv.
# We eval only the function definitions we need (never source boxup — its
# top-level dispatch would try to run/require-root). Stubs replace tailscale
# so the argv is captured instead of executed.
# ---------------------------------------------------------------------------
extract_fn() {
  # Print a shell function definition `name() { ... }` from the boxup source,
  # from the `name() {` line to its matching closing `}` at column 0.
  awk -v fn="$1" '
    $0 ~ "^"fn"\\(\\) \\{" {inside=1}
    inside {print}
    inside && /^\}$/ {exit}
  ' "$BOXUP"
}

reauth_argv_test() {
  local have_tags="$1" capture
  capture="$(mktemp)"
  (
    set -u
    # --- capture harness: a fake `tailscale` that records its argv ---------
    cap_bin="$(mktemp)"
    cat > "$cap_bin" <<CAP
#!/bin/sh
# record every arg, one per line, to the capture file
for a in "\$@"; do printf '%s\n' "\$a"; done > "$capture"
exit 0
CAP
    chmod +x "$cap_bin"
    # --- stubs -------------------------------------------------------------
    log() { :; }                          # silence
    tailscale_bin() { echo "$cap_bin"; }  # run_reauth_up execs this as `up`
    prefs_hostname() { echo "grok-box-8"; }
    read_box_name() { echo "grok-box-8"; }
    if [ "$have_tags" = yes ]; then
      current_advertise_tags() { echo "tag:grok-box"; }
    else
      current_advertise_tags() { echo ""; }
    fi
    id() { return 1; }                    # skip --operator=box for a clean argv
    eval "$(extract_fn run_reauth_up)"
    run_reauth_up "test reason" >/dev/null 2>&1
    rm -f "$cap_bin"
  )
  # The captured argv is the newline-joined arg list; flatten to one line.
  tr '\n' ' ' < "$capture"
  rm -f "$capture"
}

# extract_fn must be visible inside the subshell above.
export -f extract_fn 2>/dev/null || true

argv_with_tags="$(reauth_argv_test yes)"
argv_no_tags="$(reauth_argv_test no)"

case "$argv_with_tags" in
  *--force-reauth*) pass "#9 re-auth argv contains --force-reauth" ;;
  *) bad "#9 re-auth argv MISSING --force-reauth: [$argv_with_tags]" ;;
esac
case "$argv_with_tags" in
  *--hostname=grok-box-8*) pass "#9 re-auth argv contains --hostname=<current>" ;;
  *) bad "#9 re-auth argv MISSING --hostname: [$argv_with_tags]" ;;
esac
case "$argv_with_tags" in
  *--advertise-tags=tag:grok-box*) pass "#9 re-auth mentions existing tags" ;;
  *) bad "#9 re-auth did NOT mention existing device tags: [$argv_with_tags]" ;;
esac
case "$argv_no_tags" in
  *--advertise-tags*) bad "#9 re-auth INTRODUCED tags when device had none: [$argv_no_tags]" ;;
  *) pass "#9 re-auth omits --advertise-tags when device has no tags" ;;
esac
case "$argv_no_tags" in
  *--reset*) bad "#9 re-auth used --reset (forbidden)" ;;
  *) pass "#9 re-auth never uses --reset" ;;
esac

# ---------------------------------------------------------------------------
# #7c — FUNCTIONAL: the converge-lock stale-break self-heal.
#   (i)  a NON-boxup flock holder is broken after exactly 5 consecutive skips
#   (ii) a boxup (bash) flock holder is NEVER broken
# We eval the real converge-lock functions (never source boxup) and drive
# run_with_converge_lock against a controlled flock holder. Bounded so it can
# never hang CI.
# ---------------------------------------------------------------------------
converge_selfheal_test() {
  local kind="$1"   # nonboxup | boxup
  local inner
  inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
kind="$kind"
RUN_DIR="\$(mktemp -d)"
CONVERGE_LOCK="\$RUN_DIR/converge.lock"
CONVERGE_SKIP_COUNT="\$RUN_DIR/converge-skip.count"
CONVERGE_STALE_BREAK_AFTER=5
CONVERGE_UNRESOLVED_LOG="\$RUN_DIR/last-unresolved-holder.log"
log(){ :; }
have(){ command -v "\$1" >/dev/null 2>&1; }
extract_fn(){ awk -v fn="\$1" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$BOXUP"; }
for f in converge_skip_count_read converge_skip_count_reset converge_lock_holders converge_lock_held_by_boxup converge_lock_holder_unresolved converge_log_unresolved_once run_with_converge_lock; do
  eval "\$(extract_fn "\$f")"
done
touch "\$CONVERGE_LOCK"
ran=0; tick(){ ran=\$((ran+1)); }
if [ "\$kind" = nonboxup ]; then
  flock "\$CONVERGE_LOCK" sleep 60 & h=\$!
else
  bash -c 'exec 8>"'"\$CONVERGE_LOCK"'"; flock -n 8 || exit 7; sleep 60' & h=\$!
fi
sleep 0.7
broke_at=0
for i in 1 2 3 4 5 6; do
  run_with_converge_lock try tick; rc=\$?
  if [ "\$rc" = 0 ] && [ "\$broke_at" = 0 ]; then broke_at=\$i; fi
done
kill "\$h" 2>/dev/null
rm -rf "\$RUN_DIR"
echo "\$broke_at"
INNER
  timeout 25 bash "$inner"
  rm -f "$inner"
}

broke_at="$(converge_selfheal_test nonboxup)"
if [ "$broke_at" = 5 ]; then
  pass "#7 converge lock: non-boxup holder broken on the 5th consecutive skip"
else
  bad "#7 converge lock: non-boxup holder broke at attempt=[$broke_at] (want 5)"
fi

broke_at="$(converge_selfheal_test boxup)"
if [ "$broke_at" = 0 ]; then
  pass "#7 converge lock: genuine boxup holder is NEVER broken"
else
  bad "#7 converge lock: boxup holder was broken at attempt=[$broke_at] (must never)"
fi

echo "-----"
if [ "$fail" = 0 ]; then echo "ALL TESTS PASSED"; else echo "SOME TESTS FAILED"; fi
exit "$fail"
