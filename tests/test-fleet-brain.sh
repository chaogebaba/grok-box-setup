#!/bin/bash
# test-fleet-brain.sh — local, box-free, VPS-free coverage for PHASE 1 of the
# FLEET-BRAIN work (docs/FLEET-BRAIN.md). No real tailscale/box/VPS/API needed:
# ssh/curl are stubbed and the API is a fixture. Run from anywhere:
#   bash tests/test-fleet-brain.sh   (or: make test)
# Exit 0 = all pass, 1 = a failure.
#
# What this covers:
#   enroll   the authorized_keys line SHAPE (restrict,port-forwarding,
#            permitlisten="127.0.0.1:2000N" <pubkey>); ACL precheck refuses when
#            tag:fleet-brain has no tagOwners.
#   reconcile the PURE decision table over fixture device lists — each row a–e,
#            read-only on API failure, never-delete-when-both-online, rename-
#            after-delete (reconcile_dedup order).
#   mint     the key-create payload shape (reusable/ephemeral/preauthorized/tags/
#            expirySeconds) + atomic seed (sha mismatch => old key intact).
#   tunnel   supervision in the tick: unconfigured => silent no-op (no spawn),
#            respawn ssh -N argv shape, status field tunnel=up|down|unconfigured.
#   installer vps/install-vps.sh idempotency (run twice => identical tree) and
#            --uninstall (removes exactly what it installed), against a fake root.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
BOXUP="$ROOT/boxup"
FLEETCTL="$ROOT/fleetctl"
VPS_INSTALL="$ROOT/vps/install-vps.sh"
fail=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; fail=1; }

for f in "$BOXUP" "$FLEETCTL" "$VPS_INSTALL"; do
  [ -f "$f" ] || { echo "cannot find $f"; exit 1; }
done

# extract_fn: print a `name() { ... }` definition (col-0 to col-0 }) from a file.
extract_from() {
  awk -v fn="$2" '
    $0 ~ "^"fn"\\(\\) \\{" {inside=1}
    inside {print}
    inside && /^\}$/ {exit}
  ' "$1"
}
bx() { extract_from "$BOXUP" "$1"; }
fc() { extract_from "$FLEETCTL" "$1"; }

# =============================================================================
# ENROLL — authorized_keys line shape + ACL precheck
# =============================================================================
enroll_line_test() {
  local port="$1" pubkey="$2" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" authorized_keys_line)"
authorized_keys_line "$port" "$pubkey"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
line="$(enroll_line_test 20008 'ssh-ed25519 AAAAC3xyz grok-tunnel-grok-box-8')"
case "$line" in
  'restrict,port-forwarding,permitlisten="127.0.0.1:20008" ssh-ed25519 AAAAC3xyz grok-tunnel-grok-box-8')
    pass "enroll authorized_keys line: restrict,port-forwarding,permitlisten pinned to 127.0.0.1:20008" ;;
  *) bad "enroll authorized_keys line WRONG: [$line]" ;;
esac
# The line must NOT permit anything but forwarding to the box's own port.
case "$line" in
  *'permitlisten="127.0.0.1:20008"'*) : ;;
  *) bad "enroll line missing permitlisten pin" ;;
esac
case "$line" in
  restrict,port-forwarding,*) pass "enroll line starts restrict,port-forwarding (allow-list-by-default)" ;;
  *) bad "enroll line does not start with restrict,port-forwarding: [$line]" ;;
esac

# port_for / box_index derivation.
portfor_test() {
  local n="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" box_index_from_name)"
eval "\$(extract_from "\$FLEETCTL" port_for)"
port_for "$n"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(portfor_test grok-box-1)" = 20001 ] && pass "port_for grok-box-1 => 20001" || bad "port_for grok-box-1 => [$(portfor_test grok-box-1)]"
[ "$(portfor_test 8)" = 20008 ] && pass "port_for 8 => 20008" || bad "port_for 8 => [$(portfor_test 8)]"

# =============================================================================
# box-naming-3digit D1/D9 — canonical name<->index helpers + the OCTAL fix (F1)
# =============================================================================
# Run a helper from EITHER file (verifies both wire the same helper). Prints
# "<stdout>|rc=<rc>".
helper_call() {
  local file="$1" fn="$2"; shift 2
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
SRC="$file"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$SRC" box_index_from_name)"
eval "\$(extract_from "\$SRC" box_name_from_index)"
out="\$($fn $*)"; rc=\$?
printf '%s|rc=%s' "\$out" "\$rc"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}

# box_index_from_name: DECIMAL via 10# (008->8, 009->9, 011->11, 1->1); reject
# an out-of-range or non-numeric suffix.
[ "$(helper_call "$FLEETCTL" box_index_from_name grok-box-008)" = "8|rc=0" ]  && pass "D1: box_index_from_name grok-box-008 => 8 (decimal, not octal)" || bad "D1 idx 008: [$(helper_call "$FLEETCTL" box_index_from_name grok-box-008)]"
[ "$(helper_call "$FLEETCTL" box_index_from_name grok-box-009)" = "9|rc=0" ]  && pass "D1: box_index_from_name grok-box-009 => 9 (decimal, not octal)" || bad "D1 idx 009: [$(helper_call "$FLEETCTL" box_index_from_name grok-box-009)]"
[ "$(helper_call "$FLEETCTL" box_index_from_name grok-box-011)" = "11|rc=0" ] && pass "D1: box_index_from_name grok-box-011 => 11" || bad "D1 idx 011: [$(helper_call "$FLEETCTL" box_index_from_name grok-box-011)]"
[ "$(helper_call "$FLEETCTL" box_index_from_name grok-box-1)" = "1|rc=0" ]    && pass "D1: box_index_from_name grok-box-1 => 1 (legacy still recognised)" || bad "D1 idx 1: [$(helper_call "$FLEETCTL" box_index_from_name grok-box-1)]"
case "$(helper_call "$FLEETCTL" box_index_from_name grok-box-1000)" in *"rc=1"*) pass "D1: box_index_from_name grok-box-1000 => rc 1 (>3 digits rejected)" ;; *) bad "D1 reject 1000: [$(helper_call "$FLEETCTL" box_index_from_name grok-box-1000)]" ;; esac
case "$(helper_call "$FLEETCTL" box_index_from_name grok-box-x)" in *"rc=1"*) pass "D1: box_index_from_name grok-box-x => rc 1 (non-numeric rejected)" ;; *) bad "D1 reject x: [$(helper_call "$FLEETCTL" box_index_from_name grok-box-x)]" ;; esac

# box_name_from_index: pads to three digits.
[ "$(helper_call "$FLEETCTL" box_name_from_index 8)" = "grok-box-008|rc=0" ]  && pass "D1: box_name_from_index 8 => grok-box-008" || bad "D1 name 8: [$(helper_call "$FLEETCTL" box_name_from_index 8)]"
[ "$(helper_call "$FLEETCTL" box_name_from_index 11)" = "grok-box-011|rc=0" ] && pass "D1: box_name_from_index 11 => grok-box-011" || bad "D1 name 11: [$(helper_call "$FLEETCTL" box_name_from_index 11)]"

# F1 OCTAL FIX: port_for over the padded 8/9/10/11 must be 20008..20011 (the old
# raw-suffix arithmetic errored on 008/009 and mis-added 010/011 as octal).
for i in 8 9 10 11; do
  want=$((20000 + i)); padded="$(printf 'grok-box-%03d' "$i")"
  got="$(portfor_test "$padded")"
  [ "$got" = "$want" ] && pass "F1 octal fix: port_for $padded => $want" || bad "F1 octal fix: port_for $padded => [$got] (want $want)"
done

# The two helpers are BYTE-IDENTICAL in boxup and fleetctl (D1).
bx_bifn="$(bx box_index_from_name)"; fc_bifn="$(fc box_index_from_name)"
[ "$bx_bifn" = "$fc_bifn" ] && [ -n "$bx_bifn" ] && pass "D1: box_index_from_name is byte-identical in boxup and fleetctl" || bad "D1: box_index_from_name differs between boxup and fleetctl"
bx_bnfi="$(bx box_name_from_index)"; fc_bnfi="$(fc box_name_from_index)"
[ "$bx_bnfi" = "$fc_bnfi" ] && [ -n "$bx_bnfi" ] && pass "D1: box_name_from_index is byte-identical in boxup and fleetctl" || bad "D1: box_name_from_index differs between boxup and fleetctl"

# D3: key_meta_file goes through box_index_from_name, so grok-box-008 => keys/8.json.
keymeta_test() {
  local box="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_KEYS_DIR="/var/lib/grok-fleet/keys"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_index key_meta_file; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
key_meta_file "$box"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(keymeta_test grok-box-008)" = "/var/lib/grok-fleet/keys/8.json" ] && pass "D3: key_meta_file grok-box-008 => keys/8.json (index-keyed, unpadded)" || bad "D3 key_meta_file: [$(keymeta_test grok-box-008)]"
[ "$(keymeta_test grok-box-8)" = "/var/lib/grok-fleet/keys/8.json" ] && pass "D3: key_meta_file grok-box-8 => keys/8.json (legacy same file)" || bad "D3 key_meta_file legacy: [$(keymeta_test grok-box-8)]"

# D2: pick_name (boxup) emits the PADDED name and treats BOTH padded and legacy
# peers as taken (never mints an index a not-yet-renamed legacy box holds).
pickname_test() {
  local peers_json="$1" inner; inner="$(mktemp)"
  local d; d="$(mktemp -d)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
# Stub tailscale_bin so pick_name's python reads our fixture instead of a real
# tailscale. The fixture is served for 'status --json'; 'status'/'ip' are empty.
tailscale_bin(){ printf '%s' "$d/fakets"; }
eval "\$(extract_from "\$BOXUP" pick_name)"
pick_name
INNER
  # A fake tailscale that prints our JSON for \`status --json\`, else nothing.
  cat > "$d/fakets" <<'FAKETS'
#!/usr/bin/env bash
if [ "$1" = status ] && [ "${2:-}" = --json ]; then cat "$FAKE_JSON"; fi
FAKETS
  chmod +x "$d/fakets"
  printf '%s' "$peers_json" > "$d/peers.json"
  FAKE_JSON="$d/peers.json" timeout 15 bash "$inner"
  rm -f "$inner"; rm -rf "$d"
}
# Peers hold indexes 1 (legacy) and 2 (padded) => lowest free is 3 => grok-box-003.
pk="$(pickname_test '{"Peer":{"a":{"HostName":"grok-box-1"},"b":{"HostName":"grok-box-002"}}}')"
[ "$pk" = grok-box-003 ] && pass "D2: pick_name pads AND counts legacy+padded peers (=> grok-box-003)" || bad "D2 pick_name: [$pk]"

# D5: reconcile_target_boxes orders enrolled boxes NUMERICALLY by decimal index
# (grok-box-002 before grok-box-010, a legacy grok-box-3 in between), and dedups.
targetorder_test() {
  local inner; inner="$(mktemp)"
  local d; d="$(mktemp -d)"; mkdir -p "$d/state"
  printf 'grok-box-010\t20010\ngrok-box-002\t20002\ngrok-box-3\t20003\ngrok-box-002\t20002\n' > "$d/state/enrolled.tsv"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STATE="$d/state"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index reconcile_target_boxes; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
reconcile_target_boxes | tr '\n' '|'
INNER
  timeout 15 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
[ "$(targetorder_test)" = "grok-box-002|grok-box-3|grok-box-010|" ] \
  && pass "D5: reconcile_target_boxes orders numerically by index (002 < legacy 3 < 010) and dedups" \
  || bad "D5 numeric ordering wrong: [$(targetorder_test)]"


# ACL precheck: acl_has_fleet_brain_tagowner returns 0 when the tag is present,
# non-0 (1) when absent. Stub ts_api to return a fixture ACL; jq does the work.
acl_test() {
  local present="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
TS_TAILNET="-"
TS_API_CODE=0
log(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" acl_has_fleet_brain_tagowner)"
eval "\$(extract_from "\$FLEETCTL" ts_ok)"
ts_api_body(){ cat "\$BODYF"; }
BODYF="\$(mktemp)"
if [ "$present" = yes ]; then
  echo '{"tagOwners":{"tag:fleet-brain":["autogroup:admin"],"tag:grok-box":["autogroup:admin"]}}' > "\$BODYF"
  ts_api(){ TS_API_CODE=200; return 0; }
elif [ "$present" = no ]; then
  echo '{"tagOwners":{"tag:grok-box":["autogroup:admin"]}}' > "\$BODYF"
  ts_api(){ TS_API_CODE=200; return 0; }
else
  : > "\$BODYF"
  ts_api(){ TS_API_CODE=500; return 1; }   # API failure
fi
acl_has_fleet_brain_tagowner; echo "rc=\$?"
rm -f "\$BODYF"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(acl_test yes)" = "rc=0" ] && pass "enroll ACL precheck: tag:fleet-brain present => OK (rc 0)" || bad "ACL present wrong: [$(acl_test yes)]"
[ "$(acl_test no)" = "rc=1" ] && pass "enroll ACL precheck: tag:fleet-brain ABSENT => refuse (rc 1)" || bad "ACL absent wrong: [$(acl_test no)]"
[ "$(acl_test fail)" = "rc=2" ] && pass "enroll ACL precheck: API failure => refuse fail-closed (rc 2)" || bad "ACL API-fail wrong: [$(acl_test fail)]"

# --- BUG-D: ts_api MUST send `Accept: application/json` on EVERY call, else the
# Tailscale ACL endpoint returns HuJSON (leading // comment, trailing commas)
# and acl_has_fleet_brain_tagowner()'s `jq -e` fails (rc 5) => enroll refuses
# even when tag:fleet-brain IS in tagOwners (proven live on the VPS). Unlike the
# acl_test above (which stubs ts_api), this drives the REAL ts_api through a
# FAKE curl that inspects the actual `--config` file ts_api writes: it returns
# strict JSON iff `Accept: application/json` is present, else HuJSON. The
# precheck must pass ONLY when the header is sent. breaks-if-undone: drop the
# Accept header line in ts_api and the header-present run flips to rc 2/non-0.
acl_hujson_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
TS_TAILNET="-"
TS_API="https://api.tailscale.com/api/v2"
TS_API_CODE=0
TS_API_LAST_BODY=""
RECONCILE_READONLY=0
TOKF="\$(mktemp)"; printf 'tskey-fake-token\n' > "\$TOKF"
export FLEET_API_TOKEN_FILE="\$TOKF"
log(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index have api_token_file api_token ts_api ts_api_body ts_ok acl_has_fleet_brain_tagowner; do
  eval "\$(extract_from "\$FLEETCTL" "\$fn")"
done
# FAKE curl: parse args to find --config <cfg> and -o <out>. If the config file
# has an Accept: application/json header, write STRICT json; else HuJSON (a //
# comment line + a trailing comma) that jq rejects. Always print 200.
curl() {
  local cfg="" out="" prev=""
  for a in "\$@"; do
    case "\$prev" in
      --config) cfg="\$a" ;;
      -o) out="\$a" ;;
    esac
    prev="\$a"
  done
  if grep -q 'Accept: application/json' "\$cfg"; then
    printf '{"tagOwners":{"tag:fleet-brain":["autogroup:admin"]}}\n' > "\$out"
  else
    printf '// HuJSON ACL — Tailscale default content-type\n{\n  "tagOwners": {\n    "tag:fleet-brain": ["autogroup:admin"],\n  },\n}\n' > "\$out"
  fi
  printf '200'
}
acl_has_fleet_brain_tagowner; echo "rc=\$?"
rm -f "\$TOKF"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(acl_hujson_test)" = "rc=0" ] \
  && pass "BUG-D: ts_api sends Accept: application/json => ACL is strict JSON, precheck passes (jq ok)" \
  || bad "BUG-D: ACL precheck failed — Accept header missing => HuJSON body jq cannot parse: [$(acl_hujson_test)]"
# Static belt-and-suspenders: the header line must be in ts_api's config builder.
grep -q 'header = "Accept: application/json"' "$FLEETCTL" \
  && pass "BUG-D: ts_api curl --config includes the Accept: application/json header (static)" \
  || bad "BUG-D: ts_api curl --config is MISSING the Accept: application/json header (static)"


# =============================================================================
# MINT — key-create payload shape + atomic seed failure leaves old key intact
# =============================================================================
mint_payload_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_KEY_EXPIRY_SECS=7776000
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" clamp_expiry_secs)"
eval "\$(extract_from "\$FLEETCTL" mint_payload)"
mint_payload
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
payload="$(mint_payload_test)"
chk_json() { printf '%s' "$payload" | jq -e "$1" >/dev/null 2>&1; }
chk_json '.capabilities.devices.create.reusable == true'      && pass "mint payload: reusable=true (MANDATORY H11)"      || bad "mint payload reusable wrong: [$payload]"
chk_json '.capabilities.devices.create.ephemeral == false'    && pass "mint payload: ephemeral=false (MANDATORY H11)"    || bad "mint payload ephemeral wrong: [$payload]"
chk_json '.capabilities.devices.create.preauthorized == true' && pass "mint payload: preauthorized=true"                || bad "mint payload preauthorized wrong: [$payload]"
chk_json '.capabilities.devices.create.tags == ["tag:grok-box"]' && pass "mint payload: tags=[tag:grok-box]"            || bad "mint payload tags wrong: [$payload]"
chk_json '.expirySeconds == 7776000'                          && pass "mint payload: expirySeconds=90d cap"            || bad "mint payload expirySeconds wrong: [$payload]"
chk_json '.expirySeconds <= 7776000'                          && pass "mint payload: expirySeconds <= 90d"             || bad "mint payload expirySeconds over cap: [$payload]"

# Atomic seed: a sha MISMATCH on the remote write must FAIL and leave the OLD
# key intact (the .tmp is removed, ts-authkey unchanged). We drive the REAL
# seed_key_over_tunnel with a tunnel_ssh stub that runs the remote script
# LOCALLY against a fake box tree, but corrupts the write so the sha differs.
seed_fail_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<'INNER'
set -u
FLEETCTL="__FLEETCTL__"
BOXROOT="$(mktemp -d)"
mkdir -p "$BOXROOT/secrets"
echo "OLD-KEY" > "$BOXROOT/secrets/ts-authkey"       # the pre-existing key
BOX_ROOT="$BOXROOT"
BOX_AUTHKEY="$BOXROOT/secrets/ts-authkey"
BOX_AUTHKEY_TMP="$BOXROOT/secrets/.ts-authkey.tmp"
BOX_AUTHKEY_EXPIRES="$BOXROOT/secrets/ts-authkey.expires"
log(){ :; }
extract_from(){ awk -v fn="$2" '$0 ~ "^"fn"\\(\\) \\{"{i=1} i{print} i&&/^\}$/{exit}' "$1"; }
eval "$(extract_from "$FLEETCTL" seed_key_over_tunnel)"
eval "$(extract_from "$FLEETCTL" seed_status_converged)"
# tunnel_ssh stub: for the seed heredoc, CORRUPT the stdin so the remote sha
# never matches want_sha (the remote script rm's the .tmp and exits 3). For a
# `boxup status` call, print a benign line.
# tunnel_ssh stub: the remote script arrives as the LAST arg ("$*" after the
# box), and the key arrives on STDIN. Run the script via `bash -c` with stdin
# forwarded. The CORRUPT case tweaks the piped key so the remote sha never
# matches want_sha (the remote script rm's the .tmp and exits 3).
tunnel_ssh(){
  shift    # drop the box arg
  local script="$*"
  case "$script" in
    *"boxup status"*) echo "backend=Running name=grok-box-8 v=5.2.0/deadbee tunnel=up"; return 0 ;;
    *) sed 's/$/-CORRUPT/' | bash -c "$script" ;;
  esac
}
if seed_key_over_tunnel grok-box-8 "FRESH-KEY" "2099-01-01"; then echo "seed=OK"; else echo "seed=FAIL"; fi
echo "onbox=$(cat "$BOX_AUTHKEY")"
[ -e "$BOX_AUTHKEY_TMP" ] && echo "tmp=present" || echo "tmp=gone"
rm -rf "$BOXROOT"
INNER
  sed -i "s#__FLEETCTL__#$FLEETCTL#" "$inner"
  timeout 20 bash "$inner"; rm -f "$inner"
}
seedout="$(seed_fail_test)"
case "$seedout" in
  *"seed=FAIL"*) pass "mint atomic seed: sha mismatch => seed FAILS (old key not advanced)" ;;
  *) bad "mint atomic seed did not fail on sha mismatch: [$seedout]" ;;
esac
case "$seedout" in
  *"onbox=OLD-KEY"*) pass "mint atomic seed: failure leaves the OLD key intact on the box" ;;
  *) bad "mint atomic seed clobbered the old key: [$seedout]" ;;
esac
case "$seedout" in
  *"tmp=gone"*) pass "mint atomic seed: the .tmp scratch is removed on mismatch" ;;
  *) bad "mint atomic seed left a .tmp behind: [$seedout]" ;;
esac

# Atomic seed SUCCESS: matching sha => mv into place + .expires written.
seed_ok_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<'INNER'
set -u
FLEETCTL="__FLEETCTL__"
BOXROOT="$(mktemp -d)"; mkdir -p "$BOXROOT/secrets"; echo OLD > "$BOXROOT/secrets/ts-authkey"
BOX_ROOT="$BOXROOT"
BOX_AUTHKEY="$BOXROOT/secrets/ts-authkey"
BOX_AUTHKEY_TMP="$BOXROOT/secrets/.ts-authkey.tmp"
BOX_AUTHKEY_EXPIRES="$BOXROOT/secrets/ts-authkey.expires"
log(){ :; }
extract_from(){ awk -v fn="$2" '$0 ~ "^"fn"\\(\\) \\{"{i=1} i{print} i&&/^\}$/{exit}' "$1"; }
eval "$(extract_from "$FLEETCTL" seed_key_over_tunnel)"
eval "$(extract_from "$FLEETCTL" seed_status_converged)"
tunnel_ssh(){ shift; local s="$*"; case "$s" in *"boxup status"*) echo "backend=Running tunnel=up"; return 0 ;; *) bash -c "$s" ;; esac; }
if seed_key_over_tunnel grok-box-8 "FRESH-KEY" "2099-01-01"; then echo "seed=OK"; else echo "seed=FAIL"; fi
echo "onbox=$(cat "$BOX_AUTHKEY")"
echo "exp=$(cat "$BOX_AUTHKEY_EXPIRES" 2>/dev/null)"
rm -rf "$BOXROOT"
INNER
  sed -i "s#__FLEETCTL__#$FLEETCTL#" "$inner"
  timeout 20 bash "$inner"; rm -f "$inner"
}
seedok="$(seed_ok_test)"
case "$seedok" in
  *"seed=OK"*"onbox=FRESH-KEY"*"exp=2099-01-01"*) pass "mint atomic seed: matching sha => key installed + .expires written" ;;
  *) bad "mint atomic seed success path wrong: [$seedok]" ;;
esac

# =============================================================================
# RECONCILE — the PURE decision table (reconcile_decide), each row.
# args: online lastseen_fresh dupcount both_online_dup tunnel checkfail
#       expiry_days drift [checkfail_runs]
# =============================================================================
decide() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" reconcile_decide)"
reconcile_decide $* | tr '\n' ',' | sed 's/,\$//'
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
# Row a: offline but tunnel alive => mint.
case "$(decide no yes 1 no up no unknown unknown 0)" in *mint*) pass "reconcile row a: offline + tunnel up => mint" ;; *) bad "row a wrong: [$(decide no yes 1 no up no unknown unknown 0)]" ;; esac
# Row a via stale lastSeen even if online-flag yes.
case "$(decide yes no 1 no up no unknown unknown 0)" in *mint*) pass "reconcile row a: stale lastSeen + tunnel up => mint" ;; *) bad "row a stale wrong: [$(decide yes no 1 no up no unknown unknown 0)]" ;; esac
# Row b: duplicate, not both online => delete-then-rename.
case "$(decide yes yes 2 no up no unknown unknown 0)" in *delete-then-rename*) pass "reconcile row b: dup (not both online) => delete-then-rename" ;; *) bad "row b wrong: [$(decide yes yes 2 no up no unknown unknown 0)]" ;; esac
# Row b: duplicate, BOTH online => NEVER delete, incident.
dup_both="$(decide yes yes 2 yes up no unknown unknown 0)"
case "$dup_both" in *alert-incident:duplicate-both-online*) pass "reconcile row b: BOTH online => NEVER delete, flag incident" ;; *) bad "row b both-online wrong: [$dup_both]" ;; esac
case "$dup_both" in *delete-then-rename*) bad "reconcile row b: deleted when BOTH online (FORBIDDEN): [$dup_both]" ;; *) pass "reconcile row b: no delete emitted when both online" ;; esac
# Row c: auth-key expiry < 7d + tunnel => rotate.
case "$(decide yes yes 1 no up no 3 no 0)" in *rotate*) pass "reconcile row c: expiry 3d + tunnel => rotate" ;; *) bad "row c wrong: [$(decide yes yes 1 no up no 3 no 0)]" ;; esac
# Row c: expiry >= 7d => NO rotate.
case "$(decide yes yes 1 no up no 30 no 0)" in *rotate*) bad "reconcile row c: rotated at 30d (should not)" ;; *) pass "reconcile row c: expiry 30d => no rotate" ;; esac
# Row d: version drift + tunnel => rollout.
case "$(decide yes yes 1 no up no unknown yes 0)" in *rollout*) pass "reconcile row d: drift + tunnel => rollout" ;; *) bad "row d wrong: [$(decide yes yes 1 no up no unknown yes 0)]" ;; esac
# Row e: both paths dead, offline => alert-asleep.
case "$(decide no yes 1 no down no unknown unknown 0)" in *alert-asleep*) pass "reconcile row e: both paths dead (offline) => alert-asleep" ;; *) bad "row e asleep wrong: [$(decide no yes 1 no down no unknown unknown 0)]" ;; esac
# Row e incoherent: API says online yet both dead => immediate incident.
case "$(decide yes yes 1 no down no unknown unknown 0)" in *alert-incident:incoherent-both-dead*) pass "reconcile row e: online+both-dead => incoherent incident" ;; *) bad "row e incoherent wrong: [$(decide yes yes 1 no down no unknown unknown 0)]" ;; esac
# N-1: tunnel up but boxup check fails > 3 runs => reachable-cannot-converge incident.
case "$(decide yes yes 1 no up yes unknown no 4)" in *alert-incident:reachable-cannot-converge*) pass "reconcile N-1: check FAIL > 3 runs => reachable-cannot-converge incident" ;; *) bad "N-1 wrong: [$(decide yes yes 1 no up yes unknown no 4)]" ;; esac
case "$(decide yes yes 1 no up yes unknown no 2)" in *reachable-cannot-converge*) bad "N-1 fired too early (2 runs): [$(decide yes yes 1 no up yes unknown no 2)]" ;; *) pass "reconcile N-1: check FAIL only 2 runs => no incident yet" ;; esac
# Healthy: online, fresh, no dup, tunnel up, no drift, expiry ok => noop.
[ "$(decide yes yes 1 no up no 30 no 0)" = noop ] && pass "reconcile: fully healthy => noop" || bad "healthy not noop: [$(decide yes yes 1 no up no 30 no 0)]"

# Read-only on API failure: reconcile_one must NOT emit a mutation when the run
# is read-only, even if the (empty) inputs would otherwise. We assert the
# READ-ONLY suppression via reconcile_one with readonly=1 + a mint-worthy tunnel.
readonly_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STATE="\$(mktemp -d)"
BOX_ROOT="/nonexistent"
log(){ echo "LOG:\$*"; }
notify(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index box_index reconcile_decide reconcile_one reconcile_bump_checkfail reconcile_reset_checkfail days_until; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
# Tunnel up (would trigger mint on an offline box) but this is a READ-ONLY run.
tunnel_up(){ return 0; }
tunnel_ssh(){ return 1; }   # boxup check fails, but suppressed
dev_field(){ :; }
port_for(){ echo 20008; }
FLEET_TARGET_SHA=""
# devs empty (API failure) + readonly=1 => must WOULD-log, never execute.
out="\$(reconcile_one grok-box-8 "" 1 1 2>&1)"
rm -rf "\$FLEET_STATE"
case "\$out" in *"reconcile_execute"*) echo "EXECUTED" ;; *) echo "NO-MUTATION" ;; esac
INNER
  timeout 20 bash "$inner"; rm -f "$inner"
}
# reconcile_execute is not defined in the stubbed env, so if it were CALLED the
# run would error "command not found"; we assert it is never invoked.
case "$(readonly_test)" in
  *NO-MUTATION*) pass "reconcile: API-failure read-only run emits NO mutation (mint/delete/rename suppressed)" ;;
  *) bad "reconcile read-only run attempted a mutation: [$(readonly_test)]" ;;
esac

# dev_field over a fixture device list: dupcount, online, stale_id (older
# offline), live_id (online) — the rename-after-delete inputs (row b order).
devfield_test() {
  local field="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STALE_SECS=600
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" dev_field)"
now_iso="\$(date -u +%Y-%m-%dT%H:%M:%SZ)"
old_iso="\$(date -u -d '-1 hour' +%Y-%m-%dT%H:%M:%SZ)"
devs="\$(jq -cn --arg now "\$now_iso" --arg old "\$old_iso" '{devices:[
  {hostname:"grok-box-8",   nodeId:"LIVE", online:true,  lastSeen:\$now, created:\$now},
  {hostname:"grok-box-8-1", nodeId:"STALE",online:false, lastSeen:\$old, created:\$old}
]}')"
dev_field "\$devs" grok-box-8 "$field"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(devfield_test dupcount)" = 2 ] && pass "reconcile dev_field: dupcount counts grok-box-8 + the -1 corpse => 2" || bad "dupcount wrong: [$(devfield_test dupcount)]"
[ "$(devfield_test online)" = yes ] && pass "reconcile dev_field: online=yes (the live node)" || bad "online wrong: [$(devfield_test online)]"
[ "$(devfield_test both_online)" = no ] && pass "reconcile dev_field: both_online=no (only one online)" || bad "both_online wrong: [$(devfield_test both_online)]"
[ "$(devfield_test stale_id)" = STALE ] && pass "reconcile dev_field: stale_id = the OLDER OFFLINE device (delete target)" || bad "stale_id wrong: [$(devfield_test stale_id)]"
[ "$(devfield_test live_id)" = LIVE ] && pass "reconcile dev_field: live_id = the ONLINE device (rename target)" || bad "live_id wrong: [$(devfield_test live_id)]"

# reconcile_dedup ORDER: DELETE the stale id BEFORE POST /device/<live>/name.
# Stub ts_api to record the call sequence.
dedup_order_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
TS_TAILNET="-"
TS_API_CODE=0
log(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index reconcile_dedup dev_field ts_ok devices_json_valid; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
FLEET_STALE_SECS=600
seq="\$(mktemp)"; BODYF="\$(mktemp)"
DEVS='{"devices":[{"hostname":"grok-box-8","nodeId":"LIVE","online":true,"lastSeen":"2999-01-01T00:00:00Z"},{"hostname":"grok-box-8-1","nodeId":"STALE","online":false,"lastSeen":"2000-01-01T00:00:00Z"}]}'
devices_json(){ TS_API_CODE=200; printf '%s' "\$DEVS" > "\$BODYF"; }
ts_api_body(){ cat "\$BODYF"; }
ts_api(){ TS_API_CODE=200; echo "\$1 \$2" >> "\$seq"; return 0; }
reconcile_dedup grok-box-8 >/dev/null 2>&1
tr '\n' '|' < "\$seq"
rm -f "\$seq" "\$BODYF"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
dedup_seq="$(dedup_order_test)"
case "$dedup_seq" in
  "DELETE /device/STALE|POST /device/LIVE/name|") pass "reconcile row b: DELETE stale THEN POST live/name (F2 -1 restore, correct order)" ;;
  *) bad "reconcile dedup order wrong: [$dedup_seq]" ;;
esac

# =============================================================================
# ROTATE (task b) — reconcile_rotate: mint+seed the new key, THEN revoke the OLD
# key id via DELETE /tailnet/-/keys/<id>. Missing id => skip cleanly. NEVER
# delete before the new key is verified seeded (cmd_mint_key returns 0).
# =============================================================================
# The harness stubs cmd_mint_key (verified-seed success/failure) + key_meta_id
# (recorded old id / none) + ts_api (records the call sequence), then drives the
# REAL reconcile_rotate and inspects what it called and in what order.
rotate_test() {
  local mint_rc="$1" old_id="$2" del_rc="$3" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
TS_TAILNET="-"
TS_API_CODE=0
log(){ :; }
notify(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index reconcile_rotate ts_ok; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
seq="\$(mktemp)"
# key_meta_id: the recorded OLD id (empty => none recorded).
key_meta_id(){ [ -n "$old_id" ] && printf '%s' "$old_id"; }
# cmd_mint_key: records the mint call, returns the seed verdict. If it were
# ordered AFTER a delete we would see it out of order in \$seq.
cmd_mint_key(){ echo "MINT \$1" >> "\$seq"; return $mint_rc; }
# ts_api: record the method+path (the DELETE is what we assert on).
ts_api(){ echo "\$1 \$2" >> "\$seq"; TS_API_CODE=$del_rc; [ "$del_rc" -ge 200 ] && [ "$del_rc" -lt 300 ]; }
reconcile_rotate grok-box-8 >/dev/null 2>&1
echo "rc=\$?"
tr '\n' '|' < "\$seq"
echo
rm -f "\$seq"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}

# (1) Happy path: verified seed (mint rc 0), a recorded old id, DELETE 200.
#     Must MINT first, THEN DELETE the OLD id, and succeed.
rot_ok="$(rotate_test 0 K-OLD-123 200)"
case "$rot_ok" in
  *"MINT grok-box-8|DELETE /tailnet/-/keys/K-OLD-123|"*)
    pass "rotate: mint(verified) THEN DELETE old key id (correct order)" ;;
  *) bad "rotate happy path wrong: [$rot_ok]" ;;
esac
case "$rot_ok" in *"rc=0"*) pass "rotate: happy path returns success" ;; *) bad "rotate happy path rc!=0: [$rot_ok]" ;; esac

# (2) Missing id: no recorded old id => SKIP the revoke cleanly, still succeed.
rot_noid="$(rotate_test 0 "" 200)"
case "$rot_noid" in
  *DELETE*) bad "rotate: DELETE issued with NO recorded old id: [$rot_noid]" ;;
  "rc=0"*"MINT grok-box-8"*) pass "rotate: missing old id => skip revoke cleanly, rotation still succeeds" ;;
  *) bad "rotate missing-id wrong: [$rot_noid]" ;;
esac

# (3) Never delete before verified: mint FAILS (rc 1) => NO DELETE at all, and
#     the rotation reports failure (old key left intact upstream).
rot_failseed="$(rotate_test 1 K-OLD-123 200)"
case "$rot_failseed" in
  *DELETE*) bad "rotate: DELETED before the new key was verified seeded (FORBIDDEN): [$rot_failseed]" ;;
  *"MINT grok-box-8"*) pass "rotate: mint/seed FAILURE => NEVER DELETEs the old key" ;;
  *) bad "rotate fail-seed wrong: [$rot_failseed]" ;;
esac
case "$rot_failseed" in *"rc=1"*) pass "rotate: mint/seed failure => rotation reports failure (no revoke)" ;; *) bad "rotate fail-seed rc wrong: [$rot_failseed]" ;; esac

# (4) Revoke miss (DELETE 500) must NOT fail the rotation: the new key is seeded,
#     the old key will lapse at its own expiry.
rot_revfail="$(rotate_test 0 K-OLD-123 500)"
case "$rot_revfail" in
  "rc=0"*"DELETE /tailnet/-/keys/K-OLD-123|"*) pass "rotate: old-key revoke FAILURE never fails the rotation (new key OK)" ;;
  *) bad "rotate revoke-miss wrong: [$rot_revfail]" ;;
esac

# mint records the key id + expires at mint time (task b): cmd_mint_key writes
# $FLEET_KEYS_DIR/<N>.json with {id,expires} AFTER a verified seed. Drive the
# REAL cmd_mint_key with stubbed API + seed and assert the meta file.
mint_records_id_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
TS_TAILNET="-"
TS_API_CODE=0
FLEET_STATE="\$(mktemp -d)"
FLEET_KEYS_DIR="\$FLEET_STATE/keys"
FLEET_KEY_EXPIRY_SECS=7776000
log(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index cmd_mint_key record_key_meta key_meta_file key_meta_id box_index mint_payload mint_create ts_ok; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
BODYF="\$(mktemp)"
echo '{"key":"tskey-abc","id":"kNEW999","expires":"2099-03-01T00:00:00Z"}' > "\$BODYF"
ts_api(){ TS_API_CODE=200; return 0; }
ts_api_body(){ cat "\$BODYF"; }
seed_key_over_tunnel(){ return 0; }    # pretend the atomic seed verified
cmd_mint_key grok-box-8 >/dev/null 2>&1
metaf="\$FLEET_KEYS_DIR/8.json"
if [ -f "\$metaf" ]; then
  printf 'id=%s exp=%s\n' "\$(jq -r .id "\$metaf")" "\$(jq -r .expires "\$metaf")"
else
  echo "NO-META"
fi
# key_meta_id must read it back.
echo "readback=\$(key_meta_id grok-box-8)"
rm -rf "\$FLEET_STATE" "\$BODYF"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"
}
mint_meta="$(mint_records_id_test)"
case "$mint_meta" in
  *"id=kNEW999 exp=2099-03-01T00:00:00Z"*"readback=kNEW999"*)
    pass "mint: records key id + expires to keys/<N>.json after verified seed (rotation can revoke it later)" ;;
  *) bad "mint key-id record wrong: [$mint_meta]" ;;
esac

# =============================================================================
# ROLLOUT (task a) — reconcile_rollout: canary-first, abort-on-first-failure,
# over the tunnel; tunnel_deploy_one/tunnel_scp use the ssh -p 2000N
# box@127.0.0.1 -i <vps-key> path. Box-free: tunnel_up/tunnel_deploy_one stubbed
# to record order; the tunnel argv is asserted against real tunnel_ssh/scp.
# =============================================================================
# reconcile_rollout order: canary (grok-box-8, default) FIRST, then the rest in
# enrolled order. tunnel_deploy_one records the box + its verdict.
rollout_order_test() {
  local canary_verdict="$1" b3_verdict="$2" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_BOXES="grok-box-003 grok-box-005 grok-box-008"
log(){ :; }
notify(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index reconcile_rollout reconcile_canary_box reconcile_target_boxes box_index; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
config_get(){ return 1; }           # no canary_box configured => default grok-box-008
reconcile_stage_rollout_tree(){ FLEET_ROLLOUT_TREE_STAGED=0; return 0; }  # a tree is staged
reconcile_cleanup_rollout_tree(){ :; }
tunnel_up(){ return 0; }            # every tunnel up
seq="\$(mktemp)"
# tunnel_deploy_one records the box, returns the per-box verdict.
tunnel_deploy_one(){
  echo "DEPLOY \$1" >> "\$seq"
  case "\$1" in
    grok-box-008) return $canary_verdict ;;
    grok-box-003) return $b3_verdict ;;
    *) return 0 ;;
  esac
}
reconcile_rollout drift >/dev/null 2>&1
echo "rc=\$?"
tr '\n' '|' < "\$seq"; echo
rm -f "\$seq"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
# Canary first, all pass: deploy 008 THEN the rest (003,005 in enrolled order).
ro_all="$(rollout_order_test 0 0)"
case "$ro_all" in
  "rc=0"*"DEPLOY grok-box-008|DEPLOY grok-box-003|DEPLOY grok-box-005|"*)
    pass "rollout: canary (grok-box-008) deploys FIRST, then the rest serially" ;;
  *) bad "rollout order wrong: [$ro_all]" ;;
esac

# Canary FAILS verification => ABORT: ZERO other boxes touched.
ro_canfail="$(rollout_order_test 1 0)"
case "$ro_canfail" in
  "rc=1"*"DEPLOY grok-box-008|") pass "rollout: canary verified-FAILURE => ABORT, zero other boxes deployed" ;;
  *"DEPLOY grok-box-003"*|*"DEPLOY grok-box-005"*) bad "rollout: touched other boxes after canary failure (FORBIDDEN): [$ro_canfail]" ;;
  *) bad "rollout canary-fail wrong: [$ro_canfail]" ;;
esac

# A mid-list box (grok-box-003) FAILS => ABORT: grok-box-005 (after it) NOT deployed.
ro_midfail="$(rollout_order_test 0 1)"
case "$ro_midfail" in
  *"DEPLOY grok-box-005"*) bad "rollout: deployed grok-box-005 after grok-box-003 failed (abort-on-first-failure violated): [$ro_midfail]" ;;
  "rc=1"*"DEPLOY grok-box-008|DEPLOY grok-box-003|") pass "rollout: abort-on-first-failure stops NEW deploys after a verified failure" ;;
  *) bad "rollout mid-fail wrong: [$ro_midfail]" ;;
esac

# Canary tunnel DOWN => ABORT (cannot verify), zero deployed.
rollout_canary_down_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_BOXES="grok-box-3 grok-box-008"
log(){ :; }
notify(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index reconcile_rollout reconcile_canary_box reconcile_target_boxes box_index; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
config_get(){ return 1; }
reconcile_stage_rollout_tree(){ FLEET_ROLLOUT_TREE_STAGED=0; return 0; }
reconcile_cleanup_rollout_tree(){ :; }
tunnel_up(){ [ "\$1" = grok-box-008 ] && return 1 || return 0; }   # canary down
seq="\$(mktemp)"
tunnel_deploy_one(){ echo "DEPLOY \$1" >> "\$seq"; return 0; }
reconcile_rollout drift >/dev/null 2>&1
echo "rc=\$?"; tr '\n' '|' < "\$seq"; echo
rm -f "\$seq"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
ro_cdown="$(rollout_canary_down_test)"
case "$ro_cdown" in
  *DEPLOY*) bad "rollout: deployed despite canary tunnel DOWN (should abort): [$ro_cdown]" ;;
  "rc=1"*) pass "rollout: canary tunnel DOWN => ABORT before any deploy" ;;
  *) bad "rollout canary-down wrong: [$ro_cdown]" ;;
esac

# canary_box config override: [fleet-brain].canary_box = 5 => grok-box-5 first.
rollout_canary_cfg_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" box_name_from_index)"
eval "\$(extract_from "\$FLEETCTL" box_index_from_name)"
eval "\$(extract_from "\$FLEETCTL" reconcile_canary_box)"
config_get(){ [ "\$1 \$2" = "fleet-brain canary_box" ] && echo 5; }
reconcile_canary_box
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(rollout_canary_cfg_test)" = grok-box-005 ] && pass "rollout: [fleet-brain].canary_box overrides the default, normalised (=> grok-box-005)" || bad "canary_box override wrong: [$(rollout_canary_cfg_test)]"
# Default (unset) => grok-box-008 (D5 padded default).
rollout_canary_default_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" box_name_from_index)"
eval "\$(extract_from "\$FLEETCTL" box_index_from_name)"
eval "\$(extract_from "\$FLEETCTL" reconcile_canary_box)"
config_get(){ return 1; }
reconcile_canary_box
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(rollout_canary_default_test)" = grok-box-008 ] && pass "rollout: canary_box default => grok-box-008" || bad "canary_box default wrong: [$(rollout_canary_default_test)]"

# Tunnel argv: tunnel_deploy_one drives the box over ssh -p 2000N box@127.0.0.1
# -i <vps-key>, and VERIFIES with `boxup check`. B-2: a rollout MUST push a real
# artifact, so we stage a real tarball and assert the scp push happened. Stub
# ssh AND scp to capture argv.
rollout_tunnel_argv_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_BOX_KEY="/etc/grok-fleet/box_access_ed25519"
FLEET_ROLLOUT_TREE="\$(mktemp --suffix=.tar)"; printf 'ARTIFACT' > "\$FLEET_ROLLOUT_TREE"   # a real staged artifact
BOX_ROOT="/workspace/box-setup"
log(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index tunnel_deploy_one tunnel_ssh tunnel_scp port_for box_index; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
cap="\$(mktemp)"; scpcap="\$(mktemp)"
# ssh stub: append the full argv of each invocation (one line per call). The
# 'boxup check' verify + the extract/install/once step both come through here.
# The extract step checks '[ -f remote_tar ]' — make that TRUE so install runs.
ssh(){ printf 'SSH %s\n' "\$*" >> "\$cap"; case "\$*" in *"[ -f '/tmp/grok-box-setup-brain.tar' ]"*) return 0 ;; esac; return 0; }
scp(){ printf 'SCP %s\n' "\$*" >> "\$scpcap"; return 0; }
tunnel_deploy_one grok-box-8 >/dev/null 2>&1
echo "rc=\$?"
# Emit the LAST ssh argv (the boxup check verify) + whether any call carried the
# tunnel identity, and whether an artifact was PUSHED over scp.
tail -1 "\$cap"
grep -q -- "-p 20008 box@127.0.0.1" "\$cap" && echo "PORTHOST-OK" || echo "PORTHOST-MISSING"
grep -q -- "-i /etc/grok-fleet/box_access_ed25519" "\$cap" && echo "KEY-OK" || echo "KEY-MISSING"
grep -q "boxup check" "\$cap" && echo "VERIFY-OK" || echo "VERIFY-MISSING"
grep -q -- "-P 20008" "\$scpcap" && grep -q "box@127.0.0.1:/tmp/grok-box-setup-brain.tar" "\$scpcap" && echo "PUSH-OK" || echo "PUSH-MISSING"
rm -f "\$cap" "\$scpcap" "\$FLEET_ROLLOUT_TREE"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
ro_argv="$(rollout_tunnel_argv_test)"
case "$ro_argv" in *"PORTHOST-OK"*) pass "rollout tunnel argv: ssh -p 20008 box@127.0.0.1 (port 20000+8)" ;; *) bad "rollout tunnel argv port/host wrong: [$ro_argv]" ;; esac
case "$ro_argv" in *"KEY-OK"*) pass "rollout tunnel argv: -i <VPS box-access key> (no password fallback, R7)" ;; *) bad "rollout tunnel argv key missing: [$ro_argv]" ;; esac
case "$ro_argv" in *"VERIFY-OK"*) pass "rollout tunnel: verifies via boxup check over the tunnel (D6 postcondition)" ;; *) bad "rollout tunnel verify missing: [$ro_argv]" ;; esac
case "$ro_argv" in *"PUSH-OK"*) pass "rollout tunnel: PUSHES the staged artifact over scp -P 20008 (B-2: no push-less rollout)" ;; *) bad "rollout tunnel did NOT push an artifact (B-2): [$ro_argv]" ;; esac

# =============================================================================
# TUNNEL — boxup supervision: unconfigured no-op, respawn argv, status field.
# =============================================================================
# tunnel_state: unconfigured (no [fleet].vps) => 'unconfigured'.
tunnelstate_test() {
  local configured="$1" alive="$2" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index fleet_configured tunnel_state; do eval "\$(extract_from "\$BOXUP" "\$fn")"; done
if [ "$configured" = yes ]; then config_get(){ [ "\$1 \$2" = "fleet vps" ] && echo "1.2.3.4"; }; else config_get(){ return 1; }; fi
if [ "$alive" = yes ]; then tunnel_pid(){ echo 4242; return 0; }; else tunnel_pid(){ return 1; }; fi
tunnel_state
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(tunnelstate_test no no)" = unconfigured ] && pass "boxup tunnel_state: [fleet].vps unset => unconfigured" || bad "tunnel_state unconfigured wrong: [$(tunnelstate_test no no)]"
[ "$(tunnelstate_test yes yes)" = up ] && pass "boxup tunnel_state: configured + live pid => up" || bad "tunnel_state up wrong: [$(tunnelstate_test yes yes)]"
[ "$(tunnelstate_test yes no)" = down ] && pass "boxup tunnel_state: configured + no pid => down" || bad "tunnel_state down wrong: [$(tunnelstate_test yes no)]"

# supervise_tunnel UNCONFIGURED => silent no-op: spawn_detached must NEVER be
# called. Stub spawn_detached to record if it fired.
supervise_noop_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
marker="\$(mktemp)"; : > "\$marker"
log(){ :; }; have(){ command -v "\$1" >/dev/null 2>&1; }
config_get(){ return 1; }         # nothing configured
spawn_detached(){ echo SPAWNED >> "\$marker"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index fleet_configured fleet_port supervise_tunnel tunnel_pid tunnel_backoff_window tunnel_fail_count ensure_tunnel_key; do eval "\$(extract_from "\$BOXUP" "\$fn")"; done
supervise_tunnel
grep -q SPAWNED "\$marker" && echo SPAWNED || echo NOOP
rm -f "\$marker"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(supervise_noop_test)" = NOOP ] && pass "boxup supervise_tunnel: UNCONFIGURED => silent no-op (never spawns)" || bad "supervise_tunnel spawned while unconfigured: [$(supervise_noop_test)]"

# supervise_tunnel RESPAWN argv: configured + no live tunnel => spawn_detached
# with the exact ssh -N reverse-tunnel flags from the blueprint.
supervise_argv_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
RUN_DIR="\$(mktemp -d)"; SECRETS_DIR="\$(mktemp -d)"
TUNNEL_KEY="\$SECRETS_DIR/tunnel_ed25519"; TUNNEL_PUB="\$TUNNEL_KEY.pub"
TUNNEL_PID="\$RUN_DIR/tunnel.pid"; TUNNEL_LOG="\$RUN_DIR/tunnel.log"
: > "\$TUNNEL_KEY"      # pretend a key already exists
capture="\$(mktemp)"
log(){ :; }; have(){ command -v "\$1" >/dev/null 2>&1; }
config_get(){ case "\$1 \$2" in "fleet vps") echo "9.9.9.9";; "fleet port") echo 22;; "fleet box_index") echo 8;; *) return 1;; esac; }
read_box_name(){ echo grok-box-8; }
ensure_tunnel_key(){ return 0; }
tunnel_pid(){ return 1; }            # no live tunnel
pgrep(){ return 1; }                 # cannot attribute a pid (fine)
spawn_detached(){ shift; printf '%s\n' "\$@" > "\$capture"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index fleet_configured fleet_port supervise_tunnel tunnel_backoff_window tunnel_fail_count; do eval "\$(extract_from "\$BOXUP" "\$fn")"; done
supervise_tunnel
tr '\n' ' ' < "\$capture"
rm -rf "\$RUN_DIR" "\$SECRETS_DIR" "\$capture"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
argv="$(supervise_argv_test)"
case "$argv" in *"ssh -N -T"*) pass "boxup supervise_tunnel: respawns ssh -N -T" ;; *) bad "supervise argv missing ssh -N -T: [$argv]" ;; esac
case "$argv" in *"-R 127.0.0.1:20008:localhost:22"*) pass "boxup supervise_tunnel: -R 127.0.0.1:20008:localhost:22 (port 20000+8)" ;; *) bad "supervise argv missing -R pin: [$argv]" ;; esac
case "$argv" in *"ExitOnForwardFailure=yes"*) pass "boxup supervise_tunnel: ExitOnForwardFailure=yes" ;; *) bad "supervise argv missing ExitOnForwardFailure: [$argv]" ;; esac
case "$argv" in *"ServerAliveInterval=30"*) pass "boxup supervise_tunnel: ServerAliveInterval=30 (client-driven liveness)" ;; *) bad "supervise argv missing ServerAliveInterval: [$argv]" ;; esac
case "$argv" in *"fleet@9.9.9.9"*) pass "boxup supervise_tunnel: dials fleet@<vps>" ;; *) bad "supervise argv missing fleet@vps: [$argv]" ;; esac

# supervise_tunnel with a LIVE tunnel => no respawn (spawn_detached not called).
supervise_live_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
RUN_DIR="\$(mktemp -d)"
marker="\$(mktemp)"; : > "\$marker"
log(){ :; }; have(){ command -v "\$1" >/dev/null 2>&1; }
config_get(){ case "\$1 \$2" in "fleet vps") echo "9.9.9.9";; "fleet box_index") echo 8;; *) return 1;; esac; }
tunnel_pid(){ echo 4242; return 0; }      # a live tunnel already
spawn_detached(){ echo SPAWNED >> "\$marker"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index fleet_configured fleet_port supervise_tunnel tunnel_backoff_window tunnel_fail_count ensure_tunnel_key; do eval "\$(extract_from "\$BOXUP" "\$fn")"; done
supervise_tunnel
grep -q SPAWNED "\$marker" && echo SPAWNED || echo NOSPAWN
rm -rf "\$RUN_DIR" "\$marker"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(supervise_live_test)" = NOSPAWN ] && pass "boxup supervise_tunnel: LIVE tunnel => no respawn" || bad "supervise respawned a live tunnel: [$(supervise_live_test)]"

# boxup status carries the tunnel= field (grep the source: print_status emits it).
if grep -q "tunnel=%s" "$BOXUP" && grep -q 'tunnel_state' "$BOXUP"; then
  pass "boxup status: emits a tunnel= field via tunnel_state"
else
  bad "boxup status: missing the tunnel= field"
fi

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

# The installed tree has exactly the four expected files and NOTHING else.
installer_tree_test() {
  local pfx; pfx="$(mktemp -d)"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  ( cd "$pfx" && find . -type f | sort | sed "s#^\./##" ) | tr '\n' '|'
  rm -rf "$pfx"
}
tree="$(installer_tree_test)"
# etc/grok-fleet is a dir (no file) — normalize by removing the trailing dir slash entry if present.
tree_norm="$(printf '%s' "$tree" | sed 's#etc/grok-fleet/|##')"
# The sanctioned footprint: fleetctl + config.toml + service + timer + the ONE
# sshd drop-in (B-3). Nothing else.
expected_norm="etc/ssh/sshd_config.d/50-grok-fleet.conf|etc/systemd/system/fleet-reconcile.service|etc/systemd/system/fleet-reconcile.timer|opt/grok-fleet/config.toml|opt/grok-fleet/fleetctl|"
if [ "$tree_norm" = "$expected_norm" ]; then
  pass "installer: installs exactly fleetctl + config.toml + service + timer + one sshd drop-in"
else
  bad "installer tree unexpected: [$tree_norm] want [$expected_norm]"
fi

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

# --uninstall removes exactly what it installed (nothing under grok-fleet left).
installer_uninstall_test() {
  local pfx; pfx="$(mktemp -d)"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  PREFIX="$pfx" bash "$VPS_INSTALL" --uninstall >/dev/null 2>&1
  local left
  left="$( find "$pfx" -path '*grok-fleet*' -o -name 'fleet-reconcile*' 2>/dev/null | wc -l | tr -d ' ' )"
  echo "$left"
  rm -rf "$pfx"
}
[ "$(installer_uninstall_test)" = 0 ] && pass "installer: --uninstall removes exactly what it installed" || bad "installer --uninstall left files: [$(installer_uninstall_test)]"

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
# SURVIVOR KILLS — a behavioural test for every mutant that survived r2
# (M01,M02,M03,M11,M13,M19,M20,M21,M23). Each was verified to FLIP (PASS->FAIL)
# when its mutation is applied to a scratch copy of fleetctl / install-vps.sh.
# See the commit message for the survivor->test ledger.
# =============================================================================

# --- M01: cmd_reconcile default apply=0 (NOT 1). Drive the REAL cmd_reconcile
# with everything stubbed; a mint-worthy box must be WOULD-logged (dry-run), and
# reconcile_execute must NEVER be called by default. If the default flipped to
# apply=1, reconcile_execute would fire (command-not-found -> observable).
m01_test() {
  local args="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STATE="\$(mktemp -d)"
FLEET_BOXES="grok-box-8"
BOX_ROOT="/nonexistent"
FLEET_TARGET_SHA=""
MARK="\$(mktemp)"; : > "\$MARK"
log(){ :; }
notify(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index cmd_reconcile reconcile_one reconcile_decide reconcile_target_boxes box_index reconcile_bump_checkfail reconcile_reset_checkfail reconcile_reset_seedfail reconcile_bump_seedfail reconcile_reset_asleep reconcile_reset_incoherent reconcile_alert_asleep reconcile_alert_incoherent mint_window_valid days_until reconcile_record_api_failure reconcile_reset_api_failure reconcile_backoff_active devices_json_valid key_meta_id key_meta_file ts_ok; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
# API returns a healthy list where box-8 is OFFLINE (mint-worthy with tunnel up).
BODYF="\$(mktemp)"
devices_json(){ TS_API_CODE=200; printf '%s' '{"devices":[]}' > "\$BODYF"; }
ts_api_body(){ cat "\$BODYF"; }
dev_field(){ case "\$3" in online) echo no;; fresh) echo no;; dupcount) echo 0;; both_online) echo no;; *) echo "";; esac; }
tunnel_up(){ return 0; }
tunnel_ssh(){ return 0; }
reconcile_execute(){ echo "EXECUTED:\$2" >> "\$MARK"; return 0; }   # must NOT run by default
cmd_reconcile $args >/dev/null 2>&1
if grep -q EXECUTED "\$MARK"; then echo "EXECUTED"; else echo "DRYRUN"; fi
rm -rf "\$FLEET_STATE" "\$BODYF" "\$MARK"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"
}
[ "$(m01_test "")" = DRYRUN ] && pass "M01: bare reconcile defaults to DRY-RUN (never executes a mutation)" || bad "M01: default is not dry-run: [$(m01_test "")]"
[ "$(m01_test "--apply")" = EXECUTED ] && pass "M01: reconcile --apply DOES execute (guards against a no-op default)" || bad "M01: --apply did not execute: [$(m01_test "--apply")]"

# --- M02: defeat the readonly=1 suppression gate. A READ-ONLY run where the box
# decision WOULD be `mint` (offline + tunnel up) must STILL suppress the mutation.
# Unlike the old test (empty inputs => noop), this feeds a mint-worthy decision.
m02_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STATE="\$(mktemp -d)"
BOX_ROOT="/nonexistent"
FLEET_TARGET_SHA=""
RECONCILE_READONLY=1
MARK="\$(mktemp)"; : > "\$MARK"
log(){ :; }; notify(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index reconcile_one reconcile_decide box_index reconcile_bump_checkfail reconcile_reset_checkfail reconcile_reset_seedfail reconcile_bump_seedfail reconcile_reset_asleep reconcile_reset_incoherent mint_window_valid days_until; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
# Feed a mint-worthy decision: online=no, tunnel up. dev_field is unused because
# devs is non-empty here; provide it. But make it read-only (arg 4 = 1) AND apply=1.
dev_field(){ case "\$3" in online) echo no;; fresh) echo yes;; dupcount) echo 1;; both_online) echo no;; *) echo "";; esac; }
tunnel_up(){ return 0; }
tunnel_ssh(){ return 0; }
reconcile_execute(){ echo "EXECUTED:\$2" >> "\$MARK"; return 0; }
# apply=1 but readonly=1 => the readonly gate MUST suppress the mint.
reconcile_one grok-box-8 '{"devices":[]}' 1 1 >/dev/null 2>&1
if grep -q EXECUTED "\$MARK"; then echo "EXECUTED"; else echo "SUPPRESSED"; fi
rm -rf "\$FLEET_STATE" "\$MARK"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"
}
[ "$(m02_test)" = SUPPRESSED ] && pass "M02: read-only run suppresses a mint-worthy decision (readonly gate holds)" || bad "M02: readonly gate defeated: [$(m02_test)]"

# --- M03: the stale-device selector must pick the OLDER *OFFLINE* device, never
# the oldest overall. Fixture: an OLDER device that is ONLINE + a NEWER device
# that is OFFLINE. stale_id must be the OFFLINE (newer) one, NOT the older online.
# If the `.online != true` filter is removed, stale_id would be the older online.
m03_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STALE_SECS=600
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" dev_field)"
# OLDER = online (earliest lastSeen so it sorts FIRST if the filter is removed),
# NEWER = offline (the corpse to delete). With the offline-only filter, stale is
# NEW_OFFLINE; if the filter is removed (M03), sort-by-lastSeen picks OLD_ONLINE.
devs='{"devices":[
  {"hostname":"grok-box-8","nodeId":"OLD_ONLINE","online":true,"created":"2000-01-01T00:00:00Z","lastSeen":"2000-01-01T00:00:00Z"},
  {"hostname":"grok-box-8-1","nodeId":"NEW_OFFLINE","online":false,"created":"2020-01-01T00:00:00Z","lastSeen":"2020-01-01T00:00:00Z"}
]}'
echo "stale=\$(dev_field "\$devs" grok-box-8 stale_id)"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(m03_test)" = "stale=NEW_OFFLINE" ] && pass "M03: stale selector picks the OFFLINE duplicate, never an older ONLINE node" || bad "M03: stale selector wrong (offline-only filter defeated): [$(m03_test)]"

# --- M11: the auth key must NEVER appear in the remote SSH command ARGV (it is
# streamed on stdin only). Capture tunnel_ssh's remote command string and assert
# the key material is absent from it. If the key were appended to argv (M11),
# the capture would contain it.
m11_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<'INNER'
set -u
FLEETCTL="__FLEETCTL__"
BOXROOT="$(mktemp -d)"; mkdir -p "$BOXROOT/secrets"
BOX_ROOT="$BOXROOT"
BOX_AUTHKEY="$BOXROOT/secrets/ts-authkey"
BOX_AUTHKEY_TMP="$BOXROOT/secrets/.ts-authkey.tmp"
BOX_AUTHKEY_EXPIRES="$BOXROOT/secrets/ts-authkey.expires"
log(){ :; }
extract_from(){ awk -v fn="$2" '$0 ~ "^"fn"\\(\\) \\{"{i=1} i{print} i&&/^\}$/{exit}' "$1"; }
eval "$(extract_from "$FLEETCTL" seed_key_over_tunnel)"
eval "$(extract_from "$FLEETCTL" seed_status_converged)"
cap="$(mktemp)"
# tunnel_ssh stub: record the remote command ARGV, and for the seed run consume
# stdin so the write still succeeds (so we exercise the real code path).
tunnel_ssh(){
  shift
  printf 'ARGV:%s\n' "$*" >> "$cap"
  case "$*" in
    *"boxup status"*) echo "backend=Running tunnel=up"; return 0 ;;
    *) bash -c "$*" ;;   # runs the seed heredoc; key arrives on stdin
  esac
}
seed_key_over_tunnel grok-box-8 "SENTINEL_SECRET_KEY_MATERIAL" "2099-01-01" >/dev/null 2>&1
if grep -q "SENTINEL_SECRET_KEY_MATERIAL" "$cap"; then echo "KEY-IN-ARGV"; else echo "KEY-ABSENT"; fi
rm -rf "$BOXROOT" "$cap"
INNER
  sed -i "s#__FLEETCTL__#$FLEETCTL#" "$inner"
  timeout 20 bash "$inner"; rm -f "$inner"
}
[ "$(m11_test)" = "KEY-ABSENT" ] && pass "M11: the auth key never appears in the remote SSH argv (stdin-only)" || bad "M11: key leaked into the SSH command argv: [$(m11_test)]"

# --- M13: the seeded auth key file must be chmod 600, not 644. Drive the REAL
# seed against a fake box tree and stat the resulting file mode.
m13_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<'INNER'
set -u
FLEETCTL="__FLEETCTL__"
BOXROOT="$(mktemp -d)"; mkdir -p "$BOXROOT/secrets"
BOX_ROOT="$BOXROOT"
BOX_AUTHKEY="$BOXROOT/secrets/ts-authkey"
BOX_AUTHKEY_TMP="$BOXROOT/secrets/.ts-authkey.tmp"
BOX_AUTHKEY_EXPIRES="$BOXROOT/secrets/ts-authkey.expires"
log(){ :; }
extract_from(){ awk -v fn="$2" '$0 ~ "^"fn"\\(\\) \\{"{i=1} i{print} i&&/^\}$/{exit}' "$1"; }
eval "$(extract_from "$FLEETCTL" seed_key_over_tunnel)"
eval "$(extract_from "$FLEETCTL" seed_status_converged)"
tunnel_ssh(){ shift; case "$*" in *"boxup status"*) echo "backend=Running tunnel=up"; return 0 ;; *) bash -c "$*" ;; esac; }
seed_key_over_tunnel grok-box-8 "FRESH" "2099-01-01" >/dev/null 2>&1
stat -c '%a' "$BOX_AUTHKEY" 2>/dev/null
rm -rf "$BOXROOT"
INNER
  sed -i "s#__FLEETCTL__#$FLEETCTL#" "$inner"
  timeout 20 bash "$inner"; rm -f "$inner"
}
[ "$(m13_test)" = 600 ] && pass "M13: the seeded auth key is chmod 600 (not 644)" || bad "M13: auth key mode wrong: [$(m13_test)]"

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
  # fleetctl stub that just echoes its args, capturing whether --apply is added.
  local execline
  execline="$(grep -E '^ExecStart=' "$pfx/etc/systemd/system/fleet-reconcile.service" | sed 's/^ExecStart=//')"
  # Replace the real fleetctl path invocation with an echo shim by shadowing PATH:
  # simplest is to run the inner bash -c payload directly with a fake fleetctl.
  local payload
  payload="$(printf '%s' "$execline" | sed -E "s#^/bin/bash -c '##; s#'\$##")"
  # Provide a fleetctl shim on PATH.
  local bindir="$pfx/bin"; mkdir -p "$bindir"
  # The payload calls $OPT_DIR/fleetctl reconcile $apply; shadow that exact path.
  cat > "$pfx/opt/grok-fleet/fleetctl" <<'SHIM'
#!/bin/bash
echo "FLEETCTL-ARGS:$*"
SHIM
  chmod +x "$pfx/opt/grok-fleet/fleetctl"
  bash -c "$payload" 2>/dev/null
  rm -rf "$pfx"
}
case "$(m21_test true)" in *"FLEETCTL-ARGS:reconcile --apply"*) pass "M21: config apply=true => wrapper runs reconcile --apply" ;; *) bad "M21: apply=true did not add --apply: [$(m21_test true)]" ;; esac
case "$(m21_test false)" in
  *"--apply"*) bad "M21: config apply=false WRONGLY added --apply (gate inverted): [$(m21_test false)]" ;;
  *"FLEETCTL-ARGS:reconcile"*) pass "M21: config apply=false => wrapper runs reconcile (no --apply)" ;;
  *) bad "M21: apply=false wrapper wrong: [$(m21_test false)]" ;;
esac

# --- M23: the API-failure notify fires at the 3rd consecutive failure (>=3), not
# the 4th. Drive the REAL reconcile_record_api_failure three times against a
# clean state and assert notify() fired exactly on the 3rd call.
m23_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STATE="\$(mktemp -d)"
log(){ :; }
notify(){ echo "NOTIFY:\$*" >> "\$FLEET_STATE/notes"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" reconcile_record_api_failure)"
: > "\$FLEET_STATE/notes"
reconcile_record_api_failure; n1=\$(grep -c NOTIFY "\$FLEET_STATE/notes"); :
reconcile_record_api_failure; n2=\$(grep -c NOTIFY "\$FLEET_STATE/notes"); :
reconcile_record_api_failure; n3=\$(grep -c NOTIFY "\$FLEET_STATE/notes"); :
echo "after1=\$n1 after2=\$n2 after3=\$n3"
rm -rf "\$FLEET_STATE"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
m23="$(m23_test)"
case "$m23" in
  "after1=0 after2=0 after3=1") pass "M23: API-failure notify fires at the 3rd consecutive failure (>=3, not >=4)" ;;
  *) bad "M23: API alert threshold wrong: [$m23]" ;;
esac

echo "-----"
# =============================================================================
# r3 COVERAGE-GAP KILLS — lock the r2-fix safety properties whose mutants (N1,
# N2, N3, N5, N6) SURVIVED the 81-assertion suite (empirical-gate r3 P1-A..D,
# P2-A). Each assertion drives the REAL function and was verified to FLIP
# (PASS->FAIL) under the gate's exact mutant on a scratch copy of fleetctl.
# See the commit message for the mutant->test ledger.
# =============================================================================

# --- P1-A / N1: the 90-day clamp must hold on BOTH the mint_payload argument AND
# the FLEET_KEY_EXPIRY_SECS env. N1 (`clamp_expiry_secs` `-le`->`-ge`) defeats
# the cap (99999999 stays; a valid 3600 wrongly becomes 7776000). Drive the REAL
# mint_payload with an OVER-CAP arg + env, and clamp_expiry_secs with a valid
# in-range value (which N1 corrupts to the cap).
clamp_over_cap_test() {
  local mode="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" clamp_expiry_secs)"
eval "\$(extract_from "\$FLEETCTL" mint_payload)"
case "$mode" in
  arg)   mint_payload 99999999 | jq -r '.expirySeconds' ;;
  env)   FLEET_KEY_EXPIRY_SECS=99999999 mint_payload | jq -r '.expirySeconds' ;;
  valid) clamp_expiry_secs 3600 ;;
esac
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(clamp_over_cap_test arg)"   = 7776000 ] && pass "P1-A/N1: mint_payload ARG over 90d is clamped DOWN to 7776000 (cap invariant)" || bad "P1-A/N1: arg over-cap not clamped: [$(clamp_over_cap_test arg)]"
[ "$(clamp_over_cap_test env)"   = 7776000 ] && pass "P1-A/N1: FLEET_KEY_EXPIRY_SECS over 90d is clamped DOWN to 7776000" || bad "P1-A/N1: env over-cap not clamped: [$(clamp_over_cap_test env)]"
[ "$(clamp_over_cap_test valid)" = 3600 ]    && pass "P1-A/N1: a valid in-range expiry passes through UNCHANGED (not forced to the cap)" || bad "P1-A/N1: valid expiry corrupted (clamp direction wrong): [$(clamp_over_cap_test valid)]"

# --- P1-C / N2: devices_json_valid must FAIL-CLOSED on a truncated/garbage
# HTTP-200 body and on a wrong-typed `.devices`. N2 (always-true) accepts them,
# defeating the B-1 malformed-200 READ-ONLY latch. Drive the REAL function.
devjson_valid_test() {
  local body="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" devices_json_valid)"
if devices_json_valid '$body'; then echo VALID; else echo INVALID; fi
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(devjson_valid_test '{"devices":')"       = INVALID ] && pass "P1-C/N2: a truncated HTTP-200 body is INVALID => forces READ-ONLY (fail-closed)" || bad "P1-C/N2: truncated 200 accepted as valid: [$(devjson_valid_test '{"devices":')]"
[ "$(devjson_valid_test '{"devices":{"a":1}}')" = INVALID ] && pass "P1-C/N2: a wrong-typed .devices (object, not array) is INVALID" || bad "P1-C/N2: wrong-typed .devices accepted as valid: [$(devjson_valid_test '{"devices":{"a":1}}')]"

# --- P1-D / N5: record_key_meta must REFUSE a blank key id (return non-zero AND
# write no meta file) — the invariant that a later rotation can revoke the key.
# N5 (drop the blank-id guard) accepts a blank id and writes a {"id":""} file.
record_blank_id_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STATE="\$(mktemp -d)"
FLEET_KEYS_DIR="\$FLEET_STATE/keys"
log(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index record_key_meta key_meta_file box_index; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
if record_key_meta grok-box-8 "" "2099-01-01T00:00:00Z"; then echo "rc=0"; else echo "rc=1"; fi
f="\$FLEET_KEYS_DIR/8.json"
[ -f "\$f" ] && echo "file=present" || echo "file=absent"
rm -rf "\$FLEET_STATE"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
rkm="$(record_blank_id_test)"
case "$rkm" in
  *"rc=1"*"file=absent"*) pass "P1-D/N5: record_key_meta REFUSES a blank id (non-zero, no meta file written)" ;;
  *) bad "P1-D/N5: record_key_meta accepted a blank id: [$rkm]" ;;
esac

# --- P2-A / N3: tunnel_deploy_one's OWN push-less guard must refuse (non-zero)
# and make NO scp/ssh call when FLEET_ROLLOUT_TREE is unset. N3 (drop the guard)
# scp's the empty/unset tree and proceeds rc=0.
deploy_pushless_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
BOX_ROOT="/workspace/box-setup"
log(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index tunnel_deploy_one tunnel_ssh tunnel_scp port_for box_index; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
unset FLEET_ROLLOUT_TREE
cap="\$(mktemp)"
ssh(){ printf 'SSH %s\n' "\$*" >> "\$cap"; return 0; }
scp(){ printf 'SCP %s\n' "\$*" >> "\$cap"; return 0; }
if tunnel_deploy_one grok-box-8 >/dev/null 2>&1; then echo "rc=0"; else echo "rc=1"; fi
[ -s "\$cap" ] && echo "transport=called" || echo "transport=none"
rm -f "\$cap"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
dpl="$(deploy_pushless_test)"
case "$dpl" in
  *"rc=1"*"transport=none"*) pass "P2-A/N3: tunnel_deploy_one refuses a push-less deploy (non-zero, ZERO scp/ssh) when no tree staged" ;;
  *) bad "P2-A/N3: tunnel_deploy_one ran push-less (scp'd empty tree): [$dpl]" ;;
esac

# --- P1-B / N6: the RUN-WIDE READ-ONLY latch inside reconcile_one must suppress
# a LATER mutation once an EARLIER action latches RECONCILE_READONLY mid-call —
# even though the per-call `readonly` arg is 0 and apply=1. N6 (drop the
# `${RECONCILE_READONLY:-0}` check in reconcile_one) runs the 2nd mutation.
# Drive the REAL reconcile_one loop: reconcile_decide emits TWO mutating actions;
# reconcile_execute LATCHES on the first and records both attempts.
readonly_latch_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STATE="\$(mktemp -d)"
BOX_ROOT="/nonexistent"
FLEET_TARGET_SHA=""
MARK="\$(mktemp)"; : > "\$MARK"
log(){ :; }; notify(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index reconcile_one box_index reconcile_bump_checkfail reconcile_reset_checkfail reconcile_reset_seedfail reconcile_bump_seedfail reconcile_reset_asleep reconcile_reset_incoherent mint_window_valid days_until; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
# Two mutating actions this run; neither is 'mint' (avoid the mint-window guard).
reconcile_decide(){ printf 'delete-then-rename\nrollout\n'; }
tunnel_up(){ return 1; }          # tunnel down => no boxup check side effects
# reconcile_execute: the FIRST action latches the run-wide read-only latch (as a
# real action-time API failure would), then the SECOND must be SUPPRESSED.
reconcile_execute(){ echo "EXEC:\$2" >> "\$MARK"; RECONCILE_READONLY=1; return 0; }
# apply=1, per-call readonly=0 => ONLY the run-wide latch can suppress action 2.
reconcile_one grok-box-8 '{"devices":[]}' 1 0 >/dev/null 2>&1
tr '\n' '|' < "\$MARK"; echo
rm -rf "\$FLEET_STATE" "\$MARK"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"
}
latch="$(readonly_latch_test)"
case "$latch" in
  "EXEC:delete-then-rename|") pass "P1-B/N6: an earlier action's mid-call latch suppresses every LATER mutation this run (run-wide read-only latch)" ;;
  *"EXEC:rollout"*) bad "P1-B/N6: a later mutation RAN after the run-wide latch was set (latch defeated): [$latch]" ;;
  *) bad "P1-B/N6: unexpected reconcile_one behaviour: [$latch]" ;;
esac

echo "-----"
# =============================================================================
# SET -U / HOME + EXEC-STDERR FOOTGUNS (VPS bring-up bugs A & B).
#   A: fleetctl must load and run under systemd's environment (FLEET_* + PATH,
#      but NO HOME) without aborting on an unbound $HOME. The load-time footgun
#      is a top-level `$HOME` expansion evaluated under `set -u` before dispatch.
#   B: `exec 9>"$lock" 2>/dev/null` (redirections, no command) makes 2>/dev/null
#      PERMANENT for the process and swallows every log() (all stderr) — so
#      `reconcile` runs silently. The fix opens the fd without a persistent
#      stderr redirect, so log lines after the lock still reach stderr.
# Both are mutation-verified: reverting either fix in a scratch copy flips the
# matching assertion PASS->FAIL (see the harness comments below).
# =============================================================================

# --- BUG-A: real fleetctl under `env -i` with ONLY the systemd-unit variables
# (FLEET_CONFIG/FLEET_ETC/FLEET_STATE, PATH) — exactly what fleet-reconcile.service
# provides — must NOT abort on an unbound HOME. We drive `version` (a no-op that
# still executes ALL top-level assignments at load, which is where the unbound
# $HOME trips). breaks-if-undone: revert either `${HOME:-}` guard (line ~36
# CONFIG_FILE default arm — only when FLEET_CONFIG is UNSET — or the
# unconditional line ~705 UNIT_DIR) and this aborts with
# "HOME: unbound variable", exit 1.
home_unbound_test() {
  local st; st="$(mktemp -d)"
  # env -i: a pristine environment with NO HOME, mirroring the systemd unit.
  local out rc
  out="$(env -i \
      FLEET_CONFIG="$st/config.toml" \
      FLEET_ETC="$st/etc" \
      FLEET_STATE="$st" \
      PATH=/usr/bin:/bin \
      bash "$FLEETCTL" version 2>&1)"; rc=$?
  rm -rf "$st"
  printf '%s|rc=%s' "$out" "$rc"
}
hu="$(home_unbound_test)"
case "$hu" in
  *"HOME: unbound variable"*|*"unbound variable"*)
    bad "BUG-A: fleetctl aborts on unbound HOME under systemd env (set -u): [$hu]" ;;
  "fleetctl "*"|rc=0")
    pass "BUG-A: fleetctl loads+runs under env -i with only systemd-unit vars (no HOME) — no unbound-\$HOME abort" ;;
  *) bad "BUG-A: unexpected fleetctl behaviour under env -i (no HOME): [$hu]" ;;
esac

# Also assert there is NO unguarded top-level `$HOME` expansion left in fleetctl.
# "Top-level" = a line that is neither indented (inside a function/block) nor a
# comment. Every top-level $HOME must be written ${HOME:-...}. breaks-if-undone:
# a future bare top-level $HOME re-introduces the load-time abort.
unguarded_home="$(grep -nE '^[A-Za-z_][A-Za-z0-9_]*=.*\$(HOME|\{HOME\})([^:-]|$)' "$FLEETCTL" | grep -v '\${HOME:-' || true)"
if [ -z "$unguarded_home" ]; then
  pass "BUG-A: no unguarded top-level \$HOME expansion remains in fleetctl (all use \${HOME:-})"
else
  bad "BUG-A: unguarded top-level \$HOME expansion(s) still in fleetctl (would abort under set -u): $unguarded_home"
fi

# --- BUG-B: reconcile's log lines must reach stderr AFTER the lock is taken.
# Drive the REAL `fleetctl reconcile --dry-run` with the API stubbed to fail
# fast (FLEET_TS_API pointed at an unreachable loopback port => READ-ONLY run),
# capturing stderr. The lock is opened before any of these log() calls, so if
# the lock-open swallowed stderr, we'd see ZERO lines. breaks-if-undone: revert
# the lock-open to `exec 9>"$lock" 2>/dev/null || {...}` and stderr goes empty
# (mutation-verified: 4 lines -> 0 lines, still exit 0).
reconcile_logs_to_stderr_test() {
  local st; st="$(mktemp -d)"
  local err; err="$(mktemp)"
  # HOME is supplied here (interactive-style run); this test is about stderr, not
  # the HOME footgun. API unreachable => fast READ-ONLY run that still logs.
  env FLEET_STATE="$st" \
      FLEET_ETC="$st/etc" \
      FLEET_CONFIG="$st/config.toml" \
      FLEET_TS_API="http://127.0.0.1:1" \
      HOME="$st" \
      PATH=/usr/bin:/bin \
      bash "$FLEETCTL" reconcile --dry-run >/dev/null 2>"$err"
  local n; n="$(wc -l < "$err" | tr -d ' ')"
  local start=MISSING
  grep -q "reconcile: start" "$err" && start=PRESENT
  printf 'lines=%s|start=%s' "$n" "$start"
  rm -rf "$st" "$err"
}
rl="$(reconcile_logs_to_stderr_test)"
case "$rl" in
  "lines=0|"*|*"start=MISSING")
    bad "BUG-B: reconcile log lines did NOT reach stderr after the lock (stderr swallowed): [$rl]" ;;
  "lines="*"|start=PRESENT")
    pass "BUG-B: reconcile log lines reach stderr after the lock is taken (no permanent 2>/dev/null): [$rl]" ;;
  *) bad "BUG-B: unexpected reconcile stderr behaviour: [$rl]" ;;
esac

# --- BUG-A (installer side): the reconcile service UNIT template must set
# Environment=HOME= so systemd (which does not export HOME for a system service)
# gives fleetctl a HOME and the timer run never aborts on unbound $HOME.
# breaks-if-undone: drop the `Environment=HOME=` line and every timer run fails
# status=1/FAILURE before cmd_reconcile.
service_home_env_test() {
  local pfx; pfx="$(mktemp -d)"
  PREFIX="$pfx" bash "$VPS_INSTALL" >/dev/null 2>&1
  local svc="$pfx/etc/systemd/system/fleet-reconcile.service"
  if grep -q '^Environment=HOME=' "$svc"; then echo "HAS-HOME"; else echo "NO-HOME"; fi
  rm -rf "$pfx"
}
[ "$(service_home_env_test)" = HAS-HOME ] \
  && pass "BUG-A: fleet-reconcile.service unit sets Environment=HOME= (systemd gives fleetctl a HOME)" \
  || bad "BUG-A: fleet-reconcile.service unit missing Environment=HOME= (timer runs will abort on unbound \$HOME)"

# --- Footgun sweep: no OTHER `exec N>... 2>/dev/null` (redirections + no
# command) shape may exist in fleetctl / boxup / install-vps.sh. The ONLY
# sanctioned form is the brace-scoped `{ exec N>...; } 2>/dev/null`, where the
# redirect applies to the group, not the whole process. breaks-if-undone: a new
# bare `exec N>f 2>/dev/null` re-introduces the silent-stderr footgun.
exec_footgun="$(grep -nE '(^|[^}] *)exec [0-9]+>[^;]*2>/dev/null' "$FLEETCTL" "$BOXUP" "$VPS_INSTALL" 2>/dev/null | grep -vE ':[0-9]+: *#' || true)"
if [ -z "$exec_footgun" ]; then
  pass "BUG-B: no bare \`exec N>... 2>/dev/null\` (persistent-stderr) shape in fleetctl/boxup/install-vps.sh"
else
  bad "BUG-B: a bare \`exec N>... 2>/dev/null\` shape still present (swallows stderr): $exec_footgun"
fi

# --- BUG-E: after ANY write of ~fleet/.ssh/authorized_keys, the dir must end
# 700 and the file 600, and BOTH must be chown'd to the configured fleet user
# ($FLEET_VPS_USER, honoring FLEET_USER) — NOT left root:root. The brain runs as
# root; sshd privsep reads authorized_keys AS the fleet user, so a root-owned
# file yields "Could not open user 'fleet' authorized keys ... Permission denied"
# and every tunnel fails publickey. We drive the REAL enroll_install_vps_authorized_key
# against a temp dir with a PATH shim that RECORDS every chown/chmod invocation
# (the test user cannot actually chown to 'fleet', so the shim logs + no-ops).
# breaks-if-undone (mutation-verified below): drop the chown and the recorder
# shows no `chown ... fleet:fleet` line -> this test FAILS.
enroll_authkeys_owner_test() {
  local pfx; pfx="$(mktemp -d)"
  local bindir="$pfx/bin"; mkdir -p "$bindir"
  local rec="$pfx/rec.log"
  # Recorder shims: log the full argv, then no-op success (real chown to 'fleet'
  # is not possible as an unprivileged test user). Fall through to real tools for
  # everything else via the appended real PATH.
  cat > "$bindir/chown" <<SHIM
#!/usr/bin/env bash
printf 'chown %s\n' "\$*" >> "$rec"
exit 0
SHIM
  cat > "$bindir/chmod" <<SHIM
#!/usr/bin/env bash
printf 'chmod %s\n' "\$*" >> "$rec"
exit 0
SHIM
  chmod +x "$bindir/chown" "$bindir/chmod"
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
export PATH="$bindir:\$PATH"
FLEETCTL="$FLEETCTL"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
# The REAL config var + the two REAL functions under test.
FLEET_VPS_USER="fleet"
FLEET_VPS_AUTHKEYS="$pfx/home/.ssh/authorized_keys"
eval "\$(extract_from "\$FLEETCTL" ensure_vps_authkeys_perms)"
eval "\$(extract_from "\$FLEETCTL" enroll_install_vps_authorized_key)"
enroll_install_vps_authorized_key 'restrict,port-forwarding,permitlisten="127.0.0.1:20003" ssh-ed25519 AAAAKEY grok-tunnel-grok-box-3'
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
  # Emit the recorder log for the caller to assert against.
  cat "$rec" 2>/dev/null
  rm -rf "$pfx"
}
akrec="$(enroll_authkeys_owner_test)"
# (a) a chown to fleet:fleet on the .ssh dir/file must have happened.
case "$akrec" in
  *"chown "*"fleet:fleet"*)
    pass "BUG-E: enroll chowns ~fleet/.ssh authorized_keys to fleet:fleet (sshd privsep can read it)" ;;
  *) bad "BUG-E: enroll did NOT chown authorized_keys to the fleet user (stays root:root -> Permission denied publickey): [$akrec]" ;;
esac
# (b) the file must be chmod'd 600 and the dir 700 (belt-and-braces on perms).
case "$akrec" in
  *"chmod 600 "*) pass "BUG-E: enroll chmods authorized_keys file 600" ;;
  *) bad "BUG-E: enroll missing chmod 600 on authorized_keys file: [$akrec]" ;;
esac
case "$akrec" in
  *"chmod 700 "*) pass "BUG-E: enroll chmods ~fleet/.ssh dir 700" ;;
  *) bad "BUG-E: enroll missing chmod 700 on ~fleet/.ssh dir: [$akrec]" ;;
esac

# --- BUG-E (var): the fleet user must come from a CONFIGURED var, not a literal.
# Assert FLEET_VPS_USER exists in fleetctl and defaults through FLEET_USER.
# breaks-if-undone: hardcode a literal 'fleet' in the chown and this fails.
if grep -qE '^FLEET_VPS_USER="\$\{FLEET_VPS_USER:-\$\{FLEET_USER:-fleet\}\}"' "$FLEETCTL"; then
  pass "BUG-E: FLEET_VPS_USER is a configured var (honors FLEET_VPS_USER / FLEET_USER, default fleet)"
else
  bad "BUG-E: FLEET_VPS_USER not defined as a configurable var in fleetctl (chown must not use a literal)"
fi

# --- BUG-E (installer): install-vps.sh's ensure_fleet_user must chown ~fleet/.ssh
# to the fleet user when it creates it. breaks-if-undone: drop the chown -R and
# a freshly-installed box's dir is root:root before the first enroll.
if grep -qE 'chown -R "\$FLEET_USER":"\$FLEET_USER" "\$home/\.ssh"' "$VPS_INSTALL"; then
  pass "BUG-E: install-vps.sh ensure_fleet_user chowns ~fleet/.ssh to the fleet user on create"
else
  bad "BUG-E: install-vps.sh ensure_fleet_user does not chown ~fleet/.ssh to the fleet user"
fi

# =============================================================================
# BUG-F — reconcile_alert_asleep MUST NOT crash under `set -u` when no prior
# .asleep state file exists, and enroll's enrolled.tsv append must be idempotent.
# =============================================================================
# LIVE CRASH (fleet-reconcile.service, 4 consecutive failures 01:43-01:59Z):
# reconcile_alert_asleep declared `since`/`last` as bare locals, then only read
# them INSIDE `if [ -f "$f" ]`. First-ever both-dead => the file is absent, the
# read is skipped, and `case "$since"` aborts under `set -u` with
# "since: unbound variable" (service exits 1, keeps failing every 5-min tick).
# breaks-if-undone: revert the `since=""`/`last=""` init and this test crashes.
# Drive the REAL reconcile_alert_asleep via extract_from+eval, FLEET_STATE at a
# temp dir with NO pre-existing .asleep file, T=0 so the first alert fires.
asleep_test() {
  local pre="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STATE="\$(mktemp -d)"
FLEET_ASLEEP_T_SECS=0
FLEET_ASLEEP_DIGEST_SECS=86400
notify(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" reconcile_alert_asleep)"
f="\$FLEET_STATE/grok-box-1.asleep"
# Optionally pre-seed the state file to exercise the parse branch.
[ -n "$pre" ] && printf '%s\n' "$pre" > "\$f"
if reconcile_alert_asleep grok-box-1; then echo "rc=0"; else echo "rc=\$?"; fi
if [ -f "\$f" ]; then
  read -r s l < "\$f"
  # Report whether <since> is a plausible epoch (>0) and last was advanced.
  case "\$s" in ''|*[!0-9]*) echo "since=BAD" ;; *) [ "\$s" -gt 0 ] && echo "since=OK" || echo "since=ZERO" ;; esac
  case "\$l" in ''|*[!0-9]*) echo "last=BAD" ;; *) echo "last=\$l" ;; esac
else
  echo "NO-STATE"
fi
rm -rf "\$FLEET_STATE"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
# (a) No pre-existing file: must NOT crash (rc=0), must write "<now> <last>"
#     with a plausible since epoch (the exact both-dead observation timestamp).
asleep_fresh="$(asleep_test "")"
case "$asleep_fresh" in
  *"rc=0"*"since=OK"*) pass "BUG-F: reconcile_alert_asleep with NO prior .asleep file does not crash under set -u; writes <now> state" ;;
  *since=BAD*|*NO-STATE*) bad "BUG-F: reconcile_alert_asleep crashed / wrote no since (unbound var regression): [$asleep_fresh]" ;;
  *) bad "BUG-F: reconcile_alert_asleep fresh run wrong: [$asleep_fresh]" ;;
esac
# With T=0 the first-ever call fires the alert and stamps last=<now> (>0).
case "$asleep_fresh" in
  *"last=0"*) bad "BUG-F: reconcile_alert_asleep did not advance last after firing first alert (T=0): [$asleep_fresh]" ;;
  *last=BAD*) bad "BUG-F: reconcile_alert_asleep wrote a bad last field: [$asleep_fresh]" ;;
  *) pass "BUG-F: reconcile_alert_asleep first alert (T=0) stamps last=<now>" ;;
esac
# (b) Second/subsequent call with an EXISTING file parses it (a valid two-epoch
#     line is preserved, not reset). Pre-seed "<old-since> <recent-last>" so the
#     digest window has NOT elapsed => last stays exactly as seeded.
asleep_existing="$(asleep_test "100 4000000000")"
case "$asleep_existing" in
  *"rc=0"*"since=OK"*"last=4000000000"*) pass "BUG-F: reconcile_alert_asleep parses an EXISTING .asleep file (since kept, last within digest window preserved)" ;;
  *) bad "BUG-F: reconcile_alert_asleep did not parse existing state correctly: [$asleep_existing]" ;;
esac

# (c) enroll append is IDEMPOTENT: two enrolls of the same box leave ONE row.
# Live enrolled.tsv had grok-box-8 twice (append with no dedup). Drive the REAL
# enroll_record_enrolled twice and assert a single row survives.
enroll_idem_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STATE="\$(mktemp -d)"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" enroll_record_enrolled)"
enroll_record_enrolled grok-box-8 20008
enroll_record_enrolled grok-box-8 20008
# A neighbouring box must be untouched by the grok-box-8 dedup (prefix guard).
enroll_record_enrolled grok-box-1 20001
enroll_record_enrolled grok-box-1 20001
enr="\$FLEET_STATE/enrolled.tsv"
echo "rows8=\$(grep -c '^grok-box-8	' "\$enr")"
echo "rows1=\$(grep -c '^grok-box-1	' "\$enr")"
echo "total=\$(wc -l < "\$enr" | tr -d ' ')"
rm -rf "\$FLEET_STATE"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
enroll_idem="$(enroll_idem_test)"
case "$enroll_idem" in
  *"rows8=1"*) pass "BUG-F: enroll append is idempotent — two enrolls of grok-box-8 leave ONE row" ;;
  *) bad "BUG-F: enroll append not idempotent for grok-box-8: [$enroll_idem]" ;;
esac
case "$enroll_idem" in
  *"rows1=1"*"total=2"*) pass "BUG-F: enroll dedup is per-box (grok-box-1 unaffected by grok-box-8 dedup; total 2 rows)" ;;
  *) bad "BUG-F: enroll dedup clobbered a neighbouring box or row count wrong: [$enroll_idem]" ;;
esac

# =============================================================================
# ENROLL BOX-CONFIG (feat/enroll-one-step) — enroll writes the box's OWN
# config.toml [fleet] block (vps + box_index) over the SAME box_ssh channel it
# used to READ the tunnel pubkey, so the reverse tunnel dials without a manual
# hand-edit. Drives the REAL enroll_write_box_config + fleet_vps_addr via the
# extract_from+eval harness with a FAKE box_ssh recorder that runs the remote
# `sh -s` script LOCALLY against a fake box config tree (stdin = the script,
# positional args = vps/idx/cfg — exactly the real transport shape).
# Assertions: fresh config gets the block; same-values existing block untouched
# (byte-compare); differing block replaced without duplication; mode preserved;
# --no-box-config skips the write.
# =============================================================================

# fleet_vps_addr precedence (D1): FLEET_VPS_ADDR env > config [fleet-brain].vps
# > REFUSE (return non-zero, empty output — there is NO baked default). The
# section is [fleet-brain] (brain-side config), NOT [fleet] (the box-side block
# enroll writes).
vpsaddr_test() {
  local mode="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" fleet_vps_addr)"
if [ "$mode" = env ]; then
  export FLEET_VPS_ADDR="9.9.9.9"
  config_get(){ echo "2.2.2.2"; }            # env must WIN over config
elif [ "$mode" = config ]; then
  unset FLEET_VPS_ADDR 2>/dev/null || true
  # Must read [fleet-brain].vps — NOT [fleet].vps (which is the box-side block).
  config_get(){ [ "\$1" = fleet-brain ] && [ "\$2" = vps ] && { echo "2.2.2.2"; return 0; }; return 1; }
else
  unset FLEET_VPS_ADDR 2>/dev/null || true
  config_get(){ return 1; }                  # nothing set => REFUSE
fi
if fleet_vps_addr; then :; else echo "REFUSE(rc=\$?)"; fi
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(vpsaddr_test env)" = "9.9.9.9" ] && pass "enroll-cfg(D1): fleet_vps_addr FLEET_VPS_ADDR env WINS over config" || bad "fleet_vps_addr env wrong: [$(vpsaddr_test env)]"
[ "$(vpsaddr_test config)" = "2.2.2.2" ] && pass "enroll-cfg(D1): fleet_vps_addr falls back to config [fleet-brain].vps (NOT [fleet])" || bad "fleet_vps_addr config wrong: [$(vpsaddr_test config)]"
case "$(vpsaddr_test default)" in
  "REFUSE("*) pass "enroll-cfg(D1): fleet_vps_addr with nothing set => REFUSE (no baked default)" ;;
  *)  bad "fleet_vps_addr should refuse when unresolved, got: [$(vpsaddr_test default)]" ;;
esac
# Static: the baked default global must be GONE (D1 — no third fallback).
if grep -q 'FLEET_VPS_ADDR_DEFAULT' "$FLEETCTL"; then
  bad "enroll-cfg(D1): FLEET_VPS_ADDR_DEFAULT still present in fleetctl (must be deleted)"
else
  pass "enroll-cfg(D1): baked FLEET_VPS_ADDR_DEFAULT is DELETED (env/config-only, then refuse)"
fi

# fleet_vps_port precedence (D3b): FLEET_VPS_PORT env > config [fleet-brain].vps_port
# > 22. Always resolves (22 is the default).
vpsport_test() {
  local mode="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" fleet_vps_port)"
if [ "$mode" = env ]; then
  export FLEET_VPS_PORT="2222"
  config_get(){ echo "3333"; }               # env WINS
elif [ "$mode" = config ]; then
  unset FLEET_VPS_PORT 2>/dev/null || true
  config_get(){ [ "\$1" = fleet-brain ] && [ "\$2" = vps_port ] && { echo "3333"; return 0; }; return 1; }
else
  unset FLEET_VPS_PORT 2>/dev/null || true
  config_get(){ return 1; }                  # default 22
fi
fleet_vps_port
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(vpsport_test env)" = "2222" ] && pass "enroll-cfg(D3b): fleet_vps_port FLEET_VPS_PORT env WINS over config" || bad "fleet_vps_port env wrong: [$(vpsport_test env)]"
[ "$(vpsport_test config)" = "3333" ] && pass "enroll-cfg(D3b): fleet_vps_port falls back to config [fleet-brain].vps_port" || bad "fleet_vps_port config wrong: [$(vpsport_test config)]"
[ "$(vpsport_test default)" = "22" ] && pass "enroll-cfg(D3b): fleet_vps_port default is 22" || bad "fleet_vps_port default wrong: [$(vpsport_test default)]"

# The box-config harness. Runs the REAL enroll_write_box_config with a fake
# box_ssh that executes the remote `sudo sh -s -- ...` (the WRITE) and the
# `sudo sh -c "awk..."` D10 read-backs LOCALLY (sudo stripped, stdin forwarded)
# against a fake config file. Args:
#   $1 = seed config.toml file, $2 = vps, $3 = box_index, $4 = port,
#   $5 = extra mode ('' or 'noop')
# Prints a series of KEY=VALUE lines the assertions match on.
boxcfg_test() {
  local seedfile="$1" vps="$2" idx="$3" port="$4" mode="${5:-}" inner; inner="$(mktemp)"
  cat > "$inner" <<'INNER'
set -u
FLEETCTL="__FLEETCTL__"
SEEDFILE="__SEEDFILE__"
WANT_VPS="__VPS__"
WANT_IDX="__IDX__"
WANT_PORT="__PORT__"
MODE="__MODE__"
log(){ :; }
BOXROOT="$(mktemp -d)"
BOX_CONFIG="$BOXROOT/config.toml"
cp "$SEEDFILE" "$BOX_CONFIG"
chmod 600 "$BOX_CONFIG"
extract_from(){ awk -v fn="$2" '$0 ~ "^"fn"\\(\\) \\{"{i=1} i{print} i&&/^\}$/{exit}' "$1"; }
eval "$(extract_from "$FLEETCTL" enroll_write_box_config)"
# FAKE box_ssh: drop the box arg, strip a leading 'sudo ', run the remaining
# command via sh with the piped remote script/awk as stdin. The real transport
# runs both `sudo sh -s -- 'vps' 'idx' 'cfg' 'port'` (WRITE, script on stdin)
# and `sudo sh -c "awk ..."` (D10 read-back) — both are handled the same way.
box_ssh(){ shift; local cmd="$*"; cmd="${cmd#sudo }"; sh -c "$cmd"; }

if enroll_write_box_config grok-box-3 "$WANT_VPS" "$WANT_IDX" "$WANT_PORT"; then echo "rc=0"; else echo "rc=$?"; fi
echo "mode=$(stat -c '%a' "$BOX_CONFIG" 2>/dev/null || stat -f '%Lp' "$BOX_CONFIG")"
echo "vps_active=$(grep -c '^vps = ' "$BOX_CONFIG")"
echo "idx_active=$(grep -c '^box_index = ' "$BOX_CONFIG")"
echo "port_active=$(grep -c '^port = ' "$BOX_CONFIG")"
echo "fleet_hdr=$(grep -c '^\[fleet\]' "$BOX_CONFIG")"
echo "vps_val=$(awk -F'"' '/^vps = /{print $2}' "$BOX_CONFIG")"
echo "idx_val=$(awk '/^box_index = /{print $3}' "$BOX_CONFIG")"
echo "port_val=$(awk '/^port = /{print $3}' "$BOX_CONFIG")"

if [ "$MODE" = noop ]; then
  # Second identical call MUST be a byte-for-byte no-op (and keep mode 600).
  cp "$BOX_CONFIG" "$BOXROOT/before"
  enroll_write_box_config grok-box-3 "$WANT_VPS" "$WANT_IDX" "$WANT_PORT" || true
  if cmp -s "$BOXROOT/before" "$BOX_CONFIG"; then echo "noop=IDENTICAL"; else echo "noop=CHANGED"; fi
  echo "mode2=$(stat -c '%a' "$BOX_CONFIG" 2>/dev/null || stat -f '%Lp' "$BOX_CONFIG")"
fi
rm -rf "$BOXROOT"
INNER
  sed -i \
    -e "s#__FLEETCTL__#$FLEETCTL#" \
    -e "s#__SEEDFILE__#$seedfile#" \
    -e "s#__VPS__#$vps#" \
    -e "s#__IDX__#$idx#" \
    -e "s#__PORT__#$port#" \
    -e "s#__MODE__#$mode#" \
    "$inner"
  timeout 20 bash "$inner"; rm -f "$inner"
}

# Seed A: the shipped template — an EXISTING [fleet] block with only COMMENTED
# vps/box_index (the real seeded config.toml). A fresh enroll must ADD active
# keys inside this block (not touch the commented template lines, not duplicate
# the block).
seedA="$(mktemp)"
cat > "$seedA" <<'CFG'
[ssh]
#password = "12345678"

[fleet]
# FLEET-BRAIN reverse tunnel.
#vps = "107.172.132.211"
#port = 22
#box_index = 8

[update]
#repo = "https://example/x.git"
CFG

fresh="$(boxcfg_test "$seedA" "1.2.3.4" 3 22 noop)"
case "$fresh" in *"rc=0"*) pass "enroll-cfg: fresh config write returns success" ;; *) bad "enroll-cfg fresh rc!=0: [$fresh]" ;; esac
case "$fresh" in *"vps_active=1"*) pass "enroll-cfg(D3a/b): fresh config gets exactly ONE active vps line" ;; *) bad "enroll-cfg fresh vps_active wrong: [$fresh]" ;; esac
case "$fresh" in *"idx_active=1"*) pass "enroll-cfg(D3b): fresh config gets exactly ONE active box_index line (insert after comment)" ;; *) bad "enroll-cfg fresh idx_active wrong: [$fresh]" ;; esac
case "$fresh" in *"fleet_hdr=1"*) pass "enroll-cfg: the [fleet] block is NEVER duplicated (one header)" ;; *) bad "enroll-cfg fleet_hdr wrong: [$fresh]" ;; esac
case "$fresh" in *"vps_val=1.2.3.4"*) pass "enroll-cfg: fresh config wrote the requested vps value" ;; *) bad "enroll-cfg vps_val wrong: [$fresh]" ;; esac
case "$fresh" in *"idx_val=3"*) pass "enroll-cfg: fresh config wrote box_index = N parsed from the box name" ;; *) bad "enroll-cfg idx_val wrong: [$fresh]" ;; esac
# D3b: port 22 => the port key is OMITTED (the commented template #port stays,
# no active port line added).
case "$fresh" in *"port_active=0"*) pass "enroll-cfg(D3b): port 22 => NO active port line written (box default stands)" ;; *) bad "enroll-cfg port22 wrote a port line: [$fresh]" ;; esac
case "$fresh" in *"mode=600"*) pass "enroll-cfg: config.toml stays mode 600 after the write" ;; *) bad "enroll-cfg mode wrong: [$fresh]" ;; esac
# Idempotency: a second identical call is a byte-for-byte no-op, mode preserved.
case "$fresh" in *"noop=IDENTICAL"*) pass "enroll-cfg(D3): re-enroll with SAME values => byte-for-byte no-op (file untouched)" ;; *) bad "enroll-cfg same-values NOT a no-op: [$fresh]" ;; esac
case "$fresh" in *"mode2=600"*) pass "enroll-cfg: no-op path leaves mode 600 (never widens the ssh-password file)" ;; *) bad "enroll-cfg no-op mode wrong: [$fresh]" ;; esac

# D3b: a NON-default port (2222) against the commented template => an active
# port line IS written (inserted after the commented #port), and idempotent.
freshport="$(boxcfg_test "$seedA" "1.2.3.4" 3 2222 noop)"
case "$freshport" in *"port_active=1"*"port_val=2222"*) pass "enroll-cfg(D3b): non-default port 2222 => exactly ONE active port line = 2222" ;; *) bad "enroll-cfg port2222 wrong: [$freshport]" ;; esac
case "$freshport" in *"noop=IDENTICAL"*) pass "enroll-cfg(D3b): port write is idempotent (same non-default port => no-op)" ;; *) bad "enroll-cfg port2222 not idempotent: [$freshport]" ;; esac

# Seed B: an ALREADY-ENROLLED config (active vps/box_index present). Re-writing
# with DIFFERING values must REPLACE them in place — no duplicate keys, no
# duplicate block, and the rest of the file preserved.
seedB="$(mktemp)"
cat > "$seedB" <<'CFG'
[ssh]
#password = "12345678"

[fleet]
vps = "10.0.0.1"
port = 22
box_index = 8

[update]
#repo = "x"
CFG
differ="$(boxcfg_test "$seedB" "9.9.9.9" 5 22)"
case "$differ" in *"vps_active=1"*"idx_active=1"*) pass "enroll-cfg(D3a): differing values REPLACE in place — still exactly one vps + one box_index" ;; *) bad "enroll-cfg differ dup keys: [$differ]" ;; esac
case "$differ" in *"fleet_hdr=1"*) pass "enroll-cfg: differing values never duplicate the [fleet] block" ;; *) bad "enroll-cfg differ dup block: [$differ]" ;; esac
case "$differ" in *"vps_val=9.9.9.9"*"idx_val=5"*) pass "enroll-cfg: differing values updated to the NEW vps + box_index" ;; *) bad "enroll-cfg differ values wrong: [$differ]" ;; esac
# D3b: an ACTIVE port=22 line + requested port 22 => the active port line is
# DROPPED (22 is the box default; the key is omitted, not written as 22).
case "$differ" in *"port_active=0"*) pass "enroll-cfg(D3b): an active port=22 with requested port 22 is DROPPED (default omitted)" ;; *) bad "enroll-cfg port22 not dropped: [$differ]" ;; esac

# Seed B differ-then-noop: after a replace, a repeat with the SAME new values is
# a no-op (proves idempotency holds on the replace path too).
differ_noop="$(boxcfg_test "$seedB" "9.9.9.9" 5 22 noop)"
case "$differ_noop" in *"noop=IDENTICAL"*) pass "enroll-cfg: after a replace, a repeat with same values is a no-op" ;; *) bad "enroll-cfg replace-then-noop not idempotent: [$differ_noop]" ;; esac

# Seed B with a NON-default port => the active port=22 line is REPLACED with the
# requested port (not dropped, not duplicated).
differ_port="$(boxcfg_test "$seedB" "9.9.9.9" 5 2222)"
case "$differ_port" in *"port_active=1"*"port_val=2222"*) pass "enroll-cfg(D3b): active port line REPLACED with the requested non-default port" ;; *) bad "enroll-cfg differ port wrong: [$differ_port]" ;; esac

# Seed C: NO [fleet] block at all => enroll APPENDS one (single header).
seedC="$(mktemp)"
printf '[ssh]\n#password = "12345678"\n' > "$seedC"
noblk="$(boxcfg_test "$seedC" "3.3.3.3" 7 22)"
case "$noblk" in *"vps_active=1"*"idx_active=1"*"fleet_hdr=1"*) pass "enroll-cfg(D3c): config with NO [fleet] block gets the block appended (one header, active keys)" ;; *) bad "enroll-cfg no-block append wrong: [$noblk]" ;; esac
case "$noblk" in *"vps_val=3.3.3.3"*"idx_val=7"*) pass "enroll-cfg: appended block carries the requested vps + box_index" ;; *) bad "enroll-cfg appended values wrong: [$noblk]" ;; esac
case "$noblk" in *"port_active=0"*) pass "enroll-cfg(D3b/c): appended block omits port at default 22" ;; *) bad "enroll-cfg appended port22 wrong: [$noblk]" ;; esac
# D3c + non-default port: the appended block carries the port line too.
noblk_port="$(boxcfg_test "$seedC" "3.3.3.3" 7 2222)"
case "$noblk_port" in *"port_active=1"*"port_val=2222"*) pass "enroll-cfg(D3b/c): appended block carries a non-default port line" ;; *) bad "enroll-cfg appended port wrong: [$noblk_port]" ;; esac

# D9: remote exit-4 (config ABSENT) vs a transport/ssh failure. enroll_write_box_config
# must return 4 ONLY for the remote "config not found" exit; a transport failure
# (box_ssh itself fails, no remote code) must NOT be 4 (it is the generic write
# failure, return 1). The file is never created.
d9_test() {
  local kind="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
log(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" enroll_write_box_config)"
BOXROOT="\$(mktemp -d)"
BOX_CONFIG="\$BOXROOT/config.toml"
if [ "$kind" = absent ]; then
  # Config is ABSENT: run the REAL remote script (which exits 4). box_ssh runs
  # sudo sh -s locally; the read-backs never run because write returns 4 first.
  box_ssh(){ shift; local cmd="\$*"; cmd="\${cmd#sudo }"; sh -c "\$cmd"; }
else
  # Transport failure: box_ssh always fails (like an ssh 255), no remote code.
  box_ssh(){ return 255; }
fi
enroll_write_box_config grok-box-3 "1.2.3.4" 3 22; echo "rc=\$?"
[ -e "\$BOX_CONFIG" ] && echo "file=created" || echo "file=absent"
rm -rf "\$BOXROOT"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"
}
case "$(d9_test absent)" in
  *"rc=4"*"file=absent"*) pass "enroll-cfg(D9): remote config ABSENT => write returns 4 (distinct), file NOT created" ;;
  *) bad "enroll-cfg D9 exit-4 wrong: [$(d9_test absent)]" ;;
esac
case "$(d9_test transport)" in
  *"rc=1"*"file=absent"*) pass "enroll-cfg(D9): transport/ssh failure => generic write failure (rc 1, NOT 4), file NOT created" ;;
  *) bad "enroll-cfg D9 transport wrong: [$(d9_test transport)]" ;;
esac

# D10: a post-write read-back MISMATCH is treated as a write failure (rc 1).
# Drive the REAL enroll_write_box_config with a box_ssh that performs the WRITE
# honestly but LIES on the read-back (returns a wrong vps), and assert rc=1.
d10_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
log(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" enroll_write_box_config)"
BOXROOT="\$(mktemp -d)"
BOX_CONFIG="\$BOXROOT/config.toml"
printf '[fleet]\n#vps = "x"\n#box_index = 8\n' > "\$BOX_CONFIG"; chmod 600 "\$BOX_CONFIG"
# box_ssh: the WRITE (sh -s, script on stdin) runs honestly; the D10 read-back
# (sh -c "awk ...") is intercepted to return a WRONG value so the assert fails.
box_ssh(){
  shift; local cmd="\$*"; cmd="\${cmd#sudo }"
  case "\$cmd" in
    *"sh -c"*"awk"*) printf 'WRONG-VALUE\n' ;;   # lie on every read-back
    *) sh -c "\$cmd" ;;
  esac
}
enroll_write_box_config grok-box-3 "1.2.3.4" 3 22; echo "rc=\$?"
rm -rf "\$BOXROOT"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"
}
case "$(d10_test)" in
  *"rc=1"*) pass "enroll-cfg(D10): a post-write read-back mismatch is treated as a write failure (rc 1)" ;;
  *) bad "enroll-cfg D10 mismatch wrong: [$(d10_test)]" ;;
esac

# D8: partial-enroll contract at cmd_enroll level — when enroll_write_box_config
# FAILS, cmd_enroll must NOT record the enrollment and must return 1. Drive the
# REAL cmd_enroll with every OTHER step stubbed to success and the writer stubbed
# to fail; assert enroll_record_enrolled is NEVER called and rc=1.
d8_test() {
  local wrc="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
BOXUP_REMOTE="/workspace/box-setup/boxup"
BOX_CONFIG="/workspace/box-setup/config.toml"
log(){ :; }
notify(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index cmd_enroll box_index port_for fleet_vps_addr fleet_vps_port; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
RECORDED="\$(mktemp)"; : > "\$RECORDED"
acl_has_fleet_brain_tagowner(){ return 0; }
enroll_read_box_pubkey(){ echo "ssh-ed25519 AAAAC3fake grok-tunnel-grok-box-3"; }
authorized_keys_line(){ echo "restrict,... \$2"; }
enroll_install_vps_authorized_key(){ return 0; }
enroll_record_etc_mapping(){ return 0; }
enroll_vps_box_access_pubkey(){ echo "ssh-ed25519 AAAAvpskey vps"; }
enroll_install_box_authorized_key(){ return 0; }
enroll_record_enrolled(){ echo "RECORDED \$1" >> "\$RECORDED"; return 0; }
# vps resolves (env), port default; the writer returns the injected code.
export FLEET_VPS_ADDR="1.2.3.4"
config_get(){ return 1; }
enroll_write_box_config(){ return $wrc; }
cmd_enroll grok-box-3 >/dev/null 2>&1; echo "rc=\$?"
if [ -s "\$RECORDED" ]; then echo "recorded=yes"; else echo "recorded=no"; fi
rm -f "\$RECORDED"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
case "$(d8_test 1)" in
  *"rc=1"*"recorded=no"*) pass "enroll-cfg(D8): box-config write FAILURE => NOT recorded, cmd_enroll returns 1" ;;
  *) bad "enroll-cfg D8 failure contract wrong: [$(d8_test 1)]" ;;
esac
case "$(d8_test 4)" in
  *"rc=1"*"recorded=no"*) pass "enroll-cfg(D8/D9): exit-4 (config absent) => still NOT recorded, cmd_enroll returns 1" ;;
  *) bad "enroll-cfg D8 exit-4 contract wrong: [$(d8_test 4)]" ;;
esac
case "$(d8_test 0)" in
  *"rc=0"*"recorded=yes"*) pass "enroll-cfg(D8): box-config write SUCCESS => enrollment IS recorded (write is the last side effect before record)" ;;
  *) bad "enroll-cfg D8 success contract wrong: [$(d8_test 0)]" ;;
esac

# D1 precheck: cmd_enroll must REFUSE before any side effect when the VPS address
# is unresolved (no env, no config) — the ACL check and both authorized_keys
# installs must NOT run. Stub them to record if they fire; assert none did.
d1_precheck_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
BOXUP_REMOTE="/workspace/box-setup/boxup"
BOX_CONFIG="/workspace/box-setup/config.toml"
log(){ :; }
notify(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index cmd_enroll box_index port_for fleet_vps_addr fleet_vps_port; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
SIDE="\$(mktemp)"; : > "\$SIDE"
unset FLEET_VPS_ADDR 2>/dev/null || true
config_get(){ return 1; }                       # nothing resolves => refuse
acl_has_fleet_brain_tagowner(){ echo "ACL" >> "\$SIDE"; return 0; }
enroll_read_box_pubkey(){ echo "PUBKEY" >> "\$SIDE"; echo "ssh-ed25519 A x"; }
enroll_install_vps_authorized_key(){ echo "VPSKEY" >> "\$SIDE"; return 0; }
enroll_install_box_authorized_key(){ echo "BOXKEY" >> "\$SIDE"; return 0; }
enroll_record_enrolled(){ echo "RECORD" >> "\$SIDE"; return 0; }
cmd_enroll grok-box-3 >/dev/null 2>&1; echo "rc=\$?"
if [ -s "\$SIDE" ]; then echo "sideeffects=\$(tr '\n' ',' < "\$SIDE")"; else echo "sideeffects=none"; fi
rm -f "\$SIDE"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
case "$(d1_precheck_test)" in
  *"rc=1"*"sideeffects=none"*) pass "enroll-cfg(D1): unresolved VPS addr => REFUSE as a precheck, ZERO side effects (no ACL/key installs)" ;;
  *) bad "enroll-cfg D1 precheck wrong: [$(d1_precheck_test)]" ;;
esac


# REAL cmd_enroll with every OTHER step stubbed to success and assert the
# box-config writer is NEVER called (it would touch the recorder file if it ran).
noboxcfg_test() {
  local flagpos="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
BOXUP_REMOTE="/workspace/box-setup/boxup"
BOX_CONFIG="/workspace/box-setup/config.toml"
log(){ :; }
notify(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index cmd_enroll box_index port_for fleet_vps_addr fleet_vps_port; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
CALLED="\$(mktemp)"; : > "\$CALLED"
# Stub every side-effecting step to success; record if the box-config writer runs.
acl_has_fleet_brain_tagowner(){ return 0; }
enroll_read_box_pubkey(){ echo "ssh-ed25519 AAAAC3fake grok-tunnel-grok-box-3"; }
authorized_keys_line(){ echo "restrict,... \$2"; }
enroll_install_vps_authorized_key(){ return 0; }
enroll_record_etc_mapping(){ return 0; }
enroll_vps_box_access_pubkey(){ echo "ssh-ed25519 AAAAvpskey vps"; }
enroll_install_box_authorized_key(){ return 0; }
enroll_record_enrolled(){ return 0; }
enroll_write_box_config(){ echo "WROTE \$1" >> "\$CALLED"; return 0; }
config_get(){ return 1; }
export FLEET_VPS_ADDR="1.2.3.4"
if [ "$flagpos" = before ]; then
  cmd_enroll --no-box-config grok-box-3 >/dev/null 2>&1
elif [ "$flagpos" = after ]; then
  cmd_enroll grok-box-3 --no-box-config >/dev/null 2>&1
else
  cmd_enroll grok-box-3 >/dev/null 2>&1
fi
if [ -s "\$CALLED" ]; then echo "WRITER=called"; else echo "WRITER=skipped"; fi
rm -f "\$CALLED"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(noboxcfg_test before)" = "WRITER=skipped" ] && pass "enroll-cfg: --no-box-config (before name) SKIPS the box-side [fleet] write" || bad "enroll-cfg --no-box-config(before) did not skip: [$(noboxcfg_test before)]"
[ "$(noboxcfg_test after)" = "WRITER=skipped" ] && pass "enroll-cfg: --no-box-config (after name) SKIPS the box-side write (order-independent)" || bad "enroll-cfg --no-box-config(after) did not skip: [$(noboxcfg_test after)]"
[ "$(noboxcfg_test none)" = "WRITER=called" ] && pass "enroll-cfg: default (no flag) DOES write the box-side [fleet] block" || bad "enroll-cfg default did not write: [$(noboxcfg_test none)]"

# =============================================================================
# CONFIG-TRUTH (PHASE 2, blueprint D2-D9/D11) — render/validate/push/reconcile/
# operator surface. Box-free + VPS-free: the on-box side of push runs LOCALLY
# via a fake tunnel_ssh that strips the `sudo sh -c '<script>'` wrapper and runs
# the script with STDIN PASSED THROUGH UNMODIFIED (a trailing-newline-stripping
# stub would spuriously trip the sha gate — the real ssh streams stdin verbatim).
# =============================================================================

# cfg_env: emit the common preamble that extracts the config-truth functions and
# points the D2 files at a fresh fixture dir. $1 = fixture dir.
CFG_FIXROOT="$(mktemp -d)"
cfg_fixture() {
  # $1 = subdir name; writes fleet.toml (+ optional boxes/<box>.toml via $2/$3).
  local d="$CFG_FIXROOT/$1"; mkdir -p "$d/boxes"; printf '%s' "$d"
}

# render_test: drive the REAL render_managed over fixtures. args: fleet-content
# boxcontent(|__none__) box
render_test() {
  local fleetc="$1" boxc="$2" box="$3" inner; inner="$(mktemp)"
  local d; d="$(mktemp -d)"; mkdir -p "$d/boxes"
  printf '%s' "$fleetc" > "$d/fleet.toml"
  [ "$boxc" != "__none__" ] && printf '%s' "$boxc" > "$d/boxes/$box.toml"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/fleet.toml"
FLEET_MANAGED_BOXDIR="$d/boxes"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_header render_managed; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
render_managed "$box"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}

FLEETC='[update]
repo = "https://fleet/repo.git"
[ssh]
password = "fleetpass"
'
BOXC='[ssh]
password = "boxpass"
[tailscale]
version = "1.80.0"
'
render_out="$(render_test "$FLEETC" "$BOXC" grok-box-8)"
# Order = first-seen over fleet-then-box: update, ssh, tailscale. Box override
# replaces the ssh.password VALUE in place (never reorders). Values are emitted
# VERBATIM (D3 "key = value lines verbatim") — quotes are preserved; boxup's own
# reader strips them at read time, so the on-box effective value is unchanged.
case "$render_out" in
  *'[update]'*'repo = "https://fleet/repo.git"'*'[ssh]'*'password = "boxpass"'*'[tailscale]'*'version = "1.80.0"'*)
    pass "config render: fleet-then-box merge, box override replaces value in place, first-seen order (verbatim RHS)" ;;
  *) bad "config render merge/order wrong: [$render_out]" ;;
esac
# fleetpass must be SHADOWED by boxpass (last-wins per key).
case "$render_out" in *fleetpass*) bad "config render: box override did NOT shadow fleet value" ;; *) pass "config render: box override shadows the fleet value (last-wins per key)" ;; esac
# Byte determinism: two renders of identical inputs are byte-identical.
r1="$(render_test "$FLEETC" "$BOXC" grok-box-8 | sha256sum)"
r2="$(render_test "$FLEETC" "$BOXC" grok-box-8 | sha256sum)"
[ "$r1" = "$r2" ] && pass "config render: byte-deterministic (identical inputs => identical bytes, no timestamps)" || bad "config render NOT deterministic"
# No applicable keys => header only (still valid). The header itself contains a
# '=' (the '# [managed] enabled = false' comment line), so a leak is a NON-COMMENT
# line carrying '=' — strip comment/blank lines before counting.
hdronly="$(render_test '' __none__ grok-box-9)"
case "$hdronly" in *'WRITTEN BY THE VPS BRAIN'*) [ "$(printf '%s\n' "$hdronly" | grep -v '^[[:space:]]*#' | grep -c '=')" = 0 ] && pass "config render: no keys => header only (empty managed is a valid pushed state)" || bad "header-only render leaked keys: [$hdronly]" ;; *) bad "header-only render missing header: [$hdronly]" ;; esac

# render_present_test: drive REAL render_managed with per-file PRESENCE control
# and capture BOTH the output and the exit status. Guards the P1 regression:
# awk goes fatal (END skipped) if handed a path it cannot open, which would
# silently render header-only + push an empty managed.toml for the normal
# production case (fleet.toml present, NO per-box file). args:
#   fleet(__absent__|content)  box(__absent__|content)  box-name  awkfail(0|1)
# awkfail=1 shadows `awk` with a failing stub to prove a genuine render failure
# propagates a non-zero rc (robust across users — root can read a chmod-000 file).
render_present_test() {
  local fleetc="$1" boxc="$2" box="$3" awkfail="${4:-0}" inner; inner="$(mktemp)"
  local d; d="$(mktemp -d)"; mkdir -p "$d/boxes"
  [ "$fleetc" != "__absent__" ] && printf '%s' "$fleetc" > "$d/fleet.toml"
  [ "$boxc" != "__absent__" ] && printf '%s' "$boxc" > "$d/boxes/$box.toml"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/fleet.toml"
FLEET_MANAGED_BOXDIR="$d/boxes"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_header render_managed; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
[ "$awkfail" = 1 ] && awk(){ return 3; }   # force a genuine render failure
out="\$(render_managed "$box" 2>/dev/null)"; rc=\$?
printf '%s\n' "\$out"
echo "RENDRC=\$rc"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
FLEET_ONLY='[update]
repo = "https://fleet/repo.git"
'
BOX_ONLY='[tailscale]
version = "1.80.0"
'
# (a) fleet.toml populated + box file ABSENT => fleet keys render (NOT header-only), rc 0.
rp_a="$(render_present_test "$FLEET_ONLY" __absent__ grok-box-8)"
case "$rp_a" in
  *'repo = "https://fleet/repo.git"'*"RENDRC=0"*) pass "config render P1: fleet.toml present + box file ABSENT => fleet keys render (not header-only), rc 0" ;;
  *) bad "P1 render (a) lost fleet keys with box absent: [$rp_a]" ;;
esac
# (b) box file present + fleet.toml ABSENT => box keys render, rc 0.
rp_b="$(render_present_test __absent__ "$BOX_ONLY" grok-box-8)"
case "$rp_b" in
  *'version = "1.80.0"'*"RENDRC=0"*) pass "config render P1: box file present + fleet.toml ABSENT => box keys render, rc 0" ;;
  *) bad "P1 render (b) lost box keys with fleet absent: [$rp_b]" ;;
esac
# (c) BOTH absent => header only, rc 0.
rp_c="$(render_present_test __absent__ __absent__ grok-box-8)"
case "$rp_c" in
  *"RENDRC=0"*) [ "$(printf '%s\n' "$rp_c" | grep -v '^[[:space:]]*#' | grep -v '^RENDRC=' | grep -c '=')" = 0 ] && pass "config render P1: BOTH D2 files absent => header only, rc 0" || bad "P1 render (c) leaked keys with both absent: [$rp_c]" ;;
  *) bad "P1 render (c) non-zero rc with both absent: [$rp_c]" ;;
esac
# (d) a genuine render (awk) failure => non-zero rc propagates.
rp_d="$(render_present_test "$FLEET_ONLY" __absent__ grok-box-8 1)"
case "$rp_d" in
  *"RENDRC=0"*) bad "P1 render (d) swallowed an awk failure (rc 0): [$rp_d]" ;;
  *"RENDRC="*) case "$rp_d" in *"RENDRC=3"*) pass "config render P1: a genuine render/awk failure propagates a non-zero rc" ;; *) bad "P1 render (d) wrong rc: [$rp_d]" ;; esac ;;
  *) bad "P1 render (d) no rc: [$rp_d]" ;;
esac

# (d') the render failure must reach the PUSH path: push_managed refuses and
# writes NOTHING. Drives REAL push_managed with a failing awk stub.
render_fail_push_test() {
  local inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"; mkdir -p "$d/boxes" "$d/box"
  printf '%s' "$FLEET_ONLY" > "$d/fleet.toml"
  printf 'MANAGED_FILE=/x\n' > "$d/box/boxup"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/fleet.toml"; FLEET_MANAGED_BOXDIR="$d/boxes"
BOX_ROOT="$d/box"; BOX_MANAGED="$d/box/managed.toml"
log(){ echo "LOG:\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_header render_managed validate_managed unknown_managed_keys managed_remote_script push_managed; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
# render_managed uses awk internally; shadow it AFTER the functions are defined
# so the render fails but nothing else depends on this stub firing first.
render_managed(){ managed_header; return 7; }   # simulate a propagated render failure
tunnel_ssh(){ echo "TUNNEL-CALLED" ; }          # must NOT be reached
push_managed grok-box-8; echo "PUSHRC=\$?"
[ -f "$d/box/managed.toml" ] && echo "ONBOX=present" || echo "ONBOX=absent"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
rp_push="$(render_fail_push_test)"
case "$rp_push" in *"TUNNEL-CALLED"*) bad "P1 push: a render failure still reached the tunnel/push: [$rp_push]" ;; *"PUSHRC=4"*) case "$rp_push" in *"ONBOX=absent"*) pass "config push P1: a render failure => push REFUSES (rc 4), nothing pushed" ;; *) bad "P1 push wrote a file despite render failure: [$rp_push]" ;; esac ;; *) bad "P1 push did not refuse on render failure: [$rp_push]" ;; esac

# validate_managed (D4): drive the REAL function.
validate_test() {
  local text="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" validate_managed)"
if validate_managed "$text" >/dev/null 2>&1; then echo OK; else echo REFUSE; fi
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(validate_test '[update]
repo = x')" = OK ] && pass "config D4: a clean [update] block validates OK" || bad "D4 clean rejected"
[ "$(validate_test '[fleet]
vps = x')" = REFUSE ] && pass "config D4: [fleet] table REFUSED (enroll owns it)" || bad "D4 did not refuse [fleet]"
[ "$(validate_test '[tailscale]
tags = a')" = REFUSE ] && pass "config D4: [tailscale].tags REFUSED (first-login-only, out of scope)" || bad "D4 did not refuse tags"
[ "$(validate_test '[ssh]
garbage no equals')" = REFUSE ] && pass "config D4: unparsable line REFUSED" || bad "D4 did not refuse unparsable"
[ "$(validate_test '[weird]
k = v')" = REFUSE ] && pass "config D4: table outside boxup subset REFUSED" || bad "D4 did not refuse unknown table"
[ "$(validate_test '[update]
future_key = 1')" = OK ] && pass "config D4: unknown-but-well-formed key ALLOWED (forward compatible)" || bad "D4 wrongly refused a well-formed unknown key"

# push_test: drive the REAL push_managed with a fake tunnel_ssh that runs the
# remote script locally. args: fleet-content box-content enabled support dryflag
#   support=yes => fake boxup has MANAGED_FILE= ; enabled controls config-get
#   preseed: optional pre-existing on-box managed.toml content ($6)
push_test() {
  local fleetc="$1" boxc="$2" enabled="$3" support="$4" dry="$5" preseed="${6:-__none__}" inner; inner="$(mktemp)"
  local d; d="$(mktemp -d)"; mkdir -p "$d/boxes" "$d/box"
  printf '%s' "$fleetc" > "$d/fleet.toml"
  [ "$boxc" != "__none__" ] && printf '%s' "$boxc" > "$d/boxes/grok-box-8.toml"
  [ "$preseed" != "__none__" ] && printf '%s' "$preseed" > "$d/box/managed.toml"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/fleet.toml"
FLEET_MANAGED_BOXDIR="$d/boxes"
BOX_ROOT="$d/box"
BOX_MANAGED="$d/box/managed.toml"
log(){ echo "LOG:\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_header render_managed validate_managed managed_remote_script push_managed; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
# Fake boxup: MANAGED_FILE= line iff support=yes; answers config-get accordingly.
if [ "$support" = yes ]; then
  printf 'MANAGED_FILE=/x\ncase "\$1 \$2 \$3" in "config-get managed enabled") echo %s;; esac\n' "$enabled" > "$d/box/boxup"
else
  : > "$d/box/boxup"
fi
# Fake tunnel_ssh: strip the sudo sh -c wrapper, run with stdin passed through.
tunnel_ssh(){ shift; local c="\$*"; local s="\${c#sudo sh -c \\'}"; s="\${s%\\'}"; sh -c "\$s"; }
if [ "$dry" = 1 ]; then push_managed grok-box-8 --dry-run; else push_managed grok-box-8; fi
echo "PUSHRC=\$?"
[ -f "$d/box/managed.toml" ] && echo "ONBOX-SHA=\$(sha256sum "$d/box/managed.toml" | cut -d' ' -f1)" || echo "ONBOX=absent"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}

# D5 write path (support=yes, enabled=true, empty box): pushes, rc 0.
p_write="$(push_test "$FLEETC" "$BOXC" true yes 0)"
case "$p_write" in *"pushed (none->"*"PUSHRC=0"*) pass "config push D5: first push writes managed.toml (none->sha), rc 0" ;; *) bad "D5 write wrong: [$p_write]" ;; esac

# D5 no-op: pre-seed the box with the EXACT rendered bytes => in sync, rc 0.
rendered="$(render_test "$FLEETC" "$BOXC" grok-box-8)"
p_noop="$(push_test "$FLEETC" "$BOXC" true yes 0 "$rendered
")"
case "$p_noop" in *"in sync"*"PUSHRC=0"*) pass "config push D5: identical on-box file => in sync (no write), rc 0" ;; *) bad "D5 no-op wrong: [$p_noop]" ;; esac

# D5 dry-run WOULD push wording.
p_dry="$(push_test "$FLEETC" "$BOXC" true yes 1)"
case "$p_dry" in *"WOULD push (none->"*"PUSHRC=0"*) pass "config push D5: dry-run => 'WOULD push', writes NOTHING, rc 0" ;; *) bad "D5 dry-run wording wrong: [$p_dry]" ;; esac
case "$p_dry" in *ONBOX=absent*) pass "config push D5: dry-run leaves the box file absent (no write)" ;; *) bad "D5 dry-run WROTE a file: [$p_dry]" ;; esac

# D5 truncated-stdin => exit 3, file unchanged. Fake a corrupting tunnel_ssh.
trunc_test() {
  local inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"; mkdir -p "$d/boxes" "$d/box"
  printf '%s' "$FLEETC" > "$d/fleet.toml"; printf '%s' "$BOXC" > "$d/boxes/grok-box-8.toml"
  printf 'PRE-EXISTING\n' > "$d/box/managed.toml"; printf 'MANAGED_FILE=/x\n' > "$d/box/boxup"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/fleet.toml"; FLEET_MANAGED_BOXDIR="$d/boxes"
BOX_ROOT="$d/box"; BOX_MANAGED="$d/box/managed.toml"
log(){ echo "LOG:\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_header render_managed validate_managed managed_remote_script push_managed; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
# Corrupting tunnel_ssh: append to stdin so the remote sha never matches want.
tunnel_ssh(){ shift; local c="\$*"; local s="\${c#sudo sh -c \\'}"; s="\${s%\\'}"; sed 's/\$/X/' | sh -c "\$s"; }
push_managed grok-box-8; echo "PUSHRC=\$?"
echo "FILE=\$(cat "$d/box/managed.toml")"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
p_trunc="$(trunc_test)"
case "$p_trunc" in *"PUSHRC=3"*) pass "config push D5: truncated/corrupt stdin => exit 3 (sha mismatch)" ;; *) bad "D5 truncated exit wrong: [$p_trunc]" ;; esac
case "$p_trunc" in *"FILE=PRE-EXISTING"*) pass "config push D5: sha mismatch leaves the on-box file UNCHANGED" ;; *) bad "D5 truncated clobbered file: [$p_trunc]" ;; esac

# D5/D8 status-line annotations: enabled=false => IGNORED; support=no => inert.
p_ign="$(push_test "$FLEETC" "$BOXC" false yes 0)"
case "$p_ign" in *"[IGNORED locally: [managed] enabled=false]"*) pass "config push D8: enabled=false => IGNORED annotation on the log line" ;; *) bad "D8 IGNORED annotation missing: [$p_ign]" ;; esac
p_inert="$(push_test "$FLEETC" "$BOXC" true no 0)"
case "$p_inert" in *"[inert: boxup lacks managed support"*) pass "config push D5: support=no => inert annotation (deploy boxup first)" ;; *) bad "D5 inert annotation missing: [$p_inert]" ;; esac

# BLOCKER-2 (live canary r1): the remote managed-status probe must invoke boxup
# under BASH, not sh. boxup is #!/bin/bash and its TOML reader uses the bash-only
# `read -r -d`; on the boxes /bin/sh is dash, so `sh boxup config-get …` errored
# and the old `|| echo true` fallback ALWAYS reported enabled=true — the
# enabled=false escape hatch could never surface. Drives the REAL push_managed +
# REAL managed_remote_script with a fake boxup whose config-get path is bash-only
# (fails under dash), so ONLY a bash invocation returns the real enabled value.
# probe_test: args = enabled_value shim(bash|dash|fail)
#   bash  = a working bash on PATH (the box reality: the fix uses `bash "$bx"`)
#   fail  = every invocation of the boxup file errors (probe genuinely fails)
probe_test() {
  local want_enabled="$1" shim="$2" inner; inner="$(mktemp)"
  local d; d="$(mktemp -d)"; mkdir -p "$d/boxes" "$d/box" "$d/bin"
  printf '%s' "$FLEETC" > "$d/fleet.toml"; printf '%s' "$BOXC" > "$d/boxes/grok-box-8.toml"
  # Fake boxup: supported (MANAGED_FILE=) and its config-get uses a BASH-ONLY
  # construct (`read -r -d`), so invoking it under dash errors out (exit != 0).
  cat > "$d/box/boxup" <<BOXUP
MANAGED_FILE=/x
if [ "\$1 \$2 \$3" = "config-get managed enabled" ]; then
  # bash-only: dash's read has no -d and aborts the script here.
  printf '%s' "$want_enabled" | { read -r -d '' v || true; echo "\$v"; }
fi
BOXUP
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/fleet.toml"; FLEET_MANAGED_BOXDIR="$d/boxes"
BOX_ROOT="$d/box"; BOX_MANAGED="$d/box/managed.toml"
log(){ echo "LOG:\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_header render_managed validate_managed managed_remote_script push_managed; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
# Provide a controllable \`bash\` for the remote probe:
#   shim=bash => a real bash (the box's actual bash, honours -d) => probe works.
#   shim=fail => a bash that always errors => probe genuinely fails.
mkdir -p "$d/bin"
if [ "$shim" = fail ]; then
  printf '#!/bin/sh\nexit 2\n' > "$d/bin/bash"; chmod +x "$d/bin/bash"
  PATH="$d/bin:\$PATH"
fi
export PATH
# Fake tunnel_ssh: strip the sudo sh -c wrapper, run the remote script under sh
# (dash-equivalent posix mode) so ONLY the inner \`bash "\$bx"\` can honour -d.
tunnel_ssh(){ shift; local c="\$*"; local s="\${c#sudo sh -c \\'}"; s="\${s%\\'}"; sh -c "\$s"; }
push_managed grok-box-8 --dry-run
echo "PUSHRC=\$?"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
# (a) bash probe honours the box's real enabled=false => IGNORED annotation shows
# (this is exactly the state the live canary could never reach under sh).
pb_false="$(probe_test false bash)"
case "$pb_false" in *"[IGNORED locally: [managed] enabled=false]"*) pass "BLOCKER-2: boxup probed via bash => real enabled=false surfaces the IGNORED annotation" ;; *) bad "BLOCKER-2: bash probe did not surface enabled=false: [$pb_false]" ;; esac
# (b) bash probe with enabled=true => NO false IGNORED annotation (real value).
pb_true="$(probe_test true bash)"
case "$pb_true" in *"IGNORED locally"*) bad "BLOCKER-2: enabled=true wrongly annotated IGNORED: [$pb_true]" ;; *"PUSHRC=0"*) pass "BLOCKER-2: boxup probed via bash => real enabled=true reported (no spurious IGNORED)" ;; *) bad "BLOCKER-2: enabled=true probe wrong: [$pb_true]" ;; esac
# (c) a genuine probe FAILURE must NEVER be reported as enabled=true — it reports
# enabled=unknown and annotates the log line (never a silent false "true").
pb_fail="$(probe_test true fail)"
case "$pb_fail" in *"IGNORED locally: [managed] enabled=false]"*) bad "BLOCKER-2: a failed probe was reported as enabled=false: [$pb_fail]" ;; *"enabled UNKNOWN"*) pass "BLOCKER-2: a failed managed-status probe => enabled=unknown + annotation (never a false enabled=true)" ;; *) bad "BLOCKER-2: failed probe not reported as unknown: [$pb_fail]" ;; esac
# (c') and the remote script must invoke boxup via bash and must NOT fall back to
# a hardcoded enabled=true on probe failure. (The heredoc-built body escapes $,
# so match the escaped forms; strip comment lines before the negative check so a
# doc mention of the old fallback doesn't trip it.)
mrs="$(sed -n '/^managed_remote_script() {/,/^}/p' "$FLEETCTL")"
mrs_code="$(printf '%s\n' "$mrs" | grep -v '^[[:space:]]*#')"
case "$mrs_code" in *'bash "\$bx" config-get'*) pass "BLOCKER-2: managed_remote_script invokes the box reader via bash" ;; *) bad "BLOCKER-2: managed_remote_script does not invoke boxup via bash: [$mrs_code]" ;; esac
case "$mrs_code" in *'config-get managed enabled 2>/dev/null || echo true'*) bad "BLOCKER-2: managed_remote_script still falls back to enabled=true on probe failure" ;; *) pass "BLOCKER-2: managed_remote_script no longer falls back to enabled=true on probe failure" ;; esac

# D6 reconcile_config_pass: SILENT no-op when the D2 files are absent.
cfgpass_test() {
  # args: files_present(yes|no) apply canary_verdict rest_verdict tunnel_map...
  local present="$1" apply="$2" canary_v="$3" rest_v="$4" inner; inner="$(mktemp)"
  local d; d="$(mktemp -d)"; mkdir -p "$d/etc/boxes" "$d/state"
  if [ "$present" = yes ]; then printf '[update]\nrepo = x\n' > "$d/etc/fleet.toml"; fi
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/etc/fleet.toml"
FLEET_MANAGED_BOXDIR="$d/etc/boxes"
FLEET_STATE="$d/state"
FLEET_BOXES="grok-box-008 grok-box-003 grok-box-005"
log(){ echo "LOG:\$*"; }
notify(){ echo "NOTIFY:\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_files_present reconcile_canary_box reconcile_target_boxes reconcile_checkfail_count reconcile_bump_cfgfail reconcile_reset_cfgfail reconcile_config_pass; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
config_get(){ return 1; }   # no canary_box configured => default grok-box-008
tunnel_up(){ return 0; }    # all tunnels up
seq="$d/seq"
# push_managed stub: record the box + dry flag, return the per-box verdict.
push_managed(){
  local box="\$1" dry=0; case "\${2:-}" in --dry-run) dry=1;; esac
  echo "PUSH \$box dry=\$dry" >> "\$seq"
  case "\$box" in
    grok-box-008) return $canary_v ;;
    grok-box-003) return $rest_v ;;
    *) return 0 ;;
  esac
}
reconcile_config_pass "$apply"; echo "PASSRC=\$?"
[ -f "\$seq" ] && tr '\n' '|' < "\$seq"; echo
for f in "$d"/state/*.cfgfail; do [ -f "\$f" ] && echo "CFGFAIL \$(basename "\$f")=\$(cat "\$f")"; done
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
# absent D2 files => SILENT (no push, no log, rc 0).
cp_absent="$(cfgpass_test no 0 0 0)"
case "$cp_absent" in *PUSH*) bad "D6: config pass acted with D2 files ABSENT: [$cp_absent]" ;; *"PASSRC=0"*) pass "D6: config pass is a SILENT no-op when fleet.toml/boxes are absent" ;; *) bad "D6 absent wrong: [$cp_absent]" ;; esac
# present, dry-run => canary FIRST then rest, all dry=1.
cp_dry="$(cfgpass_test yes 0 0 0)"
case "$cp_dry" in "PASSRC=0"|*"PUSH grok-box-008 dry=1|PUSH grok-box-003 dry=1|PUSH grok-box-005 dry=1|"*) pass "D6: dry-run pass pushes --dry-run canary-first then the rest serially" ;; *) bad "D6 dry-run order wrong: [$cp_dry]" ;; esac
# present, apply => dry=0.
cp_apply="$(cfgpass_test yes 1 0 0)"
case "$cp_apply" in *"PUSH grok-box-008 dry=0|PUSH grok-box-003 dry=0|PUSH grok-box-005 dry=0|"*) pass "D6: --apply pass pushes for real (dry=0), canary-first" ;; *) bad "D6 apply order wrong: [$cp_apply]" ;; esac
# canary CONTENT failure (rc 3/4/5) => ABORT (zero other boxes), rc 1. Under
# D6b the notify is threshold-gated (D9), so a SINGLE-tick failure warns via a
# log line, NOT notify — the notify assertions live in the D11b threshold block.
cp_canfail="$(cfgpass_test yes 1 4 0)"
case "$cp_canfail" in *"PUSH grok-box-008 dry=0|"*) case "$cp_canfail" in *"PUSH grok-box-003"*) bad "D6: canary failure did NOT abort (touched grok-box-003): [$cp_canfail]" ;; *"PASSRC=1"*) pass "D6b: canary CONTENT FAILURE (rc 4) => ABORT the rest this tick, rc 1" ;; *) bad "D6 canary-abort rc wrong: [$cp_canfail]" ;; esac ;; *) bad "D6 canary-fail wrong: [$cp_canfail]" ;; esac
case "$cp_canfail" in *NOTIFY*) bad "D6b: a single-tick canary failure must NOT notify (threshold >3): [$cp_canfail]" ;; *) pass "D6b: a single-tick canary failure aborts WITHOUT notify (D9 threshold-gated)" ;; esac
# non-canary FAILS => D9 bump for that box, CONTINUE with the rest, rc 1.
cp_restfail="$(cfgpass_test yes 1 0 1)"
case "$cp_restfail" in *"PUSH grok-box-008 dry=0|PUSH grok-box-003 dry=0|PUSH grok-box-005 dry=0|"*) pass "D6: a NON-canary failure continues to the remaining boxes" ;; *) bad "D6 non-canary continue wrong: [$cp_restfail]" ;; esac
case "$cp_restfail" in *"CFGFAIL grok-box-003.cfgfail=1"*) pass "D9: a non-canary push failure bumps that box's .cfgfail" ;; *) bad "D9 cfgfail bump missing: [$cp_restfail]" ;; esac
case "$cp_restfail" in *"PASSRC=1"*) pass "D6: config pass returns rc 1 when a non-canary box failed" ;; *) bad "D6 non-canary rc wrong: [$cp_restfail]" ;; esac

# D6 per-box guard: tunnel DOWN or .checkfail => skip silently.
cfgpass_guard_test() {
  local guard="$1" inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"; mkdir -p "$d/etc/boxes" "$d/state"
  printf '[update]\nrepo = x\n' > "$d/etc/fleet.toml"
  [ "$guard" = checkfail ] && echo 4 > "$d/state/grok-box-003.checkfail"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/etc/fleet.toml"; FLEET_MANAGED_BOXDIR="$d/etc/boxes"
FLEET_STATE="$d/state"; FLEET_BOXES="grok-box-008 grok-box-003"
log(){ :; }; notify(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_files_present reconcile_canary_box reconcile_target_boxes reconcile_checkfail_count reconcile_bump_cfgfail reconcile_reset_cfgfail reconcile_config_pass; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
config_get(){ return 1; }
# tunnel_up: grok-box-008 always up; grok-box-003 down iff guard=tunnel.
tunnel_up(){ case "\$1" in grok-box-003) [ "$guard" != tunnel ] ;; *) return 0 ;; esac; }
seq="$d/seq"
push_managed(){ echo "PUSH \$1" >> "\$seq"; return 0; }
reconcile_config_pass 1 >/dev/null; echo "PASSRC=\$?"
[ -f "\$seq" ] && tr '\n' '|' < "\$seq"; echo
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
g_tun="$(cfgpass_guard_test tunnel)"
case "$g_tun" in *"PUSH grok-box-003"*) bad "D6 guard: pushed to a tunnel-DOWN box: [$g_tun]" ;; *"PUSH grok-box-008"*) pass "D6 guard: tunnel-down box skipped silently (canary still pushed)" ;; *) bad "D6 tunnel guard wrong: [$g_tun]" ;; esac
g_chk="$(cfgpass_guard_test checkfail)"
case "$g_chk" in *"PUSH grok-box-003"*) bad "D6 guard: pushed to a .checkfail box: [$g_chk]" ;; *"PUSH grok-box-008"*) pass "D6 guard: .checkfail box skipped silently" ;; *) bad "D6 checkfail guard wrong: [$g_chk]" ;; esac

# BLOCKER-1 (live canary r1): the per-box guard must gate on the checkfail COUNT
# (>3, matching reconcile_decide's threshold), NOT file PRESENCE. A HEALTHY box
# carries a `0`-content .checkfail FILE (reconcile_reset_checkfail rewrites it
# every tick), so a presence guard skipped EVERY healthy box — the whole fleet —
# on every real tick. Drives the REAL reconcile_config_pass with the checkfail
# file for a NON-canary box (grok-box-003) seeded to a chosen state; asserts the
# box is processed (0/absent) or skipped-with-a-log-line (over threshold).
cfgpass_checkfail_test() {
  # args: chkstate = absent | 0 | 4   (grok-box-003's .checkfail content)
  local chkstate="$1" inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"; mkdir -p "$d/etc/boxes" "$d/state"
  printf '[update]\nrepo = x\n' > "$d/etc/fleet.toml"
  [ "$chkstate" != absent ] && printf '%s\n' "$chkstate" > "$d/state/grok-box-003.checkfail"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/etc/fleet.toml"; FLEET_MANAGED_BOXDIR="$d/etc/boxes"
FLEET_STATE="$d/state"; FLEET_BOXES="grok-box-008 grok-box-003"
log(){ echo "LOG:\$*"; }; notify(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_files_present reconcile_canary_box reconcile_target_boxes reconcile_checkfail_count reconcile_bump_cfgfail reconcile_reset_cfgfail reconcile_config_pass; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
config_get(){ return 1; }
tunnel_up(){ return 0; }   # both tunnels up: only the checkfail count decides
seq="$d/seq"
push_managed(){ echo "PUSH \$1" >> "\$seq"; return 0; }
reconcile_config_pass 1; echo "PASSRC=\$?"
[ -f "\$seq" ] && tr '\n' '|' < "\$seq"; echo
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
# (a) content 0 (HEALTHY, the every-tick state) => box IS processed.
cf_zero="$(cfgpass_checkfail_test 0)"
case "$cf_zero" in *"PUSH grok-box-003"*) pass "BLOCKER-1: a 0-content .checkfail (healthy) box IS processed by the config pass" ;; *) bad "BLOCKER-1: healthy 0-content box was SKIPPED (the live-canary bug): [$cf_zero]" ;; esac
# (b) content 4 (>3, unhealthy) => box SKIPPED, with the skip log line.
cf_four="$(cfgpass_checkfail_test 4)"
case "$cf_four" in *"PUSH grok-box-003"*) bad "BLOCKER-1: pushed to an over-threshold (4) box: [$cf_four]" ;; *"LOG:config: skip grok-box-003 — checkfail over threshold"*) pass "BLOCKER-1: a >3 checkfail box is skipped WITH a skip log line" ;; *) bad "BLOCKER-1: over-threshold skip log missing: [$cf_four]" ;; esac
# (c) absent .checkfail => box IS processed.
cf_abs="$(cfgpass_checkfail_test absent)"
case "$cf_abs" in *"PUSH grok-box-003"*) pass "BLOCKER-1: an ABSENT .checkfail box IS processed" ;; *) bad "BLOCKER-1: absent-checkfail box was skipped: [$cf_abs]" ;; esac

# r5.3 G3: the CANARY checkfail guard needs an explicit else arm. r5.1 gave the
# NON-canary >3 skip a diagnostic line, but the canary guard skipped SILENTLY
# and UNCOUNTED. Fix: checkfail=4 canary => a visible skip line, counted in
# skipped=, NO notify, NO cfgfail change, and the pass FALLS THROUGH to the
# non-canary loop (mirrors the rc-6 path). checkfail=3 => the ==3 boundary is
# healthy, so the canary IS pushed (folds the r2 SHOULD boundary test).
# Drives the REAL reconcile_config_pass; the canary is grok-box-008, non-canary
# grok-box-003 (both tunnels up), so only the canary's checkfail count decides.
cfgpass_canary_checkfail_test() {
  # args: canary_chk = 3 | 4   (grok-box-008's .checkfail content)
  local canary_chk="$1" inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"; mkdir -p "$d/etc/boxes" "$d/state"
  printf '[update]\nrepo = x\n' > "$d/etc/fleet.toml"
  printf '%s\n' "$canary_chk" > "$d/state/grok-box-008.checkfail"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/etc/fleet.toml"; FLEET_MANAGED_BOXDIR="$d/etc/boxes"
FLEET_STATE="$d/state"; FLEET_BOXES="grok-box-008 grok-box-003"
log(){ echo "LOG:\$*"; }; notify(){ echo "NOTIFY:\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_files_present reconcile_canary_box reconcile_target_boxes reconcile_checkfail_count reconcile_bump_cfgfail reconcile_reset_cfgfail reconcile_config_pass; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
config_get(){ return 1; }   # no canary_box configured => default 8
tunnel_up(){ return 0; }    # both tunnels up: only the canary checkfail decides
seq="$d/seq"
push_managed(){ echo "PUSH \$1" >> "\$seq"; return 0; }
reconcile_config_pass 1; echo "PASSRC=\$?"
[ -f "\$seq" ] && tr '\n' '|' < "\$seq"; echo
for f in "$d"/state/*.cfgfail; do [ -f "\$f" ] && echo "CFGFAIL \$(basename "\$f")=\$(cat "\$f")"; done
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
# (a) checkfail=4 (>3): the canary is SKIPPED with the G3 line, counted in
# skipped=, NO notify, NO cfgfail, and the NON-canary loop STILL RUNS.
cc_four="$(cfgpass_canary_checkfail_test 4)"
case "$cc_four" in *"LOG:config: canary grok-box-008 skipped — checkfail=4 (>3), continuing without canary protection"*) pass "r5.3 G3: canary checkfail=4 => visible skip line" ;; *) bad "r5.3 G3: canary checkfail>3 skip line missing: [$cc_four]" ;; esac
case "$cc_four" in *"PUSH grok-box-008"*) bad "r5.3 G3: canary was PUSHED at checkfail=4 (>3): [$cc_four]" ;; *"PUSH grok-box-003"*) pass "r5.3 G3: after the canary skip the non-canary loop STILL runs (grok-box-003 pushed)" ;; *) bad "r5.3 G3: non-canary loop did not run after canary skip: [$cc_four]" ;; esac
case "$cc_four" in *"LOG:config: pass done (apply) ok=1 skipped=1 failed=0"*) pass "r5.3 G3: the skipped canary is COUNTED in skipped= (ok=1 skipped=1)" ;; *) bad "r5.3 G3: canary not counted in skipped= : [$cc_four]" ;; esac
case "$cc_four" in *NOTIFY*) bad "r5.3 G3: canary checkfail skip must NOT notify: [$cc_four]" ;; *) pass "r5.3 G3: canary checkfail skip emits NO notify" ;; esac
case "$cc_four" in *CFGFAIL*) bad "r5.3 G3: canary checkfail skip must NOT change cfgfail: [$cc_four]" ;; *) pass "r5.3 G3: canary checkfail skip leaves cfgfail unchanged" ;; esac
# (b) checkfail=3 (==3 boundary, HEALTHY): the canary IS pushed (r2 boundary).
cc_three="$(cfgpass_canary_checkfail_test 3)"
case "$cc_three" in *"PUSH grok-box-008"*) pass "r5.3 G3: canary checkfail=3 (==3 boundary) => canary IS pushed" ;; *) bad "r5.3 G3: canary skipped at the ==3 boundary (should push): [$cc_three]" ;; esac

# D4 forward-compat info log: an unknown-but-well-formed key is ALLOWED and
# logged ONCE per reconcile run, DEDUPED across boxes. Drives the REAL
# reconcile_config_pass + REAL push_managed + REAL unknown_managed_keys across
# TWO boxes in one pass, with a fake tunnel_ssh that runs the remote locally.
# Both boxes render the SAME fleet.toml, so the unknown key is seen twice but
# must be logged exactly once (run-scoped dedupe). Known-only keys => no log.
cfgunknown_test() {
  # args: fleet-content  (drives both boxes; no per-box overrides)
  local fleetc="$1" inner; inner="$(mktemp)"
  local d; d="$(mktemp -d)"; mkdir -p "$d/etc/boxes" "$d/state" "$d/box"
  printf '%s' "$fleetc" > "$d/etc/fleet.toml"
  # No per-box boxes/<box>.toml — the production normal case (fleet-wide only).
  # This also exercises the P1 fix: render_managed must merge fleet.toml even
  # when the per-box file is absent (previously awk went fatal => header-only).
  printf 'MANAGED_FILE=/x\ncase "$1 $2 $3" in "config-get managed enabled") echo true;; esac\n' > "$d/box/boxup"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/etc/fleet.toml"
FLEET_MANAGED_BOXDIR="$d/etc/boxes"
FLEET_STATE="$d/state"
FLEET_BOXES="grok-box-008 grok-box-003"
BOX_ROOT="$d/box"; BOX_MANAGED="$d/box/managed.toml"
log(){ echo "LOG:\$*"; }
notify(){ echo "NOTIFY:\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_files_present reconcile_canary_box reconcile_target_boxes reconcile_checkfail_count reconcile_bump_cfgfail reconcile_reset_cfgfail managed_header render_managed validate_managed unknown_managed_keys managed_remote_script push_managed reconcile_config_pass; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
config_get(){ return 1; }   # no canary_box configured => default 8
tunnel_up(){ return 0; }    # both tunnels up
# Fake tunnel_ssh: strip the sudo sh -c wrapper, run with stdin passed through.
tunnel_ssh(){ shift; local c="\$*"; local s="\${c#sudo sh -c \\'}"; s="\${s%\\'}"; sh -c "\$s"; }
reconcile_config_pass 1; echo "PASSRC=\$?"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
# fleet.toml with a KNOWN key (update.repo) + an UNKNOWN-but-well-formed key
# (update.channel). Two boxes render it => the unknown key is encountered twice.
UNK_FLEET='[update]
repo = "https://fleet/repo.git"
channel = "beta"
'
cu_unknown="$(cfgunknown_test "$UNK_FLEET")"
# The info log must appear EXACTLY ONCE and name the unknown key (update.channel).
cu_count="$(printf '%s\n' "$cu_unknown" | grep -c 'unknown-but-well-formed keys')"
case "$cu_unknown" in
  *"unknown-but-well-formed keys (allowed, forward-compat): update.channel"*)
    [ "$cu_count" = 1 ] && pass "D4 info: unknown well-formed key ALLOWED + logged ONCE across two boxes in one pass" || bad "D4 info: unknown-key log fired $cu_count times (want 1): [$cu_unknown]" ;;
  *) bad "D4 info: unknown-key log missing/misnamed: [$cu_unknown]" ;;
esac
# The push itself still succeeds (unknown keys are allowed, not refused).
case "$cu_unknown" in *"PASSRC=0"*) pass "D4 info: an unknown well-formed key does not fail the pass (forward compatible)" ;; *) bad "D4 info: pass rc non-zero with an allowed unknown key: [$cu_unknown]" ;; esac
# KNOWN-only fleet.toml => NO such info log at all.
KNOWN_FLEET='[update]
repo = "https://fleet/repo.git"
[ssh]
password = "p"
'
cu_known="$(cfgunknown_test "$KNOWN_FLEET")"
case "$cu_known" in *"unknown-but-well-formed keys"*) bad "D4 info: logged unknown keys for a KNOWN-ONLY render: [$cu_known]" ;; *) pass "D4 info: known keys only => no unknown-key info log emitted" ;; esac

# D7 operator surface: cmd_config refuses un-enrolled boxes.
cmdcfg_enroll_test() {
  local box="$1" inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"; mkdir -p "$d/state"
  printf 'grok-box-008\t20008\n' > "$d/state/enrolled.tsv"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STATE="$d/state"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index reconcile_target_boxes cmd_config_enrolled cmd_config render_managed managed_header validate_managed; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
FLEET_MANAGED_FLEET="$d/none.toml"; FLEET_MANAGED_BOXDIR="$d/noboxes"
cmd_config render "$box" >/dev/null 2>&1; echo "RC=\$?"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
[ "$(cmdcfg_enroll_test grok-box-008)" = "RC=0" ] && pass "config D7: render an ENROLLED box succeeds" || bad "D7 enrolled render failed: [$(cmdcfg_enroll_test grok-box-008)]"
[ "$(cmdcfg_enroll_test grok-box-99)" = "RC=2" ] && pass "config D7: an UN-enrolled box is REFUSED (rc 2)" || bad "D7 did not refuse un-enrolled: [$(cmdcfg_enroll_test grok-box-99)]"

# D7 diff exit codes + IGNORED annotation. Drive cmd_config diff with a fake
# tunnel_ssh running the dry-run remote locally.
cmddiff_test() {
  # args: onbox-state(insync|drift) enabled support
  local state="$1" enabled="$2" support="$3" inner; inner="$(mktemp)"
  local d; d="$(mktemp -d)"; mkdir -p "$d/etc/boxes" "$d/state" "$d/box"
  printf '%s' "$FLEETC" > "$d/etc/fleet.toml"; printf '%s' "$BOXC" > "$d/etc/boxes/grok-box-008.toml"
  printf 'grok-box-008\t20008\n' > "$d/state/enrolled.tsv"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STATE="$d/state"
FLEET_MANAGED_FLEET="$d/etc/fleet.toml"; FLEET_MANAGED_BOXDIR="$d/etc/boxes"
BOX_ROOT="$d/box"; BOX_MANAGED="$d/box/managed.toml"
log(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index reconcile_target_boxes cmd_config_enrolled cmd_config render_managed managed_header validate_managed managed_remote_script; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
if [ "$support" = yes ]; then printf 'MANAGED_FILE=/x\ncase "\$1 \$2 \$3" in "config-get managed enabled") echo %s;; esac\n' "$enabled" > "$d/box/boxup"; else : > "$d/box/boxup"; fi
# Pre-seed the on-box file to be IN SYNC (exact render) or DRIFTED.
if [ "$state" = insync ]; then render_managed grok-box-008 > "$d/box/managed.toml"; else printf 'DRIFT\n' > "$d/box/managed.toml"; fi
tunnel_ssh(){ shift; local c="\$*"; local s="\${c#sudo sh -c \\'}"; s="\${s%\\'}"; sh -c "\$s"; }
cmd_config diff grok-box-008; echo "DIFFRC=\$?"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
d_sync="$(cmddiff_test insync true yes)"
case "$d_sync" in *"DIFFRC=0"*) pass "config D7 diff: in-sync box (enabled, supported) => exit 0" ;; *) bad "D7 diff in-sync exit wrong: [$d_sync]" ;; esac
d_drift="$(cmddiff_test drift true yes)"
case "$d_drift" in *"DIFFRC=1"*) pass "config D7 diff: drifted box => exit 1" ;; *) bad "D7 diff drift exit wrong: [$d_drift]" ;; esac
d_ign="$(cmddiff_test insync false yes)"
case "$d_ign" in *"IGNORED on this box"*) case "$d_ign" in *"DIFFRC=1"*) pass "config D7 diff: enabled=false => annotates IGNORED AND never reports in-sync (exit 1)" ;; *) bad "D7 diff enabled=false must not be in-sync: [$d_ign]" ;; esac ;; *) bad "D7 diff missing IGNORED annotation: [$d_ign]" ;; esac
d_nosup="$(cmddiff_test insync true no)"
case "$d_nosup" in *"IGNORED"*) case "$d_nosup" in *"DIFFRC=1"*) pass "config D7 diff: support=no => annotates IGNORED AND never in-sync (exit 1)" ;; *) bad "D7 diff support=no must not be in-sync: [$d_nosup]" ;; esac ;; *) bad "D7 diff missing support=no annotation: [$d_nosup]" ;; esac

# D9 cfgfail bump/reset + notify at >3. Drive the REAL helpers.
cfgfail_test() {
  local inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"; mkdir -p "$d/state"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STATE="$d/state"
notify(){ echo "NOTIFY:\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index reconcile_bump_cfgfail reconcile_reset_cfgfail; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
for i in 1 2 3 4; do echo "bump=\$(reconcile_bump_cfgfail grok-box-008)"; done
reconcile_reset_cfgfail grok-box-008
[ -f "$d/state/grok-box-008.cfgfail" ] && echo "AFTER-RESET=present" || echo "AFTER-RESET=gone"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
cf_out="$(cfgfail_test)"
# The helper is PURE (like checkfail/seedfail): bump + print the count, NO notify
# embedded — so a caller's `x=$(reconcile_bump_cfgfail …)` capture is never
# polluted (and reconcile_config_pass's threshold notify is never swallowed).
case "$cf_out" in *"bump=1"*"bump=2"*"bump=3"*"bump=4"*) pass "D9: reconcile_bump_cfgfail increments 1..4 (pure: count only)" ;; *) bad "D9 bump sequence wrong: [$cf_out]" ;; esac
case "$cf_out" in *NOTIFY:*) bad "D9: bump helper must NOT notify (notify lives at the call site, like seedfail): [$cf_out]" ;; *) pass "D9: bump helper is pure — no notify inside (matches checkfail/seedfail shape)" ;; esac
case "$cf_out" in *"AFTER-RESET=gone"*) pass "D9: reconcile_reset_cfgfail clears the counter file" ;; *) bad "D9 reset did not clear: [$cf_out]" ;; esac

# D9 notify at the CALL SITE (reconcile_config_pass, non-canary path): a box that
# fails the push on every tick must fire `notify warn` ONLY once its cfgfail
# count crosses > 3 — exactly like seedfail (fleetctl:2311-2313). Drive the real
# reconcile_config_pass 4 ticks with a persistently-failing non-canary box.
cfgnotify_test() {
  local inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"; mkdir -p "$d/etc/boxes" "$d/state"
  printf '[update]\nrepo = x\n' > "$d/etc/fleet.toml"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/etc/fleet.toml"; FLEET_MANAGED_BOXDIR="$d/etc/boxes"
FLEET_STATE="$d/state"; FLEET_BOXES="grok-box-008 grok-box-003"
log(){ :; }; notify(){ echo "NOTIFY:\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_files_present reconcile_canary_box reconcile_target_boxes reconcile_checkfail_count reconcile_bump_cfgfail reconcile_reset_cfgfail reconcile_config_pass; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
config_get(){ return 1; }   # canary defaults to grok-box-008
tunnel_up(){ return 0; }
# canary (grok-box-008) always succeeds; grok-box-003 (non-canary) always fails.
push_managed(){ case "\$1" in grok-box-003) return 1 ;; *) return 0 ;; esac; }
for tick in 1 2 3 4; do echo "TICK\$tick:"; reconcile_config_pass 1; done
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
cn_out="$(cfgnotify_test)"
# Isolate the notify lines carrying the count for grok-box-003.
case "$cn_out" in *"NOTIFY:warn config push failing for grok-box-003: 4"*) pass "D9: notify warn fires at the call site when cfgfail crosses > 3" ;; *) bad "D9 call-site notify>3 missing: [$cn_out]" ;; esac
case "$cn_out" in *"NOTIFY:warn config push failing for grok-box-003: 3"*) bad "D9: notify fired at exactly 3 (threshold is strictly > 3): [$cn_out]" ;; *) pass "D9: no notify at count 3 (threshold is strictly > 3)" ;; esac

# =============================================================================
# D11b (r5 ADDENDUM + r5.1): canary-unreachable fall-through, content-failure
# threshold, non-canary transport skip, probe exit-code contract, and the
# cmd_reconcile exit-code-isolation mutant guard.
# =============================================================================

# --- D11b: canary rc 6 (transport unreachable) => SKIP CANARY ONLY, FALL
# THROUGH to the non-canary loop; pass rc 0, NO notify, NO cfgfail (r5.1 B1).
# Uses the stub cfgpass_test (canary_v=6 => push_managed reports transport).
cp_can6="$(cfgpass_test yes 1 6 0)"
case "$cp_can6" in
  *"PUSH grok-box-008 dry=0|PUSH grok-box-003 dry=0|PUSH grok-box-005 dry=0|"*)
    pass "D11b/B1: canary rc 6 (unreachable) => canary skipped, NON-canary boxes STILL processed (fall-through)" ;;
  *) bad "D11b/B1: canary rc 6 did not fall through to the rest: [$cp_can6]" ;;
esac
case "$cp_can6" in *"PASSRC=0"*) pass "D11b/B1: canary rc 6 => pass rc 0 (transport skip is not a failure)" ;; *) bad "D11b/B1: canary rc 6 pass rc non-zero: [$cp_can6]" ;; esac
case "$cp_can6" in *NOTIFY*) bad "D11b/B1: canary rc 6 must NOT notify: [$cp_can6]" ;; *) pass "D11b/B1: canary rc 6 fires NO notify" ;; esac
case "$cp_can6" in *"CFGFAIL grok-box-008"*) bad "D11b/B1: canary rc 6 must NOT bump .cfgfail: [$cp_can6]" ;; *) pass "D11b/B1: canary rc 6 leaves .cfgfail untouched" ;; esac
case "$cp_can6" in *"continuing without canary protection"*) pass "D11b/B1: canary rc 6 logs the fall-through info line (one line, supersedes D6a wording)" ;; *) bad "D11b/B1: fall-through info line missing: [$cp_can6]" ;; esac

# --- D11b (r5.1 add): canary rc 4 (CONTENT failure) => non-canary boxes NOT
# processed (abort preserved), NO cfgfail on the untouched rest.
cp_can4="$(cfgpass_test yes 1 4 0)"
case "$cp_can4" in *"PUSH grok-box-003"*) bad "D11b: canary rc 4 (content) must ABORT — grok-box-003 must not be touched: [$cp_can4]" ;; *"PUSH grok-box-008 dry=0|"*) pass "D11b: canary rc 4 (content) => abort preserved, non-canary boxes NOT processed" ;; *) bad "D11b canary rc4 abort wrong: [$cp_can4]" ;; esac

# --- D11b: non-canary rc 6 => info skip line, NO cfgfail bump, CONTINUE (D6d).
cp_rest6="$(cfgpass_test yes 1 0 6)"
case "$cp_rest6" in
  *"PUSH grok-box-008 dry=0|PUSH grok-box-003 dry=0|PUSH grok-box-005 dry=0|"*)
    pass "D11b/D6d: a non-canary rc 6 box is attempted then the pass CONTINUES to the rest" ;;
  *) bad "D11b/D6d: non-canary rc 6 did not continue: [$cp_rest6]" ;;
esac
case "$cp_rest6" in *"CFGFAIL grok-box-003"*) bad "D11b/D6d: non-canary rc 6 must NOT bump .cfgfail: [$cp_rest6]" ;; *) pass "D11b/D6d: non-canary rc 6 leaves .cfgfail untouched (transport is the per-box loop's job)" ;; esac
case "$cp_rest6" in *"skip grok-box-003 — unreachable over tunnel"*) pass "D11b/D6d: non-canary rc 6 logs the 'unreachable over tunnel' skip line" ;; *) bad "D11b/D6d: non-canary rc 6 skip line missing: [$cp_rest6]" ;; esac
case "$cp_rest6" in *"PASSRC=0"*) pass "D11b/D6d: a non-canary rc 6 (transport) does NOT fail the pass" ;; *) bad "D11b/D6d: non-canary rc 6 failed the pass: [$cp_rest6]" ;; esac

# --- D11b: canary rc 4 on 4 consecutive ticks => notify ONLY on the 4th (D6b
# threshold >3), and a success on the 5th tick RESETS the counter. Drives the
# REAL reconcile_config_pass with a stub push_managed whose canary verdict is
# controlled per tick via an env file.
cfgcanary_ticks_test() {
  local inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"; mkdir -p "$d/etc/boxes" "$d/state"
  printf '[update]\nrepo = x\n' > "$d/etc/fleet.toml"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/etc/fleet.toml"; FLEET_MANAGED_BOXDIR="$d/etc/boxes"
FLEET_STATE="$d/state"; FLEET_BOXES="grok-box-008 grok-box-003"
log(){ :; }; notify(){ echo "NOTIFY:\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_files_present reconcile_canary_box reconcile_target_boxes reconcile_checkfail_count reconcile_bump_cfgfail reconcile_reset_cfgfail reconcile_config_pass; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
config_get(){ return 1; }   # canary defaults to grok-box-008
tunnel_up(){ return 0; }
# canary verdict is read from \$d/verdict each tick (content failure rc 4);
# non-canary grok-box-003 always succeeds so it never pollutes the picture.
push_managed(){ case "\$1" in grok-box-008) return \$(cat "$d/verdict") ;; *) return 0 ;; esac; }
echo 4 > "$d/verdict"
for tick in 1 2 3 4; do echo "TICK\$tick:"; reconcile_config_pass 1; done
echo 0 > "$d/verdict"   # canary recovers
echo "TICK5:"; reconcile_config_pass 1
[ -f "$d/state/grok-box-008.cfgfail" ] && echo "CFGFAIL8=\$(cat "$d/state/grok-box-008.cfgfail")" || echo "CFGFAIL8=gone"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
ct_out="$(cfgcanary_ticks_test)"
case "$ct_out" in *"NOTIFY:warn config push failing for grok-box-008: 4 consecutive failures — config pass aborted"*) pass "D11b/D6b: canary content failure notifies on the 4th tick (threshold >3) with the pass-aborted wording" ;; *) bad "D11b/D6b: canary threshold notify missing/misworded: [$ct_out]" ;; esac
case "$ct_out" in *"grok-box-008: 3 consecutive"*|*"grok-box-008: 2 consecutive"*|*"grok-box-008: 1 consecutive"*) bad "D11b/D6b: canary notified at count <=3 (threshold is strictly >3): [$ct_out]" ;; *) pass "D11b/D6b: canary does NOT notify at counts 1-3 (threshold strictly >3)" ;; esac
case "$ct_out" in *"CFGFAIL8=gone"*) pass "D11b/D6b: a canary SUCCESS after failures RESETS the cfgfail counter" ;; *) bad "D11b/D6b: canary success did not reset the counter: [$ct_out]" ;; esac

# --- D11b: canary rc 6 via the REAL push_managed (fake tunnel_ssh => ssh rc 255)
# proves the transport classification end-to-end: the canary push returns 6 and
# the pass falls through to the non-canary boxes with pass rc 0, no notify.
cfgpass_real6_test() {
  local inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"; mkdir -p "$d/etc/boxes" "$d/state" "$d/box"
  printf '[update]\nrepo = "https://fleet/repo.git"\n' > "$d/etc/fleet.toml"
  printf 'MANAGED_FILE=/x\ncase "$1 $2 $3" in "config-get managed enabled") echo true;; esac\n' > "$d/box/boxup"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/etc/fleet.toml"; FLEET_MANAGED_BOXDIR="$d/etc/boxes"
FLEET_STATE="$d/state"; FLEET_BOXES="grok-box-008 grok-box-003"
BOX_ROOT="$d/box"; BOX_MANAGED="$d/box/managed.toml"
log(){ echo "LOG:\$*"; }; notify(){ echo "NOTIFY:\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_files_present reconcile_canary_box reconcile_target_boxes reconcile_checkfail_count reconcile_bump_cfgfail reconcile_reset_cfgfail managed_header render_managed validate_managed unknown_managed_keys managed_remote_script push_managed reconcile_config_pass; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
config_get(){ return 1; }
tunnel_up(){ return 0; }
# Fake tunnel_ssh: the CANARY (port 20008) is unreachable => emulate ssh's
# rc 255 with no output; every other box runs the remote script locally.
port_for(){ case "\$1" in grok-box-008) echo 20008;; grok-box-003) echo 20003;; esac; }
tunnel_ssh(){
  local box="\$1"; shift
  if [ "\$box" = grok-box-008 ]; then return 255; fi   # transport dead
  local c="\$*"; local s="\${c#sudo sh -c \\'}"; s="\${s%\\'}"; sh -c "\$s"
}
reconcile_config_pass 1; echo "PASSRC=\$?"
[ -f "$d/state/grok-box-008.cfgfail" ] && echo "CFGFAIL8=present" || echo "CFGFAIL8=gone"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
r6_out="$(cfgpass_real6_test)"
case "$r6_out" in *"continuing without canary protection"*) pass "D11b/B1 (real): a REAL push_managed classifies ssh rc 255 as rc 6 => canary fall-through info line" ;; *) bad "D11b/B1 (real): fall-through line missing: [$r6_out]" ;; esac
case "$r6_out" in *"grok-box-003 pushed"*|*"grok-box-003 in sync"*|*"grok-box-003 WOULD"*) pass "D11b/B1 (real): with the canary unreachable, non-canary grok-box-003 IS pushed in the same pass" ;; *) bad "D11b/B1 (real): non-canary box not processed after canary 255: [$r6_out]" ;; esac
case "$r6_out" in *"PASSRC=0"*) pass "D11b/B1 (real): a transport-unreachable canary yields pass rc 0" ;; *) bad "D11b/B1 (real): pass rc non-zero: [$r6_out]" ;; esac
case "$r6_out" in *NOTIFY*) bad "D11b/B1 (real): unreachable canary must not notify: [$r6_out]" ;; *) pass "D11b/B1 (real): unreachable canary fires no notify" ;; esac
case "$r6_out" in *"CFGFAIL8=gone"*) pass "D11b/B1 (real): unreachable canary does not bump .cfgfail" ;; *) bad "D11b/B1 (real): canary cfgfail bumped on transport failure: [$r6_out]" ;; esac

# --- D11b: probe exit 1 (absent [managed] key) => enabled=true and `config diff`
# reports IN SYNC (exit 0) — the live grok-box-1 fix (D5b). Fake boxup whose
# config-get exits 1 (no [managed] table), supported, on-box file == render.
cfgprobe_diff_test() {
  # args: probe_exit(1|2)
  local pexit="$1" inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"; mkdir -p "$d/etc/boxes" "$d/state" "$d/box"
  printf '%s' "$FLEETC" > "$d/etc/fleet.toml"; printf '%s' "$BOXC" > "$d/etc/boxes/grok-box-008.toml"
  printf 'grok-box-008\t20008\n' > "$d/state/enrolled.tsv"
  # Supported boxup; config-get exits with the requested code (1 = absent key,
  # 2 = an "other" error). No stdout on the non-zero paths (like the real reader).
  printf 'MANAGED_FILE=/x\ncase "$1 $2 $3" in "config-get managed enabled") exit %s;; esac\n' "$pexit" > "$d/box/boxup"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STATE="$d/state"
FLEET_MANAGED_FLEET="$d/etc/fleet.toml"; FLEET_MANAGED_BOXDIR="$d/etc/boxes"
BOX_ROOT="$d/box"; BOX_MANAGED="$d/box/managed.toml"
log(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index reconcile_target_boxes cmd_config_enrolled cmd_config render_managed managed_header validate_managed managed_remote_script; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
render_managed grok-box-008 > "$d/box/managed.toml"   # on-box file == render => in sync
tunnel_ssh(){ shift; local c="\$*"; local s="\${c#sudo sh -c \\'}"; s="\${s%\\'}"; sh -c "\$s"; }
cmd_config diff grok-box-008; echo "DIFFRC=\$?"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
pd1="$(cfgprobe_diff_test 1)"
case "$pd1" in *"IGNORED"*) bad "D11b/D5b: absent-key (exit 1) must NOT annotate IGNORED — it means enabled=true: [$pd1]" ;; *"DIFFRC=0"*) pass "D11b/D5b: probe exit 1 (absent [managed]) => enabled=true, config diff reports IN SYNC (exit 0) — the grok-box-1 fix" ;; *) bad "D11b/D5b: absent-key diff not in sync: [$pd1]" ;; esac
pd2="$(cfgprobe_diff_test 2)"
case "$pd2" in *"managed-status probe failed"*) case "$pd2" in *"DIFFRC=1"*) pass "D11b/D5b: probe exit 2 (other error) => enabled=unknown => diff annotates 'probe failed' + never in-sync (exit 1)" ;; *) bad "D11b/D5b: probe exit 2 unknown must not be in-sync: [$pd2]" ;; esac ;; *) bad "D11b/D5b: probe exit 2 did not annotate unknown: [$pd2]" ;; esac

# --- D11b MUTANT GUARD (D6c): a FAILING config pass must NOT change
# cmd_reconcile's rc when the per-box reconcile loop is clean. Drives the REAL
# cmd_reconcile tail (the per-box loop + the config-pass call + the closing
# return) with a stubbed reconcile_config_pass that returns 1 (mutant) and a
# clean per-box loop (reconcile_one returns 0). rc MUST stay 0.
reconcile_rc_isolation_test() {
  # args: pass_rc (the config pass's return code) loop_rc (per-box loop verdict)
  local pass_rc="$1" loop_rc="$2" inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"
  cat > "$inner" <<INNER
set -u
# Reproduce the cmd_reconcile tail EXACTLY as shipped (the loop + config pass +
# return), extracted by anchoring on the shipped source lines so this guard
# tracks the real control flow, not a hand copy. Wrapped in a function so the
# shipped \`return "\$rc"\` is legal (return outside a function errors).
tail_src="\$(awk '/^  local rc=0\$/{p=1} p{print} /^  return "\\\$rc"\$/{if(p){exit}}' "$FLEETCTL")"
boxes=(a b c)
devs=x; apply=0; RECONCILE_READONLY=0; mode=dry-run
log(){ :; }
reconcile_one(){ return $loop_rc; }               # per-box loop verdict
reconcile_config_pass(){ return $pass_rc; }        # MUTANT: failing config pass
eval "_reconcile_tail() {
\$tail_src
}"
_reconcile_tail
echo "RECONCILE_RC=\$?"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
# mutant: config pass returns 1 but the per-box loop is clean => rc MUST be 0.
mut_clean="$(reconcile_rc_isolation_test 1 0)"
case "$mut_clean" in *"RECONCILE_RC=0"*) pass "D11b/D6c MUTANT: a FAILING config pass (rc 1) does NOT flip cmd_reconcile's rc when the per-box loop is clean" ;; *) bad "D11b/D6c MUTANT: config pass rc leaked into cmd_reconcile rc: [$mut_clean]" ;; esac
# control: a per-box loop failure DOES set rc 1 (the config pass is clean here).
mut_loop="$(reconcile_rc_isolation_test 0 1)"
case "$mut_loop" in *"RECONCILE_RC=1"*) pass "D11b/D6c: a per-box loop failure still sets cmd_reconcile rc 1 (isolation is one-way)" ;; *) bad "D11b/D6c: per-box loop failure did not set rc 1: [$mut_loop]" ;; esac

# =============================================================================
# r5.2 (E1/E2): quote-safe remote script + rc-6-means-transport-only. Closes the
# EMPIRICAL r5.1 FAIL: apostrophes in managed_remote_script comment lines broke
# the real `sudo sh -c '<script>'` wrapping (every box rc 2, no status line), and
# the broad rc-6 classifier masked that as transport (ok=0 skipped=7 failed=0).
# =============================================================================

# --- E1 SECONDARY guard (fast char scan): the REAL managed_remote_script output
# must contain no `'` (apostrophe, the sole char that terminates the outer
# `sh -c '…'`) and no backtick. This is a cheap tripwire; the AUTHORITATIVE guard
# is the push-through-real-wrapping test below.
mrs_scan_test() {
  local dry="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
BOX_ROOT=/workspace/box-setup; BOX_MANAGED=/workspace/box-setup/managed.toml
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" managed_remote_script)"
managed_remote_script deadbeef "$dry"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
for dry in 0 1; do
  scan="$(mrs_scan_test "$dry")"
  case "$scan" in *"'"*) bad "E1: managed_remote_script (dry=$dry) emits an apostrophe — breaks sudo sh -c '<script>': [$scan]" ;; *) pass "E1: managed_remote_script (dry=$dry) output carries NO apostrophe (secondary char scan)" ;; esac
  case "$scan" in *'`'*) bad "E1: managed_remote_script (dry=$dry) emits a backtick: [$scan]" ;; *) pass "E1: managed_remote_script (dry=$dry) output carries NO backtick (secondary char scan)" ;; esac
done

# --- E1 AUTHORITATIVE guard (S1): push the rendered text through the SAME
# `sudo sh -c '$remote'` wrapping the live brain uses, parsed by a REAL shell —
# NOT the manual-strip fake other tests use. tunnel_ssh runs `sh -c "$*"` where
# $* is literally `sudo sh -c '<script>'`, with a fake `sudo` on PATH that just
# runs `sh -c` of its argument. An apostrophe anywhere in $remote terminates the
# outer quote and the remote command dies with a syntax error before any status
# line — exactly the live r5.1 break. This is the mutant-killing gate.
wrap_test() {
  local inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"; mkdir -p "$d/boxes" "$d/box" "$d/bin"
  printf '%s' "$FLEETC" > "$d/fleet.toml"; printf '%s' "$BOXC" > "$d/boxes/grok-box-008.toml"
  # Fake sudo: `sudo sh -c '<script>'` => exec `sh -c '<script>'` (drop argv[1]).
  printf '#!/bin/sh\nexec "$@"\n' > "$d/bin/sudo"; chmod +x "$d/bin/sudo"
  # Fake boxup: supported + config-get answers true.
  printf 'MANAGED_FILE=/x\ncase "$1 $2 $3" in "config-get managed enabled") echo true;; esac\n' > "$d/box/boxup"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/fleet.toml"; FLEET_MANAGED_BOXDIR="$d/boxes"
BOX_ROOT="$d/box"; BOX_MANAGED="$d/box/managed.toml"
PATH="$d/bin:\$PATH"; export PATH
log(){ echo "LOG:\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_header render_managed validate_managed unknown_managed_keys managed_remote_script push_managed; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
# REAL wrapping: run the FULL command string through a real shell so the outer
# single-quote boundary of \`sudo sh -c '<script>'\` is parsed by the shell,
# not manually stripped. This is the boundary the VPS actually exercises.
tunnel_ssh(){ shift; sh -c "\$*"; }
push_managed grok-box-008; echo "PUSHRC=\$?"
[ -f "$d/box/managed.toml" ] && echo "ONBOX=present" || echo "ONBOX=absent"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
w_out="$(wrap_test)"
case "$w_out" in *"pushed (none->"*"PUSHRC=0"*) pass "E1/S1 (authoritative): push_managed through the REAL sudo sh -c '<script>' wrapping writes managed.toml, rc 0" ;; *) bad "E1/S1: push through real sh -c wrapping FAILED (apostrophe/quoting break): [$w_out]" ;; esac
case "$w_out" in *"ONBOX=present"*) pass "E1/S1 (authoritative): the on-box file was actually written through the real wrapping" ;; *) bad "E1/S1: real-wrapping push wrote no file: [$w_out]" ;; esac

# --- E2: rc classifier. Drive the REAL push_managed with a fake tunnel_ssh whose
# remote-side behaviour we control precisely, isolating each rc case.
# rc_test <mode>: mode selects the fake remote behaviour.
#   nostatus2  => remote exits 2 emitting NO status line (a script that could not
#                 run — the r5.1 syntax-break signature) => push_managed MUST 5.
#   ssh255     => tunnel_ssh returns 255 with no output (transport)         => 6.
#   status_rc  => remote emits a valid status line THEN the ssh call exits 7
#                 (a non-3 rc WITH a status line) => returned VERBATIM (7) (S2).
rc_test() {
  local mode="$1" inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"; mkdir -p "$d/boxes" "$d/box"
  printf '%s' "$FLEETC" > "$d/fleet.toml"; printf '%s' "$BOXC" > "$d/boxes/grok-box-008.toml"
  printf 'MANAGED_FILE=/x\ncase "$1 $2 $3" in "config-get managed enabled") echo true;; esac\n' > "$d/box/boxup"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/fleet.toml"; FLEET_MANAGED_BOXDIR="$d/boxes"
BOX_ROOT="$d/box"; BOX_MANAGED="$d/box/managed.toml"
log(){ echo "LOG:\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_header render_managed validate_managed unknown_managed_keys managed_remote_script push_managed; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
case "$mode" in
  nostatus2) tunnel_ssh(){ cat >/dev/null; return 2; } ;;                       # ran, no status line, rc 2
  ssh255)    tunnel_ssh(){ cat >/dev/null; return 255; } ;;                     # transport
  status_rc) tunnel_ssh(){ cat >/dev/null; echo "sha=deadbeef cur=none support=yes enabled=true"; return 7; } ;;  # status line + non-3 rc
esac
push_managed grok-box-008; echo "PUSHRC=\$?"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
rc_ns2="$(rc_test nostatus2)"
case "$rc_ns2" in *"PUSHRC=5"*) pass "E2: a non-3 rc (2) with NO status line => rc 5 (script/probe failure, a CONTENT defect)" ;; *) bad "E2: rc=2/no-status not reclassified to 5: [$rc_ns2]" ;; esac
case "$rc_ns2" in *"remote script FAILED (rc=2, no status line)"*) pass "E2: rc=2/no-status logs the 'remote script FAILED' content-failure line (not 'unreachable')" ;; *) bad "E2: rc=2/no-status logged the wrong line: [$rc_ns2]" ;; esac
rc_255="$(rc_test ssh255)"
case "$rc_255" in *"PUSHRC=6"*) pass "E2: ssh rc 255 => rc 6 (transport unreachable, skip path unchanged)" ;; *) bad "E2: rc=255 not classified as 6: [$rc_255]" ;; esac
case "$rc_255" in *"unreachable over tunnel (ssh rc=255)"*) pass "E2: rc 255 logs the transport 'unreachable' line" ;; *) bad "E2: rc=255 logged the wrong line: [$rc_255]" ;; esac
rc_sv="$(rc_test status_rc)"
case "$rc_sv" in *"PUSHRC=7"*) pass "E2/S2: a non-3 rc (7) that DID emit a status line is returned VERBATIM (not collapsed to 5)" ;; *) bad "E2/S2: non-3 rc with status line not returned verbatim: [$rc_sv]" ;; esac

# --- E2 (pass integration): a non-canary box whose remote script fails with
# rc=2/no-status must land in failed=N (never skipped=). Drives the REAL
# reconcile_config_pass + REAL push_managed; the canary succeeds, grok-box-003's
# fake tunnel returns rc 2 with no status line.
cfg_fail_summary_test() {
  local inner; inner="$(mktemp)"; local d; d="$(mktemp -d)"; mkdir -p "$d/etc/boxes" "$d/state" "$d/box"
  printf '[update]\nrepo = "https://fleet/repo.git"\n' > "$d/etc/fleet.toml"
  printf 'MANAGED_FILE=/x\ncase "$1 $2 $3" in "config-get managed enabled") echo true;; esac\n' > "$d/box/boxup"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_MANAGED_FLEET="$d/etc/fleet.toml"; FLEET_MANAGED_BOXDIR="$d/etc/boxes"
FLEET_STATE="$d/state"; FLEET_BOXES="grok-box-008 grok-box-003"
BOX_ROOT="$d/box"; BOX_MANAGED="$d/box/managed.toml"
log(){ echo "LOG:\$*"; }; notify(){ echo "NOTIFY:\$*"; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index managed_files_present reconcile_canary_box reconcile_target_boxes reconcile_checkfail_count reconcile_bump_cfgfail reconcile_reset_cfgfail managed_header render_managed validate_managed unknown_managed_keys managed_remote_script push_managed reconcile_config_pass; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
config_get(){ return 1; }
tunnel_up(){ return 0; }
# canary runs the remote for real (succeeds); grok-box-003 fails rc 2, no status.
tunnel_ssh(){
  local box="\$1"; shift
  if [ "\$box" = grok-box-003 ]; then cat >/dev/null; return 2; fi
  local c="\$*"; local s="\${c#sudo sh -c \\'}"; s="\${s%\\'}"; sh -c "\$s"
}
reconcile_config_pass 1; echo "PASSRC=\$?"
[ -f "$d/state/grok-box-003.cfgfail" ] && echo "CFGFAIL3=\$(cat "$d/state/grok-box-003.cfgfail")" || echo "CFGFAIL3=gone"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
fs_out="$(cfg_fail_summary_test)"
case "$fs_out" in *"pass done (apply) ok=1 skipped=0 failed=1"*) pass "E2: a non-canary rc=2/no-status box lands in failed=1 (NOT skipped=) in the pass summary" ;; *) bad "E2: rc=2/no-status did not surface as failed=1: [$fs_out]" ;; esac
case "$fs_out" in *"CFGFAIL3=1"*) pass "E2: a rc=5 (script failure) non-canary box bumps .cfgfail (content-failure routing)" ;; *) bad "E2: rc=5 non-canary did not bump .cfgfail: [$fs_out]" ;; esac
case "$fs_out" in *"PASSRC=1"*) pass "E2: a script-failure non-canary box makes the pass return rc 1" ;; *) bad "E2: pass rc not 1 with a failed box: [$fs_out]" ;; esac

rm -rf "$CFG_FIXROOT"

rm -f "$seedA" "$seedB" "$seedC"

# =============================================================================
# #10 D6 — reconcile_identity_pass (LOG-ONLY, F3). Fixture device list => the
# per-device identity: lines + the `identity: ok=N flagged=M` summary. Asserts
# NO notify/counter/threshold (F3), correct grok-box-* filtering, and the -1
# split-brain corpse folding WITHOUT mauling grok-box-1.
# =============================================================================
identitypass_test() {
  local devs="$1" inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" reconcile_identity_pass)"
log(){ printf 'LOG:%s\n' "\$*"; }
notify(){ printf 'NOTIFY:%s\n' "\$*"; }
reconcile_identity_pass '$devs'
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
IDENT_DEVS='{"devices":[
 {"hostname":"grok-box-1","tags":["tag:grok-box"],"keyExpiryDisabled":true},
 {"hostname":"grok-box-9","keyExpiryDisabled":false,"expires":"2027-02-25T12:55:08Z"},
 {"name":"grok-box-10","tags":["tag:grok-box"],"keyExpiryDisabled":false,"expires":"2027-02-25T13:47:46Z"},
 {"hostname":"grok-box-3-1","tags":["tag:grok-box"],"keyExpiryDisabled":true},
 {"hostname":"some-laptop","tags":[],"keyExpiryDisabled":false}
]}'
ident_out="$(identitypass_test "$IDENT_DEVS")"
case "$ident_out" in
  *"LOG:identity: grok-box-9 untagged"*) pass "#10 D6 identity: untagged grok-box-9 logged" ;;
  *) bad "#10 D6 identity untagged line missing: [$ident_out]" ;;
esac
case "$ident_out" in
  *"LOG:identity: grok-box-10 key-expiry-enabled expires=2027-02-25T13:47:46Z"*) pass "#10 D6 identity: key-expiry-enabled grok-box-10 logged with expires" ;;
  *) bad "#10 D6 identity key-expiry-enabled line missing: [$ident_out]" ;;
esac
# ok=2 (grok-box-1 + grok-box-3 corpse-folded), flagged=2 (9 untagged, 10 expiry).
case "$ident_out" in
  *"LOG:identity: ok=2 flagged=2"*) pass "#10 D6 identity summary: ok=2 flagged=2 (grok-box-3-1 folded to grok-box-3; grok-box-1 NOT mauled; laptop ignored)" ;;
  *) bad "#10 D6 identity summary wrong: [$ident_out]" ;;
esac
# F3: LOG-ONLY — no notify at all.
case "$ident_out" in
  *NOTIFY:*) bad "#10 D6/F3 identity pass emitted a NOTIFY (must be log-only this round): [$ident_out]" ;;
  *) pass "#10 D6/F3 identity pass is LOG-ONLY (no notify/counter/threshold)" ;;
esac
# box-naming-3digit D6: a non-canonical DISCOVERED name logs `legacy-name`.
case "$ident_out" in
  *"LOG:identity: grok-box-9 legacy-name"*) pass "D6 legacy-name: unpadded discovered grok-box-9 flagged legacy-name" ;;
  *) bad "D6 legacy-name: grok-box-9 legacy line missing: [$ident_out]" ;;
esac
# The -1 split-brain corpse folds to its base and is flagged legacy under the base.
case "$ident_out" in
  *"LOG:identity: grok-box-3 legacy-name"*) pass "D6 legacy-name: corpse grok-box-3-1 folds to grok-box-3 and is flagged legacy-name" ;;
  *) bad "D6 legacy-name: folded grok-box-3 legacy line missing: [$ident_out]" ;;
esac
# A CANONICAL three-digit discovered name must NOT be flagged legacy.
ident_canon="$(identitypass_test '{"devices":[{"hostname":"grok-box-008","tags":["tag:grok-box"],"keyExpiryDisabled":true}]}')"
case "$ident_canon" in
  *"legacy-name"*) bad "D6 legacy-name: canonical grok-box-008 wrongly flagged legacy: [$ident_canon]" ;;
  *) pass "D6 legacy-name: canonical grok-box-008 is NOT flagged legacy" ;;
esac
# D6 "enrolled or discovered": a box ENROLLED under a non-canonical name is
# flagged legacy even on a READ-ONLY run (empty device list, local enrolled.tsv).
identity_enrolled_test() {
  local inner; inner="$(mktemp)"
  local d; d="$(mktemp -d)"; mkdir -p "$d/state"
  printf 'grok-box-7\t20007\ngrok-box-004\t20004\n' > "$d/state/enrolled.tsv"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STATE="$d/state"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in box_index_from_name box_name_from_index reconcile_target_boxes reconcile_identity_pass; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
log(){ printf 'LOG:%s\n' "\$*"; }
notify(){ printf 'NOTIFY:%s\n' "\$*"; }
reconcile_identity_pass ''
INNER
  timeout 15 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}
ident_enr="$(identity_enrolled_test)"
case "$ident_enr" in
  *"LOG:identity: grok-box-7 legacy-name"*) pass "D6 legacy-name: enrolled non-canonical grok-box-7 flagged legacy on a read-only run" ;;
  *) bad "D6 legacy-name: enrolled grok-box-7 legacy line missing: [$ident_enr]" ;;
esac
case "$ident_enr" in
  *"grok-box-004 legacy-name"*) bad "D6 legacy-name: enrolled canonical grok-box-004 wrongly flagged: [$ident_enr]" ;;
  *) pass "D6 legacy-name: enrolled canonical grok-box-004 is NOT flagged legacy" ;;
esac

# Empty device list (READ-ONLY run) => silent no-op (no lines at all).
[ -z "$(identitypass_test '')" ] \
  && pass "#10 D6 identity pass: empty device list (read-only run) => silent no-op" \
  || bad  "#10 D6 identity pass not silent on empty list: [$(identitypass_test '')]"

# =============================================================================
# RENAME (box-naming-3digit D4 + F2/F3/F4/F6/F7) — box-free, VPS-free, API-free.
# Drives cmd_rename through a fake $FLEET_STATE/$FLEET_ETC with tunnel_ssh /
# tunnel_up / devices_json / ts_api / ts_api_body / flock all stubbed. Each run
# gets its own temp dirs; the stubs are steered by env vars written into the
# inner script.
# =============================================================================
rename_fns="box_index_from_name box_name_from_index port_for box_index cmd_config_enrolled reconcile_target_boxes dev_field devices_json_valid rename_ver_ge rename_box_boxup_version rename_dev_hostname rename_dev_dnslabel rename_dev_liveid rename_corpse_id rename_plan_paths rename_copy_state rename_delete_old_state rename_state_copied cmd_rename"

# rename_run <flags> <old> <new> : with env HOOK_* controlling the stubs.
rename_run() {
  local args="$1"; shift 2>/dev/null || true
  local inner; inner="$(mktemp)"
  local d; d="$(mktemp -d)"
  mkdir -p "$d/state/keys" "$d/etc/authorized-keys.d" "$d/etc/boxes"
  # Seed OLD-name state (grok-box-2, port 20002, index 2).
  printf 'grok-box-2\t20002\n'                 >  "$d/state/enrolled.tsv"
  printf 'grok-box-2\t2027-01-01\n'            >  "$d/state/grok-box-2.expires"
  printf '0\n'                                 >  "$d/state/grok-box-2.checkfail"
  printf '0\n'                                 >  "$d/state/grok-box-2.cfgfail"
  printf 'restrict,... permitlisten="127.0.0.1:20002" ssh-ed25519 KEYMAT grok-tunnel-grok-box-2\n' > "$d/etc/authorized-keys.d/grok-box-2.line"
  printf 'grok-box-2\t20002\tKEYMAT\n'         >  "$d/etc/authorized-keys.map"
  printf '[managed]\nenabled = true\n'         >  "$d/etc/boxes/grok-box-2.toml"
  # Snapshot the authoritative ~fleet authorized_keys (F6: must be untouched).
  printf 'AUTHORITATIVE-KEYS-LINE\n'           >  "$d/state/fleet_authkeys"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_STATE="$d/state"
FLEET_ETC="$d/etc"
FLEET_ETC_AK_DIR="$d/etc/authorized-keys.d"
FLEET_MANAGED_BOXDIR="$d/etc/boxes"
BOX_ROOT="/workspace/box-setup"
FLEET_STALE_SECS=600
RENAME_POLL_SECS=6
RENAME_POLL_INTERVAL=1
RENAME_MIN_BOXUP_VERSION=5.3.0
TS_API_CODE=0
TS_API_LAST_BODY=""
log(){ printf 'LOG:%s\n' "\$*"; }
notify(){ printf 'NOTIFY:%s\n' "\$*"; }
sleep(){ :; }                          # never actually sleep in tests
flock(){ echo "\$*" >> "$d/flockargs"; [ "\${HOOK_LOCK_HELD:-0}" = 1 ] && return 1; return 0; }   # arg-aware; lock free unless HOOK_LOCK_HELD
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in $rename_fns; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
# tunnel_up: normally every tunnel is up. HOOK_VERIFY_FAIL=1 fails ONLY the
# post-rename verify (tunnel_up <new>=grok-box-002) so the delete-last property
# (old-name state survives a FAILED verify => resumable) is observable (S2).
tunnel_up(){ [ "\${HOOK_VERIFY_FAIL:-0}" = 1 ] && [ "\$1" = grok-box-002 ] && return 1; return 0; }
# The box's boxup version (>= 5.3.0 unless overridden to a stale one).
rename_box_boxup_version(){ printf '%s' "\${HOOK_BOXVER:-5.3.0}"; }
# Record + no-op the on-box hostname write / boxup once.
tunnel_ssh(){ echo "TUNNEL_SSH \$*" >> "$d/tsslog"; return 0; }
# devices_json / ts_api / ts_api_body: a scripted device list that FLIPS to the
# new name after N polls (HOOK_FLIP_AT), with the DNS label pinned until a POST
# /device/name is seen (HOOK_DNS_PINNED). ts_api records POST/DELETE calls.
POLLN=0
_write_devs(){
  local host="\$1" dns="\$2" corpse=""
  [ "\${HOOK_CORPSE:-0}" = 1 ] && corpse=',{"hostname":"grok-box-2","name":"grok-box-2.tail.ts.net","online":false,"nodeId":"nCORPSE"}'
  cat > "$d/devs" <<DEVS
{"devices":[
 {"hostname":"\$host","name":"\$dns.tail.ts.net","online":true,"nodeId":"nLIVE"}\$corpse
]}
DEVS
}
devices_json(){
  POLLN=\$((POLLN+1))
  local host dns
  if [ "\$POLLN" -ge "\${HOOK_FLIP_AT:-1}" ]; then host=grok-box-002; else host=grok-box-2; fi
  if [ "\${HOOK_DNS_PINNED:-0}" = 1 ] && [ "\${POSTED:-0}" = 0 ]; then dns=grok-box-2; else dns=grok-box-002; fi
  _write_devs "\$host" "\$dns"
  TS_API_CODE=200; return 0
}
ts_api_body(){ cat "$d/devs" 2>/dev/null; }
ts_ok(){ [ "\$TS_API_CODE" -ge 200 ] && [ "\$TS_API_CODE" -lt 300 ]; }
POSTED=0
ts_api(){
  local method="\$1" path="\$2"
  echo "TSAPI \$method \$path" >> "$d/apilog"
  case "\$method \$path" in
    "POST "*"/name") POSTED=1; TS_API_CODE=200; return 0 ;;
    "DELETE /device/"*) TS_API_CODE=200; return 0 ;;
    *) TS_API_CODE=200; return 0 ;;
  esac
}
cmd_rename $args
echo "RC=\$?"
echo "--- enrolled ---"; cat "$d/state/enrolled.tsv" 2>/dev/null
echo "--- state files ---"; ls "$d/state" | tr '\n' ' '; echo
echo "--- akdir ---"; ls "$d/etc/authorized-keys.d" | tr '\n' ' '; echo
echo "--- boxes ---"; ls "$d/etc/boxes" | tr '\n' ' '; echo
echo "--- akmap ---"; cat "$d/etc/authorized-keys.map" 2>/dev/null
echo "--- authoritative (F6) ---"; cat "$d/state/fleet_authkeys" 2>/dev/null
echo "--- apilog ---"; cat "$d/apilog" 2>/dev/null
echo "--- flockargs ---"; cat "$d/flockargs" 2>/dev/null
echo "--- tsslog ---"; cat "$d/tsslog" 2>/dev/null
INNER
  timeout 30 bash "$inner"; rm -f "$inner"; rm -rf "$d"
}

# --- D4: refuse a non-canonical <new> -----------------------------------------
r_noncanon="$(rename_run 'grok-box-2 grok-box-2x')"
case "$r_noncanon" in
  *"RC=2"*) case "$r_noncanon" in *"not canonical"*) pass "rename: refuses a non-canonical <new> (rc 2)" ;; *) bad "rename non-canonical: wrong reason: [$r_noncanon]" ;; esac ;;
  *) bad "rename: did NOT refuse non-canonical <new>: [$r_noncanon]" ;;
esac

# --- D4: refuse an index change -----------------------------------------------
r_idx="$(rename_run 'grok-box-2 grok-box-003')"
case "$r_idx" in
  *"RC=2"*) case "$r_idx" in *"index change"*) pass "rename: refuses an index-changing rename (rc 2)" ;; *) bad "rename index-change: wrong reason: [$r_idx]" ;; esac ;;
  *) bad "rename: did NOT refuse an index change: [$r_idx]" ;;
esac

# --- D4: refuse when the box's boxup is too old (< 5.3.0) ----------------------
r_oldver="$(HOOK_BOXVER=5.2.0 rename_run 'grok-box-2 grok-box-002')"
case "$r_oldver" in
  *"update boxup first"*) pass "rename: refuses when the box boxup < 5.3.0 (update boxup first)" ;;
  *) bad "rename: did NOT refuse a stale box boxup: [$r_oldver]" ;;
esac

# --- F2/F7: reconcile lock held => rename waits then refuses -------------------
r_lock="$(HOOK_LOCK_HELD=1 rename_run 'grok-box-2 grok-box-002')"
case "$r_lock" in
  *"reconcile busy"*) pass "rename F2/F7: reconcile lock held => refuse with 'reconcile busy'" ;;
  *) bad "rename: did NOT refuse under a held reconcile lock: [$r_lock]" ;;
esac

# --- F4: --dry-run prints the plan and touches nothing ------------------------
r_dry="$(rename_run '--dry-run grok-box-2 grok-box-002')"
case "$r_dry" in
  *"DRY-RUN plan grok-box-2 -> grok-box-002"*) pass "rename F4: --dry-run prints the plan" ;;
  *) bad "rename: --dry-run plan missing: [$r_dry]" ;;
esac
case "$r_dry" in
  *"grok-box-2.expires"*"grok-box-002.expires"*) pass "rename F4: --dry-run lists the state artefact paths (old->new)" ;;
  *) bad "rename: --dry-run artefact paths missing: [$r_dry]" ;;
esac
case "$r_dry" in
  # dry-run must NOT have created a grok-box-002 enrolled row.
  *"--- enrolled ---"*"grok-box-002"*) bad "rename: --dry-run MUTATED enrolled.tsv (added grok-box-002): [$r_dry]" ;;
  *) pass "rename F4: --dry-run touches nothing (no grok-box-002 row created)" ;;
esac

# --- F3/F6: happy path migrates all artefacts, deletes old, keeps authoritative
r_happy="$(rename_run 'grok-box-2 grok-box-002')"
case "$r_happy" in *"RC=0"*) pass "rename happy: completes rc 0" ;; *) bad "rename happy: non-zero rc: [$r_happy]" ;; esac
# enrolled.tsv now has ONLY the new row (old deleted at step 6).
case "$r_happy" in
  *"--- enrolled ---"*"grok-box-002"$'\t'"20002"*) pass "rename F3: enrolled.tsv row migrated grok-box-2 -> grok-box-002 (same port)" ;;
  *) bad "rename: enrolled row not migrated: [$r_happy]" ;;
esac
case "$r_happy" in
  *"--- state files ---"*"grok-box-2."*) bad "rename F3 step6: OLD state sidecars not deleted: [$r_happy]" ;;
  *) pass "rename F3 step6: old-name state sidecars deleted" ;;
esac
case "$r_happy" in
  *"--- state files ---"*"grok-box-002.expires"*) pass "rename F3: new-name state sidecars present (expires copied)" ;;
  *) bad "rename: new-name state sidecars missing: [$r_happy]" ;;
esac
case "$r_happy" in
  *"--- akdir ---"*"grok-box-002.line"*) pass "rename F6: new-name authorized-keys.d audit copy present" ;;
  *) bad "rename: new .line audit copy missing: [$r_happy]" ;;
esac
case "$r_happy" in
  *"--- akdir ---"*"grok-box-2.line"*) bad "rename F6 step6: OLD .line audit copy not deleted: [$r_happy]" ;;
  *) pass "rename F6 step6: old .line audit copy deleted" ;;
esac
case "$r_happy" in
  *"--- boxes ---"*"grok-box-002.toml"*) pass "rename F3: boxes/<new>.toml copied" ;;
  *) bad "rename: boxes/<new>.toml missing: [$r_happy]" ;;
esac
case "$r_happy" in
  *"--- akmap ---"*"grok-box-002"$'\t'"20002"$'\t'"KEYMAT"*) pass "rename F6: authorized-keys.map row rewritten to the new name (same port/key)" ;;
  *) bad "rename: akmap row not migrated: [$r_happy]" ;;
esac
# F6: the authoritative ~fleet/.ssh/authorized_keys is NEVER touched.
case "$r_happy" in
  *"--- authoritative (F6) ---"*"AUTHORITATIVE-KEYS-LINE"*) pass "rename F6: authoritative ~fleet authorized_keys UNTOUCHED (key-material-keyed)" ;;
  *) bad "rename F6: authoritative authorized_keys was altered: [$r_happy]" ;;
esac
# The box hostname write + boxup once ran over the tunnel.
case "$r_happy" in
  *"TUNNEL_SSH"*"grok-box-002"*"boxup once"*) pass "rename F3 step3: wrote new hostname + ran boxup once on the box" ;;
  *) bad "rename: box hostname/boxup step missing: [$r_happy]" ;;
esac

# --- S1 / F2/F7: the reconcile lock is taken with a BOUNDED WAIT (-w 90), not -n
# The flock stub is argument-aware (records its args); a happy rename must have
# acquired fd 9 with `-w 90`. This kills mutant f (`flock -w 90` -> `flock -n`),
# which the old argument-blind stub could not distinguish.
case "$r_happy" in
  *"--- flockargs ---"*"-w 90"*) pass "rename F2/F7: acquires the reconcile lock with a bounded wait (-w 90), not -n" ;;
  *) bad "rename F2/F7: lock not taken with -w 90 (bounded wait): [$r_happy]" ;;
esac

# --- F3 step5: DNS-pinned label => POST /device/<id>/name EXACTLY once ---------
r_dns="$(HOOK_DNS_PINNED=1 rename_run 'grok-box-2 grok-box-002')"
case "$r_dns" in *"RC=0"*) : ;; *) bad "rename DNS-pinned: non-zero rc: [$r_dns]" ;; esac
napi="$(printf '%s\n' "$r_dns" | grep -c 'TSAPI POST /device/.*/name')"
[ "$napi" = 1 ] && pass "rename F3 step5: DNS-pinned label => POST /device/<id>/name exactly once" || bad "rename DNS-pinned: POST count=$napi (expected 1): [$r_dns]"

# --- F3 step7: corpse reaping deletes the OTHER old-name id only ---------------
r_corpse="$(HOOK_CORPSE=1 rename_run 'grok-box-2 grok-box-002')"
case "$r_corpse" in
  *"TSAPI DELETE /device/nCORPSE"*) pass "rename F3 step7: reaps the stale corpse device id" ;;
  *) bad "rename: corpse not reaped: [$r_corpse]" ;;
esac
case "$r_corpse" in
  *"DELETE /device/nLIVE"*) bad "rename F3 step7: deleted the RENAMED node's own live id (FORBIDDEN): [$r_corpse]" ;;
  *) pass "rename F3 step7: never deletes the renamed node's own live id" ;;
esac

# --- F3 resume: a rename re-run after step 2 already copied continues cleanly ---
r_resume="$(HOOK_FLIP_AT=1 rename_run 'grok-box-2 grok-box-002')"   # first run completes
# Re-running the SAME rename when new is already canonical+enrolled: cmd_config_enrolled(old)
# now fails (old row gone) — the command reports old not enrolled, which is the
# idempotent "already renamed" outcome (rc 2, no mutation of the finished state).
case "$r_resume" in *"RC=0"*) pass "rename resume: a completed happy path is rc 0 (state fully migrated)" ;; *) bad "rename resume base run failed: [$r_resume]" ;; esac

# --- S2 / F3 delete-last: a FAILED post-rename verify leaves OLD state INTACT ---
# HOOK_VERIFY_FAIL forces the verify (tunnel_up <new>) to fail. The rename must
# abort rc 1 BEFORE deleting the old-name artefacts, so grok-box-2 state survives
# and the rename is resumable. This kills mutant d (delete-old-state moved BEFORE
# the verify), which the old unconditional `tunnel_up(){ return 0; }` stub missed.
r_vf="$(HOOK_VERIFY_FAIL=1 rename_run 'grok-box-2 grok-box-002')"
case "$r_vf" in
  *"RC=1"*) pass "rename S2: a failed post-rename verify aborts rc 1" ;;
  *) bad "rename S2: expected rc 1 on a failed verify: [$r_vf]" ;;
esac
case "$r_vf" in
  *"--- state files ---"*"grok-box-2."*) pass "rename S2/F3 delete-last: OLD state SURVIVES a failed verify (resumable)" ;;
  *) bad "rename S2/F3: old state deleted despite a FAILED verify (not delete-last / not resumable): [$r_vf]" ;;
esac
case "$r_vf" in
  *"--- enrolled ---"*"grok-box-2"$'\t'"20002"*) pass "rename S2/F3 delete-last: OLD enrolled row SURVIVES a failed verify" ;;
  *) bad "rename S2/F3: old enrolled row deleted despite a FAILED verify: [$r_vf]" ;;
esac


echo "-----"
if [ "$fail" = 0 ]; then echo "ALL FLEET-BRAIN TESTS PASSED"; else echo "SOME FLEET-BRAIN TESTS FAILED"; fi
exit "$fail"
