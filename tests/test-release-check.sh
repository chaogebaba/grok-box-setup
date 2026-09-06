#!/bin/bash
# test-release-check.sh — r2/R1: the version gate is itself gated.
#
# WHY THIS EXISTS. The r1 empirical gate planted three mutants in
# fleet/scripts/release-check.sh and ALL THREE SURVIVED the full suite, because
# nothing anywhere exercised the script's failure behaviour:
#
#   M11b  `if [ "$fail" != 0 ]` never fires, so the script always exits 0
#   M12b  the brain-set comparison becomes `if true`, comparing nothing
#   M13   the F1-tripwire loop body becomes `:`, so the literal A4 exists to
#         catch is no longer compared
#
# Each is the exact regression A4 was written to prevent: the target goes green
# while comparing nothing. The builder's two mismatch proofs were real but were
# performed by hand, once, at build time — the next person to touch the script
# got no signal at all. A gate is only as good as what fails when it breaks.
#
# WHICH CASE KILLS WHICH MUTANT:
#   M11b  every case in section 2 (all six assert rc 1; an always-0 script fails
#         all six), and section 2 is also the only place rc is asserted non-zero
#   M12b  the three BRAIN cases in section 2 (PKG_VERSION, package.json,
#         GROKFLEET_RELEASE) — with the comparison stubbed to `if true` the
#         brain set can never disagree, so those three see rc 0
#   M13   the F1-tripwire case in section 2 — it is the ONLY case that bumps the
#         tripwire literals while leaving VERSION and BOXUP_VERSION alone, so it
#         is the only one that fails when the loop stops comparing
#
# Section 3 is not a mutant killer; it pins the design decision that the brain
# and box sets version INDEPENDENTLY, so a future "simplification" that compares
# them to each other fails here rather than on a release.
#
# Bash-only (no bun), so it runs inside `make test` on a machine with no bun.
# Every mutation happens in a COPY of the repo under a mktemp -d; the real tree
# is only ever read.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
SCRIPT="$ROOT/fleet/scripts/release-check.sh"
fail=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; fail=1; }

[ -f "$SCRIPT" ] || { echo "cannot find $SCRIPT"; exit 1; }

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# scratch_copy <dir>: the six files release-check reads, plus the script itself,
# at the paths it resolves them from (it derives ROOT as <script>/../..).
scratch_copy() {
  local d="$1"
  mkdir -p "$d/fleet/src" "$d/fleet/scripts" "$d/vps" "$d/tests"
  cp "$ROOT/fleet/scripts/release-check.sh" "$d/fleet/scripts/"
  cp "$ROOT/fleet/src/cli.ts"               "$d/fleet/src/"
  cp "$ROOT/fleet/package.json"             "$d/fleet/"
  cp "$ROOT/vps/install-vps.sh"             "$d/vps/"
  cp "$ROOT/boxup"                          "$d/"
  cp "$ROOT/VERSION"                        "$d/"
  cp "$ROOT/tests/test-iter3-fixes.sh"      "$d/tests/"
}

run_in() { bash "$1/fleet/scripts/release-check.sh" 2>&1; }
rc_in()  { bash "$1/fleet/scripts/release-check.sh" >/dev/null 2>&1; echo $?; }

# =============================================================================
# 1. The real tree passes.
# =============================================================================
real_rc=$(bash "$SCRIPT" >/dev/null 2>&1; echo $?)
if [ "$real_rc" = 0 ]; then
  pass "release-check: the real tree agrees (rc 0)"
else
  bad "release-check: the real tree FAILS rc=$real_rc — $(bash "$SCRIPT" 2>&1 | tail -3)"
fi

# The pass output must NAME both sets, or "OK" is unattributable.
real_out="$(bash "$SCRIPT" 2>&1)"
case "$real_out" in
  *"brain set agrees"*"box set agrees"*) pass "release-check: the pass output names BOTH sets" ;;
  *) bad "release-check: the pass output does not name both sets: [$real_out]" ;;
esac

# =============================================================================
# 2. Each of the six literals, bumped ONE AT A TIME, fails rc 1 and names its
#    file. Six independent scratch copies — a shared one would let an earlier
#    bump mask a later one.
# =============================================================================

# bump_case <label> <expect-substring> <mutate-fn>
bump_case() {
  local label="$1" want="$2" fn="$3"
  local slug d
  slug="$(printf '%s' "$label" | tr -c 'a-zA-Z0-9' '_')"
  d="$WORK/$slug"
  mkdir -p "$d"
  scratch_copy "$d"
  "$fn" "$d"
  local rc out
  out="$(run_in "$d")"
  rc="$(rc_in "$d")"
  if [ "$rc" != 1 ]; then
    bad "release-check: $label bumped alone did NOT fail (rc=$rc) — the gate is not comparing it"
    return
  fi
  case "$out" in
    *"$want"*) pass "release-check: $label bumped alone fails rc 1 and names $want" ;;
    *) bad "release-check: $label failed rc 1 but never named $want: [$(printf '%s' "$out" | tr '\n' '|')]" ;;
  esac
}

# --- the BRAIN set (x3) ---
m_pkg_version() { sed -i 's/^const PKG_VERSION = "[^"]*"/const PKG_VERSION = "9.9.9"/' "$1/fleet/src/cli.ts"; }
m_package_json() { sed -i '0,/"version": *"[^"]*"/s//"version": "9.9.9"/' "$1/fleet/package.json"; }
m_release_tag()  { sed -i 's/^GROKFLEET_RELEASE=.*/GROKFLEET_RELEASE=v9.9.9/' "$1/vps/install-vps.sh"; }

bump_case "PKG_VERSION"       "fleet/src/cli.ts"      m_pkg_version
bump_case "package.json"      "fleet/package.json"    m_package_json
bump_case "GROKFLEET_RELEASE" "vps/install-vps.sh"    m_release_tag

# --- the BOX set (x3) ---
m_boxup_version() { sed -i 's/^BOXUP_VERSION=.*/BOXUP_VERSION=9.9.9/' "$1/boxup"; }
m_version_file()  { printf '9.9.9\n' > "$1/VERSION"; }
# The F1 tripwire is a STANZA, not one line: its comment, its assertion and both
# of its messages each hard-code the literal. Bump every semver inside it and
# leave the rest of the file alone.
m_f1_tripwire() {
  awk '
    /^# VERSION bumped to /{inblk=1}
    inblk{ gsub(/[0-9]+\.[0-9]+\.[0-9]+/, "9.9.9") }
    inblk&&/^fi$/{inblk=0}
    {print}
  ' "$1/tests/test-iter3-fixes.sh" > "$1/tests/.t" && mv "$1/tests/.t" "$1/tests/test-iter3-fixes.sh"
}

bump_case "BOXUP_VERSION" "boxup"                     m_boxup_version
bump_case "VERSION file"  "VERSION"                   m_version_file
bump_case "F1 tripwire"   "tests/test-iter3-fixes.sh" m_f1_tripwire

# Guard the F1 case against silently mutating nothing: if the awk above stopped
# matching (the stanza marker moved), the case would "pass" section 1 and fail
# for the wrong reason. Assert the mutation actually happened.
f1d="$WORK/f1probe"; mkdir -p "$f1d"; scratch_copy "$f1d"; m_f1_tripwire "$f1d"
if diff -q "$ROOT/tests/test-iter3-fixes.sh" "$f1d/tests/test-iter3-fixes.sh" >/dev/null 2>&1; then
  bad "release-check: the F1-tripwire mutation changed NOTHING — the stanza marker moved, so that case proves nothing"
else
  pass "release-check: the F1-tripwire mutation really edits the stanza (the case is not vacuous)"
fi

# =============================================================================
# 3. The two sets are INDEPENDENT: bumping the whole brain set together, with
#    the box set untouched, still passes. The brain versions separately from the
#    box on purpose (5.12.x of the brain ships alongside 5.6.x of the box), so a
#    gate that compared them to each other would refuse every real release.
# =============================================================================
d="$WORK/independent"
mkdir -p "$d"; scratch_copy "$d"
m_pkg_version "$d"; m_package_json "$d"; m_release_tag "$d"
rc="$(rc_in "$d")"
out="$(run_in "$d")"
if [ "$rc" = 0 ]; then
  case "$out" in
    *"brain set agrees at 9.9.9"*"box set agrees"*)
      pass "release-check: the brain set bumped TOGETHER passes with the box set untouched (the sets are independent)" ;;
    *) bad "release-check: brain-set-only bump passed but the output is wrong: [$(printf '%s' "$out" | tr '\n' '|')]" ;;
  esac
else
  bad "release-check: bumping the whole brain set together FAILED rc=$rc — the sets must be independent: [$(printf '%s' "$out" | tr '\n' '|')]"
fi

# ...and symmetrically for the box set.
d="$WORK/independent-box"
mkdir -p "$d"; scratch_copy "$d"
m_boxup_version "$d"; m_version_file "$d"; m_f1_tripwire "$d"
rc="$(rc_in "$d")"
if [ "$rc" = 0 ]; then
  pass "release-check: the box set bumped TOGETHER passes with the brain set untouched"
else
  bad "release-check: bumping the whole box set together FAILED rc=$rc — the sets must be independent"
fi

echo "-----"
if [ "$fail" = 0 ]; then echo "ALL RELEASE-CHECK TESTS PASSED"; else echo "SOME RELEASE-CHECK TESTS FAILED"; fi
exit "$fail"
