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
convert one in place use `grokfleet rename grok-box-8 grok-box-008` (see
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
`grokfleet enroll` by hand. The brain needs the box ssh password once, installed
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
| idle sleep (platform pause) | nothing on the box — but a paused box is unreachable: no converge, no alerts, no ssh, and the VPS brain cannot wake it | keep-awake guard: every `[keepawake] interval_min` minutes the worker asks the local gateway to run one minimal agent turn, which is what the platform's idle clock actually watches |
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

A symlink named on the allowlist is refused outright, never followed, whatever
its size — the refusal sits above the size floor precisely so nothing else can
stand in for it.

All five knobs survive `boxup`'s privilege escalation: a non-root `boxup once`
re-execs itself under `sudo`, and they are on the forwarded list, so
`BOXUP_DISK_FAIL_PCT=1 boxup once` from an ordinary shell behaves as written.

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

## Keep-awake guard

The platform pauses a box after an idle window keyed to **agent turns**, and a
paused box is unreachable — the brain cannot converge it, alert on it, or wake
it. The platform's own hourly `keep-alive` automation is too slow (003 slept
51 m 50 s inside an hourly gap) and gets parked on Auto-review approval widgets,
which do not refresh the idle clock. Since 5.4.0 every worker tick can drive the
same mechanism at a faster cadence, from the box itself.

| Knob | Default | What it does |
|---|---|---|
| `[keepawake] interval_min` | `20` | minutes between fires. `0` turns the guard off entirely; `1`–`9` are raised to the floor of `10`. Read through `config_get`, so the brain can push it in `managed.toml`. |
| `BOXUP_GATEWAY_URL` | `http://127.0.0.1:1340` | the box's local gateway. A test seam; you do not change this on a box. |
| `BOXUP_GATEWAY_JSON` | `/home/box/sand-data/gateway.json` | where the gateway's bearer token is discovered. |

One fire is `POST /api/sendPrompt` with the prompt `Reply with only the word:
ok`, the bearer from the discovery file, and `agentId` read from `GET /health`
**on that same tick** — the gateway restarts and the agent id changes with it,
so it is never hard-coded. A request carrying an `Origin` header is refused 403,
so none is sent.

**This costs a real model turn per fire — 72 a box a day at 20 minutes.** The
guard is therefore skip-first (a genuinely running turn already refreshed the
idle clock, so it fires nothing) and it measures itself. Every attempt appends
one line to `/workspace/boxup-keepawake.log`, skips and unreachable gateways
included:

```
2026-09-03T04:20:11Z rc=ok before=1788382445430 after=1788382463529
2026-09-03T04:40:12Z rc=skip before=1788383644001 after=-
2026-09-03T05:00:14Z rc=unreachable before=- after=-
```

`rc` is one of seven values, also surfaced on the status line as
`keepawake=on keepawake_last=<ISO> keepawake_rc=<rc> jumps=<n>`:

| `rc` | Meaning |
|---|---|
| `ok` | accepted, and a turn started within 10 s |
| `inert` | accepted, but no turn appeared — **not** a success |
| `refused` | HTTP error, or a body without `"accepted":true` |
| `skip` | a real turn was already running; nothing was fired |
| `unreachable` | `/health` did not answer (retried no faster than every 90 s) |
| `parked-ok` | fired into a parked approval widget and the idle clock advanced |
| `parked-blocked` | fired into a parked approval widget and it did **not** — the guard warns once an hour to clear the widget in the GUI |

`jumps` counts tailscaled's `time jump detected` lines since the per-install
baseline written at the first converge, which is how a sleep is detected at all.
`tests/keepawake-readout.sh` turns a directory of pulled logs into the per-box
per-day table that decides whether the mechanism stays: only days in which the
mechanism demonstrably fired are in the denominator.

**One honest caveat.** A paused box writes nothing, so a sleep erases the log
slots it covers, and the readout attributes absent slots to sleep as an
approximation. A stopped worker, an image swap, or a crashed gateway produce
absent slots too. Every one of those alternative causes pushes the verdict
toward abandoning the mechanism, which is the cheap error: abandoning costs one
config key to reverse, while keeping a mechanism that does not work costs 792
model turns a day across the fleet.

## Job runner

Since 5.5.0 a box can run a **job**: a detached process started by one short
ssh, recorded durably, and supervised by the worker tick. There are two kinds
and one runner. `run` is ad-hoc CI — a wall-clock cap enforced on the box, the
rc recorded on exit, `124` on the cap. `service` is long-lived — no cap, and the
tick restarts it whenever it is not live, including after an image swap.

```
boxup job start <id> [--kind run|service] [--cap <s>] [--keep-alive] \
                     [--cwd <dir>] [--no-restart-on-swap] -- <cmd...>
boxup job status <id>          # one key=value line, the brain's whole channel
boxup job log <id> [<offset>]  # raw bytes from that offset, <=1 MiB per call
boxup job stop <id>            # TERM the process group, KILL after 10 s
boxup job ls
boxup job prune
```

A box runs **one job at a time**. The slot is an atomic `mkdir` under
`$RUN_DIR/jobs/`; a second start returns **rc 75**. Durable state lives in
`/workspace/jobs/<id>/` (`cmd`, `cwd`, `kind`, `cap`, `pgid`, `started`, `rc`,
`ended`, `log`, `truncations`, `truncated_total`) and survives an image swap.
**Liveness** lives in `$RUN_DIR/jobs/` and does not: a swap clears it, which is
how a swap is detected without asking the kernel anything. A job is live iff its
marker exists, the pid in it is alive, and that pid's `/proc` cmdline is the
job's own wrapper. The recorded `pgid` is only ever used to signal — after a
swap pids restart from 1, so a recorded number can belong to anything.

`status` derives its state from those files:

| state | how |
|---|---|
| `done` / `failed` / `timeout` | an `rc` file: 0, non-zero, or 124 from the cap |
| `stopped` | `boxup job stop` (rc 143) |
| `crashloop` | 5 keep-alive restarts inside 10 minutes; the guard gives up |
| `running` | the marker is live and is this job's wrapper |
| `lost:died` | the marker is there, the process is not |
| `lost:image-swap` | the marker is gone and no `rc` was ever written |

Logs are bounded at **64 MiB** by truncation **in place** — never by rename,
because the wrapper holds one append descriptor across the whole job and a
rename would leave it writing into a file nobody reads. The truncation is the
disk guard's own single-syscall mutator, so it inherits every safety gate,
including the symlink refusal that a job's own command can make reachable. Each
event bumps `truncations` and `truncated_total`, which `status` reports: the
brain detects a truncation from the counter, never from a size. `/workspace/jobs`
records are pruned 7 days after a terminal state and bounded to the 20 most
recent, and `disk_guard` can reclaim a job log under disk pressure through a
built-in allowlist entry that a `DISK_GUARD_TRUNCATE` override cannot remove.

The status line gains `job=<id|-> job_state=<state|->`, appended last.

## Fleet operations (laptop)

`boxup` runs on a box; [`grokfleet`](fleet/) runs on the operator's laptop and
drives all the boxes at once over the tailnet (needs `tailscale`, `ssh`,
`sshpass` — `sudo dnf install sshpass` / `sudo apt install sshpass`). It
discovers every `grok-box-NNN` peer; it never touches other machines.

> **grokfleet (bun + TypeScript brain).** The VPS-side brain is bun +
> TypeScript. It was called `fleet2` up to and including 5.9.0 and is
> `grokfleet` from 5.10.0 on; 5.10.0 keeps the old unit names, the `fleet2`
> command and the `FLEET2_*` variables working for that one release. See
> [`fleet/README.md`](fleet/README.md) and
> [`docs/FLEET-BRAIN.md`](docs/FLEET-BRAIN.md) §"Upgrades and inventory (grokfleet)".

```bash
./grokfleet list                 # name, tailscale IP, online — all grok-box-NNN peers
./grokfleet status               # boxup status line per online box + sha/drift (read-only)
./grokfleet check                # quiet health gate; exit 1 + prints only problems
./grokfleet rollout grok-box-003 # deploy current git HEAD to explicit boxes
./grokfleet rollout --all        # deploy to the whole fleet (canary first, then batch)
./grokfleet ssh grok-box-003 [cmd] # ssh wrapper
```

`rollout` requires a target: one or more explicit `grok-box-NNN`, or `--all` for
the whole fleet. A bare `grokfleet rollout` is a usage error (it will not guess).
`--all` deploys to a canary first (default `grok-box-005`, override with
`--canary <box>`), verifies it with `boxup check`, and only then rolls the rest
at 2-concurrency. The first box that fails verification trips an **abort**: no
new boxes are dispatched (in-flight ones finish and report), the command exits
nonzero, and a summary lists each box's result and `v=<version>/<sha>`. There is
no auto-rollback — on abort the exact redeploy command is printed. An
unreachable canary aborts (pick another with `--canary`); unreachable
non-canary boxes are skipped, never failures. `--dirty` allows a dirty tree.

`grokfleet status` appends `sha=<sha> drift=yes|no` per box (comparing the box's
installed git sha to the laptop's HEAD) and logs a summary when the fleet is
mixed-version; a box running an older boxup renders `sha=unknown drift=unknown`
(informational, never a failure).

`grokfleet check` delegates to `boxup check` on each box and trusts its exit
code; a box running an older boxup (no `check` subcommand) falls back to the
laptop-side `boxup status` parse so it is never wrongly reported as failing.

Password precedence: `FLEET_SSH_PASSWORD` > the config file `$FLEET_CONFIG`
points at (default `/opt/grok-fleet/config.toml`) `[ssh].password` > `12345678` (never stored in git). `FLEET_BOXES="grok-box-1
grok-box-2"` bypasses discovery for a fixed list.

The laptop **user** timer is retired (since 5.4.0): the VPS `grokfleet-reconcile.timer`
does the scheduled health checks and alerts now. `grokfleet install-timer` prints a
retirement notice (rc 2). If you set up the old timer on a laptop, tear it down
once:

```bash
./grokfleet remove-timer         # removes the retired fleetctl-check.{timer,service}
```

## House rules

- No systemd, no cron — the platform has neither. tini is PID 1.
- Never `pkill -f`; processes are matched by exact argv and killed by PID.
- `tailscale up` only for the first login; `tailscale set` afterwards.
- One tailscaled, bound to `--statedir=/workspace/box-setup/state/tailscale`.
- Box identity (`state/`, `hostname`, auth keys) never enters git.
