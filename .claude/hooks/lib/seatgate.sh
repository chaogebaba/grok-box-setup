#!/usr/bin/env bash
# seatgate.sh — shared supervisor seat-gate library for shell hooks (F519 #374).
#
# DRY consolidation of the "is this the CAO SUPERVISOR seat" verdict that was
# maintained in parallel by supervisor-only.sh and supervisor-inbox-drain.sh
# (Gate 5). Source this file; do not exec it.
#
#   source "$(dirname "$0")/lib/seatgate.sh"
#
# ---------------------------------------------------------------------------
# Discriminator (precedent: supervisor-only.sh + supervisor-inbox-drain.sh
# Gate 5, verified 2026-08-12): GET $CAO_ENDPOINT/terminals/$CAO_TERMINAL_ID →
# caller_id is null for the seat; every worker carries its creator's id.
# ---------------------------------------------------------------------------
#
# Verdict cache: /data/cao-scratch/hook-gate/<CAO_TERMINAL_ID> holds the string
# "supervisor" or "worker" (terminal ids are never reused, so the API is hit
# once per terminal, not once per tool call). This is the SINGLE shell-side
# verdict cache shared across every sourcing shell hook.
#
# Failure posture (BEST-PRACTICE BAR, F519): the GATING verdict is FAIL-OPEN
# SILENT. No CAO_TERMINAL_ID, deps missing (curl/python3), or API down with no
# cache → seatgate_verdict returns "worker"/"unknown" and require_supervisor_seat
# skips the wrapped hook (exit 0). A broken gate must never break a tool call.
# The wrapped guard's OWN deny semantics stay fail-closed in the guard itself —
# this lib only answers "is this the supervisor seat", never denies.

# Guard against double-sourcing.
if [[ -n "${__SEATGATE_SH_LOADED:-}" ]]; then
    return 0 2>/dev/null || true
fi
__SEATGATE_SH_LOADED=1

# Single shared shell-side verdict cache location. Overridable for tests via
# SEATGATE_CACHE_DIR (offline harness stubs this to a tmp dir).
SEATGATE_CACHE_DIR="${SEATGATE_CACHE_DIR:-/data/cao-scratch/hook-gate}"

# ---------------------------------------------------------------------------
# seatgate_verdict — echo "supervisor" | "worker" | "unknown".
#
#   "supervisor"  this terminal is the supervisor seat (caller_id null)
#   "worker"      this terminal is a worker (caller_id set) — a DEFINITE verdict
#   "unknown"     could not determine (no tid, deps/API failure, no cache) —
#                 callers MUST treat "unknown" as not-the-seat (fail-open skip)
#
# Cache semantics preserved byte-for-byte from supervisor-only.sh: only the two
# definite verdicts ("supervisor"/"worker") are ever written; "unknown" is never
# cached (the seat's verdict lands on the first healthy call).
# ---------------------------------------------------------------------------
seatgate_verdict() {
    local tid="${CAO_TERMINAL_ID:-}"
    [[ -n "$tid" ]] || { printf '%s\n' unknown; return 0; }

    local cache_dir="$SEATGATE_CACHE_DIR"
    local cache="$cache_dir/${tid}"

    local verdict=""
    if [[ -r "$cache" ]]; then
        read -r verdict < "$cache" || verdict=""
    fi

    if [[ "$verdict" != "supervisor" && "$verdict" != "worker" ]]; then
        local endpoint="${CAO_ENDPOINT:-http://127.0.0.1:9889}"
        verdict=$(curl -s --max-time 2 "$endpoint/terminals/$tid" 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print('supervisor' if d.get('caller_id') is None and 'id' in d else 'worker')
except Exception:
    print('unknown')
" 2>/dev/null || echo unknown)
        if [[ "$verdict" == "supervisor" || "$verdict" == "worker" ]]; then
            { mkdir -p "$cache_dir" && printf '%s\n' "$verdict" > "$cache"; } 2>/dev/null || true
        fi
    fi

    case "$verdict" in
        supervisor|worker) printf '%s\n' "$verdict" ;;
        *) printf '%s\n' unknown ;;
    esac
}

# ---------------------------------------------------------------------------
# require_supervisor_seat — fail-open gate for the sourcing hook.
#
# Returns 0 (success) iff this terminal is the supervisor seat. Returns 1
# otherwise (no tid, worker, or indeterminate). Callers that were previously
# `exit 0`-on-skip translate a non-zero return into their own skip/exit.
# ---------------------------------------------------------------------------
require_supervisor_seat() {
    [[ "$(seatgate_verdict)" == "supervisor" ]]
}

# ---------------------------------------------------------------------------
# emit_additional_context — print a Claude Code structured-hook JSON envelope
# carrying additionalContext for the given hook event (default PostToolUse).
#
#   emit_additional_context "<context string>" [hookEventName]
#
# Uses python3 for correct JSON string escaping. Best-effort: on any failure it
# prints nothing (the hook must never crash on emission).
# ---------------------------------------------------------------------------
emit_additional_context() {
    local ctx="$1"
    local event="${2:-PostToolUse}"
    CTX="$ctx" EVENT="$event" python3 -c "
import json, os
try:
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': os.environ.get('EVENT', 'PostToolUse'),
            'additionalContext': os.environ.get('CTX', ''),
        }
    }))
except Exception:
    pass
" 2>/dev/null || true
}
