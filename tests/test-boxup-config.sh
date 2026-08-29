#!/bin/bash
# test-boxup-config.sh — local, box-free coverage for the box side of PHASE 2
# config-truth (docs/FLEET-BRAIN.md §config-truth, blueprint D1/D8/D11). No real
# box needed: the boxup reader functions are extracted and driven directly over
# fixture config.toml / managed.toml files. Run from anywhere:
#   bash tests/test-boxup-config.sh   (or: make test)
# Exit 0 = all pass, 1 = a failure.
#
# What this covers (D11 boxup side):
#   * managed.toml value shadows config.toml (managed > config > default)
#   * a key ONLY in config.toml still reads through (fallback)
#   * missing managed.toml == today's behaviour exactly (config.toml only)
#   * [managed] enabled = false in config.toml => managed.toml IGNORED
#   * FIRST-match-per-file semantics unchanged (managed AND config)
#   * config-get subcommand reads the LOCAL config.toml value (never managed)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
BOXUP="$ROOT/boxup"
fail=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; fail=1; }

[ -f "$BOXUP" ] || { echo "cannot find $BOXUP"; exit 1; }

# extract_from: print a `name() { ... }` definition (col-0 to col-0 }) from a file.
extract_from() {
  awk -v fn="$2" '
    $0 ~ "^"fn"\\(\\) \\{" {inside=1}
    inside {print}
    inside && /^\}$/ {exit}
  ' "$1"
}

# cfgget: drive the REAL boxup config_get with the given config.toml + managed.toml
# fixtures and an explicit MANAGED_ENABLED (mirrors the do_ensure_body hoist; ""
# forces the lazy re-read path). Prints the resolved value.
#   args: <config-content> <managed-content|__none__> <enabled> <table> <key>
cfgget() {
  local cfg="$1" mgd="$2" en="$3" table="$4" key="$5" inner; inner="$(mktemp)"
  local dir; dir="$(mktemp -d)"
  printf '%s' "$cfg" > "$dir/config.toml"
  if [ "$mgd" != "__none__" ]; then printf '%s' "$mgd" > "$dir/managed.toml"; fi
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
CONFIG_FILE="$dir/config.toml"
MANAGED_FILE="$dir/managed.toml"
MANAGED_ENABLED="$en"
# The reader uses this awk blob; source it + the two readers from boxup.
extract_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
eval "\$(awk '/^read -r -d/{p=1} p{print} /^AWK\$/{if(p)exit}' "\$BOXUP")"
eval "\$(extract_from "\$BOXUP" config_get_file)"
eval "\$(extract_from "\$BOXUP" config_get)"
config_get "$table" "$key"
INNER
  timeout 15 bash "$inner"; rm -f "$inner"; rm -rf "$dir"
}

CFG='[ssh]
password = "cfgpass"
[update]
repo = "https://cfg/repo.git"
'
MGD='[update]
repo = "https://managed/repo.git"
'

# managed > config: [update].repo comes from managed.toml when enabled.
[ "$(cfgget "$CFG" "$MGD" true update repo)" = "https://managed/repo.git" ] \
  && pass "boxup precedence: managed.toml value SHADOWS config.toml (managed > config)" \
  || bad "managed did not shadow config: [$(cfgget "$CFG" "$MGD" true update repo)]"

# config fallback: a key ONLY in config.toml still reads (managed has no [ssh]).
[ "$(cfgget "$CFG" "$MGD" true ssh password)" = "cfgpass" ] \
  && pass "boxup precedence: key absent from managed.toml falls back to config.toml" \
  || bad "config fallback wrong: [$(cfgget "$CFG" "$MGD" true ssh password)]"

# missing managed.toml == config.toml-only behaviour exactly.
[ "$(cfgget "$CFG" __none__ true update repo)" = "https://cfg/repo.git" ] \
  && pass "boxup precedence: MISSING managed.toml => config.toml value (today's behaviour)" \
  || bad "missing-managed wrong: [$(cfgget "$CFG" __none__ true update repo)]"

# [managed] enabled = false => managed.toml IGNORED, config.toml value wins.
[ "$(cfgget "$CFG" "$MGD" false update repo)" = "https://cfg/repo.git" ] \
  && pass "boxup D8 gate: [managed] enabled=false => managed.toml IGNORED (config.toml wins)" \
  || bad "enabled=false gate wrong: [$(cfgget "$CFG" "$MGD" false update repo)]"

# Lazy gate read: MANAGED_ENABLED unset ("") + config.toml sets enabled=false
# => the wrapper re-reads the gate and honours it (managed ignored).
CFG_OFF='[managed]
enabled = false
[update]
repo = "https://cfg/repo.git"
'
[ "$(cfgget "$CFG_OFF" "$MGD" "" update repo)" = "https://cfg/repo.git" ] \
  && pass "boxup D8 gate: unset MANAGED_ENABLED + config enabled=false => lazy re-read honours it" \
  || bad "lazy gate wrong: [$(cfgget "$CFG_OFF" "$MGD" "" update repo)]"

# Lazy gate default true: unset MANAGED_ENABLED + no [managed] in config => managed wins.
[ "$(cfgget "$CFG" "$MGD" "" update repo)" = "https://managed/repo.git" ] \
  && pass "boxup D8 gate: unset MANAGED_ENABLED + no [managed] => default true (managed wins)" \
  || bad "lazy gate default wrong: [$(cfgget "$CFG" "$MGD" "" update repo)]"

# FIRST-match-per-file unchanged: a duplicate key in managed.toml => the FIRST wins.
MGD_DUP='[update]
repo = "https://first/repo.git"
repo = "https://second/repo.git"
'
[ "$(cfgget "$CFG" "$MGD_DUP" true update repo)" = "https://first/repo.git" ] \
  && pass "boxup: FIRST-match-per-file unchanged in managed.toml (first duplicate wins)" \
  || bad "first-match(managed) wrong: [$(cfgget "$CFG" "$MGD_DUP" true update repo)]"

# FIRST-match-per-file unchanged in config.toml when managed absent.
CFG_DUP='[ssh]
password = "first"
password = "second"
'
[ "$(cfgget "$CFG_DUP" __none__ true ssh password)" = "first" ] \
  && pass "boxup: FIRST-match-per-file unchanged in config.toml (first duplicate wins)" \
  || bad "first-match(config) wrong: [$(cfgget "$CFG_DUP" __none__ true ssh password)]"

# config-get subcommand reads the LOCAL config.toml value (never the managed
# layer), exit 1 when absent. Drive the real dispatch with fixtures.
cggsub() {
  local table="$1" key="$2" inner; inner="$(mktemp)"
  local dir; dir="$(mktemp -d)"
  printf '%s' "$CFG" > "$dir/config.toml"
  printf '%s' "$MGD" > "$dir/managed.toml"    # present but MUST be ignored by config-get
  BOX_SETUP_ROOT="$dir" BOX_SETUP_CONFIG="$dir/config.toml" \
    timeout 15 bash "$BOXUP" config-get "$table" "$key"
  local rc=$?
  rm -f "$inner"; rm -rf "$dir"
  return "$rc"
}
val="$(cggsub update repo)"; rc=$?
if [ "$rc" = 0 ] && [ "$val" = "https://cfg/repo.git" ]; then
  pass "boxup config-get: reads the LOCAL config.toml value (NOT managed.toml), exit 0"
else
  bad "config-get value/exit wrong: val=[$val] rc=$rc"
fi
cggsub nope missing >/dev/null 2>&1 && bad "config-get absent key should exit 1" \
  || pass "boxup config-get: absent key => exit 1"

echo "-----"
if [ "$fail" = 0 ]; then echo "ALL BOXUP-CONFIG TESTS PASSED"; else echo "SOME BOXUP-CONFIG TESTS FAILED"; fi
exit "$fail"
