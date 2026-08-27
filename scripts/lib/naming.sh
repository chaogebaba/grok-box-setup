#!/bin/bash
# Pick the next free grok-box-N AFTER the node is logged in.
# See docs/NAMING.md. Do not call this while BackendState=NeedsLogin.

pick_grok_box_name() {
  python3 - "$@" <<'PY'
import json, os, re, subprocess, sys

pat = re.compile(r"^grok-box-([0-9]+)$")

def run(args, timeout=8):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return p.stdout or ""
    except Exception:
        return ""

status_txt = run(["tailscale", "status"])
self_ip = run(["tailscale", "ip", "-4"]).strip()
raw = run(["tailscale", "status", "--json"])
taken = set()

def take(name):
    if not name:
        return
    name = name.strip().rstrip(".")
    # DNSName first label
    if "." in name and name.endswith("ts.net"):
        name = name.split(".")[0]
    m = pat.match(name)
    if m:
        taken.add(int(m.group(1)))

try:
    d = json.loads(raw) if raw.strip() else {}
except json.JSONDecodeError:
    d = {}

self_obj = d.get("Self") or {}
self_ids = {
    self_obj.get("ID"),
    self_obj.get("StableID"),
    self_ip,
}

# Peers only — never count Self (often still named cursor).
for peer in (d.get("Peer") or {}).values():
    take(peer.get("HostName") or "")
    dns = peer.get("DNSName") or ""
    take(dns.split(".")[0] if dns else "")

# Column 1 of `tailscale status` for every row that is not this node.
for line in status_txt.splitlines():
    cols = line.split()
    if len(cols) < 2:
        continue
    ip, name = cols[0], cols[1]
    if self_ip and ip == self_ip:
        continue
    take(name)

n = 1
while n in taken:
    n += 1
print(f"grok-box-{n}")
PY
}
