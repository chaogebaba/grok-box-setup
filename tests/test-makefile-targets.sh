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

# =============================================================================
# 6. RELEASE TOOLING — ts-release-build / ts-release-publish
#    (blueprint fleet2-release-install D12/D15, acceptance #14/#15/#19)
# =============================================================================
# Everything below runs the REAL recipes inside a THROWAWAY GIT REPO under
# mktemp -d. Nothing touches this checkout, and NOTHING IS EVER PUBLISHED:
# ts-release-publish is driven with CONFIRM unset at every call site, and its
# CONFIRM gate is the last check before the only `git tag` / `git push` /
# `gh release create` in the script. That is deliberate — D12 split publish out
# of build precisely so no gate's happy path can create a permanent public
# release. The publish HAPPY PATH is therefore never exercised here; what is
# exercised is that every refusal fires, and that after the D15 step-2 commit
# the run gets PAST all of them and stops only at the CONFIRM gate.
#
# The bun compile is stubbed via FLEET2_BUILD_CMD (a documented seam in
# release-build.sh) so this file stays bash-only and fast, per its header.
release_tests() {
  local T; T="$(mktemp -d)" || { bad "mktemp -d failed — cannot run the release tests"; return; }
  local R="$T/repo"
  mkdir -p "$R/vps" "$R/fleet/src" "$R/fleet/scripts"
  cp "$ROOT/Makefile" "$R/Makefile"
  cp "$ROOT/.gitignore" "$R/.gitignore"
  cp "$ROOT/vps/install-vps.sh" "$R/vps/install-vps.sh"
  cp "$ROOT/fleet/src/cli.ts" "$R/fleet/src/cli.ts"
  cp "$ROOT/fleet/scripts/release-build.sh" "$R/fleet/scripts/release-build.sh"
  cp "$ROOT/fleet/scripts/release-publish.sh" "$R/fleet/scripts/release-publish.sh"
  # A stand-in for `make ts-build`: writes a deterministic fleet/dist/fleet2.
  cat > "$T/fakebuild.sh" <<'FAKE'
#!/bin/bash
mkdir -p fleet/dist
printf '#!/bin/bash\necho "fleet2 fake"\n' > fleet/dist/fleet2
chmod 0755 fleet/dist/fleet2
FAKE
  chmod 0755 "$T/fakebuild.sh"

  ( cd "$R" \
    && git init -q \
    && git checkout -q -b main 2>/dev/null \
    && git add -A \
    && git -c user.email=t@example.invalid -c user.name=test commit -qm init ) \
    || { bad "could not build the scratch release repo"; rm -rf "$T"; return; }

  # rel <target> [VAR=val ...]: run the real recipe in the scratch repo.
  # CONFIRM is NEVER set to 1 anywhere in this function.
  rel() {
    local target="$1"; shift
    ( cd "$R" && env -u MAKEFLAGS -u MAKELEVEL -u MFLAGS \
        FLEET2_BUILD_CMD="bash $T/fakebuild.sh" \
        make --no-print-directory "$target" "$@" 2>&1 )
  }
  scratch_commit() {
    ( cd "$R" && git add -A \
      && git -c user.email=t@example.invalid -c user.name=test commit -qm "$1" ) >/dev/null 2>&1
  }
  installer_pin() { sed -nE "s/^$1=(.*)\$/\1/p" "$R/vps/install-vps.sh" | head -1; }

  # --- #19a: ts-release-build refuses when ANOTHER tracked file is dirty ------
  printf '\n# scratch edit\n' >> "$R/fleet/src/cli.ts"
  local out
  out="$(rel ts-release-build)"
  case "$out" in
    *'REFUSED'*'fleet/src/cli.ts'*'is dirty'*)
      pass "#19: ts-release-build REFUSES when a tracked file other than the two pin constants is dirty" ;;
    *) bad "#19: ts-release-build did not refuse on an unrelated dirty file: [$out]" ;;
  esac
  ( cd "$R" && git checkout -q -- fleet/src/cli.ts )

  # --- #14: FLEET2_RELEASE != v$PKG_VERSION => refusal -----------------------
  ( cd "$R" && sed -i 's/^FLEET2_RELEASE=.*/FLEET2_RELEASE=v0.0.1/' vps/install-vps.sh )
  scratch_commit "mismatched pin tag"
  out="$(rel ts-release-build)"
  case "$out" in
    *'REFUSED'*'FLEET2_RELEASE=v0.0.1'*'PKG_VERSION='*)
      pass "#14: ts-release-build REFUSES when FLEET2_RELEASE != v\$PKG_VERSION" ;;
    *) bad "#14: ts-release-build did not refuse on a tag/PKG_VERSION mismatch: [$out]" ;;
  esac
  ( cd "$R" && git revert -q --no-edit HEAD 2>/dev/null \
    || git -c user.email=t@example.invalid -c user.name=test reset -q --hard HEAD~1 )

  # --- build HAPPY PATH (local, network-free) --------------------------------
  out="$(rel ts-release-build)"
  local dist="$R/fleet/dist/fleet2-linux-x64"
  if [ -f "$dist" ] && [ -f "$dist.sha256" ]; then
    pass "ts-release-build emits fleet/dist/fleet2-linux-x64 + its .sha256"
  else
    bad "ts-release-build produced no artifact/.sha256: [$out]"
  fi
  local digest; digest="$(sha256sum "$dist" 2>/dev/null | cut -d' ' -f1)"
  if [ -n "$digest" ] && [ "$(installer_pin FLEET2_SHA256)" = "$digest" ]; then
    pass "ts-release-build rewrites FLEET2_SHA256 in the installer to the artifact's digest (the pin travels with the release)"
  else
    bad "ts-release-build left FLEET2_SHA256=[$(installer_pin FLEET2_SHA256)], artifact digest [$digest]"
  fi
  local dirty; dirty="$( cd "$R" && git diff --name-only HEAD | tr '\n' '|' )"
  if [ "$dirty" = "vps/install-vps.sh|" ]; then
    pass "ts-release-build leaves ONLY vps/install-vps.sh dirty (D15 step 1)"
  else
    bad "ts-release-build left an unexpected dirty set: [$dirty]"
  fi

  # --- #19b: publish REFUSES on the dirty tree step 1 just left --------------
  out="$(rel ts-release-publish)"
  case "$out" in
    *'REFUSED'*'working tree is dirty'*)
      pass "#19: ts-release-publish REFUSES on the dirty tree left by ts-release-build (before the commit)" ;;
    *) bad "#19: ts-release-publish did not refuse on the step-1 dirty tree: [$out]" ;;
  esac

  # --- #15: after the commit, a MISMATCHED artifact is still refused ---------
  scratch_commit "release: bump the fleet2 pin"
  printf 'tamper\n' >> "$dist"
  out="$(rel ts-release-publish)"
  case "$out" in
    *'REFUSED'*'artifact digest != the committed FLEET2_SHA256'*)
      pass "#15: ts-release-publish REFUSES when the artifact digest != the committed FLEET2_SHA256" ;;
    *) bad "#15: ts-release-publish did not refuse a digest mismatch: [$out]" ;;
  esac

  # --- #19c: with the commit made and the artifact matching, every refusal is
  # PASSED and the run stops only at the CONFIRM gate, having printed the plan.
  # This is as far as any test may go: the next statement in the script is the
  # `git tag` / `git push` / `gh release create` that publishes for real.
  rel ts-release-build >/dev/null
  scratch_commit "release: restore the matching pin" 2>/dev/null || true
  out="$(rel ts-release-publish)"
  case "$out" in
    *'PLAN'*'CONFIRM=1 not set'*)
      pass "#19: after the D15 step-2 commit, ts-release-publish clears dirty/main/tag/digest and stops at the CONFIRM gate" ;;
    *) bad "#19: ts-release-publish did not reach the CONFIRM gate after the commit: [$out]" ;;
  esac
  case "$out" in
    *'no .sha256 asset is published'*)
      pass "D4: the publish plan states that no same-origin .sha256 asset is published" ;;
    *) bad "D4: the publish plan does not mention the absent .sha256 asset: [$out]" ;;
  esac

  # --- nothing was published -------------------------------------------------
  if [ -z "$( cd "$R" && git tag -l )" ]; then
    pass "release tests created NO git tag (the publish happy path is never exercised — D12)"
  else
    bad "release tests created a git tag in the scratch repo: [$( cd "$R" && git tag -l | tr '\n' ' ')]"
  fi

  rm -rf "$T"
}
if command -v make >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
  release_tests
else
  bad "make/git not available — cannot execute the ts-release-build / ts-release-publish recipes"
fi


# --- 6. the TUI pty smoke (blueprint fleet-tui-ink D4) ------------------------
# The TUI is an Ink app now, and everything that used to be hand-rolled — raw
# mode, the alternate screen, the cursor, restore on exit — is a library's job.
# A frame test cannot see any of that: `bun test` runs TTY-free, where Ink turns
# the alt screen off entirely. So the binary is driven under a REAL pty here.
#
# `script` is not installed on every machine this repo is developed on, so
# tests/lib/pty-smoke.py forks its own pty (python3's `pty.fork`).
#
# The environment is DELIBERATELY sterile: a fresh HOME and XDG_CONFIG_HOME so
# nothing of the developer's ~/.config/grok-fleet leaks in, and an admin URL
# pointing at a closed port so the smoke can never reach the production API.
tui_pty_smoke() {
  local R T out raw
  R="$ROOT"
  T="$(mktemp -d)"
  mkdir -p "$T/home" "$T/xdg"
  raw="$T/raw"

  # --- 6a. the happy path: paint, then quit ----------------------------------
  out="$(cd "$R" && env -i \
      PATH="/usr/bin:/bin" \
      TERM=xterm-256color \
      HOME="$T/home" \
      XDG_CONFIG_HOME="$T/xdg" \
      FLEET2_ADMIN_URL="http://127.0.0.1:1" \
      FLEET2_ADMIN_TOKEN=x \
      python3 tests/lib/pty-smoke.py 5 q "$raw" -- "$R/fleet/dist/fleet2" tui)"
  # shellcheck disable=SC2086  # the KEY=VALUE lines are meant to be split
  eval "$out"

  [ "${SAW_HEADER:-0}" = 1 ] \
    && pass "D4 pty: the TUI paints its header within the timeout" \
    || bad "D4 pty: no header line painted [$out]"
  [ "${SAW_LINKDOWN:-0}" = 1 ] \
    && pass "D4 pty: the LINK DOWN banner is painted (the closed port, not the production API)" \
    || bad "D4 pty: no LINK DOWN banner [$out]"
  [ "${RC:-x}" = 0 ] \
    && pass "D4 pty: 'q' quits with rc 0" \
    || bad "D4 pty: quitting did not exit 0 (RC=${RC:-?}; -999 means it never exited) [$out]"

  # Ink's unmount order: enter the alt screen, then leave it, then show the
  # cursor. A restore that never happens leaves the operator's terminal in the
  # alt screen with no cursor, which is exactly what term.ts existed to prevent.
  if [ "${ALT_ON:--1}" -ge 0 ]; then
    pass "D4 pty: the alternate screen is ENTERED (1049h)"
  else
    bad "D4 pty: no 1049h in the pty bytes — alternateScreen is not in force"
  fi
  if [ "${ALT_OFF:--1}" -gt "${ALT_ON:--1}" ]; then
    pass "D4 pty: the alternate screen is LEFT after it was entered (1049l after 1049h)"
  else
    bad "D4 pty: no 1049l after the 1049h (ALT_ON=${ALT_ON:-?} ALT_OFF=${ALT_OFF:-?})"
  fi
  if [ "${CURSOR_ON:--1}" -gt "${ALT_OFF:--1}" ]; then
    pass "D4 pty: the cursor is shown AFTER the alt screen is left (25h after 1049l)"
  else
    bad "D4 pty: no 25h after the 1049l (ALT_OFF=${ALT_OFF:-?} CURSOR_ON=${CURSOR_ON:-?})"
  fi

  # Nothing of the operator's config was read, and nothing was written into the
  # sterile HOME: the smoke ran entirely off the two env variables.
  if [ -d "$T/home/.config/grok-fleet" ] || [ -d "$T/xdg/grok-fleet" ]; then
    bad "D4 pty: the smoke created a grok-fleet config dir in its sterile HOME/XDG"
  else
    pass "D4 pty: no grok-fleet config was read or written (sterile HOME + XDG_CONFIG_HOME)"
  fi

  # --- 6b. the crash path ----------------------------------------------------
  # The compiled TUI cannot be told to throw, so the crash barrier is driven
  # over the SAME render-options factory and the SAME installCrashBarrier the
  # entry point uses. The point of the barrier is ordering: the teardown bytes
  # must reach the terminal BEFORE the process exits, and the process must
  # still exit rather than hang waiting on a stream callback that never fires.
  if command -v bun >/dev/null 2>&1; then
    unset RC ALT_ON ALT_OFF CURSOR_ON
    out="$(cd "$R/fleet" && python3 "$R/tests/lib/pty-smoke.py" 8 "" "$T/raw-crash" -- bun run test/tui/crash-fixture.ts)"
    # shellcheck disable=SC2086
    eval "$out"
    [ "${RC:-x}" != 0 ] && [ "${RC:-x}" != "-999" ] \
      && pass "D4 pty crash: an uncaught exception ENDS the process (rc ${RC:-?})" \
      || bad "D4 pty crash: the process did not end non-zero on an uncaught exception (RC=${RC:-?}) [$out]"
    if [ "${ALT_OFF:--1}" -gt "${ALT_ON:--1}" ] && [ "${CURSOR_ON:--1}" -gt "${ALT_OFF:--1}" ]; then
      pass "D4 pty crash: the alt screen is left and the cursor restored BEFORE the exit"
    else
      bad "D4 pty crash: the teardown bytes did not arrive before the exit (ALT_ON=${ALT_ON:-?} ALT_OFF=${ALT_OFF:-?} CURSOR_ON=${CURSOR_ON:-?})"
    fi
  else
    echo "SKIP: bun not installed; the crash-barrier pty case needs it"
  fi

  rm -rf "$T"
}
if [ ! -x "$ROOT/fleet/dist/fleet2" ]; then
  # `make test` must keep working on a machine with no bun (see the header), and
  # that machine cannot have built the binary either.
  echo "SKIP: fleet/dist/fleet2 is not built; run 'make ts-build' for the TUI pty smoke"
elif ! command -v python3 >/dev/null 2>&1; then
  echo "SKIP: python3 not installed; the TUI pty smoke needs it to fork a pty"
else
  tui_pty_smoke
fi

if [ "$fail" = 0 ]; then echo "ALL PASS"; else echo "FAILURES"; fi
exit "$fail"
