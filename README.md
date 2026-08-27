# grok-box-setup

OpenSSH + Tailscale **exit node** for a Debian 13 Grok/sand box
(no systemd, container sleeps, overlay gets wiped).

An AI agent clones this repo, runs `install.sh`, and follows
[`docs/AGENT.md`](docs/AGENT.md) + [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

```
hourly keep-alive  →  box-bootstrap.sh --once
                   →  enable IPv4+IPv6 forwarding
                   →  nft NAT for Docker FORWARD DROP
                   →  one tailscaled, statedir under /workspace
                   →  advertise 0.0.0.0/0 and ::/0
```

## Why this exists

The admin console dialog *“Unable to relay traffic — This machine has IP
forwarding disabled”* appears after the box sleeps or the image is swapped.
Forwarding is per-netns and Docker defaults it to `0`. IPv4-only is not
enough; IPv6 forwarding must also be `1`. v4 of this repo re-applies that
on every health tick and refreshes Tailscale Hostinfo so the banner clears.

## Quick start (on the box)

```bash
git clone https://github.com/chaogebaba/grok-box-setup.git /tmp/grok-box-setup
sudo /tmp/grok-box-setup/install.sh
sudo /workspace/box-setup/box-bootstrap.sh --once
```

If the status line contains `auth=https://login.tailscale.com/…`, open it and
click **Connect**. Then let the agent pick the next free `grok-box-N`
([`docs/NAMING.md`](docs/NAMING.md)) and approve **Use as exit node** in the
admin console once.

Human clicks: Connect, then approve exit-node routes. Everything else is scripted.

## Layout

```
.
├── install.sh                 # seed /workspace/box-setup from this checkout
├── docs/
│   ├── AGENT.md               # start here if you are an AI agent
│   ├── RUNBOOK.md             # procedures A–G
│   ├── ARCHITECTURE.md        # platform, persistence, contract
│   ├── NAMING.md              # grok-box-N algorithm
│   └── TROUBLESHOOTING.md
├── scripts/
│   ├── box-bootstrap.sh       # restore entrypoint (--once/--status/--stop)
│   ├── start-tailscaled.sh    # one daemon, workspace statedir, flock
│   ├── tailscale-selfheal.sh  # supervisor + worker
│   ├── health-tick-forward.sh
│   ├── ensure-ip-forward.sh
│   ├── refresh-exitnode-if-needed.sh
│   ├── tailscale-exitnode-nat.sh
│   └── lib/
├── etc/default-tailscaled
├── state/tailscale/           # empty in git — THIS box's login after Connect
└── secrets/                   # optional ts-authkey, never committed
```

`install.sh` flattens `scripts/*.sh` onto `/workspace/box-setup/` so the
runbook paths stay short (`sudo /workspace/box-setup/box-bootstrap.sh`).

## Status line

```
backend=Running online=yes exit-node=yes sshd=up ipfwd=4:1,6:1 tailscaled=… selfheal=… hb=…s
```

`ipfwd=4:0` or `6:0` is the relay bug. It is not a new login.

## Never

`systemctl`, `pkill -f`, cron, a second `tailscaled`, Tailscale SSH,
a partial `tailscale up`, copying `state/tailscale` between boxes,
guessing `grok-box-N` before Connect.

## License

MIT. See [LICENSE](LICENSE).
