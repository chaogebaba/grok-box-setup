#!/bin/bash
# release-publish.sh — STEP 3 of the D15 release sequence
# (`make ts-release-publish CONFIRM=1`).
#
# This is the ONE outward-facing target: it creates a public git tag and uploads
# a public release asset to a public repo. It is deliberately NOT reachable from
# `make test` or any gate (D12): no gate exercises the publish happy path.
#
# Refusals, all checked BEFORE anything is created:
#   * the working tree is dirty            (so the tag names exactly what is pinned)
#   * HEAD is not on main
#   * the tag already exists
#   * the built artifact's digest != the committed FLEET2_SHA256   (D12)
#   * CONFIRM=1 is absent
# The plan is PRINTED before any of it happens (D8).
#
# Usage: bash fleet/scripts/release-publish.sh <installer> <dist-asset> <repo> <confirm>
set -euo pipefail

INSTALLER="${1:?usage: release-publish.sh <installer> <dist-asset> <repo> <confirm>}"
DIST="${2:?usage: release-publish.sh <installer> <dist-asset> <repo> <confirm>}"
REPO="${3:?usage: release-publish.sh <installer> <dist-asset> <repo> <confirm>}"
CONFIRM="${4:-}"

die() { echo "ts-release-publish: REFUSED — $*" >&2; exit 1; }
say() { echo "ts-release-publish: $*"; }

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

[ -f "$INSTALLER" ] || die "no installer at $INSTALLER"

# --- clean tree ---------------------------------------------------------------
# D15: step 1 (ts-release-build) leaves the two pin constants dirty ON PURPOSE
# and step 2 is the operator committing them. Publishing off a dirty tree would
# create a tag whose commit does not carry the pin that is being published.
if [ -n "$(git status --porcelain)" ]; then
  die "the working tree is dirty. If this is the pin bump from 'make ts-release-build', COMMIT it first (D15 step 2):
$(git status --porcelain)"
fi

# --- on main ------------------------------------------------------------------
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = main ] || die "HEAD is on '$branch', not main"

# --- read the committed pin ---------------------------------------------------
tag="$(sed -nE 's/^FLEET2_RELEASE=(.*)$/\1/p' "$INSTALLER" | head -1)"
want="$(sed -nE 's/^FLEET2_SHA256=(.*)$/\1/p' "$INSTALLER" | head -1)"
[ -n "$tag" ]  || die "could not read FLEET2_RELEASE from $INSTALLER"
[ -n "$want" ] || die "could not read FLEET2_SHA256 from $INSTALLER"

# --- tag must not exist -------------------------------------------------------
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  die "tag $tag already exists locally — a release tag is never moved (a moved tag makes the pin a lie)"
fi

# --- the artifact must BE the committed pin (D12) -----------------------------
[ -f "$DIST" ] || die "no artifact at $DIST — run 'make ts-release-build' first"
got="$(sha256sum "$DIST" | cut -d' ' -f1)"
if [ "$got" != "$want" ]; then
  die "artifact digest != the committed FLEET2_SHA256 — the published bytes and the pin would disagree
  artifact $DIST: $got
  committed pin:  $want
  re-run 'make ts-release-build' and commit the bump"
fi

# --- print the plan (D8) ------------------------------------------------------
say "PLAN — this creates a PUBLIC tag and a PUBLIC release asset:"
say "  repo      $REPO"
say "  tag       $tag   (created at $(git rev-parse --short HEAD), branch $branch)"
say "  asset     $DIST  ($(wc -c < "$DIST") bytes)"
say "  sha256    $got   (== the committed FLEET2_SHA256)"
say "  NOTE      no .sha256 asset is published (D4): a same-origin checksum adds"
say "            zero protection against anyone who can write to the release."

if [ "$CONFIRM" != 1 ]; then
  die "CONFIRM=1 not set. Re-run:  make ts-release-publish CONFIRM=1"
fi

command -v gh >/dev/null 2>&1 || die "gh is not installed (needed to create the release)"
if gh release view "$tag" --repo "$REPO" >/dev/null 2>&1; then
  die "release $tag already exists on $REPO"
fi

git tag -a "$tag" -m "fleet2 $tag"
git push origin "refs/tags/$tag"
gh release create "$tag" "$DIST" --repo "$REPO" \
  --title "fleet2 $tag" \
  --notes "fleet2 linux-x64 release asset. Verified by vps/install-vps.sh against the in-repo FLEET2_SHA256=$got — see docs/FLEET-BRAIN.md §\"Release + install\" for what that does and does not defend against."
say "published $tag on $REPO"
