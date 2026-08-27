#!/bin/bash
# Docker FORWARD DROP + missing masquerade = exit node "connected" with no WAN.
# Re-apply every tick; nft tables die with the overlay. Does not touch tailscaled.
set -u

if command -v nft >/dev/null 2>&1; then
  nft list table ip ts-exitfix >/dev/null 2>&1 || nft add table ip ts-exitfix
  nft list chain ip ts-exitfix postrouting >/dev/null 2>&1 || \
    nft add chain ip ts-exitfix postrouting '{ type nat hook postrouting priority 100; }'
  nft list chain ip ts-exitfix forward >/dev/null 2>&1 || \
    nft add chain ip ts-exitfix forward '{ type filter hook forward priority 0; }'
  nft list chain ip ts-exitfix postrouting 2>/dev/null | grep -q masquerade || \
    nft add rule ip ts-exitfix postrouting oifname != "lo" masquerade
  nft list chain ip ts-exitfix forward 2>/dev/null | grep -q 'iifname "tailscale0"' || \
    nft add rule ip ts-exitfix forward iifname "tailscale0" accept
  nft list chain ip ts-exitfix forward 2>/dev/null | grep -q 'oifname "tailscale0"' || \
    nft add rule ip ts-exitfix forward oifname "tailscale0" accept

  nft list table ip6 ts-exitfix >/dev/null 2>&1 || nft add table ip6 ts-exitfix
  nft list chain ip6 ts-exitfix postrouting >/dev/null 2>&1 || \
    nft add chain ip6 ts-exitfix postrouting '{ type nat hook postrouting priority 100; }'
  nft list chain ip6 ts-exitfix forward >/dev/null 2>&1 || \
    nft add chain ip6 ts-exitfix forward '{ type filter hook forward priority 0; }'
  nft list chain ip6 ts-exitfix output >/dev/null 2>&1 || \
    nft add chain ip6 ts-exitfix output '{ type filter hook output priority 0; }'
  nft list chain ip6 ts-exitfix postrouting 2>/dev/null | grep -q masquerade || \
    nft add rule ip6 ts-exitfix postrouting oifname != "lo" masquerade
  nft list chain ip6 ts-exitfix forward 2>/dev/null | grep -q 'iifname "tailscale0"' || \
    nft add rule ip6 ts-exitfix forward iifname "tailscale0" accept
  nft list chain ip6 ts-exitfix forward 2>/dev/null | grep -q 'oifname "tailscale0"' || \
    nft add rule ip6 ts-exitfix forward oifname "tailscale0" accept
  nft list chain ip6 ts-exitfix output 2>/dev/null | grep -q reject || \
    nft add rule ip6 ts-exitfix output oifname != "lo" oifname != "tailscale0" reject
fi

if command -v iptables-legacy >/dev/null 2>&1; then
  iptables-legacy -C DOCKER-USER -j ACCEPT 2>/dev/null || \
    iptables-legacy -I DOCKER-USER 1 -j ACCEPT 2>/dev/null || \
    iptables-legacy -A DOCKER-USER -j ACCEPT 2>/dev/null || true
  iptables-legacy -C FORWARD -i tailscale0 -j ACCEPT 2>/dev/null || \
    iptables-legacy -I FORWARD 1 -i tailscale0 -j ACCEPT 2>/dev/null || true
  iptables-legacy -C FORWARD -o tailscale0 -j ACCEPT 2>/dev/null || \
    iptables-legacy -I FORWARD 1 -o tailscale0 -j ACCEPT 2>/dev/null || true
fi

if command -v ip >/dev/null 2>&1; then
  ip -6 route show default 2>/dev/null | grep -q prohibit || \
    ip -6 route replace prohibit default 2>/dev/null || true
fi

exit 0
