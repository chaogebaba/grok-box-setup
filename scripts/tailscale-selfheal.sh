#!/bin/bash
# Supervisor + worker. Recovers forwarding, NAT, sshd, and tailscaled after
# freeze/thaw. Does not mint AuthURLs. Does not pick names. Does not up.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib/common.sh"

INTERVAL="${SELFHEAL_INTERVAL:-15}"
MODE="${1:-}"

worker_tick() {
  "$HERE/health-tick-forward.sh" || true

  if ! pgrep -x sshd >/dev/null 2>&1; then
    if [ -x /usr/sbin/sshd ]; then
      /usr/sbin/sshd -D 2>/dev/null &
    fi
  fi

  if ! pgrep -n -x tailscaled >/dev/null 2>&1; then
    "$HERE/start-tailscaled.sh" || true
  fi

  # If we already have a grok-box-N name, keep prefs from drifting.
  local name
  name="$(read_box_name || true)"
  case "$name" in
    grok-box-[0-9]*)
      if pgrep -n -x tailscaled >/dev/null 2>&1; then
        "$HERE/refresh-exitnode-if-needed.sh" || true
      fi
      ;;
  esac

  date +%s > "$RUN_DIR/hb" 2>/dev/null || true
}

worker_loop() {
  ensure_dirs
  echo $$ > "$SELFHEAL_PID"
  echo "selfheal-worker pid=$$ interval=$INTERVAL" >>"$SELFHEAL_LOG"
  while true; do
    worker_tick >>"$SELFHEAL_LOG" 2>&1 || true
    sleep "$INTERVAL"
  done
}

supervisor_start() {
  ensure_dirs
  if [ -f "$SELFHEAL_PID" ]; then
    old=$(cat "$SELFHEAL_PID" 2>/dev/null || echo "")
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
      echo "selfheal: already running pid=$old"
      return 0
    fi
  fi
  # sudoers use_pty — setsid so HUP cannot kill the worker.
  setsid -f "$HERE/tailscale-selfheal.sh" --worker >/dev/null 2>&1
  sleep 0.3
  echo "selfheal: started pid=$(cat "$SELFHEAL_PID" 2>/dev/null || echo '?')"
}

supervisor_stop() {
  if [ -f "$SELFHEAL_PID" ]; then
    old=$(cat "$SELFHEAL_PID" 2>/dev/null || echo "")
    if [ -n "$old" ]; then
      kill "$old" 2>/dev/null || true
    fi
    rm -f "$SELFHEAL_PID"
  fi
  echo "selfheal: stopped (tailscaled left running)"
}

case "$MODE" in
  --worker) worker_loop ;;
  --tick)   worker_tick ;;
  --stop)   supervisor_stop ;;
  --status)
    if [ -f "$SELFHEAL_PID" ] && kill -0 "$(cat "$SELFHEAL_PID")" 2>/dev/null; then
      echo "selfheal=$(cat "$SELFHEAL_PID")"
    else
      echo "selfheal=down"
    fi
    ;;
  *)        supervisor_start ;;
esac
