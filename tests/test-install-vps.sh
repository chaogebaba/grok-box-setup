#!/bin/bash
# test-install-vps.sh — local, box-free, VPS-free coverage for vps/install-vps.sh.
# Split out of test-fleet-brain.sh (fleet2 phase-3 D8/F6): every assertion that
# drives the installer or its rendered units/drop-in lives HERE, so the bash
# fleetctl test file can be retired independently of the installer suite.
# No real tailscale/box/VPS/API needed: everything runs against a fake root
# PREFIX and shimmed sshd/systemctl. Run from anywhere:
#   bash tests/test-install-vps.sh   (or: make test)
# Exit 0 = all pass, 1 = a failure.
#
# What this covers:
#   installer  vps/install-vps.sh idempotency (run twice => identical tree) and
#              --uninstall (removes exactly what it installed), against a fake root;
#              the sanctioned installed footprint; the reconcile service is dry-run
#              until config apply=true; the scope guard (never mutates sshd/xray/
#              hysteria/wg0); the reconcile timer cadence (M20) and the ExecStart
#              --apply wrapper gate (M21); sshd is reloaded never restarted (M19).
#   sshd drop-in  the rendered 50-grok-fleet.conf carries `PermitListen any` (no
#              literal per-port list), PermitOpen none, the Match User fleet block
#              with ClientAlive{Interval,CountMax}; upgrade replaces a hand-widened
#              file; a dated .bak.* sidecar survives; the REAL validate/rollback
#              path (sshd -t OK lands / REJECT rolls back); a failed reload is
#              FATAL (F8).
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
VPS_INSTALL="$ROOT/vps/install-vps.sh"
fail=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; fail=1; }

[ -f "$VPS_INSTALL" ] || { echo "cannot find $VPS_INSTALL"; exit 1; }

# extract_from: print a `name() { ... }` definition (col-0 to col-0 }) from a file.
extract_from() {
  awk -v fn="$2" '
    $0 ~ "^"fn"\\(\\) \\{" {inside=1}
    inside {print}
    inside && /^\}$/ {exit}
  ' "$1"
}

# =============================================================================
# INSTALLER — vps/install-vps.sh idempotency + --uninstall (fake root PREFIX).
# =============================================================================
installer_idem_test() {
  local pfx; pfx="$(mktemp -d)"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1 || { echo "INSTALL1-FAIL"; rm -rf "$pfx"; return; }
  local a b
  a="$( (cd "$pfx" && find . -type f -exec sha256sum {} \; | sort) )"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1 || { echo "INSTALL2-FAIL"; rm -rf "$pfx"; return; }
  b="$( (cd "$pfx" && find . -type f -exec sha256sum {} \; | sort) )"
  if [ "$a" = "$b" ]; then echo "IDENTICAL"; else echo "DIFFERED"; fi
  rm -rf "$pfx"
}
[ "$(installer_idem_test)" = IDENTICAL ] && pass "installer: run twice => byte-identical tree (idempotent)" || bad "installer not idempotent: [$(installer_idem_test)]"

# The installed tree has exactly the expected files and NOTHING else.
installer_tree_test() {
  local pfx; pfx="$(mktemp -d)"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  ( cd "$pfx" && find . -type f | sort | sed "s#^\./##" ) | tr '\n' '|'
  rm -rf "$pfx"
}
tree="$(installer_tree_test)"
# etc/grok-fleet is a dir (no file) — normalize by removing the trailing dir slash entry if present.
tree_norm="$(printf '%s' "$tree" | sed 's#etc/grok-fleet/|##')"
# The sanctioned footprint (D7): fleet2 + config.toml + service + timer + the ONE
# sshd drop-in (B-3). The usr/local/bin/fleet2 symlink is a symlink (not -type f)
# and is asserted separately below. A FRESH install has no retired bash binary.
expected_norm="etc/ssh/sshd_config.d/50-grok-fleet.conf|etc/systemd/system/fleet-reconcile.service|etc/systemd/system/fleet-reconcile.timer|opt/grok-fleet/fleet2|opt/grok-fleet/config.toml|"
# The build also emits fleet2.prev on a re-run; the tree test uses a fresh pfx so
# only the first-install files are present. Sort-order: find|sort places
# opt/grok-fleet/fleet2 before .../config.toml? No — 'c' < 'f', so config first.
expected_norm="etc/ssh/sshd_config.d/50-grok-fleet.conf|etc/systemd/system/fleet-reconcile.service|etc/systemd/system/fleet-reconcile.timer|opt/grok-fleet/config.toml|opt/grok-fleet/fleet2|"
if [ "$tree_norm" = "$expected_norm" ]; then
  pass "installer: installs exactly fleet2 + config.toml + service + timer + one sshd drop-in (D7)"
else
  bad "installer tree unexpected: [$tree_norm] want [$expected_norm]"
fi

# T8 (F4, m17): a PREFIX= install creates only <pfx>/usr/local/bin/fleet2 as a
# symlink pointing at the REAL /opt/grok-fleet/fleet2 (never the real
# /usr/local/bin). m17 (symlink not PREFIX-rooted) ⇒ the scratch link is absent ⇒ killed.
installer_symlink_test() {
  local pfx; pfx="$(mktemp -d)"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  local link="$pfx/usr/local/bin/fleet2"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "/opt/grok-fleet/fleet2" ]; then echo "OK"; else echo "MISSING:[$link -> $(readlink "$link" 2>/dev/null)]"; fi
  rm -rf "$pfx"
}
[ "$(installer_symlink_test)" = OK ] && pass "installer (F4): PREFIX symlink usr/local/bin/fleet2 -> /opt/grok-fleet/fleet2" || bad "installer symlink wrong: [$(installer_symlink_test)]"

# T8 (D7): a FRESH install has NO retired bash binary; installing OVER an
# incumbent $OPT_DIR/fleetctl retires it to fleetctl.retired-c303696 mode 0644.
installer_fresh_no_retired_test() {
  local pfx; pfx="$(mktemp -d)"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  if [ -e "$pfx/opt/grok-fleet/fleetctl.retired-c303696" ]; then echo "HAS-RETIRED"; else echo "NONE"; fi
  rm -rf "$pfx"
}
[ "$(installer_fresh_no_retired_test)" = NONE ] && pass "installer (M6): fresh install has NO retired bash binary" || bad "installer fresh had a retired copy: [$(installer_fresh_no_retired_test)]"

installer_retire_incumbent_test() {
  local pfx; pfx="$(mktemp -d)"
  mkdir -p "$pfx/opt/grok-fleet"
  printf '#!/bin/bash\necho old\n' > "$pfx/opt/grok-fleet/fleetctl"; chmod 0755 "$pfx/opt/grok-fleet/fleetctl"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  local r="$pfx/opt/grok-fleet/fleetctl.retired-c303696"
  if [ -e "$r" ] && [ "$(stat -c '%a' "$r")" = 644 ] && [ ! -e "$pfx/opt/grok-fleet/fleetctl" ]; then echo "RETIRED-0644"; else echo "WRONG:[$(ls -la "$pfx/opt/grok-fleet/" 2>&1 | tr '\n' ';')]"; fi
  rm -rf "$pfx"
}
[ "$(installer_retire_incumbent_test)" = RETIRED-0644 ] && pass "installer (M6/Q4): install over an incumbent retires bash fleetctl to .retired-c303696 mode 0644" || bad "installer retire-incumbent wrong: [$(installer_retire_incumbent_test)]"

# T8 (Q3): bun-missing PREFLIGHT refuses rc 1 with the install hint, before any
# mutation. Shadow PATH so `command -v bun` fails; assert rc 1 + the hint.
installer_bun_missing_test() {
  local pfx; pfx="$(mktemp -d)"; local bindir; bindir="$(mktemp -d)"
  # A PATH with only the coreutils the installer needs, minus bun.
  for b in bash sh env mktemp install mv cp rm mkdir chmod chown ln grep sed awk cat printf find sort getent id touch stat readlink rmdir dirname cut make; do
    src="$(command -v "$b" 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$bindir/$b" 2>/dev/null || true
  done
  local out rc
  out="$(PREFIX="$pfx" PATH="$bindir" bash "$VPS_INSTALL" 2>&1)"; rc=$?
  rm -rf "$pfx" "$bindir"
  if [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'bun not found on PATH' && printf '%s' "$out" | grep -q 'bun.sh/install'; then echo "REFUSED-1"; else echo "WRONG:rc=$rc"; fi
}
[ "$(installer_bun_missing_test)" = REFUSED-1 ] && pass "installer (Q3): bun-missing PREFLIGHT refuses rc 1 with the install hint" || bad "installer bun-missing wrong: [$(installer_bun_missing_test)]"

# The reconcile service is DRY-RUN by default (no bare --apply baked in; the
# wrapper only adds it when config apply=true).
installer_dryrun_test() {
  local pfx; pfx="$(mktemp -d)"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  local svc="$pfx/etc/systemd/system/fleet-reconcile.service"
  # apply must be GATED on the config grep, never unconditional.
  if grep -q 'apply="--apply"' "$svc" && grep -q 'grep -Eq' "$svc"; then echo "GATED"; else echo "UNGATED"; fi
  rm -rf "$pfx"
}
[ "$(installer_dryrun_test)" = GATED ] && pass "installer: reconcile service is dry-run until config apply=true (--apply gated)" || bad "installer service not dry-run-gated: [$(installer_dryrun_test)]"

# --uninstall removes exactly what it installed (nothing under grok-fleet left)
# EXCEPT the state dir, which R2-B3 requires it to leave alone — see the sentinel
# case below. Units, /opt tree, secrets dir and symlink must all be gone.
installer_uninstall_test() {
  local pfx; pfx="$(mktemp -d)"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  PREFIX="$pfx" bash "$VPS_INSTALL" --uninstall >/dev/null 2>&1
  local left
  left="$( find "$pfx" \( -path '*grok-fleet*' -o -name 'fleet-reconcile*' \) \
             -not -path "$pfx/var/lib/grok-fleet" -not -path "$pfx/var/lib/grok-fleet/*" \
             2>/dev/null | wc -l | tr -d ' ' )"
  echo "$left"
  rm -rf "$pfx"
}
[ "$(installer_uninstall_test)" = 0 ] && pass "installer: --uninstall removes exactly what it installed (state excepted)" || bad "installer --uninstall left files: [$(installer_uninstall_test)]"

# R2-B3: --uninstall MUST LEAVE STATE. The gate seeded a sentinel under a PREFIX
# state dir and `--uninstall` deleted it, taking the device cache / key-expiry
# ledger with it. State outlives an install; only units, binaries, symlinks and
# secrets are ours to remove.
installer_uninstall_state_test() {
  local pfx; pfx="$(mktemp -d)"
  local sentinel="$pfx/var/lib/grok-fleet/preexisting-state-sentinel"
  mkdir -p "$pfx/var/lib/grok-fleet"
  printf 'do-not-delete\n' > "$sentinel"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  PREFIX="$pfx" bash "$VPS_INSTALL" --uninstall >/dev/null 2>&1
  local out=""
  if [ -f "$sentinel" ] && [ "$(cat "$sentinel")" = "do-not-delete" ]; then out="survived"; else out="REMOVED"; fi
  # and the things uninstall IS responsible for are still gone
  [ -e "$pfx/opt/grok-fleet" ] && out="$out+opt-left"
  [ -e "$pfx/etc/grok-fleet" ] && out="$out+secrets-left"
  [ -e "$pfx/etc/systemd/system/fleet-reconcile.service" ] && out="$out+unit-left"
  echo "$out"
  rm -rf "$pfx"
}
[ "$(installer_uninstall_state_test)" = survived ] && pass "installer: --uninstall leaves pre-existing state intact (R2-B3)" || bad "installer --uninstall did not leave state: [$(installer_uninstall_state_test)]"

# The installer must NOT MUTATE sshd/xray/hysteria/wg0 (scope guard). We scan
# for a mutating command (systemctl/rm/mv/install/sed -i/redirect) on the SAME
# line as one of those service names. Word-boundary on the verbs so "uninstall"
# does not match "install".
mutate_lines="$(grep -nE '(\bsystemctl\b|\brm\b|\bmv\b|\binstall\b|\bsed -i\b|>).*(\bxray\b|\bhysteria\b|\bwg0\b|\bwireguard\b|sshd_config)' "$VPS_INSTALL" || true)"
if [ -z "$mutate_lines" ]; then
  pass "installer: never MUTATES sshd/xray/hysteria/wg0 (scope guarantee holds)"
else
  bad "installer appears to MUTATE sshd/xray/hysteria/wg0: $mutate_lines"
fi

echo "-----"

# =============================================================================
# INSTALLER MUTANT KILLS (M19/M20/M21) — moved from test-fleet-brain.sh SURVIVOR
# KILLS; each drives install-vps.sh (or its installed units) and was verified to
# FLIP (PASS->FAIL) under its mutation on a scratch copy of install-vps.sh.
# =============================================================================

# --- M19: the REAL-install path must never RESTART sshd (only reload). A restart
# drops every live reverse tunnel. Scan the installer: no `systemctl restart`
# targeting ssh/sshd anywhere; reload is the only permitted sshd action.
if grep -nE 'systemctl[[:space:]]+restart[[:space:]]+(ssh|sshd)\b' "$VPS_INSTALL" >/dev/null 2>&1; then
  bad "M19: installer RESTARTS sshd (drops tunnels) — must only reload"
else
  # And it MUST reload (proving the sshd path is a reload, not a no-op).
  if grep -qE 'systemctl[[:space:]]+reload[[:space:]]+(ssh|sshd)\b' "$VPS_INSTALL"; then
    pass "M19: installer reloads (never restarts) sshd after the drop-in"
  else
    bad "M19: installer does not reload sshd after installing the drop-in"
  fi
fi

# --- M20: the reconcile timer fires every 5min (OnUnitActiveSec=5min). Assert on
# the INSTALLED unit, so a change to 10min is caught.
m20_test() {
  local pfx; pfx="$(mktemp -d)"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  grep -E '^OnUnitActiveSec=' "$pfx/etc/systemd/system/fleet-reconcile.timer" | tr -d ' '
  rm -rf "$pfx"
}
[ "$(m20_test)" = "OnUnitActiveSec=5min" ] && pass "M20: reconcile timer OnUnitActiveSec=5min (5-min reconcile cadence)" || bad "M20: timer cadence wrong: [$(m20_test)]"

# --- M21: the service ExecStart wrapper adds --apply IFF config apply=true, and
# NOT when apply=false. Execute the wrapper's shell logic against both configs.
# If the grep gate is inverted (M21), apply=false would wrongly add --apply.
m21_test() {
  local applyval="$1" pfx; pfx="$(mktemp -d)"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  local cfg="$pfx/opt/grok-fleet/config.toml"
  # Force the config's apply value.
  sed -i "s/^apply = .*/apply = $applyval/" "$cfg"
  # Extract the ExecStart command line and run its inner `bash -c '...'` with a
  # fleet2 stub that just echoes its args, capturing whether --apply is added.
  local execline
  execline="$(grep -E '^ExecStart=' "$pfx/etc/systemd/system/fleet-reconcile.service" | sed 's/^ExecStart=//')"
  local payload
  payload="$(printf '%s' "$execline" | sed -E "s#^/bin/bash -c '##; s#'\$##")"
  # The payload calls $OPT_DIR/fleet2 reconcile $apply; shadow that exact path
  # with an echo shim (overwriting the real built binary for this test only).
  cat > "$pfx/opt/grok-fleet/fleet2" <<'SHIM'
#!/bin/bash
echo "FLEET2-ARGS:$*"
SHIM
  chmod +x "$pfx/opt/grok-fleet/fleet2"
  bash -c "$payload" 2>/dev/null
  rm -rf "$pfx"
}
case "$(m21_test true)" in *"FLEET2-ARGS:reconcile --apply"*) pass "M21: config apply=true => wrapper runs reconcile --apply" ;; *) bad "M21: apply=true did not add --apply: [$(m21_test true)]" ;; esac
case "$(m21_test false)" in
  *"--apply"*) bad "M21: config apply=false WRONGLY added --apply (gate inverted): [$(m21_test false)]" ;;
  *"FLEET2-ARGS:reconcile"*) pass "M21: config apply=false => wrapper runs reconcile (no --apply)" ;;
  *) bad "M21: apply=false wrapper wrong: [$(m21_test false)]" ;;
esac

echo "-----"

# =============================================================================
# #12 PermitListen cap — installer sshd drop-in (D6a/D6b, #11, F10).
# =============================================================================

# --- D6(a): the rendered sshd drop-in has NO literal PermitListen port list,
# carries an explicit `PermitListen any`, and still has PermitOpen none + the
# Match block. Reuses the installer PREFIX harness.
dropin_render() {
  local pfx; pfx="$(mktemp -d)"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  cat "$pfx/etc/ssh/sshd_config.d/50-grok-fleet.conf"
  rm -rf "$pfx"
}
di="$(dropin_render)"
case "$di" in
  *'PermitListen 127.0.0.1:20001'*) bad "#12 D6a: drop-in STILL has the literal 8-port PermitListen list" ;;
  *) pass "#12 D6a: drop-in has NO literal 8-port PermitListen list" ;;
esac
printf '%s\n' "$di" | grep -qxE ' *PermitListen any' && pass "#12 D6a: drop-in sets PermitListen any (per-key permitlisten is the cap)" || bad "#12 D6a: drop-in missing 'PermitListen any': [$di]"
printf '%s\n' "$di" | grep -qxE ' *PermitOpen none' && pass "#12 D6a: drop-in keeps PermitOpen none (no local -L forwarding)" || bad "#12 D6a: drop-in lost 'PermitOpen none'"
case "$di" in *'Match User fleet'*) pass "#12 D6a: drop-in keeps Match User fleet" ;; *) bad "#12 D6a: drop-in lost Match User block" ;; esac

# --- #11: the fleet-user sshd drop-in carries ClientAliveInterval 30 +
# ClientAliveCountMax 3 INSIDE the `Match User fleet` block, so a dead tunnel
# session is reaped fast (a sleep/wake box can rebind its -R port). Assert both
# directives are present AND fall after the `Match User fleet` line (the Match
# block runs to EOF), and that a re-run keeps them (idempotent — the whole file
# is rewritten from one heredoc, so the upgrade harness output must carry them too).
di_match="$(printf '%s\n' "$di" | sed -n '/^Match User fleet/,$p')"
printf '%s\n' "$di_match" | grep -qxE ' *ClientAliveInterval 30' && pass "#11: drop-in sets ClientAliveInterval 30 inside the Match User fleet block" || bad "#11: drop-in missing 'ClientAliveInterval 30' in the Match block: [$di]"
printf '%s\n' "$di_match" | grep -qxE ' *ClientAliveCountMax 3' && pass "#11: drop-in sets ClientAliveCountMax 3 inside the Match User fleet block" || bad "#11: drop-in missing 'ClientAliveCountMax 3' in the Match block: [$di]"

# --- D6(b): UPGRADE — pre-seed PREFIX with the OLD hand-widened 8..20-port file,
# run the installer, and assert it is REPLACED with the uncapped `any` content.
dropin_upgrade() {
  local pfx; pfx="$(mktemp -d)"
  mkdir -p "$pfx/etc/ssh/sshd_config.d"
  cat > "$pfx/etc/ssh/sshd_config.d/50-grok-fleet.conf" <<'OLD'
Match User fleet
    AllowTcpForwarding remote
    PermitOpen none
    PermitListen 127.0.0.1:20001 127.0.0.1:20002 127.0.0.1:20003 127.0.0.1:20004 127.0.0.1:20005 127.0.0.1:20006 127.0.0.1:20007 127.0.0.1:20008 127.0.0.1:20009 127.0.0.1:20010 127.0.0.1:20011
OLD
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  cat "$pfx/etc/ssh/sshd_config.d/50-grok-fleet.conf"
  rm -rf "$pfx"
}
up="$(dropin_upgrade)"
case "$up" in
  *'PermitListen 127.0.0.1:2001'*|*'PermitListen 127.0.0.1:20001'*) bad "#12 D6b upgrade: old widened PermitListen list survived the installer re-run" ;;
  *) pass "#12 D6b upgrade: installer replaced the hand-widened 8..N-port file" ;;
esac
printf '%s\n' "$up" | grep -qxE ' *PermitListen any' && pass "#12 D6b upgrade: replacement file sets PermitListen any" || bad "#12 D6b upgrade: replacement missing 'PermitListen any'"
printf '%s\n' "$up" | grep -qxE ' *ClientAliveInterval 30' && pass "#11: installer re-run (upgrade) rewrites ClientAliveInterval 30 (idempotent)" || bad "#11: upgrade re-run lost 'ClientAliveInterval 30': [$up]"
printf '%s\n' "$up" | grep -qxE ' *ClientAliveCountMax 3' && pass "#11: installer re-run (upgrade) rewrites ClientAliveCountMax 3 (idempotent)" || bad "#11: upgrade re-run lost 'ClientAliveCountMax 3': [$up]"

# --- F10: a pre-existing DATED .bak.* sidecar (the hand-edit's backup — NOT the
# installer's) SURVIVES an installer re-run (the installer only manages the exact
# target, never the operator's .bak).
dropin_bak_survives() {
  local pfx; pfx="$(mktemp -d)"; local d="$pfx/etc/ssh/sshd_config.d"
  mkdir -p "$d"
  : > "$d/50-grok-fleet.conf.bak.20260829T153543Z"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  if [ -e "$d/50-grok-fleet.conf.bak.20260829T153543Z" ]; then echo SURVIVED; else echo GONE; fi
  rm -rf "$pfx"
}
[ "$(dropin_bak_survives)" = SURVIVED ] && pass "#12 F10: a dated .bak.* sidecar survives an installer re-run" || bad "#12 F10: installer clobbered the operator's .bak.* sidecar"

# --- F10 (D2 real-path): drive install_sshd_dropin down its REAL (non-PREFIX)
# validate/rollback path with a `sshd` shim. sshd -t OK => the drop-in lands with
# PermitListen any; sshd -t REJECT => the drop-in is rolled back (old content
# restored) and rc 1. This shim never touches a real daemon.
dropin_realpath() {
  local mode="$1" inner; inner="$(mktemp)"
  local d; d="$(mktemp -d)"
  # A fake sshd on PATH: `-t` honours FAKE_SSHD_T; anything else is a no-op.
  cat > "$d/sshd" <<'SSHD'
#!/usr/bin/env bash
if [ "$1" = -t ]; then exit "${FAKE_SSHD_T:-0}"; fi
exit 0
SSHD
  chmod +x "$d/sshd"
  # A fake systemctl so a "reload" always succeeds under the shim.
  cat > "$d/systemctl" <<'SC'
#!/usr/bin/env bash
exit 0
SC
  chmod +x "$d/systemctl"
  cat > "$inner" <<INNER
set -u
VPS_INSTALL="$VPS_INSTALL"
PATH="$d:\$PATH"
PREFIX=""                      # force the REAL validate/reload path
SSHD_DROPIN_DIR="$d/dropin"; mkdir -p "\$SSHD_DROPIN_DIR"
SSHD_DROPIN="\$SSHD_DROPIN_DIR/50-grok-fleet.conf"
FLEET_USER=fleet
printf 'OLDCONTENT\n' > "\$SSHD_DROPIN"     # a pre-existing file to roll back to
log(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$VPS_INSTALL" install_sshd_dropin)"
FAKE_SSHD_T=$mode install_sshd_dropin; rc=\$?
printf 'RC=%s|' "\$rc"; cat "\$SSHD_DROPIN"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
ok_out="$(dropin_realpath 0)"
case "$ok_out" in
  RC=0\|*'PermitListen any'*) pass "#12 F10: real-path install_sshd_dropin — sshd -t OK => lands PermitListen any, rc 0" ;;
  *) bad "#12 F10: real-path OK case wrong: [$ok_out]" ;;
esac
rej_out="$(dropin_realpath 1)"
case "$rej_out" in
  RC=1\|OLDCONTENT) pass "#12 F10: real-path install_sshd_dropin — sshd -t REJECT => rollback to old content, rc 1" ;;
  *) bad "#12 F10: real-path reject/rollback wrong: [$rej_out]" ;;
esac



# --- F8: install_sshd_dropin treats a FAILED sshd reload as FATAL (rc 1), not a
# swallowed note. sshd -t passes but BOTH systemctl reload arms fail.
dropin_reload_fatal() {
  local inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"
  cat > "$d/sshd" <<'SSHD'
#!/usr/bin/env bash
[ "$1" = -t ] && exit 0
exit 0
SSHD
  chmod +x "$d/sshd"
  cat > "$d/systemctl" <<'SC'
#!/usr/bin/env bash
exit 1
SC
  chmod +x "$d/systemctl"
  cat > "$inner" <<INNER
set -u
VPS_INSTALL="$VPS_INSTALL"
PATH="$d:\$PATH"
PREFIX=""
SSHD_DROPIN_DIR="$d/dropin"; mkdir -p "\$SSHD_DROPIN_DIR"
SSHD_DROPIN="\$SSHD_DROPIN_DIR/50-grok-fleet.conf"
FLEET_USER=fleet
log(){ echo "LOG:\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$VPS_INSTALL" install_sshd_dropin)"
install_sshd_dropin; echo "RC=\$?"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
case "$(dropin_reload_fatal)" in
  *"sshd reload FAILED"*"RC=1"*) pass "#12 F8: a failed sshd reload is FATAL (rc 1), never swallowed" ;;
  *) bad "#12 F8: reload-failure not fatal: [$(dropin_reload_fatal)]" ;;
esac

echo "-----"
if [ "$fail" = 0 ]; then echo "ALL INSTALL-VPS TESTS PASSED"; else echo "SOME INSTALL-VPS TESTS FAILED"; fi
exit "$fail"
