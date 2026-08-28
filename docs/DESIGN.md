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
   - **nodegone / server-deleted (H4/#8):** a node deleted server-side does NOT
     reliably land in NeedsLogin on a LocalAPI query — it stays `Running`
     while the map poll 404s (tailscale/tailscale#20615). Recovery is
     recycle-then-read: persistent `Self.Online=false` or a generic
     not-in-map-poll / "Out of sync" Health string triggers a daemon RESTART
     (`recycle_offline_tailscaled` → `recycle_tailscaled`), which re-reads state
     and lands in NeedsLogin; `recycle_tailscaled` then calls `ensure_login` so
     the re-auth happens immediately. No Health-text or log-tail matching.
   - **re-auth `up` mentions (F9/#9):** the `--force-reauth` branch MENTIONS the
     current `--hostname` (prefs → hostname file → `status --json` Self.HostName;
     refuses if all empty) and the tags the device ALREADY carries (never
     config.toml — see the control-plane scoping in docs/AGENT.md §G). Never
     `--reset`. Attempts are rate-limited (30-min floor + per-hour cap).

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
| **`--advertise-tags` first-login only; re-auth MENTIONS already-held tags** (tags/F11/#9, control-plane-scoped) | on **login.tailscale.com** current CLI refuses an `up` that omits an already-set non-default flag, so re-auth must MENTION the hostname + tags the node already carries (from live prefs/`Self.Tags`, never config.toml). *Introducing* a new tag on re-auth still forbidden. On **headscale < 0.29.3** even mentioning a held tag is rejected (headscale#3374) — the old blanket "never pass tags on re-auth" rule was right for THAT control plane only. We run login.tailscale.com. | on our control plane: re-auth is a silent no-op and the box never rejoins (the #9 bug). If ever pointed at headscale <0.29.3: revert `run_reauth_up` to omit `--advertise-tags`. See docs/AGENT.md §G. Never `--reset` |
| **Converge lock is `flock --close`; NO stale-holder detector** (H1, replaces the deleted /proc/locks self-heal) | the #7 leak (a child inheriting the lock fd) is made STRUCTURALLY IMPOSSIBLE: an outer subshell holds the lock on fd 9 for the body's whole duration, the body runs in an inner subshell with `9<&-`, so neither it nor any descendant has the fd. The dual gate PROVED a holder detector cannot work with boxup's real leak shape — a subshell takes `flock -n`, spawns a detached child, then EXITS, so `/proc/locks` records the EXITED helper's pid (445980) not the inheriting daemon (445981); the holder reads "?", the counter resets, the break never fires. So the entire detector/classifier/skip-counter/5-skip-break was DELETED. | without `--close`, any spawn site that forgets to close the fd re-introduces #7; with it, forgetting is harmless. Do NOT resurrect the /proc/locks detector — it is unfixable for this leak shape |
| **Never run the converge body unlocked** (H3) | old `flock -w 60` ran the body UNLOCKED on timeout, and open-failure "failed open" — both defeat mutual exclusion | try-mode contention → skip (200); wait-mode timeout / open-failure → hard non-zero (201), `boxup once`/`up` exit non-zero, never a faked converge. `tailscale_set_full` is `timeout`-bounded (the realistic way to hold the lock past 60s) |
| **Transitional legacy-wedge recovery: recycle, don't break** (H2, removable) | boxes already wedged by the OLD pre-hotfix daemon still hold the inherited fd; `flock --close` does not free an already-leaked fd | on try-mode contention only, `/proc/*/fd` (which DOES see the inheritor, unlike /proc/locks) matched by dev+inode finds a `tailscaled` on OUR `$STATE_DIR` holding the lock and RECYCLES it (a restart releases the lock via the `--close` path). Never breaks for an arbitrary opener, never runs a tick unlocked. DELETE this once the whole fleet runs this version |
| **#8 recovery is recycle-then-read, NO Health/log text matching** (H4/#8, replaces the deleted nodegone flag) | gate confirmed: a deleted node's daemon stays `Running` on a LocalAPI query and only a RESTART yields `NeedsLogin` (tailscale/tailscale#20615); Health does NOT contain "node not found", only a generic not-in-map-poll / "Out of sync" — so exact-text matching was never viable | persistent `Self.Online=false` OR generic map-poll Health ⇒ `recycle_offline_tailscaled` recycles the daemon, and `recycle_tailscaled` now calls `ensure_login` (not just `refresh_exitnode`) so a freshly-`NeedsLogin` daemon re-auths immediately instead of idling until the next hourly converge. No log parsing, no epochs. The nodegone flag/log-tail and its refresh_exitnode guard were DELETED |
| **Re-auth ATTEMPT limiter, rc-independent** (H5) | the old rc-keyed backoff let a rc=0 `up` (that only PRINTED an unclicked AuthURL) reset the counter with a 20s floor → ~180 force-reauths/hour against control | a hard 30-min minimum between force-reauth ATTEMPTS + an absolute per-hour cap (default 3), persisted under `$RUN_DIR`, advanced on every attempt REGARDLESS of rc. Separate from the D4 failure backoff |
| **Re-auth refuses without a resolvable hostname** (H6/#9) | with `debug prefs` unavailable AND the hostname file missing, argv got no `--hostname` and the CLI rejects the `up` | hostname resolved from prefs → `$HOSTNAME_FILE` → `status --json` Self.HostName; if ALL three empty, log ERROR and DO NOT attempt (a doomed `up` still counts as an attempt and churns) |
| **`chpasswd` failure is loud; `check` verifies accounts UNLOCKED** (H7, P0) | chpasswd swallowed failure and `boxup check` only verified sshd was up, so after a swap wiped /etc/shadow a box could report healthy with box/root LOCKED and no login | chpasswd rc is logged per-account on failure; `boxup check` fails unless `box` (and `root` when present) have a usable password (`passwd -S` P, else /etc/shadow field-2), fail-safe to not-unlocked. Resurrection-path invariant |
| **`spawn_detached()` is the ONLY long-lived spawn primitive** (H9, defense-in-depth) | with `flock --close` the sshd sites were never a CONFIRMED live leak (self-daemonizing sshd closes fd 8 itself) — this is belt-and-braces, not a proven second #7 | all detached spawns (tailscaled, sshd ×2, worker) route through one helper that closes fd 8+9; a lint/test rule fails if `setsid`/`nohup`/`disown` appears outside it. One place to be right |
| **Converge `degraded` marker, return-neutral** (P1) | `do_ensure_body` was all-`\|\| true`, so a converge reported success even if every step failed, invisibly | each step's non-zero rc is now logged and stamps `$RUN_DIR/degraded` (cleared on a clean pass). RETURN SEMANTICS UNCHANGED — the marker is visibility only, never a gate on a tick |
| **Auth-key expiry is recorded and gates health** (H11) | tailscale keys expire (≤90d) and the date is NOT recoverable from the key; a box whose only unattended recovery path is a dead key is not healthy | expiry read from `$SECRETS_DIR/ts-authkey.expires` (ISO `YYYY-MM-DD`, seeded by the operator): `boxup check` FAILS when expired, `status` shows `authkey=EXPIRED:<date>`; a key expiring < 14 days is a WARNING (`authkey=expiring:<date>`) not a failure; a missing/unparseable file is fail-quiet (the key still works). **ASSUMPTION:** the current fleet key was minted 2026-08-28 with a 90-day expiry ⇒ 2026-11-26 (operator seeds the `.expires` file; boxup only reads it) |

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
