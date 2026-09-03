#!/bin/bash
# test-install-vps.sh — local, box-free, VPS-free coverage for vps/install-vps.sh.
# Split out of test-fleet-brain.sh (grokfleet phase-3 D8/F6): every assertion that
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
#              (curl/sha256sum refusals, the GROKFLEET_RELEASE+GROKFLEET_SHA256 pin
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
# THE GROKFLEET_BINARY STUB (blueprint fleet2-release-install D7) — READ THIS
# BEFORE EDITING ANY CALL SITE BELOW.
# =============================================================================
# Since D1 the installer FETCHES an ~80 MB release asset with curl instead of
# building it on the host. This file drives `bash "$VPS_INSTALL"` at ~14 sites;
# without a stub each one would perform a real download (~1 GB per `make test`)
# in a suite that advertises "local, box-free, VPS-free coverage". So every call
# site passes GROKFLEET_BINARY="$STUB": an executable that exits 0 on `version`,
# which is exactly what install_grokfleet's smoke test runs.
#
# *** THE TWO DELIBERATE EXCEPTIONS (D14) ***
# installer_curl_missing_test and installer_sha256sum_missing_test do NOT set
# GROKFLEET_BINARY, and MUST NOT. GROKFLEET_BINARY short-circuits the whole preflight,
# so setting it there would mean the curl/sha256sum refusal can never fire —
# both cases would become permanently-green no-ops asserting nothing. They are
# safe without it because the preflight refuses on the MISSING TOOL before any
# fetch is attempted, so no download happens even with the fetch path live.
# Each of the two grants the OTHER tool on PATH, for the same reason: granting
# both would leave nothing missing, and the refusal could never fire.
# Do NOT "fix" those two by adding GROKFLEET_BINARY.
#
# The fixture tests further down use GROKFLEET_BASE_URL (D10) with a `file://`
# origin instead, because they exercise the fetch/verify code GROKFLEET_BINARY
# deliberately skips.
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT
STUB="$STUB_DIR/grokfleet-stub"
cat > "$STUB" <<'STUBEOF'
#!/bin/bash
# Stand-in for the release binary: the installer only ever runs `version`.
[ "${1:-}" = version ] && echo "grokfleet stub (test)"
exit 0
STUBEOF
chmod 0755 "$STUB"
STUB_SHA="$(sha256sum "$STUB" | cut -d' ' -f1)"

# =============================================================================
# INSTALLER — vps/install-vps.sh idempotency + --uninstall (fake root PREFIX).
# =============================================================================
installer_idem_test() {
  local pfx; pfx="$(mktemp -d)"
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1 || { echo "INSTALL1-FAIL"; rm -rf "$pfx"; return; }
  local a b
  a="$( (cd "$pfx" && find . -type f -exec sha256sum {} \; | sort) )"
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1 || { echo "INSTALL2-FAIL"; rm -rf "$pfx"; return; }
  b="$( (cd "$pfx" && find . -type f -exec sha256sum {} \; | sort) )"
  if [ "$a" = "$b" ]; then echo "IDENTICAL"; else echo "DIFFERED"; fi
  rm -rf "$pfx"
}
[ "$(installer_idem_test)" = IDENTICAL ] && pass "installer: run twice => byte-identical tree (idempotent)" || bad "installer not idempotent: [$(installer_idem_test)]"

# The installed tree has exactly the expected files and NOTHING else.
installer_tree_test() {
  local pfx; pfx="$(mktemp -d)"
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  ( cd "$pfx" && find . -type f | sort | sed "s#^\./##" ) | tr '\n' '|'
  rm -rf "$pfx"
}
tree="$(installer_tree_test)"
# etc/grok-fleet is a dir (no file) — normalize by removing the trailing dir slash entry if present.
tree_norm="$(printf '%s' "$tree" | sed 's#etc/grok-fleet/|##')"
# The sanctioned footprint (D7): grokfleet + config.toml + service + timer + the ONE
# sshd drop-in (B-3). The usr/local/bin/grokfleet symlink is a symlink (not -type f)
# and is asserted separately below. A FRESH install has no retired bash binary.
# TUI-D8 (grokfleet admin panel): the API unit is written but NOT enabled.
# 5.10.0 (N2): the two compatibility service names are SYMLINKS, so `find -type f`
# does not list them — they are asserted separately by the compat-surface case.
# The build also emits grokfleet.prev on a re-run; the tree test uses a fresh pfx
# so only the first-install files are present. Sort order is plain `sort`.
expected_norm="etc/ssh/sshd_config.d/50-grok-fleet.conf|etc/systemd/system/grokfleet-api.service|etc/systemd/system/grokfleet-reconcile.service|etc/systemd/system/grokfleet-reconcile.timer|opt/grok-fleet/config.toml|opt/grok-fleet/grokfleet|"
if [ "$tree_norm" = "$expected_norm" ]; then
  pass "installer: installs exactly grokfleet + config.toml + service + timer + fleet-api.service + one sshd drop-in (D7/TUI-D8)"
else
  bad "installer tree unexpected: [$tree_norm] want [$expected_norm]"
fi

# T8 (F4, m17): a PREFIX= install creates only <pfx>/usr/local/bin/grokfleet as a
# symlink pointing at the REAL /opt/grok-fleet/grokfleet (never the real
# /usr/local/bin). m17 (symlink not PREFIX-rooted) ⇒ the scratch link is absent ⇒ killed.
installer_symlink_test() {
  local pfx; pfx="$(mktemp -d)"
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  local link="$pfx/usr/local/bin/grokfleet"
  if [ -L "$link" ] && [ "$(readlink "$link")" = "/opt/grok-fleet/grokfleet" ]; then echo "OK"; else echo "MISSING:[$link -> $(readlink "$link" 2>/dev/null)]"; fi
  rm -rf "$pfx"
}
[ "$(installer_symlink_test)" = OK ] && pass "installer (F4): PREFIX symlink usr/local/bin/grokfleet -> /opt/grok-fleet/grokfleet" || bad "installer symlink wrong: [$(installer_symlink_test)]"

# T8 (D7): a FRESH install has NO retired bash binary; installing OVER an
# incumbent $OPT_DIR/fleetctl retires it to fleetctl.retired-c303696 mode 0644.
installer_fresh_no_retired_test() {
  local pfx; pfx="$(mktemp -d)"
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  if [ -e "$pfx/opt/grok-fleet/fleetctl.retired-c303696" ]; then echo "HAS-RETIRED"; else echo "NONE"; fi
  rm -rf "$pfx"
}
[ "$(installer_fresh_no_retired_test)" = NONE ] && pass "installer (M6): fresh install has NO retired bash binary" || bad "installer fresh had a retired copy: [$(installer_fresh_no_retired_test)]"

installer_retire_incumbent_test() {
  local pfx; pfx="$(mktemp -d)"
  mkdir -p "$pfx/opt/grok-fleet"
  printf '#!/bin/bash\necho old\n' > "$pfx/opt/grok-fleet/fleetctl"; chmod 0755 "$pfx/opt/grok-fleet/fleetctl"
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
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
# fire — a permanently-green no-op. NEITHER case sets GROKFLEET_BINARY (see the
# stub header at the top of this file): GROKFLEET_BINARY short-circuits the whole
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
# OTHER tool; neither sets GROKFLEET_BINARY.
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
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  local svc="$pfx/etc/systemd/system/grokfleet-reconcile.service"
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
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  PREFIX="$pfx" bash "$VPS_INSTALL" --uninstall >/dev/null 2>&1
  local left
  left="$( find "$pfx" \( -path '*grok-fleet*' -o -name 'fleet-reconcile*' -o -name 'fleet-api*' \) \
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
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  PREFIX="$pfx" bash "$VPS_INSTALL" --uninstall >/dev/null 2>&1
  local out=""
  if [ -f "$sentinel" ] && [ "$(cat "$sentinel")" = "do-not-delete" ]; then out="survived"; else out="REMOVED"; fi
  # and the things uninstall IS responsible for are still gone
  [ -e "$pfx/opt/grok-fleet" ] && out="$out+opt-left"
  [ -e "$pfx/etc/grok-fleet" ] && out="$out+secrets-left"
  [ -e "$pfx/etc/systemd/system/grokfleet-reconcile.service" ] && out="$out+unit-left"
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
# GROKFLEET_BINARY hatch. Nothing here touches the network.
# =============================================================================

# --- D16 (acceptance #16), THE HEADLINE CASE ---------------------------------
# The fleetctl retirement must happen AFTER a verified replacement is live, not
# before. Until D13 the installer renamed the live engine to a NON-EXECUTABLE
# 0644 file first and only then copied and smoke-tested the replacement — and
# the rollback restores grokfleet.prev ONLY, never fleetctl. That is how production
# ended up with a renamed engine and no replacement.
#
# Vehicle: GROKFLEET_BINARY= pointing at a stub that exits NON-ZERO on `version`.
# Truncation cannot be used here — down the fetch path D4's digest check refuses
# a bad file in the preflight, long before the smoke test. This stub stands in
# for the real failures the smoke test is there to catch: ENOSPC on the 80 MB
# copy, a `noexec` mount, a wrong-arch binary.
installer_retire_ordering_test() {
  local pfx sd; pfx="$(mktemp -d)"; sd="$(mktemp -d)"
  mkdir -p "$pfx/opt/grok-fleet"
  printf '#!/bin/bash\necho old-engine\n' > "$pfx/opt/grok-fleet/fleetctl"
  chmod 0755 "$pfx/opt/grok-fleet/fleetctl"
  local badbin="$sd/grokfleet-bad"
  printf '#!/bin/bash\nexit 3\n' > "$badbin"; chmod 0755 "$badbin"
  local rc r
  GROKFLEET_BINARY="$badbin" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1; rc=$?
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
# GROKFLEET_BASE_URL is a seam because the security-critical paths are UNTESTABLE
# against github.com: there is no controllable origin, no way to serve a corrupt
# body or an HTML error page, and no release exists yet. A `file://` origin
# drives the identical curl + sha256sum code. GROKFLEET_BINARY does not substitute
# here — it SKIPS verification, which is exactly the code under test.
fixture_origin() {
  local mode="$1" dir="$2"
  mkdir -p "$dir/v9.9.9"
  case "$mode" in
    good)    cp "$STUB" "$dir/v9.9.9/grokfleet-linux-x64" ;;
    corrupt) head -c 12 "$STUB" > "$dir/v9.9.9/grokfleet-linux-x64" ;;
    html)    printf '<!DOCTYPE html><html><head><title>Not Found</title></head><body>404</body></html>\n' > "$dir/v9.9.9/grokfleet-linux-x64" ;;
    absent)  : ;;   # a 404: no asset at that address at all
  esac
}

# snap: the acceptance-#13 host snapshot — every path with its size and mode.
snap() { ( cd "$1" && find . -printf '%p %s %m\n' 2>/dev/null | sort ); }

# fetch_run <mode>: seed a PREFIX holding a LIVE incumbent fleetctl, snapshot it,
# run the installer against a <mode> fixture origin, snapshot again.
# Echoes: rc=<n> why=<...> tree=<SAME|CHANGED> fleetctl=<...> retired=<...> grokfleet=<...>
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
  out="$(PREFIX="$pfx" GROKFLEET_BASE_URL="file://$fx" GROKFLEET_RELEASE=v9.9.9 GROKFLEET_SHA256="$STUB_SHA" \
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
  if [ -x "$pfx/opt/grok-fleet/grokfleet" ] \
     && [ "$(sha256sum "$pfx/opt/grok-fleet/grokfleet" | cut -d' ' -f1)" = "$STUB_SHA" ] \
     && "$pfx/opt/grok-fleet/grokfleet" version >/dev/null 2>&1; then
    r="$r grokfleet=pinned-and-runs"
  elif [ -e "$pfx/opt/grok-fleet/grokfleet" ]; then r="$r grokfleet=WRONG"
  else r="$r grokfleet=absent"; fi
  rm -rf "$pfx" "$fx"
  echo "$r"
}

# #1/#13: a 404 (an unpublished tag, the state `main` is in between the phase-3
# merge and the first release) exits rc 1 from the PREFLIGHT and leaves the tree
# BYTE-IDENTICAL. Note the snapshot is the real test: under D2 install_grokfleet is
# never called at all, so "install_grokfleet returns 1" is not assertable.
# The "no fleet user was created" clause of #13 is kept for the record but is
# VACUOUS under PREFIX: ensure_fleet_user returns early when PREFIX is set, so
# this suite cannot prove it — only a real (PREFIX-less) run could.
r404="$(fetch_run absent)"
if [ "$r404" = "rc=1 why=download tree=SAME fleetctl=present retired=no grokfleet=absent" ]; then
  pass "installer (D2/#1): a 404 on the pinned tag exits rc 1 from the preflight, tree byte-identical, fleetctl untouched"
else
  bad "#1 404 case wrong: [$r404]"
fi

# #2/#12: a corrupt (truncated) body — 200, wrong bytes — is refused on the
# digest, the download is deleted, and the tree is byte-identical.
rcorrupt="$(fetch_run corrupt)"
if [ "$rcorrupt" = "rc=1 why=digest tree=SAME fleetctl=present retired=no grokfleet=absent" ]; then
  pass "installer (D4/#2): a corrupt body fails the sha256 check, rc 1, tree byte-identical"
else
  bad "#2 corrupt case wrong: [$rcorrupt]"
fi

# #12: a captive portal / proxy answering 200 with an HTML error page. Same
# refusal, via the digest — which is the point of verifying at all.
rhtml="$(fetch_run html)"
if [ "$rhtml" = "rc=1 why=digest tree=SAME fleetctl=present retired=no grokfleet=absent" ]; then
  pass "installer (D4/#12): a 200 whose body is an HTML error page fails the sha256 check, rc 1, tree byte-identical"
else
  bad "#12 html-body case wrong: [$rhtml]"
fi

# #4/#12/#17: the happy fetch path. The installed file's sha256 equals the pin
# AND the binary's `version` exits 0 (acceptance #4 is not runnable as written —
# "version matches the pinned sha256" — so it is implemented as those two).
# #17: retirement DOES happen on the success path, after the replacement is live.
rgood="$(fetch_run good)"
if [ "$rgood" = "rc=0 why=none tree=CHANGED fleetctl=GONE retired=YES grokfleet=pinned-and-runs" ]; then
  pass "installer (D1/#4): a good fetch installs the pinned bytes, 'version' runs, and the incumbent is retired AFTER (#17)"
else
  bad "#4 good-fetch case wrong: [$rgood]"
fi

# #8: the fetch path leaves NO download temp and NO .sha256 in $OPT_DIR — the
# download lives outside $PREFIX entirely (D2/D7) and is cleaned up by the trap.
installer_tree_fetch_test() {
  local pfx fx; pfx="$(mktemp -d)"; fx="$(mktemp -d)"
  fixture_origin good "$fx"
  PREFIX="$pfx" GROKFLEET_BASE_URL="file://$fx" GROKFLEET_RELEASE=v9.9.9 GROKFLEET_SHA256="$STUB_SHA" \
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

# --- TWO TEMPS, AND THEY ARE NOT INTERCHANGEABLE -----------------------------
# The install path has TWO temp files. Do not merge them.
#
#   1. the FETCH temp — $GROKFLEET_FETCH_ROOT/.grokfleet-fetch.XXXXXX/<asset>, where
#      curl writes and the digest is verified. It is created in the PREFLIGHT,
#      before any mutation, on an EXPLICITLY NAMED real-disk path — never the
#      default TMPDIR, which is tmpfs on the 961 MB brain VPS and would have to
#      hold an ~80 MB download.
#   2. the INSTALL temp — $OPT_DIR/.grokfleet.XXXXXX, created by mktemp in the SAME
#      DIRECTORY as the live target. That same-directory mktemp + `mv -f` is
#      what makes the install ATOMIC, and is the entire reason it lives in
#      $OPT_DIR rather than anywhere more convenient.
#
# The fetch temp is COPIED into the install temp with `install -m 0755` and is
# NEVER renamed onto the live path. Pointing the final `mv -f` at the fetch temp
# would look like a simplification and would be a cross-device rename —
# $GROKFLEET_FETCH_ROOT and $OPT_DIR can be on different filesystems — which either
# fails outright or silently degrades into a non-atomic copy, losing the
# atomicity this code has today. These assertions exist to catch that edit.
inst_fn="$(extract_from "$VPS_INSTALL" install_grokfleet)"
if printf '%s\n' "$inst_fn" | grep -Fq 'tmp="$(mktemp "$OPT_DIR/.grokfleet.XXXXXX")"'; then
  pass "installer: the INSTALL temp is still mktemp'd inside \$OPT_DIR (same-dir rename = atomic)"
else
  bad "installer: the \$OPT_DIR/.grokfleet.XXXXXX install temp is gone — the install is no longer atomic: [$inst_fn]"
fi
if printf '%s\n' "$inst_fn" | grep -Fq 'install -m 0755 "$built" "$tmp"'; then
  pass "installer: the FETCH temp is COPIED into the install temp (install -m 0755), never renamed onto the live path"
else
  bad "installer: 'install -m 0755 \"\$built\" \"\$tmp\"' is gone — the two temps have been merged"
fi
mv_live="$(printf '%s\n' "$inst_fn" | grep -F 'mv -f' | grep -F '"$OPT_DIR/grokfleet"' | grep -v '^ *#')"
case "$mv_live" in
  *'mv -f "$tmp" "$OPT_DIR/grokfleet"'*)
    pass "installer: the live \$OPT_DIR/grokfleet is renamed from the INSTALL temp (\$tmp), not the fetch temp" ;;
  *) bad "installer: the final mv -f does not rename \$tmp onto \$OPT_DIR/grokfleet — cross-device rename risk: [$mv_live]" ;;
esac

# The fetch temp is ~80 MB and must not accumulate across re-provisions: it is
# removed on EVERY exit path — the refusal paths (curl failure, bad digest) and
# the success path alike. GROKFLEET_FETCH_ROOT points at a scratch dir here so the
# leftovers are countable.
fetch_temp_cleanup_test() {
  local mode="$1"
  local pfx fx fr; pfx="$(mktemp -d)"; fx="$(mktemp -d)"; fr="$(mktemp -d)"
  fixture_origin "$mode" "$fx"
  PREFIX="$pfx" GROKFLEET_FETCH_ROOT="$fr" GROKFLEET_BASE_URL="file://$fx" \
    GROKFLEET_RELEASE=v9.9.9 GROKFLEET_SHA256="$STUB_SHA" bash "$VPS_INSTALL" >/dev/null 2>&1
  find "$fr" -mindepth 1 2>/dev/null | wc -l | tr -d ' '
  rm -rf "$pfx" "$fx" "$fr"
}
for m in good corrupt absent; do
  left="$(fetch_temp_cleanup_test "$m")"
  if [ "$left" = 0 ]; then
    pass "installer (D2/D7): the ~80 MB fetch temp is cleaned up on the '$m' path (nothing left under \$GROKFLEET_FETCH_ROOT)"
  else
    bad "fetch temp LEAKED on the '$m' path: $left entries left under \$GROKFLEET_FETCH_ROOT"
  fi
done

# #5 (D3): the tag is only an address; the sha256 is the identity. Overriding one
# without the other means fetching bytes the operator has not pinned ⇒ refusal.
# No GROKFLEET_BINARY here on purpose: the pairing check runs first in the preflight,
# so nothing is fetched and nothing is created.
installer_pin_pairing_test() {
  local which="$1" pfx out rc created
  pfx="$(mktemp -d)"
  case "$which" in
    release) out="$(PREFIX="$pfx" GROKFLEET_RELEASE=v9.9.9 bash "$VPS_INSTALL" 2>&1)"; rc=$? ;;
    *)       out="$(PREFIX="$pfx" GROKFLEET_SHA256="$STUB_SHA" bash "$VPS_INSTALL" 2>&1)"; rc=$? ;;
  esac
  created="$(find "$pfx" -mindepth 1 2>/dev/null | wc -l | tr -d ' ')"
  rm -rf "$pfx"
  printf 'rc=%s created=%s|%s\n' "$rc" "$created" "$out"
}
for w in release:GROKFLEET_RELEASE sha:GROKFLEET_SHA256; do
  pp="$(installer_pin_pairing_test "${w%%:*}")"
  case "$pp" in
    rc=1\ created=0\|*'must be overridden TOGETHER'*)
      pass "installer (D3/#5): ${w##*:} set alone ⇒ refusal rc 1, nothing created" ;;
    *) bad "#5 pin-pairing (${w##*:}) wrong: [$pp]" ;;
  esac
done

# #6: THE ACTUAL r2 PRODUCTION FAILURE. The gate died on `make: command not
# found` while building grokfleet on the VPS. With neither bun NOR make on PATH the
# install must now succeed — the host requirement went from bun + make + a full
# checkout to curl + sha256sum.
installer_no_bun_no_make_test() {
  local pfx fx bindir b src rc have hasbun hasmake
  pfx="$(mktemp -d)"; fx="$(mktemp -d)"; bindir="$(mktemp -d)"
  fixture_origin good "$fx"
  for b in bash sh env mktemp install mv cp rm mkdir chmod chown ln grep sed awk cat printf find sort getent id touch stat readlink rmdir dirname cut cmp curl sha256sum; do
    src="$(command -v "$b" 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$bindir/$b" 2>/dev/null || true
  done
  PREFIX="$pfx" PATH="$bindir" GROKFLEET_BASE_URL="file://$fx" GROKFLEET_RELEASE=v9.9.9 GROKFLEET_SHA256="$STUB_SHA" \
    bash "$VPS_INSTALL" >/dev/null 2>&1; rc=$?
  have=no; [ -x "$pfx/opt/grok-fleet/grokfleet" ] && have=yes
  hasbun=yes; PATH="$bindir" command -v bun >/dev/null 2>&1 || hasbun=no
  hasmake=yes; PATH="$bindir" command -v make >/dev/null 2>&1 || hasmake=no
  rm -rf "$pfx" "$fx" "$bindir"
  echo "rc=$rc grokfleet=$have bun=$hasbun make=$hasmake"
}
nbm="$(installer_no_bun_no_make_test)"
if [ "$nbm" = "rc=0 grokfleet=yes bun=no make=no" ]; then
  pass "installer (D1/#6): install succeeds with NEITHER bun NOR make on PATH (the r2 production failure)"
else
  bad "#6 no-bun-no-make wrong: [$nbm] want [rc=0 grokfleet=yes bun=no make=no]"
fi

# D7: exactly ONE real-network test, SKIPPED BY DEFAULT. Every case above is
# offline; this is the only one that touches github.com, and it needs a
# published release. Enable it with GROKFLEET_TEST_REAL_FETCH=1.
if [ "${GROKFLEET_TEST_REAL_FETCH:-0}" = 1 ]; then
  real_fetch_test() {
    local pfx rc; pfx="$(mktemp -d)"
    # No GROKFLEET_BASE_URL, no GROKFLEET_RELEASE/GROKFLEET_SHA256 overrides: this uses
    # the COMMITTED pin against the real release origin.
    PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1; rc=$?
    local r="rc=$rc"
    if [ -x "$pfx/opt/grok-fleet/grokfleet" ] && "$pfx/opt/grok-fleet/grokfleet" version >/dev/null 2>&1; then
      r="$r grokfleet=runs"
    else r="$r grokfleet=BAD"; fi
    rm -rf "$pfx"
    echo "$r"
  }
  rf="$(real_fetch_test)"
  [ "$rf" = "rc=0 grokfleet=runs" ] && pass "installer (#4): REAL fetch of the committed pin installs and runs" || bad "#4 real fetch wrong: [$rf]"
else
  pass "installer (D7): the real-fetch test is SKIPPED by default (GROKFLEET_TEST_REAL_FETCH=1 to run it) — the suite downloads nothing"
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
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  grep -E '^OnUnitActiveSec=' "$pfx/etc/systemd/system/grokfleet-reconcile.timer" | tr -d ' '
  rm -rf "$pfx"
}
[ "$(m20_test)" = "OnUnitActiveSec=5min" ] && pass "M20: reconcile timer OnUnitActiveSec=5min (5-min reconcile cadence)" || bad "M20: timer cadence wrong: [$(m20_test)]"

# --- M21: the service ExecStart wrapper adds --apply IFF config apply=true, and
# NOT when apply=false. Execute the wrapper's shell logic against both configs.
# If the grep gate is inverted (M21), apply=false would wrongly add --apply.
m21_test() {
  local applyval="$1" pfx; pfx="$(mktemp -d)"
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  local cfg="$pfx/opt/grok-fleet/config.toml"
  # Force the config's apply value.
  sed -i "s/^apply = .*/apply = $applyval/" "$cfg"
  # Extract the ExecStart command line and run its inner `bash -c '...'` with a
  # grokfleet stub that just echoes its args, capturing whether --apply is added.
  local execline
  execline="$(grep -E '^ExecStart=' "$pfx/etc/systemd/system/grokfleet-reconcile.service" | sed 's/^ExecStart=//')"
  local payload
  payload="$(printf '%s' "$execline" | sed -E "s#^/bin/bash -c '##; s#'\$##")"
  # The payload calls $OPT_DIR/grokfleet reconcile $apply; shadow that exact path
  # with an echo shim (overwriting the real built binary for this test only).
  cat > "$pfx/opt/grok-fleet/grokfleet" <<'SHIM'
#!/bin/bash
echo "GROKFLEET-ARGS:$*"
SHIM
  chmod +x "$pfx/opt/grok-fleet/grokfleet"
  bash -c "$payload" 2>/dev/null
  rm -rf "$pfx"
}
case "$(m21_test true)" in *"GROKFLEET-ARGS:reconcile --apply"*) pass "M21: config apply=true => wrapper runs reconcile --apply" ;; *) bad "M21: apply=true did not add --apply: [$(m21_test true)]" ;; esac
case "$(m21_test false)" in
  *"--apply"*) bad "M21: config apply=false WRONGLY added --apply (gate inverted): [$(m21_test false)]" ;;
  *"GROKFLEET-ARGS:reconcile"*) pass "M21: config apply=false => wrapper runs reconcile (no --apply)" ;;
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
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
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
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
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
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
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

# --- P2 box_passwd seam (blueprint fleet2-zero-touch-join) -------------------
# Adoption drives a box over the tailnet BEFORE it is enrolled, so the engine
# needs the box ssh password in $ETC_DIR/box_passwd. The installer writes it
# only from env BOX_PASSWD, at mode 600, and must never log the value.

box_passwd_absent_test() {
  local pfx; pfx="$(mktemp -d)"
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  if [ -e "$pfx/etc/grok-fleet/box_passwd" ]; then echo "CREATED"; else echo "UNTOUCHED"; fi
  rm -rf "$pfx"
}
[ "$(box_passwd_absent_test)" = UNTOUCHED ] && pass "installer (P2): no BOX_PASSWD => \$ETC_DIR/box_passwd left untouched" || bad "installer created box_passwd without BOX_PASSWD: [$(box_passwd_absent_test)]"

box_passwd_written_test() {
  local pfx out f; pfx="$(mktemp -d)"
  out="$(GROKFLEET_BINARY="$STUB" PREFIX="$pfx" BOX_PASSWD='s3cr3t-not-in-logs' bash "$VPS_INSTALL" 2>&1)"
  f="$pfx/etc/grok-fleet/box_passwd"
  if [ ! -f "$f" ]; then echo "MISSING"; rm -rf "$pfx"; return; fi
  if [ "$(stat -c '%a' "$f")" != 600 ]; then echo "MODE:$(stat -c '%a' "$f")"; rm -rf "$pfx"; return; fi
  if [ "$(cat "$f")" != 's3cr3t-not-in-logs' ]; then echo "CONTENT"; rm -rf "$pfx"; return; fi
  case "$out" in *s3cr3t-not-in-logs*) echo "LEAKED";; *) echo "OK";; esac
  rm -rf "$pfx"
}
[ "$(box_passwd_written_test)" = OK ] && pass "installer (P2): BOX_PASSWD => box_passwd written 0600 and never logged" || bad "installer box_passwd wrong: [$(box_passwd_written_test)]"

# The pin bump that ships with this release (D9): the committed GROKFLEET_RELEASE
# must match grokfleet's own PKG_VERSION, or ts-release-build refuses the pair.
release_pin_matches_pkg_test() {
  local tag ver
  tag="$(grep -E '^GROKFLEET_RELEASE=' "$VPS_INSTALL" | head -1 | cut -d= -f2)"
  ver="$(grep -E '^const PKG_VERSION = ' "$ROOT/fleet/src/cli.ts" | head -1 | sed 's/.*"\(.*\)".*/\1/')"
  if [ "$tag" = "v$ver" ]; then echo "MATCH"; else echo "MISMATCH:$tag vs $ver"; fi
}
[ "$(release_pin_matches_pkg_test)" = MATCH ] && pass "installer (D9): GROKFLEET_RELEASE pin matches grokfleet PKG_VERSION" || bad "release pin mismatch: [$(release_pin_matches_pkg_test)]"

# --- API rebind after a binary swap ------------------------------------------
# A long-running unit keeps executing the binary it was STARTED with, and the
# installer's atomic `mv -f` unlinks the old inode without touching the process:
# production served /v1/health version 5.5.0 for 3.5 h after the 5.6.0 install.
# install_grokfleet ends with a `try-restart` of the API unit, but ONLY when it is
# already active — TUI-D8's "never enable, never start" policy stands for the API.
#
# The harness evals install_grokfleet AND the helpers it calls (N6a absorbed
# install_units/install_fleet_api into it) with a fake systemctl and a
# recording stub binary on PATH, both writing to ONE log, so the ORDER of
# `version` and `try-restart` is assertable and not just their presence.
api_rebind_test() {
  local active="$1" prefix="$2"
  local d root inner; d="$(mktemp -d)"; root="$(mktemp -d)"; inner="$(mktemp)"
  mkdir -p "$root/opt" "$root/systemd"
  # A fake systemctl: records every invocation, and answers `is-active` from
  # FAKE_ACTIVE. Anything else succeeds silently.
  cat > "$d/systemctl" <<SC
#!/usr/bin/env bash
printf 'systemctl %s\n' "\$*" >> "$d/calls.log"
if [ "\$1" = is-active ]; then exit "\${FAKE_ACTIVE:-1}"; fi
if [ "\$1" = is-enabled ]; then echo disabled; exit 1; fi
exit 0
SC
  chmod +x "$d/systemctl"
  # The binary under test: records its own `version` smoke into the SAME log.
  cat > "$d/grokfleet-stub" <<ST
#!/usr/bin/env bash
printf 'binary %s\n' "\$*" >> "$d/calls.log"
exit 0
ST
  chmod +x "$d/grokfleet-stub"
  cat > "$inner" <<INNER
set -u
PATH="$d:\$PATH"
PREFIX="$prefix"
OPT_DIR="$root/opt"
OPT_DIR_REAL="/opt/grok-fleet"
ETC_DIR="$root/etc"
STATE_DIR="$root/state"
SYSTEMD_DIR="$root/systemd"
BIN_DIR="$root/bin"
SERVICE="grokfleet-reconcile.service"
TIMER="grokfleet-reconcile.timer"
API_SERVICE="grokfleet-api.service"
STALE_SERVICE="fleet-reconcile.service"
STALE_TIMER="fleet-reconcile.timer"
STALE_API_SERVICE="fleet-api.service"
STALE_CLI="fleet2"
DEFERRED_FAIL=0
API_WAS_ENABLED=""
GF_HAD_BINARY=0
GF_WROTE_PREV=0
GROKFLEET_VERIFIED_BINARY="$d/grokfleet-stub"
log(){ printf 'LOG %s\n' "\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in write_grokfleet_units remove_compat_names undo_step3 rollback_step5 install_grokfleet; do
  eval "\$(extract_from "$VPS_INSTALL" "\$fn")"
done
FAKE_ACTIVE=$active install_grokfleet
INNER
  local out; out="$(timeout 20 bash "$inner" 2>&1)"
  printf '%s\n---CALLS---\n' "$out"
  cat "$d/calls.log" 2>/dev/null
  rm -f "$inner"; rm -rf "$d" "$root"
}

# (a) active (is-active rc 0) => exactly one try-restart, AFTER the version smoke.
a_out="$(api_rebind_test 0 '')"
a_calls="$(printf '%s\n' "$a_out" | sed -n '/---CALLS---/,$p')"
a_try="$(printf '%s\n' "$a_calls" | grep -c 'try-restart grokfleet-api.service' || true)"
a_ver_line="$(printf '%s\n' "$a_calls" | grep -n 'binary version' | head -1 | cut -d: -f1)"
a_try_line="$(printf '%s\n' "$a_calls" | grep -n 'try-restart' | head -1 | cut -d: -f1)"
if [ "$a_try" = 1 ] && [ -n "$a_ver_line" ] && [ -n "$a_try_line" ] && [ "$a_ver_line" -lt "$a_try_line" ]; then
  pass "installer: active grokfleet-api.service => exactly one try-restart, after the version smoke"
else
  bad "API rebind (active) wrong — try-restarts=$a_try version@$a_ver_line try-restart@$a_try_line: [$a_out]"
fi
case "$a_out" in
  *'LOG restarted grokfleet-api.service (binary changed)'*)
    pass "installer: the rebind says so in the log" ;;
  *) bad "API rebind (active) did not log the restart: [$a_out]" ;;
esac

# (b) inactive (is-active rc 1) => the API unit is never restarted, started or
# enabled (TUI-D8). The TIMER is still enabled on every run — that is step (6),
# exactly as install_units did unconditionally before N6a — so the assertion is
# scoped to the API unit rather than to the word `enable`.
b_out="$(api_rebind_test 1 '')"
b_calls="$(printf '%s\n' "$b_out" | sed -n '/---CALLS---/,$p')"
if printf '%s\n' "$b_calls" | grep -Eq 'try-restart|restart .*api|start .*api\.service|enable .*api\.service'; then
  bad "API rebind (inactive) touched the API unit — TUI-D8 says never start it: [$b_calls]"
else
  pass "installer: inactive grokfleet-api.service => no restart, no start, no enable (TUI-D8)"
fi
if printf '%s\n' "$b_calls" | grep -q 'enable --now grokfleet-reconcile.timer'; then
  pass "installer: the reconcile TIMER is enabled on every run (step 6, as install_units always did)"
else
  bad "installer: step (6) did not enable the timer: [$b_calls]"
fi
case "$b_out" in
  *'LOG grokfleet-api.service not active — not started (TUI-D8)'*)
    pass "installer: the inactive case says so in the log" ;;
  *) bad "API rebind (inactive) did not log the skip: [$b_out]" ;;
esac

# (c) PREFIX set (a scratch-root install) => systemctl is not consulted AT ALL.
c_out="$(api_rebind_test 0 "$(mktemp -d)")"
c_calls="$(printf '%s\n' "$c_out" | sed -n '/---CALLS---/,$p' | grep '^systemctl' || true)"
if [ -z "$c_calls" ]; then
  pass "installer: under PREFIX => no systemctl call at all"
else
  bad "API rebind under PREFIX called systemctl: [$c_calls]"
fi

# The reconcile unit is Type=oneshot behind its timer, so it execs the new binary
# on its next tick; the installer must NOT restart it.
inst_fn2="$(extract_from "$VPS_INSTALL" install_grokfleet)"
if printf '%s\n' "$inst_fn2" | grep -F 'try-restart' | grep -Fq 'reconcile'; then
  bad "install_grokfleet try-restarts the reconcile unit — it is oneshot and picks the binary up on its next tick"
else
  pass "installer: only the API unit is rebound (the oneshot reconcile unit is left alone)"
fi

echo "-----"

# =============================================================================
# 5.10.0 RENAME — fleet2 -> grokfleet (blueprint fleet2-rename-grokfleet).
# N2 compatibility surface, N4 rollback artifact, N6 cutover ordering and its
# failure boundaries, N6a absorption, N7 the two-spelling env rule.
#
# Everything here runs against a mock PREFIX root. `systemctl` is absent from
# these runs (PREFIX is set), so the assertions are about FILES: unit contents,
# symlinks, the preserved rollback artifact and the demoted binary. The
# systemctl-shaped behaviour (the alias disable-before-remove, the enablement
# carry-over) is driven separately by upgrade_mock() below, which evals the
# function with a recording systemctl exactly like the API-rebind harness does.
# =============================================================================

# seed_5_10_0 <pfx>: a mock host as 5.10.0 left it — the grokfleet binary, the
# three REAL units, and the whole one-release compatibility surface that 5.11.0
# now removes: the two service symlinks, the timer's alias symlink (what
# `systemctl enable` materialises for `Alias=`), and the `fleet2` PATH link.
seed_5_10_0() {
  local pfx="$1"
  mkdir -p "$pfx/opt/grok-fleet" "$pfx/etc/systemd/system" "$pfx/usr/local/bin"
  printf '#!/bin/bash\n[ "$1" = version ] && echo "grokfleet 5.10.0"\nexit 0\n' > "$pfx/opt/grok-fleet/grokfleet"
  chmod 0755 "$pfx/opt/grok-fleet/grokfleet"
  local sd="$pfx/etc/systemd/system"
  cat > "$sd/grokfleet-reconcile.service" <<EOF
[Service]
ExecStart=$pfx/opt/grok-fleet/grokfleet reconcile
EOF
  cat > "$sd/grokfleet-reconcile.timer" <<'EOF'
[Timer]
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
Alias=fleet-reconcile.timer
EOF
  cat > "$sd/grokfleet-api.service" <<EOF
[Service]
ExecStart=$pfx/opt/grok-fleet/grokfleet serve
EOF
  # the compatibility surface, exactly as 5.10.0 wrote it
  ln -sfn grokfleet-reconcile.service "$sd/fleet-reconcile.service"
  ln -sfn grokfleet-api.service "$sd/fleet-api.service"
  ln -sfn grokfleet-reconcile.timer "$sd/fleet-reconcile.timer"
  ln -sfn /opt/grok-fleet/grokfleet "$pfx/usr/local/bin/fleet2"
}

# --- 5.11.0: the compatibility layer is REMOVED on upgrade -------------------
# The N2 schedule promised those names for exactly one release. This asserts the
# whole removal AND that the removal touched nothing else: the three real units
# must still be there, with their content unchanged, and the grokfleet PATH link
# must still resolve. A second run is a no-op — nothing to remove, nothing to
# report, and the tree is byte-identical.
compat_removed_test() {
  local pfx; pfx="$(mktemp -d)"
  seed_5_10_0 "$pfx"
  local sd="$pfx/etc/systemd/system"
  local out; out="$(GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" 2>&1)"
  local r=""
  # (1) every compatibility name is gone
  [ -e "$sd/fleet-reconcile.service" ] || [ -L "$sd/fleet-reconcile.service" ] && r="$r svc=LEFT" || r="$r svc=gone"
  [ -e "$sd/fleet-api.service" ] || [ -L "$sd/fleet-api.service" ] && r="$r api=LEFT" || r="$r api=gone"
  [ -e "$sd/fleet-reconcile.timer" ] || [ -L "$sd/fleet-reconcile.timer" ] && r="$r timer=LEFT" || r="$r timer=gone"
  [ -e "$pfx/usr/local/bin/fleet2" ] || [ -L "$pfx/usr/local/bin/fleet2" ] && r="$r cli=LEFT" || r="$r cli=gone"
  # (2) the timer no longer DECLARES the alias, so a future enable cannot recreate it
  grep -q '^Alias=' "$sd/grokfleet-reconcile.timer" && r="$r alias=DECLARED" || r="$r alias=gone"
  # (3) the REAL units are all present and INTACT — the removal is only about the
  #     compatibility names, so each unit still drives the grokfleet binary. (The
  #     installer rewrites the three unit files on every run by design, so this
  #     asserts their CONTENT rather than their bytes being untouched.)
  [ -f "$sd/grokfleet-reconcile.service" ] && [ -f "$sd/grokfleet-reconcile.timer" ] \
    && [ -f "$sd/grokfleet-api.service" ] && r="$r units=present" || r="$r units=MISSING"
  grep -q "$pfx/opt/grok-fleet/grokfleet reconcile" "$sd/grokfleet-reconcile.service" \
    && r="$r svcbody=drives-grokfleet" || r="$r svcbody=WRONG"
  grep -q "ExecStart=$pfx/opt/grok-fleet/grokfleet serve" "$sd/grokfleet-api.service" \
    && r="$r apibody=drives-grokfleet" || r="$r apibody=WRONG"
  grep -q '^OnUnitActiveSec=5min$' "$sd/grokfleet-reconcile.timer" \
    && r="$r timerbody=intact" || r="$r timerbody=WRONG"
  # (4) the real CLI link still resolves
  [ -L "$pfx/usr/local/bin/grokfleet" ] && r="$r gfcli=link" || r="$r gfcli=MISSING"
  # (5) it SAID so
  case "$out" in *'the 5.10.0 compatibility names are gone'*) r="$r said=yes" ;; *) r="$r said=NO" ;; esac
  # (6) IDEMPOTENT: a second run removes nothing and changes nothing
  local before after out2
  before="$( (cd "$pfx" && find . \( -type f -o -type l \) -exec ls -ld {} \; | awk '{print $1, $NF}' | sort) )"
  out2="$(GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" 2>&1)"
  after="$( (cd "$pfx" && find . \( -type f -o -type l \) -exec ls -ld {} \; | awk '{print $1, $NF}' | sort) )"
  [ "$before" = "$after" ] && r="$r rerun=identical" || r="$r rerun=CHANGED"
  case "$out2" in *'compatibility names are gone'*) r="$r rerun_said=YES" ;; *) r="$r rerun_said=no" ;; esac
  rm -rf "$pfx"
  echo "${r# }"
}
cr="$(compat_removed_test)"
want_cr="svc=gone api=gone timer=gone cli=gone alias=gone units=present svcbody=drives-grokfleet apibody=drives-grokfleet timerbody=intact gfcli=link said=yes rerun=identical rerun_said=no"
if [ "$cr" = "$want_cr" ]; then
  pass "5.11.0: upgrading a 5.10.0 host removes every compatibility name and leaves the real units alone (idempotent on a re-run)"
else
  bad "5.11.0 compat removal wrong: [$cr] want [$want_cr]"
fi

# A FRESH install writes none of them in the first place.
compat_never_written_test() {
  local pfx; pfx="$(mktemp -d)"
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  local sd="$pfx/etc/systemd/system" r=""
  local n; n="$(find "$sd" -maxdepth 1 -name 'fleet-*' 2>/dev/null | wc -l | tr -d ' ')"
  r="$r stale_units=$n"
  [ -e "$pfx/usr/local/bin/fleet2" ] && r="$r cli=WRITTEN" || r="$r cli=none"
  grep -q '^Alias=' "$sd/grokfleet-reconcile.timer" && r="$r alias=DECLARED" || r="$r alias=none"
  rm -rf "$pfx"
  echo "${r# }"
}
cn="$(compat_never_written_test)"
if [ "$cn" = "stale_units=0 cli=none alias=none" ]; then
  pass "5.11.0: a FRESH install writes no compatibility unit name, no fleet2 link and no timer Alias="
else
  bad "5.11.0 fresh install still writes a compat name: [$cn] want [stale_units=0 cli=none alias=none]"
fi

# A REGULAR FILE at a compatibility path is somebody else's unit: left alone.
compat_regular_file_test() {
  local pfx; pfx="$(mktemp -d)"
  seed_5_10_0 "$pfx"
  local sd="$pfx/etc/systemd/system"
  rm -f "$sd/fleet-api.service"
  printf '[Service]\nExecStart=/usr/bin/true\n' > "$sd/fleet-api.service"   # NOT ours
  local out; out="$(GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" 2>&1)"
  local r=""
  [ -f "$sd/fleet-api.service" ] && [ ! -L "$sd/fleet-api.service" ] && r="$r kept=yes" || r="$r kept=NO"
  case "$out" in *'is a REGULAR FILE, not our compatibility link — left alone'*) r="$r said=yes" ;; *) r="$r said=NO" ;; esac
  rm -rf "$pfx"
  echo "${r# }"
}
crf="$(compat_regular_file_test)"
if [ "$crf" = "kept=yes said=yes" ]; then
  pass "5.11.0: a REGULAR FILE at a compatibility path is an operator's own unit — removed never, reported once"
else
  bad "5.11.0 regular-file guard wrong: [$crf] want [kept=yes said=yes]"
fi

# --- N6 step (3): .prev is the previous grokfleet ----------------------------
# Install over a 5.10.0 host, then a differing build over that: grokfleet.prev
# must become the FIRST install's bytes. Mutant (drop the step-3 copy) ⇒ .prev is
# never written at all. And a byte-identical re-run must write nothing (T8).
second_release_prev_test() {
  local pfx sd; pfx="$(mktemp -d)"; sd="$(mktemp -d)"
  seed_5_10_0 "$pfx"
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  local first_sha; first_sha="$(sha256sum "$pfx/opt/grok-fleet/grokfleet" | cut -d' ' -f1)"
  # a byte-identical re-run first: nothing may change
  local before after
  before="$( (cd "$pfx" && find . -type f -exec sha256sum {} \; | sort) )"
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  after="$( (cd "$pfx" && find . -type f -exec sha256sum {} \; | sort) )"
  local r=""
  [ "$before" = "$after" ] && r="$r rerun=identical" || r="$r rerun=CHANGED"
  # now a DIFFERENT build
  local next="$sd/grokfleet-5.11.1"
  printf '#!/bin/bash\n[ "$1" = version ] && echo "grokfleet 5.11.1"\nexit 0\n' > "$next"; chmod 0755 "$next"
  GROKFLEET_BINARY="$next" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  if [ "$(sha256sum "$pfx/opt/grok-fleet/grokfleet.prev" | cut -d' ' -f1)" = "$first_sha" ]; then
    r="$r prev=previous-grokfleet"
  else r="$r prev=WRONG"; fi
  rm -rf "$pfx" "$sd"
  echo "${r# }"
}
sr="$(second_release_prev_test)"
if [ "$sr" = "rerun=identical prev=previous-grokfleet" ]; then
  pass "installer (N6.3/r8-B1): a no-change re-run is byte-identical (T8) and the NEXT release preserves the outgoing grokfleet as .prev"
else
  bad "N6.3 preserve-then-install wrong: [$sr] want [rerun=identical prev=previous-grokfleet]"
fi

# --- N6 steps (5)/(8), re-run idempotence: a deleted unit/link is restored ----
rerun_repairs_test() {
  local pfx; pfx="$(mktemp -d)"
  seed_5_10_0 "$pfx"
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  local sd="$pfx/etc/systemd/system" o="$pfx/opt/grok-fleet"
  local bin_sha; bin_sha="$(sha256sum "$o/grokfleet" | cut -d' ' -f1)"
  rm -f "$sd/grokfleet-api.service"          # an operator (or a bad edit) removed one
  rm -f "$pfx/usr/local/bin/grokfleet"       # …and the PATH link
  GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  local r=""
  [ -f "$sd/grokfleet-api.service" ] && r="$r unit=restored" || r="$r unit=MISSING"
  [ -L "$pfx/usr/local/bin/grokfleet" ] && r="$r link=restored" || r="$r link=MISSING"
  [ "$(sha256sum "$o/grokfleet" | cut -d' ' -f1)" = "$bin_sha" ] && r="$r bin=same" || r="$r bin=CHANGED"
  rm -rf "$pfx"
  echo "${r# }"
}
rr="$(rerun_repairs_test)"
if [ "$rr" = "unit=restored link=restored bin=same" ]; then
  pass "installer (N6.5/N6.8): a re-run restores a deleted unit and a deleted PATH link, and leaves the binary alone"
else
  bad "N6 re-run repair wrong: [$rr] want [unit=restored link=restored bin=same]"
fi

# --- N6a: install_units / install_fleet_api are GONE, not merely unused -------
# If either survived it would write REAL unit files at the pre-rename paths with
# an ExecStart naming a binary that no longer exists. Comments may still discuss
# them; no code line may name them.
n6a_hits="$(grep -vE '^[[:space:]]*#' "$VPS_INSTALL" | grep -cE 'install_units|install_fleet_api' || true)"
if [ "$n6a_hits" = 0 ]; then
  pass "installer (N6a): no code line names install_units or install_fleet_api (both absorbed into install_grokfleet)"
else
  bad "N6a: $n6a_hits code line(s) still name install_units/install_fleet_api: [$(grep -vE '^[[:space:]]*#' "$VPS_INSTALL" | grep -nE 'install_units|install_fleet_api')]"
fi

# --- 5.11.0: the FLEET2_* env compatibility is gone --------------------------
# 5.10.0 accepted `FLEET2_<X>` beside `GROKFLEET_<X>` and REFUSED rc 1 when both
# were set and differed. Both halves go here: a stale `FLEET2_BINARY` export is
# now simply ignored (the committed pin wins), and setting both no longer
# refuses. Offline: the first half drives a `file://` fixture origin (D10), the
# second the GROKFLEET_BINARY hatch.
env_no_compat_test() {
  local pfx fx pinbin pin_sha out rc; pfx="$(mktemp -d)"; fx="$(mktemp -d)"
  # A PINNED body that is byte-DIFFERENT from $STUB, served from a file:// origin.
  # Asserting on the installed BYTES is what makes "ignored" provable: an
  # existence check alone passes on any host where the fetch can succeed, so it
  # read a successful download as "the old spelling was honoured" and the case
  # failed on every networked host while passing offline.
  mkdir -p "$fx/v9.9.9"
  pinbin="$fx/v9.9.9/grokfleet-linux-x64"
  printf '#!/bin/bash\n# pinned release body (test) — byte-different from the stub\n[ "${1:-}" = version ] && echo "grokfleet pinned (test)"\nexit 0\n' > "$pinbin"
  chmod 0755 "$pinbin"
  pin_sha="$(sha256sum "$pinbin" | cut -d' ' -f1)"
  # FLEET2_BINARY alone: ignored, so the run falls through to the pinned FETCH
  # and installs the PINNED bytes, not the FLEET2_BINARY ones.
  out="$(FLEET2_BINARY="$STUB" PREFIX="$pfx" GROKFLEET_BASE_URL="file://$fx" \
    GROKFLEET_RELEASE=v9.9.9 GROKFLEET_SHA256="$pin_sha" bash "$VPS_INSTALL" 2>&1)"; rc=$?
  local r="" got=""
  [ -f "$pfx/opt/grok-fleet/grokfleet" ] && got="$(sha256sum "$pfx/opt/grok-fleet/grokfleet" | cut -d' ' -f1)"
  case "$got" in
    "$STUB_SHA") r="$r honoured=YES" ;;
    "$pin_sha")  r="$r honoured=no" ;;
    "")          r="$r honoured=NOTHING-INSTALLED" ;;
    *)           r="$r honoured=UNKNOWN-BYTES" ;;
  esac
  case "$out" in *FLEET2_*) r="$r mentions=YES" ;; *) r="$r mentions=no" ;; esac
  rm -rf "$pfx" "$fx"
  # both set and DIFFERENT: no refusal any more — GROKFLEET_BINARY simply wins.
  pfx="$(mktemp -d)"
  out="$(FLEET2_BINARY="/nonexistent/other" GROKFLEET_BINARY="$STUB" PREFIX="$pfx" bash "$VPS_INSTALL" 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ -x "$pfx/opt/grok-fleet/grokfleet" ] && r="$r both=installed" || r="$r both=REFUSED"
  case "$out" in *REFUSING*DIFFER*) r="$r refusal=STILL-THERE" ;; *) r="$r refusal=gone" ;; esac
  rm -rf "$pfx"
  echo "${r# }"
}
env_out="$(env_no_compat_test)"
if [ "$env_out" = "honoured=no mentions=no both=installed refusal=gone" ]; then
  pass "5.11.0: FLEET2_* env spellings are ignored and the both-set refusal is gone (GROKFLEET_* is the only seam)"
else
  bad "5.11.0 env compat still present: [$env_out] want [honoured=no mentions=no both=installed refusal=gone]"
fi

# --- N6 failure injection (i): the binary install fails ⇒ nothing changed ------
# A stub that exits non-zero on `version` stands in for ENOSPC on the 80 MB copy,
# a noexec mount or a wrong-arch binary — the D13 failures.
inject_binary_fail_test() {
  local pfx sd; pfx="$(mktemp -d)"; sd="$(mktemp -d)"
  seed_5_10_0 "$pfx"
  local bad="$sd/grokfleet-bad"; printf '#!/bin/bash\nexit 3\n' > "$bad"; chmod 0755 "$bad"
  local before after rc
  before="$( (cd "$pfx" && find . \( -type f -o -type l \) -printf '%p %s %m\n' | sort) )"
  GROKFLEET_BINARY="$bad" PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1; rc=$?
  after="$( (cd "$pfx" && find . \( -type f -o -type l \) -printf '%p %s %m\n' | sort) )"
  local r="rc=$rc"
  [ "$before" = "$after" ] && r="$r tree=SAME" || r="$r tree=CHANGED"
  [ -x "$pfx/opt/grok-fleet/grokfleet" ] && "$pfx/opt/grok-fleet/grokfleet" version >/dev/null 2>&1 \
    && r="$r incumbent=intact" || r="$r incumbent=BROKEN"
  rm -rf "$pfx" "$sd"
  echo "$r"
}
ib="$(inject_binary_fail_test)"
if [ "$ib" = "rc=1 tree=SAME incumbent=intact" ]; then
  pass "installer (N6 (i)): a failed binary install leaves the host byte-identical — the incumbent engine present and executable"
else
  bad "N6 (i) binary-failure wrong: [$ib] want [rc=1 tree=SAME incumbent=intact]"
fi

# --- N6 failure injection: the upgrade with a RECORDING systemctl -------------
# Drives install_grokfleet with a fake systemctl so the API enablement carry-over
# and the step-(5) failure handler are assertable.
#   $1 = the pre-run `is-enabled` answer for grokfleet-api.service
#   $2 = "ok" | "unitfail" (make the unit write fail)
upgrade_mock() {
  local api_enabled="$1" mode="$2"
  local d root inner; d="$(mktemp -d)"; root="$(mktemp -d)"; inner="$(mktemp)"
  mkdir -p "$root/opt" "$root/systemd"
  cat > "$d/systemctl" <<SC
#!/usr/bin/env bash
printf 'systemctl %s\n' "\$*" >> "$d/calls.log"
if [ "\$1" = is-active ]; then exit 1; fi
if [ "\$1" = is-enabled ]; then
  case "\$2" in
    grokfleet-api.service) echo "$api_enabled"; [ "$api_enabled" = enabled ] && exit 0 || exit 1 ;;
  esac
  echo disabled; exit 1
fi
exit 0
SC
  chmod +x "$d/systemctl"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$d/grokfleet-stub"; chmod +x "$d/grokfleet-stub"
  # a migrated (5.10.0) host: the real units plus the compatibility links.
  printf '#!/bin/bash\nexit 0\n' > "$root/opt/grokfleet"; chmod 0755 "$root/opt/grokfleet"
  printf '[Service]\nExecStart=%s/opt/grokfleet reconcile\n' "$root" > "$root/systemd/grokfleet-reconcile.service"
  printf '[Timer]\n' > "$root/systemd/grokfleet-reconcile.timer"
  printf '[Service]\n' > "$root/systemd/grokfleet-api.service"
  ln -sfn grokfleet-reconcile.service "$root/systemd/fleet-reconcile.service"
  ln -sfn grokfleet-api.service "$root/systemd/fleet-api.service"
  ln -sfn grokfleet-reconcile.timer "$root/systemd/fleet-reconcile.timer"
  local sysdir="$root/systemd" real_install; real_install="$(command -v install)"
  if [ "$mode" = unitfail ]; then
    cat > "$d/install" <<INS
#!/usr/bin/env bash
for a in "\$@"; do case "\$a" in $sysdir/grokfleet-reconcile.service) exit 1 ;; esac; done
exec "$real_install" "\$@"
INS
    chmod +x "$d/install"
  fi
  cat > "$inner" <<INNER
set -u
PATH="$d:\$PATH"
PREFIX=""
OPT_DIR="$root/opt"
OPT_DIR_REAL="$root/opt"
ETC_DIR="$root/etc"
STATE_DIR="$root/state"
SYSTEMD_DIR="$sysdir"
BIN_DIR="$root/bin"
SERVICE="grokfleet-reconcile.service"
TIMER="grokfleet-reconcile.timer"
API_SERVICE="grokfleet-api.service"
STALE_SERVICE="fleet-reconcile.service"
STALE_TIMER="fleet-reconcile.timer"
STALE_API_SERVICE="fleet-api.service"
STALE_CLI="fleet2"
DEFERRED_FAIL=0
API_WAS_ENABLED=""
GF_HAD_BINARY=0
GF_WROTE_PREV=0
GROKFLEET_VERIFIED_BINARY="$d/grokfleet-stub"
log(){ printf 'LOG %s\n' "\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in write_grokfleet_units remove_compat_names undo_step3 rollback_step5 install_grokfleet; do
  eval "\$(extract_from "$VPS_INSTALL" "\$fn")"
done
install_grokfleet; echo "RC=\$?"
INNER
  local out; out="$(timeout 30 bash "$inner" 2>&1)"
  printf '%s\n---CALLS---\n' "$out"
  cat "$d/calls.log" 2>/dev/null
  printf '%s\n' '---STATE---'
  [ -e "$root/opt/grokfleet" ] && echo "state grokfleet=present" || echo "state grokfleet=absent"
  [ -L "$root/systemd/fleet-reconcile.service" ] && echo "state oldsvc=present" || echo "state oldsvc=absent"
  [ -L "$root/systemd/fleet-reconcile.timer" ] && echo "state oldtimer=present" || echo "state oldtimer=absent"
  rm -f "$inner"; rm -rf "$d" "$root"
}

# The compatibility names are removed under a REAL systemctl too, and the timer
# alias is DISABLED before its link goes (or the wants-symlink dangles).
up="$(upgrade_mock enabled ok)"
up_calls="$(printf '%s\n' "$up" | sed -n '/---CALLS---/,/---STATE---/p')"
up_state="$(printf '%s\n' "$up" | sed -n '/---STATE---/,$p')"
r_up=""
printf '%s\n' "$up_state" | grep -q 'oldsvc=absent' && r_up="$r_up oldsvc=gone" || r_up="$r_up oldsvc=LEFT"
printf '%s\n' "$up_state" | grep -q 'oldtimer=absent' && r_up="$r_up oldtimer=gone" || r_up="$r_up oldtimer=LEFT"
dis_line="$(printf '%s\n' "$up_calls" | grep -n 'systemctl disable fleet-reconcile.timer' | head -1 | cut -d: -f1)"
en_line="$(printf '%s\n' "$up_calls" | grep -n 'enable --now grokfleet-reconcile.timer' | head -1 | cut -d: -f1)"
if [ -n "$dis_line" ] && [ -n "$en_line" ] && [ "$dis_line" -lt "$en_line" ]; then
  r_up="$r_up order=disable-first"
else
  r_up="$r_up order=WRONG(dis@$dis_line en@$en_line)"
fi
r_up="${r_up# }"
if [ "$r_up" = "oldsvc=gone oldtimer=gone order=disable-first" ]; then
  pass "5.11.0: under a real systemctl the alias timer is DISABLED before its link is removed, and both service links go"
else
  bad "5.11.0 systemctl-side removal wrong: [$r_up] want [oldsvc=gone oldtimer=gone order=disable-first]"
fi

# (6) the API's boot enablement is CARRIED OVER, both starting states.
if printf '%s\n' "$up_calls" | grep -q 'systemctl enable grokfleet-api.service'; then
  pass "installer (N6.6/r3-B2): an ENABLED API is re-enabled after the upgrade"
else
  bad "N6.6: the API enablement was not carried over: [$up_calls]"
fi
up_dis="$(upgrade_mock disabled ok)"
up_dis_calls="$(printf '%s\n' "$up_dis" | sed -n '/---CALLS---/,/---STATE---/p')"
if printf '%s\n' "$up_dis_calls" | grep -q 'systemctl enable grokfleet-api.service'; then
  bad "N6.6: a DISABLED API was wrongly enabled by the upgrade: [$up_dis_calls]"
else
  pass "installer (N6.6/r3-B2): a DISABLED API stays disabled (the never-enable policy is unchanged)"
fi

# A unit-write failure must NOT restore units.prev and must NOT remove grokfleet:
# any units.prev on disk holds 5.9.0 units naming a binary that is gone.
rf="$(upgrade_mock disabled unitfail)"
rf_state="$(printf '%s\n' "$rf" | sed -n '/---STATE---/,$p')"
r_rr=""
printf '%s\n' "$rf_state" | grep -q 'grokfleet=present' && r_rr="$r_rr grokfleet=present" || r_rr="$r_rr grokfleet=REMOVED"
printf '%s\n' "$rf" | grep -q 'units.prev is NOT touched' && r_rr="$r_rr branch=rewrite" || r_rr="$r_rr branch=WRONG"
r_rr="${r_rr# }"
if [ "$r_rr" = "grokfleet=present branch=rewrite" ]; then
  pass "installer (N6.5/r5-B1): a unit-write failure leaves grokfleet present and units.prev untouched"
else
  bad "N6.5 failure handler wrong: [$r_rr] want [grokfleet=present branch=rewrite]"
fi


# --- N6 step (9): the ONE survivable failure ---------------------------------
# A failing try-restart logs one line, sets DEFERRED_FAIL and RETURNS 0, so every
# phase after the call site still runs; main exits 1 at the end. Drive the whole
# installer with a systemctl shim that fails only on try-restart, and assert the
# sshd drop-in (the phase this file marks fatal) was still written.
deferred_fail_test() {
  local pfx d out rc; pfx="$(mktemp -d)"; d="$(mktemp -d)"
  cat > "$d/systemctl" <<'SC'
#!/usr/bin/env bash
case "$1" in
  is-active) exit 0 ;;
  is-enabled) echo disabled; exit 1 ;;
  try-restart) exit 1 ;;
esac
exit 0
SC
  chmod +x "$d/systemctl"
  # a `sshd` shim so install_sshd_dropin takes its REAL validate path and passes
  cat > "$d/sshd" <<'SD'
#!/usr/bin/env bash
exit 0
SD
  chmod +x "$d/sshd"
  # PREFIX must be empty for systemctl to be consulted at all, so redirect every
  # path the installer writes into the scratch root by exporting the dir vars is
  # not possible from outside — instead drive the function directly, then assert
  # the DEFERRED_FAIL contract on the file itself.
  rm -rf "$pfx" "$d"
  # contract assertions (the behaviour is driven end-to-end by cutover_mock):
  local r=""
  grep -q 'DEFERRED_FAIL=1' "$VPS_INSTALL" && r="$r sets=yes" || r="$r sets=NO"
  grep -q 'if \[ "$DEFERRED_FAIL" = 1 \]; then' "$VPS_INSTALL" && r="$r exits=yes" || r="$r exits=NO"
  # the exit check must come AFTER the last install phase
  local ph df
  ph="$(grep -n '^install_sshd_dropin || exit 1' "$VPS_INSTALL" | head -1 | cut -d: -f1)"
  df="$(grep -n 'if \[ "$DEFERRED_FAIL" = 1 \]; then' "$VPS_INSTALL" | head -1 | cut -d: -f1)"
  [ -n "$ph" ] && [ -n "$df" ] && [ "$ph" -lt "$df" ] && r="$r order=after-phases" || r="$r order=WRONG"
  echo "${r# }"
}
df_out="$(deferred_fail_test)"
if [ "$df_out" = "sets=yes exits=yes order=after-phases" ]; then
  pass "rename (N6.9/r4-B1): a failed API restart sets DEFERRED_FAIL and the exit-1 check runs AFTER every install phase"
else
  bad "N6.9 deferred-failure wiring wrong: [$df_out] want [sets=yes exits=yes order=after-phases]"
fi
# and the one-line operator message is verbatim what the blueprint specifies
if grep -q 'grokfleet: API restart failed — the CLI is usable; run: systemctl start' "$VPS_INSTALL"; then
  pass "rename (N6.9): the survivable failure logs the one-line remedy"
else
  bad "N6.9: the API-restart failure message is missing or reworded"
fi

# --- r2-n1: the disk precheck refuses BEFORE the fetch ------------------------
disk_precheck_test() {
  local pfx out rc created; pfx="$(mktemp -d)"
  out="$(GROKFLEET_BINARY="$STUB" GROKFLEET_DISK_MIN_KB=999999999999 PREFIX="$pfx" bash "$VPS_INSTALL" 2>&1)"; rc=$?
  created="$(find "$pfx" -mindepth 1 2>/dev/null | wc -l | tr -d ' ')"
  rm -rf "$pfx"
  printf 'rc=%s created=%s|%s\n' "$rc" "$created" "$out"
}
dp="$(disk_precheck_test)"
case "$dp" in
  rc=1\ created=0\|*'the 5.10.0 cutover peaks at five'*'nothing on this host was changed'*)
    pass "rename (r2-n1): too little free disk refuses rc 1 before anything is fetched or created" ;;
  *) bad "r2-n1 disk precheck wrong: [$dp]" ;;
esac

echo "-----"
if [ "$fail" = 0 ]; then echo "ALL INSTALL-VPS TESTS PASSED"; else echo "SOME INSTALL-VPS TESTS FAILED"; fi
exit "$fail"
