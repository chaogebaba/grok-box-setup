#!/bin/bash
# Supervisor + worker. Recovers forwarding, NAT, sshd, and tailscaled after
# freeze/thaw. Does not mint AuthURLs. Does not pick names. Does not up.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib/common.sh"

INTERVAL="${SELFHEAL_INTERVAL:-15}"
MODE="${1:-}"

# Process alive + BackendState=Running + Online=false after freeze/thaw:
# PollNetMap is dead (long-poll timeout / context canceled). Kill that PID
# only, then start-tailscaled.sh. Not NeedsLogin. Not a new AuthURL.
recycle_offline_tailscaled() {
  local parsed backend online pid cmd now last ticks do_recycle i
  have_tailscale_cli || return 0

  parsed="$(ts status --json 2>/dev/null | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    s=d.get("Self") or {}
    print("backend="+str(d.get("BackendState") or ""))
    print("online="+("yes" if s.get("Online") else "no"))
except Exception:
    print("backend=")
    print("online=no")
' 2>/dev/null || true)"
  backend=""
  online="no"
  while IFS= read -r line; do
    case "$line" in
      backend=*) backend="${line#backend=}" ;;
      online=*)  online="${line#online=}" ;;
    esac
  done <<EOF
$parsed
EOF

  case "$backend" in
    Running) ;;
    *)
      rm -f "$RUN_DIR/offline-ticks"
      return 0
      ;;
  esac

  now=$(date +%s)
  if [ "$online" = "yes" ]; then
    echo "$now" > "$RUN_DIR/last-online" 2>/dev/null || true
    rm -f "$RUN_DIR/offline-ticks"
    return 0
  fi

  last=0
  if [ -f "$RUN_DIR/last-online" ]; then
    last=$(tr -d '[:space:]' < "$RUN_DIR/last-online" 2>/dev/null || echo 0)
  fi
  case "$last" in
    ''|*[!0-9]*) last=0 ;;
  esac

  ticks=0
  if [ -f "$RUN_DIR/offline-ticks" ]; then
    ticks=$(tr -d '[:space:]' < "$RUN_DIR/offline-ticks" 2>/dev/null || echo 0)
  fi
  case "$ticks" in
    ''|*[!0-9]*) ticks=0 ;;
  esac
  ticks=$((ticks + 1))
  echo "$ticks" > "$RUN_DIR/offline-ticks" 2>/dev/null || true

  do_recycle=0
  if [ "$last" -gt 0 ] && [ $((now - last)) -ge 30 ]; then
    do_recycle=1
  elif [ "$ticks" -ge 3 ]; then
    do_recycle=1
  fi
  [ "$do_recycle" = 1 ] || return 0

  pid=$(pgrep -n -x tailscaled 2>/dev/null || true)
  [ -n "$pid" ] || return 0
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  echo "$cmd" | grep -q -- "$STATE_DIR" || return 0

  echo "selfheal: online=no after freeze — recycle tailscaled pid=$pid"
  kill "$pid" 2>/dev/null || true
  i=0
  while [ "$i" -lt 20 ]; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    sleep 0.3
  fi
  rm -f "$RUN_DIR/last-online" "$RUN_DIR/offline-ticks"
  "$HERE/start-tailscaled.sh" || true
}

worker_tick() {
  "$HERE/health-tick-forward.sh" || true

  if ! pgrep -x sshd >/dev/null 2>&1; then
    if [ -x /usr/sbin/sshd ]; then
      /usr/sbin/sshd 2>/dev/null || true
    fi
  fi

  if ! pgrep -x tailscaled >/dev/null 2>&1; then
    "$HERE/start-tailscaled.sh" || true
  fi

  recycle_offline_tailscaled || true

  local name
  name="$(read_box_name || true)"
  case "$name" in
    grok-box-[0-9]*)
      if pgrep -x tailscaled >/dev/null 2>&1; then
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
  setsid -f bash "$HERE/tailscale-selfheal.sh" --worker >/dev/null 2>&1
  local i=0
  while [ "$i" -lt 15 ]; do
    if [ -f "$SELFHEAL_PID" ] && kill -0 "$(cat "$SELFHEAL_PID" 2>/dev/null)" 2>/dev/null; then
      break
    fi
    sleep 0.2
    i=$((i + 1))
  done
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
    if [ -f "$SELFHEAL_PID" ] && kill -0 "$(cat "$SELFHEAL_PID" 2>/dev/null)" 2>/dev/null; then
      echo "selfheal=$(cat "$SELFHEAL_PID")"
    else
      echo "selfheal=down"
    fi
    ;;
  *)        supervisor_start ;;
esac
