# Troubleshooting

## Matrix

| Symptom | Cause | Fix |
|---|---|---|
| Admin: “IP forwarding disabled” / cannot relay | v4 or v6 forwarding 0, or Hostinfo stale | Section G in RUNBOOK |
| Phone uses exit node, no internet | NAT / Docker `FORWARD DROP` | `sudo /workspace/box-setup/tailscale-exitnode-nat.sh` then `--status` |
| `missing kernel module` / connmark | tailscaled without nftables env | Kill **that PID**, `sudo /workspace/box-setup/start-tailscaled.sh` |
| Two `tailscaled` | second start | Kill **each PID**. Never `pkill -f`. Then `start-tailscaled.sh` |
| Online but no `offers exit node` | routes not approved, or prefs drift | Human approves routes + `tailscale set` full flags after ipfwd=4:1,6:1 |
| `debug prefs` `ExitNodeOption` is null | that key is “use an exit node”, not advertise | check status `offers exit node` / `Self.ExitNodeOption` |
| Android hangs on some sites | AAAA / broken v6 WAN | advertise `::/0`, `prohibit default` v6, nft6 reject |
| sshd missing on :22 | no systemd | `--once` |
| `NeedsLogin` + empty `auth=` | `up` never minted a URL | `--once` |
| `NeedsLogin` + `auth=` | statedir empty/corrupt | paste AuthURL, stop. Do not pick N yet |
| `NeedsLogin` but state is kilobytes | socket vs state | `start-tailscaled.sh`, not a new login |
| `backend=NoState` for a few seconds | tailscaled still coming up | wait, `--status` again |
| `cat` of `tailscaled.state` looks empty | mode 600 root; `box` gets EACCES | `sudo wc -c` / `sudo ls -la` |
| Reachable ~3 min then dead | sleep; hourly keep-alive missing | install section D |
| Keep-alive “already running”, stale hb | wedged worker | `--once` recycles it |
| dpkg conffile prompt, package `iU` | `/etc/default/tailscaled` pre-existed | `DEBIAN_FRONTEND=noninteractive dpkg --force-confold --configure tailscale` |
| `up` lost operator / exit / hostname | partial `up` | `set` with full flags + `$NAME` |
| New `cursor-N` or new 100.x after swap | statedir was `/var/lib/tailscale` | confirm workspace `--statedir` before the next swap |
| New 100.x right after apt | dpkg started a default daemon | kill **that PID**, `start-tailscaled.sh` |
| Still named `cursor` after Connect | A3 not run | list peers, write next free `grok-box-N`, `set` |
| MagicDNS hits the wrong box | two machines share a name | bump N on the **new** one only |
| Two boxes flap as one node | statedir was copied | empty statedir on the clone; new Connect; then A3 |
| `start-tailscaled` hangs on flock | daemon inherited lock fd | child must `8<&-` |
| `pgrep -x tailscale-selfheal` empty | 15-char pgrep | read `/run/tailscale-selfheal.pid` |

Logs: `/var/log/tailscaled.log`, `/var/log/tailscale-selfheal.log`,
`/var/log/box-bootstrap.log`. After a swap: `/tmp/sand-copy-in.log`.

## Pitfalls

1. Statedir kilobytes ⇒ already this node. Skip Connect, skip auth key, skip new N.
2. `NeedsLogin` + empty AuthURL + “Tailscale is stopped” ⇒ `WantRunning=false`.
   `tailscale login` is wrong. `--once` mints the URL.
3. You cannot list the tailnet before Connect. Guessing `grok-box-1` collides.
4. After Connect, name with `set`, not `up`. OS name stays `cursor`.
5. JSON `HostName` ≠ MagicDNS. Parse peer `DNSName` first label and status column 1.
6. `debug prefs` `ExitNodeOption` is not “offers exit node”.
7. IPv4 forwarding=1 with IPv6 forwarding=0 still produces the exact
   “IP forwarding disabled” banner. Always set both.
8. Advertising the exit node *before* sysctl latches CanRelay=false.
   Order is sysctl → NAT → `set`.
9. `/etc/sysctl.d/99-tailscale-exitnode.conf` is same-image convenience only.
   The tick must write `/proc`.
10. A keep-alive that only runs `true` wakes the box and does not restore Tailscale.
