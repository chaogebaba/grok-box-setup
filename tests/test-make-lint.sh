#!/bin/bash
# test-make-lint.sh — `make lint` must FAIL on shellcheck findings.
#
# WHY THIS EXISTS. The shellcheck recipe line was
#
#   @command -v shellcheck >/dev/null && shellcheck -S warning <files> || echo "shellcheck not installed; skipped"
#
# and `a && b || c` is not a conditional: when shellcheck RAN and REPORTED
# FINDINGS (b failed), control fell into c, make printed "shellcheck not
# installed; skipped" and exited 0. CI gates on `make lint`, so findings were
# invisible — a green gate that checked nothing. The fix is an if/else, where
# the skip branch is reachable ONLY when shellcheck is absent.
#
# Mutants each case kills (house style, cf. test-release-check.sh):
#   M-lint1  back to `a && b || c`            -> case 4 (findings path sees rc 0)
#   M-lint2  skip branch removed / always run -> case 2 (absent path fails or
#                                               prints no skip message)
#   M-lint3  `if` inverted                    -> case 2 (runs shellcheck with no
#                                               shellcheck) AND case 4 (skips
#                                               with shellcheck present)
#   M-lint4  rc swallowed (`|| true`, `; :`)  -> case 4 again
#
# Bash-only, runs inside `make test` on a machine with no bun. Every mutation
# happens in a COPY under mktemp -d; the real tree is only ever read.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
MAKEFILE="$ROOT/Makefile"
fail=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; fail=1; }

[ -f "$MAKEFILE" ] || { echo "cannot find $MAKEFILE"; exit 1; }
command -v make >/dev/null 2>&1 || { echo "make not available"; exit 1; }

# nested_make: run `make` against this repo without inheriting MAKEFLAGS from
# the outer `make test` recipe (same env -u discipline as test-makefile-targets.sh).
nested_make() {
  (cd "$ROOT" && env -u MAKEFLAGS -u MAKELEVEL -u MFLAGS \
    make --no-print-directory "$@")
}

# The recipe line under test — exactly one line mentions shellcheck.
lint_line="$(grep 'shellcheck' "$MAKEFILE" | grep -v '^\s*#')"
[ "$(printf '%s\n' "$lint_line" | wc -l)" = 1 ] \
  || bad "expected exactly one shellcheck recipe line in the Makefile, got $(printf '%s\n' "$lint_line" | wc -l)"

# --- 1. static: the line is an if/else, not `a && b || c` ---------------------
case "$lint_line" in
  *'&& shellcheck'*'|| echo'*)
    bad "lint recipe is still \`a && b || c\` — a shellcheck FINDING falls into the skip branch and make exits 0" ;;
  *'if command -v shellcheck'*'; then shellcheck'*'; else echo'*'; fi'*)
    pass "lint recipe is an if/else (skip reachable only when shellcheck is absent)" ;;
  *)
    bad "lint recipe is neither the known-good if/else nor the known-bad &&||: [$lint_line]" ;;
esac

# --- 2. absent path EXECUTED: no shellcheck on PATH -> skip message, rc 0 ------
FAKEBIN="$(mktemp -d)"
trap 'rm -rf "$FAKEBIN"' EXIT
# Symlink every PATH binary EXCEPT shellcheck: the recipe must behave as if
# shellcheck were never installed, without hiding make/bash from themselves.
oldIFS="$IFS"; IFS=:
for d in $PATH; do
  [ -d "$d" ] || continue
  for b in "$d"/*; do
    [ -f "$b" ] || continue
    [ "$(basename "$b")" = shellcheck ] && continue
    [ -e "$FAKEBIN/$(basename "$b")" ] || ln -s "$b" "$FAKEBIN/"
  done
done
IFS="$oldIFS"
absent_out="$(PATH="$FAKEBIN" nested_make lint 2>&1)"
absent_rc=$?
if [ "$absent_rc" = 0 ] && printf '%s' "$absent_out" | grep -q 'shellcheck not installed; skipped'; then
  pass "shellcheck absent -> skip message printed, make lint rc 0"
else
  bad "shellcheck absent: expected rc 0 + skip message, got rc=$absent_rc out=[$(printf '%s' "$absent_out" | tail -3 | tr '\n' '|')]"
fi

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "NOTE: shellcheck not installed here; the findings/present cases cannot run (absent path above still held)."
  echo "-----"
  if [ "$fail" = 0 ]; then echo "ALL MAKE-LINT TESTS PASSED"; else echo "SOME MAKE-LINT TESTS FAILED"; fi
  exit "$fail"
fi

# --- 3. present + clean: the real tree passes, rc 0 ----------------------------
clean_out="$(nested_make lint 2>&1)"
clean_rc=$?
if [ "$clean_rc" = 0 ]; then
  pass "shellcheck present, real tree clean -> make lint rc 0"
else
  bad "shellcheck present, real tree should be clean: rc=$clean_rc out=[$(printf '%s' "$clean_out" | tail -3 | tr '\n' '|')]"
fi

# --- 4. findings path EXECUTED: a warning-class finding must fail make lint ----
WORK="$(mktemp -d)"
badcopy="$WORK/boxup-bad"
cp "$ROOT/boxup" "$badcopy"
# Inject an unused variable: SC2034 is warning-severity, i.e. exactly what
# `shellcheck -S warning` must report. (SC2086 itself is info-class and sits
# BELOW the -S warning threshold — see tests/test-boxup-jobs.sh for that trap.)
sed -i '1a LINT_PROBE_SC2034_FIXTURE=unused-var-injected-for-lint-test' "$badcopy"
# Confirm the fixture really is flagged before using it, or case 4 proves nothing.
if ! shellcheck -S warning "$badcopy" >/dev/null 2>&1; then
  fixture_flagged=1
else
  fixture_flagged=0
  bad "lint fixture: shellcheck -S warning did NOT flag the injected SC2034 — shellcheck version changed? case 4 is vacuous"
fi
if [ "$fixture_flagged" = 1 ]; then
  # Scratch Makefile: same recipes, but the file list points at the bad COPY.
  # The real boxup is never edited and the real tree is only read.
  sed "s|shellcheck -S warning boxup |shellcheck -S warning $badcopy |" "$MAKEFILE" > "$WORK/Makefile"
  find_out="$(nested_make -f "$WORK/Makefile" lint 2>&1)"
  find_rc=$?
  if [ "$find_rc" != 0 ] && printf '%s' "$find_out" | grep -q 'SC2034'; then
    pass "shellcheck FINDING -> finding printed AND make lint rc non-zero (the &&|| mutant would print \"skipped\" and exit 0)"
  else
    bad "shellcheck finding: expected rc!=0 + finding printed, got rc=$find_rc out=[$(printf '%s' "$find_out" | tail -3 | tr '\n' '|')]"
  fi
fi

rm -rf "$WORK"
echo "-----"
if [ "$fail" = 0 ]; then echo "ALL MAKE-LINT TESTS PASSED"; else echo "SOME MAKE-LINT TESTS FAILED"; fi
exit "$fail"