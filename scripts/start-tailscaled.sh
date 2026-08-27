#!/bin/bash
# Start exactly one tailscaled bound to the workspace statedir.
# No systemd. No pkill -f. Child closes flock fd 8 so a later start is not wedged.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib/common.sh"

ensure_dirs

DAEMON="$(tailscaled_bin)"
if [ ! -x "$DAEMON" ]; then
  echo "start-tailscaled: no tailscaled binary (install tailscale or vendor bin/)" >&2
  exit 1
fi

if [ ! -e /dev/net/tun ]; then
  echo "start-tailscaled: /dev/net/tun missing — kernel TUN required, no userspace netstack" >&2
  exit 1
fi

# Kill every stray daemon (dpkg default on /var/lib/tailscale). Keep the one
# that already uses our statedir. Never pkill -f.
keep=""
for pid in $(pgrep -x tailscaled 2>/dev/null || true); do
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  if echo "$cmd" | grep -q -- "$STATE_DIR"; then
    if [ -z "$keep" ]; then
      keep="$pid"
    else
      echo "start-tailscaled: extra statedir daemon pid=$pid — stopping"
      kill "$pid" 2>/dev/null || true
    fi
  else
    echo "start-tailscaled: stopping stray pid=$pid (wrong statedir)"
    kill "$pid" 2>/dev/null || true
  fi
done
sleep 0.4
for pid in $(pgrep -x tailscaled 2>/dev/null || true); do
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  if echo "$cmd" | grep -q -- "$STATE_DIR"; then
    continue
  fi
  kill -9 "$pid" 2>/dev/null || true
done

if [ -n "$keep" ] && kill -0 "$keep" 2>/dev/null; then
  echo "start-tailscaled: already running pid=$keep statedir=$STATE_DIR"
  exit 0
fi

mkdir -p /run /var/run/tailscale "$STATE_DIR" "$(dirname "$TAILSCALED_LOG")"
touch "$TAILSCALED_LOG" 2>/dev/null || true

export TS_DEBUG_FIREWALL_MODE="${TS_DEBUG_FIREWALL_MODE:-nftables}"

exec 8>"$LOCK_FILE"
if ! flock -n 8; then
  wait_for_socket || true
  if pgrep -x tailscaled >/dev/null 2>&1; then
    echo "start-tailscaled: lock busy, daemon present"
    exit 0
  fi
  echo "start-tailscaled: lock busy ($LOCK_FILE)" >&2
  exit 1
fi

setsid -f env TS_DEBUG_FIREWALL_MODE="$TS_DEBUG_FIREWALL_MODE" \
  "$DAEMON" \
    --statedir="$STATE_DIR" \
    --socket="$TS_SOCK" \
    --tun=tailscale0 \
    --port=41641 \
    8<&- >>"$TAILSCALED_LOG" 2>&1

wait_for_socket || true
pid=$(pgrep -n -x tailscaled 2>/dev/null || true)
echo "start-tailscaled: pid=${pid:-?} statedir=$STATE_DIR firewall=$TS_DEBUG_FIREWALL_MODE"
exit 0
