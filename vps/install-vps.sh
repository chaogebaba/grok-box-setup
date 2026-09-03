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
#                          apply=true). 5.10.0 also writes the pre-rename unit
#                          names as compatibility symlinks/aliases for ONE
#                          release (N2); they are removed in 5.11.0.
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
# product name. The OLD_* names are the ONE-RELEASE compatibility surface (N2),
# removed in 5.11.0 — see the TODO at install_grokfleet().
SERVICE="grokfleet-reconcile.service"
TIMER="grokfleet-reconcile.timer"
API_SERVICE="grokfleet-api.service"
OLD_SERVICE="fleet-reconcile.service"
OLD_TIMER="fleet-reconcile.timer"
OLD_API_SERVICE="fleet-api.service"

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
# N7 (5.10.0 rename) — every env seam below answers to BOTH spellings for ONE
# release. `FLEET2_<X>` is accepted wherever `GROKFLEET_<X>` is, under one rule:
#   * only one spelling set  ⇒ that value is used (a deprecation note is logged
#     for the old one, so an operator's stale export is never silently ignored);
#   * both set and EQUAL     ⇒ used, logged once;
#   * both set and DIFFERENT ⇒ REFUSE rc 1, naming both.
# That is the same instinct as the D3 paired-override refusal below: ambiguous
# pin input is refused, never guessed. REMOVE THE FLEET2_* HALF IN 5.11.0
# (TODO 5.11.0: delete resolve_compat_env + its callers and read GROKFLEET_*
# directly).
GROKFLEET_ENV_REFUSAL=""
resolve_compat_env() {
  # $1 = variable suffix (RELEASE, SHA256, …); $2 = the name of the shell
  # variable to assign the resolved value into. Assigns rather than echoes so a
  # refusal can `return 1` — a $( ) subshell could not abort the caller.
  local suffix="$1" out="$2" neu old
  eval "neu=\${GROKFLEET_${suffix}-}"
  eval "old=\${FLEET2_${suffix}-}"
  if [ -n "$neu" ] && [ -n "$old" ]; then
    if [ "$neu" != "$old" ]; then
      GROKFLEET_ENV_REFUSAL="GROKFLEET_${suffix}='$neu' and FLEET2_${suffix}='$old' are BOTH set and DIFFER — unset one (FLEET2_${suffix} is the 5.10.0-only compatibility spelling and is removed in 5.11.0)"
      return 1
    fi
    log "note: GROKFLEET_${suffix} and FLEET2_${suffix} are both set and agree — using it (FLEET2_${suffix} is deprecated; removed in 5.11.0)"
    printf -v "$out" '%s' "$neu"
    return 0
  fi
  if [ -n "$old" ]; then
    log "note: FLEET2_${suffix} is deprecated — use GROKFLEET_${suffix} (accepted for 5.10.0 only, removed in 5.11.0)"
    printf -v "$out" '%s' "$old"
    return 0
  fi
  printf -v "$out" '%s' "$neu"
  return 0
}

GROKFLEET_RELEASE_ENV=""
GROKFLEET_SHA256_ENV=""
GROKFLEET_BASE_URL_ENV=""
GROKFLEET_ASSET_ENV=""
GROKFLEET_BINARY_ENV=""
GROKFLEET_FETCH_ROOT_ENV=""
resolve_compat_env RELEASE    GROKFLEET_RELEASE_ENV    \
  && resolve_compat_env SHA256     GROKFLEET_SHA256_ENV     \
  && resolve_compat_env BASE_URL   GROKFLEET_BASE_URL_ENV   \
  && resolve_compat_env ASSET      GROKFLEET_ASSET_ENV      \
  && resolve_compat_env BINARY     GROKFLEET_BINARY_ENV     \
  && resolve_compat_env FETCH_ROOT GROKFLEET_FETCH_ROOT_ENV \
  || { log "install-vps.sh: REFUSING — $GROKFLEET_ENV_REFUSAL"; exit 1; }

# `make ts-release-build` rewrites EXACTLY these two lines (fleet/scripts/
# release-build.sh); keep them at column 0 in `NAME=value` form.
GROKFLEET_RELEASE=v5.11.0
# Placeholder until the first `make ts-release-build` writes the real digest.
# Until then the fetch 404s or mismatches — which, by D2, mutates nothing.
GROKFLEET_SHA256=41fa0e4cce39b6bc9a694277bc75105ee59d762cd28a98242816d464a8d40cd5

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
  # N2: BOTH generations of unit names. A host that never saw 5.10.0 has only
  # the OLD_* names; a 5.10.0 host has the new names plus the compat
  # symlinks/alias. Disabling a name that does not exist is a harmless no-op.
  if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now "$TIMER" >/dev/null 2>&1 || true
    systemctl disable --now "$OLD_TIMER" >/dev/null 2>&1 || true
    systemctl stop "$SERVICE" >/dev/null 2>&1 || true
    systemctl disable --now "$API_SERVICE" >/dev/null 2>&1 || true
    systemctl stop "$API_SERVICE" >/dev/null 2>&1 || true
    systemctl disable --now "$OLD_API_SERVICE" >/dev/null 2>&1 || true
    systemctl stop "$OLD_API_SERVICE" >/dev/null 2>&1 || true
  fi
  rm -f "$SYSTEMD_DIR/$SERVICE" "$SYSTEMD_DIR/$TIMER" "$SYSTEMD_DIR/$API_SERVICE" \
        "$SYSTEMD_DIR/$OLD_SERVICE" "$SYSTEMD_DIR/$OLD_TIMER" "$SYSTEMD_DIR/$OLD_API_SERVICE"
  if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  rm -rf "$OPT_DIR"
  # F4: remove the PATH symlink ONLY when it resolves to our target (never a
  # foreign symlink, never a regular file). PREFIX-rooted so a scratch uninstall
  # only ever touches the scratch link. N2: the compat `fleet2` link points at
  # the SAME target, so the guard matches either name against either target.
  local link
  for link in "$PREFIX/usr/local/bin/grokfleet" "$PREFIX/usr/local/bin/fleet2"; do
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

# r2-n1 — PEAK DISK AT THE 5.10.0 CUTOVER IS FIVE BINARIES, NOT FOUR.
# Between N6 steps (3) and (7) the host holds, at ~80 MB each: the fetch temp,
# the $OPT_DIR temp, the incumbent `fleet2`, the new `grokfleet`, and a
# pre-existing `fleet2.prev` — roughly 400 MB, against ~961 MB on the brain VPS.
# So the run refuses up front rather than dying halfway through a rename. A
# later (post-cutover) upgrade holds four, about 320 MB. Overridable so the test
# suite can drive the refusal.
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

# --- the 5.10.0 CUTOVER installer (blueprint fleet2-rename-grokfleet N6/N6a) --
#
# install_grokfleet ABSORBS what used to be three functions — install_fleet2,
# install_units and install_fleet_api (N6a). That absorption is load-bearing,
# not tidying: install_units/install_fleet_api wrote REAL unit files at the
# pre-rename paths with `ExecStart=$OPT_DIR/fleet2`. If either survived it would
# overwrite the two compatibility symlinks this function writes with units
# naming a binary that step (7) has just removed.
#
# `install_grokfleet || exit 1` DISABLES `set -e` for the whole function body
# (the D13 outage: an ENOSPC on the 80 MB copy did not abort, control reached
# the smoke test, and production ended up with a renamed engine and no
# replacement). So EVERY mutating line here checks its own status and routes to
# a named handler; nothing relies on `set -e`.
#
# Order, ONE run (a step's number is its N6 number):
#   (1) stage the verified bytes into an $OPT_DIR temp   — fail ⇒ nothing changed
#   (2) `version` smoke on that temp                     — fail ⇒ rm temp
#   (3) PRESERVE-THEN-INSTALL grokfleet(.prev)           — the T8 idempotency
#   (4) preserve + disable the OLD units  [CUTOVER only] — the N4 artifact
#   (5) write the three NEW units + the two compat symlinks   [every run]
#   (6) enable the timer, carry the API's boot enablement     [every run]
#   (7) demote $OPT_DIR/fleet2 -> grokfleet.prev         [old binary only]
#   (8) PATH symlinks grokfleet + fleet2                 [every run]
#   (9) try-restart the API — the ONE survivable failure [every run]
#
# Steps (5), (6), (8) and (9) are IDEMPOTENT and run on EVERY run, exactly as
# install_units / install_fleet_api / the PATH symlink did unconditionally
# before: a 5.10.0 host keeps getting its units repaired, its timer re-enabled
# and a deleted compat link restored. They are the safety net of this release.
#
# TWO INDEPENDENT DISCRIMINATORS (r6-B1), each testing what its own step
# manipulates rather than a proxy for it:
#   * step (7) runs iff $OPT_DIR/fleet2 is a regular file (the binary demotion);
#   * step (4) runs iff $SYSTEMD_DIR/fleet-reconcile.service is a REGULAR FILE
#     and NOT a symlink (the unit preserve/disable). CUTOVER=1 means (4) ran.
# A half-rolled-back host — the N4 binary restored, the units still the compat
# symlinks — therefore demotes the binary but does NOT re-preserve symlinks as
# units, which would poison the rollback artifact with 5.10.0 content.
#
# TODO 5.11.0: delete the whole compatibility layer — OLD_SERVICE/OLD_TIMER/
# OLD_API_SERVICE, the two `ln -sfn` compat symlinks, the timer's
# `Alias=fleet-reconcile.timer`, the `/usr/local/bin/fleet2` link, step (4),
# step (7) and resolve_compat_env().

# Set by step (9) (and by a recovered step-(5) failure on a re-run): the run had
# a problem that did NOT stop it. Main still exits 1 (r4-B1) — a survivable
# failure must not truncate the run, and the exit code must still say it failed.
DEFERRED_FAIL=0
# Set by step (4). 1 = this run performed the 5.9.x -> 5.10.0 unit cutover.
CUTOVER=0
# `systemctl is-enabled` for the API unit, recorded BEFORE step (4) disables it.
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

  # N2: the TIMER is the ONE unit the installer enables, so it is the one unit
  # whose compatibility name `Alias=` can actually create — `Alias=` materialises
  # only on `systemctl enable`. The two SERVICES are never enabled by the
  # installer (the reconcile service has no [Install] at all and is timer-driven;
  # the API unit is enabled by the empirical gate on PASS, TUI-D8), so their
  # compatibility names are written below as plain unit symlinks instead — which
  # is byte-for-byte what `enable` would have written for an Alias=.
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
# 5.10.0 compatibility (N2, ONE release — removed in 5.11.0): keep answering to
# the pre-rename timer name. A .timer alias must live in a .timer unit.
Alias=fleet-reconcile.timer
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

# N2: the two compatibility SERVICE names, written by the installer itself
# because `Alias=` cannot reach them (see write_grokfleet_units). `ln -sfn`
# unlinks then creates, so it replaces a regular file at the destination — which
# is exactly what the cutover needs, and what makes a re-run idempotent.
write_compat_service_links() {
  ln -sfn "$SERVICE" "$SYSTEMD_DIR/$OLD_SERVICE" || return 1
  ln -sfn "$API_SERVICE" "$SYSTEMD_DIR/$OLD_API_SERVICE" || return 1
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

# Step (4) failure: re-enable the old timer and the API per the RECORDED state,
# undo step (3), and refuse.
rollback_step4() {
  if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl enable --now "$OLD_TIMER" >/dev/null 2>&1 || true
    case "$API_WAS_ENABLED" in
      enabled|enabled-runtime) systemctl enable "$OLD_API_SERVICE" >/dev/null 2>&1 || true ;;
    esac
  fi
  undo_step3
  log "install_grokfleet: step (4) FAILED — pre-rename units re-enabled, grokfleet undone, nothing renamed"
}

# Step (5)/(6) failure, BRANCH-AWARE (r5-B1). With CUTOVER=1 the rollback
# artifact belongs to THIS run's incumbent, so restoring it is correct. With
# CUTOVER=0 it holds the ORIGINAL cutover's 5.9.0 units, naming a binary that no
# longer exists — restoring those would leave unstartable units and (with the
# blueprint's `rm grokfleet`) no engine at all. So the re-run branch never
# touches units.prev/ and never removes grokfleet; it simply rewrites the units
# and the symlinks again.
rollback_step5() {
  local u
  if [ "$CUTOVER" = 1 ]; then
    log "install_grokfleet: step (5)/(6) FAILED on the CUTOVER run — restoring $OPT_DIR/units.prev"
    rm -f "$SYSTEMD_DIR/$SERVICE" "$SYSTEMD_DIR/$TIMER" "$SYSTEMD_DIR/$API_SERVICE" \
          "$SYSTEMD_DIR/$OLD_SERVICE" "$SYSTEMD_DIR/$OLD_API_SERVICE"
    for u in "$OLD_SERVICE" "$OLD_TIMER" "$OLD_API_SERVICE"; do
      [ -e "$OPT_DIR/units.prev/$u" ] || continue
      cp -P -f "$OPT_DIR/units.prev/$u" "$SYSTEMD_DIR/$u" 2>/dev/null || true
    done
    if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
      systemctl daemon-reload >/dev/null 2>&1 || true
      systemctl enable --now "$OLD_TIMER" >/dev/null 2>&1 || true
      case "$API_WAS_ENABLED" in
        enabled|enabled-runtime) systemctl enable "$OLD_API_SERVICE" >/dev/null 2>&1 || true ;;
      esac
    fi
    undo_step3
    log "install_grokfleet: pre-rename units restored, timer re-enabled, grokfleet undone"
    return 1
  fi
  log "install_grokfleet: step (5)/(6) FAILED on a RE-RUN — units.prev is NOT touched (it holds the 5.9.0 units) and grokfleet stays; rewriting the units"
  if write_grokfleet_units && write_compat_service_links; then
    if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
      systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    # Recovered: the host has correct 5.10.0 units, so the run continues — but
    # the exit code still reports the failure (the DEFERRED_FAIL pattern).
    DEFERRED_FAIL=1
    log "install_grokfleet: units rewritten successfully — continuing, the installer will still exit 1"
    return 0
  fi
  log "install_grokfleet: the rewrite FAILED too — host stays on 5.10.0 with whatever units are on disk; fix by hand and re-run"
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
  # `.prev` is the previous grokfleet from the SECOND release on: without this
  # copy every upgrade after the 5.10.0 cutover would destroy its predecessor,
  # because step (7) — the other writer of grokfleet.prev — is gated on the
  # pre-rename binary and never fires again. The `cmp` guard keeps a no-change
  # re-run byte-identical (the T8 property). On the CUTOVER run $OPT_DIR/grokfleet
  # does not exist yet, so this copy cannot fire and step (7) is the sole writer;
  # on a HALF-ROLLED-BACK host both fire and (7) wins, which is the correct
  # pairing (a 5.9.0 binary next to the 5.9.0 units in units.prev/).
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

  # === (4) preserve + disable the PRE-RENAME units — CUTOVER RUN ONLY =======
  # Discriminator: the old reconcile SERVICE path is a REGULAR FILE and not a
  # symlink. `-f` alone follows symlinks and would still be true on a migrated
  # host, where that path holds the compatibility symlink.
  CUTOVER=0
  if [ -f "$SYSTEMD_DIR/$OLD_SERVICE" ] && [ ! -L "$SYSTEMD_DIR/$OLD_SERVICE" ]; then
    # ARTIFACT GUARD, HOISTED ABOVE EVERY MUTATION IN THIS STEP (r7-B1). It reads
    # units.prev/ and nothing else, so it can run first — and only then is
    # "nothing changed" literally true. units.prev/ is the N4 rollback artifact
    # and must only ever hold OLD-version units; a previous damaged run could
    # have left 5.10.0 units there, and overwriting a good artifact with new-
    # version units would make the next rollback restore 5.10.0 units alongside
    # the 5.9.0 binary — exactly the failure the artifact exists to prevent.
    if [ -e "$OPT_DIR/units.prev/$OLD_SERVICE" ] \
       && grep -q "$OPT_DIR/grokfleet" "$OPT_DIR/units.prev/$OLD_SERVICE" 2>/dev/null; then
      undo_step3
      log "grokfleet: refusing — $OPT_DIR/units.prev already holds 5.10.0 units; if that is intended, rm -r $OPT_DIR/units.prev and re-run"
      return 1
    fi

    # RECORD the operator's boot state for the API BEFORE disabling it. On an
    # upgrade this is state the operator (or the empirical gate on PASS)
    # established deliberately; the never-enable policy describes a FRESH
    # install, so applying it here would turn a `disable` into a permanent
    # removal that only shows up at the next reboot.
    if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
      API_WAS_ENABLED="$(systemctl is-enabled "$OLD_API_SERVICE" 2>/dev/null || true)"
      log "recorded $OLD_API_SERVICE boot state: '${API_WAS_ENABLED:-<unreadable>}'"
      # Disable BEFORE removing the unit files (the uninstall precedent), or the
      # *.wants symlinks dangle and then silently resolve again through the
      # compatibility name.
      systemctl disable --now "$OLD_TIMER" >/dev/null 2>&1 \
        || { rollback_step4; return 1; }
      # NOT --now for the API: the RUNNING api keeps serving until step (9)
      # rebinds it to the new bytes.
      systemctl disable "$OLD_API_SERVICE" >/dev/null 2>&1 \
        || { rollback_step4; return 1; }
    fi

    mkdir -p "$OPT_DIR/units.prev" || { rollback_step4; return 1; }
    for u in "$OLD_SERVICE" "$OLD_TIMER" "$OLD_API_SERVICE"; do
      if [ ! -e "$SYSTEMD_DIR/$u" ]; then
        log "note: no $u to preserve (rollback will not restore it)"
        continue
      fi
      # -P: NEVER dereference. Two of these three paths become symlinks to the
      # new units later in this run, and a plain `cp` on a re-entry would copy
      # the TARGET's contents into the rollback artifact.
      cp -P -f "$SYSTEMD_DIR/$u" "$OPT_DIR/units.prev/$u" || { rollback_step4; return 1; }
    done
    CUTOVER=1
    log "preserved the pre-rename units in $OPT_DIR/units.prev (N4 rollback artifact)"
  fi

  # === (5) the three NEW units, then the two compatibility symlinks =========
  # Unit-write failures are FATAL from 5.10.0 (they were non-fatal when
  # install_units/install_fleet_api were called bare). Deliberate: a half-renamed
  # host is worse than an aborted install, and rollback_step5 is what makes fatal
  # safe.
  write_grokfleet_units || { rollback_step5 || return 1; }
  if [ "$CUTOVER" = 1 ]; then
    # Only the TIMER path needs an explicit removal: its compatibility name comes
    # from `enable` (the Alias), not from a link we write, so a leftover regular
    # file there would shadow the alias. The two SERVICE paths need no rm —
    # `ln -sfn` unlinks then creates. On a re-run (CUTOVER=0) these three paths
    # hold the compat symlinks and the timer alias: leave them alone.
    rm -f "$SYSTEMD_DIR/$OLD_TIMER" || { rollback_step5 || return 1; }
  fi
  # D7: a phase-2 cutover drop-in (fleet-reconcile.service.d/fleet2.conf) is
  # obsolete — the base unit ExecStart runs the engine directly. Removed on every
  # run. r3-n2: any FUTURE drop-in belongs under grokfleet-reconcile.service.d/,
  # because systemd resolves drop-ins by the REAL unit name; a directory named
  # after the compatibility alias is silently ignored.
  local dropin="$SYSTEMD_DIR/$OLD_SERVICE.d/fleet2.conf"
  if [ -e "$dropin" ]; then
    rm -f "$dropin" || { rollback_step5 || return 1; }
    rmdir "$SYSTEMD_DIR/$OLD_SERVICE.d" 2>/dev/null || true
    log "removed obsolete cutover drop-in $dropin"
  fi
  write_compat_service_links || { rollback_step5 || return 1; }
  log "installed $SERVICE + $TIMER + $API_SERVICE; compatibility names $OLD_SERVICE / $OLD_API_SERVICE link to them (removed in 5.11.0)"

  if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || { rollback_step5 || return 1; }

    # === (6) enable the timer; CARRY OVER the API's boot enablement =========
    systemctl enable --now "$TIMER" || { rollback_step5 || return 1; }
    log "enabled $TIMER (reconcile every 5min; dry-run until config apply=true); $OLD_TIMER resolves through Alias="
    if [ "$CUTOVER" = 0 ]; then
      # No step (4) on this run, so the recorded state comes from the unit that
      # actually exists.
      API_WAS_ENABLED="$(systemctl is-enabled "$API_SERVICE" 2>/dev/null || true)"
    fi
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

  # === (7) demote the PRE-RENAME binary ====================================
  # Discriminator: $OPT_DIR/fleet2 is a regular file. `mv` (not `cp`) is
  # deliberate — a rename is not idempotent by nature, and on a re-run this step
  # simply does not fire; step (3) is the idempotent preservation path.
  if [ -f "$OPT_DIR/fleet2" ]; then
    mv -f "$OPT_DIR/fleet2" "$OPT_DIR/grokfleet.prev" || { rollback_step5 || return 1; }
    log "demoted $OPT_DIR/fleet2 -> $OPT_DIR/grokfleet.prev (the rollback target of THIS install)"
    if [ -e "$OPT_DIR/fleet2.prev" ]; then
      rm -f "$OPT_DIR/fleet2.prev" || { log "install_grokfleet: could not remove superseded $OPT_DIR/fleet2.prev"; return 1; }
      log "removed the superseded $OPT_DIR/fleet2.prev (two releases old; its units are gone)"
    fi
  fi

  # === (8) PATH symlinks — BEFORE the restart ==============================
  # Deliberately ahead of step (9): the one survivable failure below must leave a
  # host whose CLI resolves, so the operator's first recovery command works.
  # Nothing here depends on the service. The `fleet2` name is the N2 CLI
  # compatibility link and points at the SAME target (removed in 5.11.0).
  # BIN_DIR is an extracted-function test seam; normal installs retain the
  # established PREFIX-relative destination.
  local bindir="${BIN_DIR:-$PREFIX/usr/local/bin}"
  mkdir -p "$bindir" || { log "install_grokfleet: could not create $bindir for CLI links"; return 1; }
  ln -sfn "$OPT_DIR_REAL/grokfleet" "$bindir/grokfleet" \
    || { log "install_grokfleet: could not link $bindir/grokfleet"; return 1; }
  ln -sfn "$OPT_DIR_REAL/grokfleet" "$bindir/fleet2" \
    || { log "install_grokfleet: could not link $bindir/fleet2"; return 1; }
  log "linked $bindir/grokfleet and $bindir/fleet2 -> $OPT_DIR_REAL/grokfleet"

  # === (9) rebind a RUNNING API to the new bytes ===========================
  # A long-running unit keeps executing the binary it was STARTED with, and the
  # atomic `mv -f` above unlinks the old inode without touching the process.
  # Production served /v1/health version 5.5.0 for three and a half hours after
  # the 5.6.0 install, with /proc/<pid>/exe reading "(deleted)". `try-restart`
  # and nothing else: it restarts the unit ONLY if it is already active, so the
  # never-start policy (TUI-D8) is unchanged. ONLY the API — the reconcile unit
  # is a Type=oneshot whose next tick execs the new binary on its own.
  if [ -z "$PREFIX" ] && command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet "$API_SERVICE" 2>/dev/null \
       || systemctl is-active --quiet "$OLD_API_SERVICE" 2>/dev/null; then
      if systemctl try-restart "$API_SERVICE" >/dev/null 2>&1 \
         || systemctl try-restart "$OLD_API_SERVICE" >/dev/null 2>&1; then
        log "restarted $API_SERVICE (binary changed)"
      else
        # THE ONE SURVIVABLE FAILURE. Return 0 so every phase after this call
        # site still runs — including the sshd drop-in, the only one the file
        # marks fatal-if-it-fails — and let main exit 1 on DEFERRED_FAIL.
        log "grokfleet: API restart failed — host is on 5.10.0, CLI usable, run: systemctl start $API_SERVICE"
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
