# DESIGN.md — environment, persistence, and why boxup looks like this

## The environment (measured, 2026-08)

- Debian 13 (trixie) inside a Cursor sand **container**: PID 1 is `tini`
  running `/pod-daemon`; a python supervisor (`sand-exit-watch`) is the parent
  of long-lived processes. `systemd` is present on disk but **not running**;
  there is **no cron**. In-container hostname is `cursor`.
- `/` is a docker overlay on a 128G disk. **`/workspace` is a plain directory
  on that same overlay** — the platform preserves it across image swaps, but
  it is not a separate mount. Treat it as "probably persistent" and keep a
  full re-join path (auth key or AuthURL) for the day it isn't.
- The box **sleeps when idle** and thaws with a clock jump
  (`tailscaled.log: "time jump detected (slept 23m34s)"` — observed).
- An **image swap** replaces the overlay: packages, `/etc/shadow` (accounts
  come back locked), sshd config and host keys, sysctl values, nft rules, and
  every process are gone. Nothing on the box auto-starts our code afterwards.
- The default user `box` has passwordless sudo. `/usr/sbin` is not on its
  PATH (boxup exports its own). `/dev/net/tun` exists. Docker CLI does not.
- The only external trigger is an hourly Grok automation running
  `box-bootstrap.sh --once`.

## Persistence model

Everything the box must remember lives in `/workspace/box-setup/`:

| Path | What | Why it must persist |
|---|---|---|
| `state/tailscale/tailscaled.state` | node identity (keys) | same `grok-box-N`, same 100.x IP after swap; never copy between boxes |
| `state/ssh/ssh_host_*` | SSH host keys | stable host identity — no known_hosts churn after swap |
| `hostname` | chosen `grok-box-N` | naming survives everything |
| `bin/tailscale{,d}` | vendored static binaries | daemon restarts after swap without apt or network |
| `config.toml` | user config (password, pins) | seeded once, never overwritten |
| `secrets/ts-authkey` | optional reusable join key | unattended re-join if state is ever lost |

`/run/box-setup/` (hb, ipfwd.env, last-recycle, last-online, offline-ticks,
last-exitnode-set) is deliberately ephemeral bookkeeping.

## Recovery paths

1. **Sleep/thaw** (state intact, processes alive but stale): tailscaled's
   long-poll to the coordination server is dead, yet `Self.Online` and
   `Health` stay green for ~2 min, so you cannot poll your way out. The
   worker's own stale heartbeat (age ≥ 60s) *is* the thaw signal: recycle
   tailscaled (restart is the only reliable fix — it has no reload signal,
   and `tailscale up` re-sends prefs without rebinding anything), then
   re-push prefs. Guard rails: 120s recycle cooldown (stamped *before* the
   kill), and a brand-new worker only trusts leftover hb if tailscaled logged
   a recent time jump or the node is already offline.
2. **Still offline after thaw**: backend=Running with `Online=false` or
   map-poll Health errors → recycle after 30s past last-online or 3 ticks.
3. **Image swap** (overlay gone): the hourly `boxup once` re-converges from
   `/workspace` alone — packages if missing, sshd drop-in + passwords +
   restored host keys, sysctl, nft, tailscaled from `bin/` on the surviving
   statedir, full `tailscale set`, worker restart. Time to recovery is
   bounded by the hourly trigger.
4. **State lost too** (worst case): backend lands in NeedsLogin with an
   empty statedir → auth-key join, else mint an AuthURL and surface it in
   `status`. This mints a NEW node; the old one must be deleted in the admin
   console.
5. **Node key expired / node deleted in console**: backend=NeedsLogin with a
   *populated* statedir — the node key hit its ~180-day expiry, or the node
   was removed in the admin console. `tailscale up` on an expired node exits
   silently, so `boxup once` re-auths with `--force-reauth`; the AuthURL
   appears in `status` as `auth=`. Re-auth reuses the existing machine key, so
   it is the same identity — no new node is forked.
   - **nodegone (F8/#8):** a node deleted server-side does NOT always land in
     NeedsLogin. Observed on box-8: LocalAPI kept `BackendState=Running` while
     tailscaled logged `PollNetMap: initial fetch failed 404: node not found`.
     `ensure_login` now detects this `nodegone` state (Health strings, or a
     bounded `tailscaled.log` tail gated on `Self.Online=false`) and re-auths
     even at Running — rate-limited to once per D4 backoff window so it never
     storms control.
   - **re-auth `up` mentions (F9/#9):** current tailscale (1.102.x) refuses an
     `up` that omits an already-set non-default flag, so the `--force-reauth`
     branch MENTIONS the current `--hostname` and the tags the device ALREADY
     carries (from live prefs, never config.toml — see the F11 distinction on
     the decision wall). Never `--reset`.

## Convergence rules that encode past incidents

- **`tailscale up` exactly once.** `up` resets every pref it isn't given; all
  post-login convergence is `tailscale set` with the full flag list
  (`--hostname --ssh=false --operator=box --advertise-exit-node
  --snat-subnet-routes=true --stateful-filtering=false`).
- **Refresh is need-driven and rate-limited (20s).** An unconditional
  `tailscale set` every tick cancels PollNetMap and marks the node offline.
  Need = check-ip-forwarding Warning (the *value* — grepping the key name is
  always true and once spammed the node offline), kernel fwd flags ≠ 1,
  sysctl just flipped, `ExitNodeOption=false`, Health mentions forwarding, or
  advertised routes missing `0.0.0.0/0` / `::/0`.
- **NoState ≠ NeedsLogin.** Right after daemon start the backend reports
  NoState; minting an AuthURL then forks a second identity. Wait for
  Running/NeedsLogin/Stopped.
- **nft is applied atomically.** One `nft -f` transaction: create-if-absent +
  `delete table` + full redefinition of `ts-exitfix` (ip and ip6). No
  grep-the-rule-text idempotence. Rules die with the overlay and are cheap,
  so every tick re-applies.
- **Why the NAT table exists at all:** Docker-style FORWARD DROP plus no
  masquerade = exit node "connected" with no WAN. The ip6 `output reject` +
  `prohibit` default route force-fail IPv6 fast (the WAN has no v6), so
  exit-node clients fall back to v4 instead of hanging.
- **Exactly one tailscaled**, on the workspace statedir; strays (dpkg's
  default `/var/lib/tailscale`) are killed by PID after an argv check. Never
  `pkill -f` — flattened-cmdline matching once SIGTERM'd agent shells that
  merely mentioned a script name. The same rule shapes the worker reaper:
  exact argv match (`boxup … worker`, or the v4 `tailscale-selfheal.sh
  --worker`), skipping any `-c` process.
- **Naming**: lowest free `grok-box-N`, computed from **peers only** (Self is
  often still `cursor`), only while `backend=Running` with peers visible, then
  frozen in the `hostname` file. First-value-wins sshd semantics: our
  `00-box-setup.conf` drop-in outranks the main config and any foreign
  drop-in; leftover `50-`/`60-` files on the boxes are harmless and not ours.
- **Passwords are re-applied every converge** — the image ships `box`/`root`
  locked and `/etc/shadow` dies on swap; `sshd=up` is not a working login.
  Non-printable config passwords are refused (they would lock the box out).

## Security posture

- The tailnet is the trust boundary. sshd listens everywhere, but the WAN
  side is the sand platform's NAT; do not expose port 22 on purpose.
- Tailscale SSH stays off (`--ssh=false`): OpenSSH is the only login path.
- Auth keys must be reusable and non-ephemeral (ephemeral nodes vanish on
  restart and mint duplicates).
- `state/`, `secrets/`, `hostname` never enter git (CI enforces).


## Decision wall (D8)

One row per load-bearing decision: what it is, the incident/measurement that
forced it, and what breaks if it is "simplified away". Read this before undoing
any special case.

| Decision | Forced by | Breaks if undone |
|---|---|---|
| No systemd/cron on boxes | platform has neither; PID1 is tini | nothing schedules recovery; box stays dead after swap |
| Single-file `boxup`, one copy at `/workspace/box-setup/boxup` | v4's 8 scripts installed twice drifted | two copies diverge; stale copy runs |
| `tailscale up` only in `ensure_login` | `up` resets every unmentioned pref | prefs (exit-node, operator) silently cleared each tick |
| `tailscale set` (not `up`) for prefs | need-driven refresh must not reset flags | same pref-clobber as above |
| Never `pkill -f` | flattened-cmdline match once SIGTERM'd agent shells naming a script | agent `-c` shells killed; collateral damage |
| `00-` sshd drop-in wins | Debian sshd keeps FIRST value; Include is near top | a foreign drop-in overrides our password login |
| chpasswd every converge | image ships box/root locked; `/etc/shadow` dies on swap | `sshd=up` but no login works after swap |
| Exactly one tailscaled on the workspace statedir | dpkg's default unit binds `/var/lib/tailscale` | two daemons; split identity; NoState churn |
| NoState ≠ NeedsLogin | minting on NoState forks a second identity | duplicate node created right after daemon start |
| Recycle-not-restart on freeze | tailscaled has no reload; long-poll dies on thaw | node stays grey ~2 min every sleep/thaw |
| Identity out of git | per-box keys/hostname must not leak or collide | two boxes with one identity; key leak (CI enforces) |
| Frozen shim flag contract | external hourly automation calls `box-bootstrap.sh --once` | the resurrection trigger breaks |
| Parse the VALUE of check-ip-forwarding, never grep the key | grepping the key is always true; once spammed `set` and marked node offline | `set` every tick → PollNetMap cancelled → node offline |
| nft applied as one atomic `nft -f` transaction | partial rule state = exit node "connected" with no WAN | half-applied rules; broken forwarding |
| NAT table + ip6 reject/prohibit forcing v4 fallback | Docker FORWARD DROP + no masquerade; WAN has no v6 | exit clients hang on v6 with no WAN |
| Name computed from PEERS only, never Self, then frozen | Self is often still `cursor`; a lone node always picks grok-box-1 | name collisions across the fleet |
| Recycle cooldown stamped BEFORE the kill | a slow/dying recycle tick must still honor the cooldown | recycle storm on every tick |
| Brand-new-worker leftover-hb guard | a just-started worker sees stale hb from the old one | spurious recycle right after `boxup stop`/start |
| hb written immediately after freeze checks | a slow recycle must not leave stale hb for the next tick | next tick mistakes it for another freeze |
| Worker reaper matches exact argv, skips `-c` | same `pkill -f` lesson | agent shells reaped |
| Reusable non-ephemeral auth keys; Tailscale SSH off | ephemeral nodes vanish on restart and mint duplicates; OpenSSH is the only login | duplicate nodes; lost the only login path |
| Non-printable config passwords refused | chpasswd round-trip would set an unknown password | box locked out |
| config.toml seeded once, never overwritten | user's password/pins must survive upgrades | every install resets the login |
| ROOT never auto-detected from a checkout | a stray clone must not become the live root | dev tree silently drives a real box |
| Vendored tailscale bins in `bin/` | recovery after swap must not wait on apt/network | daemon can't restart offline |
| `set -u`, not blanket `set -e` | the worker loop must keep looping past transient failures | one transient error kills the self-heal loop |
| tailscaled-start flock in a subshell; child closes fd 9 | a long-lived worker holding the lock wedges later starts | daemon restart deadlocks on the inherited lock |
| **Converge lock: wait-for-ensure, skip-for-tick, fail-open** (D3/B1/S1) | `boxup once`, the tick, and rollout can converge concurrently | `once` silently skipped (operator faked out) OR duplicate concurrent converge |
| **hb-stamp-on-contention** (D3/B1/N3) — its OWN row | a long `boxup once` starves hb; the next tick would spuriously recycle | it deliberately masks a freeze for the bounded converge duration — do NOT "simplify" it away |
| **Atomic mktemp+rename install** (D3/M2) | non-atomic copy over a running boxup; two concurrent installs truncate a fixed dotfile | worker reads a half-written/corrupt boxup |
| **Refresh backoff with env-only human bypass** (D4/F6/M1) | a persistently failing `set` retried every tick forever, invisibly; hourly `once` would reset a cmd-based bypass | silent infinite retry; unattended backoff reset |
| **Shim tail-sentinel + hardcoded-fallback-URL divergence** (D5/F2/F3) | `bash -n` accepts a boxup truncated at a statement boundary; a corrupt boxup's config parser is unavailable | truncated boxup execs+exits 0 silently; self-heal can't find its repo |
| **Root-clone sanity gate** (D5/F4) | the shim runs an unpinned clone as root, hourly | executes a partial/hostile clone as root |
| **`check` exit-2 skew fallback** (D6/B2) | exit 2 = unknown-subcommand = "old boxup"; a check bug emitting 2 downgrades fleetctl | healthy old box reported failing; notify-send spam |
| **Canary/abort + no-auto-rollback** (D7) | rollout deployed everywhere with no verify/brake; per-box failures discarded | a bad HEAD rolls the whole fleet unverified |
| **Sudo env sha plumbing** (D10/B3) | sudo env_reset drops exported vars; git archive carries no .git | every box stamps `sha=unknown`; drift detection blind |
| **`--advertise-tags` first-login only** (tags/F11) | re-auth-time tagging locks a node out (headscale#3374) | unattended re-auth converts node to tag-owned and it can't rejoin |
| **Daemon child closes BOTH lock fds (fd 8 + fd 9)** (F7/#7) | `start_tailscaled` runs under the converge lock (fd 8); the old code closed only fd 9, so tailscaled inherited fd 8 and held converge.lock for its whole life → every tick skipped forever (256 skips/77 min, box-8) | one leaked fd wedges all converge; box looks "healthy-ish" (hb fresh) while ticks are no-ops |
| **Stale converge-lock self-heal: break after ≥5 non-boxup skips** (F7/#7) | field boxes already wedged with tailscaled holding fd 8 need to recover without a manual restart; a genuine concurrent `boxup` must never be stomped | either the wedge is permanent until reboot (no self-heal), or a real concurrent converge gets stomped (no boxup-holder check / no threshold). Counter is ephemeral ($RUN_DIR/converge-skip.count); fail-open — no counter/holder ⇒ no break. Holder identity comes from **/proc/locks** (the kernel flock table, keyed by dev:inode), NOT /proc/*/fd: /proc/*/fd answers "who has the file open" and self-includes the very lock-check subshell that just lost `flock -n 8`, defeating the break. **Verified 2026-08-28 on grok-box-1** (shared pid namespace, tini as pid 1): /proc/locks pids resolve to /proc/PID/comm inside the container (holder pid 1123910 → comm `flock`, inode 527804 matched `00:27:527804`). If the platform ever moves the boxes into their OWN pid namespace, holders stop resolving, an unresolvable holder is treated as unproven (never broken, fail-safe), and this self-heal degrades to a silent no-op — so that case is logged once per window, never silent |
| **`nodegone` ≠ logged-in: re-auth on deleted node even at backend=Running** (F8/#8) | control plane deleted the node but LocalAPI kept `BackendState=Running` while PollNetMap 404'd; `ensure_login` returned 0 on Running and never re-authed → box sat online=no with fresh hb forever (box-8) | a server-deleted node never recovers; `wait_for_backend` is untouched (Running is legitimately terminal for IT — the judgement lives in ensure_login). Rate-limited via the D4 window (once per window; loud once-per-window log when only an unclickable AuthURL can be minted) so re-auth never storms control |
| **Re-auth `up` MENTIONS current hostname + already-set tags** (F9/#9, reverses F11's blanket rule) | tailscale 1.102.x refuses `up` that omits any already-set non-default flag ("requires mentioning all non-default flags"); `--force-reauth` with no `--hostname`/`--advertise-tags` was a silent no-op (box-8, reproduced by hand) | re-auth is a no-op and the box never rejoins. **Distinction from F11:** F11 forbids *introducing* tags on re-auth (locks node out); this MENTIONS tags the device ALREADY carries (sourced from live prefs/`Self.Tags`, NEVER config.toml) — a mention is not an introduction. Never `--reset`. The `up` failure is no longer swallowed by `\|\| true`: combined output is captured and the tailscale error is logged at ERROR, naming the mentioning-flags case explicitly |
| **One `spawn_detached()` for ALL long-lived spawns** (F7/#7 P0-A) | #7 was a per-site fd-close convention nobody enforced — the comment even claimed a close the code skipped. tailscaled, sshd (ensure_sshd AND do_tick), and the worker each spawn under/near the converge-lock subshell; any that keeps fd 8 open holds the flock for life | a second/third instance of #7 (sshd self-daemonizes holding fd 8; observed-class failure). Routing all four spawns through one helper that owns the `8>&- 9>&-` closes = one place to be right, one to review. Do NOT re-inline per-site closes |
| **`refresh_exitnode` skips on nodegone** (F8/#8 P0-B) | a node deleted server-side stays backend=Running (nodegone); the old `case Running) ;;` gate let a `tailscale set` fire against a dead identity, a no-op that can cancel the in-flight map poll | pushing prefs to a gone node fights the re-auth path; re-auth (ensure_login) is the only correct actor on a gone node. (ensure_name needs NO guard: a nodegone box already has a frozen grok-box-N and short-circuits before reading fields.) |
| **Converge `degraded` marker, return-neutral** (P1) | `do_ensure_body` was all-`\|\| true`, so a converge reported success even if every step failed, invisibly | each step's non-zero rc is now logged and stamps `$RUN_DIR/degraded` (cleared on a clean pass). RETURN SEMANTICS UNCHANGED — the marker is visibility only, never a gate on a tick (callers depend on a converge not failing a tick) |

## Prior art (D11)

What each does, what we borrowed, why we diverged.

- **tailscale `containerboot`** — env-driven `up`, state in a mounted volume.
  Borrowed: env-configured convergence. Diverged: we have no volume that
  survives an image swap, so state lives in `/workspace` and we keep a full
  re-join path (auth key / AuthURL).
- **runit / s6 supervision** — our worker loop is a poor-man's s6 (supervise +
  restart). Diverged: we cannot own PID 1 (tini + the sand supervisor do), so
  the loop is a userspace tick, not a real supervisor.
- **ansible-pull** — pull-based convergence. Borrowed: the shim's re-clone +
  reinstall is exactly pull-based self-heal. Diverged: triggered by the hourly
  automation, not a control node.
- **`tailscale up --reset`** — resets prefs to flags given. Informs our
  set-only-after-first-login rule: we never want the reset semantics post-join,
  so we use `set` and reserve `up` for `ensure_login`.
- **Kubernetes CrashLoopBackOff + systemd `RestartSec`/`StartLimitBurst`**
  (D4) — capped exponential backoff, reset on success, never a permanent give
  up. Borrowed wholesale for the refresh backoff (20→60→180→600s, reset on a
  successful `set`, no permanent stop).
- **Docker `HEALTHCHECK` / k8s liveness-readiness** (D6) — one exit-code health
  predicate owned by the workload, not the orchestrator. Borrowed: `boxup
  check` is that one predicate; fleetctl (the orchestrator) trusts its exit
  code instead of reimplementing health.
- **Ansible `serial:` + `max_fail_percentage`** (D7) — canary-then-batch with
  an abort. Borrowed: canary-first, verify, abort-on-first-failure. **`kubectl
  rollout status`/`undo`** — informs the deliberate no-auto-rollback choice
  (rollback = redeploy a known-good sha; we print the command rather than
  building undo machinery).
- **rename-not-truncate self-replace (rustup, dpkg)** (D3) — a running program
  keeps its fd on the old inode after `rename(2)`. Justifies the atomic
  mktemp+`mv -f` install: a live worker finishes reading the old boxup
  uninterrupted while the new file is installed.
