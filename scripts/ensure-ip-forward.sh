#!/bin/bash
# Force IPv4 + IPv6 forwarding in this netns. Safe on every health tick.
# Admin console "IP forwarding disabled / cannot relay" fires if EITHER is 0.
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
# After install, scripts live at $BOX_SETUP_ROOT/; lib is beside them or in lib/.
# shellcheck source=/dev/null
[ -f "$ROOT/lib/common.sh" ] && . "$ROOT/lib/common.sh"
[ -f "$ROOT/scripts/lib/common.sh" ] && . "$ROOT/scripts/lib/common.sh"

log() { echo "ensure-ip-forward: $*" >&2; }

write_proc() {
  local path="$1" val="$2"
  [ -e "$path" ] || return 0
  local cur
  cur=$(tr -d '[:space:]' < "$path" 2>/dev/null || echo "")
  [ "$cur" = "$val" ] && return 0
  if echo "$val" > "$path" 2>/dev/null; then
    return 0
  fi
  local key="${path#/proc/sys/}"
  key="${key//\//.}"
  sysctl -w "${key}=${val}" >/dev/null 2>&1 || return 1
}

if [ -d /etc/sysctl.d ] || mkdir -p /etc/sysctl.d 2>/dev/null; then
  cat > /etc/sysctl.d/99-tailscale-exitnode.conf 2>/dev/null <<'EOF' || true
net.ipv4.ip_forward = 1
net.ipv4.conf.all.forwarding = 1
net.ipv4.conf.default.forwarding = 1
net.ipv6.conf.all.forwarding = 1
net.ipv6.conf.default.forwarding = 1
net.ipv4.conf.all.src_valid_mark = 1
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
EOF
  sysctl -p /etc/sysctl.d/99-tailscale-exitnode.conf >/dev/null 2>&1 || true
fi

CHANGED=0
for p in \
  /proc/sys/net/ipv4/ip_forward \
  /proc/sys/net/ipv4/conf/all/forwarding \
  /proc/sys/net/ipv4/conf/default/forwarding \
  /proc/sys/net/ipv6/conf/all/forwarding \
  /proc/sys/net/ipv6/conf/default/forwarding \
  /proc/sys/net/ipv4/conf/all/src_valid_mark
do
  before=$(tr -d '[:space:]' < "$p" 2>/dev/null || echo "")
  write_proc "$p" 1 || log "cannot write $p (need NET_ADMIN)"
  after=$(tr -d '[:space:]' < "$p" 2>/dev/null || echo "")
  [ "$before" != "$after" ] && CHANGED=1
done

write_proc /proc/sys/net/ipv4/conf/all/rp_filter 2 || true
write_proc /proc/sys/net/ipv4/conf/default/rp_filter 2 || true

if [ -d /proc/sys/net/ipv6/conf ]; then
  for d in /proc/sys/net/ipv6/conf/*/forwarding; do
    [ -e "$d" ] || continue
    case "$d" in
      */lo/forwarding) continue ;;
    esac
    write_proc "$d" 1 || true
  done
fi

V4=$(tr -d '[:space:]' < /proc/sys/net/ipv4/ip_forward 2>/dev/null || echo 0)
V6=$(tr -d '[:space:]' < /proc/sys/net/ipv6/conf/all/forwarding 2>/dev/null || echo 0)

mkdir -p /run/box-setup 2>/dev/null || true
{
  echo "ipfwd_v4=${V4}"
  echo "ipfwd_v6=${V6}"
  echo "changed=${CHANGED}"
  echo "ts=$(date +%s)"
} > /run/box-setup/ipfwd.env 2>/dev/null || true

echo "ipfwd=4:${V4},6:${V6}"

if [ "$V4" != 1 ] || [ "$V6" != 1 ]; then
  log "forwarding still off (v4=${V4} v6=${V6})"
  exit 1
fi
exit 0
