# Contributing

## Principles

- Scripts are the source of truth for behavior. Docs describe them; they do
  not duplicate large command blocks that will drift.
- `/workspace/box-setup/` is the on-box contract path. Keep `install.sh`
  flattening `scripts/*.sh` there.
- Never add `systemctl`, `pkill -f`, Linux cron, Tailscale SSH, or ephemeral
  auth keys.
- Identity (`state/tailscale`, `hostname`, Tailscale IPs) is per-box and
  must stay out of git.

## Docs map

| Question | File |
|---|---|
| I am an agent, what do I run? | `docs/AGENT.md` |
| Which procedure (A–G)? | `docs/RUNBOOK.md` |
| Why / platform / persistence | `docs/ARCHITECTURE.md` |
| How to pick `grok-box-N` | `docs/NAMING.md` |
| Something is broken | `docs/TROUBLESHOOTING.md` |

## Checks

Scripts are POSIX-ish bash. Prefer `set -u` over blanket `set -e` in
daemons that must keep looping. Run `bash -n` on every script before a PR.
