#!/bin/bash
# After forwarding is on, push a full `tailscale set` so the coordination
# server drops "Unable to relay traffic". Never `tailscale up`. Rate-limited.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
[ -f "$HERE/lib/common.sh" ] && . "$HERE/lib/common.sh"
[ -f "$HERE/scripts/lib/common.sh" ] && . "$HERE/scripts/lib/common.sh"
# shellcheck source=/dev/null
[ -f "$HERE/lib/naming.sh" ] && . "$HERE/lib/naming.sh"

: "${ROOT:=${BOX_SETUP_ROOT:-/workspace/box-setup}}"
: "${HOSTNAME_FILE:=$ROOT/hostname}"
STAMP=/run/box-setup/last-exitnode-set
MIN_INTERVAL="${MIN_INTERVAL:-20}"

log() { echo "refresh-exitnode: $*" >&2; }

if ! have_tailscale_cli 2>/dev/null; then
  command -v tailscale >/dev/null 2>&1 || { log "no tailscale cli"; exit 0; }
fi

BACKEND=$(timeout 5 tailscale status --json 2>/dev/null | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin); print(d.get("BackendState") or "")
except Exception:
    print("")
' 2>/dev/null || true)

case "$BACKEND" in
  Running) ;;
  *) log "backend=${BACKEND:-unknown} — skip set"; exit 0 ;;
esac

NAME=""
if [ -s "$HOSTNAME_FILE" ]; then
  NAME=$(tr -d '[:space:]' < "$HOSTNAME_FILE")
fi
case "$NAME" in
  grok-box-[0-9]*) ;;
  *)
    NAME=$(timeout 5 tailscale debug prefs 2>/dev/null | python3 -c '
import json,sys
try:
    p=json.load(sys.stdin); print((p.get("Hostname") or "").strip())
except Exception:
    print("")
' 2>/dev/null || true)
    ;;
esac
case "$NAME" in
  grok-box-[0-9]*) ;;
  *) log "no grok-box-N yet — skip set"; exit 0 ;;
esac

need=0
reason=""

CHK=$(timeout 5 curl -sS --unix-socket /var/run/tailscale/tailscaled.sock \
  http://local-tailscaled.sock/localapi/v0/check-ip-forwarding 2>/dev/null || true)
if echo "$CHK" | grep -qi 'forwarding is disabled\|Warning'; then
  need=1; reason="check-ip-forwarding warning"
fi

V4=$(tr -d '[:space:]' < /proc/sys/net/ipv4/ip_forward 2>/dev/null || echo 0)
V6=$(tr -d '[:space:]' < /proc/sys/net/ipv6/conf/all/forwarding 2>/dev/null || echo 0)
if [ "$V4" != 1 ] || [ "$V6" != 1 ]; then
  need=1; reason="kernel ipfwd v4=${V4} v6=${V6}"
fi
if [ -f /run/box-setup/ipfwd.env ]; then
  # shellcheck disable=SC1091
  . /run/box-setup/ipfwd.env
  if [ "${changed:-0}" = 1 ]; then
    need=1; reason="sysctl just flipped"
  fi
fi

EVAL=$(timeout 8 tailscale status --json 2>/dev/null | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin); s=d.get("Self") or {}
    health=d.get("Health") or []
    print("exit="+str(bool(s.get("ExitNodeOption"))))
    print("health="+" ".join(str(x) for x in health))
except Exception:
    print("exit=False"); print("health=")
' 2>/dev/null || true)
echo "$EVAL" | grep -q 'exit=False' && { need=1; reason="ExitNodeOption false"; }
echo "$EVAL" | grep -qi 'forward' && { need=1; reason="status Health mentions forward"; }

PREFS=$(timeout 8 tailscale debug prefs 2>/dev/null | python3 -c '
import json,sys
try:
    p=json.load(sys.stdin)
    routes=p.get("AdvertiseRoutes") or []
    print("routes="+",".join(str(x) for x in routes))
except Exception:
    print("routes=")
' 2>/dev/null || true)
echo "$PREFS" | grep -q '0.0.0.0/0' || { need=1; reason="missing 0.0.0.0/0"; }
echo "$PREFS" | grep -q '::/0' || { need=1; reason="missing ::/0"; }

[ "$need" = 1 ] || exit 0

now=$(date +%s)
if [ -f "$STAMP" ]; then
  last=$(cat "$STAMP" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$MIN_INTERVAL" ]; then
    log "need set ($reason) but rate-limited"
    exit 0
  fi
fi

log "tailscale set ($reason) hostname=$NAME"
if tailscale_set_full "$NAME"; then
  mkdir -p /run/box-setup 2>/dev/null || true
  echo "$now" > "$STAMP" 2>/dev/null || true
  log "set ok"
else
  log "set failed"
  exit 1
fi
exit 0
