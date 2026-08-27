# Architecture

## Platform

- Debian 13, PID 1 is tini, Docker present
- **No systemd**, no Linux cron, no `/usr` bind-mount
- Box sleeps after a few idle minutes and freezes in-box processes
- “Update Grok Bot’s Computer” recreates the container overlay
- OS hostname is `cursor` — ignore it. Tailscale name is `grok-box-N`

SSH: user `box` / `root`, password `12345678`, listen `0.0.0.0:22` and `[::]:22`.
`box` has passwordless sudo. `sudoers` has `use_pty` — keep-alives must `setsid -f`.

Firewall: `TS_DEBUG_FIREWALL_MODE=nftables` (log: `nftables mode`,
`firewallmode="nft-forced"`). Kernel TUN required. No userspace networking.

## What survives an image swap

| Survives | Dies with the overlay |
|---|---|
| `/workspace` (this install) | apt packages, `/usr/local/sbin` |
| `/home/box` except caches | `/var/lib/tailscale` (unless statedir is under `/workspace`) |
| `state/tailscale/` = the login | `/etc/**` including `sysctl.d` |
| `hostname` file | `/proc/sys/net/*/forwarding` |
| vendored `bin/` | nft `ts-exitfix`, `/run/**`, live processes |

## Contract

```
hourly keep-alive
  sudo /workspace/box-setup/box-bootstrap.sh --once
        → health-tick-forward.sh
             → ensure-ip-forward.sh
             → tailscale-exitnode-nat.sh
             → refresh-exitnode-if-needed.sh
        → apt OpenSSH/nft/tailscale if missing
        → copy helpers onto /usr
        → sshd, start tailscaled --statedir=…/state/tailscale
        → NeedsLogin + empty statedir:
             secrets/ts-authkey → up --auth-key=…
             else → up (full flags, 25s) to mint AuthURL
        → selfheal supervisor + worker
```

After login, only `tailscale set` with the **full** flag set. Never a second
partial `up`. `--accept-dns` is an `up` flag; `set` has no `--accept-dns`.

## Why exit nodes die “after a while”

`net.ipv4.ip_forward` and `net.ipv6.conf.all.forwarding` are per-netns.
Docker defaults both to `0`. A one-shot sysctl in bootstrap does not survive
image swap or a start-order race with tailscaled.

The admin banner

> Unable to relay traffic — This machine has IP forwarding disabled

fires if **either** family is 0. Enabling sysctl *after* advertise does not
clear the coordination-server flag until a full `tailscale set --advertise-exit-node`
runs with forwarding already 1.

`health-tick-forward.sh` on every `--once` and every selfheal loop is the fix.

A second “offline after a while” path is freeze/thaw. The box sleeps;
`tailscaled` stays alive; PollNetMap’s long-poll dies (`time jump detected`,
`PollNetMap: context canceled`). `Self.Online` is false while
`BackendState=Running`. Selfheal used to only restart if the process was
missing. `recycle_offline_tailscaled` kills **that** PID and runs
`start-tailscaled.sh`. Same statedir. Not NeedsLogin.

The node is unreachable for the minutes the container is actually frozen.
After wake, `--once` / the worker should bring `online=yes` back.

## Identity (do not mix boxes)

| Piece | Path | Copy to a new box? |
|---|---|---|
| Node key | `state/tailscale/tailscaled.state` | **Never** |
| Tailscale name | `hostname` → `grok-box-N` | **Never** the same N |
| Tailscale IPs | assigned at join | **Never** reuse |
| Scripts + docs + `bin/` | this repo | Yes |
| Auth key | `secrets/ts-authkey` | Yes, if reusable and non-ephemeral |

`NeedsLogin` + a new AuthURL means statedir empty or corrupt, not “login expired.”
The forwarding banner is not NeedsLogin.

## Healthy shapes

`--status`:

```
backend=Running online=yes exit-node=yes sshd=up ipfwd=4:1,6:1 tailscaled=<pid> selfheal=<pid> worker=<pid> hb=<Ns>
```

`debug prefs` (this is not `status --json`):

```
Hostname=grok-box-N  OperatorUser=box  RunSSH=False  WantRunning=True
AdvertiseRoutes=['0.0.0.0/0', '::/0']  NoSNAT=False  NoStatefulFiltering=True
CorpDNS=True
```

`prefs.ExitNodeOption` means “use some exit node”, not “advertise as one”.
It is often `null`. Ignore it. “offers exit node” is `Self.ExitNodeOption`.

`status --json`:

```
BackendState=Running  Self.Online=true  Self.ExitNodeOption=true  Health=[]
```
