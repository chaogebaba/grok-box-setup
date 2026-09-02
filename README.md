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
sudo boxup once
```

The installer symlinks `/usr/local/bin/boxup` to `$BOX_SETUP_ROOT/boxup`, so
`boxup` works unqualified from any shell on the box. That link lives in `/usr`,
which an image swap wipes, so every converge restores it as well — the
installer only runs on a rollout, and a swapped box would otherwise sit for
hours with no `boxup` on PATH. A link already pointing at the right target is
left alone silently. The absolute `/workspace/box-setup/boxup` always works and
is what to reach for when the link is missing, which happens when `/usr` is
read-only: both the installer and the converge log one line and carry on rather
than failing over a convenience link.

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

**That is the whole box-side procedure.** A box only needs to reach the tailnet
under a `grok-box-NNN` name; the fleet brain does the rest. Its next reconcile
tick discovers the unenrolled box, enrols it, writes its `[fleet]` block, and
keeps those artefacts repaired after an image swap. Nobody runs
`fleet2 enroll` by hand. The brain needs the box ssh password once, installed
with `BOX_PASSWD=... bash vps/install-vps.sh` on the VPS — see
[docs/FLEET-BRAIN.md](docs/FLEET-BRAIN.md) → "Zero-touch join".

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
| image swap | everything outside `/workspace`: packages, `/etc/shadow`, sshd config, host keys, nft rules, the `/usr/local/bin/boxup` PATH link, all processes | hourly `boxup once` re-converges from `/workspace/box-setup`: vendored binaries in `bin/`, node identity in `state/tailscale/`, ssh host keys in `state/ssh/`, the PATH symlink |
| process crash | sshd / tailscaled / worker | worker restarts procs; hourly `once` restarts the worker |
| root disk fills | nothing yet — but a full root overlay makes `install.sh` exit 1, so the box stops taking rollouts and the brain sees it stuck | disk guard: every tick reads `df /`; at the fail threshold it truncates the allowlisted platform logs as their owner, and `boxup check` FAILs until usage drops |

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

## Disk guard

The sandbox host writes `/tmp/sand-host.log` and never rotates it. On
grok-box-006 it reached 101 GB, filled the root overlay, and made `install.sh`
exit 1 — the box silently stopped accepting rollouts. Since 5.3.2 every worker
tick watches for that.

| Knob | Default | What it does |
|---|---|---|
| `BOXUP_DISK_WARN_PCT` | `80` | at/above this root usage, `boxup status` shows `disk=NN%/warn` and `boxup check` logs `check: WARN disk NN%` once an hour. Not a check failure. |
| `BOXUP_DISK_FAIL_PCT` | `90` | at/above this, the guard truncates the allowlist and `boxup check` FAILs with `reason=disk NN% (after truncation) …`, so the brain's existing `reachable-cannot-converge` alert fires. |
| `DISK_GUARD_TRUNCATE` | `/tmp/sand-host.log` | whitespace-separated allowlist of paths the guard may truncate. Nothing outside it is ever touched, and nothing is ever deleted. |
| `BOXUP_DISK_TRUNCATE_MIN_BYTES` | `1073741824` (1 GiB) | only a file **larger** than this is truncated. A small log is not what fills a 100 GB overlay, and truncating it would only destroy evidence. |
| `BOXUP_DISK_INTERVAL` | `60` | seconds between checks. The tick is 15s; four `df` calls a minute buy nothing. |

A symlink named on the allowlist is refused outright, never followed.

**Truncation runs as the file's owner, and that is the whole trick.** `/tmp` is
sticky and world-writable, and Linux's `fs.protected_regular` refuses an
`O_TRUNC` open of a file in such a directory unless the opener owns the file or
the directory — root included. `truncate` as root gets `EACCES` on
`/tmp/sand-host.log`. So the guard switches first: if it already *is* the owner
it truncates directly, otherwise `runuser -u <owner>`, falling through to
`su -s /bin/sh <owner>` when `runuser` is missing or refuses. There is no
root-truncate fallback, because that is precisely the operation the kernel
denies; a failure is logged instead of being retried into a silent no-op.

Observations land in three places: the worker log
(`disk-guard: truncated <path> (<bytes> B, root <pct>%)`), `$RUN_DIR/disk` as
`<pct>% <level> <epoch>`, and the `disk=` token appended to the end of the
`boxup status` line (`disk=22%`, `disk=85%/warn`, `disk=93%/fail`).

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
