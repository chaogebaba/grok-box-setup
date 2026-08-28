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

## C. Verify health

```bash
sudo /workspace/box-setup/boxup status
sudo /workspace/box-setup/boxup check   # exit 0 healthy / 1 unhealthy (never 2)
```

`status` prints one line; `check` is the single health predicate (same one
`fleetctl` and rollout verification use): exit 0 and `check=OK ...` when
healthy, else exit 1 and `check=FAIL reason=<first-failed-predicate>`.

Healthy: `backend=Running online=yes exit-node=yes sshd=up ipfwd=4:1,6:1`
with numeric pids and a small `hb=` age (≤ ~30s), and `v=5.1.0/<sha>`.
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
swap — do not rename or remove either file.

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
**only at first login** (empty statedir). It is deliberately NEVER applied on
the ~180-day key-expiry re-auth path, because converting a live user-owned node
to tag-owned during an unattended re-auth can lock it out of the tailnet.

Ordering (do this before enabling tags): the tailnet ACL `tagOwners`
(and `autoApprovers` for the exit routes) for the tag MUST exist BEFORE you seed
`[tailscale] tags` into any box's config.toml — the first-login branch is also
the state-lost recovery path, and a box rebuilding its identity with an
unauthorized tag cannot rejoin at all. If the seeded auth key itself carries
tags, they must match the config value.

To retag an ALREADY-registered node, it is a **manual** operator step (never
automatic): once the ACL authorizes the tag, run on the box

```bash
sudo /workspace/box-setup/bin/tailscale up --advertise-tags=tag:grok-box --force-reauth \
  --ssh=false --advertise-exit-node --accept-dns --snat-subnet-routes=true --operator=box
```

then `sudo /workspace/box-setup/boxup once` to re-push prefs.
