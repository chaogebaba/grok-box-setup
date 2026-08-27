#!/bin/bash
# Start exactly one tailscaled bound to the workspace statedir.
# No systemd. No pkill -f. Child closes flock fd 8 so a later start is not wedged.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib/common.sh"

ensure_dirs

DAEMON="$(tailscaled_bin)"
if [ ! -x "$DAEMON" ] && ! have "$DAEMON"; then
  echo "start-tailscaled: no tailscaled binary" >&2
  exit 1
fi

# Already running with the right statedir?
if pid=$(pgrep -n -x tailscaled 2>/dev/null); then
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  if echo "$cmd" | grep -q -- "$STATE_DIR"; then
    echo "start-tailscaled: already running pid=$pid statedir=$STATE_DIR"
    exit 0
  fi
  echo "start-tailscaled: stopping stray pid=$pid (wrong statedir or default dpkg daemon)"
  kill "$pid" 2>/dev/null || true
  sleep 1
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
fi

mkdir -p /run /var/run/tailscale "$STATE_DIR" "$(dirname "$TAILSCALED_LOG")"
touch "$TAILSCALED_LOG"

export TS_DEBUG_FIREWALL_MODE="${TS_DEBUG_FIREWALL_MODE:-nftables}"

# flock on fd 8; child drops it (8<&-).
exec 8>"$LOCK_FILE"
if ! flock -n 8; then
  echo "start-tailscaled: lock busy ($LOCK_FILE)" >&2
  exit 1
fi

setsid -f env TS_DEBUG_FIREWALL_MODE="$TS_DEBUG_FIREWALL_MODE" \
  "$DAEMON" \
    --statedir="$STATE_DIR" \
    --tun=tailscale0 \
    --port=41641 \
    8<&- >>"$TAILSCALED_LOG" 2>&1

sleep 0.4
pid=$(pgrep -n -x tailscaled 2>/dev/null || true)
echo "start-tailscaled: pid=${pid:-?} statedir=$STATE_DIR firewall=$TS_DEBUG_FIREWALL_MODE"
exit 0
