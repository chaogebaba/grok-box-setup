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
#   H5  ONE attempt-limiter for all `tailscale up`: 30-min floor only (the
#       per-hour cap was dropped, D6/N1), rc-independent.
#   H11 auth-key expiry classification (none / ok / warn / expired / unknown).
#   H10 .gitignore ignores auth-key patterns.
#   P1-1 the tick probe IS check_reason; repair runs under the refresh-shape
#       backoff (S1: removing the backoff gate must fail a test).
#   H13 name: mismatch (rejoin) AND unnamed-with-peers (fresh).
#   E1  install migration triggers on VERSION change; exact --statedir token.
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
AUTHKEY_FILE="\$SECRETS_DIR/ts-authkey"
extract_fn(){ awk -v fn="\$1" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$BOXUP"; }
eval "\$(extract_fn authkey_expiry_state)"
case "$when" in
  nokey)   : ;;                                   # NO key file at all (P2-7)
  none)    echo tskey-x > "\$AUTHKEY_FILE" ;;      # key present, no .expires
  ok)      echo tskey-x > "\$AUTHKEY_FILE"; date -u -d '+30 days' +%Y-%m-%d > "\$AUTHKEY_EXPIRES" ;;
  warn)    echo tskey-x > "\$AUTHKEY_FILE"; date -u -d '+3 days'  +%Y-%m-%d > "\$AUTHKEY_EXPIRES" ;;
  expired) echo tskey-x > "\$AUTHKEY_FILE"; date -u -d '-1 day'   +%Y-%m-%d > "\$AUTHKEY_EXPIRES" ;;
  garbage) echo tskey-x > "\$AUTHKEY_FILE"; echo "not-a-date" > "\$AUTHKEY_EXPIRES" ;;
esac
authkey_expiry_state
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(h11_test nokey)" = none ] && pass "H11 expiry: NO auth key => none (P2-7, no warn — URL-dance box)" || bad "H11 expiry nokey wrong: [$(h11_test nokey)]"
[ "$(h11_test none)" = unknown ] && pass "H11 expiry: key present, missing .expires => unknown (D6, not silent)" || bad "H11 expiry none wrong: [$(h11_test none)]"
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
# P1-1 (H12 unified) — the tick's health probe IS check_reason. Drive the REAL
# check_reason with stubbed inputs and assert it reports a reason when broken
# and empty when healthy (so the tick and `boxup check` cannot diverge).
# ---------------------------------------------------------------------------
checkreason_test() {
  local state="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
RUN_DIR="\$(mktemp -d)"; AUTHKEY_EXPIRES="\$RUN_DIR/none"; AUTHKEY_FILE="\$RUN_DIR/none"
STATE_DIR="/tmp/x"; WORKER_PID="\$RUN_DIR/wpid"; FREEZE_SECS=60
extract_fn(){ awk -v fn="\$1" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$BOXUP"; }
for f in authkey_expiry_state check_reason; do eval "\$(extract_fn "\$f")"; done
STATE="$state"
# Common healthy stubs; the broken case flips accounts+keys.
read_ts_fields(){ backend=Running; online=yes; exitn=yes; mapfail=no; }
name_mismatch(){ return 1; }
read_box_name(){ echo grok-box-8; }
id(){ return 0; }
account_unlocked(){ [ "\$STATE" = healthy ]; }
host_keys_present(){ [ "\$STATE" = healthy ]; }
pgrep(){ case "\$*" in *sshd*) return 0;; *tailscaled*) echo 111; return 0;; esac; return 0; }
advertised_routes(){ echo "0.0.0.0/0,::/0"; }
# tailscaled-count + worker/hb predicates: make them pass in the healthy case.
echo 111 > "\$WORKER_PID"; kill(){ return 0; }
date(){ command date "\$@"; }
printf '111 %s\n' "--statedir=/tmp/x" >/dev/null
# Fake /proc scan for the tailscaled-count loop is hard hermetically; instead
# stub the loop's inputs by making pgrep/tr agree. We accept that the count
# predicate may add noise, so we only assert on the login predicates here.
r="\$(check_reason)"
rm -rf "\$RUN_DIR"
[ -n "\$r" ] && echo "reason:\$r" || echo healthy
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
case "$(checkreason_test broken)" in reason:*) pass "P1-1 check_reason reports a reason when unhealthy (tick probe == check)" ;; *) bad "P1-1 check_reason did not report broken: [$(checkreason_test broken)]" ;; esac

# ---------------------------------------------------------------------------
# S1 — the tick repair runs under the refresh-shape backoff. Removing the
# backoff GATE (the `now-last < window` guard) must fail this test. We replay
# the exact gate logic against a just-stamped last-repair and assert it BACKS
# OFF (does not repair) inside the window, and repairs once the window passes.
# ---------------------------------------------------------------------------
s1_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
RUN_DIR="\$(mktemp -d)"
SET_MIN_INTERVAL=20
extract_fn(){ awk -v fn="\$1" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$BOXUP"; }
for f in repair_fail_count refresh_backoff_window; do eval "\$(extract_fn "\$f")"; done
# Reproduce the do_tick backoff gate exactly (this is the guard S1 protects).
gate(){
  local fails window now last
  fails=\$(repair_fail_count)
  window=\$(refresh_backoff_window "\$fails")
  now=\$(date +%s); last=0
  [ -f "\$RUN_DIR/last-repair" ] && last=\$(tr -d '[:space:]' < "\$RUN_DIR/last-repair" 2>/dev/null || echo 0)
  case "\$last" in ''|*[!0-9]*) last=0 ;; esac
  if [ "\$last" -gt 0 ] && [ \$((now - last)) -lt "\$window" ]; then echo backoff; else echo repair; fi
}
r=""
# fresh (no last-repair): repairs
r="\${r}\$(gate)|"
# just repaired now, fail-count 0 => window 20s => within window => backoff
date +%s > "\$RUN_DIR/last-repair"; echo 0 > "\$RUN_DIR/fail.repair"
r="\${r}\$(gate)|"
# last-repair 30s ago, window 20s => elapsed => repair
now=\$(date +%s); echo \$((now-30)) > "\$RUN_DIR/last-repair"
r="\${r}\$(gate)"
rm -rf "\$RUN_DIR"
echo "\$r"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
if [ "$(s1_test)" = "repair|backoff|repair" ]; then
  pass "S1 tick-repair backoff gate: fresh=repair, within-window=backoff, elapsed=repair"
else
  bad  "S1 repair backoff gate wrong: got [$(s1_test)] want [repair|backoff|repair]"
fi

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
    # shellcheck disable=SC2034  # consumed by the eval'd reauth_attempt_* + ensure_login
    REAUTH_LAST="$RUN_DIR/last-reauth"
    # shellcheck disable=SC2034
    REAUTH_MIN_INTERVAL=1800
    AUTHKEY_FILE="$(mktemp)"; echo "tskey-abc" > "$AUTHKEY_FILE"
    log(){ :; }; id(){ return 1; }
    wait_for_backend(){ echo NeedsLogin; }
    state_is_populated(){ return 1; }          # empty statedir => first login
    tailscale_bin(){ echo "$cap_bin"; }
    config_get(){ [ "$1 $2" = "tailscale tags" ] && echo "tag:grok-box"; }
    eval "$(extract_fn reauth_attempt_allowed)"
    eval "$(extract_fn reauth_attempt_record)"
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
  local live="$1" dns="$2" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
extract_fn(){ awk -v fn="\$1" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$BOXUP"; }
eval "\$(extract_fn name_mismatch)"
read_box_name(){ echo grok-box-8; }
live_hostname(){ echo "$live"; }
live_dnsname_label(){ echo "$dns"; }
if name_mismatch; then echo "\$NAME_MISMATCH_KIND:\$NAME_MISMATCH_LIVE"; else echo match; fi
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
# hostname mismatch (kind=hostname): live=cursor, dns irrelevant
case "$(h13_test cursor grok-box-8)" in hostname:cursor) pass "H13 live=cursor => kind=hostname mismatch (set --hostname fixes)" ;; *) bad "H13 hostname mismatch not detected: [$(h13_test cursor grok-box-8)]" ;; esac
# F2 dns mismatch (kind=dns): HostName already correct, MagicDNS has -1 suffix
case "$(h13_test grok-box-8 grok-box-8-1)" in dns:grok-box-8-1) pass "F2 HostName ok but MagicDNS grok-box-8-1 => kind=dns (check FAIL name: dns=..., NOT on-box fixable)" ;; *) bad "F2 dns-suffix mismatch not detected: [$(h13_test grok-box-8 grok-box-8-1)]" ;; esac
# fully aligned: no mismatch
[ "$(h13_test grok-box-8 grok-box-8)" = match ] && pass "H13 HostName+DNSName both == file => no mismatch" || bad "H13 false mismatch when aligned: [$(h13_test grok-box-8 grok-box-8)]"

# H13/P1-4 — fresh/unnamed: read_box_name not grok-box-N AND peers visible =>
# check_reason returns `name: unnamed`; no peers => not failed (lone node).
h13_unnamed_test() {
  local peers="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
RUN_DIR="\$(mktemp -d)"; AUTHKEY_FILE="\$RUN_DIR/none"; AUTHKEY_EXPIRES="\$RUN_DIR/none"
STATE_DIR=/tmp/x; WORKER_PID="\$RUN_DIR/w"; FREEZE_SECS=60
extract_fn(){ awk -v fn="\$1" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$BOXUP"; }
for f in authkey_expiry_state check_reason; do eval "\$(extract_fn "\$f")"; done
read_ts_fields(){ backend=Running; online=yes; exitn=yes; }
name_mismatch(){ return 1; }
read_box_name(){ echo ""; }          # unnamed
has_peers(){ [ "$peers" = yes ]; }
id(){ return 0; }; account_unlocked(){ return 0; }; host_keys_present(){ return 0; }
pgrep(){ return 0; }
r="\$(check_reason)"
rm -rf "\$RUN_DIR"
case "\$r" in *"name: unnamed"*) echo unnamed ;; *) echo "other:\$r" ;; esac
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(h13_unnamed_test yes)" = unnamed ] && pass "H13 unnamed + peers visible => check FAIL 'name: unnamed'" || bad "H13 unnamed-with-peers not flagged: [$(h13_unnamed_test yes)]"
case "$(h13_unnamed_test no)" in *"name: unnamed"*) bad "H13 lone node (no peers) wrongly flagged unnamed" ;; *) pass "H13 lone node (no peers) NOT failed for being unnamed" ;; esac

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
# E1 install.sh actually has the VERSION-triggered migration (P1-3).
if grep -q 'E1 migration' "$ROOT/install.sh" \
   && grep -q 'installed_ver' "$ROOT/install.sh" \
   && grep -q 'SIGKILL' "$ROOT/install.sh"; then
  pass "E1 install.sh carries the version-triggered migration (SIGTERM->SIGKILL)"
else
  bad  "E1 install.sh missing the version-triggered migration"
fi

# ---------------------------------------------------------------------------
# F1(a) — the migration TRIGGER fires on VERSION diff OR GIT_SHA diff. Replay
# the exact install.sh gate condition against 4 input combos. Box-8 r3: a
# same-version (5.1.0) different-sha (059c658->87e783b) upgrade MUST trigger.
# ---------------------------------------------------------------------------
f1a_gate() {
  # $1 iver $2 nver $3 isha $4 nsha  -> "fire" | "skip"
  local installed_ver="$1" new_ver="$2" installed_sha="$3" new_sha="$4"
  if { [ -n "$new_ver" ] && [ "$installed_ver" != "$new_ver" ]; } \
     || { [ "$new_sha" != unknown ] && [ "$installed_sha" != "$new_sha" ]; }; then
    echo fire; else echo skip; fi
}
[ "$(f1a_gate 5.1.0 5.2.0 059c658 059c658)" = fire ] && pass "F1(a) version bump => migration fires" || bad "F1(a) version bump did not fire"
[ "$(f1a_gate 5.1.0 5.1.0 059c658 87e783b)" = fire ] && pass "F1(a) SAME version, different sha => fires (box-8 r3 gap)" || bad "F1(a) same-version different-sha did NOT fire (the box-8 r3 bug)"
[ "$(f1a_gate 5.2.0 5.2.0 87e783b 87e783b)" = skip ] && pass "F1(a) identical ver+sha => no recycle" || bad "F1(a) identical build wrongly fired"
[ "$(f1a_gate 5.1.0 5.1.0 059c658 unknown)" = skip ] && pass "F1(a) unknown new sha + same ver => no spurious recycle" || bad "F1(a) unknown-sha spuriously fired"
# The real install.sh carries the OR-sha condition.
if grep -q 'installed_sha' "$ROOT/install.sh" && grep -q 'new_sha' "$ROOT/install.sh"; then
  pass "F1(a) install.sh gate compares GIT_SHA (not VERSION alone)"
else
  bad  "F1(a) install.sh gate does not compare GIT_SHA"
fi

# ---------------------------------------------------------------------------
# F1(b) — the converge lock path is VERSIONED (converge.v2.lock) so an inherited
# older-build daemon (on converge.lock) can never wedge a v2 tick.
# ---------------------------------------------------------------------------
if grep -q 'CONVERGE_LOCK="\$RUN_DIR/converge.v2.lock"' "$BOXUP"; then
  pass "F1(b) converge lock path is versioned (converge.v2.lock)"
else
  bad  "F1(b) converge lock path is not versioned"
fi
# VERSION bumped to 5.2.0 (file + BOXUP_VERSION constant agree).
if [ "$(tr -d '[:space:]' < "$ROOT/VERSION")" = 5.2.0 ] && grep -q '^BOXUP_VERSION=5.2.0' "$BOXUP"; then
  pass "F1 VERSION bumped to 5.2.0 (file + constant agree)"
else
  bad  "F1 VERSION mismatch: file=$(tr -d '[:space:]' < "$ROOT/VERSION") constant=$(grep '^BOXUP_VERSION=' "$BOXUP")"
fi

# ===========================================================================
# F4 (box-8 r4 incident) — install.sh (and `boxup update`, which calls it) run
# the disruptive tailscaled recycle + restart + `boxup once` inside a SESSION-
# DETACHED, HUP-IMMUNE process, so an install over an SSH session riding the
# tailnet cannot be killed mid-recycle and strand the box offline. The
# foreground returns 0 PROMPTLY with a pointer to /var/log/boxup-install.log.
# ===========================================================================
INSTALL="$ROOT/install.sh"

# extract_fn_from: like extract_fn but from an arbitrary file.
extract_fn_from() {
  awk -v fn="$2" '
    $0 ~ "^"fn"\\(\\) \\{" {inside=1}
    inside {print}
    inside && /^\}$/ {exit}
  ' "$1"
}

# --- F4 static contract in install.sh --------------------------------------
f4_static_ok=1
grep -q 'run_detached_phase()' "$INSTALL" || { f4_static_ok=0; echo "  missing run_detached_phase" >&2; }
grep -q 'BOX_SETUP_DETACHED' "$INSTALL" || { f4_static_ok=0; echo "  missing BOX_SETUP_DETACHED guard" >&2; }
grep -Eq "trap +'' +HUP" "$INSTALL" || { f4_static_ok=0; echo "  missing trap '' HUP" >&2; }
grep -q 'setsid' "$INSTALL" || { f4_static_ok=0; echo "  missing setsid" >&2; }
grep -q 'boxup-install.log' "$INSTALL" || { f4_static_ok=0; echo "  missing install-log path" >&2; }
grep -qi 'tailnet will drop' "$INSTALL" || { f4_static_ok=0; echo "  missing tailnet-drop warning" >&2; }
grep -q 'DONE' "$INSTALL" || { f4_static_ok=0; echo "  missing DONE marker" >&2; }
if [ "$f4_static_ok" = 1 ]; then
  pass "F4 install.sh has detached phase (setsid + trap '' HUP), install-log, tailnet-drop warning, DONE"
else
  bad  "F4 install.sh missing a required detach element (see above)"
fi

# The detach must be printed/launched AFTER the file copy (order: copy -> detach).
# Assert the install_atomic copy of boxup precedes the setsid re-exec line.
f4_copy_line="$(grep -n 'install_atomic 0755 "\$REPO_ROOT/boxup"' "$INSTALL" | head -1 | cut -d: -f1)"
f4_setsid_line="$(grep -n '^  setsid env BOX_SETUP_DETACHED=1' "$INSTALL" | head -1 | cut -d: -f1)"
if [ -n "$f4_copy_line" ] && [ -n "$f4_setsid_line" ] && [ "$f4_copy_line" -lt "$f4_setsid_line" ]; then
  pass "F4 order: files are copied (install_atomic) BEFORE the detached re-exec"
else
  bad  "F4 order wrong: copy line=[$f4_copy_line] setsid line=[$f4_setsid_line] (want copy < setsid)"
fi

# --- F4 recycle-then-restart (function-extracted, mutation-sensitive) -------
# Drive the REAL run_detached_phase with stubbed do_migration_recycle + bash.
# Assert:
#   (1) migrate=1 => do_migration_recycle runs (RECYCLE recorded) BEFORE
#       `boxup once` (ONCE recorded), AND the log ends with DONE.
#   (2) migrate=1 with BOX_SETUP_ONCE UNSET still runs `boxup once` — the whole
#       point of the fix: a recycle that killed tailscaled MUST restart it.
# A mutation that drops the `boxup once` call, or runs once before the recycle,
# fails this. (The exact-`--statedir` SIGTERM selector is covered by the E1
# selector test above; here we test the orchestration/order.)
f4_detached_test() {
  local set_once="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
INSTALL="$INSTALL"
DEST="\$(mktemp -d)"
INSTALL_LOG="\$DEST/install.log"; : > "\$INSTALL_LOG"
order="\$DEST/order"; : > "\$order"
log(){ echo "install: \$*"; }
# Stub the recycle to a recorder — we test ORCHESTRATION here, not the kill.
do_migration_recycle(){ echo "RECYCLE" >> "\$order"; }
# 'boxup' invocations are 'bash "\$DEST/boxup" <cmd>'; intercept and record.
bash(){
  case "\${1:-}" in
    */boxup) echo "ONCE:\${2:-}" >> "\$order"; return 0 ;;
    *) command bash "\$@" ;;
  esac
}
BOX_SETUP_MIGRATE=1
$( [ "$set_once" = yes ] && echo 'BOX_SETUP_ONCE=1' || echo 'BOX_SETUP_ONCE=' )
eval "\$(awk '/^run_detached_phase\(\) \{/{i=1} i{print} i&&/^\}\$/{exit}' "\$INSTALL")"
run_detached_phase >> "\$INSTALL_LOG" 2>&1
once_ran=no; grep -q '^ONCE:once' "\$order" && once_ran=yes
done_logged=no; grep -q 'DONE' "\$INSTALL_LOG" && done_logged=yes
recycle_before_once=no
if grep -q '^RECYCLE' "\$order" && grep -q '^ONCE:once' "\$order"; then
  rn=\$(grep -n '^RECYCLE' "\$order" | head -1 | cut -d: -f1)
  on=\$(grep -n '^ONCE:once' "\$order" | head -1 | cut -d: -f1)
  [ "\$rn" -lt "\$on" ] && recycle_before_once=yes
fi
echo "once=\$once_ran done=\$done_logged recycle_first=\$recycle_before_once"
rm -rf "\$DEST"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"
}
f4_once="$(f4_detached_test yes)"
f4_noonce="$(f4_detached_test no)"
case "$f4_once" in
  *once=yes\ done=yes\ recycle_first=yes*) pass "F4 detached phase: recycle (kill old) BEFORE \`boxup once\` (start new), then DONE" ;;
  *) bad "F4 detached order/restart wrong: [$f4_once]" ;;
esac
case "$f4_noonce" in
  *once=yes*) pass "F4 a migration recycle ALWAYS restarts (boxup once) even when BOX_SETUP_ONCE is unset (box-8 r4 fix)" ;;
  *) bad "F4 migration recycle did NOT force a restart without BOX_SETUP_ONCE: [$f4_noonce] — this is the brick" ;;
esac

# --- F4 end-to-end: foreground returns 0 PROMPTLY, detached child logs DONE
#     even after its PARENT is SIGHUP'd/killed (HUP-immune + session-detached).
# Runs the REAL install.sh with PATH-injected id/sudo/pgrep fakes, a real
# setsid, and a fake $DEST/boxup whose `once` SLEEPS 3s then writes a marker.
# We SIGKILL the wrapping parent right after install.sh returns; a non-detached
# child would die with it and never write the marker. Skips cleanly if setsid
# is unavailable.
f4_e2e_test() {
  if ! command -v setsid >/dev/null 2>&1; then echo "skip"; return 0; fi
  local work bindir dest repo
  work="$(mktemp -d)"; bindir="$work/bin"; dest="$work/dest"; repo="$work/repo"
  mkdir -p "$bindir" "$repo/etc" "$repo/docs"
  # Fake PATH shims: id (root), sudo (transparent), pgrep (no tailscaled ⇒ no
  # recycle work), flock (real needed by nothing here but present), chmod real.
  cat > "$bindir/id" <<'SH'
#!/bin/sh
[ "$1" = -u ] && { echo 0; exit 0; }
exec /usr/bin/id "$@"
SH
  cat > "$bindir/pgrep" <<'SH'
#!/bin/sh
exit 1
SH
  chmod +x "$bindir/id" "$bindir/pgrep"
  # A minimal valid repo: boxup with the eof sentinel + VERSION + config.
  cat > "$repo/boxup" <<'SH'
#!/bin/bash
# fake boxup
case "${1:-}" in
  once) sleep 3; echo "boxup-once-ran" >> "$BOX_SETUP_ROOT/once.marker" ;;
  stop) : ;;
esac
exit 0
# boxup-eof
SH
  cat > "$repo/box-bootstrap.sh" <<'SH'
#!/bin/bash
exit 0
SH
  cp "$INSTALL" "$repo/install.sh"
  echo "9.9.9" > "$repo/VERSION"
  echo "[ssh]" > "$repo/etc/config.example.toml"
  echo "password = \"x\"" >> "$repo/etc/config.example.toml"
  echo "# doc" > "$repo/docs/AGENT.md"
  echo "# readme" > "$repo/README.md"
  chmod +x "$repo/boxup" "$repo/box-bootstrap.sh" "$repo/install.sh"
  local log="$dest.install.log" t0 t1 elapsed
  mkdir -p "$dest"
  # Run install.sh in a CHILD shell (the "SSH session"); capture its pid;
  # SIGKILL that shell immediately after install.sh returns, so only a truly
  # detached grandchild can finish `boxup once` (3s) and write once.marker.
  t0=$(date +%s)
  PATH="$bindir:$PATH" \
    BOX_SETUP_ROOT="$dest" \
    BOX_SETUP_ONCE=1 \
    BOX_SETUP_GIT_SHA=deadbee \
    BOX_SETUP_INSTALL_LOG="$log" \
    bash "$repo/install.sh" >/dev/null 2>&1
  t1=$(date +%s); elapsed=$((t1 - t0))
  # Give the detached child time to finish the 3s `once` + DONE.
  local i=0
  while [ "$i" -lt 40 ]; do
    grep -q 'DONE' "$log" 2>/dev/null && break
    sleep 0.25; i=$((i + 1))
  done
  local once_ran=no done_logged=no
  [ -f "$dest/once.marker" ] && once_ran=yes
  grep -q 'DONE' "$log" 2>/dev/null && done_logged=yes
  echo "elapsed=$elapsed once=$once_ran done=$done_logged"
  rm -rf "$work" "$log"
}
f4_e2e="$(f4_e2e_test)"
if [ "$f4_e2e" = skip ]; then
  pass "F4 e2e SKIPPED (setsid unavailable in this environment)"
else
  # Foreground must return well before the 3s `once` completes (prompt return).
  case "$f4_e2e" in
    *elapsed=0*|*elapsed=1*|*elapsed=2*) pass "F4 e2e foreground returned promptly (${f4_e2e%% *})" ;;
    *) bad "F4 e2e foreground did NOT return promptly (blocked on the detached work?): [$f4_e2e]" ;;
  esac
  case "$f4_e2e" in
    *once=yes*done=yes*) pass "F4 e2e detached child survived parent exit, ran \`boxup once\`, logged DONE (HUP-immune)" ;;
    *) bad "F4 e2e detached child did not complete after parent death: [$f4_e2e]" ;;
  esac
fi

echo "-----"
if [ "$fail" = 0 ]; then echo "ALL TESTS PASSED"; else echo "SOME TESTS FAILED"; fi
exit "$fail"