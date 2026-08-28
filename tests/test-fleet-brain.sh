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
for fn in reconcile_dedup dev_field ts_ok; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
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
# -i <vps-key>, and VERIFIES with `boxup check`. Stub ssh (via tunnel_ssh's ssh
# call) to capture the argv of the LAST call (the boxup check verify).
rollout_tunnel_argv_test() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
FLEETCTL="$FLEETCTL"
FLEET_BOX_KEY="/etc/grok-fleet/box_access_ed25519"
FLEET_ROLLOUT_TREE=""     # no tarball => converge+verify only (no scp)
BOX_ROOT="/workspace/box-setup"
log(){ :; }
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in tunnel_deploy_one tunnel_ssh port_for box_index; do eval "\$(extract_from "\$FLEETCTL" "\$fn")"; done
cap="\$(mktemp)"
# ssh stub: append the full argv of each invocation (one line per call).
ssh(){ printf '%s\n' "\$*" >> "\$cap"; return 0; }
tunnel_deploy_one grok-box-8 >/dev/null 2>&1
# Emit the LAST ssh argv (the boxup check verify) + whether any call carried the
# tunnel identity.
tail -1 "\$cap"
grep -q -- "-p 20008 box@127.0.0.1" "\$cap" && echo "PORTHOST-OK" || echo "PORTHOST-MISSING"
grep -q -- "-i /etc/grok-fleet/box_access_ed25519" "\$cap" && echo "KEY-OK" || echo "KEY-MISSING"
grep -q "boxup check" "\$cap" && echo "VERIFY-OK" || echo "VERIFY-MISSING"
rm -f "\$cap"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"
}
ro_argv="$(rollout_tunnel_argv_test)"
case "$ro_argv" in *"PORTHOST-OK"*) pass "rollout tunnel argv: ssh -p 20008 box@127.0.0.1 (port 20000+8)" ;; *) bad "rollout tunnel argv port/host wrong: [$ro_argv]" ;; esac
case "$ro_argv" in *"KEY-OK"*) pass "rollout tunnel argv: -i <VPS box-access key> (no password fallback, R7)" ;; *) bad "rollout tunnel argv key missing: [$ro_argv]" ;; esac
case "$ro_argv" in *"VERIFY-OK"*) pass "rollout tunnel: verifies via boxup check over the tunnel (D6 postcondition)" ;; *) bad "rollout tunnel verify missing: [$ro_argv]" ;; esac

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
expected="etc/grok-fleet/|etc/systemd/system/fleet-reconcile.service|etc/systemd/system/fleet-reconcile.timer|opt/grok-fleet/config.toml|opt/grok-fleet/fleetctl|"
# etc/grok-fleet is a dir (no file) — normalize by removing the trailing dir slash entry if present.
tree_norm="$(printf '%s' "$tree" | sed 's#etc/grok-fleet/|##')"
expected_norm="etc/systemd/system/fleet-reconcile.service|etc/systemd/system/fleet-reconcile.timer|opt/grok-fleet/config.toml|opt/grok-fleet/fleetctl|"
if [ "$tree_norm" = "$expected_norm" ]; then
  pass "installer: installs exactly fleetctl + config.toml + service + timer"
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
if [ "$fail" = 0 ]; then echo "ALL FLEET-BRAIN TESTS PASSED"; else echo "SOME FLEET-BRAIN TESTS FAILED"; fi
exit "$fail"
