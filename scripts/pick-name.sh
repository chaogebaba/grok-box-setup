#!/bin/bash
# Print the next free grok-box-N. Only after Connect (peers visible).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$HERE/lib/common.sh"
# shellcheck source=/dev/null
. "$HERE/lib/naming.sh"

st="$(backend_state)"
case "$st" in
  Running) ;;
  *)
    echo "pick-name: backend=$st — cannot list tailnet yet" >&2
    exit 2
    ;;
esac

pick_grok_box_name
