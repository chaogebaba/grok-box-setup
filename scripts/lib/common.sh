#!/bin/bash
# Shared paths and tiny helpers. Sourced by every script.
# Do not execute this file directly.

: "${BOX_SETUP_ROOT:=/workspace/box-setup}"

ROOT="$BOX_SETUP_ROOT"
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# When running from a git checkout before install, fall back to repo root.
if [ ! -d "$ROOT/state" ] && [ -d "$LIB_DIR/../../state" ]; then
  ROOT="$(cd "$LIB_DIR/../.." && pwd)"
fi

STATE_DIR="$ROOT/state/tailscale"
STATE_FILE="$STATE_DIR/tailscaled.state"
HOSTNAME_FILE="$ROOT/hostname"
SECRETS_DIR="$ROOT/secrets"
AUTHKEY_FILE="$SECRETS_DIR/ts-authkey"
BIN_DIR="$ROOT/bin"
RUN_DIR="${BOX_SETUP_RUN:-/run/box-setup}"
LOG_DIR="${BOX_SETUP_LOG:-/var/log}"
SELFHEAL_PID="/run/tailscale-selfheal.pid"
SELFHEAL_LOG="$LOG_DIR/tailscale-selfheal.log"
BOOTSTRAP_LOG="$LOG_DIR/box-bootstrap.log"
TAILSCALED_LOG="$LOG_DIR/tailscaled.log"
LOCK_FILE="/run/tailscaled.start.lock"
STATEDIR_FLAG="--statedir=$STATE_DIR"

log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[$ts] $*"
}

log_file() {
  local f="$1"; shift
  mkdir -p "$(dirname "$f")" 2>/dev/null || true
  log "$@" | tee -a "$f" >/dev/null
  log "$@"
}

have() { command -v "$1" >/dev/null 2>&1; }

tailscale_bin() {
  if [ -x "$BIN_DIR/tailscale" ]; then
    echo "$BIN_DIR/tailscale"
  elif have tailscale; then
    command -v tailscale
  else
    echo tailscale
  fi
}

tailscaled_bin() {
  if [ -x "$BIN_DIR/tailscaled" ]; then
    echo "$BIN_DIR/tailscaled"
  elif have tailscaled; then
    command -v tailscaled
  elif [ -x /usr/sbin/tailscaled ]; then
    echo /usr/sbin/tailscaled
  else
    echo tailscaled
  fi
}

ensure_dirs() {
  mkdir -p "$STATE_DIR" "$SECRETS_DIR" "$BIN_DIR" "$RUN_DIR" \
    "$(dirname "$SELFHEAL_PID")" "$LOG_DIR" 2>/dev/null || true
}

state_bytes() {
  if [ ! -f "$STATE_FILE" ]; then
    echo 0
    return
  fi
  # mode 600 root — must use sudo-capable read; wc -c is the contract
  if [ -r "$STATE_FILE" ]; then
    wc -c < "$STATE_FILE" | tr -d '[:space:]'
  else
    sudo wc -c < "$STATE_FILE" 2>/dev/null | tr -d '[:space:]' || echo 0
  fi
}

state_is_populated() {
  local n
  n="$(state_bytes)"
  [ "${n:-0}" -ge 1024 ]
}

read_box_name() {
  if [ -s "$HOSTNAME_FILE" ]; then
    tr -d '[:space:]' < "$HOSTNAME_FILE"
  fi
}

ts_cmd() {
  local bin
  bin="$(tailscale_bin)"
  timeout "${TS_TIMEOUT:-8}" "$bin" "$@"
}

python_json() {
  python3 -c "$1"
}
