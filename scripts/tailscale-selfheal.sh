#!/bin/bash
# Supervisor + worker. Recovers forwarding, NAT, sshd, and tailscaled after
# freeze/thaw. Does not mint AuthURLs. Does not pick names. Does not up.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib/common.sh"

INTERVAL="${SELFHEAL_INTERVAL:-15}"
# hb older than this ⇒ the box (and this worker) was frozen.
FREEZE_SECS="${SELFHEAL_FREEZE_SECS:-60}"
MODE="${1:-}"

hb_age() {
  local now prev
  now=$(date +%s)
  prev=0
  if [ -f "$RUN_DIR/hb" ]; then
    prev=$(tr -d '[:space:]' < "$RUN_DIR/hb" 2>/dev/null || echo 0)
  fi
  case "$prev" in
    ''|*[!0-9]*) prev=0 ;;
  esac
  if [ "$prev" -le 0 ]; then
    echo 0
    return 0
  fi
  echo $((now - prev))
}

parse_ts() {
  have_tailscale_cli || {
    echo "backend="
    echo "online=no"
    echo "mapfail=no"
    return 0
  }
  ts status --json 2>/dev/null | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    s=d.get("Self") or {}
    health=" ".join(str(x) for x in (d.get("Health") or []))
    h=health.lower()
    mapfail=("coordination server" in h) or ("not-in-map-poll" in h) or ("pollnetmap" in h)
    print("backend="+str(d.get("BackendState") or ""))
    print("online="+("yes" if s.get("Online") else "no"))
    print("mapfail="+("yes" if mapfail else "no"))
except Exception:
    print("backend=")
    print("online=no")
    print("mapfail=no")
' 2>/dev/null || true
}

read_parsed() {
  backend=""
  online="no"
  mapfail="no"
  while IFS= read -r line; do
    case "$line" in
      backend=*) backend="${line#backend=}" ;;
      online=*)  online="${line#online=}" ;;
      mapfail=*) mapfail="${line#mapfail=}" ;;
    esac
  done <<EOF
$(parse_ts)
EOF
}

# Kill that PID only, then start-tailscaled.sh. Same statedir. Never pkill -f.
recycle_tailscaled() {
  local reason="$1" pid cmd i
  pid=$(pgrep -n -x tailscaled 2>/dev/null || true)
  [ -n "$pid" ] || return 0
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  echo "$cmd" | grep -q -- "$STATE_DIR" || return 0

  echo "selfheal: $reason — recycle tailscaled pid=$pid"
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

# After freeze/thaw, Online=false lags (map long-poll is ~2 min). hb age is
# the wake signal. Rebind first; recycle immediately if already not in-map.
maybe_wake_recycle() {
  local age
  age=$(hb_age)
  case "$age" in
    ''|*[!0-9]*) age=0 ;;
  esac
  [ "$age" -ge "$FREEZE_SECS" ] || return 0

  echo "selfheal: time jump ${age}s (hb) — rebind"
  ts debug rebind >/dev/null 2>&1 || true
  ts debug restun >/dev/null 2>&1 || true

  read_parsed
  if [ "$online" = "yes" ] && [ "$mapfail" != "yes" ]; then
    return 0
  fi
  recycle_tailscaled "time jump ${age}s and online=${online:-?} mapfail=${mapfail:-?}"
}

# Process alive + Running + (Online=false or map-poll Health) after freeze/thaw.
# Not NeedsLogin. Not a new AuthURL.
recycle_offline_tailscaled() {
  local now last ticks do_recycle
  read_parsed

  case "$backend" in
    Running) ;;
    *)
      rm -f "$RUN_DIR/offline-ticks"
      return 0
      ;;
  esac

  now=$(date +%s)
  if [ "$online" = "yes" ] && [ "$mapfail" != "yes" ]; then
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

  recycle_tailscaled "online=${online} mapfail=${mapfail} after freeze"
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
  else
    maybe_wake_recycle || true
    recycle_offline_tailscaled || true
  fi

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
  echo "selfheal-worker pid=$$ interval=$INTERVAL freeze=${FREEZE_SECS}s" >>"$SELFHEAL_LOG"
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
