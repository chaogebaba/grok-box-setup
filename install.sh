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
      BOX_SETUP_GIT_SHA="${BOX_SETUP_GIT_SHA:-}" \
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

# Atomic executable install (D3/M2): write to a UNIQUE mktemp file INSIDE $DEST
# then rename onto the destination. Same directory ⇒ rename(2) ⇒ atomic swap;
# a running bash keeps its fd on the old inode and finishes reading the old
# file uninterrupted (precedent: rustup / dpkg self-replace). A fixed dotfile
# name would let two concurrent installs (D5's hourly self-heal makes that
# plausible) truncate each other's partial write and then atomically install a
# corrupt file — mktemp gives each install its own scratch inode.
install_atomic() {
  local mode="$1" src="$2" dst="$3" tmp
  tmp="$(mktemp "$(dirname "$dst")/.install.XXXXXX")" || return 1
  if ! install -m "$mode" "$src" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$dst"
}

# Refuse to install a boxup that lost its tail sentinel (D5): the shim's
# corruption predicate keys on `# boxup-eof` being the literal last line, and a
# truncated boxup still parses (bash -n stops at a statement boundary) and
# execs silently. Refuse LOUDLY and leave the existing installed boxup
# untouched — we check BEFORE writing, and install_atomic's rename ordering
# means a refusal never half-replaces the live file.
if [ "$(tail -n1 "$REPO_ROOT/boxup")" != "# boxup-eof" ]; then
  echo "install: FATAL — $REPO_ROOT/boxup is missing its '# boxup-eof' tail sentinel;" >&2
  echo "install: refusing to install a possibly-truncated boxup. Existing install left untouched." >&2
  exit 1
fi

install_atomic 0755 "$REPO_ROOT/boxup" "$DEST/boxup"
install_atomic 0755 "$REPO_ROOT/box-bootstrap.sh" "$DEST/box-bootstrap.sh"
install_atomic 0755 "$REPO_ROOT/install.sh" "$DEST/install.sh"
install -m 0644 "$REPO_ROOT/etc/config.example.toml" "$DEST/etc/config.example.toml"
install -m 0644 "$REPO_ROOT/docs/"*.md "$DEST/docs/" 2>/dev/null || true
install -m 0644 "$REPO_ROOT/README.md" "$DEST/README.md" 2>/dev/null || true
install -m 0644 "$REPO_ROOT/VERSION" "$DEST/VERSION" 2>/dev/null || true

# Stamp the installed git sha (D10). Sources, in order: $BOX_SETUP_GIT_SHA
# (set by fleetctl rollout, whose git archive carries no .git); a rev-parse of
# the source tree ($REPO_ROOT — `boxup update`'s clone has .git); else
# "unknown". Boxup surfaces it in status as v=<version>/<sha>.
box_git_sha="${BOX_SETUP_GIT_SHA:-}"
if [ -z "$box_git_sha" ]; then
  box_git_sha="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
fi
[ -n "$box_git_sha" ] || box_git_sha="unknown"
printf '%s\n' "$box_git_sha" > "$DEST/GIT_SHA"
chmod 0644 "$DEST/GIT_SHA" 2>/dev/null || true
log "stamped GIT_SHA=$box_git_sha"

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
  rm -f "$DEST/$s" "/usr/local/sbin/$s" || true
done
rm -f /usr/local/sbin/box-bootstrap.sh /usr/local/sbin/tailscaled || true
rm -rf "${DEST:?}/scripts" "${DEST:?}/lib" /usr/local/sbin/lib || true
rm -f "$DEST/RUNBOOK.md" "$DEST/etc/default-tailscaled" /etc/default/tailscaled || true

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
