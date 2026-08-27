#!/bin/bash
# Compat shim. The external hourly keep-alive automation calls
# `box-bootstrap.sh --once`; that contract is frozen. All logic lives in
# ./boxup — use it directly for anything new.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
case "${1:-}" in
  --once)   exec bash "$HERE/boxup" once ;;
  --ensure) exec bash "$HERE/boxup" ensure ;;
  --status) exec bash "$HERE/boxup" status ;;
  --stop)   exec bash "$HERE/boxup" stop ;;
  "")       exec bash "$HERE/boxup" up ;;
  *)        exec bash "$HERE/boxup" "$@" ;;
esac
