#!/usr/bin/env bash
# supervisor-only.sh — blast-radius gate for supervisor doctrine hooks.
#
# Usage (settings.json): supervisor-only.sh <real-hook> [args...]
# Runs the wrapped hook ONLY when this Claude Code session is the CAO
# SUPERVISOR seat. Everywhere else — plain Claude Code sessions in this
# repo, claude_code-provider CAO worker terminals — it exits 0 silently,
# so the wrapped guard never fires.
#
# F519 (#374): the seat verdict + cache now live in lib/seatgate.sh (the single
# shared shell-side implementation). This file is a THIN SHIM over that lib; the
# wrapper API (argv contract) is UNCHANGED, so settings.json needs zero churn.
#
# Supervisor discriminator (precedent: supervisor-inbox-drain.sh Gate 5,
# verified 2026-08-12): GET /terminals/$CAO_TERMINAL_ID → caller_id is
# null for the seat; every worker carries its creator's id. Result is
# cached per terminal id (terminal ids are never reused), so the API is
# hit once per terminal, not once per tool call.
#
# Failure posture (fail-open silent): no CAO_TERMINAL_ID → not the seat →
# skip. API unreachable and no cache → skip this fire, don't cache. lib
# missing/unsourceable → skip (a broken gate must never break a tool call).
set -u

[[ $# -ge 1 ]] || exit 0
[[ -n "${CAO_TERMINAL_ID:-}" ]] || exit 0

# Source the shared seat-gate lib. If it is absent or unsourceable, fail open
# (skip the wrapped hook) — never break a tool call over a missing gate.
_SEATGATE_LIB="${SEATGATE_LIB:-$(dirname "$0")/lib/seatgate.sh}"
# shellcheck source=lib/seatgate.sh
if ! source "$_SEATGATE_LIB" 2>/dev/null; then
    exit 0
fi
# Defensive: lib present but require_supervisor_seat undefined → fail open.
if ! declare -F require_supervisor_seat >/dev/null 2>&1; then
    exit 0
fi

require_supervisor_seat || exit 0
exec "$@"
