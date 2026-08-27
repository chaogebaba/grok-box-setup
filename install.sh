#!/bin/bash
# install.sh — seed /workspace/box-setup from this repo.
#
# Usage (on the box, as root or passwordless sudo):
#   git clone <repo-url> /tmp/grok-box-setup
#   sudo bash /tmp/grok-box-setup/install.sh
#   sudo bash /workspace/box-setup/box-bootstrap.sh --once
#
# Env:
#   BOX_SETUP_ROOT   install destination (default /workspace/box-setup)
#   BOX_SETUP_ONCE=1 run --once after install
#   BOX_SETUP_AUTHKEY=tskey-...   write secrets/ts-authkey (reusable, non-ephemeral)
#
# Never copies state/tailscale from the repo. Never copies hostname.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${BOX_SETUP_ROOT:-/workspace/box-setup}"

log() { echo "install: $*"; }

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo env BOX_SETUP_ROOT="$DEST" \
      BOX_SETUP_ONCE="${BOX_SETUP_ONCE:-}" \
      BOX_SETUP_AUTHKEY="${BOX_SETUP_AUTHKEY:-}" \
      bash "$0" "$@"
  fi
  echo "install: need root" >&2
  exit 1
fi

log "repo=$REPO_ROOT dest=$DEST"

mkdir -p "$DEST"/{bin,docs,etc,lib,scripts,secrets,state/tailscale}

for s in box-bootstrap.sh start-tailscaled.sh tailscale-selfheal.sh \
         ensure-ip-forward.sh refresh-exitnode-if-needed.sh \
         health-tick-forward.sh tailscale-exitnode-nat.sh pick-name.sh; do
  install -m 0755 "$REPO_ROOT/scripts/$s" "$DEST/$s"
  install -m 0755 "$REPO_ROOT/scripts/$s" "$DEST/scripts/$s"
done

install -d -m 0755 "$DEST/lib" "$DEST/scripts/lib"
install -m 0644 "$REPO_ROOT/scripts/lib/"*.sh "$DEST/lib/"
install -m 0644 "$REPO_ROOT/scripts/lib/"*.sh "$DEST/scripts/lib/"

install -m 0644 "$REPO_ROOT/etc/default-tailscaled" "$DEST/etc/default-tailscaled"

install -m 0644 "$REPO_ROOT/docs/"*.md "$DEST/docs/"
install -m 0644 "$REPO_ROOT/docs/RUNBOOK.md" "$DEST/RUNBOOK.md"
install -m 0644 "$REPO_ROOT/README.md" "$DEST/README.md" 2>/dev/null || true
install -m 0644 "$REPO_ROOT/VERSION" "$DEST/VERSION" 2>/dev/null || true
install -m 0755 "$REPO_ROOT/install.sh" "$DEST/install.sh"

if [ ! -e "$DEST/hostname" ]; then
  : > "$DEST/hostname"
fi

if [ -n "${BOX_SETUP_AUTHKEY:-}" ]; then
  umask 077
  printf '%s\n' "$BOX_SETUP_AUTHKEY" > "$DEST/secrets/ts-authkey"
  chmod 600 "$DEST/secrets/ts-authkey"
  log "wrote secrets/ts-authkey"
fi

chmod 700 "$DEST/state" "$DEST/state/tailscale" "$DEST/secrets" 2>/dev/null || true

log "installed files:"
ls -1 "$DEST"/*.sh "$DEST/RUNBOOK.md" 2>/dev/null || true

# Drop every in-memory worker (pidfile PID and leftovers) so the next --once
# loads this script. Does not stop tailscaled.
if [ -x "$DEST/box-bootstrap.sh" ]; then
  bash "$DEST/box-bootstrap.sh" --stop >/dev/null 2>&1 || true
fi

if [ "${BOX_SETUP_ONCE:-}" = 1 ]; then
  log "running box-bootstrap.sh --once"
  bash "$DEST/box-bootstrap.sh" --once
else
  log "next: sudo bash $DEST/box-bootstrap.sh --once"
  log "then follow $DEST/RUNBOOK.md (or docs/AGENT.md)"
fi
