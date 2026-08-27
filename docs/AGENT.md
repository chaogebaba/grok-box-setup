# Agent guide — clone this repo and stand up the box

You are an AI agent on a Debian 13 Grok/sand box (PID 1 = tini, **no systemd**).
Your job: install this repo and keep OpenSSH + a Tailscale **exit node** healthy.

Read this file first. Then `docs/RUNBOOK.md`. Do not improvise around the Never list.

## 1. Clone and install

```bash
DEST=/workspace/box-setup
REPO_URL="${REPO_URL:-https://github.com/chaogebaba/grok-box-setup.git}"

if [ -x "$DEST/box-bootstrap.sh" ]; then
  sudo "$DEST/box-bootstrap.sh" --once
else
  tmp=$(mktemp -d)
  git clone --depth 1 "$REPO_URL" "$tmp/grok-box-setup"
  sudo "$tmp/grok-box-setup/install.sh"
  sudo "$DEST/box-bootstrap.sh" --once
fi
```

`install.sh` copies scripts + docs into `/workspace/box-setup`. It never copies
`state/tailscale` or a `hostname` from the repo. One node identity per box.

Optional reusable **non-ephemeral** auth key (only used when statedir is empty):

```bash
sudo BOX_SETUP_AUTHKEY='tskey-auth-…' /path/to/install.sh
```

## 2. What you do next

Print the `--once` status line. Then follow **exactly one** procedure in
[`RUNBOOK.md`](RUNBOOK.md):

| Status line | Procedure |
|---|---|
| `auth=https://login.tailscale.com/…` | A2 — paste URL, stop |
| `backend=Running` and no `hostname` / not `grok-box-N` | A3 — list peers, write next free name, `set` |
| `backend=Running online=yes exit-node=yes sshd=up ipfwd=4:1,6:1` | healthy — stop |
| `ipfwd=4:0` or `ipfwd=6:0` | G — forwarding tick, then stop |
| statedir kilobytes + image just swapped | C — `--once` only, do not bump N |
| anything else | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) |

## 3. Hard rules

- Call `/workspace/box-setup/box-bootstrap.sh` as the restore path.
- Do **not** pick `grok-box-N` until `tailscale status` lists Self + peers.
- Do not ask the human which N to use. Compute it ([`NAMING.md`](NAMING.md)).
- Do not ask for an auth key when `sudo wc -c state/tailscale/tailscaled.state`
  is already kilobytes. The file is mode 600 root; a non-sudo read looks empty.
- Do not run `tailscale login` or a second `tailscale up` after login.
  `backend=NoState` for a few seconds is not NeedsLogin.
- Never: `systemctl`, `pkill`, cron, a second `tailscaled`, Tailscale SSH,
  a **partial** `tailscale up`, invent kill commands.
- Kill a stray `tailscaled` by **PID only**.

## 4. Human clicks (only these)

1. Open the AuthURL and click **Connect** (first join, empty statedir).
2. Admin console → this machine → approve **Use as exit node** for both
   `0.0.0.0/0` and `::/0` (once per box).

You do everything else, including naming.

## 5. Hourly keep-alive

Install a Grok Bot automation named `Box keep-alive`, hourly 24/7, prompt
verbatim from [`RUNBOOK.md`](RUNBOOK.md) section D. Without it the box sleeps
after a few idle minutes and will not rebuild after an image swap.
