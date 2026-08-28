#!/bin/bash
# test-iter3-fixes.sh — local, box-free coverage for the iter3 HOTFIX
# (fix/iter3-hotfix). No real tailscale/box needed. Run from anywhere:
#   bash tests/test-iter3-fixes.sh   (or: make test)
# Exit 0 = all pass, 1 = a failure.
#
# What this covers (post-hotfix shape — the /proc/locks self-heal and the #8
# log-tail were DELETED, so their tests are gone too):
#   H1  converge lock is flock --close: the body + descendants do NOT hold the
#       lock fd, using boxup's REAL leak shape (exec-fd / flock / spawn / exit).
#   H9  spawn_detached is the ONLY long-lived spawn primitive (lint rule).
#   H6/#9 run_reauth_up mentions --hostname + already-held tags, never --reset,
#       and REFUSES (no up) when no hostname resolves.
#   H5  re-auth attempt-limiter: min-interval + per-hour cap, rc-independent.
#   H11 auth-key expiry classification (ok / warn / expired / none).
#   H10 .gitignore ignores auth-key patterns.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
BOXUP="$ROOT/boxup"
fail=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; fail=1; }

[ -f "$BOXUP" ] || { echo "cannot find boxup at $BOXUP"; exit 1; }

# extract_fn: print a `name() { ... }` definition from boxup (col-0 to col-0 }).
extract_fn() {
  awk -v fn="$1" '
    $0 ~ "^"fn"\\(\\) \\{" {inside=1}
    inside {print}
    inside && /^\}$/ {exit}
  ' "$BOXUP"
}

# ---------------------------------------------------------------------------
# H1 — FUNCTIONAL: converge lock uses flock --close semantics. Reproduce
# boxup's REAL leak shape (the one that defeated the /proc/locks detector):
# an outer subshell opens the lock on fd 9, flocks it, spawns a DETACHED child,
# then the body exits — assert the child does NOT hold the lock fd. This is the
# structural guarantee that replaced the deleted stale-holder machinery.
# ---------------------------------------------------------------------------
flock_close_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
have(){ command -v "\$1" >/dev/null 2>&1; }
log(){ :; }
$(: 'pull in the real lock + spawn helpers')
extract_fn(){ awk -v fn="\$1" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$BOXUP"; }
eval "\$(extract_fn spawn_detached)"
eval "\$(extract_fn run_with_converge_lock)"
RUN_DIR="\$(mktemp -d)"
CONVERGE_LOCK="\$RUN_DIR/converge.lock"
marker="\$(mktemp)"
# The body spawns a detached child through the real spawn_detached, exactly as
# start_tailscaled does under the converge lock.
body(){ spawn_detached "" sh -c "echo \\\$\\\$ > '\$marker'; exec sleep 5"; }
run_with_converge_lock wait body
sleep 0.4
child="\$(cat "\$marker" 2>/dev/null)"
lockrl="\$(readlink -f "\$CONVERGE_LOCK")"
leaked=no
if [ -n "\$child" ] && [ -d "/proc/\$child" ]; then
  for l in "/proc/\$child/fd/"*; do
    [ -e "\$l" ] || continue
    [ "\$(readlink -f "\$l" 2>/dev/null)" = "\$lockrl" ] && leaked=yes
  done
else
  leaked=unknown
fi
[ -n "\$child" ] && kill "\$child" 2>/dev/null
rm -rf "\$RUN_DIR" "\$marker"
echo "\$leaked"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"
}
res="$(flock_close_test)"
if [ "$res" = no ]; then
  pass "H1 flock --close: detached child under the converge lock does NOT hold the lock fd"
else
  bad  "H1 flock --close: child leaked the lock fd (result=[$res])"
fi

# ---------------------------------------------------------------------------
# H9 — LINT: setsid/nohup/disown must appear ONLY inside spawn_detached. Any
# other occurrence (outside comments) re-introduces the #7 spawn-leak risk.
# ---------------------------------------------------------------------------
h9_lint() {
  # Strip full-line comments, then find spawn primitives. Allow them only on
  # lines within the spawn_detached function body.
  local sd_start sd_end ln n=0 offenders=0
  sd_start="$(grep -n '^spawn_detached() {' "$BOXUP" | head -1 | cut -d: -f1)"
  [ -n "$sd_start" ] || { echo "no spawn_detached"; return 1; }
  # end = first line "^}" at/after sd_start
  sd_end="$(awk -v s="$sd_start" 'NR>=s && /^\}$/ {print NR; exit}' "$BOXUP")"
  while IFS= read -r ln; do
    n="${ln%%:*}"
    local text="${ln#*:}"
    case "${text#"${text%%[![:space:]]*}"}" in \#*) continue ;; esac  # skip comment lines
    if [ "$n" -ge "$sd_start" ] && [ "$n" -le "$sd_end" ]; then
      continue   # inside spawn_detached — allowed
    fi
    offenders=$((offenders+1))
    echo "  offender line $n: $text" >&2
  done < <(grep -nE '\b(setsid|nohup|disown)\b' "$BOXUP")
  return "$offenders"
}
if h9_lint; then
  pass "H9 spawn primitives (setsid/nohup/disown) appear only inside spawn_detached"
else
  bad  "H9 a spawn primitive appears OUTSIDE spawn_detached (see offenders above)"
fi

# ---------------------------------------------------------------------------
# H6 / #9 — run_reauth_up argv, via stubs (never source boxup's dispatch).
# ---------------------------------------------------------------------------
reauth_argv_test() {
  # $1: have_tags yes|no ; $2: hostname resolvable yes|no
  local have_tags="$1" have_host="$2" capture
  capture="$(mktemp)"
  (
    set -u
    cap_bin="$(mktemp)"
    cat > "$cap_bin" <<CAP
#!/bin/sh
for a in "\$@"; do printf '%s\n' "\$a"; done > "$capture"
exit 0
CAP
    chmod +x "$cap_bin"
    log() { :; }
    ts() { :; }                            # status --json fallback -> empty
    # shellcheck disable=SC2034  # consumed by the eval'd run_reauth_up
    HOSTNAME_FILE="/nonexistent/hostname"
    tailscale_bin() { echo "$cap_bin"; }
    if [ "$have_host" = yes ]; then
      prefs_hostname() { echo "grok-box-8"; }
      read_box_name() { echo "grok-box-8"; }
    else
      prefs_hostname() { echo ""; }
      read_box_name() { echo ""; }
    fi
    if [ "$have_tags" = yes ]; then
      current_advertise_tags() { echo "tag:grok-box"; }
    else
      current_advertise_tags() { echo ""; }
    fi
    id() { return 1; }
    eval "$(extract_fn run_reauth_up)"
    run_reauth_up "test reason" >/dev/null 2>&1
    rm -f "$cap_bin"
  )
  tr '\n' ' ' < "$capture"
  rm -f "$capture"
}

argv_tags="$(reauth_argv_test yes yes)"
argv_notags="$(reauth_argv_test no yes)"
argv_nohost="$(reauth_argv_test no no)"

case "$argv_tags" in *--force-reauth*) pass "#9 argv has --force-reauth" ;; *) bad "#9 argv MISSING --force-reauth: [$argv_tags]" ;; esac
case "$argv_tags" in *--hostname=grok-box-8*) pass "#9 argv has --hostname=<current>" ;; *) bad "#9 argv MISSING --hostname: [$argv_tags]" ;; esac
case "$argv_tags" in *--advertise-tags=tag:grok-box*) pass "#9 argv mentions held tags" ;; *) bad "#9 argv missing held tags: [$argv_tags]" ;; esac
case "$argv_notags" in *--advertise-tags*) bad "#9 argv INTRODUCED tags when none held: [$argv_notags]" ;; *) pass "#9 argv omits tags when none held" ;; esac
case "$argv_tags" in *--reset*) bad "#9 argv used --reset (forbidden)" ;; *) pass "#9 argv never uses --reset" ;; esac
# H6: no hostname resolvable => run_reauth_up must NOT invoke up at all (empty capture).
if [ -z "${argv_nohost// /}" ]; then
  pass "H6 re-auth REFUSES (no up) when no hostname resolves"
else
  bad  "H6 re-auth attempted up with no hostname: [$argv_nohost]"
fi

# ---------------------------------------------------------------------------
# H5/E3 — the attempt-limiter must record an attempt even when `tailscale up`
# FAILS (rc≠0). This drives the REAL ensure_login (NeedsLogin + populated
# statedir branch) with a stubbed failing `up`, then asserts $REAUTH_LAST was
# written. MUTATION-SENSITIVE: deleting the reauth_attempt_record call in
# ensure_login makes this fail (no stamp written).
# ---------------------------------------------------------------------------
h5_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
RUN_DIR="\$(mktemp -d)"
REAUTH_LAST="\$RUN_DIR/last-reauth"
REAUTH_MIN_INTERVAL=1800
AUTHKEY_FILE="\$RUN_DIR/nokey"      # no auth key => AuthURL path
HOSTNAME_FILE="\$RUN_DIR/hostname"; echo grok-box-8 > "\$HOSTNAME_FILE"
log(){ :; }
have(){ command -v "\$1" >/dev/null 2>&1; }
id(){ return 1; }
# Backend says NeedsLogin; statedir populated; tailscale up FAILS (rc 1).
wait_for_backend(){ echo NeedsLogin; }
read_ts_fields(){ backend=NeedsLogin; }
state_is_populated(){ return 0; }
tailscale_bin(){ echo /bin/false; }        # -x true; used only by run_reauth_up fallback
prefs_hostname(){ echo grok-box-8; }
read_box_name(){ echo grok-box-8; }
current_advertise_tags(){ echo ""; }
ts(){ :; }
# Stub run_reauth_up to a guaranteed FAILURE (rc 7), so we test that
# ensure_login records the attempt regardless of rc.
run_reauth_up(){ return 7; }
extract_fn(){ awk -v fn="\$1" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$BOXUP"; }
for f in reauth_attempt_allowed reauth_attempt_record ensure_login; do eval "\$(extract_fn "\$f")"; done
ensure_login
[ -f "\$REAUTH_LAST" ] && echo recorded || echo missing
rm -rf "\$RUN_DIR"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
if [ "$(h5_test)" = recorded ]; then
  pass "H5/E3 ensure_login records the re-auth attempt even when up FAILS (rc≠0)"
else
  bad  "H5/E3 attempt NOT recorded on failing up — limiter is defeatable by a rc≠0 up"
fi

# ---------------------------------------------------------------------------
# H11 — auth-key expiry classification. Exercise the real authkey_expiry_state
# helper with a controlled .expires file.
# ---------------------------------------------------------------------------
h11_test() {
  local when="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
SECRETS_DIR="\$(mktemp -d)"
AUTHKEY_EXPIRES="\$SECRETS_DIR/ts-authkey.expires"
extract_fn(){ awk -v fn="\$1" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$BOXUP"; }
eval "\$(extract_fn authkey_expiry_state)"
case "$when" in
  none) : ;;  # no file
  ok)      date -u -d '+30 days' +%Y-%m-%d > "\$AUTHKEY_EXPIRES" ;;
  warn)    date -u -d '+3 days'  +%Y-%m-%d > "\$AUTHKEY_EXPIRES" ;;
  expired) date -u -d '-1 day'   +%Y-%m-%d > "\$AUTHKEY_EXPIRES" ;;
  garbage) echo "not-a-date" > "\$AUTHKEY_EXPIRES" ;;
esac
authkey_expiry_state
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(h11_test none)" = unknown ] && pass "H11 expiry: missing .expires => unknown (D6, not silent)" || bad "H11 expiry none wrong: [$(h11_test none)]"
[ "$(h11_test garbage)" = unknown ] && pass "H11 expiry: unparseable => unknown" || bad "H11 expiry garbage wrong: [$(h11_test garbage)]"
[ "$(h11_test ok)" = ok ] && pass "H11 expiry: >7d => ok" || bad "H11 expiry ok wrong: [$(h11_test ok)]"
[ "$(h11_test warn)" = warn ] && pass "H11 expiry: <7d => warn" || bad "H11 expiry warn wrong: [$(h11_test warn)]"
[ "$(h11_test expired)" = expired ] && pass "H11 expiry: past date => expired" || bad "H11 expiry expired wrong: [$(h11_test expired)]"

# ---------------------------------------------------------------------------
# H10 — .gitignore ignores auth-key patterns (belt-and-braces).
# ---------------------------------------------------------------------------
h10_ok=1
for pat in auth_key.txt myauthkey tskey-abc123 node_auth_key; do
  if ! git -C "$ROOT" check-ignore -q "$pat" 2>/dev/null; then h10_ok=0; echo "  not ignored: $pat" >&2; fi
done
if [ "$h10_ok" = 1 ]; then
  pass "H10 .gitignore ignores auth-key filename patterns"
else
  bad  "H10 .gitignore misses an auth-key pattern (see above)"
fi

# ---------------------------------------------------------------------------
# D2 — no `flock` ⇒ REFUSE, never run the body unlocked. Stub `have` so
# `have flock` is false and assert the body function never ran (marker absent)
# and the return code is the refuse code (200 try / 201 wait).
# ---------------------------------------------------------------------------
d2_test() {
  local mode="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
RUN_DIR="\$(mktemp -d)"
CONVERGE_LOCK="\$RUN_DIR/converge.lock"
log(){ :; }
have(){ return 1; }   # flock (and everything) reported absent
extract_fn(){ awk -v fn="\$1" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$BOXUP"; }
eval "\$(extract_fn run_with_converge_lock)"
marker="\$RUN_DIR/ran"
body(){ echo ran > "\$marker"; }
run_with_converge_lock "$mode" body; rc=\$?
ran=no; [ -f "\$marker" ] && ran=yes
rm -rf "\$RUN_DIR"
echo "\$rc \$ran"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
d2_try="$(d2_test try)"; d2_wait="$(d2_test wait)"
[ "$d2_try" = "200 no" ] && pass "D2 no-flock try-mode: REFUSE (rc 200) and body never ran" || bad "D2 no-flock try wrong: [$d2_try] want [200 no]"
[ "$d2_wait" = "201 no" ] && pass "D2 no-flock wait-mode: REFUSE (rc 201) and body never ran" || bad "D2 no-flock wait wrong: [$d2_wait] want [201 no]"
# install.sh asserts flock exists
if grep -q "command -v flock" "$ROOT/install.sh"; then
  pass "D2 install.sh asserts flock (util-linux) exists"
else
  bad  "D2 install.sh does not assert flock exists"
fi

# ---------------------------------------------------------------------------
# H1 raw-setsid — a RAW `setsid sleep` (NOT via spawn_detached) inside the body
# must STILL end up without the lock held after the body returns, because the
# body runs under `( fn ) 9<&-`. This catches removal of the inner `9<&-`:
# without it, a raw detached child would inherit fd 9 and hold the lock.
# ---------------------------------------------------------------------------
h1_raw_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
have(){ command -v "\$1" >/dev/null 2>&1; }
log(){ :; }
extract_fn(){ awk -v fn="\$1" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$BOXUP"; }
eval "\$(extract_fn run_with_converge_lock)"
RUN_DIR="\$(mktemp -d)"
CONVERGE_LOCK="\$RUN_DIR/converge.lock"
marker="\$(mktemp)"
# Body spawns a RAW detached child, bypassing spawn_detached entirely.
body(){ setsid sh -c "echo \\\$\\\$ > '\$marker'; exec sleep 5" & }
run_with_converge_lock wait body
sleep 0.4
# After the body returned, is the lock free? Try to take it non-blocking.
if flock -n "\$CONVERGE_LOCK" -c true; then held=no; else held=yes; fi
child="\$(cat "\$marker" 2>/dev/null)"
[ -n "\$child" ] && kill "\$child" 2>/dev/null
pkill -x sleep 2>/dev/null
rm -rf "\$RUN_DIR" "\$marker"
echo "\$held"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"
}
h1raw="$(h1_raw_test)"
if [ "$h1raw" = no ]; then
  pass "H1 inner 9<&-: a RAW setsid child in the body does NOT hold the lock (released)"
else
  bad  "H1 inner 9<&- missing? raw child held the lock after body returned ([$h1raw])"
fi

# ---------------------------------------------------------------------------
# H12 (generalized) — the tick repair DECISION: if any convergence
# postcondition fails, do_ensure_body runs; if all hold, it does not. Hermetic:
# stub the postcondition helpers + read_ts_fields and spy do_ensure_body.
# ---------------------------------------------------------------------------
h12_test() {
  local state="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
extract_fn(){ awk -v fn="\$1" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$BOXUP"; }
eval "\$(extract_fn tick_repair_needed)"
STATE="$state"
if [ "\$STATE" = broken ]; then
  pgrep(){ return 0; }                 # sshd "up" so we fall through to login
  login_postcondition_ok(){ return 1; } # locked / keys gone => repair needed
  read_ts_fields(){ backend=Running; online=yes; exitn=yes; }
  name_mismatch(){ return 1; }
else
  pgrep(){ return 0; }
  login_postcondition_ok(){ return 0; }
  read_ts_fields(){ backend=Running; online=yes; exitn=yes; }
  name_mismatch(){ return 1; }
fi
if tick_repair_needed; then echo "repair:\$TICK_REPAIR_REASON"; else echo none; fi
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
case "$(h12_test broken)" in repair:login) pass "H12 broken login postcondition => tick repair needed" ;; *) bad "H12 broken not detected: [$(h12_test broken)]" ;; esac
[ "$(h12_test healthy)" = none ] && pass "H12 healthy => no tick repair (cheap path)" || bad "H12 flagged repair when healthy: [$(h12_test healthy)]"

# H12 Stage-3 — statedir EMPTY (NeedsLogin) must drive an auth-key JOIN through
# one tick's do_ensure_body path. We exercise the REAL ensure_login first-login
# branch with an auth key + config tags, capturing the `up` argv.
h12_join_test() {
  local capture; capture="$(mktemp)"
  (
    set -u
    cap_bin="$(mktemp)"
    cat > "$cap_bin" <<CAP
#!/bin/sh
for a in "\$@"; do printf '%s\n' "\$a"; done > "$capture"
exit 0
CAP
    chmod +x "$cap_bin"
    RUN_DIR="$(mktemp -d)"
    AUTHKEY_FILE="$(mktemp)"; echo "tskey-abc" > "$AUTHKEY_FILE"
    log(){ :; }; id(){ return 1; }
    wait_for_backend(){ echo NeedsLogin; }
    state_is_populated(){ return 1; }          # empty statedir => first login
    tailscale_bin(){ echo "$cap_bin"; }
    config_get(){ [ "$1 $2" = "tailscale tags" ] && echo "tag:grok-box"; }
    eval "$(extract_fn run_reauth_up)"
    eval "$(extract_fn ensure_login)"
    ensure_login >/dev/null 2>&1
    rm -f "$cap_bin" "$AUTHKEY_FILE"; rm -rf "$RUN_DIR"
  )
  tr '\n' ' ' < "$capture"; rm -f "$capture"
}
h12join="$(h12_join_test)"
case "$h12join" in
  *--auth-key=tskey-abc*) pass "H12 statedir-empty => auth-key join argv carries --auth-key" ;;
  *) bad "H12 join argv missing --auth-key: [$h12join]" ;;
esac
case "$h12join" in
  *--advertise-tags=tag:grok-box*) pass "H12 first-login join argv carries --advertise-tags from config" ;;
  *) bad "H12 join argv missing --advertise-tags: [$h12join]" ;;
esac

# ---------------------------------------------------------------------------
# H13 — name_mismatch: file=grok-box-8 vs live=cursor is a mismatch; equal is
# not. Drives the REAL name_mismatch with stubbed read_box_name/live_hostname.
# ---------------------------------------------------------------------------
h13_test() {
  local live="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
extract_fn(){ awk -v fn="\$1" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$BOXUP"; }
eval "\$(extract_fn name_mismatch)"
read_box_name(){ echo grok-box-8; }
live_hostname(){ echo "$live"; }
if name_mismatch; then echo "mismatch:\$NAME_MISMATCH_LIVE"; else echo match; fi
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
case "$(h13_test cursor)" in mismatch:cursor) pass "H13 live=cursor vs file=grok-box-8 => mismatch (check FAIL + set --hostname)" ;; *) bad "H13 mismatch not detected: [$(h13_test cursor)]" ;; esac
[ "$(h13_test grok-box-8)" = match ] && pass "H13 live==file => no mismatch" || bad "H13 false mismatch on equal names: [$(h13_test grok-box-8)]"

# ---------------------------------------------------------------------------
# E1 — install.sh one-shot migration kills EXACTLY the tailscaled whose argv
# has the exact `--statedir=$STATE_DIR` token, and NOT a decoy with
# `--statedir=$STATE_DIR-other`. We replicate the migration's kill selector
# (exact NUL-split token match) against two fake daemons and assert only the
# right one is selected.
# ---------------------------------------------------------------------------
e1_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<'INNER'
set -u
STATE_DIR="/tmp/e1-$$-state"
# Two fake long-lived "daemons" carrying the token as an argv element. Using
# `bash -c 'sleep 30' _ <token>` keeps the process alive 30s while <token>
# appears verbatim in /proc/PID/cmdline (it's an ignored positional param).
bash -c 'sleep 30; :' _ "--statedir=$STATE_DIR" &
right=$!
bash -c 'sleep 30; :' _ "--statedir=$STATE_DIR-other" &
wrong=$!
sleep 0.3
# Migration selector (mirrors install.sh): NUL-split argv, exact token.
selected=""
for pid in "$right" "$wrong"; do
  match=0
  while IFS= read -r -d '' arg; do
    [ "$arg" = "--statedir=$STATE_DIR" ] && match=1
  done < "/proc/$pid/cmdline" 2>/dev/null || true
  [ "$match" = 1 ] && selected="$selected $pid"
done
kill "$right" "$wrong" 2>/dev/null
if [ "$selected" = " $right" ]; then echo ok; else echo "bad:[$selected] right=$right wrong=$wrong"; fi
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
if [ "$(e1_test)" = ok ]; then
  pass "E1 migration selector: exact --statedir token matches the daemon, not the -other decoy"
else
  bad  "E1 migration selector wrong: [$(e1_test)]"
fi
# E1 install.sh actually has the migration (marker-absence gate + exact token)
if grep -q 'E1 migration' "$ROOT/install.sh" && grep -q 'flock --close' "$ROOT/install.sh"; then
  pass "E1 install.sh carries the one-shot pre-H1 migration (marker-gated)"
else
  bad  "E1 install.sh missing the migration"
fi

echo "-----"
if [ "$fail" = 0 ]; then echo "ALL TESTS PASSED"; else echo "SOME TESTS FAILED"; fi
exit "$fail"
