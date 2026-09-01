#!/bin/bash
# test-makefile-targets.sh — bind docs/FLEET-BRAIN.md to the Makefile so a target
# can never be deleted while the docs still tell an operator to run it. Bash-only
# (no bun), so it runs in the `make test` shell suite on a machine without bun.
# Run from anywhere:
#   bash tests/test-makefile-targets.sh   (or: make test)
# Exit 0 = all pass, 1 = a failure.
#
# Why this exists: 634b922 ("D7 retirement") deleted `fleet/scripts/apply-flip.sh`
# and the ts-cutover / ts-apply-flip / ts-cutback targets while
# docs/FLEET-BRAIN.md §"Cutover / soak / apply-flip / cutback" still documented
# all three. That removed the ONLY apply-flip and rollback tooling and no test
# noticed. These cases would have caught it.
#
# What this covers:
#   * every `make <target>` named anywhere in docs/FLEET-BRAIN.md exists in the Makefile
#   * every `ts-*` target named in the cutover section exists in the Makefile
#     (and each is listed in .PHONY)
#   * fleet/scripts/apply-flip.sh exists, is executable, and parses
#   * ts-apply-flip actually invokes that script
#   * the T2 hazard: the emitted wrapper ExecStart keeps a BARE `$apply`
#     (a `${apply}` is expanded by systemd to empty and `--apply` lost silently)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
MAKEFILE="$ROOT/Makefile"
DOC="$ROOT/docs/FLEET-BRAIN.md"
FLIP="$ROOT/fleet/scripts/apply-flip.sh"
fail=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; fail=1; }

[ -f "$MAKEFILE" ] || { echo "cannot find $MAKEFILE"; exit 1; }
[ -f "$DOC" ]      || { echo "cannot find $DOC"; exit 1; }

# has_target: the Makefile defines `<name>:` at column 0.
has_target() { grep -qE "^$1:" "$MAKEFILE"; }

# --- 1. every `make <target>` mentioned in the docs exists --------------------
doc_targets="$(grep -oE '`make [a-z][a-z0-9_-]*' "$DOC" | sed 's/^`make //' | sort -u)"
if [ -z "$doc_targets" ]; then
  bad "no 'make <target>' references found in $DOC (grep broken?)"
else
  for t in $doc_targets; do
    if has_target "$t"; then pass "docs reference 'make $t' -> Makefile defines $t:"
    else bad "docs reference 'make $t' but the Makefile has no '$t:' target"; fi
  done
fi

# --- 2. the cutover section's ts-* targets, specifically ----------------------
# Section = from the '### Cutover / soak / apply-flip / cutback' heading to the
# next heading line.
section="$(awk '/^### Cutover \/ soak \/ apply-flip \/ cutback/{i=1;next} i&&/^#/{exit} i{print}' "$DOC")"
if [ -z "$section" ]; then
  bad "docs section '### Cutover / soak / apply-flip / cutback' not found in $DOC"
else
  pass "docs cutover section found"
  cut_targets="$(printf '%s\n' "$section" | grep -oE 'ts-[a-z][a-z0-9-]*' | sort -u)"
  [ -n "$cut_targets" ] || bad "cutover section names no ts-* target (parse broken?)"
  for t in $cut_targets; do
    if has_target "$t"; then pass "cutover section names $t -> Makefile defines it"
    else bad "cutover section names $t but the Makefile has no '$t:' target"; fi
    if grep -qE '^\.PHONY:.*(^|[[:space:]])'"$t"'([[:space:]]|$)' "$MAKEFILE"; then
      pass "$t is listed in .PHONY"
    else
      bad "$t is not listed in .PHONY"
    fi
  done
fi

# --- 3. apply-flip.sh exists, executable, parses ------------------------------
if [ -f "$FLIP" ]; then pass "fleet/scripts/apply-flip.sh exists"
else bad "fleet/scripts/apply-flip.sh is MISSING (ts-apply-flip cannot run)"; fi
if [ -x "$FLIP" ]; then pass "fleet/scripts/apply-flip.sh is executable"
else bad "fleet/scripts/apply-flip.sh is not executable"; fi
if [ -f "$FLIP" ] && bash -n "$FLIP" 2>/dev/null; then pass "fleet/scripts/apply-flip.sh parses (bash -n)"
else bad "fleet/scripts/apply-flip.sh does not parse"; fi
if grep -q 'fleet/scripts/apply-flip.sh' "$MAKEFILE"; then pass "ts-apply-flip invokes fleet/scripts/apply-flip.sh"
else bad "the Makefile never invokes fleet/scripts/apply-flip.sh"; fi

# --- 4. T2 hazard: the EMITTED wrapper ExecStart keeps a bare \$apply ----------
# Expand the recipe the way make will (dry-run) and inspect the wrapper string.
if command -v make >/dev/null 2>&1; then
  # env -u: `make test` calls this script from inside a recipe, and the inherited
  # MAKEFLAGS/MAKELEVEL would make the nested run print "Entering directory" noise.
  expanded="$(cd "$ROOT" && env -u MAKEFLAGS -u MAKELEVEL -u MFLAGS \
    make --no-print-directory -n ts-apply-flip 2>/dev/null | grep 'apply-flip.sh')"
  case "$expanded" in
    *'reconcile ${apply}'*)
      bad "wrapper ExecStart expands to \${apply} — systemd would expand it to empty and drop --apply" ;;
    *'reconcile $apply'*)
      pass "wrapper ExecStart keeps a BARE \$apply (T2 hazard)" ;;
    *)
      bad "could not find the wrapper ExecStart in 'make -n ts-apply-flip' output" ;;
  esac
else
  bad "make not available — cannot check the wrapper ExecStart expansion"
fi

if [ "$fail" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$fail"
