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
#   * the T2 hazard: the wrapper ExecStart keeps a BARE `$apply`
#     (a `${apply}` is expanded by systemd to empty and `--apply` lost silently)
#   * R2-B1, the load-bearing case: the real ts-apply-flip / ts-cutover recipes
#     are EXECUTED against a scratch DROPIN_DIR/SOAK_MARKER/CONFIG under
#     mktemp -d, and the INSTALLED drop-in file is asserted to carry a literal
#     `$apply` — and to actually append `--apply` when run. Recipe-text checks
#     alone cannot see this: `make -n` printed a healthy bare `$apply` while the
#     shell silently expanded it away before apply-flip.sh ever saw it, and the
#     drop-in that reached production could never apply anything.
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

# --- 4. T2 hazard: the wrapper SOURCE keeps a bare $apply ---------------------
# Recipe-text level (kept, but NOT load-bearing — see section 5). The wrapper is
# handed to the recipes through the ENVIRONMENT (`export WRAPPER_EXEC`), because
# interpolating it as "$(WRAPPER_EXEC)" let the shell expand $apply to empty.
wrapper_def="$(grep -E '^WRAPPER_EXEC[[:space:]]*=' "$MAKEFILE" || true)"
case "$wrapper_def" in
  *'reconcile ${apply}'*)
    bad "WRAPPER_EXEC uses \${apply} — systemd would expand it to empty and drop --apply" ;;
  *'reconcile $$apply'*)
    pass "WRAPPER_EXEC keeps a BARE \$apply (T2 hazard)" ;;
  *)
    bad "could not find a WRAPPER_EXEC definition carrying a bare \$\$apply in $MAKEFILE" ;;
esac
if grep -qE '^export WRAPPER_EXEC[[:space:]]*$' "$MAKEFILE"; then
  pass "WRAPPER_EXEC is exported (recipes get it via the environment, unexpanded)"
else
  bad "WRAPPER_EXEC is not exported — recipes interpolating \"\$(WRAPPER_EXEC)\" lose \$apply to shell expansion"
fi
if grep -q '"\$\$WRAPPER_EXEC"' "$MAKEFILE"; then
  pass "recipes reference the exported \"\$\$WRAPPER_EXEC\""
else
  bad "no recipe references \"\$\$WRAPPER_EXEC\"; check the wrapper handoff"
fi
if command -v make >/dev/null 2>&1; then
  # env -u: `make test` calls this script from inside a recipe, and the inherited
  # MAKEFLAGS/MAKELEVEL would make the nested run print "Entering directory" noise.
  expanded="$(cd "$ROOT" && env -u MAKEFLAGS -u MAKELEVEL -u MFLAGS \
    make --no-print-directory -n ts-apply-flip 2>/dev/null | grep 'apply-flip.sh')"
  case "$expanded" in
    *'"$WRAPPER_EXEC"'*) pass "ts-apply-flip passes the wrapper as the exported env var" ;;
    *) bad "ts-apply-flip does not pass \"\$WRAPPER_EXEC\" to apply-flip.sh: [$expanded]" ;;
  esac
else
  bad "make not available — cannot check the ts-apply-flip recipe expansion"
fi

# --- 5. R2-B1: EXECUTE the real recipes and assert on the INSTALLED FILE ------
# Everything below runs against a scratch tree from mktemp -d. DROPIN_DIR,
# SOAK_MARKER, CONFIG and FLEET2_REMOTE are all overridden, so /etc/systemd and
# /var/lib/grok-fleet are never touched. SYSTEMCTL=true stands in for systemctl
# so the recipes complete on a machine with no systemd (or where daemon-reload
# would fail); the recipes' informational `systemctl cat` is already non-fatal.
artifact_tests() {
  local T; T="$(mktemp -d)" || { bad "mktemp -d failed — cannot run the artifact tests"; return; }
  local dropin_dir="$T/etc/systemd/system/fleet-reconcile.service.d"
  local dropin="$dropin_dir/fleet2.conf"
  local marker="$T/var/lib/grok-fleet/fleet2.soak-ok"
  local config="$T/opt/grok-fleet/config.toml"
  local fleet2="$T/opt/grok-fleet/fleet2"
  mkdir -p "$dropin_dir" "$T/var/lib/grok-fleet" "$T/opt/grok-fleet"
  printf 'apply = true\n' > "$config"
  # A stand-in fleet2 that just prints the argv the wrapper built.
  printf '#!/bin/bash\nprintf "ARGS:[%%s]\\n" "$*"\n' > "$fleet2"
  chmod 0755 "$fleet2"

  run_target() {
    (cd "$ROOT" && env -u MAKEFLAGS -u MAKELEVEL -u MFLAGS \
      make --no-print-directory "$@" \
        SYSTEMCTL=true \
        DROPIN_DIR="$dropin_dir" DROPIN="$dropin" \
        SOAK_MARKER="$marker" CONFIG="$config" FLEET2_REMOTE="$fleet2" >/dev/null 2>&1)
  }

  # exec_line: the installed wrapper ExecStart (the second one; the first is the
  # empty ExecStart= reset).
  exec_line() { grep '^ExecStart=/bin/bash' "$dropin" 2>/dev/null; }
  # run_wrapper: execute the wrapper's `bash -c` body for real and echo its output.
  run_wrapper() {
    local line body
    line="$(exec_line)" || return 1
    body="${line#ExecStart=/bin/bash -c }"
    body="${body#\'}"; body="${body%\'}"
    bash -c "$body" 2>&1
  }

  # 5a. ts-apply-flip FORCE=1 must install a wrapper carrying a LITERAL $apply.
  rm -f "$dropin" "$marker"
  if run_target ts-apply-flip FORCE=1; then
    if [ -f "$dropin" ]; then pass "ts-apply-flip FORCE=1 installed a drop-in on the scratch tree"
    else bad "ts-apply-flip FORCE=1 installed no drop-in at $dropin"; fi
    if grep -Fq 'reconcile $apply' "$dropin"; then
      pass "INSTALLED ts-apply-flip drop-in contains a literal \$apply (R2-B1)"
    else
      bad "INSTALLED ts-apply-flip drop-in LOST \$apply — --apply can never be appended: [$(exec_line)]"
    fi
    if grep -Fq 'reconcile ${apply}' "$dropin"; then
      bad "INSTALLED drop-in uses \${apply} — systemd expands it to empty"
    else
      pass "INSTALLED drop-in does not use \${apply}"
    fi
    # 5b. functional: apply=true => --apply appended; apply=false => not.
    printf 'apply = true\n' > "$config"
    if [ "$(run_wrapper)" = "ARGS:[reconcile --apply]" ]; then
      pass "INSTALLED wrapper appends --apply when config apply=true"
    else
      bad "INSTALLED wrapper did not append --apply with apply=true: [$(run_wrapper)]"
    fi
    printf 'apply = false\n' > "$config"
    if [ "$(run_wrapper)" = "ARGS:[reconcile]" ]; then
      pass "INSTALLED wrapper omits --apply when config apply=false"
    else
      bad "INSTALLED wrapper misbehaved with apply=false: [$(run_wrapper)]"
    fi
    printf 'apply = true\n' > "$config"
    # 5c. the FORCE=1 marker must be ONE clean line (empty journal wrote "0\n0").
    local lines; lines="$(wc -l < "$marker" 2>/dev/null | tr -d ' ')"
    if [ "$lines" = 1 ]; then pass "FORCE=1 soak marker is exactly one line"
    else bad "FORCE=1 soak marker is not one line ($lines): [$(tr '\n' '|' < "$marker")]"; fi
    if grep -qE '^forced=1 observed=[0-9]+ required=[0-9]+ failed_runs=[^ ]* at=[0-9T:Z-]+$' "$marker"; then
      pass "FORCE=1 soak marker is well formed (single numeric observed=)"
    else
      bad "FORCE=1 soak marker is malformed: [$(tr '\n' '|' < "$marker")]"
    fi
  else
    bad "ts-apply-flip FORCE=1 failed on the scratch tree (rc != 0)"
  fi

  # 5d. ts-cutover's wrapper branch has the SAME shape and the same hazard.
  rm -f "$dropin"
  if run_target ts-cutover; then
    if grep -Fq 'reconcile $apply' "$dropin"; then
      pass "INSTALLED ts-cutover drop-in contains a literal \$apply (R2-B1)"
    else
      bad "INSTALLED ts-cutover drop-in LOST \$apply: [$(exec_line)]"
    fi
  else
    bad "ts-cutover failed on the scratch tree with the soak marker present"
  fi

  # 5e. nothing outside the scratch tree was written.
  if [ ! -e /etc/systemd/system/fleet-reconcile.service.d/fleet2.conf ] \
     && [ ! -e /var/lib/grok-fleet/fleet2.soak-ok ]; then
    pass "artifact tests wrote nothing to /etc/systemd or /var/lib/grok-fleet"
  else
    bad "artifact tests leaked outside the scratch tree"
  fi

  rm -rf "$T"
}
if command -v make >/dev/null 2>&1; then
  artifact_tests
else
  bad "make not available — cannot execute the ts-apply-flip / ts-cutover recipes"
fi

if [ "$fail" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$fail"
