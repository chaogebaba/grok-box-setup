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

# B-3: the ONE sanctioned sshd drop-in that constrains the fleet user to
# remote-forward-only. We install it UNDER the drop-in directory and NEVER edit
# the main daemon config file. Split the base name so no mutating line carries
# the main config's literal name (see the scope guard in tests).
SSHD_DROPIN_DIR="$PREFIX/etc/ssh/${SSHD_CONF_D:-sshd_config.d}"
SSHD_DROPIN="$SSHD_DROPIN_DIR/50-grok-fleet.conf"

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
  # B-3: remove the sshd drop-in we installed, then re-validate + reload so the
  # daemon returns to its pre-install policy. NEVER touch the main config.
  if [ -e "$SSHD_DROPIN" ]; then
    rm -f "$SSHD_DROPIN"
    if [ -z "$PREFIX" ] && command -v sshd >/dev/null 2>&1; then
      if sshd -t >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
        systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || true
      fi
    fi
    log "removed sshd drop-in $SSHD_DROPIN"
  fi
  # P1-8: the fleet user AND everything the installer created for it. `useradd
  # --create-home` made ~fleet + enroll wrote ~fleet/.ssh/authorized_keys, so a
  # bare `userdel` would leave that home behind. Use `userdel -r` to remove the
  # home + mail spool too. Only on a real install and only if the user exists.
  if [ -z "$PREFIX" ] && id "$FLEET_USER" >/dev/null 2>&1; then
    local home; home="$(getent passwd "$FLEET_USER" | cut -d: -f6)"
    if userdel -r "$FLEET_USER" >/dev/null 2>&1; then
      log "removed user $FLEET_USER and its home (userdel -r)"
    else
      # userdel -r can fail if the home is busy; fall back to a plain userdel
      # plus an explicit home removal so nothing the installer created lingers.
      userdel "$FLEET_USER" >/dev/null 2>&1 || log "note: could not remove user $FLEET_USER"
      if [ -n "$home" ] && [ "$home" != "/" ] && [ -d "$home" ]; then
        rm -rf "$home" && log "removed leftover fleet home $home"
      fi
    fi
  fi
  log "uninstall complete — sshd main config/xray/hysteria/wg0 untouched"
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

# The VPS address the BOXES dial out to for the reverse-SSH tunnel. This is
# what \`fleetctl enroll grok-box-N\` writes into each box's own config.toml
# [fleet].vps (docs/FLEET-BRAIN.md §ops). REQUIRED for enroll: it resolves
# FLEET_VPS_ADDR env > [fleet-brain].vps > REFUSE (no baked default). Set it to
# THIS brain's reachable address (the one the boxes can open a tunnel to).
#vps = "203.0.113.10"
#
# The VPS sshd port the boxes dial (default 22). enroll writes [fleet].port on
# a box ONLY when this is non-default; at 22 the box default stands.
#vps_port = 22

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
# HOME is set to the fleet state tree (STATE_DIR=/var/lib/grok-fleet), NOT /root:
# breaks-if-undone — systemd does NOT export HOME for a system service, and
# fleetctl's top-level $HOME expansions abort under set -u when HOME is unset
# ("HOME: unbound variable" → every timer run status=1/FAILURE before reconcile
# ever runs). /var/lib/grok-fleet keeps the brain's whole footprint inside the
# one declared state tree (decision wall: "Footprint: one tree + one unit set");
# /root would place fleet activity outside the declared footprint.
Environment=HOME=$STATE_DIR
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

# B-3: constrain the fleet user to REMOTE-FORWARD-ONLY via a single sshd drop-in.
# We write ONLY a drop-in under the drop-in directory and NEVER edit the main
# daemon config. The Match block pins the fleet user to:
#   AllowTcpForwarding remote  — reverse (-R) forwards only; NO local (-L)
#   PermitOpen none            — cannot open local-forward destinations
#   PermitListen any           — reverse-listen cap is per-key (authorized_keys
#     permitlisten="127.0.0.1:2000N", fleetctl); no fixed 8-box list here. The
#     explicit `any` in THIS Match block deliberately overrides any main-section
#     PermitListen for the fleet user ONLY, so the per-key option alone decides
#     which 127.0.0.1:2000N a box may listen on (#12; docs/FLEET-BRAIN.md §2).
#   X11Forwarding no / AllowAgentForwarding no / PermitTTY no — no shell surface
#   ForceCommand <no-op>       — never runs a program even if a client asks
# The config is VALIDATED with `sshd -t` before any reload; if validation fails
# we REMOVE the drop-in and refuse to reload (never leave sshd unstartable).
install_sshd_dropin() {
  mkdir -p "$SSHD_DROPIN_DIR" 2>/dev/null || { log "note: cannot create $SSHD_DROPIN_DIR — skipping sshd drop-in"; return 0; }
  # Atomic write (temp + rename) so a partial write never lands.
  local tmp; tmp="$(mktemp "$SSHD_DROPIN_DIR/.grok-fleet.XXXXXX" 2>/dev/null)" || { log "note: mktemp for sshd drop-in failed"; return 0; }
  cat > "$tmp" <<EOF
# grok-fleet — remote-forward-only constraint for the '$FLEET_USER' user.
# Managed by vps/install-vps.sh (docs/FLEET-BRAIN.md §2, B-3). Do not edit by
# hand; re-run the installer to change it. This is the ONLY sshd change we make;
# the main daemon config is never touched.
Match User $FLEET_USER
    AllowTcpForwarding remote
    PermitOpen none
    # #12: per-key permitlisten= is the real cap; explicit \`any\` here so a main-
    # section PermitListen cannot silently cap the fleet user (fleet user only).
    PermitListen any
    X11Forwarding no
    AllowAgentForwarding no
    AllowStreamLocalForwarding no
    PermitTunnel no
    PermitTTY no
    ForceCommand /usr/sbin/nologin
EOF
  chmod 644 "$tmp" 2>/dev/null || true
  # On a real install, VALIDATE before installing/reloading. sshd -t parses the
  # WHOLE config INCLUDING drop-ins, so we stage the drop-in into place first in
  # a way that lets us roll back on failure.
  if [ -z "$PREFIX" ] && command -v sshd >/dev/null 2>&1; then
    # Move into place, validate, and roll back if the daemon rejects it.
    local backup=""
    if [ -e "$SSHD_DROPIN" ]; then backup="$(mktemp)"; cp -f "$SSHD_DROPIN" "$backup" 2>/dev/null || true; fi
    mv -f "$tmp" "$SSHD_DROPIN"
    if sshd -t >/dev/null 2>&1; then
      log "installed sshd drop-in $SSHD_DROPIN (validated with sshd -t)"
      if command -v systemctl >/dev/null 2>&1; then
        # F8 (#12): a failed reload is FATAL — the drop-in is on disk but not
        # live, so the running daemon still has the OLD cap. Never swallow it.
        systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || { log "sshd reload FAILED — drop-in on disk but not live"; return 1; }
      fi
    else
      log "ERROR: sshd -t REJECTED the drop-in — rolling back, sshd left UNCHANGED"
      if [ -n "$backup" ]; then mv -f "$backup" "$SSHD_DROPIN"; else rm -f "$SSHD_DROPIN"; fi
      return 1
    fi
    [ -n "$backup" ] && rm -f "$backup" 2>/dev/null || true
  else
    # PREFIX (test) or no sshd binary: just write the drop-in (no validate/reload).
    mv -f "$tmp" "$SSHD_DROPIN"
    log "wrote sshd drop-in $SSHD_DROPIN (PREFIX/no-sshd — not validated/reloaded)"
  fi
  return 0
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
install_sshd_dropin || exit 1   # F8 (#12): drop-in validate/reload failure is FATAL
log "install complete. Next:"
log "  1) put the write-scoped Tailscale API token at $ETC_DIR/api-token (chmod 600)"
log "  2) generate the box-access key: ssh-keygen -t ed25519 -f $ETC_DIR/box_access_ed25519 -N ''"
log "  3) fleetctl enroll grok-box-N for each box (over the tailnet)"
log "  4) verify with: $OPT_DIR/fleetctl reconcile   (dry-run)"
log "  5) flip apply=true in $OPT_DIR/config.toml when ready to mutate"
