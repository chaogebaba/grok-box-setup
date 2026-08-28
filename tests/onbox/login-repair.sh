#!/bin/bash
# tests/onbox/login-repair.sh — DESTRUCTIVE on-box reproducer for the H12
# login-repair postcondition (box-8 Stage 1). This is NOT part of `make test`:
# it mutates /etc/shadow and /etc/ssh and must run as root ON A BOX ONLY.
#
# It reproduces the exact box-8 Stage 1 failure and asserts the worker self-
# heals it within one tick:
#   1. lock box + root, delete the ssh host keys  (the tamper)
#   2. run ONE `boxup tick`                        (the repair)
#   3. assert box + root unlocked AND host keys restored
#
# SAFETY: refuses to run unless BOXUP_ONBOX_DESTRUCTIVE=1 is set, AND it is
# clearly on a box (ROOT=/workspace/box-setup exists). grok_tester runs it on
# box-8 after deploy; never on a laptop.
#
# Usage (on the box, as root):
#   sudo env BOXUP_ONBOX_DESTRUCTIVE=1 /workspace/box-setup/tests/onbox/login-repair.sh
set -u

ROOT="${BOX_SETUP_ROOT:-/workspace/box-setup}"
BOXUP="$ROOT/boxup"

die() { echo "onbox: $*" >&2; exit 1; }

[ "${BOXUP_ONBOX_DESTRUCTIVE:-}" = 1 ] || die "refusing: set BOXUP_ONBOX_DESTRUCTIVE=1 (this mutates /etc/shadow and /etc/ssh)"
[ "$(id -u)" -eq 0 ] || die "must run as root"
[ -x "$BOXUP" ] || die "no boxup at $BOXUP — this runs ON A BOX only"
[ -d "$ROOT" ] || die "no $ROOT — this runs ON A BOX only"

echo "onbox: === H12 login-repair reproducer (DESTRUCTIVE) on $(hostname) ==="

# --- 1. tamper -------------------------------------------------------------
echo "onbox: locking box + root, deleting ssh host keys"
passwd -l box  >/dev/null 2>&1 || true
passwd -l root >/dev/null 2>&1 || true
rm -f /etc/ssh/ssh_host_* 2>/dev/null || true

# Sanity: confirm the tamper took (box now locked, keys gone).
locked_before=0
[ "$(passwd -S box 2>/dev/null | awk '{print $2}')" = L ] && locked_before=1
keys_before=1; [ -s /etc/ssh/ssh_host_ed25519_key ] || keys_before=0
echo "onbox: after tamper: box_locked=$locked_before host_ed25519_present=$keys_before (want 1 and 0)"

# --- 2. repair: one tick ---------------------------------------------------
echo "onbox: running one 'boxup tick'"
"$BOXUP" tick >/dev/null 2>&1 || true
sleep 1

# --- 3. assert -------------------------------------------------------------
fail=0
box_state="$(passwd -S box 2>/dev/null | awk '{print $2}')"
root_state="$(passwd -S root 2>/dev/null | awk '{print $2}')"
[ "$box_state" = P ]  || { echo "onbox: FAIL box account not unlocked (passwd -S => ${box_state:-?})"; fail=1; }
[ "$root_state" = P ] || { echo "onbox: FAIL root account not unlocked (passwd -S => ${root_state:-?})"; fail=1; }
[ -s /etc/ssh/ssh_host_ed25519_key ] || { echo "onbox: FAIL ssh host key not restored"; fail=1; }

if [ "$fail" = 0 ]; then
  echo "onbox: PASS — one tick unlocked box+root and restored host keys (H12 self-heal works)"
else
  echo "onbox: FAILED — H12 did not self-heal within one tick"
fi
exit "$fail"
