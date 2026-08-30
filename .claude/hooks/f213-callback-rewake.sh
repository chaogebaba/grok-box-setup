#!/usr/bin/env bash
# F213 A1 — Callback rewake watcher (carrier-plural, bounded lifetime).
#
# F508 #363: hook timeout reduced from 86400s to 10s. The watcher runs inline
# for up to 10s (1-2 polls); if no pending messages arrive in that window, the
# harness kills it (SIGTERM). Re-armed on every PostToolUse. The WS doorbell
# monitor provides immediate delivery for the post-Stop idle gap.
#
# Modes (S1):
#   --arm --source=<carrier>   Arm the singleton watcher (PostToolUse/Stop/SessionStart).
#                              Default (no args) ≡ --arm --source=stop (backward compat).
#   --prime --notify           SessionStart fallback: prime state, one sync poll, exit 0.
#
# Contract:
#   stdin:  hook JSON (subagent gate uses env-first, bounded read — D35)
#   env:    CAO_TERMINAL_ID (required; absent => silent exit 0)
#           CAO_ENDPOINT (default http://127.0.0.1:9889)
#           CAO_HOME_DIR (default ~/.aws/cli-agent-orchestrator)
#           CAO_PROCESS_INCARNATION (optional — D19: absent => arm anyway)
#   exit:   2 = wake (only non-zero), 0 = everything else
#   stdout: one {-prefixed JSON line on wake (no hookSpecificOutput)
#           --prime --notify: hookSpecificOutput on pending rows
#   stderr: model-visible preview on wake only; silent otherwise
#
# Test-only overrides: F213_POLL_INTERVAL_S, F213_DEADLINE_S (tests only),
#                      F213_COOLDOWN_S, F213_MAX_STREAK, F213_STATE_DIR,
#                      F213_STABILITY_POLLS, F213_OWNER_CHECK_CADENCE

set -euo pipefail

# ---------- S1: Argument parsing ----------
MODE="arm"
SOURCE="stop"
NOTIFY=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --arm) MODE="arm"; shift ;;
        --prime) MODE="prime"; shift ;;
        --notify) NOTIFY=true; shift ;;
        --source=*) SOURCE="${1#--source=}"; shift ;;
        *) shift ;;
    esac
done

# ---------- Identity (D12) ----------
if [[ -z "${CAO_TERMINAL_ID:-}" ]]; then
    exit 0
fi

CAO_ENDPOINT="${CAO_ENDPOINT:-http://127.0.0.1:9889}"
CAO_HOME_DIR="${CAO_HOME_DIR:-$HOME/.aws/cli-agent-orchestrator}"
INCARNATION="${CAO_PROCESS_INCARNATION:-}"

# ---------- F582 D22: idempotent-arm guard vs the overlay-composed rewake ------
# When the per-seat overlay owns the callback-rewake edge for this incarnation
# (CAO_OVERLAY_HOOKS_ACTIVE=1) and it has already armed the watcher for this
# incarnation (sentinel present), the repo-local copy must NOT arm a SECOND
# watcher — two watchers double-poll the same inbox and can double-wake. The
# guard applies to the --arm mode only; --prime --notify (SessionStart sync
# fallback) is left untouched so a fresh session still primes. Fail-open: any
# error falls through to a normal arm (a redundant watcher is bounded to 10s).
_D22_REWAKE_SENTINEL="$CAO_HOME_DIR/callback-rewake-armed.${CAO_TERMINAL_ID}.${INCARNATION:-noinc}"
if [[ "$MODE" == "arm" ]] && [[ "${CAO_OVERLAY_HOOKS_ACTIVE:-}" == "1" ]] \
   && [[ -f "$_D22_REWAKE_SENTINEL" ]]; then
    exit 0
fi
[[ "$MODE" == "arm" ]] && touch "$_D22_REWAKE_SENTINEL" 2>/dev/null || true

# ---------- S2: Fast path — subagent gate (D35, non-blocking, env-first) ----------
# For --source=subagentstop, bypass the gate entirely (N3)
if [[ "$SOURCE" != "subagentstop" ]]; then
    # Env-first: check if CLAUDE_AGENT_ID is set (fastest, no fork)
    if [[ -n "${CLAUDE_AGENT_ID:-}" ]]; then
        exit 0
    fi
    # D35: Non-blocking stdin check. read -t 0 returns 0 iff data is immediately
    # available (no fork, no wait). Only read the payload if data is ready.
    STDIN_PAYLOAD=""
    if read -r -t 0 2>/dev/null; then
        # Data available — read one line (sufficient for the JSON gate check)
        read -r -t 0.1 STDIN_PAYLOAD 2>/dev/null || true
    fi
    if [[ "$STDIN_PAYLOAD" == *'"agent_id"'* ]]; then
        exit 0
    fi
fi

# ---------- Tuning knobs ----------
POLL_INTERVAL_S="${F213_POLL_INTERVAL_S:-5}"
COOLDOWN_S="${F213_COOLDOWN_S:-300}"
MAX_STREAK="${F213_MAX_STREAK:-3}"
STABILITY_POLLS="${F213_STABILITY_POLLS:-2}"
OWNER_CHECK_CADENCE="${F213_OWNER_CHECK_CADENCE:-6}"

# ---------- State directory ----------
STATE_DIR="${F213_STATE_DIR:-${CAO_HOME_DIR}/f213-rewake/${CAO_TERMINAL_ID}}"
mkdir -p "$STATE_DIR"
LOCK_FILE="$STATE_DIR/watcher.lock"
OWNER_FILE="$STATE_DIR/owner.json"
STATE_FILE="$STATE_DIR/state.json"
LOG_FILE="$STATE_DIR/watcher.log"

# ---------- S3: Create lock file if absent (never truncate) ----------
: >>"$LOCK_FILE"

# ---------- Logging (D16, D30) — NDJSON, rate-limited lock-held ----------
LOCK_HELD_STAMP="$STATE_DIR/.lock-held-stamp"

log_event() {
    local event="$1"
    local detail="${2:-}"
    local max_id="${3:-null}"
    local streak="${4:-0}"
    python3 -c "
import json, time, sys, os
obj = {
    'ts': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
    'event': sys.argv[1],
    'incarnation': sys.argv[2] if sys.argv[2] else None,
    'pid': int(sys.argv[3]),
    'max_id': int(sys.argv[4]) if sys.argv[4] != 'null' else None,
    'streak': int(sys.argv[5]),
    'detail': sys.argv[6] if sys.argv[6] else None,
    'arm_source': sys.argv[7] if sys.argv[7] else None
}
print(json.dumps(obj), flush=True)
" "$event" "${INCARNATION}" "$$" "$max_id" "$streak" "$detail" "$SOURCE" >> "$LOG_FILE" 9>&- 2>/dev/null || true
}

# ---------- --prime --notify mode (D29, S11) ----------
if [[ "$MODE" == "prime" ]]; then
    # Never touch the lock, never reset wake_streak (D29, R8 fix)
    # Initialize state.json only if absent/unparseable
    if [[ ! -f "$STATE_FILE" ]] || ! python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    assert 'last_wake_max_id' in d
except:
    sys.exit(1)
" "$STATE_FILE" 2>/dev/null; then
        python3 -c "
import json, sys
state = {'last_wake_max_id': 0, 'last_wake_ts': 0, 'wake_streak': 0}
with open(sys.argv[1], 'w') as f:
    json.dump(state, f)
" "$STATE_FILE" 9>&- 2>/dev/null || true
    fi

    log_event "primed" "" "null" "0"

    # --notify: one synchronous poll, hookSpecificOutput on pending rows
    if [[ "$NOTIFY" == "true" ]]; then
        RESPONSE=$(curl -s --max-time 3 \
            "${CAO_ENDPOINT}/messages?to=${CAO_TERMINAL_ID}&status=pending&limit=100" \
            9>&- 2>/dev/null) || RESPONSE=""

        NOTIFY_RESULT=$(python3 -c "
import json, sys
try:
    resp = sys.argv[1]
    if not resp:
        sys.exit(0)
    data = json.loads(resp)
    items = [i for i in data.get('items', []) if i.get('status') == 'pending']
    if not items:
        sys.exit(0)
    preview_lines = []
    for item in items[:5]:
        sender = item.get('sender_id', '?')
        msg = (item.get('message', '') or '')[:200].replace(chr(10), ' ')
        row_id = item.get('id', '?')
        preview_lines.append(f'  [{row_id}] from={sender}: {msg}')
    output = {
        'hookSpecificOutput': {
            'hookEventName': 'SessionStart',
            'additionalContext': 'CAO callbacks pending:\\n' + '\\n'.join(preview_lines)
        }
    }
    print(json.dumps(output))
except:
    pass
" "$RESPONSE" 9>&- 2>/dev/null || true)

        if [[ -n "$NOTIFY_RESULT" ]]; then
            echo "$NOTIFY_RESULT"
        fi
    fi

    exit 0
fi

# ---------- S2 continued: flock attempt (D6, D26) ----------
exec 9<>"$LOCK_FILE"
if ! flock -n 9; then
    # D30: rate-limited lock-held log (at most once per 60s)
    if [[ ! -f "$LOCK_HELD_STAMP" ]] || \
       [[ $(( $(date +%s) - $(stat -c %Y "$LOCK_HELD_STAMP" 2>/dev/null || echo 0) )) -ge 60 ]]; then
        log_event "lock-held" "another watcher owns the lock"
        touch "$LOCK_HELD_STAMP" 2>/dev/null || true
    fi
    exec 9>&-
    exit 0
fi

# ---------- Lock won — we are the singleton watcher ----------

# S13: SIGTERM/SIGINT trap (D34) — log and exit clean
ARMED_TS=$(date +%s)
trap '
    ELAPSED=$(( $(date +%s) - ARMED_TS ))
    log_event "killed-by-harness" "elapsed=${ELAPSED}s" "null" "0"
    exit 0
' TERM INT

# D19: incarnation-unknown warning (moved after lock per S2)
if [[ -z "$INCARNATION" ]]; then
    log_event "incarnation-unknown" "CAO_PROCESS_INCARNATION absent; arming with pid+mtime only"
fi

# S5: Write owner.json (from bash, correct PID — R3 fix)
# Walk up PPids looking for claude binary (best-effort cc_pid)
CC_PID=""
WALK_PID=$$
for _ in 1 2 3 4 5 6 7 8; do
    WALK_PID=$(awk '/^PPid:/{print $2}' /proc/$WALK_PID/status 2>/dev/null || echo "")
    if [[ -z "$WALK_PID" ]] || [[ "$WALK_PID" == "0" ]] || [[ "$WALK_PID" == "1" ]]; then
        break
    fi
    if readlink /proc/$WALK_PID/exe 2>/dev/null | grep -q "claude"; then
        CC_PID="$WALK_PID"
        break
    fi
done

LOCK_INO=$(stat -c %i "$LOCK_FILE" 2>/dev/null || echo "0")

python3 -c "
import json, sys, os
owner = {
    'pid': int(sys.argv[1]),
    'incarnation': sys.argv[2] if sys.argv[2] else None,
    'arm_source': sys.argv[3],
    'cc_pid': int(sys.argv[4]) if sys.argv[4] else None,
    'lock_ino': int(sys.argv[5]),
    'armed_ts': int(sys.argv[6])
}
with open(sys.argv[7], 'w') as f:
    json.dump(owner, f)
" "$$" "${INCARNATION}" "$SOURCE" "${CC_PID}" "$LOCK_INO" "$ARMED_TS" "$OWNER_FILE" 9>&- 2>/dev/null || true

# ---------- Load state ----------
read_state() {
    python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    print(int(d.get('last_wake_max_id', 0)))
    print(int(float(d.get('last_wake_ts', 0))))
    print(int(d.get('wake_streak', 0)))
except:
    print(0)
    print(0)
    print(0)
" "$STATE_FILE" 9>&- 2>/dev/null
}

save_state() {
    local mid="$1" ts="$2" streak="$3"
    python3 -c "
import json, sys
state = {'last_wake_max_id': int(sys.argv[1]), 'last_wake_ts': int(float(sys.argv[2])), 'wake_streak': int(sys.argv[3])}
with open(sys.argv[4], 'w') as f:
    json.dump(state, f)
" "$mid" "$ts" "$streak" "$STATE_FILE" 9>&- 2>/dev/null || true
}

STATE_LINES=$(read_state)
LAST_WAKE_MAX_ID=$(echo "$STATE_LINES" | sed -n '1p')
LAST_WAKE_TS=$(echo "$STATE_LINES" | sed -n '2p')
WAKE_STREAK=$(echo "$STATE_LINES" | sed -n '3p')

log_event "armed" "" "$LAST_WAKE_MAX_ID" "$WAKE_STREAK"

# ---------- Poll loop (S7: no default deadline; S8: ownership checks; S9: two-poll stability) ----------
BACKOFF_S=2
MAX_BACKOFF_S=60
POLL_COUNT=0
OWNER_DEAD_STRIKES=0
CANDIDATE_MAX_ID=0
CANDIDATE_SEEN=0

while true; do
    # S7: Check explicit deadline (test-only)
    if [[ -n "${F213_DEADLINE_S:-}" ]]; then
        ELAPSED=$(( $(date +%s) - ARMED_TS ))
        if [[ "$ELAPSED" -ge "$F213_DEADLINE_S" ]]; then
            log_event "expired" "deadline ${F213_DEADLINE_S}s reached"
            save_state "$LAST_WAKE_MAX_ID" "$LAST_WAKE_TS" "$WAKE_STREAK"
            exit 0
        fi
    fi

    POLL_COUNT=$(( POLL_COUNT + 1 ))

    # S8a: Inode supersession check (D27) — every poll
    CURRENT_INO=$(stat -c %i "$LOCK_FILE" 2>/dev/null || echo "0")
    if [[ "$CURRENT_INO" != "$LOCK_INO" ]] && [[ "$LOCK_INO" != "0" ]]; then
        log_event "superseded" "lock inode changed: ${LOCK_INO} -> ${CURRENT_INO}"
        save_state "$LAST_WAKE_MAX_ID" "$LAST_WAKE_TS" "$WAKE_STREAK"
        exit 0
    fi

    # S8b: Owner-death check (D28) — every OWNER_CHECK_CADENCE polls
    if [[ $(( POLL_COUNT % OWNER_CHECK_CADENCE )) -eq 0 ]]; then
        # Best-effort cc_pid check first
        if [[ -n "$CC_PID" ]] && ! kill -0 "$CC_PID" 2>/dev/null; then
            log_event "owner-dead" "cc_pid=$CC_PID is dead"
            save_state "$LAST_WAKE_MAX_ID" "$LAST_WAKE_TS" "$WAKE_STREAK"
            exit 0
        fi

        # CAO-native owner check
        OWNER_RESP=$(curl -s --max-time 5 \
            "${CAO_ENDPOINT}/terminals/${CAO_TERMINAL_ID}" \
            9>&- 2>/dev/null) || OWNER_RESP=""

        OWNER_STATUS=$(python3 -c "
import json, sys
try:
    resp = sys.argv[1]
    if not resp:
        print('unknown')
        sys.exit(0)
    data = json.loads(resp)
    print(data.get('status', 'unknown'))
except:
    print('unknown')
" "$OWNER_RESP" 9>&- 2>/dev/null || echo "unknown")

        if [[ "$OWNER_STATUS" == "error" ]] || [[ "$OWNER_STATUS" == "404" ]]; then
            OWNER_DEAD_STRIKES=$(( OWNER_DEAD_STRIKES + 1 ))
            if [[ "$OWNER_DEAD_STRIKES" -ge 3 ]]; then
                log_event "owner-dead" "terminal status=$OWNER_STATUS for 3 consecutive checks"
                save_state "$LAST_WAKE_MAX_ID" "$LAST_WAKE_TS" "$WAKE_STREAK"
                exit 0
            fi
        else
            OWNER_DEAD_STRIKES=0
        fi
    fi

    # ---------- Poll CAO inbox (D1, D8: read-only) ----------
    RESPONSE=$(curl -s --max-time 10 \
        "${CAO_ENDPOINT}/messages?to=${CAO_TERMINAL_ID}&status=pending&limit=100" \
        9>&- 2>/dev/null) || RESPONSE=""

    # Parse response (S10: preview fix — all rows via tail -n +3)
    POLL_RESULT=$(python3 -c "
import json, sys
try:
    resp = sys.argv[1]
    if not resp:
        print('error')
        print('empty_response')
        print('0')
        sys.exit(0)
    data = json.loads(resp)
    items = [i for i in data.get('items', []) if i.get('status') == 'pending']
    if not items:
        print('empty')
        print('')
        print('0')
        sys.exit(0)
    max_id = max(int(item.get('id', 0)) for item in items)
    print('pending')
    # S10: Preview — all rows (up to 5), each on its own line, newlines replaced
    import time
    preview_lines = []
    for item in items[:5]:
        sender = item.get('sender_id', '?')
        msg = (item.get('message', '') or '')[:200].replace(chr(10), ' ').replace(chr(0), '')
        row_id = item.get('id', '?')
        preview_lines.append(f'  [{row_id}] from={sender}: {msg}')
    print('\\n'.join(preview_lines))
    print(str(max_id))
except json.JSONDecodeError:
    print('error')
    print('malformed_json')
    print('0')
except Exception as e:
    print('error')
    print(str(e)[:100])
    print('0')
" "$RESPONSE" 9>&- 2>/dev/null || echo -e "error\nunknown\n0")

    POLL_STATUS=$(echo "$POLL_RESULT" | head -1)
    # S10: preview is all lines between first and last
    POLL_MAX_ID=$(echo "$POLL_RESULT" | tail -1)
    POLL_DETAIL=$(echo "$POLL_RESULT" | tail -n +2 | head -n -1)

    # Handle errors (D13: never wake on error)
    if [[ "$POLL_STATUS" == "error" ]]; then
        log_event "poll-error" "$(echo "$POLL_DETAIL" | head -1)" "$LAST_WAKE_MAX_ID" "$WAKE_STREAK"
        sleep "$BACKOFF_S"
        BACKOFF_S=$(python3 -c "print(min(max(float('$BACKOFF_S') * 2, 2), $MAX_BACKOFF_S))" 9>&- 2>/dev/null || echo "$MAX_BACKOFF_S")
        continue
    fi

    # Reset backoff on successful poll
    BACKOFF_S=2

    # Handle empty (no pending)
    if [[ "$POLL_STATUS" == "empty" ]]; then
        CANDIDATE_MAX_ID=0
        CANDIDATE_SEEN=0
        sleep "$POLL_INTERVAL_S"
        continue
    fi

    # --- Pending messages found ---
    # S9: Two-poll stability (D22)
    if [[ "$POLL_MAX_ID" -eq "$CANDIDATE_MAX_ID" ]] && [[ "$CANDIDATE_MAX_ID" -gt 0 ]]; then
        CANDIDATE_SEEN=$(( CANDIDATE_SEEN + 1 ))
    else
        CANDIDATE_MAX_ID="$POLL_MAX_ID"
        CANDIDATE_SEEN=1
    fi

    if [[ "$CANDIDATE_SEEN" -lt "$STABILITY_POLLS" ]]; then
        sleep "$POLL_INTERVAL_S"
        continue
    fi

    # D10: wake logic (stability confirmed)
    NOW_TS=$(date +%s)

    if [[ "$POLL_MAX_ID" -gt "$LAST_WAKE_MAX_ID" ]]; then
        # Strictly newer id: wake immediately, reset streak
        WAKE_STREAK=0
    else
        # Same id (or older): check cooldown and streak
        COOLDOWN_ELAPSED=$(( NOW_TS - LAST_WAKE_TS ))
        if [[ "$COOLDOWN_ELAPSED" -lt "$COOLDOWN_S" ]]; then
            log_event "cooldown-suppressed" "elapsed=${COOLDOWN_ELAPSED}s < cooldown=${COOLDOWN_S}s" "$POLL_MAX_ID" "$WAKE_STREAK"
            sleep "$POLL_INTERVAL_S"
            continue
        fi
        if [[ "$WAKE_STREAK" -ge "$MAX_STREAK" ]]; then
            log_event "streak-capped" "streak=${WAKE_STREAK} >= max=${MAX_STREAK}" "$POLL_MAX_ID" "$WAKE_STREAK"
            sleep "$POLL_INTERVAL_S"
            continue
        fi
    fi

    # --- WAKE ---
    WAKE_STREAK=$(( WAKE_STREAK + 1 ))
    LAST_WAKE_MAX_ID="$POLL_MAX_ID"
    LAST_WAKE_TS="$NOW_TS"
    save_state "$LAST_WAKE_MAX_ID" "$LAST_WAKE_TS" "$WAKE_STREAK"
    log_event "wake" "max_id=${POLL_MAX_ID} streak=${WAKE_STREAK}" "$POLL_MAX_ID" "$WAKE_STREAK"

    # stdout: minimal valid SyncHookJSONOutput (D5, AC16)
    echo "{\"rewakeSummary\":\"CAO callback waiting (id ${POLL_MAX_ID})\"}"

    # stderr: model-visible preview (D9, S10 — all rows)
    echo "$POLL_DETAIL" >&2

    exit 2
done
