#!/bin/bash
# release-check.sh — A4 (5.12.1). Assert that the version constants scattered
# across this repo agree, and print a diff when they do not.
#
# WHY: the repo carries SIX copies of two version numbers, in five file formats,
# and nothing compared more than two of them. CI checked `VERSION` against
# `BOXUP_VERSION` and stopped there, so the brain's three copies could drift
# freely — `fleet/package.json` sat a release behind `PKG_VERSION` for two
# releases without anything noticing, and `release-build.sh` only catches the
# installer pin at RELEASE time, which is the worst moment to discover it.
#
# TWO INDEPENDENT SETS. The brain (grokfleet, bun+TS, runs on the VPS) and the
# box (boxup, shell, runs on a grok box) version SEPARATELY and deliberately:
# 5.12.0 of the brain ships alongside 5.6.0 of the box. This target asserts each
# set is internally consistent; it must NEVER assert the two sets equal.
#
#   brain  fleet/src/cli.ts        const PKG_VERSION = "X.Y.Z"
#          fleet/package.json      "version": "X.Y.Z"
#          vps/install-vps.sh      GROKFLEET_RELEASE=vX.Y.Z   (the `v` is the tag prefix)
#
#   box    boxup                   BOXUP_VERSION=X.Y.Z
#          VERSION                 X.Y.Z
#          tests/test-iter3-fixes.sh   the F1 tripwire stanza's literals
#
# NOT checked here: GROKFLEET_SHA256. That is the identity of PUBLISHED bytes and
# it is rewritten by `make ts-release-build` at release time; on a development
# branch that has bumped GROKFLEET_RELEASE it is EXPECTED to name the previous
# release's digest until the build runs. Asserting it here would either be
# vacuous or would force a release on every version bump.
#
# Usage: bash fleet/scripts/release-check.sh
# Exit 0 = every set agrees, 1 = a mismatch (with the diff).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fail=0

CLI="$ROOT/fleet/src/cli.ts"
PKGJSON="$ROOT/fleet/package.json"
INSTALLER="$ROOT/vps/install-vps.sh"
BOXUP="$ROOT/boxup"
VERSION_FILE="$ROOT/VERSION"
ITER3="$ROOT/tests/test-iter3-fixes.sh"

say()  { printf 'release-check: %s\n' "$1"; }
bad()  { printf 'release-check: MISMATCH — %s\n' "$1" >&2; fail=1; }

# read <file> <sed-script> <label>: extract one value, or record a failure.
read_one() {
  local file="$1" script="$2" label="$3" v
  if [ ! -f "$file" ]; then bad "$label: no such file ($file)"; printf '\n'; return; fi
  v="$(sed -nE "$script" "$file" | head -1)"
  if [ -z "$v" ]; then bad "$label: could not extract a version from $file"; fi
  printf '%s\n' "$v"
}

# --- the brain set -----------------------------------------------------------
pkg_version="$(read_one "$CLI"      's/^const PKG_VERSION = "([^"]+)".*/\1/p'            'PKG_VERSION')"
json_version="$(read_one "$PKGJSON" 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' 'package.json version')"
pinned_tag="$(read_one "$INSTALLER" 's/^GROKFLEET_RELEASE=(.*)$/\1/p'                    'GROKFLEET_RELEASE')"
# The installer pins a TAG (`vX.Y.Z`); compare the version it names.
pinned_version="${pinned_tag#v}"

# --- the box set -------------------------------------------------------------
boxup_version="$(read_one "$BOXUP" 's/^BOXUP_VERSION=(.*)$/\1/p' 'BOXUP_VERSION')"
version_file="$(tr -d '[:space:]' < "$VERSION_FILE" 2>/dev/null)"
[ -n "$version_file" ] || bad "VERSION: $VERSION_FILE is missing or empty"

# The F1 tripwire STANZA, not one line: the comment, the `if` test, the `pass`
# message and the `bad` message all hard-code the literal, and a bump that
# updates the assertion but leaves the prose saying 5.6.0 is exactly the kind of
# half-done bump this target exists to name. Delimited by its own comment marker
# through the closing `fi`, then every semver literal inside it is collected.
tripwire_literals="$(
  awk '/^# VERSION bumped to /{inblk=1} inblk{print} inblk&&/^fi$/{exit}' "$ITER3" \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | sort -u
)"
[ -n "$tripwire_literals" ] || bad "F1 tripwire: found no stanza in $ITER3 (marker '# VERSION bumped to ' moved?)"

# --- compare -----------------------------------------------------------------
# A set is consistent iff every member equals the first. The report prints the
# whole set either way, so a failure names the odd one out instead of only
# saying two numbers differ.
report() {
  local name="$1"; shift
  printf 'release-check: %s set\n' "$name"
  printf '  %s\n' "$@"
}

if [ "$pkg_version" = "$json_version" ] && [ "$pkg_version" = "$pinned_version" ] && [ -n "$pkg_version" ]; then
  say "brain set agrees at $pkg_version (tag $pinned_tag)"
else
  bad "the brain version constants disagree"
  report brain \
    "fleet/src/cli.ts        PKG_VERSION       = ${pkg_version:-<none>}" \
    "fleet/package.json      version           = ${json_version:-<none>}" \
    "vps/install-vps.sh      GROKFLEET_RELEASE = ${pinned_tag:-<none>} (version ${pinned_version:-<none>})"
fi

box_ok=1
[ "$boxup_version" = "$version_file" ] && [ -n "$boxup_version" ] || box_ok=0
for lit in $tripwire_literals; do
  [ "$lit" = "$boxup_version" ] || box_ok=0
done
if [ "$box_ok" = 1 ]; then
  say "box set agrees at $boxup_version"
else
  bad "the box version constants disagree"
  report box \
    "boxup                       BOXUP_VERSION = ${boxup_version:-<none>}" \
    "VERSION                                   = ${version_file:-<none>}" \
    "tests/test-iter3-fixes.sh   F1 tripwire   = $(printf '%s' "$tripwire_literals" | tr '\n' ' ')"
fi

if [ "$fail" != 0 ]; then
  printf 'release-check: FAILED — bump every member of a set together.\n' >&2
  exit 1
fi
say "OK"
exit 0
