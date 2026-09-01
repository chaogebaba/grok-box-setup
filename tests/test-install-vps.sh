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
#   release path (blueprint fleet2-release-install) the fetch+verify PREFLIGHT
#              (curl/sha256sum refusals, the FLEET2_RELEASE+FLEET2_SHA256 pin
#              pairing), the D10 `file://` fixture origin (good body / corrupt
#              body / 404 / a 200 carrying an HTML error page), the D2 promise
#              that a failed acquisition leaves the tree BYTE-IDENTICAL, and the
#              D13 ordering fix: the incumbent fleetctl is retired only AFTER a
#              verified replacement is live.
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
# THE FLEET2_BINARY STUB (blueprint fleet2-release-install D7) — READ THIS
# BEFORE EDITING ANY CALL SITE BELOW.
# =============================================================================
# Since D1 the installer FETCHES an ~80 MB release asset with curl instead of
# building it on the host. This file drives `bash "$VPS_INSTALL"` at ~14 sites;
# without a stub each one would perform a real download (~1 GB per `make test`)
# in a suite that advertises "local, box-free, VPS-free coverage". So every call
# site passes FLEET2_BINARY="$STUB": an executable that exits 0 on `version`,
# which is exactly what install_fleet2's smoke test runs.
#
# *** THE TWO DELIBERATE EXCEPTIONS (D14) ***
# installer_curl_missing_test and installer_sha256sum_missing_test do NOT set
# FLEET2_BINARY, and MUST NOT. FLEET2_BINARY short-circuits the whole preflight,
# so setting it there would mean the curl/sha256sum refusal can never fire —
# both cases would become permanently-green no-ops asserting nothing. They are
# safe without it because the preflight refuses on the MISSING TOOL before any
# fetch is attempted, so no download happens even with the fetch path live.
# Each of the two grants the OTHER tool on PATH, for the same reason: granting
# both would leave nothing missing, and the refusal could never fire.
# Do NOT "fix" those two by adding FLEET2_BINARY.
#
# The fixture tests further down use FLEET2_BASE_URL (D10) with a `file://`
# origin instead, because they exercise the fetch/verify code FLEET2_BINARY
# deliberately skips.
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT
STUB="$STUB_DIR/fleet2-stub"
cat > "$STUB" <<'STUBEOF'
#!/bin/bash
# Stand-in for the release binary: the installer only ever runs `version`.
[ "${1:-}" = version ] && echo "fleet2 stub (test)"
exit 0
STUBEOF
chmod 0755 "$STUB"
STUB_SHA="$(sha256sum "$STUB" | cut -d' ' -f1)"

# =============================================================================
# INSTALLER — vps/install-vps.sh idempotency + --uninstall (fake root PREFIX).
# =============================================================================
installer_idem_test() {
  local pfx; pfx="$(mktemp -d)"
  FLEET2_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1 || { echo "INSTALL1-FAIL"; rm -rf "$pfx"; return; }
  local a b
  a="$( (cd "$pfx" && find . -type f -exec sha256sum {} \; | sort) )"
  FLEET2_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1 || { echo "INSTALL2-FAIL"; rm -rf "$pfx"; return; }
  b="$( (cd "$pfx" && find . -type f -exec sha256sum {} \; | sort) )"
  if [ "$a" = "$b" ]; then echo "IDENTICAL"; else echo "DIFFERED"; fi
  rm -rf "$pfx"
}
[ "$(installer_idem_test)" = IDENTICAL ] && pass "installer: run twice => byte-identical tree (idempotent)" || bad "installer not idempotent: [$(installer_idem_test)]"

# The installed tree has exactly the expected files and NOTHING else.
installer_tree_test() {
  local pfx; pfx="$(mktemp -d)"
  FLEET2_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
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
  FLEET2_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  local link="$pfx/usr/local/bin/fleet2"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "/opt/grok-fleet/fleet2" ]; then echo "OK"; else echo "MISSING:[$link -> $(readlink "$link" 2>/dev/null)]"; fi
  rm -rf "$pfx"
}
[ "$(installer_symlink_test)" = OK ] && pass "installer (F4): PREFIX symlink usr/local/bin/fleet2 -> /opt/grok-fleet/fleet2" || bad "installer symlink wrong: [$(installer_symlink_test)]"

# T8 (D7): a FRESH install has NO retired bash binary; installing OVER an
# incumbent $OPT_DIR/fleetctl retires it to fleetctl.retired-c303696 mode 0644.
installer_fresh_no_retired_test() {
  local pfx; pfx="$(mktemp -d)"
  FLEET2_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  if [ -e "$pfx/opt/grok-fleet/fleetctl.retired-c303696" ]; then echo "HAS-RETIRED"; else echo "NONE"; fi
  rm -rf "$pfx"
}
[ "$(installer_fresh_no_retired_test)" = NONE ] && pass "installer (M6): fresh install has NO retired bash binary" || bad "installer fresh had a retired copy: [$(installer_fresh_no_retired_test)]"

installer_retire_incumbent_test() {
  local pfx; pfx="$(mktemp -d)"
  mkdir -p "$pfx/opt/grok-fleet"
  printf '#!/bin/bash\necho old\n' > "$pfx/opt/grok-fleet/fleetctl"; chmod 0755 "$pfx/opt/grok-fleet/fleetctl"
  FLEET2_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  local r="$pfx/opt/grok-fleet/fleetctl.retired-c303696"
  if [ -e "$r" ] && [ "$(stat -c '%a' "$r")" = 644 ] && [ ! -e "$pfx/opt/grok-fleet/fleetctl" ]; then echo "RETIRED-0644"; else echo "WRONG:[$(ls -la "$pfx/opt/grok-fleet/" 2>&1 | tr '\n' ';')]"; fi
  rm -rf "$pfx"
}
[ "$(installer_retire_incumbent_test)" = RETIRED-0644 ] && pass "installer (M6/Q4): install over an incumbent retires bash fleetctl to .retired-c303696 mode 0644" || bad "installer retire-incumbent wrong: [$(installer_retire_incumbent_test)]"

# D6/D14 (replaces the retired installer_bun_missing_test, which asserted the
# `bun not found on PATH` refusal D6 deletes): the PREFLIGHT refuses rc 1 with an
# install hint when a tool the FETCH path needs is absent — before any mutation.
# `make` and `bun` are gone from the allowlist: since D1 the host builds nothing.
#
# D14: this takes TWO cases, each granting the OTHER tool. Granting both would
# leave nothing missing, the preflight would pass, and the refusal could never
# fire — a permanently-green no-op. NEITHER case sets FLEET2_BINARY (see the
# stub header at the top of this file): FLEET2_BINARY short-circuits the whole
# preflight and would make both cases vacuous. They cause no download because
# the preflight refuses on the missing tool BEFORE any fetch is attempted.
installer_tool_missing_test() {
  local grant="$1"                       # the ONE of curl/sha256sum we DO grant
  local pfx; pfx="$(mktemp -d)"; local bindir; bindir="$(mktemp -d)"
  local b src
  for b in bash sh env mktemp install mv cp rm mkdir chmod chown ln grep sed awk cat printf find sort getent id touch stat readlink rmdir dirname cut "$grant"; do
    src="$(command -v "$b" 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$bindir/$b" 2>/dev/null || true
  done
  local out rc
  out="$(PREFIX="$pfx" PATH="$bindir" bash "$VPS_INSTALL" 2>&1)"; rc=$?
  # Nothing may have been created under the PREFIX either (D2): the refusal is
  # in the preflight, so ensure_dirs never ran.
  local created; created="$(find "$pfx" -mindepth 1 2>/dev/null | wc -l | tr -d ' ')"
  rm -rf "$pfx" "$bindir"
  printf 'rc=%s created=%s|%s\n' "$rc" "$created" "$out"
}
# The two D14 cases, under the names the blueprint gives them. Each grants the
# OTHER tool; neither sets FLEET2_BINARY.
installer_curl_missing_test()      { installer_tool_missing_test sha256sum; }
installer_sha256sum_missing_test() { installer_tool_missing_test curl; }

curl_missing="$(installer_curl_missing_test)"
case "$curl_missing" in
  rc=1\ created=0\|*'curl not found on PATH'*'apt-get install -y curl'*)
    pass "installer (D6/D14): curl-missing PREFLIGHT refuses rc 1 with the install hint, nothing created" ;;
  *) bad "installer curl-missing wrong: [$curl_missing]" ;;
esac
sha_missing="$(installer_sha256sum_missing_test)"
case "$sha_missing" in
  rc=1\ created=0\|*'sha256sum not found on PATH'*'apt-get install -y coreutils'*)
    pass "installer (D6/D14): sha256sum-missing PREFLIGHT refuses rc 1 with the install hint, nothing created" ;;
  *) bad "installer sha256sum-missing wrong: [$sha_missing]" ;;
esac

# The reconcile service is DRY-RUN by default (no bare --apply baked in; the
# wrapper only adds it when config apply=true).
installer_dryrun_test() {
  local pfx; pfx="$(mktemp -d)"
  FLEET2_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
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
  FLEET2_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
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
  FLEET2_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
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
# RELEASE FETCH PATH + ORDERING (blueprint fleet2-release-install D1-D6, D10,
# D13). Offline: every case below drives a `file://` fixture origin or the
# FLEET2_BINARY hatch. Nothing here touches the network.
# =============================================================================

# --- D16 (acceptance #16), THE HEADLINE CASE ---------------------------------
# The fleetctl retirement must happen AFTER a verified replacement is live, not
# before. Until D13 the installer renamed the live engine to a NON-EXECUTABLE
# 0644 file first and only then copied and smoke-tested the replacement — and
# the rollback restores fleet2.prev ONLY, never fleetctl. That is how production
# ended up with a renamed engine and no replacement.
#
# Vehicle: FLEET2_BINARY= pointing at a stub that exits NON-ZERO on `version`.
# Truncation cannot be used here — down the fetch path D4's digest check refuses
# a bad file in the preflight, long before the smoke test. This stub stands in
# for the real failures the smoke test is there to catch: ENOSPC on the 80 MB
# copy, a `noexec` mount, a wrong-arch binary.
installer_retire_ordering_test() {
  local pfx sd; pfx="$(mktemp -d)"; sd="$(mktemp -d)"
  mkdir -p "$pfx/opt/grok-fleet"
  printf '#!/bin/bash\necho old-engine\n' > "$pfx/opt/grok-fleet/fleetctl"
  chmod 0755 "$pfx/opt/grok-fleet/fleetctl"
  local badbin="$sd/fleet2-bad"
  printf '#!/bin/bash\nexit 3\n' > "$badbin"; chmod 0755 "$badbin"
  local rc r
  FLEET2_BINARY="$badbin" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1; rc=$?
  r="rc=$rc"
  if [ -e "$pfx/opt/grok-fleet/fleetctl" ]; then r="$r fleetctl=present"; else r="$r fleetctl=GONE"; fi
  if [ -x "$pfx/opt/grok-fleet/fleetctl" ]; then r="$r exec=yes"; else r="$r exec=NO"; fi
  if [ -e "$pfx/opt/grok-fleet/fleetctl.retired-c303696" ]; then r="$r retired=YES"; else r="$r retired=no"; fi
  rm -rf "$pfx" "$sd"
  echo "$r"
}
ord="$(installer_retire_ordering_test)"
if [ "$ord" = "rc=1 fleetctl=present exec=yes retired=no" ]; then
  pass "installer (D13/#16): a failed 'version' smoke test leaves the incumbent fleetctl present + executable, NOT retired"
else
  bad "D13/#16 ORDERING DEFECT: [$ord] want [rc=1 fleetctl=present exec=yes retired=no]"
fi

# --- D10 fixture origin -------------------------------------------------------
# FLEET2_BASE_URL is a seam because the security-critical paths are UNTESTABLE
# against github.com: there is no controllable origin, no way to serve a corrupt
# body or an HTML error page, and no release exists yet. A `file://` origin
# drives the identical curl + sha256sum code. FLEET2_BINARY does not substitute
# here — it SKIPS verification, which is exactly the code under test.
fixture_origin() {
  local mode="$1" dir="$2"
  mkdir -p "$dir/v9.9.9"
  case "$mode" in
    good)    cp "$STUB" "$dir/v9.9.9/fleet2-linux-x64" ;;
    corrupt) head -c 12 "$STUB" > "$dir/v9.9.9/fleet2-linux-x64" ;;
    html)    printf '<!DOCTYPE html><html><head><title>Not Found</title></head><body>404</body></html>\n' > "$dir/v9.9.9/fleet2-linux-x64" ;;
    absent)  : ;;   # a 404: no asset at that address at all
  esac
}

# snap: the acceptance-#13 host snapshot — every path with its size and mode.
snap() { ( cd "$1" && find . -printf '%p %s %m\n' 2>/dev/null | sort ); }

# fetch_run <mode>: seed a PREFIX holding a LIVE incumbent fleetctl, snapshot it,
# run the installer against a <mode> fixture origin, snapshot again.
# Echoes: rc=<n> why=<...> tree=<SAME|CHANGED> fleetctl=<...> retired=<...> fleet2=<...>
#
# `why=` names WHICH refusal fired, and is load-bearing: without it the download
# refusal is untestable, because the digest check downstream would refuse a
# never-created file too and rc/tree would look identical. Asserting the reason
# is what makes each guard individually provable by mutation.
fetch_run() {
  local mode="$1"
  local pfx fx; pfx="$(mktemp -d)"; fx="$(mktemp -d)"
  mkdir -p "$pfx/opt/grok-fleet"
  printf '#!/bin/bash\necho old-engine\n' > "$pfx/opt/grok-fleet/fleetctl"
  chmod 0755 "$pfx/opt/grok-fleet/fleetctl"
  fixture_origin "$mode" "$fx"
  local before after out rc r
  before="$(snap "$pfx")"
  out="$(PREFIX="$pfx" FLEET2_BASE_URL="file://$fx" FLEET2_RELEASE=v9.9.9 FLEET2_SHA256="$STUB_SHA" \
    bash "$VPS_INSTALL" 2>&1)"; rc=$?
  after="$(snap "$pfx")"
  r="rc=$rc"
  case "$out" in
    *'could not download'*) r="$r why=download" ;;
    *'sha256 MISMATCH'*)    r="$r why=digest" ;;
    *)                      r="$r why=none" ;;
  esac
  if [ "$before" = "$after" ]; then r="$r tree=SAME"; else r="$r tree=CHANGED"; fi
  if [ -e "$pfx/opt/grok-fleet/fleetctl" ]; then r="$r fleetctl=present"; else r="$r fleetctl=GONE"; fi
  if [ -e "$pfx/opt/grok-fleet/fleetctl.retired-c303696" ]; then r="$r retired=YES"; else r="$r retired=no"; fi
  if [ -x "$pfx/opt/grok-fleet/fleet2" ] \
     && [ "$(sha256sum "$pfx/opt/grok-fleet/fleet2" | cut -d' ' -f1)" = "$STUB_SHA" ] \
     && "$pfx/opt/grok-fleet/fleet2" version >/dev/null 2>&1; then
    r="$r fleet2=pinned-and-runs"
  elif [ -e "$pfx/opt/grok-fleet/fleet2" ]; then r="$r fleet2=WRONG"
  else r="$r fleet2=absent"; fi
  rm -rf "$pfx" "$fx"
  echo "$r"
}

# #1/#13: a 404 (an unpublished tag, the state `main` is in between the phase-3
# merge and the first release) exits rc 1 from the PREFLIGHT and leaves the tree
# BYTE-IDENTICAL. Note the snapshot is the real test: under D2 install_fleet2 is
# never called at all, so "install_fleet2 returns 1" is not assertable.
# The "no fleet user was created" clause of #13 is kept for the record but is
# VACUOUS under PREFIX: ensure_fleet_user returns early when PREFIX is set, so
# this suite cannot prove it — only a real (PREFIX-less) run could.
r404="$(fetch_run absent)"
if [ "$r404" = "rc=1 why=download tree=SAME fleetctl=present retired=no fleet2=absent" ]; then
  pass "installer (D2/#1): a 404 on the pinned tag exits rc 1 from the preflight, tree byte-identical, fleetctl untouched"
else
  bad "#1 404 case wrong: [$r404]"
fi

# #2/#12: a corrupt (truncated) body — 200, wrong bytes — is refused on the
# digest, the download is deleted, and the tree is byte-identical.
rcorrupt="$(fetch_run corrupt)"
if [ "$rcorrupt" = "rc=1 why=digest tree=SAME fleetctl=present retired=no fleet2=absent" ]; then
  pass "installer (D4/#2): a corrupt body fails the sha256 check, rc 1, tree byte-identical"
else
  bad "#2 corrupt case wrong: [$rcorrupt]"
fi

# #12: a captive portal / proxy answering 200 with an HTML error page. Same
# refusal, via the digest — which is the point of verifying at all.
rhtml="$(fetch_run html)"
if [ "$rhtml" = "rc=1 why=digest tree=SAME fleetctl=present retired=no fleet2=absent" ]; then
  pass "installer (D4/#12): a 200 whose body is an HTML error page fails the sha256 check, rc 1, tree byte-identical"
else
  bad "#12 html-body case wrong: [$rhtml]"
fi

# #4/#12/#17: the happy fetch path. The installed file's sha256 equals the pin
# AND the binary's `version` exits 0 (acceptance #4 is not runnable as written —
# "version matches the pinned sha256" — so it is implemented as those two).
# #17: retirement DOES happen on the success path, after the replacement is live.
rgood="$(fetch_run good)"
if [ "$rgood" = "rc=0 why=none tree=CHANGED fleetctl=GONE retired=YES fleet2=pinned-and-runs" ]; then
  pass "installer (D1/#4): a good fetch installs the pinned bytes, 'version' runs, and the incumbent is retired AFTER (#17)"
else
  bad "#4 good-fetch case wrong: [$rgood]"
fi

# #8: the fetch path leaves NO download temp and NO .sha256 in $OPT_DIR — the
# download lives outside $PREFIX entirely (D2/D7) and is cleaned up by the trap.
installer_tree_fetch_test() {
  local pfx fx; pfx="$(mktemp -d)"; fx="$(mktemp -d)"
  fixture_origin good "$fx"
  PREFIX="$pfx" FLEET2_BASE_URL="file://$fx" FLEET2_RELEASE=v9.9.9 FLEET2_SHA256="$STUB_SHA" \
    bash "$VPS_INSTALL" >/dev/null 2>&1
  ( cd "$pfx" && find . -type f | sort | sed "s#^\./##" ) | tr '\n' '|'
  rm -rf "$pfx" "$fx"
}
tree_fetch="$(installer_tree_fetch_test | sed 's#etc/grok-fleet/|##')"
if [ "$tree_fetch" = "$expected_norm" ]; then
  pass "installer (D7/#8): the FETCH path leaves no download temp and no .sha256 in \$OPT_DIR"
else
  bad "#8 fetch-path tree unexpected: [$tree_fetch] want [$expected_norm]"
fi

# #5 (D3): the tag is only an address; the sha256 is the identity. Overriding one
# without the other means fetching bytes the operator has not pinned ⇒ refusal.
# No FLEET2_BINARY here on purpose: the pairing check runs first in the preflight,
# so nothing is fetched and nothing is created.
installer_pin_pairing_test() {
  local which="$1" pfx out rc created
  pfx="$(mktemp -d)"
  case "$which" in
    release) out="$(PREFIX="$pfx" FLEET2_RELEASE=v9.9.9 bash "$VPS_INSTALL" 2>&1)"; rc=$? ;;
    *)       out="$(PREFIX="$pfx" FLEET2_SHA256="$STUB_SHA" bash "$VPS_INSTALL" 2>&1)"; rc=$? ;;
  esac
  created="$(find "$pfx" -mindepth 1 2>/dev/null | wc -l | tr -d ' ')"
  rm -rf "$pfx"
  printf 'rc=%s created=%s|%s\n' "$rc" "$created" "$out"
}
for w in release:FLEET2_RELEASE sha:FLEET2_SHA256; do
  pp="$(installer_pin_pairing_test "${w%%:*}")"
  case "$pp" in
    rc=1\ created=0\|*'must be overridden TOGETHER'*)
      pass "installer (D3/#5): ${w##*:} set alone ⇒ refusal rc 1, nothing created" ;;
    *) bad "#5 pin-pairing (${w##*:}) wrong: [$pp]" ;;
  esac
done

# #6: THE ACTUAL r2 PRODUCTION FAILURE. The gate died on `make: command not
# found` while building fleet2 on the VPS. With neither bun NOR make on PATH the
# install must now succeed — the host requirement went from bun + make + a full
# checkout to curl + sha256sum.
installer_no_bun_no_make_test() {
  local pfx fx bindir b src rc have hasbun hasmake
  pfx="$(mktemp -d)"; fx="$(mktemp -d)"; bindir="$(mktemp -d)"
  fixture_origin good "$fx"
  for b in bash sh env mktemp install mv cp rm mkdir chmod chown ln grep sed awk cat printf find sort getent id touch stat readlink rmdir dirname cut cmp curl sha256sum; do
    src="$(command -v "$b" 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$bindir/$b" 2>/dev/null || true
  done
  PREFIX="$pfx" PATH="$bindir" FLEET2_BASE_URL="file://$fx" FLEET2_RELEASE=v9.9.9 FLEET2_SHA256="$STUB_SHA" \
    bash "$VPS_INSTALL" >/dev/null 2>&1; rc=$?
  have=no; [ -x "$pfx/opt/grok-fleet/fleet2" ] && have=yes
  hasbun=yes; PATH="$bindir" command -v bun >/dev/null 2>&1 || hasbun=no
  hasmake=yes; PATH="$bindir" command -v make >/dev/null 2>&1 || hasmake=no
  rm -rf "$pfx" "$fx" "$bindir"
  echo "rc=$rc fleet2=$have bun=$hasbun make=$hasmake"
}
nbm="$(installer_no_bun_no_make_test)"
if [ "$nbm" = "rc=0 fleet2=yes bun=no make=no" ]; then
  pass "installer (D1/#6): install succeeds with NEITHER bun NOR make on PATH (the r2 production failure)"
else
  bad "#6 no-bun-no-make wrong: [$nbm] want [rc=0 fleet2=yes bun=no make=no]"
fi

# D7: exactly ONE real-network test, SKIPPED BY DEFAULT. Every case above is
# offline; this is the only one that touches github.com, and it needs a
# published release. Enable it with FLEET2_TEST_REAL_FETCH=1.
if [ "${FLEET2_TEST_REAL_FETCH:-0}" = 1 ]; then
  real_fetch_test() {
    local pfx rc; pfx="$(mktemp -d)"
    # No FLEET2_BASE_URL, no FLEET2_RELEASE/FLEET2_SHA256 overrides: this uses
    # the COMMITTED pin against the real release origin.
    PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1; rc=$?
    local r="rc=$rc"
    if [ -x "$pfx/opt/grok-fleet/fleet2" ] && "$pfx/opt/grok-fleet/fleet2" version >/dev/null 2>&1; then
      r="$r fleet2=runs"
    else r="$r fleet2=BAD"; fi
    rm -rf "$pfx"
    echo "$r"
  }
  rf="$(real_fetch_test)"
  [ "$rf" = "rc=0 fleet2=runs" ] && pass "installer (#4): REAL fetch of the committed pin installs and runs" || bad "#4 real fetch wrong: [$rf]"
else
  pass "installer (D7): the real-fetch test is SKIPPED by default (FLEET2_TEST_REAL_FETCH=1 to run it) — the suite downloads nothing"
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
  FLEET2_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  grep -E '^OnUnitActiveSec=' "$pfx/etc/systemd/system/fleet-reconcile.timer" | tr -d ' '
  rm -rf "$pfx"
}
[ "$(m20_test)" = "OnUnitActiveSec=5min" ] && pass "M20: reconcile timer OnUnitActiveSec=5min (5-min reconcile cadence)" || bad "M20: timer cadence wrong: [$(m20_test)]"

# --- M21: the service ExecStart wrapper adds --apply IFF config apply=true, and
# NOT when apply=false. Execute the wrapper's shell logic against both configs.
# If the grep gate is inverted (M21), apply=false would wrongly add --apply.
m21_test() {
  local applyval="$1" pfx; pfx="$(mktemp -d)"
  FLEET2_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
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
  FLEET2_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
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
  FLEET2_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
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
  FLEET2_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
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
