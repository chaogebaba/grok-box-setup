#!/usr/bin/env bash
# F123 — PostToolUse hook: auto-drain supervisor mailbox at idle boundary.
#
# Fast-path: checks a filesystem sentinel (<5ms). Only spawns `cao` CLI
# when pending messages exist. Emits structured hook JSON so Claude Code
# injects the drained messages into the supervisor's context.
#
# Exit 0 always (hook must never block the agent).
#
# F508 seat-gate annotation: WORKER-OK (not wrapped by supervisor-only.sh).
# Self-gates via Gate 5 (caller_id-null API check) — workers exit 0 at Gate 5
# after paying only the sentinel fast-path cost. No external wrapper needed.
set -euo pipefail

# --- Gate 0 (F135): never drain from a subagent context ---
# In-process subagents inherit CAO_TERMINAL_ID, so without this gate their
# PostToolUse fire acks supervisor-bound messages into the SUBAGENT's context
# (silent loss for the supervisor). Discriminator (verified 2026-08-12): hook
# stdin JSON carries top-level "agent_id"/"agent_type" ONLY in subagent
# invocations. String match is deliberate — a false positive merely skips one
# drain (messages stay pending for the next main-session fire).
STDIN_PAYLOAD=$(cat 2>/dev/null || true)
if [[ "$STDIN_PAYLOAD" == *'"agent_id"'* ]]; then
    exit 0
fi

# --- Gate 1: non-CAO context → no-op ---
# The supervisor runs INSIDE a CAO terminal, so CAO_TERMINAL_ID is REQUIRED
# (it also resolves `--to me`). Worker terminals are excluded by Gate 5 below.
if [[ -z "${CAO_TERMINAL_ID:-}" ]]; then
    exit 0
fi

# --- Gate 2: determine CAO data dir ---
CAO_DATA_DIR="${CAO_HOME_DIR:-$HOME/.aws/cli-agent-orchestrator}"

# --- Gate 2.5 (F582 D22): idempotent-ack guard vs the overlay-composed hook ---
# D22 relocates the drain/ack edge into the per-seat settings overlay
# (cli_agent_orchestrator.hooks.supervisor_drain / …supervisor_ack). This
# repo-local copy is a dev convenience and must NO-OP when the overlay edge has
# already run for this incarnation, so the extra repo-local work (digest
# re-injection, CC team-inbox scrub, spool append) does not run twice. The
# server drain is idempotent regardless; this only suppresses the duplicate
# repo-local side effects. Sentinel keyed on terminal id + process incarnation
# (both never reused / bump on phoenix), so it can never wedge a live seat.
# Fail-open: any error falls through to a normal (safe, idempotent) drain.
_D22_INCARNATION="${CAO_PROCESS_INCARNATION:-noinc}"
_D22_ACK_SENTINEL="$CAO_DATA_DIR/supervisor-drain-ack.${CAO_TERMINAL_ID}.${_D22_INCARNATION}"
if [[ "${CAO_OVERLAY_HOOKS_ACTIVE:-}" == "1" ]] && [[ -f "$_D22_ACK_SENTINEL" ]]; then
    # Overlay owns the edge this incarnation AND has already acked — no-op.
    exit 0
fi
# Stamp the sentinel best-effort so a sibling fire this incarnation sees it.
# (The overlay hook stamps the same path; see supervisor_drain.py companion.)
touch "$_D22_ACK_SENTINEL" 2>/dev/null || true

# --- Gate 3: sentinel fast-path (no pending → conditional exit) ---
# Design contract (pg-boss precedent): the sentinel can only ACCELERATE delivery,
# never gate it. When absent, fall through if the last drain check is stale (>120s).
SENTINEL="$CAO_DATA_DIR/supervisor-pending.flag"
DRAIN_STAMP="$CAO_DATA_DIR/supervisor-last-drain.stamp"
if [[ ! -f "$SENTINEL" ]]; then
    # Sentinel absent — check staleness marker
    if [[ -f "$DRAIN_STAMP" ]]; then
        STAMP_AGE=$(( $(date +%s) - $(stat -c %Y "$DRAIN_STAMP" 2>/dev/null || echo 0) ))
        if [[ $STAMP_AGE -lt 120 ]]; then
            exit 0
        fi
        # Stale (>=120s) — fall through to drain unconditionally
    fi
    # No stamp file at all — first run or stamp deleted; fall through to drain
fi

# --- Gate 4: flock dedup (non-blocking; skip if another drain in progress) ---
LOCKFILE="$CAO_DATA_DIR/supervisor-drain.lock"
exec 9>"$LOCKFILE"
if ! flock -n 9; then
    exit 0
fi

# --- Gate 5: supervisor identity (workers must not drain) ---
# A supervisor terminal is one launched directly (caller_id null); assigned
# workers carry their caller's id. Runs after the sentinel gate so the
# no-mail fast path never pays this API call.
#
# F519 (#374): the seat verdict + cache now come from lib/seatgate.sh (single
# shared shell-side implementation). Fail-open: if the lib is missing or the
# verdict is not "supervisor", exit 0 (a worker mistakenly skipped loses
# nothing — drain is supervisor-only by definition). Caching the verdict is a
# pure speedup; terminal ids are never reused so the answer cannot change.
_SEATGATE_LIB="${SEATGATE_LIB:-$(dirname "$0")/lib/seatgate.sh}"
# shellcheck source=lib/seatgate.sh
if ! source "$_SEATGATE_LIB" 2>/dev/null; then
    exit 0
fi
if ! declare -F require_supervisor_seat >/dev/null 2>&1; then
    exit 0
fi
require_supervisor_seat || exit 0

# --- Drain: list pending messages ---
PENDING_JSON=$(cao messages list --to me --status pending 2>/dev/null) || exit 0

# Touch the staleness marker — records that we just performed a real drain check.
touch "$DRAIN_STAMP" 2>/dev/null || true

# Parse message count — exit if empty
MSG_COUNT=$(echo "$PENDING_JSON" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    items = data.get('items', data.get('messages', []))
    print(len(items))
except Exception:
    print(0)
" 2>/dev/null) || MSG_COUNT=0

if [[ "$MSG_COUNT" == "0" ]] || [[ -z "$MSG_COUNT" ]]; then
    exit 0
fi

# --- Build digest and ack ---
# Use python to parse, format, ack, and emit structured JSON in one pass.
echo "$PENDING_JSON" | python3 -c "
import sys, json, subprocess, os, time

CAO_DATA_DIR = os.environ.get('CAO_HOME_DIR', os.path.expanduser('~/.aws/cli-agent-orchestrator'))
MAX_CONTEXT = 16000

try:
    data = json.load(sys.stdin)
    items = data.get('items', data.get('messages', []))
    if not items:
        sys.exit(0)

    # Sort by id ascending
    items.sort(key=lambda m: int(m.get('id', 0)))
    min_id = items[0].get('id', '?')
    max_id = items[-1].get('id', '?')
    count = len(items)

    # Build digest lines
    header = f'[CAO INBOX] {count} message(s) auto-surfaced and acked (ids {min_id}-{max_id}):\n'
    body_lines = []
    for msg in items:
        sender = msg.get('sender_id', 'unknown')
        msg_id = msg.get('id', '?')
        # Age calculation (best-effort)
        age_str = ''
        created = msg.get('created_at', '')
        if created:
            try:
                from datetime import datetime, timezone
                if isinstance(created, str):
                    ct = datetime.fromisoformat(created.replace('Z', '+00:00'))
                    if ct.tzinfo is None:
                        ct = ct.replace(tzinfo=timezone.utc)  # DB stores naive UTC (F130)
                    age_s = int((datetime.now(timezone.utc) - ct).total_seconds())
                    age_str = f', {age_s}s ago'
            except Exception:
                pass
        body = msg.get('message', '')
        body_lines.append((msg_id, sender, age_str, body))

    # Assemble with truncation
    digest = header
    remaining_budget = MAX_CONTEXT - len(header) - 100  # reserve for safety

    for msg_id, sender, age_str, body in body_lines:
        line_header = f'\n--- From {sender} (id {msg_id}{age_str}) ---\n'
        line_footer = '\n---'
        overhead = len(line_header) + len(line_footer)
        body_budget = remaining_budget - overhead

        if body_budget <= 0:
            # No room left — still include the header for attribution
            digest += line_header + '...[truncated; full body: cao messages list --to me --audit-browse --after-id ' + str(int(msg_id) - 1) + ' --limit 1]' + line_footer
            remaining_budget = 0
            continue

        if len(body) > body_budget:
            truncated_body = body[:body_budget] + '...[truncated; full body: cao messages list --to me --audit-browse --after-id ' + str(int(msg_id) - 1) + ' --limit 1]'
        else:
            truncated_body = body

        entry = line_header + truncated_body + line_footer
        digest += entry
        remaining_budget -= len(entry)

    # F123-P0: Spool to disk BEFORE ack (durable copy — survives CC injection failure)
    spool_path = os.path.join(CAO_DATA_DIR, 'supervisor-digest-spool.md')
    watermark_path = os.path.join(CAO_DATA_DIR, 'supervisor-digest-spool.watermark')
    from datetime import datetime, timezone
    spool_ts = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S UTC')
    spool_entry = f'\n## [{spool_ts}] ids {min_id}-{max_id}\n{digest}\n'
    # Capture the spool's mtime BEFORE this run appends (0 if absent) so the
    # recovery-notice check below can't false-positive from our own write.
    try:
        pre_write_spool_mtime = os.path.getmtime(spool_path)
    except Exception:
        pre_write_spool_mtime = 0
    try:
        with open(spool_path, 'a') as sf:
            sf.write(spool_entry)
    except Exception:
        pass  # spool write is best-effort; digest still emitted

    # Ack up to max_id
    try:
        subprocess.run(
            ['cao', 'messages', 'ack', '--up-to', str(max_id)],
            capture_output=True, timeout=5
        )
    except Exception:
        pass  # Ack failure is non-fatal; messages re-surface next fire.

    # F157 hotfix: Scrub idle_notification + acked callback replays from CC team inbox
    try:
        import re as _re
        import urllib.request
        _CAO_EP = os.environ.get('CAO_ENDPOINT', 'http://127.0.0.1:9889')
        _TERM_ID = os.environ.get('CAO_TERMINAL_ID', '')
        if _TERM_ID:
            _meta_resp = urllib.request.urlopen(f'{_CAO_EP}/terminals/{_TERM_ID}', timeout=3)
            _meta_json = json.loads(_meta_resp.read())
            _inbox_rel = (_meta_json.get('metadata', {}) or {}).get('metadata', {})
            if isinstance(_inbox_rel, dict):
                _team_inbox_path_raw = _inbox_rel.get('cc_team_inbox_path', '')
            else:
                _team_inbox_path_raw = ''
            if _team_inbox_path_raw:
                _team_inbox_path = os.path.expanduser(_team_inbox_path_raw)
                _lock_path = _team_inbox_path + '.lock'
                _ack_cursor = int(max_id)
                # Acquire lockfile (O_CREAT|O_EXCL, mirror teammate_push_service.py)
                _lock_fd = None
                _LOCK_STALE_S = 5.0
                for _attempt in range(20):
                    try:
                        _lock_fd = os.open(_lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
                        break
                    except FileExistsError:
                        try:
                            _st = os.stat(_lock_path)
                            if (time.time() - _st.st_mtime) > _LOCK_STALE_S:
                                os.unlink(_lock_path)
                        except (FileNotFoundError, OSError):
                            pass
                        time.sleep(0.01)
                    except OSError:
                        break
                if _lock_fd is not None:
                    try:
                        _raw = open(_team_inbox_path, 'r', encoding='utf-8').read()
                        _entries = json.loads(_raw) if _raw.strip() else []
                        if isinstance(_entries, list):
                            _filtered = []
                            for _e in _entries:
                                # (a) unread idle_notification
                                if _e.get('type') == 'idle_notification' and not _e.get('read', False):
                                    continue
                                # (b) cao-bridge mirror entries: ALWAYS redundant at scrub
                                # time -- this hook has just surfaced+acked every pending
                                # CAO message, and both writer formats (F136 per-id and
                                # the legacy count footer) mirror that same inbox.
                                # Anything newer is still pending in CAO and will be
                                # surfaced on the next hook fire.
                                if _e.get('type') == 'message' and _e.get('from') == 'cao-bridge':
                                    continue
                                _filtered.append(_e)
                            if len(_filtered) < len(_entries):
                                # Atomic write: tmp + rename
                                _tmp_path = _team_inbox_path + '.scrub_tmp'
                                _tmp_fd = os.open(_tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
                                try:
                                    _data = json.dumps(_filtered, indent=2).encode('utf-8')
                                    os.write(_tmp_fd, _data)
                                    os.fsync(_tmp_fd)
                                finally:
                                    os.close(_tmp_fd)
                                os.replace(_tmp_path, _team_inbox_path)
                    except (json.JSONDecodeError, OSError, ValueError):
                        pass  # fail-safe: leave file untouched
                    finally:
                        try:
                            os.close(_lock_fd)
                        except OSError:
                            pass
                        try:
                            os.unlink(_lock_path)
                        except OSError:
                            pass
    except Exception:
        pass  # F157 scrub is best-effort; never crash the hook

    # F123-P0: Recovery notice — fires only when a PRIOR run wrote the spool
    # (pre_write_spool_mtime > watermark_mtime) but died before updating its
    # watermark: an incomplete prior run. The current run's own append can no
    # longer trigger it (its mtime is only captured above, before the write).
    try:
        wm_mtime = os.path.getmtime(watermark_path) if os.path.exists(watermark_path) else 0
        if pre_write_spool_mtime > wm_mtime and wm_mtime > 0:
            # Previous digest(s) may have been lost — prepend notice
            digest = f'[CAO INBOX] earlier digest(s) may not have surfaced; see spool at {spool_path}\n' + digest
    except Exception:
        pass

    # Update watermark (marks this emission as the latest surfaced)
    try:
        with open(watermark_path, 'w') as wf:
            wf.write(spool_ts)
    except Exception:
        pass

    # Emit structured hook JSON
    envelope = {
        'hookSpecificOutput': {
            'hookEventName': 'PostToolUse',
            'additionalContext': digest
        }
    }
    print(json.dumps(envelope))

except Exception:
    # Never crash the hook
    sys.exit(0)
" 2>/dev/null || true

# Release lock (fd 9 closed on exit)
exit 0
