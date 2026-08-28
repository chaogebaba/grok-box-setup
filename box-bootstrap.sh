#!/bin/bash
# Compat shim + corruption self-heal. The external hourly keep-alive automation
# calls `box-bootstrap.sh --once`; that flag contract is frozen. All real logic
# lives in ./boxup — use it directly for anything new.
#
# Second line of defense (D5): if the co-located boxup is missing or corrupt
# (external corruption, a partial restore), re-clone + reinstall from GitHub as
# root, then run `boxup once` before satisfying the original request. D3's
# atomic install removes torn writes from our OWN tooling; this covers the rest.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
BOXUP="$HERE/boxup"
DEFAULT_REPO="https://github.com/chaogebaba/grok-box-setup.git"

# Map the frozen shim flags to a boxup subcommand (unchanged contract).
case "${1:-}" in
  --once)   sub=once ;;
  --ensure) sub=ensure ;;
  --status) sub=status ;;
  --stop)   sub=stop ;;
  "")       sub=up ;;
  *)        sub="$1" ;;
esac
[ "$#" -gt 0 ] && shift || true

# Healthy iff boxup exists, parses, and ends with its literal tail sentinel —
# bash -n alone accepts a file truncated at a statement boundary (boxup's
# dispatch is last), so the sentinel is the real corruption guard.
if [ -f "$BOXUP" ] && bash -n "$BOXUP" 2>/dev/null \
   && [ "$(tail -n1 "$BOXUP" 2>/dev/null)" = "# boxup-eof" ]; then
  exec bash "$BOXUP" "$sub" "$@"
fi

# --- self-heal (unhealthy boxup) --------------------------------------------
echo "[shim] SELF-HEAL: boxup missing/corrupt at $BOXUP — re-cloning" >&2
# Repo URL from config.toml [update].repo (sed anchored to the [update] table
# so a future repo= in another table can't hijack the root clone). Reject any
# non-https value at the parse site; fall back to the hardcoded default.
repo="$(sed -n '/^[[:space:]]*\[update\]/,/^[[:space:]]*\[/{s/^[[:space:]]*repo[[:space:]]*=[[:space:]]*//p}' \
  "$HERE/config.toml" 2>/dev/null | head -1 | tr -d '"'"'"' \t\r')"
case "$repo" in https://*) ;; *) repo="$DEFAULT_REPO" ;; esac

tmp="$(mktemp -d)" || { echo "[shim] SELF-HEAL: mktemp failed" >&2; exit 1; }
trap 'rm -rf "$tmp"' EXIT
if ! git clone --depth 1 "$repo" "$tmp/repo" >/dev/null 2>&1; then
  echo "[shim] SELF-HEAL: clone of $repo failed — aborting (no retry)" >&2
  exit 1
fi
# Post-clone sanity gate: never execute anything from the clone until it is
# proven intact (root-executed unpinned clone).
c="$tmp/repo"
if [ ! -f "$c/install.sh" ] || [ ! -f "$c/boxup" ] \
   || ! bash -n "$c/boxup" 2>/dev/null \
   || [ "$(tail -n1 "$c/boxup" 2>/dev/null)" != "# boxup-eof" ]; then
  echo "[shim] SELF-HEAL: cloned repo failed sanity gate — refusing to run it" >&2
  exit 1
fi
echo "[shim] SELF-HEAL: clone OK — installing from $repo" >&2
BOX_SETUP_ROOT="$HERE" bash "$c/install.sh" >&2 || { echo "[shim] SELF-HEAL: install failed" >&2; exit 1; }
# install.sh stops the worker and does not restart it; run `boxup once` first so
# a repair triggered via --status never leaves the box worker-less for an hour.
bash "$BOXUP" once >&2 || true
exec bash "$BOXUP" "$sub" "$@"
# boxup-bootstrap-eof
