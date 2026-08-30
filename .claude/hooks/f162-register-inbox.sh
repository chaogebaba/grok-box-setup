#!/usr/bin/env bash
# F162 D9 (rebuilt): Mechanized cc_team_inbox_path registration.
#
# Derivation: scans OWN session's subagent meta.json files for the teamName key.
# Path pattern: ~/.claude/projects/*/<session_id>/subagents/*.meta.json
# The session_id comes from hook stdin JSON (session_id field, provided by both
# SessionStart and PostToolUse triggers).
#
# Exactly one unique teamName → registers ~/.claude/teams/<teamName>/inboxes/team-lead.json
# via PATCH /terminals/<id>/metadata on the local cao-server.
# Zero or ambiguous matches → WARN to stderr, exit 0 (mute recoverable).
#
# Fires as SessionStart and PostToolUse (Agent/Task spawn tool). Idempotent:
# skips PATCH when GET shows the same path already registered.
#
# D9 law: derivation by exact key only, never recency/mtime selection among team dirs.

set -euo pipefail

# Silent no-op without CAO_TERMINAL_ID — not a CAO-managed supervisor.
if [ -z "${CAO_TERMINAL_ID:-}" ]; then
    exit 0
fi

# Read stdin JSON to get session_id.
STDIN_JSON=$(cat 2>/dev/null || true)
if [ -z "$STDIN_JSON" ]; then
    exit 0
fi

# Extract session_id from stdin JSON.
OWN_SESSION_ID=$(echo "$STDIN_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    sid = data.get('session_id', '')
    print(sid if sid else '')
except Exception:
    print('')
" 2>/dev/null)

if [ -z "$OWN_SESSION_ID" ]; then
    exit 0
fi

# Scan subagent meta.json files for this session's teamName.
# D9: derivation by exact key match from OWN session's meta files only.
TEAM_NAMES=()
for metafile in "$HOME"/.claude/projects/*/"$OWN_SESSION_ID"/subagents/*.meta.json; do
    [ -f "$metafile" ] || continue
    TNAME=$(python3 -c "
import sys, json
try:
    data = json.load(open('$metafile'))
    tn = data.get('teamName', '')
    print(tn if tn else '')
except Exception:
    print('')
" 2>/dev/null)
    if [ -n "$TNAME" ]; then
        # Collect unique team names only.
        ALREADY=0
        for existing in "${TEAM_NAMES[@]+"${TEAM_NAMES[@]}"}"; do
            if [ "$existing" = "$TNAME" ]; then
                ALREADY=1
                break
            fi
        done
        if [ "$ALREADY" -eq 0 ]; then
            TEAM_NAMES+=("$TNAME")
        fi
    fi
done

if [ "${#TEAM_NAMES[@]}" -eq 0 ]; then
    echo "f162-register-inbox: WARN: 0 teamName matches for session=$OWN_SESSION_ID — registering nothing (recoverable)" >&2
    exit 0
fi

if [ "${#TEAM_NAMES[@]}" -gt 1 ]; then
    echo "f162-register-inbox: WARN: ${#TEAM_NAMES[@]} distinct teamNames for session=$OWN_SESSION_ID — ambiguous, registering nothing" >&2
    exit 0
fi

# Exactly one unique teamName — derive the inbox path.
TEAM_NAME="${TEAM_NAMES[0]}"
CC_INBOX_PATH="$HOME/.claude/teams/${TEAM_NAME}/inboxes/team-lead.json"

# Verify the team dir actually exists.
if [ ! -d "$HOME/.claude/teams/${TEAM_NAME}" ]; then
    echo "f162-register-inbox: WARN: team dir ~/.claude/teams/${TEAM_NAME} does not exist — registering nothing" >&2
    exit 0
fi

# F213 D15: Verify the inbox file exists before registering (second nail from §1c).
if [ ! -f "$CC_INBOX_PATH" ]; then
    echo "f162-register-inbox: WARN: inbox file ${CC_INBOX_PATH} does not exist — registering nothing" >&2
    exit 0
fi

# Idempotency check: GET current metadata, skip PATCH if already registered with same path.
CAO_PORT="${CAO_PORT:-9889}"
CAO_URL="http://127.0.0.1:${CAO_PORT}"

CURRENT_META=$(curl -s -f "${CAO_URL}/terminals/${CAO_TERMINAL_ID}" 2>/dev/null || echo "")
if [ -n "$CURRENT_META" ]; then
    CURRENT_PATH=$(echo "$CURRENT_META" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(data.get('metadata', {}).get('cc_team_inbox_path', ''))
except Exception:
    print('')
" 2>/dev/null)
    if [ "$CURRENT_PATH" = "$CC_INBOX_PATH" ]; then
        # Already registered with the correct path — no-op.
        exit 0
    fi
fi

# Register via PATCH /terminals/<id>/metadata (whole-dict replace).
PAYLOAD=$(python3 -c "
import json, sys
# Preserve existing metadata fields, update cc_team_inbox_path.
existing = {}
meta_str = '''$CURRENT_META'''
if meta_str:
    try:
        existing = json.loads(meta_str).get('metadata') or {}
    except Exception:
        pass
existing['cc_team_inbox_path'] = '$CC_INBOX_PATH'
print(json.dumps({'metadata': existing}))
" 2>/dev/null)

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH \
    "${CAO_URL}/terminals/${CAO_TERMINAL_ID}/metadata" \
    -H "Content-Type: application/json" \
    -d "${PAYLOAD}" 2>/dev/null)

if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
    echo "f162-register-inbox: ERROR: PATCH returned HTTP $HTTP_CODE (terminal=$CAO_TERMINAL_ID)" >&2
fi

exit 0
