# Troubleshooting

## Matrix

| Symptom | Cause | Fix |
|---|---|
| Admin: “IP forwarding disabled” / cannot relay | v4 or v6 forwarding 0, or Hostinfo stale | Section G in RUNBOOK |
| Admin: node **offline**; Health “Unable to connect to the Tailscale coordination server” | `refresh-exitnode` grepped JSON key `Warning` (`{"Warning":""}` still matches) → `tailscale set` every 20s cancels PollNetMap | parse a **non-empty** Warning only; kill **that** `tailscaled` PID, `start-tailscaled.sh`. Not NeedsLogin. |
| Admin: node **offline** after idle; `time jump detected (slept …)` then `PollNetMap: context canceled`; process still running | Freeze/thaw. Map long-poll dies. `Online=false` lags ~2 min. `debug rebind` does not restart PollNetMap, so a recycle that waits for `online=no` leaves the admin pane grey. | First tick after hb age ≥ 60s: recycle **that** PID. Same statedir. Not NeedsLogin. |
| Admin: node **offline**; several `bash …/tailscale-selfheal.sh --worker`; pidfile has one | `--stop` only killed the pidfile PID. Older in-memory workers kept ticking. | `--stop` walks `/proc` cmdline and kills every `--worker`. Never `pkill -f`. Then `--once`. |
| Phone uses exit node, no internet | NAT / Docker `FORWARD DROP` | `sudo bash /workspace/box-setup/tailscale-exitnode-nat.sh` then `--status` |
| `missing kernel module` / connmark | tailscaled without nftables env | Kill **that PID**, `start-tailscaled.sh` |
| Two `tailscaled` | second start / dpkg default | `start-tailscaled.sh` kills every wrong PID. Never `pkill -f`. |
| Online but no `offers exit node` | routes not approved, or prefs drift | Human approves routes + full `set` after ipfwd=4:1,6:1 |
| `debug prefs` `ExitNodeOption` is null | that key is “use an exit node”, not advertise | check status `offers exit node` / `Self.ExitNodeOption` |
| Android hangs on some sites | AAAA / broken v6 WAN | advertise `::/0`, `prohibit default` v6, nft6 reject |
| sshd missing on :22 | no systemd | `--once` |
| SSH banner on :22, password `12345678` denied | `box`/`root` shadow locked (`passwd -S` is `L`). Image ships no password. `ensure_sshd` only toggled `sshd_config`. | `ensure_sshd` `chpasswd` both to `12345678`. `--once`. |
| `NeedsLogin` + empty `auth=` | `up` never minted a URL | `--once` (waits out NoState first) |
| `NeedsLogin` + `auth=` | statedir empty/corrupt | paste AuthURL, stop. Do not pick N yet |
| `NeedsLogin` but state is kilobytes | socket vs state | `start-tailscaled.sh`, not a new login |
| `backend=NoState` for a few seconds | tailscaled still coming up | wait. Do not mint AuthURL |
| `cat` of `tailscaled.state` looks empty | mode 600 root; `box` gets EACCES | `sudo wc -c` / `sudo ls -la` |
| Reachable ~3 min then dead | sleep; hourly keep-alive missing | install section D |
| Keep-alive “already running”, stale hb | wedged worker | `--once` recycles it |
| dpkg conffile prompt, package `iU` | `/etc/default/tailscaled` pre-existed | `dpkg --force-confold --configure tailscale` |
| `up` lost operator / exit / hostname | partial `up` | `set` with full flags + `$NAME` |
| New `cursor-N` or new 100.x after swap | statedir was `/var/lib/tailscale` | confirm workspace `--statedir` |
| Still named `cursor` after Connect | A3 not run | `pick-name.sh`, write file, `set` |
| MagicDNS hits the wrong box | two machines share a name | bump N on the **new** one only |
| Two boxes flap as one node | statedir was copied | empty statedir on the clone; new Connect |
| `start-tailscaled` hangs on flock | daemon inherited lock fd | child must `8<&-` |
| `pgrep -x tailscale-selfheal` empty | 15-char pgrep | read `/run/tailscale-selfheal.pid` |
| `sudo ./install.sh`: Permission denied | GitHub clone is mode 644 | `sudo bash install.sh` |
| `sudo -u box tailscale set` fails | operator not written yet | scripts fall back to root `set` |
| `/dev/net/tun` missing | unprivileged netns | cannot be an exit node; say so |

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
7. IPv4 forwarding=1 with IPv6 forwarding=0 still produces the exact banner.
8. Advertise only after sysctl is 1. Order is sysctl → NAT → `set`.
9. `/etc/sysctl.d` is same-image convenience. The tick must write `/proc`.
10. A keep-alive that only runs `true` does not restore Tailscale.
11. Clone from GitHub is mode 644. Always `sudo bash install.sh`.
12. `backend=Running online=no` after sleep is a dead map poll, not NeedsLogin. Recycle that PID. Do not mint AuthURL.
13. `sshd=up` is the listener, not a working login. `passwd -S box` must not be `L`.
