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
| `managed.toml` | brain-pushed config (FLEET-BRAIN §config-truth) | written ONLY by the VPS brain; hand edits are overwritten on the next reconcile. Missing = feature off. Under `/workspace` so it survives a swap like `config.toml` |
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
   console. **VERIFIED (box-8, 2026-08-28, r3 build 87e783b):** with
   `state/tailscale/` wiped, the WORKER TICK self-joined in **~17s** (NeedsLogin
   → `check_reason` fails → `do_ensure_body` → auth-key join; tags=`tag:grok-box`
   applied, exit node advertised, SSH host keys persisted). H12 on-box is
   CONFIRMED (the pre-H12 build's worker did NOT self-join in 90s; H12 closed
   that gap). Caveat: the rejoin's MagicDNS name got a `-1` suffix
   (`grok-box-8-1`) because the stale node still held `grok-box-8` — the
   split-brain aftermath (F2) is NOT on-box fixable and needs the brain/operator
   to delete the stale device + POST the name (FLEET-BRAIN row b; DESIGN wall
   F2 below). The split-brain itself is a DESIGN choice not to fix on-box.
5. **Node key expired / node deleted in console**: backend=NeedsLogin with a
   *populated* statedir — the node key hit its ~180-day expiry, or the node
   was removed in the admin console. `tailscale up` on an expired node exits
   silently, so `boxup once` re-auths with `--force-reauth`; the AuthURL
   appears in `status` as `auth=`. Re-auth reuses the existing machine key, so
   it is the same identity — no new node is forked.
   - **nodegone / server-deleted (H4/#8):** a node deleted server-side does NOT
     reliably land in NeedsLogin on a LocalAPI query — it stays `Running`
     while the map poll 404s (tailscale/tailscale#20615). Recovery is
     recycle-then-read: persistent `Self.Online=false` or a `mapfail` Health
     match (one of four substrings — see the H4 wall row) TRIGGERS a daemon
     RESTART (`recycle_offline_tailscaled` → `recycle_tailscaled`), which
     re-reads state and lands in NeedsLogin; `recycle_tailscaled` then calls
     `ensure_login` so re-auth happens immediately. The Health text is only a
     TRIGGER — the post-restart BackendState is the verdict; what was deleted is
     the #8 `nodegone` flag and its `tailscaled.log` tail (no LOG parsing, no
     exact "node not found" matching, which never appears in Health).
   - **re-auth `up` mentions (F9/#9):** the `--force-reauth` branch MENTIONS the
     current `--hostname` (prefs → hostname file → `status --json` Self.HostName;
     refuses if all empty) and the tags the device ALREADY carries (never
     config.toml — see the control-plane scoping in docs/AGENT.md §G). Never
     `--reset`. Attempts are rate-limited (30-min floor).

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
| config.toml seeded once, never overwritten (except `[fleet]`.vps/box_index/port, written idempotently by `fleet2 enroll`) | user's password/pins must survive upgrades | every install resets the login |
| ROOT never auto-detected from a checkout | a stray clone must not become the live root | dev tree silently drives a real box |
| Vendored tailscale bins in `bin/` | recovery after swap must not wait on apt/network | daemon can't restart offline |
| `set -u`, not blanket `set -e` | the worker loop must keep looping past transient failures | one transient error kills the self-heal loop |
| tailscaled-start flock in a subshell (fd 9 = START_LOCK) | a long-lived worker holding the lock wedges later starts | daemon restart deadlocks on the inherited lock. NB (D4): the daemon child no longer needs to close this fd itself — spawn_detached closes fd 8+9 belt-and-braces, and a self-daemonizing child anyway drops it; the load-bearing guarantee is flock --close on the CONVERGE lock (H1 row below), not a per-site close |
| **Converge lock: flock --close, wait-for-ensure, skip-for-tick, NEVER unlocked** (D3/B1/H3) | `boxup once`, the tick, and rollout can converge concurrently; a lost/absent lock must never mean "run anyway" | see the H1 + H3 rows below. Replaces the earlier "fail-open" design: an unopenable lock or a wait-timeout is now a hard skip (tick) / non-zero (once), NOT an unlocked run |
| **hb-stamp-on-contention** (D3/B1/N3) — its OWN row | a long `boxup once` starves hb; the next tick would spuriously recycle | it deliberately masks a freeze for the bounded converge duration — do NOT "simplify" it away |
| **Atomic mktemp+rename install** (D3/M2) | non-atomic copy over a running boxup; two concurrent installs truncate a fixed dotfile | worker reads a half-written/corrupt boxup |
| **Refresh backoff with env-only human bypass** (D4/F6/M1) | a persistently failing `set` retried every tick forever, invisibly; hourly `once` would reset a cmd-based bypass | silent infinite retry; unattended backoff reset |
| **Shim tail-sentinel + hardcoded-fallback-URL divergence** (D5/F2/F3) | `bash -n` accepts a boxup truncated at a statement boundary; a corrupt boxup's config parser is unavailable | truncated boxup execs+exits 0 silently; self-heal can't find its repo |
| **Root-clone sanity gate** (D5/F4) | the shim runs an unpinned clone as root, hourly | executes a partial/hostile clone as root |
| **`check` exit-2 skew fallback** (D6/B2) | exit 2 = unknown-subcommand = "old boxup"; a check bug emitting 2 downgrades fleet2 | healthy old box reported failing; notify-send spam |
| **Canary/abort + no-auto-rollback** (D7) | rollout deployed everywhere with no verify/brake; per-box failures discarded | a bad HEAD rolls the whole fleet unverified |
| **Sudo env sha plumbing** (D10/B3) | sudo env_reset drops exported vars; git archive carries no .git | every box stamps `sha=unknown`; drift detection blind |
| **`--advertise-tags` first-login only; re-auth MENTIONS already-held tags** (tags/F11/#9, control-plane-scoped) | on **login.tailscale.com** current CLI refuses an `up` that omits an already-set non-default flag, so re-auth must MENTION the hostname + tags the node already carries (from live prefs/`Self.Tags`, never config.toml). *Introducing* a new tag on re-auth still forbidden. On **headscale < 0.29.3** even mentioning a held tag is rejected (headscale#3374) — the old blanket "never pass tags on re-auth" rule was right for THAT control plane only. We run login.tailscale.com. | on our control plane: re-auth is a silent no-op and the box never rejoins (the #9 bug). If ever pointed at headscale <0.29.3: revert `run_reauth_up` to omit `--advertise-tags`. See docs/AGENT.md §G. Never `--reset` |
| **Converge lock is `flock --close`; NO stale-holder detector** (H1, replaces the deleted /proc/locks self-heal) | the #7 leak (a child inheriting the lock fd) is made STRUCTURALLY IMPOSSIBLE: an outer subshell holds the lock on fd 9 for the body's whole duration, the body runs in an inner subshell with `9<&-`, so neither it nor any descendant has the fd. The dual gate PROVED a holder detector cannot work with boxup's real leak shape — a subshell takes `flock -n`, spawns a detached child, then EXITS, so `/proc/locks` records the EXITED helper's pid (445980) not the inheriting daemon (445981); the holder reads "?", the counter resets, the break never fires. So the entire detector/classifier/skip-counter/5-skip-break was DELETED. **Alternatives considered / why lost:** (a) literal `flock -o CMD` command form — LOST: our body is an in-process bash function graph (do_tick/do_ensure_body), so `-o CMD` would need either `export -f` of the whole graph (fragile, drifts) or a re-exec of boxup (dispatch recursion); the outer-subshell + `9<&-` construct gives identical --close semantics in-process (supervisor-approved). (b) keep the /proc/locks detector — LOST: proven unfixable for this leak shape (pid 445980 vs 445981). | without `--close`, any spawn site that forgets to close the fd re-introduces #7; with it, forgetting is harmless. Do NOT resurrect the /proc/locks detector — it is unfixable for this leak shape |
| **Never run the converge body unlocked** (H3/D2) | old `flock -w 60` ran the body UNLOCKED on timeout, the no-`flock` branch ran it unlocked, and open-failure "failed open" — all three defeat mutual exclusion | try-mode contention → skip (200); wait-mode timeout / open-failure / no-flock → hard non-zero (201), `boxup once`/`up` exit non-zero, never a faked converge. install.sh asserts util-linux `flock` exists (D2). `tailscale_set_full` is `timeout`-bounded (the realistic way to hold the lock past 60s) |
| **Build-change tailscaled recycle + VERSIONED lock path** (E1/P1-3/F1) | boxes wedged by an OLD pre-H1 daemon still hold the inherited fd; `flock --close` cannot free an already-leaked fd; and box-8 r3 proved a VERSION-only trigger MISSES a same-version-different-sha upgrade | a runtime legacy-wedge detector was tried TWICE and DELETED — the empirical gate proved it inert (`stat` without `-L` on `/proc/PID/fd`; `pgrep -n` re-pick; substring `$STATE_DIR` match). install.sh recycles tailscaled ONCE on ANY build change — **installed VERSION != new VERSION OR installed GIT_SHA != new GIT_SHA** (F1(a): box-8 r3 reinstalled 5.1.0/059c658 → 5.1.0/87e783b, a real upgrade a VERSION-only gate skipped, leaving the pre-H1 daemon wedged and `boxup once` rc=201 for 60s). Recycle = exact `--statedir` NUL-token select → SIGTERM → poll ≤10s → SIGKILL → verify gone. **AND F1(b): the converge lock path is VERSIONED — `converge.v2.lock`** — so a daemon inherited from ANY older build flocks a DIFFERENT file and can NEVER wedge a v2 tick, independent of whether the install recycle fired. Belt (recycle) AND braces (versioned lock). **Alternatives considered / why lost:** (a) sha-ONLY trigger — LOST: a first install has no prior sha to diff cleanly; VERSION-or-sha covers both. (b) an `lsof`/`fuser` scan to find the lock holder at install — LOST: same fragility class as the deleted runtime detector, and unnecessary once the lock path is versioned. (c) marker/sentinel file — LOST (P1-3): disk contents vs live daemon generation diverge. **Breaks if undone:** a same-version rebuild leaves the pre-H1 daemon holding the old lock and every tick skips (box-8 r3, verbatim). |
| **#8 recovery is recycle-then-read; identity Health text is a TRIGGER, never the verdict** (H4/#8, replaces the deleted nodegone flag) | gate confirmed: a deleted node's daemon stays `Running` on a LocalAPI query and only a RESTART yields `NeedsLogin` (tailscale/tailscale#20615). The daemon RESTART, not any string, produces the authoritative BackendState. | persistent `Self.Online=false` OR a map-poll Health match ⇒ `recycle_offline_tailscaled` recycles, and `recycle_tailscaled` now calls `ensure_login` (not just `refresh_exitnode`) so a freshly-`NeedsLogin` daemon re-auths immediately instead of idling until the hourly converge. **Correction (D7):** `mapfail` DOES still substring-match Health, on FOUR lowercased strings — `"coordination server"`, `"not-in-map-poll"`, `"pollnetmap"`, `"out of sync"` — but only to TRIGGER a recycle; the post-restart BackendState is the verdict. What was DELETED is the #8 `nodegone` flag, its bounded `tailscaled.log` tail, and the `refresh_exitnode` nodegone guard — i.e. no LOG parsing and no exact "node not found" matching (that string never appears in Health). |
| **Install/update is session-detached + HUP-immune BEFORE the disruptive recycle** (F4/box-8 r4) | every install & `boxup update` on this fleet runs over SSH riding the tailnet — the SAME interface the E1 recycle SIGTERMs. Run inline, the SIGTERM drops the tailnet, the SSH session dies, and install.sh (its child) is HUP'd DEAD before it restarts tailscaled: box-8 sat OFFLINE 25+ min with no self-heal until the hourly `once` (r4 truth run, FINDINGS.md). This is the NORMAL case, not an edge. | install.sh copies files in the foreground, then re-execs its disruptive tail (`BOX_SETUP_DETACHED=1`) under `setsid` (new session, no controlling terminal) with `trap '' HUP`, stdout/stderr → `/var/log/boxup-install.log`. Order: **copy files → detach → kill old (recycle) → start new + `boxup once` → log DONE**. The foreground prints "tailnet will drop ~20s; reconnect and run `boxup status`" BEFORE the recycle and returns 0 promptly with the log pointer. A migration recycle ALWAYS forces a following `boxup once` even when `BOX_SETUP_ONCE` was not requested — otherwise it would kill tailscaled and never restart it (the exact brick). `boxup update` inherits this for free (it execs install.sh). **Alternatives considered / why lost:** (a) `nohup`-only (no new session) — LOST: `nohup` ignores SIGHUP but the process stays in the SSH session's process group; some teardown paths and a `kill -HUP -<pgid>` still reach it, and it keeps the controlling terminal — `setsid` is the actual session cut, `trap '' HUP` the belt. (b) "operator must run it under tmux/screen" — LOST: unenforceable and not how the fleet operates (fleet2/SSH one-shots, the hourly shim); a P1 brick cannot depend on operator discipline every single time. (c) keep the OLD daemon alive until the next reboot (no recycle at install) — LOST: defeats E1's whole purpose (an inherited pre-H1 daemon holding the leaked converge-lock fd keeps wedging every tick until reboot, and these boxes may not reboot for weeks); the recycle must happen at upgrade, just not synchronously in the SSH-riding process. **Breaks if undone:** any tailnet-riding install that triggers the recycle strands the box offline until the hourly `once` — verbatim box-8 r4. See docs/AGENT.md §B. |
| **One re-auth/first-login ATTEMPT limiter, rc-independent** (H5/D6/P1-1) | the old rc-keyed backoff let a rc=0 `up` (that only PRINTED an unclicked AuthURL) reset the counter with a 20s floor → ~180 `up`s/hour against control; and the first-login `up` was UNLIMITED | ONE limiter now wraps EVERY `tailscale up` (first-login AND force-reauth): a hard 30-min minimum between ATTEMPTS (`REAUTH_MIN_INTERVAL`), persisted under `$RUN_DIR`, advanced on every attempt REGARDLESS of rc; the `up` rc is captured/logged/returned (surfaces as a check FAIL + degraded marker), never `\|\| true`. **30 min justified:** above tailscale control-plane rate-limit headroom, and 1800s == the hourly period / 2, so the hourly `once` and a 15s tick cannot double-fire within one period. **Alternative considered / why lost:** an absolute per-hour cap — DROPPED (D6) as redundant (a 30-min floor already caps at 2/hour; a second knob can never bind first). **Breaks if undone:** an unbounded/rc-reset limiter lets a NeedsLogin or empty-statedir box hammer the control plane every tick. |
| **Re-auth refuses without a resolvable hostname** (H6/#9) | with `debug prefs` unavailable AND the hostname file missing, argv got no `--hostname` and the CLI rejects the `up` | hostname resolved from prefs → `$HOSTNAME_FILE` → `status --json` Self.HostName; if ALL three empty, log ERROR and DO NOT attempt (a doomed `up` still counts as an attempt and churns) |
| **`chpasswd` failure is loud; `check` verifies accounts UNLOCKED** (H7, P0) | chpasswd swallowed failure and `boxup check` only verified sshd was up, so after a swap wiped /etc/shadow a box could report healthy with box/root LOCKED and no login | chpasswd rc is logged per-account on failure; `boxup check` fails unless `box` (and `root` when present) have a usable password (`passwd -S` P, else /etc/shadow field-2), fail-safe to not-unlocked. Resurrection-path invariant |
| **`spawn_detached()` is the ONLY long-lived spawn primitive** (H9, defense-in-depth) | with `flock --close` the sshd sites were never a CONFIRMED live leak (self-daemonizing sshd closes fd 8 itself) — this is belt-and-braces, not a proven second #7 | all detached spawns (tailscaled, sshd ×2, worker) route through one helper that closes fd 8+9; a lint/test rule fails if `setsid`/`nohup`/`disown` appears outside it. One place to be right |
| **Converge `degraded` marker, return-neutral** (P1) | `do_ensure_body` was all-`\|\| true`, so a converge reported success even if every step failed, invisibly | each step's non-zero rc is now logged and stamps `$RUN_DIR/degraded` (cleared on a clean pass). RETURN SEMANTICS UNCHANGED — the marker is visibility only, never a gate on a tick |
| **do_tick's health probe IS `check_reason`; repair under a backoff** (H12 generalized/P1-1, box-8 Stages 1 & 3) | do_tick used to only restart a DEAD sshd and hand-pick repairs; a locked account, wiped host keys (Stage 1), OR a wiped statedir left at `NeedsLogin` (Stage 3) all waited up to an hour for the external `boxup once` | the tick's probe is `check_reason()` — the SAME single predicate `boxup check` uses, factored out so the two CANNOT drift (that was the whole point of one predicate). On any failure the tick runs the FULL `do_ensure_body` under its lock, bounded by the SAME backoff as refresh (20→60→180→600s cap) via `fail.repair`/`last-repair`, with `repair=failing:N` in status and a reason log — never a blind fixed loop. Stop hand-picking which repair a tick may run: the tick's job is "if not converged, converge"; ensure_login's own attempt-limiter (H5) still bounds `up`. Cost: check_reason is ~2 tailscale calls + passwd -S — measured fine for a 15s tick (if a future tailscale makes status slow, CACHE it, don't fork the list). **Alternatives considered / why lost:** (a) a parallel `tick_repair_needed` predicate list — LOST, it drifted from check (P1-1); (b) a fixed once/60s repair gate — LOST, an unsatisfiable predicate then loops blindly with no escalation/visibility. **Breaks if undone:** either the tick and check disagree on "healthy" (a box `check` calls broken keeps ticking as if fine), or a permanently-unsatisfiable predicate hammers the control plane every 15s. |
| **`ensure_name`: file = intent, LIVE identity = postcondition; HostName vs DNSName** (H13/P1-4/F2, box-8 Stages 3 + r3) | after an auth-key rejoin the node registered under the OS hostname (`cursor`); `ensure_name` early-returned because the `hostname` FILE already said grok-box-8 and never pushed — reachable only as `cursor`. AND (F2, box-8 r3): after a state-loss rejoin while the STALE node still held `grok-box-8`, the live node's Self.HostName was ALREADY `grok-box-8` but its MagicDNS name was `grok-box-8-1` — a HostName-only check passed while the box was unreachable under its intended name | `name_mismatch` now checks TWO kinds: **hostname** (Self.HostName != file, e.g. `cursor`) — self-fixable via `tailscale set --hostname` → check `name: live=X want=Y`; **dns** (Self.HostName == file but MagicDNS first label != file, the `-1` suffix) — NOT on-box fixable (`set --hostname` is a no-op when the hostname is unchanged) → check `name: dns=X want=Y`, ensure_name LOGS it and does NOT spin; remediation is delete-stale + `POST /device/<id>/name` (FLEET-BRAIN row b, verified HTTP 200). Fresh/unnamed with peers → `name: unnamed`. **Alternatives considered / why lost:** compare only Self.HostName — LOST (F2): it passes while the `-1` MagicDNS name makes the box unreachable; trust the file's existence — LOST (Stage 3): let `cursor` pass as healthy. **Breaks if undone:** a rejoined box silently answers to `cursor`/`grok-box-N-1` and every fleet script hits a dead/absent IP. |
| **`ensure_name` also sets the OS hostname to grok-box-N** (F3, cosmetic/best-effort) | the sand image ships OS hostname `cursor`; prompts, logs, and `hostname` all say `cursor`, misleading an operator ssh'd into a box (box-8 tests printed "on cursor" throughout) | once a grok-box-N is frozen, `ensure_name` runs `hostname grok-box-N` + writes `/etc/hostname`, best-effort (logs, never fails a converge), re-applied every converge because the overlay dies on an image swap (same pattern as passwords/nft). **Alternatives considered / why lost:** (a) leave it `cursor` — LOST: real operator-confusion footgun, and cheap to fix. (b) make it a `check` predicate/FAIL — LOST: it is COSMETIC; the tailscale identity is `Self.HostName`/prefs (already enforced), and failing health on an OS-hostname cosmetic would be over-strict. **Breaks if undone:** operators keep seeing `cursor` and can misidentify which box they're on. |
| **On-box CANNOT self-heal an identity collision (split-brain) — by design** (fleet2/API, next round) | after a rejoin the OLD node lingers in the tailnet as an offline corpse still holding the `grok-box-8` MagicDNS name; laptop scripts talking to grok-box-8 hit a dead IP | the box has NO Tailscale API credentials on purpose (blast radius: a compromised box must not be able to delete fleet nodes). Reconciling duplicates per hostname — delete the older offline one — is the **fleet2 + Tailscale API** job (`GET /api/v2/tailnet/-/devices`, next round). This is a DESIGN DECISION, not a tested capability. **Alternative considered / why lost:** put API creds on the box so it self-reconciles — LOST: a single compromised box could then delete the whole fleet's nodes; the blast radius is unacceptable for an unattended exit node on the WAN. **Breaks if undone:** either boxes can nuke fleet identity, or split-brain is left unreconciled — hence it MUST be an off-box (fleet2) job. |
| **Auth-key expiry is recorded and gates health** (H11/D6) | tailscale keys expire (≤90d) and the date is NOT recoverable from the key; a box whose only unattended recovery path is a dead key is not healthy | expiry read from `$SECRETS_DIR/ts-authkey.expires` (ISO `YYYY-MM-DD`, seeded by the operator): `boxup check` FAILS when expired (`status`: `authkey=EXPIRED:<date>`); a key expiring **< 7 days** is a WARNING (`authkey=expiring:<date>`) not a failure. **D6 — missing/unparseable is NOT silent:** `status` shows `authkey=unknown-expiry` and `check` logs a WARN once/hour (still not a FAIL — the key may be valid, and an unattended box must not be failed for an un-seeded sidecar). **Warn window = 7 days:** one weekly operator pass of margin — nothing authoritative backs a specific number (Tailscale's own KeyExpirationNotice defaults to 24h, far too short for an unattended fleet on a weekly human cadence); 14d produced a fortnight of steady-state noise for no added recoverability. **ASSUMPTION (operator-set, not derived):** the current fleet key was minted 2026-08-28 with a 90-day lifetime ⇒ `2026-11-26` (operator seeds `.expires`; boxup only reads it). **Also:** an ABSENT `ts-authkey` ⇒ `none` (no warn — URL-dance boxes are legitimate). |
| **`.gitignore` auth-key filename patterns** (H10) | a live tailnet key once sat at repo root as `auth_key.txt` — untracked but NOT ignored (`.gitignore` covered only `secrets/**`) while commits were happening in-tree | patterns `auth_key.txt`, `*authkey*`, `*auth_key*`, `tskey-*`, `*.authkey` ignore a stray key wherever it lands. **Alternative considered / why lost:** a pre-commit hook or a secret scanner — LOST: adds a dependency + a bypassable step (`--no-verify`), and must be installed per-clone; gitignore patterns are zero-dependency, always-on, and reviewable in one file. Belt-and-braces (the key belongs in `secrets/`, mode 600), not the primary control. |

## Prior art (D11)

What each does, what we borrowed, why we diverged.

- **tailscale [`containerboot`](https://github.com/tailscale/tailscale/blob/main/cmd/containerboot/main.go)**
  — env-driven `up`, state in a mounted volume.
  Borrowed: env-configured convergence. Diverged: we have no volume that
  survives an image swap, so state lives in `/workspace` and we keep a full
  re-join path (auth key / AuthURL).
- **[runit](http://smarden.org/runit/) / [s6](https://skarnet.org/software/s6/) supervision**
  — our worker loop is a poor-man's s6 (supervise +
  restart). Diverged: we cannot own PID 1 (tini + the sand supervisor do), so
  the loop is a userspace tick, not a real supervisor.
- **[ansible-pull](https://docs.ansible.com/ansible/latest/cli/ansible-pull.html)**
  — pull-based convergence. Borrowed: the shim's re-clone + reinstall is
  pull-based self-heal FOR A MISSING OR CORRUPT `boxup` only. Diverged: it is
  not a pull-based UPDATE path and never has been. The hourly
  `box-bootstrap.sh --once` execs the co-located `boxup` and touches GitHub only
  when that file is absent or fails its sanity gate, so a healthy box never
  re-clones and never acquires new code on its own. (Measured 2026-09-02: every
  box's `/var/log/box-bootstrap.log` still dated from the one-time 27 Aug
  install. An earlier belief that the hourly shim self-updated the platform is
  RETRACTED.) New releases reach a box only through the brain's rollout —
  fleet2 decision-table row d, `[rollout]` in docs/FLEET-BRAIN.md — which IS the
  control node this comparison says we diverged from.
- **[`tailscale up --reset`](https://tailscale.com/kb/1080/cli/#up)** — resets
  prefs to flags given. Informs our
  set-only-after-first-login rule: we never want the reset semantics post-join,
  so we use `set` and reserve `up` for `ensure_login`.
- **Kubernetes [CrashLoopBackOff](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#restart-policy)
  + systemd [`RestartSec`/`StartLimitBurst`](https://www.freedesktop.org/software/systemd/man/systemd.service.html)**
  (D4) — capped exponential backoff, reset on success, never a permanent give
  up. Borrowed wholesale for the refresh backoff (20→60→180→600s, reset on a
  successful `set`, no permanent stop).
- **Docker [`HEALTHCHECK`](https://docs.docker.com/reference/dockerfile/#healthcheck)
  / k8s [liveness-readiness](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)**
  (D6) — one exit-code health
  predicate owned by the workload, not the orchestrator. Borrowed: `boxup
  check` is that one predicate; fleet2 (the orchestrator) trusts its exit
  code instead of reimplementing health.
- **Ansible [`serial:` + `max_fail_percentage`](https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_strategies.html#setting-the-batch-size-with-serial)**
  (D7) — canary-then-batch with
  an abort. Borrowed: canary-first, verify, abort-on-first-failure.
  **[`kubectl rollout status`/`undo`](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_rollout/)**
  — informs the deliberate no-auto-rollback choice
  (rollback = redeploy a known-good sha; we print the command rather than
  building undo machinery).
- **rename-not-truncate self-replace ([rustup](https://github.com/rust-lang/rustup),
  dpkg)** (D3) — a running program
  keeps its fd on the old inode after `rename(2)`. Justifies the atomic
  mktemp+`mv -f` install: a live worker finishes reading the old boxup
  uninterrupted while the new file is installed.

## External references (D7)

Primary sources behind the tailscale/headscale decisions above:

- `tailscale up` flag semantics ("mentioning all non-default flags"):
  https://tailscale.com/kb/1080/cli/#up
- Auth keys (reusable / non-ephemeral / expiry ≤ 90d):
  https://tailscale.com/kb/1085/auth-keys
- `tailscale up` reset/re-auth behaviour discussion (up resets unmentioned
  prefs; --force-reauth): https://github.com/tailscale/tailscale/issues/5597
- Deleted node stays `Running` until a daemon restart yields `NeedsLogin`
  (the #8 / H4 basis): https://github.com/tailscale/tailscale/issues/20615
- headscale rejects `--advertise-tags` for already-held tags, fixed in
  v0.29.3 (the control-plane scoping in AGENT §G / F11):
  https://github.com/juanfont/headscale/issues/3374 ,
  fix PR https://github.com/juanfont/headscale/pull/3394 ,
  release notes https://github.com/juanfont/headscale/releases/tag/v0.29.3
- KeyExpirationNotice default (24h) — why our 7-day warn window cites nothing
  authoritative: https://tailscale.com/kb/1028/key-expiry