# Contributing

## Principles

- `boxup` is the source of truth for behavior; it is ONE file installed in
  ONE place (`/workspace/box-setup/boxup`). Docs describe it, never duplicate
  it.
- The on-box contract paths are frozen: `/workspace/box-setup/` and the
  `box-bootstrap.sh --once` shim (the external hourly automation calls it).
- Never add `systemctl`, Linux cron, `pkill -f`, Tailscale SSH, or ephemeral
  auth keys.
- Identity (`state/`, `hostname`, Tailscale IPs, auth keys) is per-box and
  must stay out of git.
- `docs/DESIGN.md` lists the incidents behind each special case — read it
  before "simplifying" one away.

## Docs map

| Question | File |
|---|---|
| I am an agent, what do I run? | `docs/AGENT.md` |
| Why / environment / persistence / rationale | `docs/DESIGN.md` |

## Checks

`make lint` (bash -n + shellcheck). boxup uses `set -u`, not blanket
`set -e` — the worker loop must keep looping past transient failures.
