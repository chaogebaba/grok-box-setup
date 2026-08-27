#!/bin/bash
# install.sh — seed /workspace/box-setup from this repo.
#
# Usage (on the box, as root or passwordless sudo):
#   git clone https://github.com/chaogebaba/grok-box-setup.git /tmp/grok-box-setup
#   sudo bash /tmp/grok-box-setup/install.sh
#   sudo /workspace/box-setup/boxup once
#
# Env:
#   BOX_SETUP_ROOT   install destination (default /workspace/box-setup)
#   BOX_SETUP_ONCE=1 run `boxup once` after install
#   BOX_SETUP_AUTHKEY=tskey-...   write secrets/ts-authkey (reusable, non-ephemeral)
#   BOX_SSH_PASSWORD=...          ssh password for root/box (else config.toml,
#                                 else 12345678)
#
# Never copies state/ from the repo. Never copies hostname. Never overwrites an
# existing config.toml. Cleans up the v4 script layout (dual copies at DEST
# root + DEST/scripts, /usr/local/sbin helpers) — v5 is one file, one copy.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${BOX_SETUP_ROOT:-/workspace/box-setup}"

log() { echo "install: $*"; }

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo env BOX_SETUP_ROOT="$DEST" \
      BOX_SETUP_ONCE="${BOX_SETUP_ONCE:-}" \
      BOX_SETUP_AUTHKEY="${BOX_SETUP_AUTHKEY:-}" \
      BOX_SSH_PASSWORD="${BOX_SSH_PASSWORD:-}" \
      bash "$0" "$@"
  fi
  echo "install: need root" >&2
  exit 1
fi

log "repo=$REPO_ROOT dest=$DEST"

# Stop the old worker BEFORE replacing files: the running copy knows its own
# argv shape best. boxup's own reaper also recognizes v4 workers as a backstop.
if [ -x "$DEST/box-bootstrap.sh" ] && [ ! -f "$DEST/boxup" ]; then
  bash "$DEST/box-bootstrap.sh" --stop >/dev/null 2>&1 || true
fi

mkdir -p "$DEST"/{bin,docs,etc,secrets,state/tailscale,state/ssh}

install -m 0755 "$REPO_ROOT/boxup" "$DEST/boxup"
install -m 0755 "$REPO_ROOT/box-bootstrap.sh" "$DEST/box-bootstrap.sh"
install -m 0755 "$REPO_ROOT/install.sh" "$DEST/install.sh"
install -m 0644 "$REPO_ROOT/etc/config.example.toml" "$DEST/etc/config.example.toml"
install -m 0644 "$REPO_ROOT/docs/"*.md "$DEST/docs/" 2>/dev/null || true
install -m 0644 "$REPO_ROOT/README.md" "$DEST/README.md" 2>/dev/null || true
install -m 0644 "$REPO_ROOT/VERSION" "$DEST/VERSION" 2>/dev/null || true

# config.toml is the user's, not ours. Seed it once, never overwrite it, so a
# custom ssh password survives every later install.
if [ ! -e "$DEST/config.toml" ]; then
  install -m 0600 "$REPO_ROOT/etc/config.example.toml" "$DEST/config.toml"
  log "seeded config.toml (defaults; edit [ssh].password to change the login)"
else
  chmod 0600 "$DEST/config.toml" 2>/dev/null || true
  log "kept existing config.toml"
fi

[ -e "$DEST/hostname" ] || : > "$DEST/hostname"

if [ -n "${BOX_SETUP_AUTHKEY:-}" ]; then
  umask 077
  printf '%s\n' "$BOX_SETUP_AUTHKEY" > "$DEST/secrets/ts-authkey"
  chmod 600 "$DEST/secrets/ts-authkey"
  umask 022
  log "wrote secrets/ts-authkey"
fi

chmod 700 "$DEST/state" "$DEST/state/tailscale" "$DEST/state/ssh" \
  "$DEST/secrets" 2>/dev/null || true

# --- v4 cleanup --------------------------------------------------------------
# One copy of one file replaces eight scripts installed twice. Remove the old
# layout so nothing stale can ever be executed again. Never touches state/,
# secrets/, bin/, hostname or config.toml.
V4_SCRIPTS="start-tailscaled.sh tailscale-selfheal.sh ensure-ip-forward.sh \
  refresh-exitnode-if-needed.sh health-tick-forward.sh \
  tailscale-exitnode-nat.sh pick-name.sh"
for s in $V4_SCRIPTS; do
  rm -f "$DEST/$s" "/usr/local/sbin/$s"
done
rm -f /usr/local/sbin/box-bootstrap.sh /usr/local/sbin/tailscaled
rm -rf "${DEST:?}/scripts" "${DEST:?}/lib" /usr/local/sbin/lib
rm -f "$DEST/RUNBOOK.md" "$DEST/etc/default-tailscaled" /etc/default/tailscaled

# Reap any surviving v4 selfheal worker (boxup recognizes the old argv too).
bash "$DEST/boxup" stop >/dev/null 2>&1 || true

log "installed boxup $(cat "$DEST/VERSION" 2>/dev/null || echo '?') at $DEST"

if [ "${BOX_SETUP_ONCE:-}" = 1 ]; then
  log "running boxup once"
  bash "$DEST/boxup" once
else
  log "next: sudo $DEST/boxup once"
  log "then follow $DEST/docs/AGENT.md"
fi
