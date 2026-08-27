#!/bin/bash
# Shared paths and tiny helpers. Sourced by every script.
# Do not execute this file directly.

: "${BOX_SETUP_ROOT:=/workspace/box-setup}"

ROOT="$BOX_SETUP_ROOT"
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Running from a git checkout before install → use the checkout as ROOT.
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
TS_SOCK="/var/run/tailscale/tailscaled.sock"
STATEDIR_FLAG="--statedir=$STATE_DIR"
CONFIG_FILE="${BOX_SETUP_CONFIG:-$ROOT/config.toml}"
DEFAULT_SSH_PASSWORD="12345678"

log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[$ts] $*"
}

have() { command -v "$1" >/dev/null 2>&1; }

# --- config.toml -------------------------------------------------------------
# A TOML subset, read with awk so this works before python3 is installed.
# Handles [table] headers, "basic" and 'literal' strings, bare values and
# # comments. See etc/config.example.toml for exactly what is supported.
read -r -d '' _BOX_TOML_AWK <<'AWK' || true
function trim(s) { sub(/^[ \t\r]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }
{
  line = trim($0)
  if (line == "" || line ~ /^#/) next
  if (line ~ /^\[.*\]$/) { sec = trim(substr(line, 2, length(line) - 2)); next }
  eq = index(line, "=")
  if (eq == 0) next
  if (sec != want_t || trim(substr(line, 1, eq - 1)) != want_k) next
  v = trim(substr(line, eq + 1))
  if (substr(v, 1, 1) == "\"") {
    out = ""; i = 2; n = length(v)
    while (i <= n) {
      c = substr(v, i, 1)
      if (c == "\\" && i < n) {
        d = substr(v, i + 1, 1)
        if (d == "n") out = out "\n"
        else if (d == "t") out = out "\t"
        else out = out d
        i += 2; continue
      }
      if (c == "\"") break
      out = out c; i++
    }
    print out; found = 1; exit
  }
  if (substr(v, 1, 1) == "'") {
    rest = substr(v, 2)
    q = index(rest, "'")
    if (q > 0) rest = substr(rest, 1, q - 1)
    print rest; found = 1; exit
  }
  h = index(v, "#")
  if (h > 0) v = trim(substr(v, 1, h - 1))
  print v; found = 1; exit
}
END { exit(found ? 0 : 1) }
AWK

# config_get <table> <key> [file] -> prints value, non-zero when unset.
config_get() {
  local file="${3:-$CONFIG_FILE}"
  [ -f "$file" ] || return 1
  awk -v want_t="$1" -v want_k="$2" "$_BOX_TOML_AWK" "$file" 2>/dev/null
}

# The password applied to root and box by ensure_sshd.
# Precedence: BOX_SSH_PASSWORD env > config.toml [ssh].password > default.
ssh_password() {
  local p=""
  if [ -n "${BOX_SSH_PASSWORD:-}" ]; then
    p="$BOX_SSH_PASSWORD"
  else
    p="$(config_get ssh password || true)"
  fi
  # chpasswd takes one user:password line. Anything that cannot survive that
  # round trip would set an unknown password and lock the box out, so refuse
  # it and keep the documented default instead.
  case "$p" in
    "")
      p="$DEFAULT_SSH_PASSWORD"
      ;;
    *[![:print:]]*)
      log "config: [ssh] password is not printable; using default" >&2
      p="$DEFAULT_SSH_PASSWORD"
      ;;
  esac
  printf '%s' "$p"
}

# Resolve a binary to an absolute path when possible.
# `tailscaled_bin` used to return the bare word "tailscaled"; `[ -x tailscaled ]`
# then tested ./tailscaled and made apt / start decisions wrong.
resolve_cmd() {
  local name="$1" p
  if [ -n "$name" ] && [ -x "$name" ]; then
    echo "$name"
    return 0
  fi
  p="$(command -v "$name" 2>/dev/null || true)"
  if [ -n "$p" ] && [ -x "$p" ]; then
    echo "$p"
    return 0
  fi
  return 1
}

tailscale_bin() {
  if [ -x "$BIN_DIR/tailscale" ]; then
    echo "$BIN_DIR/tailscale"
    return
  fi
  resolve_cmd tailscale || echo tailscale
}

tailscaled_bin() {
  if [ -x "$BIN_DIR/tailscaled" ]; then
    echo "$BIN_DIR/tailscaled"
    return
  fi
  resolve_cmd tailscaled || resolve_cmd /usr/sbin/tailscaled || echo tailscaled
}

have_tailscale_cli() {
  local b
  b="$(tailscale_bin)"
  [ -x "$b" ]
}

have_tailscaled_daemon() {
  local b
  b="$(tailscaled_bin)"
  [ -x "$b" ]
}

ts() {
  local b
  b="$(tailscale_bin)"
  timeout "${TS_TIMEOUT:-8}" "$b" "$@"
}

ensure_dirs() {
  mkdir -p "$STATE_DIR" "$SECRETS_DIR" "$BIN_DIR" "$RUN_DIR" \
    "$(dirname "$SELFHEAL_PID")" "$LOG_DIR" /var/run/tailscale /run/sshd \
    2>/dev/null || true
}

state_bytes() {
  if [ ! -f "$STATE_FILE" ]; then
    echo 0
    return
  fi
  if [ -r "$STATE_FILE" ]; then
    wc -c < "$STATE_FILE" | tr -d '[:space:]'
  else
    sudo wc -c < "$STATE_FILE" 2>/dev/null | tr -d '[:space:]' || echo 0
  fi
}

state_is_populated() {
  local n
  n="$(state_bytes)"
  n="${n:-0}"
  case "$n" in
    ''|*[!0-9]*) n=0 ;;
  esac
  [ "$n" -ge 1024 ]
}

read_box_name() {
  if [ -s "$HOSTNAME_FILE" ]; then
    tr -d '[:space:]' < "$HOSTNAME_FILE"
  fi
}

backend_state() {
  ts status --json 2>/dev/null | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get("BackendState") or "")
except Exception:
    print("")
' 2>/dev/null || true
}

wait_for_socket() {
  local i=0
  while [ "$i" -lt 25 ]; do
    if [ -S "$TS_SOCK" ] || [ -S /run/tailscale/tailscaled.sock ]; then
      return 0
    fi
    sleep 0.2
    i=$((i + 1))
  done
  return 1
}

# Wait until backend is Running / NeedsLogin / Stopped, or timeout.
# NoState right after start is not NeedsLogin and not a reason to mint AuthURL.
wait_for_backend() {
  local i=0 st
  while [ "$i" -lt 20 ]; do
    st="$(backend_state)"
    case "$st" in
      Running|NeedsLogin|Stopped|Starting)
        echo "$st"
        return 0
        ;;
    esac
    sleep 0.5
    i=$((i + 1))
  done
  echo "${st:-NoState}"
  return 1
}

# Full flag set. Prefer operator=box; fall back to root if that user cannot talk
# to the daemon yet (first join, operator not written).
tailscale_set_full() {
  local name="$1"
  local b
  b="$(tailscale_bin)"
  [ -x "$b" ] || return 1
  if id box >/dev/null 2>&1 && sudo -n -u box "$b" set --hostname="$name" \
      --ssh=false --operator=box --advertise-exit-node \
      --snat-subnet-routes=true --stateful-filtering=false 2>/dev/null; then
    return 0
  fi
  "$b" set --hostname="$name" --ssh=false --operator=box \
    --advertise-exit-node --snat-subnet-routes=true \
    --stateful-filtering=false
}
