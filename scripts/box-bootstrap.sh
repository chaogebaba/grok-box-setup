#!/bin/bash
# Restore contract. Always invoke THIS path after an image swap.
#   --once     ensure + one health tick + print status
#   --ensure   packages, helpers, sshd, sysctl, hook
#   --status   print the one-line health string
#   --stop     selfheal loop only
#   (default)  ensure + daemonize selfheal
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib/common.sh"

usage() {
  sed -n '2,8p' "$0"
}

ensure_packages() {
  if ! have apt-get; then
    return 0
  fi
  export DEBIAN_FRONTEND=noninteractive
  if [ ! -x "$(tailscaled_bin)" ] || [ ! -x /usr/sbin/sshd ]; then
    apt-get update -qq || true
    apt-get install -y -qq --no-install-recommends \
      openssh-server iptables nftables ca-certificates curl python3 \
      iproute2 procps sudo 2>/dev/null || true
  fi
  if [ ! -x "$(tailscaled_bin)" ]; then
    # Official Tailscale repo is optional; ignore failure — vendored bin wins later.
    if [ ! -f /usr/share/keyrings/tailscale-archive-keyring.gpg ]; then
      curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg \
        -o /usr/share/keyrings/tailscale-archive-keyring.gpg 2>/dev/null || true
    fi
    apt-get install -y -qq tailscale 2>/dev/null || \
      dpkg --force-confold --configure tailscale 2>/dev/null || true
  fi
  # Vendor bins so the next overlay skip can use $ROOT/bin
  mkdir -p "$BIN_DIR"
  if [ -x /usr/bin/tailscale ] && [ ! -x "$BIN_DIR/tailscale" ]; then
    cp -a /usr/bin/tailscale "$BIN_DIR/tailscale" 2>/dev/null || true
  fi
  if [ -x /usr/sbin/tailscaled ] && [ ! -x "$BIN_DIR/tailscaled" ]; then
    cp -a /usr/sbin/tailscaled "$BIN_DIR/tailscaled" 2>/dev/null || true
  fi
}

install_helpers_to_usr() {
  mkdir -p /usr/local/sbin
  for s in box-bootstrap.sh start-tailscaled.sh tailscale-selfheal.sh \
           ensure-ip-forward.sh refresh-exitnode-if-needed.sh \
           health-tick-forward.sh tailscale-exitnode-nat.sh; do
    if [ -f "$HERE/$s" ]; then
      install -m 0755 "$HERE/$s" "/usr/local/sbin/$s" 2>/dev/null || true
    fi
  done
  mkdir -p /usr/local/sbin/lib
  if [ -d "$HERE/lib" ]; then
    cp -a "$HERE/lib/." /usr/local/sbin/lib/ 2>/dev/null || true
  fi
  if [ -f "$ROOT/etc/default-tailscaled" ]; then
    mkdir -p /etc/default
    cp -a "$ROOT/etc/default-tailscaled" /etc/default/tailscaled 2>/dev/null || true
  fi
}

ensure_sshd() {
  mkdir -p /run/sshd /etc/ssh
  if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
    ssh-keygen -A >/dev/null 2>&1 || true
  fi
  # Listen on all addresses, not only the Tailscale IP.
  if [ -f /etc/ssh/sshd_config ]; then
    grep -q '^ListenAddress 0.0.0.0' /etc/ssh/sshd_config 2>/dev/null || \
      echo 'ListenAddress 0.0.0.0' >> /etc/ssh/sshd_config
    grep -q '^ListenAddress ::' /etc/ssh/sshd_config 2>/dev/null || \
      echo 'ListenAddress ::' >> /etc/ssh/sshd_config
    sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config 2>/dev/null || true
    sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config 2>/dev/null || true
  fi
  if ! pgrep -x sshd >/dev/null 2>&1 && [ -x /usr/sbin/sshd ]; then
    /usr/sbin/sshd 2>/dev/null || true
  fi
}

maybe_login_up() {
  # Only when statedir is empty AND backend is NeedsLogin.
  local backend auth=""
  backend=$(timeout 5 tailscale status --json 2>/dev/null | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin); print(d.get("BackendState") or "")
except Exception:
    print("")
' 2>/dev/null || true)

  case "$backend" in
    Running|Starting) return 0 ;;
    NoState)
      sleep 2
      return 0
      ;;
  esac

  if state_is_populated; then
    return 0
  fi

  case "$backend" in
    NeedsLogin|Stopped|"") ;;
    *) return 0 ;;
  esac

  local up=(tailscale up --ssh=false --operator=box
            --advertise-exit-node --accept-dns
            --snat-subnet-routes=true --timeout=25s)

  if [ -s "$AUTHKEY_FILE" ]; then
    echo "bootstrap: auth-key join (statedir empty)"
    "${up[@]}" --auth-key="file:$AUTHKEY_FILE" || \
      "${up[@]}" --auth-key="$(tr -d '[:space:]' < "$AUTHKEY_FILE")" || true
  else
    echo "bootstrap: minting AuthURL (statedir empty, no key)"
    "${up[@]}" || true
  fi
}

print_status() {
  local backend="unknown" online="no" exitn="no" sshd="down"
  local ts_pid sh_pid wrk_pid hb="-"
  local ipfwd="4:?,6:?" auth=""

  local v4 v6
  v4=$(tr -d '[:space:]' < /proc/sys/net/ipv4/ip_forward 2>/dev/null || echo 0)
  v6=$(tr -d '[:space:]' < /proc/sys/net/ipv6/conf/all/forwarding 2>/dev/null || echo 0)
  ipfwd="4:${v4},6:${v6}"

  ts_pid=$(pgrep -n -x tailscaled 2>/dev/null || echo "")
  if [ -f "$SELFHEAL_PID" ]; then
    sh_pid=$(tr -d '[:space:]' < "$SELFHEAL_PID")
    if [ -n "$sh_pid" ] && kill -0 "$sh_pid" 2>/dev/null; then
      wrk_pid="$sh_pid"
    else
      sh_pid=""
    fi
  fi
  if [ -f "$RUN_DIR/hb" ]; then
    local now last
    now=$(date +%s)
    last=$(tr -d '[:space:]' < "$RUN_DIR/hb" 2>/dev/null || echo 0)
    if [ -n "$last" ] && [ "$last" -gt 0 ] 2>/dev/null; then
      hb="$((now - last))s"
    fi
  fi

  if pgrep -x sshd >/dev/null 2>&1; then
    sshd="up"
  fi

  if have tailscale; then
    eval "$(timeout 8 tailscale status --json 2>/dev/null | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
    s=d.get("Self") or {}
    print("backend="+str(d.get("BackendState") or "unknown"))
    print("online="+("yes" if s.get("Online") else "no"))
    print("exitn="+("yes" if s.get("ExitNodeOption") else "no"))
    ba=d.get("AuthURL") or ""
    print("auth="+ba)
except Exception:
    print("backend=unknown")
    print("online=no")
    print("exitn=no")
    print("auth=")
' 2>/dev/null || true)"
  fi

  printf 'backend=%s online=%s exit-node=%s sshd=%s ipfwd=%s tailscaled=%s selfheal=%s worker=%s hb=%s' \
    "${backend:-unknown}" "${online:-no}" "${exitn:-no}" "$sshd" "$ipfwd" \
    "${ts_pid:--}" "${sh_pid:--}" "${wrk_pid:--}" "$hb"
  if [ -n "${auth:-}" ]; then
    printf ' auth=%s' "$auth"
  fi
  printf '\n'
}

do_ensure() {
  ensure_dirs
  ensure_packages
  install_helpers_to_usr
  ensure_sshd
  "$HERE/ensure-ip-forward.sh" || true
  "$HERE/start-tailscaled.sh" || true
  sleep 1
  maybe_login_up
  "$HERE/health-tick-forward.sh" || true
}

do_once() {
  do_ensure
  "$HERE/tailscale-selfheal.sh" || true
  "$HERE/tailscale-selfheal.sh" --tick || true
  print_status
}

do_default() {
  do_ensure
  "$HERE/tailscale-selfheal.sh" || true
  print_status
}

cmd="${1:-}"
case "$cmd" in
  -h|--help) usage ;;
  --once)    do_once ;;
  --ensure)  do_ensure ;;
  --status)  print_status ;;
  --stop)    "$HERE/tailscale-selfheal.sh" --stop ;;
  "")        do_default ;;
  *)
    echo "unknown flag: $cmd" >&2
    usage >&2
    exit 2
    ;;
esac
