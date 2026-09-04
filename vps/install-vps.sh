#!/bin/bash
# install-vps.sh — idempotent root installer for the FLEET-BRAIN VPS.
#
# Stands up the always-on brain (docs/FLEET-BRAIN.md §2) as ONE tree + ONE unit
# set, on a shared host we do NOT own the policy of. Scope is deliberately tiny
# and auditable:
#
#   /opt/grok-fleet        grokfleet (a pinned release asset, fetched + sha256-
#                          verified by the preflight) + config.toml template
#   fleet user             shell-less, key-only, password-locked; its
#                          authorized_keys is managed by `grokfleet enroll`
#   /etc/grok-fleet        600 secrets dir (API token, box-access key)
#   /var/lib/grok-fleet    mutable state (device cache, per-box expiry, locks)
#   grokfleet-reconcile.timer   systemd timer, OnUnitActiveSec=5min
#   grokfleet-reconcile.service oneshot: grokfleet reconcile (DRY-RUN until
#                          apply=true). The 5.10.0 compatibility names are GONE
#                          as of 5.11.0; an upgrade REMOVES any left behind.
#
# Usage (on the VPS, as root):
#   sudo bash vps/install-vps.sh              # install / upgrade (idempotent)
#   sudo bash vps/install-vps.sh --uninstall  # remove EXACTLY what we installed
#                                             # (never /var/lib/grok-fleet state)
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

log() { echo "install-vps: $*"; }

# PREFIX lets the test harness install into a throwaway root. Empty => real /.
PREFIX="${PREFIX:-}"
FLEET_USER="${FLEET_USER:-fleet}"

OPT_DIR="$PREFIX/opt/grok-fleet"
# The REAL (non-PREFIX) opt dir — the symlink TARGET must resolve on the live
# system regardless of a PREFIX= scratch install (F4).
OPT_DIR_REAL="/opt/grok-fleet"
ETC_DIR="$PREFIX/etc/grok-fleet"
STATE_DIR="$PREFIX/var/lib/grok-fleet"
SYSTEMD_DIR="$PREFIX/etc/systemd/system"
# 5.10.0 rename (blueprint fleet2-rename-grokfleet N1): the units carry the
# product name.
SERVICE="grokfleet-reconcile.service"
TIMER="grokfleet-reconcile.timer"
API_SERVICE="grokfleet-api.service"

# The 5.10.0 compatibility names, kept HERE FOR REMOVAL ONLY (N2 promised them
# for exactly one release and 5.11.0 is that release). Nothing writes these any
# more: `remove_compat_names` deletes whatever a 5.10.0 install left behind, and
# `uninstall` clears them too so a host that never reached 5.11.0 still ends
# clean. Naming them is what makes the removal possible — it is not a surface.
STALE_SERVICE="fleet-reconcile.service"
STALE_TIMER="fleet-reconcile.timer"
STALE_API_SERVICE="fleet-api.service"
STALE_CLI="fleet2"

# B-3: the ONE sanctioned sshd drop-in that constrains the fleet user to
# remote-forward-only. We install it UNDER the drop-in directory and NEVER edit
# the main daemon config file. Split the base name so no mutating line carries
# the main config's literal name (see the scope guard in tests).
SSHD_DROPIN_DIR="$PREFIX/etc/ssh/${SSHD_CONF_D:-sshd_config.d}"
SSHD_DROPIN="$SSHD_DROPIN_DIR/50-grok-fleet.conf"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- grokfleet release pin (blueprint fleet2-release-install, D1/D3) -------------
# The host no longer BUILDS grokfleet (it needed bun + make + a full checkout, and
# the r2 gate died on `make: command not found`). It downloads a pinned release
# asset with curl instead.
#
# D3 — THE PIN IS THE SHA256, NOT THE TAG. A git tag is mutable
# (`git tag -f && git push -f --tags`) and a release asset is mutable
# (`gh release upload --clobber`), so the tag pins a NAME, not bytes. The tag is
# only the fetch ADDRESS; GROKFLEET_SHA256 is the identity, and it lives HERE, in
# the repo the operator is already executing.
#
# Both are overridable by env FOR ROLLBACK, but only TOGETHER (D3): a rollback
# legitimately needs both, and one alone means the operator is fetching bytes
# they have not pinned. Capture what the environment supplied BEFORE the
# committed pin shadows it, so the preflight can tell the two apart.
#
# The env seams, read DIRECTLY (5.11.0). The 5.10.0 release also accepted a
# `FLEET2_<X>` spelling for each of these and refused when both were set and
# differed; that one-release compatibility is gone, and an operator with a stale
# `FLEET2_*` export now simply gets the committed pin, which is the safe answer.
GROKFLEET_RELEASE_ENV="${GROKFLEET_RELEASE-}"
GROKFLEET_SHA256_ENV="${GROKFLEET_SHA256-}"
GROKFLEET_BASE_URL_ENV="${GROKFLEET_BASE_URL-}"
GROKFLEET_ASSET_ENV="${GROKFLEET_ASSET-}"
GROKFLEET_BINARY_ENV="${GROKFLEET_BINARY-}"
GROKFLEET_FETCH_ROOT_ENV="${GROKFLEET_FETCH_ROOT-}"

# `make ts-release-build` rewrites EXACTLY these two lines (fleet/scripts/
# release-build.sh); keep them at column 0 in `NAME=value` form.
GROKFLEET_RELEASE=v5.11.2
# Placeholder until the first `make ts-release-build` writes the real digest.
# Until then the fetch 404s or mismatches — which, by D2, mutates nothing.
GROKFLEET_SHA256=f132683d080c32c0831b3e568e648ff38fb32f85d57c10b98b7165d48983443e

# D10 — the fetch ORIGIN is a seam so the security-critical paths (good fetch,
# corrupt body, 404, a 200 whose body is an HTML error page) can be tested
# against a local fixture instead of github.com, which is not controllable.
GROKFLEET_BASE_URL="${GROKFLEET_BASE_URL_ENV:-https://github.com/chaogebaba/grok-box-setup/releases/download}"
GROKFLEET_ASSET="${GROKFLEET_ASSET_ENV:-grokfleet-linux-x64}"

# D5 — operator escape hatch: install THESE bytes and skip the download entirely
# (dev loop, air-gapped provisioning, GitHub unreachable). Checksum verification
# is skipped, and the installer LOGS that it was.
GROKFLEET_BINARY="$GROKFLEET_BINARY_ENV"

# Peak disk during an install is ~320 MB (fetch temp + $OPT_DIR temp + grokfleet +
# grokfleet.prev) and the brain VPS has ~961 MB with a possibly-tmpfs default
# TMPDIR, so the download goes on an EXPLICITLY named real-disk path, never
# $TMPDIR. It is deliberately NOT under $PREFIX: a failed preflight must leave
# the install tree BYTE-IDENTICAL (D2), and creating $PREFIX/var/... for a
# scratch file would break exactly that. Removed on every exit path (trap).
GROKFLEET_FETCH_ROOT="${GROKFLEET_FETCH_ROOT_ENV:-/var/tmp}"

# Set by the preflight; consumed by install_grokfleet (D1 REBIND). Always bound so
# `set -u` cannot trip on it.
GROKFLEET_VERIFIED_BINARY=""
GROKFLEET_FETCH_DIR=""

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
  # BOTH generations of unit names: a host that stopped at 5.9.x has only the
  # pre-rename names, a 5.10.0 host has the new names plus the compatibility
  # links this release removes. Disabling a name that does not exist is a
  # harmless no-op, and uninstall must leave neither generation behind.
  if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now "$TIMER" >/dev/null 2>&1 || true
    systemctl disable --now "$STALE_TIMER" >/dev/null 2>&1 || true
    systemctl stop "$SERVICE" >/dev/null 2>&1 || true
    systemctl disable --now "$API_SERVICE" >/dev/null 2>&1 || true
    systemctl stop "$API_SERVICE" >/dev/null 2>&1 || true
    systemctl disable --now "$STALE_API_SERVICE" >/dev/null 2>&1 || true
    systemctl stop "$STALE_API_SERVICE" >/dev/null 2>&1 || true
  fi
  rm -f "$SYSTEMD_DIR/$SERVICE" "$SYSTEMD_DIR/$TIMER" "$SYSTEMD_DIR/$API_SERVICE" \
        "$SYSTEMD_DIR/$STALE_SERVICE" "$SYSTEMD_DIR/$STALE_TIMER" "$SYSTEMD_DIR/$STALE_API_SERVICE"
  if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  rm -rf "$OPT_DIR"
  # F4: remove the PATH symlink ONLY when it resolves to our target (never a
  # foreign symlink, never a regular file). PREFIX-rooted so a scratch uninstall
  # only ever touches the scratch link. The retired `fleet2` link pointed at the
  # SAME target, so the guard matches either name against either target — an
  # uninstall on a host that never reached 5.11.0 still clears it.
  local link
  for link in "$PREFIX/usr/local/bin/grokfleet" "$PREFIX/usr/local/bin/$STALE_CLI"; do
    if [ -L "$link" ] && { [ "$(readlink "$link")" = "$OPT_DIR_REAL/grokfleet" ] \
       || [ "$(readlink "$link")" = "$OPT_DIR_REAL/fleet2" ]; }; then
      rm -f "$link"
      log "removed PATH symlink $link"
    fi
  done
  # Secrets: remove the dir WE created. (An operator who wants to keep the API
  # token should back it up before uninstalling.)
  rm -rf "$ETC_DIR"
  # R2-B3: STATE IS NEVER REMOVED. $STATE_DIR holds the device cache, the
  # per-box key-expiry ledger and the reconcile locks — operator data that
  # outlives any one install, and that a PREFIX= scratch uninstall was observed
  # to delete out from under a pre-existing tree. Uninstall removes units,
  # binaries, symlinks and secrets; it leaves /var/lib/grok-fleet and everything
  # in it alone. An operator who really wants it gone removes it by hand.
  if [ -d "$STATE_DIR" ]; then
    log "left state dir $STATE_DIR intact (remove it by hand if you really want it gone)"
  fi
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
  # password-locked, key-only. authorized_keys is managed by `grokfleet enroll`.
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

# --- grokfleet acquisition PREFLIGHT (D2 — ORDERING IS THE SAFETY PROPERTY) ------
# This runs BEFORE ensure_dirs, BEFORE ensure_fleet_user and before
# install_grokfleet is called at all. Converting the build into a NETWORK FETCH
# widens every failure window (DNS, GitHub 5xx, a proxy, a 404 on an unpublished
# tag, disk full), so the bytes are acquired AND verified while NOTHING on the
# host has been touched. A failed fetch or a failed verify leaves the host
# byte-identical to before the run. Hoisting only to the top of install_grokfleet()
# would be insufficient: ensure_dirs/ensure_fleet_user have already run by then,
# and a failed fetch would strand a half-provisioned host.
grokfleet_fetch_cleanup() {
  if [ -n "$GROKFLEET_FETCH_DIR" ] && [ -d "$GROKFLEET_FETCH_DIR" ]; then
    rm -rf "$GROKFLEET_FETCH_DIR"
  fi
}

# r2-n1 — PEAK DISK. An upgrade holds four ~80 MB binaries at once: the fetch
# temp, the $OPT_DIR temp, the incumbent `grokfleet` and `grokfleet.prev` — about
# 320 MB, against ~961 MB on the brain VPS. The threshold keeps the 450 MB
# headroom the 5.10.0 cutover needed (it briefly held five) rather than tightening
# it for a saving nothing asks for. The run refuses up front rather than dying
# halfway through. Overridable so the test suite can drive the refusal.
GROKFLEET_DISK_MIN_KB="${GROKFLEET_DISK_MIN_KB:-460800}"   # 450 MB

# Free kB on the filesystem holding $1, walking up to the nearest existing dir
# (the install tree may not exist yet). Echoes nothing when df cannot answer.
grokfleet_free_kb() {
  local d="$1"
  while [ -n "$d" ] && [ ! -d "$d" ]; do d="$(dirname "$d")"; [ "$d" = "/" ] && break; done
  df -Pk "$d" 2>/dev/null | awk 'NR==2 {print $4}'
}

grokfleet_check_disk() {
  local path free
  for path in "$GROKFLEET_FETCH_ROOT" "$OPT_DIR"; do
    free="$(grokfleet_free_kb "$path")"
    if [ -z "$free" ]; then
      log "note: could not read free space for $path — skipping the disk precheck"
      continue
    fi
    if [ "$free" -lt "$GROKFLEET_DISK_MIN_KB" ]; then
      log "install-vps.sh: REFUSING — only ${free} kB free on the filesystem holding $path; the 5.10.0 cutover peaks at five ~80 MB binaries and needs ${GROKFLEET_DISK_MIN_KB} kB (nothing on this host was changed)."
      return 1
    fi
    log "disk precheck: ${free} kB free for $path (need ${GROKFLEET_DISK_MIN_KB} kB)"
  done
  return 0
}

grokfleet_preflight() {
  # r2-n1: refuse BEFORE the fetch, so a full disk changes nothing at all.
  grokfleet_check_disk || return 1

  # D3: the pin is a PAIR. Overriding one without the other is a refusal.
  if [ -n "$GROKFLEET_RELEASE_ENV" ] && [ -z "$GROKFLEET_SHA256_ENV" ]; then
    log "install-vps.sh: REFUSING — GROKFLEET_RELEASE and GROKFLEET_SHA256 must be overridden TOGETHER (the tag is only an address; the sha256 is the identity)."
    return 1
  fi
  if [ -n "$GROKFLEET_SHA256_ENV" ] && [ -z "$GROKFLEET_RELEASE_ENV" ]; then
    log "install-vps.sh: REFUSING — GROKFLEET_RELEASE and GROKFLEET_SHA256 must be overridden TOGETHER (the tag is only an address; the sha256 is the identity)."
    return 1
  fi
  if [ -n "$GROKFLEET_RELEASE_ENV" ]; then GROKFLEET_RELEASE="$GROKFLEET_RELEASE_ENV"; fi
  if [ -n "$GROKFLEET_SHA256_ENV" ]; then GROKFLEET_SHA256="$GROKFLEET_SHA256_ENV"; fi

  # D5: operator-supplied bytes short-circuit the download. Verification is
  # skipped BY DESIGN (the operator chose these bytes) — and we say so out loud.
  if [ -n "$GROKFLEET_BINARY" ]; then
    if [ ! -f "$GROKFLEET_BINARY" ]; then
      log "install-vps.sh: REFUSING — GROKFLEET_BINARY='$GROKFLEET_BINARY' is not a file"
      return 1
    fi
    GROKFLEET_VERIFIED_BINARY="$GROKFLEET_BINARY"
    log "using operator-supplied GROKFLEET_BINARY=$GROKFLEET_BINARY — checksum verification SKIPPED (D5)"
    return 0
  fi

  # D6: what the fetch path needs. bun and make are NO LONGER host requirements.
  if ! command -v curl >/dev/null 2>&1; then
    log "install-vps.sh: REFUSING — curl not found on PATH (grokfleet is downloaded from a GitHub release)."
    log "install-vps.sh: install it with:  apt-get install -y curl   (or set GROKFLEET_BINARY=/path/to/grokfleet)"
    return 1
  fi
  if ! command -v sha256sum >/dev/null 2>&1; then
    log "install-vps.sh: REFUSING — sha256sum not found on PATH (the download is verified against the in-repo GROKFLEET_SHA256)."
    log "install-vps.sh: install it with:  apt-get install -y coreutils   (or set GROKFLEET_BINARY=/path/to/grokfleet)"
    return 1
  fi

  local url="$GROKFLEET_BASE_URL/$GROKFLEET_RELEASE/$GROKFLEET_ASSET"
  GROKFLEET_FETCH_DIR="$(mktemp -d "$GROKFLEET_FETCH_ROOT/.grokfleet-fetch.XXXXXX" 2>/dev/null)" \
    || GROKFLEET_FETCH_DIR="$(mktemp -d)" \
    || { log "install-vps.sh: REFUSING — cannot create a download dir under $GROKFLEET_FETCH_ROOT"; return 1; }
  local dl="$GROKFLEET_FETCH_DIR/$GROKFLEET_ASSET"

  log "fetching grokfleet $GROKFLEET_RELEASE from $url"
  if ! curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 10 -o "$dl" "$url"; then
    log "install-vps.sh: REFUSING — could not download $url (nothing on this host was changed)."
    log "install-vps.sh: for an air-gapped or GitHub-unreachable install, set GROKFLEET_BINARY=/path/to/grokfleet"
    return 1
  fi

  # D4: verify against the IN-REPO constant and nothing else. This catches
  # truncated downloads, disk-full writes, a captive portal or proxy answering
  # 200-with-HTML, and a mis-uploaded asset; and because the digest lives in the
  # repo the operator is already executing, it anchors authenticity to THAT
  # checkout. It does NOT defend against someone who can write to the release
  # (a compromised GitHub account or token, a malicious collaborator, GitHub
  # itself) — such an adversary replaces the asset, and a same-origin `.sha256`
  # alongside it, in one `gh release upload --clobber`. That is why no `.sha256`
  # asset is published or consulted. No flag may skip this check.
  local got; got="$(sha256sum "$dl" | cut -d' ' -f1)"
  if [ "$got" != "$GROKFLEET_SHA256" ]; then
    rm -f "$dl"
    log "install-vps.sh: REFUSING — sha256 MISMATCH for $url"
    log "install-vps.sh:   expected $GROKFLEET_SHA256"
    log "install-vps.sh:   got      $got"
    log "install-vps.sh: the download was deleted; nothing on this host was changed."
    return 1
  fi
  chmod 0755 "$dl"
  GROKFLEET_VERIFIED_BINARY="$dl"
  log "verified grokfleet $GROKFLEET_RELEASE (sha256 $GROKFLEET_SHA256)"
  return 0
}

# --- the installer (blueprint fleet2-rename-grokfleet N6/N6a) ----------------
#
# install_grokfleet ABSORBS what used to be three functions — install_fleet2,
# install_units and install_fleet_api (N6a). That absorption is load-bearing,
# not tidying: install_units/install_fleet_api wrote REAL unit files at the
# pre-rename paths with `ExecStart=$OPT_DIR/fleet2`. Either one surviving would
# reinstate a unit naming a binary that no longer exists.
#
# `install_grokfleet || exit 1` DISABLES `set -e` for the whole function body
# (the D13 outage: an ENOSPC on the 80 MB copy did not abort, control reached
# the smoke test, and production ended up with a renamed engine and no
# replacement). So EVERY mutating line here checks its own status and routes to
# a named handler; nothing relies on `set -e`.
#
# Order, ONE run (a step's number is its N6 number, kept so the blueprint still
# reads against this file):
#   (1) stage the verified bytes into an $OPT_DIR temp   — fail ⇒ nothing changed
#   (2) `version` smoke on that temp                     — fail ⇒ rm temp
#   (3) PRESERVE-THEN-INSTALL grokfleet(.prev)           — the T8 idempotency
#   (5) write the three units                            [every run]
#   (6) enable the timer, carry the API's boot enablement [every run]
#   (8) the grokfleet PATH symlink                        [every run]
#   (9) try-restart the API — the ONE survivable failure  [every run]
#
# STEPS (4) AND (7) ARE GONE with the 5.10.0 compatibility layer (N2 promised it
# for exactly one release). They preserved and disabled the PRE-RENAME units and
# demoted the pre-rename BINARY, and both were gated on artefacts only a 5.9.x
# host has. What replaces them is `remove_compat_names`, which DELETES what a
# 5.10.0 install left behind.
#
# Every step here is IDEMPOTENT and runs on EVERY run: a host keeps getting its
# units repaired, its timer re-enabled and a deleted PATH link restored. That is
# the safety net of this release.

# Set by step (9) (and by a recovered step-(5) failure on a re-run): the run had
# a problem that did NOT stop it. Main still exits 1 (r4-B1) — a survivable
# failure must not truncate the run, and the exit code must still say it failed.
DEFERRED_FAIL=0
# `systemctl is-enabled` for the API unit, read in step (6) so an upgrade carries
# the operator's boot state across.
API_WAS_ENABLED=""
# Step (3) bookkeeping, so a later failure can undo it EXACTLY (see undo_step3).
GF_HAD_BINARY=0
GF_WROTE_PREV=0

# --- N6 step (5): the three unit files ----------------------------------------
# One function so the step-(5) failure handler can rewrite them on a re-run
# without duplicating the heredocs. Returns non-zero on the first failure.
write_grokfleet_units() {
  # The oneshot reconcile service reads apply= from the config: dry-run unless
  # apply=true. We express that with an ExecStart wrapper that appends --apply
  # only when the config says so, so flipping the config needs no unit edit.
  install -m 0644 /dev/stdin "$SYSTEMD_DIR/$SERVICE" <<EOF || return 1
[Unit]
Description=grok-fleet reconcile (FLEET-BRAIN brain)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# HOME is set to the fleet state tree (STATE_DIR=/var/lib/grok-fleet), NOT /root:
# breaks-if-undone — systemd does NOT export HOME for a system service, and
# grokfleet's top-level \$HOME expansions abort under set -u when HOME is unset
# ("HOME: unbound variable" → every timer run status=1/FAILURE before reconcile
# ever runs). /var/lib/grok-fleet keeps the brain's whole footprint inside the
# one declared state tree (decision wall: "Footprint: one tree + one unit set");
# /root would place fleet activity outside the declared footprint.
Environment=HOME=$STATE_DIR
Environment=FLEET_CONFIG=$OPT_DIR/config.toml
Environment=FLEET_ETC=$ETC_DIR
Environment=FLEET_STATE=$STATE_DIR
# Dry-run by default; the wrapper adds --apply iff config apply=true.
ExecStart=/bin/bash -c 'apply=""; grep -Eq "^[[:space:]]*apply[[:space:]]*=[[:space:]]*true" "$OPT_DIR/config.toml" && apply="--apply"; exec $OPT_DIR/grokfleet reconcile \$apply'
# grokfleet 5.8.0 (state-store D6/r6-B2/r7-n3): rc 7 is "recorded; export failed" —
# every store write COMMITTED and only the legacy enrolled.tsv / authorized-keys
# .map export a rolled-back 5.7.1 would read is stale. That is a SUCCESS for this
# oneshot: without this line a lagging export would park the unit in 'failed'
# every five minutes and mask a real failure. The Telegram notify is the signal.
SuccessExitStatus=7
EOF

  # 5.11.0: the timer's `Alias=fleet-reconcile.timer` is GONE with the rest of
  # the one-release compatibility layer. `remove_compat_names` deletes the alias
  # symlink `systemctl enable` materialised for it on a 5.10.0 host.
  install -m 0644 /dev/stdin "$SYSTEMD_DIR/$TIMER" <<EOF || return 1
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

  # TUI-D8: the admin API unit. NOT enabled here — the empirical gate enables it
  # on PASS for a FRESH install; on an UPGRADE step (6) carries over whatever the
  # operator's boot state was. Runs `grokfleet serve` (tailnet-bound token-auth
  # API, port 9891), env EXACTLY as the reconcile unit INCLUDING HOME=$STATE_DIR
  # (A18; refuse-to-start + Restart IS the boot-order retry).
  install -m 0644 /dev/stdin "$SYSTEMD_DIR/$API_SERVICE" <<EOF || return 1
[Unit]
Description=grok-fleet admin API (grokfleet serve — tailnet-bound token-auth HTTP/JSON)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
# Same env as the reconcile unit INCLUDING HOME=$STATE_DIR (A18): grokfleet's
# top-level \$HOME expansions abort under set -u when HOME is unset. The API
# refuses to start (rc 6) until the tailnet IPv4 resolves; Restart=on-failure +
# RestartSec make that the boot-order retry (a slow tailscaled means a few
# restarts, nothing more).
Environment=HOME=$STATE_DIR
Environment=FLEET_CONFIG=$OPT_DIR/config.toml
Environment=FLEET_ETC=$ETC_DIR
Environment=FLEET_STATE=$STATE_DIR
ExecStart=$OPT_DIR/grokfleet serve
Restart=on-failure
RestartSec=5
# Never park the unit in 'failed' while tailscaled is slow to bring the tailnet
# IP up (R2-A9): unlimited restart attempts within any interval.
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
EOF
  return 0
}

# 5.11.0: REMOVE the 5.10.0 compatibility names. N2 promised them for exactly one
# release; this is the release that takes them away.
#
# What a 5.10.0 host carries, and what this deletes:
#   * $SYSTEMD_DIR/fleet-reconcile.service — a unit symlink the installer wrote;
#   * $SYSTEMD_DIR/fleet-api.service       — the same;
#   * $SYSTEMD_DIR/fleet-reconcile.timer   — the symlink `systemctl enable`
#     materialised for the timer's `Alias=`;
#   * $bindir/fleet2                       — the PATH link.
#
# IDEMPOTENT by construction: `rm -f` on an absent path is a no-op, so a second
# run changes nothing and a fresh install removes nothing. Each unit path is only
# removed when it is a SYMLINK — a regular file there is an operator's own unit
# and this installer does not delete other people's units. The PATH link keeps
# the F4 guard: removed only when it resolves to OUR target.
#
# The timer is DISABLED before its alias link goes, or the *.wants symlink
# dangles and systemd keeps resolving the old name through it.
remove_compat_names() {
  local removed=0 u link bindir="${BIN_DIR:-$PREFIX/usr/local/bin}"
  if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
    if [ -L "$SYSTEMD_DIR/$STALE_TIMER" ]; then
      systemctl disable "$STALE_TIMER" >/dev/null 2>&1 || true
    fi
  fi
  for u in "$STALE_SERVICE" "$STALE_TIMER" "$STALE_API_SERVICE"; do
    if [ -L "$SYSTEMD_DIR/$u" ]; then
      rm -f "$SYSTEMD_DIR/$u" || { log "install_grokfleet: could not remove the stale $u link"; return 1; }
      log "removed the retired compatibility unit name $u"
      removed=1
    elif [ -e "$SYSTEMD_DIR/$u" ]; then
      log "note: $SYSTEMD_DIR/$u is a REGULAR FILE, not our compatibility link — left alone"
    fi
  done
  link="$bindir/$STALE_CLI"
  if [ -L "$link" ] && { [ "$(readlink "$link")" = "$OPT_DIR_REAL/grokfleet" ] \
     || [ "$(readlink "$link")" = "$OPT_DIR_REAL/$STALE_CLI" ]; }; then
    rm -f "$link" || { log "install_grokfleet: could not remove the stale $link"; return 1; }
    log "removed the retired CLI link $link"
    removed=1
  fi
  [ "$removed" = 1 ] && log "the 5.10.0 compatibility names are gone (N2: one release only)"
  return 0
}

# Undo step (3) EXACTLY. The blueprint's step-(4) handler says "rm grokfleet";
# that is right only when step (3) CREATED the file (the cutover run). On a host
# where `grokfleet` already existed — a re-run, or the N4 "forward again" path —
# removing it would be a bigger change than the one being undone, so restore the
# copy step (3) preserved instead.
undo_step3() {
  if [ "$GF_HAD_BINARY" = 0 ]; then
    rm -f "$OPT_DIR/grokfleet"
  elif [ "$GF_WROTE_PREV" = 1 ] && [ -e "$OPT_DIR/grokfleet.prev" ]; then
    cp -f "$OPT_DIR/grokfleet.prev" "$OPT_DIR/grokfleet" 2>/dev/null || true
  fi
}

# Step (5)/(6) failure. There is no CUTOVER branch any more: with steps (4) and
# (7) gone nothing preserves a `units.prev/` artifact, and the one that a 5.10.0
# cutover left behind holds 5.9.0 units naming a binary that no longer exists —
# restoring those would leave unstartable units and no engine at all. So the
# handler NEVER touches units.prev/ and never removes grokfleet; it rewrites the
# units and lets the run continue with the failure recorded (DEFERRED_FAIL).
rollback_step5() {
  log "install_grokfleet: step (5)/(6) FAILED — units.prev is NOT touched and grokfleet stays; rewriting the units"
  if write_grokfleet_units; then
    if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
      systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    # Recovered: the host has correct units, so the run continues — but the exit
    # code still reports the failure (the DEFERRED_FAIL pattern).
    DEFERRED_FAIL=1
    log "install_grokfleet: units rewritten successfully — continuing, the installer will still exit 1"
    return 0
  fi
  log "install_grokfleet: the rewrite FAILED too — the host keeps whatever units are on disk; fix by hand and re-run"
  return 1
}

install_grokfleet() {
  # D1 REBIND: the binary was FETCHED AND VERIFIED by grokfleet_preflight, before
  # any mutation. `built` is the verified temp path.
  local built="$GROKFLEET_VERIFIED_BINARY"
  [ -x "$built" ] || { log "install_grokfleet: no executable verified binary at '$built'"; return 1; }
  local u tmp

  # === (1) stage the verified bytes into $OPT_DIR (same-dir temp) ============
  tmp="$(mktemp "$OPT_DIR/.grokfleet.XXXXXX")" \
    || { log "install_grokfleet: cannot create a temp in $OPT_DIR — nothing on this host was changed"; return 1; }
  install -m 0755 "$built" "$tmp" \
    || { rm -f "$tmp"; log "install_grokfleet: could not stage the binary into $OPT_DIR (disk full? noexec?) — nothing on this host was changed"; return 1; }

  # === (2) `version` smoke on the temp, BEFORE anything goes live ===========
  if ! "$tmp" version >/dev/null 2>&1; then
    rm -f "$tmp"
    log "install_grokfleet: the verified binary failed 'version' (wrong arch? noexec mount?) — nothing on this host was changed"
    return 1
  fi

  # === (3) PRESERVE-THEN-INSTALL (r8-B1) ====================================
  # `.prev` is the previous grokfleet, and since step (7) went with the 5.10.0
  # compatibility layer this is the ONLY writer of it — which is exactly what
  # `make ts-cutback` restores. The `cmp` guard keeps a no-change re-run
  # byte-identical (the T8 property): an unchanged binary is not preserved over
  # itself, so `.prev` keeps naming the last DIFFERENT version.
  GF_HAD_BINARY=0
  GF_WROTE_PREV=0
  if [ -e "$OPT_DIR/grokfleet" ]; then
    GF_HAD_BINARY=1
    if ! cmp -s "$tmp" "$OPT_DIR/grokfleet"; then
      cp -f "$OPT_DIR/grokfleet" "$OPT_DIR/grokfleet.prev" \
        || { rm -f "$tmp"; log "install_grokfleet: could not preserve the outgoing $OPT_DIR/grokfleet as .prev — incumbent is untouched"; return 1; }
      GF_WROTE_PREV=1
      log "kept the outgoing binary as $OPT_DIR/grokfleet.prev"
    fi
  fi
  mv -f "$tmp" "$OPT_DIR/grokfleet" \
    || { rm -f "$tmp"; log "install_grokfleet: could not install $OPT_DIR/grokfleet — the incumbent is untouched"; return 1; }
  log "installed grokfleet -> $OPT_DIR/grokfleet"

  # D13 — RETIRE THE INCUMBENT ONLY ONCE A VERIFIED REPLACEMENT IS LIVE.
  # This block used to run FIRST, at the top of the install function. That is how
  # production ended up with its engine renamed to a non-executable 0644 file and
  # no replacement: `|| exit 1` disables `set -e` for the whole body, so an ENOSPC
  # on the 80 MB copy, a `noexec` mount or a wrong-arch binary did NOT abort —
  # control reached the `version` smoke test, it failed, and the rollback restores
  # the .prev binary ONLY; it never restored fleetctl. Running HERE, after steps
  # (1)-(3) have succeeded, every one of those failures returns 1 with the
  # incumbent still in place, still executable.
  #
  # D7: the retired bash fleetctl is NOT shipped from the repo (it was `git rm`'d
  # in phase 3) — instead we PRESERVE any incumbent $OPT_DIR/fleetctl IN PLACE
  # (M6/Q4) at mode 0644 (non-executable) as the documented manual fallback. A
  # fresh install (no incumbent) has no retired copy and that is correct.
  if [ -e "$OPT_DIR/fleetctl" ] && [ ! -e "$OPT_DIR/fleetctl.retired-c303696" ]; then
    mv -f "$OPT_DIR/fleetctl" "$OPT_DIR/fleetctl.retired-c303696" || true
    chmod 0644 "$OPT_DIR/fleetctl.retired-c303696" 2>/dev/null || true
    log "retired incumbent bash fleetctl -> $OPT_DIR/fleetctl.retired-c303696 (0644, manual fallback)"
  fi

  # === (5) the three units =================================================
  # Unit-write failures are FATAL from 5.10.0 (they were non-fatal when
  # install_units/install_fleet_api were called bare). Deliberate: a half-renamed
  # host is worse than an aborted install, and rollback_step5 is what makes fatal
  # safe.
  write_grokfleet_units || { rollback_step5 || return 1; }
  # D7: a phase-2 cutover drop-in (fleet-reconcile.service.d/fleet2.conf) is
  # obsolete — the base unit ExecStart runs the engine directly. Removed on every
  # run. r3-n2: any FUTURE drop-in belongs under grokfleet-reconcile.service.d/,
  # because systemd resolves drop-ins by the REAL unit name; a directory named
  # after a retired compatibility name is silently ignored.
  local dropin="$SYSTEMD_DIR/$STALE_SERVICE.d/fleet2.conf"
  if [ -e "$dropin" ]; then
    rm -f "$dropin" || { rollback_step5 || return 1; }
    rmdir "$SYSTEMD_DIR/$STALE_SERVICE.d" 2>/dev/null || true
    log "removed obsolete cutover drop-in $dropin"
  fi
  # 5.11.0: the compatibility names go HERE, after the real units are on disk and
  # before the daemon-reload, so systemd never sees a moment with neither name.
  remove_compat_names || { rollback_step5 || return 1; }
  log "installed $SERVICE + $TIMER + $API_SERVICE"

  if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || { rollback_step5 || return 1; }

    # === (6) enable the timer; CARRY OVER the API's boot enablement =========
    systemctl enable --now "$TIMER" || { rollback_step5 || return 1; }
    log "enabled $TIMER (reconcile every 5min; dry-run until config apply=true)"
    # Carry the operator's (or the empirical gate's) API boot state across the
    # upgrade: the never-enable policy describes a FRESH install only.
    API_WAS_ENABLED="$(systemctl is-enabled "$API_SERVICE" 2>/dev/null || true)"
    case "$API_WAS_ENABLED" in
      enabled|enabled-runtime)
        systemctl enable "$API_SERVICE" >/dev/null 2>&1 || true
        log "carried the API boot enablement across the rename ($API_WAS_ENABLED)"
        ;;
      "")
        log "$API_SERVICE left not enabled (boot state unreadable; TUI-D8 — the empirical gate enables it on PASS)"
        ;;
      *)
        log "$API_SERVICE left not enabled (recorded boot state '$API_WAS_ENABLED' is not an enabled spelling; TUI-D8)"
        ;;
    esac
  else
    log "PREFIX set (or no systemctl) — units written but not enabled"
  fi

  # === (8) the PATH symlink — BEFORE the restart ==========================
  # Deliberately ahead of step (9): the one survivable failure below must leave a
  # host whose CLI resolves, so the operator's first recovery command works.
  # Nothing here depends on the service. The `fleet2` compatibility link is GONE
  # in 5.11.0 — `remove_compat_names` deleted it above.
  # BIN_DIR is an extracted-function test seam; normal installs retain the
  # established PREFIX-relative destination.
  local bindir="${BIN_DIR:-$PREFIX/usr/local/bin}"
  mkdir -p "$bindir" || { log "install_grokfleet: could not create $bindir for CLI links"; return 1; }
  ln -sfn "$OPT_DIR_REAL/grokfleet" "$bindir/grokfleet" \
    || { log "install_grokfleet: could not link $bindir/grokfleet"; return 1; }
  log "linked $bindir/grokfleet -> $OPT_DIR_REAL/grokfleet"

  # === (9) rebind a RUNNING API to the new bytes ===========================
  # A long-running unit keeps executing the binary it was STARTED with, and the
  # atomic `mv -f` above unlinks the old inode without touching the process.
  # Production served /v1/health version 5.5.0 for three and a half hours after
  # the 5.6.0 install, with /proc/<pid>/exe reading "(deleted)". `try-restart`
  # and nothing else: it restarts the unit ONLY if it is already active, so the
  # never-start policy (TUI-D8) is unchanged. ONLY the API — the reconcile unit
  # is a Type=oneshot whose next tick execs the new binary on its own.
  if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet "$API_SERVICE" 2>/dev/null; then
      if systemctl try-restart "$API_SERVICE" >/dev/null 2>&1; then
        log "restarted $API_SERVICE (binary changed)"
      else
        # THE ONE SURVIVABLE FAILURE. Return 0 so every phase after this call
        # site still runs — including the sshd drop-in, the only one the file
        # marks fatal-if-it-fails — and let main exit 1 on DEFERRED_FAIL.
        log "grokfleet: API restart failed — the CLI is usable; run: systemctl start $API_SERVICE"
        DEFERRED_FAIL=1
      fi
    else
      log "$API_SERVICE not active — not started (TUI-D8)"
    fi
  fi
  return 0
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
# Path to the write-scoped Tailscale API token (mode 600). Read by grokfleet,
# never passed on argv or logged.
api_token_file = "/etc/grok-fleet/api-token"

# The VPS address the BOXES dial out to for the reverse-SSH tunnel. This is
# what \`grokfleet enroll grok-box-N\` writes into each box's own config.toml
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

install_box_passwd() {
  # P2 (zero-touch join): adoption drives a box over the TAILNET as box@<box>
  # before that box is enrolled, so the engine needs the box ssh password. It
  # lives in its own 600 file owned by the fleet user; grokfleet reads it at tick
  # start and never caches it across ticks.
  #
  # Written ONLY when BOX_PASSWD is in the environment, and the value is NEVER
  # logged. Without it discover fails closed (skipped:no-box-password) rather
  # than falling back to grokfleet's baked default, so an EXISTING fleet must
  # re-run this installer with BOX_PASSWD before adoption does anything.
  local f="$ETC_DIR/box_passwd"
  if [ -z "${BOX_PASSWD-}" ]; then
    log "note: BOX_PASSWD not set — left $f untouched (zero-touch adoption stays inert until it exists)"
    return 0
  fi
  ( umask 077; printf '%s\n' "$BOX_PASSWD" > "$f" )
  chmod 600 "$f" 2>/dev/null || true
  chown "$FLEET_USER":"$FLEET_USER" "$f" 2>/dev/null || true
  log "wrote $f (mode 600, owner $FLEET_USER) — box ssh password for zero-touch adoption"
}

# B-3: constrain the fleet user to REMOTE-FORWARD-ONLY via a single sshd drop-in.
# We write ONLY a drop-in under the drop-in directory and NEVER edit the main
# daemon config. The Match block pins the fleet user to:
#   AllowTcpForwarding remote  — reverse (-R) forwards only; NO local (-L)
#   PermitOpen none            — cannot open local-forward destinations
#   PermitListen any           — reverse-listen cap is per-key (authorized_keys
#     permitlisten="127.0.0.1:2000N", grokfleet); no fixed 8-box list here. The
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
    # #11: reap a dead tunnel session fast so a sleep/wake box can rebind its
    # reverse -R port. Without this the OLD session holds :2000N until sshd's
    # (long) default keepalive fires, costing minutes of tunnel=down. 30s * 3 =
    # ~90s worst case, scoped to the fleet user ONLY.
    ClientAliveInterval 30
    ClientAliveCountMax 3
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
# D2 PREFLIGHT (before ANY mutation): acquire AND verify the grokfleet binary while
# the host is still untouched — no dirs created, no fleet user created, the
# incumbent engine still in place. Any failure here exits rc 1 having changed
# nothing. The download temp is removed on EVERY exit path.
trap grokfleet_fetch_cleanup EXIT
grokfleet_preflight || exit 1
ensure_dirs
ensure_fleet_user
install_grokfleet || exit 1
install_config_template
install_box_passwd
install_sshd_dropin || exit 1   # F8 (#12): drop-in validate/reload failure is FATAL
log "install complete. Next:"
log "  1) put the write-scoped Tailscale API token at $ETC_DIR/api-token (chmod 600)"
log "  2) generate the box-access key: ssh-keygen -t ed25519 -f $ETC_DIR/box_access_ed25519 -N ''"
log "  3) grokfleet enroll grok-box-N for each box (over the tailnet) — or re-run this installer with BOX_PASSWD=... set and let zero-touch join adopt them (docs/FLEET-BRAIN.md §zero-touch join)"
log "  4) verify with: $OPT_DIR/grokfleet reconcile   (dry-run)"
log "  5) flip apply=true in $OPT_DIR/config.toml when ready to mutate"
# Optional Telegram alert sink: grokfleet notify() always writes to the
# journal/stderr and additionally POSTs to the Telegram Bot API iff
# $ETC_DIR/telegram.env (mode 600, TELEGRAM_BOT_TOKEN= + TELEGRAM_CHAT_ID=)
# exists — see etc/telegram.env.example. The installer deliberately does NOT
# seed it: no file => journal-only alerts, no error.
log "  note (optional): Telegram alerts need $ETC_DIR/telegram.env (chmod 600) with TELEGRAM_BOT_TOKEN= and TELEGRAM_CHAT_ID= (see etc/telegram.env.example); without it, alerts stay journal-only"

# r4-B1 (N6 step 9): a SURVIVABLE failure must not truncate the run, and the exit
# code must still say the run failed. install_grokfleet returns 0 after logging
# such a failure and sets DEFERRED_FAIL, so every later phase — including the
# sshd drop-in, the one this file marks fatal — still executed above.
if [ "$DEFERRED_FAIL" = 1 ]; then
  log "install completed with a DEFERRED FAILURE (see the line above) — exiting 1"
  exit 1
fi
