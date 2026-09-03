#!/bin/bash
# release-build.sh — STEP 1 of the D15 release sequence (`make ts-release-build`).
#
# LOCAL ONLY. No network, no `gh`, no tag, no upload. Freely runnable by a gate:
# D12 split this out of the old single `ts-release` target precisely so a gate's
# happy-path run cannot create a permanent public release as a side effect.
#
# What it does, in order:
#   1. REFUSES if any tracked file other than the two installer pin constants is
#      dirty. (D15 step 1: this target's whole job is to leave the tree dirty in
#      exactly those two lines, so the operator's commit in step 2 is reviewable.)
#   2. REFUSES if GROKFLEET_RELEASE in the installer is not "v$PKG_VERSION" (D11).
#      Note this is asserted on the COMMITTED value BEFORE anything is rewritten:
#      if the target simply set the tag from PKG_VERSION the assertion would be
#      vacuous, and a PKG_VERSION bump could silently leave the pin naming an
#      older tag. The tag line is still rewritten afterwards (idempotently), so
#      "rewrites GROKFLEET_RELEASE and GROKFLEET_SHA256" holds; in practice only the
#      digest line changes.
#   3. Builds the binary, emits dist/grokfleet-linux-x64 + its .sha256.
#   4. Rewrites GROKFLEET_RELEASE and GROKFLEET_SHA256 in vps/install-vps.sh so the
#      release and its pin travel together.
#
# Then: the operator commits that bump (step 2), and runs
# `make ts-release-publish CONFIRM=1` (step 3).
#
# Usage: bash fleet/scripts/release-build.sh <installer> <dist-asset-path>
set -euo pipefail

INSTALLER="${1:?usage: release-build.sh <installer> <dist-asset>}"
DIST="${2:?usage: release-build.sh <installer> <dist-asset>}"

# The build command is a seam ONLY so the shell test suite can drive the refusal
# and happy paths without bun and without a ~10 s compile. Production leaves it
# at `make ts-build`.
BUILD_CMD="${GROKFLEET_BUILD_CMD:-make ts-build}"
BUILD_OUT="${GROKFLEET_BUILD_OUT:-fleet/dist/grokfleet}"

die() { echo "ts-release-build: REFUSED — $*" >&2; exit 1; }
say() { echo "ts-release-build: $*"; }

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

[ -f "$INSTALLER" ] || die "no installer at $INSTALLER"

# --- 1. tracked-dirt check ----------------------------------------------------
# Only the two pin constants in the installer may already be dirty (a re-run of
# this same target). Any OTHER tracked change means the operator is about to
# commit a release bump mixed with unrelated work.
dirty="$(git diff --name-only HEAD -- . || true)"
for f in $dirty; do
  if [ "$f" != "$INSTALLER" ]; then
    die "tracked file '$f' is dirty; commit or stash it first (this target must leave ONLY the two pin constants dirty)"
  fi
done
if [ -n "$dirty" ]; then
  # $INSTALLER is dirty: allow it ONLY if every changed line is a pin constant.
  offending="$(git diff -U0 HEAD -- "$INSTALLER" \
    | grep -E '^[+-]' \
    | grep -vE '^(\+\+\+|---)' \
    | grep -vE '^[+-](GROKFLEET_RELEASE|GROKFLEET_SHA256)=' || true)"
  [ -z "$offending" ] || die "$INSTALLER is dirty beyond the two pin constants:
$offending"
  say "note: $INSTALLER already carries an uncommitted pin bump — rewriting it"
fi

# --- 2. GROKFLEET_RELEASE == v$PKG_VERSION (D11) ---------------------------------
pkg_version="$(sed -nE 's/^const PKG_VERSION = "([^"]+)".*/\1/p' fleet/src/cli.ts | head -1)"
[ -n "$pkg_version" ] || die "could not read PKG_VERSION from fleet/src/cli.ts"
pinned_tag="$(sed -nE 's/^GROKFLEET_RELEASE=(.*)$/\1/p' "$INSTALLER" | head -1)"
[ -n "$pinned_tag" ] || die "could not read GROKFLEET_RELEASE from $INSTALLER"
if [ "$pinned_tag" != "v$pkg_version" ]; then
  die "GROKFLEET_RELEASE=$pinned_tag but fleet/src/cli.ts PKG_VERSION=$pkg_version (expected tag v$pkg_version) — bump one to match the other"
fi
say "pin tag $pinned_tag matches PKG_VERSION $pkg_version"

# --- 3. build -----------------------------------------------------------------
say "building ($BUILD_CMD) — no network, nothing published"
# shellcheck disable=SC2086  # BUILD_CMD is a command line by design
$BUILD_CMD
[ -f "$BUILD_OUT" ] || die "the build produced no $BUILD_OUT"
mkdir -p "$(dirname "$DIST")"
install -m 0755 "$BUILD_OUT" "$DIST"
digest="$(sha256sum "$DIST" | cut -d' ' -f1)"
printf '%s  %s\n' "$digest" "$(basename "$DIST")" > "$DIST.sha256"
say "built $DIST ($(wc -c < "$DIST") bytes)"
say "sha256 $digest"

# --- 4. rewrite the pin -------------------------------------------------------
# D3/D8: the release and its pin must travel together, or the installer points
# at bytes nobody verified. Note the .sha256 sidecar written above is a LOCAL
# convenience only — it is never published (D4: a same-origin checksum asset
# would add zero protection against anyone who can write to the release).
tmp="$(mktemp)"
sed -E "s#^GROKFLEET_RELEASE=.*#GROKFLEET_RELEASE=$pinned_tag#; s#^GROKFLEET_SHA256=.*#GROKFLEET_SHA256=$digest#" \
  "$INSTALLER" > "$tmp"
cat "$tmp" > "$INSTALLER"
rm -f "$tmp"
say "rewrote GROKFLEET_RELEASE / GROKFLEET_SHA256 in $INSTALLER"
say ""
say "NEXT (D15): commit that bump, then run:  make ts-release-publish CONFIRM=1"
