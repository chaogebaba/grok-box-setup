# grok-box-setup

Turn a Grok sand box into a self-healing **Tailscale exit node** with password
SSH, reachable as `grok-box-N` on the tailnet — and keep it that way through
sleep/thaw cycles and full image swaps.

Everything is one program: [`boxup`](boxup), installed at
`/workspace/box-setup/boxup`.

## Quick start (on the box, as the `box` user)

```bash
git clone https://github.com/chaogebaba/grok-box-setup.git /tmp/grok-box-setup
sudo bash /tmp/grok-box-setup/install.sh
sudo /workspace/box-setup/boxup once
```

If the box has never joined the tailnet, `boxup status` prints an `auth=` URL —
open it, approve the node, run `boxup once` again. With a reusable auth key in
`secrets/ts-authkey` the join is unattended. Full operator procedure:
[docs/AGENT.md](docs/AGENT.md).

## Commands

```
boxup once      full converge + health tick + status   (hourly keep-alive contract)
boxup ensure    full converge only
boxup up        converge + start the selfheal worker   (default)
boxup tick      one health tick
boxup status    one-line health string
boxup check     health gate: exit 0 healthy / 1 unhealthy (never 2)
boxup stop      stop the selfheal worker (tailscaled stays up)
boxup update    fresh clone from GitHub + reinstall (never git pull)
```

`box-bootstrap.sh` remains as a shim (`--once` → `boxup once`) because the
external hourly automation calls it by that name.

## How it survives

| Event | What dies | What brings it back |
|---|---|---|
| sleep / thaw | tailscaled's map poll (node goes grey) | selfheal worker: stale-heartbeat freeze detection recycles tailscaled |
| image swap | everything outside `/workspace`: packages, `/etc/shadow`, sshd config, host keys, nft rules, all processes | hourly `boxup once` re-converges from `/workspace/box-setup`: vendored binaries in `bin/`, node identity in `state/tailscale/`, ssh host keys in `state/ssh/` |
| process crash | sshd / tailscaled / worker | worker restarts procs; hourly `once` restarts the worker |

Design, environment facts, and the reasoning behind every special case:
[docs/DESIGN.md](docs/DESIGN.md).

## Configuration

`/workspace/box-setup/config.toml` (seeded once, never overwritten):
SSH password (`[ssh] password`, default `12345678`), pinned tailscale version
(`[tailscale] version`), first-login tags (`[tailscale] tags`, e.g.
`tag:grok-box` — added to `tailscale up` at first registration only, never on
re-auth; see AGENT.md §F before enabling), update repo (`[update] repo`). See
[etc/config.example.toml](etc/config.example.toml).

## Fleet operations (laptop)

`boxup` runs on a box; [`fleetctl`](fleetctl) runs on the operator's laptop and
drives all the boxes at once over the tailnet (needs `tailscale`, `ssh`,
`sshpass` — `sudo dnf install sshpass` / `sudo apt install sshpass`). It
discovers every `grok-box-N` peer; it never touches other machines.

```bash
./fleetctl list                 # name, tailscale IP, online — all grok-box-N peers
./fleetctl status               # boxup status line per online box + sha/drift (read-only)
./fleetctl check                # quiet health gate; exit 1 + prints only problems
./fleetctl rollout grok-box-3   # deploy current git HEAD to explicit boxes
./fleetctl rollout --all        # deploy to the whole fleet (canary first, then batch)
./fleetctl ssh grok-box-3 [cmd] # ssh wrapper
```

`rollout` requires a target: one or more explicit `grok-box-N`, or `--all` for
the whole fleet. A bare `fleetctl rollout` is a usage error (it will not guess).
`--all` deploys to a canary first (default `grok-box-5`, override with
`--canary <box>`), verifies it with `boxup check`, and only then rolls the rest
at 2-concurrency. The first box that fails verification trips an **abort**: no
new boxes are dispatched (in-flight ones finish and report), the command exits
nonzero, and a summary lists each box's result and `v=<version>/<sha>`. There is
no auto-rollback — on abort the exact redeploy command is printed. An
unreachable canary aborts (pick another with `--canary`); unreachable
non-canary boxes are skipped, never failures. `--dirty` allows a dirty tree.

`fleetctl status` appends `sha=<sha> drift=yes|no` per box (comparing the box's
installed git sha to the laptop's HEAD) and logs a summary when the fleet is
mixed-version; a box running an older boxup renders `sha=unknown drift=unknown`
(informational, never a failure).

`fleetctl check` delegates to `boxup check` on each box and trusts its exit
code; a box running an older boxup (no `check` subcommand) falls back to the
laptop-side `boxup status` parse so it is never wrongly reported as failing.

Password precedence: `FLEET_SSH_PASSWORD` > `~/.config/fleetctl/config.toml`
`[ssh].password` > `12345678` (never stored in git). `FLEET_BOXES="grok-box-1
grok-box-2"` bypasses discovery for a fixed list.

Run `check` on a schedule with a systemd **user** timer (every 10 min, desktop
notification on failure):

```bash
./fleetctl install-timer        # enables fleetctl-check.timer (check --notify)
./fleetctl remove-timer         # tears it down
```

Note: the timer's notifications use `notify-send`, which needs a graphical
session — outside one (e.g. over plain ssh) nothing pops up, but failures are
still logged to the systemd user journal.

## House rules

- No systemd, no cron — the platform has neither. tini is PID 1.
- Never `pkill -f`; processes are matched by exact argv and killed by PID.
- `tailscale up` only for the first login; `tailscale set` afterwards.
- One tailscaled, bound to `--statedir=/workspace/box-setup/state/tailscale`.
- Box identity (`state/`, `hostname`, auth keys) never enters git.
