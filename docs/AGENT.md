# AGENT.md — operator runbook

You are an agent on a Grok sand box (or SSH'd into one). This is everything
you run, in order, for every situation. The program is
`/workspace/box-setup/boxup`; `sudo` is passwordless.

> Driving the whole fleet from a laptop instead of one box? Use `fleetctl`
> (`fleetctl list|status|check|rollout`) — see the "Fleet operations (laptop)"
> section in [README.md](../README.md).

## A. Fresh box (never set up)

```bash
git clone https://github.com/chaogebaba/grok-box-setup.git /tmp/grok-box-setup
sudo bash /tmp/grok-box-setup/install.sh
sudo /workspace/box-setup/boxup once
```

- If status ends with `auth=https://login.tailscale.com/...`: relay that URL
  to the human, wait for approval, run `sudo /workspace/box-setup/boxup once`
  again.
- To skip the URL dance, put a **reusable, non-ephemeral** auth key in
  `/workspace/box-setup/secrets/ts-authkey` (mode 600) before `boxup once`,
  or install with `BOX_SETUP_AUTHKEY=tskey-...`.
- **Record the key's expiry (H11).** Tailscale auth keys expire (≤ 90 days) and
  the date is NOT recoverable from the key, so read the key's expiry from the
  Tailscale admin console (Settings → Keys) and write it next to the key as a
  single ISO date `YYYY-MM-DD`:
  ```bash
  # replace with the key's actual expiry shown in the admin console
  echo "<YYYY-MM-DD>" | sudo tee /workspace/box-setup/secrets/ts-authkey.expires
  sudo chmod 600 /workspace/box-setup/secrets/ts-authkey.expires
  ```
  `boxup check` FAILS on an expired key and WARNs (once/hour, not a failure) if
  a key exists but this file is missing/unparseable; a box with NO key at all
  shows nothing (URL-dance boxes are legitimate). `status` shows
  `authkey=expiring:<date>` (< 7 days), `authkey=EXPIRED:<date>`, or
  `authkey=unknown-expiry`. When you rotate the key, update this file in the
  same step. **Current-fleet assumption (operator-set, verify in the console —
  not derived by boxup):** the key in use was minted 2026-08-28 with a 90-day
  lifetime ⇒ expiry `2026-11-26`.
- The box names itself: once logged in with peers visible, `boxup` picks the
  lowest free `grok-box-N`, stores it in `/workspace/box-setup/hostname`, and
  pushes it. Do not invent names by hand.

## B. Refresh to the latest version

Always a fresh clone; never `git pull` in place, never trust an existing
`/tmp` checkout (a stale copy once kept a box on an old version):

```bash
sudo /workspace/box-setup/boxup update     # clone + install + tells you next step
sudo /workspace/box-setup/boxup once
```

(Equivalent by hand: fresh `git clone` to a `mktemp -d`, then
`sudo bash <tmp>/install.sh`.)

> **The tailnet drops ~20s during an upgrade — this is expected, and it will
> NOT strand the box (F4).** When the build changes, install.sh recycles
> tailscaled to clear any inherited converge-lock wedge (E1), which briefly
> drops the tailnet you are almost certainly SSH'd in over. install.sh handles
> this itself: it copies every file, then runs the disruptive tail (recycle +
> restart + `boxup once`) inside a **session-detached, HUP-immune** process
> (progress logged to `/var/log/boxup-install.log`), and the foreground command
> returns 0 **immediately** with a line like `install: the tailnet will drop for
> ~20s ...`. So your SSH session dying mid-upgrade no longer kills the upgrade —
> the detached installer finishes on its own and restarts tailscaled. Just
> **reconnect after ~20–30s and confirm**:
> ```bash
> sudo /workspace/box-setup/boxup status    # v= should show the new version/sha
> sudo tail -n 40 /var/log/boxup-install.log # ends with 'install: DONE (rc=0)'
> ```
> A `DONE (rc=0)` line means the detached install completed cleanly; `rc=201`
> means the converge lock was busy (retry `boxup once` — NOT a fake success).
> (History: before 5.2.0 a clean `boxup once` exited **rc=1** — its `once)`/`up)`
> arms ended on a bare `[ "$_rc" = 201 ] && exit …` test that, on a healthy
> converge (`_rc=0`), left the arm's status at 1 (no `set -e`). This was a
> trailing-conditional bug, NOT a `run_tick` converge race — `run_tick` always
> returns 0. Fixed in 5.2.0: both arms now `exit 0` on the clean path and only
> propagate 201, so a clean detached install logs `DONE (rc=0)`.)
> (History, box-8 r4: before F4 the recycle ran inline in the SSH session, so
> the SIGTERM dropped the tailnet, killed the SSH session, and killed install.sh
> before it could restart tailscaled — the box sat offline 25+ min. That is what
> the detach fixes; do not "simplify" install.sh back to an inline recycle.)

## C. Verify health

```bash
sudo /workspace/box-setup/boxup status
sudo /workspace/box-setup/boxup check   # exit 0 healthy / 1 unhealthy (never 2)
```

`status` prints one line; `check` is the single health predicate (same one
`fleetctl` and rollout verification use): exit 0 and `check=OK ...` when
healthy, else exit 1 and `check=FAIL reason=<first-failed-predicate>`.

Healthy: `backend=Running online=yes exit-node=yes sshd=up ipfwd=4:1,6:1`
with numeric pids and a small `hb=` age (≤ ~30s), and `v=5.2.0/<sha>`.
Cross-check from another machine on the tailnet: `tailscale ping grok-box-N`
and `ssh box@grok-box-N` (password from config.toml, default `12345678`).

If a persistently failing exit-node refresh has escalated, `status` shows
`refresh=failing:N` (N = consecutive failures; the retry window backs off
20s→60s→180s→600s). Force one immediate retry, bypassing the backoff, with the
env form in section D.

## D. Something is wrong

| Symptom | Meaning | Do |
|---|---|---|
| `auth=` URL in status | box needs (re-)login | relay URL to the human, then `boxup once` |
| `backend=NeedsLogin`, no URL | node needs (re-)login: first login (empty statedir) or expired/deleted node key (populated statedir) | `boxup once` — starts login/re-auth in both cases (populated statedir re-auths with `--force-reauth`; a seeded auth-key may complete with no URL); if `boxup status` then shows `auth=`, relay that URL |
| `online=no` for >1 min | map poll died (freeze) | wait one worker tick (15s); else `boxup once` |
| `exit-node=no` | prefs lost after swap | `boxup once` (refresh pushes full `tailscale set`) |
| `sshd=down` or login refused | swap wiped shadow/config | `boxup once` re-applies password + drop-in |
| `ipfwd` not `4:1,6:1` | sysctl wiped | `boxup tick` |
| `check=FAIL reason=...` | that predicate is unhealthy | act on the named predicate (its own row here); most are fixed by `boxup once` |
| `refresh=failing:N` in status | exit-node `tailscale set` has failed N times in a row (backoff 20→60→180→600s) | check `/var/log/boxup-worker.log`; force one immediate retry with `sudo env BOXUP_FORCE_REFRESH=1 /workspace/box-setup/boxup once` |
| `hb=-` or huge | worker dead | `boxup once` (restarts it) |
| `authkey=expiring:<date>` in status | seeded auth key expires in < 7 days | mint a new reusable key, write it to `secrets/ts-authkey`, update `secrets/ts-authkey.expires` (see §A) |
| `authkey=EXPIRED:<date>` in status / `check=FAIL reason=authkey EXPIRED` | the unattended recovery key is dead | rotate the key NOW (§A); until then a state-loss event cannot self-recover |
| `authkey=unknown-expiry` in status / `check: WARN authkey expiry unknown` | `secrets/ts-authkey.expires` missing or unparseable | seed it (§A); the key may still be valid — this is a warning, not a check failure |
| `ssh grok-box-N` times out but the node is online under another name (e.g. `cursor`, its OS hostname) | after an auth-key rejoin the box registered under the OS hostname and hasn't been renamed yet (H13) | reach it via its `tailscale status` IP or the wrong name, run `sudo /workspace/box-setup/boxup once` (pushes `set --hostname` from the frozen name file); `check` shows `name: live=cursor want=grok-box-N` until it converges. Then delete the OLD grok-box-N node in the console (or let fleetctl reconcile once it exists) |
| `check=FAIL reason=name: dns=grok-box-N-1 want=grok-box-N` / `ssh grok-box-N` hits a DEAD/stale IP while the box is reachable at `grok-box-N-1` | split-brain: a state-loss rejoin minted a NEW node; the STALE node still holds the `grok-box-N` MagicDNS name, so the live node got a `-1` suffix. **NOT on-box fixable** — `tailscale set --hostname` is a no-op (Self.HostName is already correct; only the MagicDNS name carries `-1`). | DELETE the stale/older OFFLINE device, THEN rename the live one: `curl -X DELETE https://api.tailscale.com/api/v2/device/<stale-id> -u "$TOKEN:"` then `curl -X POST https://api.tailscale.com/api/v2/device/<live-id>/name -u "$TOKEN:" -H 'Content-Type: application/json' -d '{"name":"grok-box-N"}'` (verified HTTP 200 restores the name). This is the fleetctl reconcile row (b) job once the brain exists. |
| `check=FAIL reason=name: unnamed` | box is Running with peers visible but never picked a grok-box-N | `boxup once` / wait a tick — it picks the lowest free name from peers and freezes it; if it persists, check peers are actually visible (`tailscale status`) |
| tailnet shows two nodes for one box | stale identity got recreated | delete the OLD node in the admin console; never copy `state/` between boxes |

Logs: `/var/log/boxup-worker.log`, `/var/log/tailscaled.log`.

## E. Never do

- `pkill -f anything` — it kills agent shells that merely mention the name.
- `tailscale up` on a logged-in box — it resets every flag you didn't pass.
- `systemctl` / cron — they do not exist here; the hourly automation and the
  worker loop are the only schedulers.
- Copy `state/tailscale/`, `hostname`, or an auth key from another box.
- Run a second tailscaled on a different statedir.

## F. The hourly keep-alive (already configured, for reference)

An external Grok automation runs, every hour:

```bash
sudo /workspace/box-setup/box-bootstrap.sh --once
```

That shim calls `boxup once`. It is the resurrection path after an image
swap — do not rename or remove either file. The two shim files
(`box-bootstrap.sh`, `boxup`) live in `/workspace/box-setup/` only; **v5.2.0
installs NOTHING in `/usr/local/sbin`** (the old v4 layout put helper shims
there — install.sh now actively removes them). Do not look for or recreate
`/usr/local/sbin` shims; they are not part of v5.

**Self-heal (since v5.1):** the shim now also repairs a missing or corrupt
`boxup`. If `/workspace/box-setup/boxup` is absent, fails `bash -n`, or has
lost its `# boxup-eof` tail sentinel, the shim clones the repo fresh from
GitHub (https only, `--depth 1`), sanity-checks the clone, reinstalls, runs
`boxup once`, then satisfies the original request. It logs `[shim] SELF-HEAL:`
to stderr and runs as root on the hourly schedule — so a `[shim] SELF-HEAL:`
line in the logs means the on-box boxup was corrupt and was re-fetched from
GitHub. The clone URL is `[update] repo` in config.toml (must be `https://`),
else the built-in default.

## G. Tags (`[tailscale] tags`) and manual retag

`[tailscale] tags` (e.g. `tags = "tag:grok-box"`) is added to `tailscale up`
**only at first login** (empty statedir). It is deliberately NEVER *introduced*
on the key-expiry / re-auth path, because converting a live user-owned node to
tag-owned during an unattended re-auth can lock it out of the tailnet.

**Mention vs introduce (reconciles the old blanket rule with #9).** There are
two different operations that both touch `--advertise-tags` on a re-auth `up`,
and they are NOT the same:

- *Introducing* a tag the node does not currently carry — forbidden on re-auth
  (the lock-out above). Still a manual operator step.
- *Mentioning* a tag the node ALREADY carries — required by current tailscale
  CLI, which refuses an `up` that omits any already-set non-default flag
  ("requires mentioning all non-default flags"). Restating the current value is
  not a change. boxup's re-auth path (`run_reauth_up`) therefore MENTIONS the
  tags read from the device's LIVE prefs / `Self.Tags` (never from
  config.toml), and mentions the current `--hostname`, so the `up` is accepted.
  If the device has no tags, none are mentioned.

**Control-plane scope (this is load-bearing).** We run **login.tailscale.com**
(Tailscale's hosted control plane), where mentioning already-held tags on
re-auth is correct and required. The old "never pass tags on re-auth at all"
rule was written for **headscale < 0.29.3**, which rejects `--advertise-tags`
even for tags the node already holds (headscale#3374) — on that control plane
the mention itself fails. If this fleet is ever pointed at a headscale < 0.29.3
server, revert `run_reauth_up` to omit `--advertise-tags` entirely. As long as
we are on login.tailscale.com, mention-current-tags is the correct behaviour.

Ordering (do this before enabling tags): the tailnet ACL `tagOwners`
(and `autoApprovers` for the exit routes) for the tag MUST exist BEFORE you seed
`[tailscale] tags` into any box's config.toml — the first-login branch is also
the state-lost recovery path, and a box rebuilding its identity with an
unauthorized tag cannot rejoin at all. If the seeded auth key itself carries
tags, they must match the config value.

To retag an ALREADY-registered node, it is a **manual** operator step (never
automatic): once the ACL authorizes the tag, run on the box

```bash
h="$(cat /workspace/box-setup/hostname 2>/dev/null)"
case "$h" in
  grok-box-[0-9]*) ;;
  *) echo "refusing: hostname file is '$h' (want grok-box-N); run 'sudo /workspace/box-setup/boxup once' first"; exit 1 ;;
esac
sudo /workspace/box-setup/bin/tailscale up --advertise-tags=tag:grok-box --force-reauth \
  --hostname="$h" \
  --ssh=false --advertise-exit-node --accept-dns --snat-subnet-routes=true --operator=box
```

then `sudo /workspace/box-setup/boxup once` to re-push prefs.
