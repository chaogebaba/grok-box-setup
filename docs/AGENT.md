# AGENT.md — operator runbook

You are an agent on a Grok sand box (or SSH'd into one). This is everything
you run, in order, for every situation. The program is
`/workspace/box-setup/boxup`; `sudo` is passwordless.

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
```

Healthy: `backend=Running online=yes exit-node=yes sshd=up ipfwd=4:1,6:1`
with numeric pids and a small `hb=` age (≤ ~30s). Cross-check from another
machine on the tailnet: `tailscale ping grok-box-N` and
`ssh box@grok-box-N` (password from config.toml, default `12345678`).

## D. Something is wrong

| Symptom | Meaning | Do |
|---|---|---|
| `auth=` URL in status | box needs (re-)login | relay URL to the human, then `boxup once` |
| `backend=NeedsLogin`, no URL | login flow not started | `boxup once` |
| `online=no` for >1 min | map poll died (freeze) | wait one worker tick (15s); else `boxup once` |
| `exit-node=no` | prefs lost after swap | `boxup once` (refresh pushes full `tailscale set`) |
| `sshd=down` or login refused | swap wiped shadow/config | `boxup once` re-applies password + drop-in |
| `ipfwd` not `4:1,6:1` | sysctl wiped | `boxup tick` |
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
