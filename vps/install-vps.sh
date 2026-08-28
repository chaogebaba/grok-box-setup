#!/bin/bash
# install-vps.sh — idempotent root installer for the FLEET-BRAIN VPS.
#
# Stands up the always-on brain (docs/FLEET-BRAIN.md §2) as ONE tree + ONE unit
# set, on a shared host we do NOT own the policy of. Scope is deliberately tiny
# and auditable:
#
#   /opt/grok-fleet        fleetctl (from THIS repo) + config.toml template
#   fleet user             shell-less, key-only, password-locked; its
#                          authorized_keys is managed by `fleetctl enroll`
#   /etc/grok-fleet        600 secrets dir (API token, box-access key)
#   /var/lib/grok-fleet    mutable state (device cache, per-box expiry, locks)
#   fleet-reconcile.timer  systemd timer, OnUnitActiveSec=5min
#   fleet-reconcile.service oneshot: fleetctl reconcile (DRY-RUN until apply=true)
#
# Usage (on the VPS, as root):
#   sudo bash vps/install-vps.sh              # install / upgrade (idempotent)
#   sudo bash vps/install-vps.sh --uninstall  # remove EXACTLY what we installed
#
# NON-GOALS / HARD GUARANTEES:
#   * NEVER touches global sshd_config, xray, hysteria, WireGuard wg0, cron, or
#     any other service. The fleet user is key-only via its OWN authorized_keys.
#   * Idempotent: run twice => identical tree (verified by tests against a fake
#     root prefix via PREFIX=).
#   * The reconcile service runs `reconcile` with NO --apply until the operator
#     sets apply=true in /opt/grok-fleet/config.toml (dry-run by default), so a
#     fresh install mutates NOTHING on the tailnet.
set -euo pipefail

# PREFIX lets the test harness install into a throwaway root. Empty => real /.
PREFIX="${PREFIX:-}"
FLEET_USER="${FLEET_USER:-fleet}"

OPT_DIR="$PREFIX/opt/grok-fleet"
ETC_DIR="$PREFIX/etc/grok-fleet"
STATE_DIR="$PREFIX/var/lib/grok-fleet"
SYSTEMD_DIR="$PREFIX/etc/systemd/system"
SERVICE="fleet-reconcile.service"
TIMER="fleet-reconcile.timer"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() { echo "install-vps: $*"; }

if [ "$(id -u)" -ne 0 ]; then
  # Under a PREFIX (test) we do not need real root; only the real install does.
  if [ -z "$PREFIX" ]; then
    echo "install-vps: need root (or set PREFIX=<dir> for a test install)" >&2
    exit 1
  fi
fi

# --- uninstall ---------------------------------------------------------------
# Remove EXACTLY what we installed, nothing else. Leaves the fleet user's data
# behind ONLY if it holds enrolled keys the operator may still want — we remove
# our unit files + /opt tree + config template, disable the timer, and (unless
# --keep-user) remove the fleet user. Never touches sshd/xray/hysteria/wg0.
uninstall() {
  log "uninstalling (PREFIX='${PREFIX:-/}')"
  if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now "$TIMER" >/dev/null 2>&1 || true
    systemctl stop "$SERVICE" >/dev/null 2>&1 || true
  fi
  rm -f "$SYSTEMD_DIR/$SERVICE" "$SYSTEMD_DIR/$TIMER"
  if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  rm -rf "$OPT_DIR"
  # Secrets + state: remove the dirs WE created. (An operator who wants to keep
  # the API token should back it up before uninstalling.)
  rm -rf "$ETC_DIR" "$STATE_DIR"
  # The fleet user: only remove it on a real install and only if it exists.
  if [ -z "$PREFIX" ] && id "$FLEET_USER" >/dev/null 2>&1; then
    userdel "$FLEET_USER" >/dev/null 2>&1 || log "note: could not remove user $FLEET_USER (leaving it)"
  fi
  log "uninstall complete — sshd/xray/hysteria/wg0 untouched"
}

# --- install steps (each idempotent) -----------------------------------------
ensure_dirs() {
  mkdir -p "$OPT_DIR" "$ETC_DIR" "$STATE_DIR" "$SYSTEMD_DIR"
  # Secrets dir is 700; state 755 is fine (no secrets), config template 600.
  chmod 700 "$ETC_DIR" 2>/dev/null || true
  chmod 755 "$STATE_DIR" 2>/dev/null || true
}

ensure_fleet_user() {
  # Only on a real install (no meaningful useradd under a PREFIX). Shell-less,
  # password-locked, key-only. authorized_keys is managed by `fleetctl enroll`.
  [ -z "$PREFIX" ] || return 0
  command -v useradd >/dev/null 2>&1 || { log "note: useradd missing — skipping fleet user"; return 0; }
  if ! id "$FLEET_USER" >/dev/null 2>&1; then
    useradd --system --create-home --shell /usr/sbin/nologin "$FLEET_USER" 2>/dev/null \
      || useradd --system --create-home --shell /sbin/nologin "$FLEET_USER" \
      || useradd --system --create-home --shell /bin/false "$FLEET_USER"
    log "created system user $FLEET_USER (nologin)"
  fi
  # Lock the password so PasswordAuthentication yes (global) cannot be used
  # against this user — its only credential is the per-box pubkey lines.
  passwd -l "$FLEET_USER" >/dev/null 2>&1 || true
  # Its ~/.ssh (authorized_keys populated by enroll).
  local home; home="$(getent passwd "$FLEET_USER" | cut -d: -f6)"
  [ -n "$home" ] || home="/home/$FLEET_USER"
  mkdir -p "$home/.ssh"
  touch "$home/.ssh/authorized_keys"
  chmod 700 "$home/.ssh"; chmod 600 "$home/.ssh/authorized_keys"
  chown -R "$FLEET_USER":"$FLEET_USER" "$home/.ssh" 2>/dev/null || true
}

install_fleetctl() {
  # Copy fleetctl from THIS repo. Atomic write (temp + rename in the same dir).
  local tmp; tmp="$(mktemp "$OPT_DIR/.fleetctl.XXXXXX")"
  install -m 0755 "$REPO_ROOT/fleetctl" "$tmp"
  mv -f "$tmp" "$OPT_DIR/fleetctl"
  log "installed fleetctl -> $OPT_DIR/fleetctl"
}

install_config_template() {
  # Seed the brain config template ONCE; never overwrite an operator's edits
  # (idempotent: a second run keeps the existing file). The token itself lives
  # in $ETC_DIR (600), referenced by path — never inlined here.
  local cfg="$OPT_DIR/config.toml"
  if [ -e "$cfg" ]; then
    chmod 600 "$cfg" 2>/dev/null || true
    log "kept existing $cfg"
    return 0
  fi
  install -m 0600 /dev/stdin "$cfg" <<EOF
# grok-fleet brain config (docs/FLEET-BRAIN.md §2).
#
# The reconcile service runs DRY-RUN until you set apply = true below. The API
# token is NOT inlined here — it lives in a 600 file referenced by path.

[fleet-brain]
# Path to the write-scoped Tailscale API token (mode 600). Read by fleetctl,
# never passed on argv or logged.
api_token_file = "/etc/grok-fleet/api-token"

# Set to true to let the timer MUTATE the tailnet (mint/delete/rename). Until
# then every reconcile is a dry-run — a fresh install changes nothing.
apply = false
EOF
  log "seeded $cfg (apply=false — reconcile is dry-run until you flip it)"
}

install_units() {
  # The oneshot reconcile service reads apply= from the config: dry-run unless
  # apply=true. We express that with an ExecStart wrapper that appends --apply
  # only when the config says so, so flipping the config needs no unit edit.
  install -m 0644 /dev/stdin "$SYSTEMD_DIR/$SERVICE" <<EOF
[Unit]
Description=grok-fleet reconcile (FLEET-BRAIN brain)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=FLEET_CONFIG=$OPT_DIR/config.toml
Environment=FLEET_ETC=$ETC_DIR
Environment=FLEET_STATE=$STATE_DIR
# Dry-run by default; the wrapper adds --apply iff config apply=true.
ExecStart=/bin/bash -c 'apply=""; grep -Eq "^[[:space:]]*apply[[:space:]]*=[[:space:]]*true" "$OPT_DIR/config.toml" && apply="--apply"; exec $OPT_DIR/fleetctl reconcile \$apply'
EOF

  install -m 0644 /dev/stdin "$SYSTEMD_DIR/$TIMER" <<EOF
[Unit]
Description=Run grok-fleet reconcile every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF
  log "installed $SERVICE + $TIMER"

  if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload
    systemctl enable --now "$TIMER"
    log "enabled $TIMER (reconcile every 5min; dry-run until config apply=true)"
  else
    log "PREFIX set (or no systemctl) — units written but not enabled"
  fi
}

# --- main --------------------------------------------------------------------
case "${1:-}" in
  --uninstall) uninstall; exit 0 ;;
  ""|--install) : ;;
  *) echo "usage: install-vps.sh [--install|--uninstall]" >&2; exit 2 ;;
esac

log "installing to '${PREFIX:-/}' from repo $REPO_ROOT"
ensure_dirs
ensure_fleet_user
install_fleetctl
install_config_template
install_units
log "install complete. Next:"
log "  1) put the write-scoped Tailscale API token at $ETC_DIR/api-token (chmod 600)"
log "  2) generate the box-access key: ssh-keygen -t ed25519 -f $ETC_DIR/box_access_ed25519 -N ''"
log "  3) fleetctl enroll grok-box-N for each box (over the tailnet)"
log "  4) verify with: $OPT_DIR/fleetctl reconcile   (dry-run)"
log "  5) flip apply=true in $OPT_DIR/config.toml when ready to mutate"
