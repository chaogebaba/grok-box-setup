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
eval "\$(extract_from "\$FLEETCTL" port_for)"
port_for "$n"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(portfor_test grok-box-1)" = 20001 ] && pass "port_for grok-box-1 => 20001" || bad "port_for grok-box-1 => [$(portfor_test grok-box-1)]"
[ "$(portfor_test 8)" = 20008 ] && pass "port_for 8 => 20008" || bad "port_for 8 => [$(portfor_test 8)]"

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
for fn in have api_token_file api_token ts_api ts_api_body ts_ok acl_has_fleet_brain_tagowner; do
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
for fn in box_index reconcile_decide reconcile_one reconcile_bump_checkfail reconcile_reset_checkfail days_until; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
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
for fn in reconcile_dedup dev_field ts_ok devices_json_valid; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
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
for fn in reconcile_rotate ts_ok; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
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
for fn in cmd_mint_key record_key_meta key_meta_file key_meta_id box_index mint_payload mint_create ts_ok; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
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
FLEET_BOXES="grok-box-3 grok-box-5 grok-box-8"
log(){ :; }
notify(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in reconcile_rollout reconcile_canary_box reconcile_target_boxes box_index; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
config_get(){ return 1; }           # no canary_box configured => default 8
reconcile_stage_rollout_tree(){ FLEET_ROLLOUT_TREE_STAGED=0; return 0; }  # a tree is staged
reconcile_cleanup_rollout_tree(){ :; }
tunnel_up(){ return 0; }            # every tunnel up
seq="\$(mktemp)"
# tunnel_deploy_one records the box, returns the per-box verdict.
tunnel_deploy_one(){
  echo "DEPLOY \$1" >> "\$seq"
  case "\$1" in
    grok-box-8) return $canary_verdict ;;
    grok-box-3) return $b3_verdict ;;
    *) return 0 ;;
  esac
}
reconcile_rollout grok-box-5 >/dev/null 2>&1
echo "rc=\$?"
tr '\n' '|' < "\$seq"; echo
rm -f "\$seq"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
# Canary first, all pass: deploy 8 THEN the rest (3,5 in enrolled order).
ro_all="$(rollout_order_test 0 0)"
case "$ro_all" in
  "rc=0"*"DEPLOY grok-box-8|DEPLOY grok-box-3|DEPLOY grok-box-5|"*)
    pass "rollout: canary (grok-box-8) deploys FIRST, then the rest serially" ;;
  *) bad "rollout order wrong: [$ro_all]" ;;
esac

# Canary FAILS verification => ABORT: ZERO other boxes touched.
ro_canfail="$(rollout_order_test 1 0)"
case "$ro_canfail" in
  "rc=1"*"DEPLOY grok-box-8|") pass "rollout: canary verified-FAILURE => ABORT, zero other boxes deployed" ;;
  *"DEPLOY grok-box-3"*|*"DEPLOY grok-box-5"*) bad "rollout: touched other boxes after canary failure (FORBIDDEN): [$ro_canfail]" ;;
  *) bad "rollout canary-fail wrong: [$ro_canfail]" ;;
esac

# A mid-list box (grok-box-3) FAILS => ABORT: grok-box-5 (after it) NOT deployed.
ro_midfail="$(rollout_order_test 0 1)"
case "$ro_midfail" in
  *"DEPLOY grok-box-5"*) bad "rollout: deployed grok-box-5 after grok-box-3 failed (abort-on-first-failure violated): [$ro_midfail]" ;;
  "rc=1"*"DEPLOY grok-box-8|DEPLOY grok-box-3|") pass "rollout: abort-on-first-failure stops NEW deploys after a verified failure" ;;
  *) bad "rollout mid-fail wrong: [$ro_midfail]" ;;
esac

# Canary tunnel DOWN => ABORT (cannot verify), zero deployed.
rollout_canary_down_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_BOXES="grok-box-3 grok-box-8"
log(){ :; }
notify(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in reconcile_rollout reconcile_canary_box reconcile_target_boxes box_index; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
config_get(){ return 1; }
reconcile_stage_rollout_tree(){ FLEET_ROLLOUT_TREE_STAGED=0; return 0; }
reconcile_cleanup_rollout_tree(){ :; }
tunnel_up(){ [ "\$1" = grok-box-8 ] && return 1 || return 0; }   # canary down
seq="\$(mktemp)"
tunnel_deploy_one(){ echo "DEPLOY \$1" >> "\$seq"; return 0; }
reconcile_rollout grok-box-3 >/dev/null 2>&1
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
eval "\$(extract_from "\$FLEETCTL" reconcile_canary_box)"
config_get(){ [ "\$1 \$2" = "fleet-brain canary_box" ] && echo 5; }
reconcile_canary_box
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(rollout_canary_cfg_test)" = grok-box-5 ] && pass "rollout: [fleet-brain].canary_box overrides the default (=> grok-box-5)" || bad "canary_box override wrong: [$(rollout_canary_cfg_test)]"
# Default (unset) => grok-box-8.
rollout_canary_default_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(extract_from "\$FLEETCTL" reconcile_canary_box)"
config_get(){ return 1; }
reconcile_canary_box
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
[ "$(rollout_canary_default_test)" = grok-box-8 ] && pass "rollout: canary_box default => grok-box-8" || bad "canary_box default wrong: [$(rollout_canary_default_test)]"

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
for fn in tunnel_deploy_one tunnel_ssh tunnel_scp port_for box_index; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
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
for fn in fleet_configured tunnel_state; do eval "\$(extract_from "\$BOXUP" "\$fn")"; done
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
for fn in fleet_configured fleet_port supervise_tunnel tunnel_pid tunnel_backoff_window tunnel_fail_count ensure_tunnel_key; do eval "\$(extract_from "\$BOXUP" "\$fn")"; done
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
for fn in fleet_configured fleet_port supervise_tunnel tunnel_backoff_window tunnel_fail_count; do eval "\$(extract_from "\$BOXUP" "\$fn")"; done
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
for fn in fleet_configured fleet_port supervise_tunnel tunnel_backoff_window tunnel_fail_count ensure_tunnel_key; do eval "\$(extract_from "\$BOXUP" "\$fn")"; done
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
for fn in cmd_reconcile reconcile_one reconcile_decide reconcile_target_boxes box_index reconcile_bump_checkfail reconcile_reset_checkfail reconcile_reset_seedfail reconcile_bump_seedfail reconcile_reset_asleep reconcile_reset_incoherent reconcile_alert_asleep reconcile_alert_incoherent mint_window_valid days_until reconcile_record_api_failure reconcile_reset_api_failure reconcile_backoff_active devices_json_valid key_meta_id key_meta_file ts_ok; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
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
for fn in reconcile_one reconcile_decide box_index reconcile_bump_checkfail reconcile_reset_checkfail reconcile_reset_seedfail reconcile_bump_seedfail reconcile_reset_asleep reconcile_reset_incoherent mint_window_valid days_until; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
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
for fn in record_key_meta key_meta_file box_index; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
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
for fn in tunnel_deploy_one tunnel_ssh tunnel_scp port_for box_index; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
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
for fn in reconcile_one box_index reconcile_bump_checkfail reconcile_reset_checkfail reconcile_reset_seedfail reconcile_bump_seedfail reconcile_reset_asleep reconcile_reset_incoherent mint_window_valid days_until; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
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

echo "-----"
if [ "$fail" = 0 ]; then echo "ALL FLEET-BRAIN TESTS PASSED"; else echo "SOME FLEET-BRAIN TESTS FAILED"; fi
exit "$fail"
