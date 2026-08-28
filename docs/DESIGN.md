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
