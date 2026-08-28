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
# H5 — re-auth attempt-limiter: min-interval blocks a second attempt; a fresh
# state allows one; the per-hour cap blocks beyond the cap. rc-independent.
# ---------------------------------------------------------------------------
h5_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
RUN_DIR="\$(mktemp -d)"
REAUTH_LAST="\$RUN_DIR/last-reauth"
REAUTH_HOUR="\$RUN_DIR/reauth-hour"
REAUTH_MIN_INTERVAL=1800
REAUTH_MAX_PER_HOUR=3
extract_fn(){ awk -v fn="\$1" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$BOXUP"; }
for f in reauth_attempt_allowed reauth_attempt_record; do eval "\$(extract_fn "\$f")"; done
r=""
# fresh: allowed
reauth_attempt_allowed && r="\${r}A" || r="\${r}."
reauth_attempt_record
# immediately after: min-interval blocks
reauth_attempt_allowed && r="\${r}A" || r="\${r}."
# simulate 31 min ago but hour cap: force last old, count at cap in this hour
now=\$(date +%s)
echo \$((now-2000)) > "\$REAUTH_LAST"
echo "\$now 3" > "\$REAUTH_HOUR"
reauth_attempt_allowed && r="\${r}A" || r="\${r}."   # capped => blocked
# old interval + under cap => allowed
echo \$((now-2000)) > "\$REAUTH_LAST"
echo "\$now 1" > "\$REAUTH_HOUR"
reauth_attempt_allowed && r="\${r}A" || r="\${r}."
rm -rf "\$RUN_DIR"
echo "\$r"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
h5="$(h5_test)"
# expected: A . . A  (fresh allowed; min-interval block; hour-cap block; under-cap allowed)
if [ "$h5" = "A..A" ]; then
  pass "H5 attempt-limiter: min-interval + per-hour cap gate attempts (pattern A..A)"
else
  bad  "H5 attempt-limiter pattern wrong: got [$h5] want [A..A]"
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
  ok)      date -u -d '+60 days' +%Y-%m-%d > "\$AUTHKEY_EXPIRES" ;;
  warn)    date -u -d '+5 days'  +%Y-%m-%d > "\$AUTHKEY_EXPIRES" ;;
  expired) date -u -d '-1 day'   +%Y-%m-%d > "\$AUTHKEY_EXPIRES" ;;
esac
authkey_expiry_state
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(h11_test none)" = none ] && pass "H11 expiry: missing .expires => none (fail-quiet)" || bad "H11 expiry none wrong: [$(h11_test none)]"
[ "$(h11_test ok)" = ok ] && pass "H11 expiry: >14d => ok" || bad "H11 expiry ok wrong: [$(h11_test ok)]"
[ "$(h11_test warn)" = warn ] && pass "H11 expiry: <14d => warn" || bad "H11 expiry warn wrong: [$(h11_test warn)]"
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

echo "-----"
if [ "$fail" = 0 ]; then echo "ALL TESTS PASSED"; else echo "SOME TESTS FAILED"; fi
exit "$fail"
