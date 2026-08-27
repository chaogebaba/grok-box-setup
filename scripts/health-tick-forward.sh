#!/bin/bash
# One forwarding/NAT/Hostinfo tick. Call at the start of every --once and
# every selfheal loop. Order: sysctl → NAT → refresh.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"

run() {
  local s="$1"
  if [ -x "$s" ]; then
    "$s" || true
  elif [ -f "$s" ]; then
    bash "$s" || true
  fi
}

run "$HERE/ensure-ip-forward.sh"
run "$HERE/tailscale-exitnode-nat.sh"

if [ -S /var/run/tailscale/tailscaled.sock ] || [ -S /run/tailscale/tailscaled.sock ]; then
  run "$HERE/refresh-exitnode-if-needed.sh"
fi
exit 0
