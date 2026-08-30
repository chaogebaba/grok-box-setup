# grok-box-setup

Turn a Grok sand box into a self-healing **Tailscale exit node** with password
SSH, reachable as `grok-box-NNN` on the tailnet — and keep it that way through
sleep/thaw cycles and full image swaps.

Everything is one program: [`boxup`](boxup), installed at
`/workspace/box-setup/boxup`.

## Quick start (on the box, as the `box` user)

```bash
git clone https://github.com/chaogebaba/grok-box-setup.git /tmp/grok-box-setup
sudo bash /tmp/grok-box-setup/install.sh
sudo /workspace/box-setup/boxup once
```

**Naming rule.** A box name is `grok-box-` + exactly three decimal digits
(`grok-box-001` … `grok-box-999`). `boxup` picks the lowest free index and
zero-pads it; the reverse-tunnel port is `20000 + index` (parsed as decimal, so
`grok-box-008` → port 20008). Legacy unpadded names are still recognised; to
convert one in place use `fleet2 rename grok-box-8 grok-box-008` (see
docs/AGENT.md → "Rename a box").

Before the first `boxup once`, create the Tailscale auth key as **reusable +
pre-authorized + tagged `tag:grok-box`** (admin console → Settings → Keys →
Generate: check *Reusable*, *Pre-approved*, and add the tag `tag:grok-box`),
and put it in `secrets/ts-authkey` (mode 600). Tagging the node **at
authentication time is the only path that disables node-key expiry
automatically** — tagging later in the console does not. This is why the key
must carry the tag. (`[tailscale] tags` defaults to `tag:grok-box`, so the node
advertises it at first login with no extra config.)

After `boxup once`, confirm identity is correct:

```bash
sudo /workspace/box-setup/boxup check   # expect tags=tag:grok-box keyexpiry=disabled
```

If either is wrong (`tags-missing` or `key-expiry-enabled` in the check
reason), re-authenticate with the tag:

```bash
sudo /workspace/box-setup/boxup retag
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
boxup retag     re-auth WITH config tags to disable node-key expiry (#10)
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
(`[tailscale] version`), first-login tags (`[tailscale] tags`, **default
`tag:grok-box`** — advertised on `tailscale up` at first registration only,
never on re-auth; disables node-key expiry automatically because tagging at
auth time is the only path that does; set `tags = ""` to register untagged on
purpose; see AGENT.md §G and use `boxup retag` to fix an already-registered
node), update repo (`[update] repo`). See
[etc/config.example.toml](etc/config.example.toml).

## Fleet operations (laptop)

`boxup` runs on a box; [`fleet2`](fleet2) runs on the operator's laptop and
drives all the boxes at once over the tailnet (needs `tailscale`, `ssh`,
`sshpass` — `sudo dnf install sshpass` / `sudo apt install sshpass`). It
discovers every `grok-box-NNN` peer; it never touches other machines.

> **fleet2 (bun + TypeScript brain, phase 1).** The VPS-side brain is moving to
> bun + TypeScript. `fleet2` adds fleet **inventory** and batch **upgrade**
> (canary/verify/abort) alongside the bash `fleet2`. See
> [`fleet/README.md`](fleet/README.md) and
> [`docs/FLEET-BRAIN.md`](docs/FLEET-BRAIN.md) §"Upgrades and inventory (fleet2)".

```bash
./fleet2 list                 # name, tailscale IP, online — all grok-box-NNN peers
./fleet2 status               # boxup status line per online box + sha/drift (read-only)
./fleet2 check                # quiet health gate; exit 1 + prints only problems
./fleet2 rollout grok-box-003 # deploy current git HEAD to explicit boxes
./fleet2 rollout --all        # deploy to the whole fleet (canary first, then batch)
./fleet2 ssh grok-box-003 [cmd] # ssh wrapper
```

`rollout` requires a target: one or more explicit `grok-box-NNN`, or `--all` for
the whole fleet. A bare `fleet2 rollout` is a usage error (it will not guess).
`--all` deploys to a canary first (default `grok-box-005`, override with
`--canary <box>`), verifies it with `boxup check`, and only then rolls the rest
at 2-concurrency. The first box that fails verification trips an **abort**: no
new boxes are dispatched (in-flight ones finish and report), the command exits
nonzero, and a summary lists each box's result and `v=<version>/<sha>`. There is
no auto-rollback — on abort the exact redeploy command is printed. An
unreachable canary aborts (pick another with `--canary`); unreachable
non-canary boxes are skipped, never failures. `--dirty` allows a dirty tree.

`fleet2 status` appends `sha=<sha> drift=yes|no` per box (comparing the box's
installed git sha to the laptop's HEAD) and logs a summary when the fleet is
mixed-version; a box running an older boxup renders `sha=unknown drift=unknown`
(informational, never a failure).

`fleet2 check` delegates to `boxup check` on each box and trusts its exit
code; a box running an older boxup (no `check` subcommand) falls back to the
laptop-side `boxup status` parse so it is never wrongly reported as failing.

Password precedence: `FLEET_SSH_PASSWORD` > `~/.config/fleet2/config.toml`
`[ssh].password` > `12345678` (never stored in git). `FLEET_BOXES="grok-box-1
grok-box-2"` bypasses discovery for a fixed list.

The laptop **user** timer is retired (since 5.4.0): the VPS `fleet-reconcile.timer`
does the scheduled health checks and alerts now. `fleet2 install-timer` prints a
retirement notice (rc 2). If you set up the old timer on a laptop, tear it down
once:

```bash
./fleet2 remove-timer         # removes the retired fleetctl-check.{timer,service}
```

## House rules

- No systemd, no cron — the platform has neither. tini is PID 1.
- Never `pkill -f`; processes are matched by exact argv and killed by PID.
- `tailscale up` only for the first login; `tailscale set` afterwards.
- One tailscaled, bound to `--statedir=/workspace/box-setup/state/tailscale`.
- Box identity (`state/`, `hostname`, auth keys) never enters git.
