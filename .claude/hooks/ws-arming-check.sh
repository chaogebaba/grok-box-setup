#!/bin/sh
# WPDT W2: Check if WS doorbell is enabled but unarmed, emit additionalContext
# to instruct the model to arm. Flag-conditioned: no-op when ws_monitor=False.
#
# Exit 0 with stdout → content appended as additionalContext to the model.
# If the health endpoint reports ws_monitor=True and no active WS connection
# exists for this terminal, output the arming instruction.

set -e

CAO_ENDPOINT="${CAO_ENDPOINT:-http://localhost:9889}"
TERMINAL_ID="${CAO_TERMINAL_ID:-}"

# No terminal ID → not a CAO terminal, skip silently
[ -z "$TERMINAL_ID" ] && exit 0

# Check if ws_monitor is enabled (best-effort, fail silently)
health=$(curl -s --connect-timeout 2 "${CAO_ENDPOINT}/health" 2>/dev/null) || exit 0

# If the health response doesn't mention ws_monitor or it's off, skip
echo "$health" | grep -q '"ws_monitor"' || exit 0
echo "$health" | grep -q '"ws_monitor": *true' || exit 0

# ws_monitor is enabled — instruct the model to arm if not already connected.
# F614 #470 fixes vs the old text:
#   1. The old Monitor({ws: "...${CAO_TERMINAL_ID}..."}) form is emitted
#      verbatim — the ws-source Monitor does NOT expand shell vars, so the
#      literal ${CAO_TERMINAL_TOKEN} reached the server and failed with HTTP
#      403. Emit a python3 websockets one-liner that reads os.environ instead.
#   2. The instruction is now guarded: arming when a Monitor is already live
#      makes the two monitors supersede each other (WS 4008 flaps — observed
#      2026-08-30 ~07:25Z, ~40 notifications).
# F616 #472 fixes vs the F614 text (stdout/stderr discipline + terminal 4008):
#   3. Lifecycle chatter ("WS connected", "reconnect after ...", "superseded")
#      goes to STDERR — monitor stdout is queued while the seat is blocked on
#      a user prompt and renders as a burst when the user answers; only real
#      "[CAO] callback waiting" frames may be stdout events.
#   4. The reconnect loop treats WS close code 4008 (superseded) as TERMINAL:
#      stop reconnecting, print one line, exit — an older monitor never fights
#      a newer one.
cat <<'EOF'
[CAO-ARMING] The WS doorbell monitor is enabled (supervisor.wake.ws_monitor=True).
ONLY if no Monitor task named 'CAO supervisor WS doorbell' is already running
(check the task list first), arm now — this is the ws-source form; the Monitor
tool does not expand shell vars, so use the python3/os.environ form:

python3 - <<'PY'
import asyncio, os, sys, websockets

URL = (f"ws://localhost:9889/ws/supervisor/{os.environ['CAO_TERMINAL_ID']}"
       f"?token={os.environ['CAO_TERMINAL_TOKEN']}")

def lifecycle(msg):
    # F616 #472: lifecycle chatter is NEVER a stdout event — stderr only.
    print(msg, file=sys.stderr, flush=True)

async def main():
    backoff = 2
    while True:
        try:
            async with websockets.connect(URL) as ws:
                lifecycle("WS connected")
                async for frame in ws:
                    if "[CAO]" in frame:
                        print(frame, flush=True)  # the ONLY stdout surface
                    else:
                        lifecycle(frame)
                # websockets' async-for exits normally on a CLEAN close
                # (1000/1001) without raising — emit the reconnect line here.
                lifecycle(f"WS closed; reconnect after {backoff}s")
        except websockets.ConnectionClosed as e:
            code = e.rcvd.code if e.rcvd is not None else None
            if code == 4008:  # superseded by a newer monitor — TERMINAL
                lifecycle("superseded (WS 4008) — monitor exiting, do not re-arm")
                return
            lifecycle(f"WS closed (code={code}); reconnect after {backoff}s")
        except Exception as e:
            lifecycle(f"connect failed ({type(e).__name__}); reconnect after {backoff}s")
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60)

asyncio.run(main())
PY

Only "[CAO] callback waiting" frames go to stdout; lifecycle lines go to stderr.
On close code 4008 the monitor exits for good (superseded — never re-arm).
This enables immediate callback delivery without composer injection.
On frame receipt, call list_messages to obtain the full message — never reply to previews.
EOF
