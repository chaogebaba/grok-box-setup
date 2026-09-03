#!/bin/bash
# test-boxup-keepawake.sh — box-free coverage for boxup 5.4.0's keep-awake guard
# (blueprint boxup-keepawake, K1-K6, cases (1)-(12), plus (13) the run_tick /
# converge wiring and (14) the sudo re-exec seams).
# Run from anywhere:  bash tests/test-boxup-keepawake.sh   (or: make test)
# Exit 0 = all pass, 1 = a failure. Needs no root, no network, no listening
# gateway, and touches nothing outside its own mktemp dirs.
#
# Everything below drives the REAL functions extracted out of the repo-root
# `boxup` — no reimplementation. Only the environment around them is stubbed,
# in the shape tests/test-boxup-disk-guard.sh established:
#
#   * `curl` is a stub script on PATH. It records its full argv (so the exact
#     request body, the Authorization header, and the ABSENCE of an Origin
#     header are all directly assertable), answers `/health` from a sequence
#     file one JSON per line (the last repeats, exactly like that suite's
#     DISK_SEQ), and answers `/api/sendPrompt` with a configurable body and rc.
#   * `sleep` is a no-op stub, so the guard's 10 s post-fire poll runs at full
#     speed. Nothing else about the poll is altered — it still makes ten health
#     reads and still stops early on success.
#   * BOXUP_GATEWAY_URL / BOXUP_GATEWAY_JSON (the K6 seams) point at a fake URL
#     and a fixture discovery file, so no port is ever opened.
#   * RUN_DIR, the attempt log, the baseline and the tailscaled log are mktemp
#     paths.
#
# Simulated time: the guard's three stamps are plain epoch files, so "15 s
# later" and "91 s later" are expressed by back-dating a stamp rather than by
# sleeping. That is the same fact the production code reads, so nothing is
# faked that the code does not itself trust.
#
# Cases, and the blueprint mutant each one kills:
#   (1)   a fire sends the exact body, Bearer from the discovery file, NO Origin
#         header, and agentId = activeAgentId from THIS tick's /health
#                                                          [mutants m1, m4]
#   (2)   isBusy && !busyOnlyAwaitingApproval => no sendPrompt, stamp advanced,
#         rc=skip                                                  [mutant m2]
#   (3)   busyOnlyAwaitingApproval with a static lastBusyAtMs => it FIRES,
#         records parked-blocked, and WARNs once an hour            [mutant m3]
#   (3b)  the same with lastBusyAtMs advancing => parked-ok, no WARN
#   (3c)  the same with lastBusyAtMs going BACKWARDS => parked-blocked  [m16]
#   (4)   /health unreachable => rc 0, `unreachable`, the MAIN stamp is NOT
#         advanced, the RETRY stamp is                         [mutants m5, m6]
#   (4b)  the 90 s retry floor: a tick 15 s later makes no curl call, a tick
#         91 s later does, and ten unreachable ticks log ONE line   [mutant m6b]
#   (5)   a stamp younger than interval_min => nothing is called at all
#   (6)   interval_min = 0 => nothing called, one `off` line an hour
#   (7)   the baseline is written ONCE and `jumps` subtracts it      [mutant m7]
#   (8)   `boxup status` carries the four keepawake tokens
#   (9)   accepted but never busy => `inert`, not `ok`               [mutant m8]
#   (10)  a 500 / "accepted":false => `refused`, main stamp advanced [mutant m9]
#   (11)  EVERY outcome appends exactly one rc= line to the attempt log,
#         skips and unreachables included                          [mutant m10]
#   (12)  tests/keepawake-readout.sh classifies the fixture days, counts ALL
#         seven rc tokens, and refuses a contradicted off-days input
#                                    [mutants m11, m12, m13, m14, m15]
#   (13)  keepawake_guard is wired into run_tick outside the converge lock, and
#         converge writes the jumps baseline
#   (14)  the two gateway seams survive require_root's sudo re-exec
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
BOXUP="$ROOT/boxup"
READOUT="$HERE/keepawake-readout.sh"
fail=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; fail=1; }

[ -f "$BOXUP" ] || { echo "cannot find $BOXUP"; exit 1; }
[ -f "$READOUT" ] || { echo "cannot find $READOUT"; exit 1; }

AGENT="11111111-2222-3333-4444-555555555555"
TOKEN="tok-abc-123"

# Health JSON builders. Field order deliberately varies from the guard's read
# order so a positional parser could not pass by accident.
h_idle()   { printf '{"activeAgentId":"%s","isBusy":false,"busyOnlyAwaitingApproval":false,"lastBusyAtMs":%s}\n' "$AGENT" "$1"; }
h_busy()   { printf '{"isBusy":true,"activeAgentId":"%s","busyOnlyAwaitingApproval":false,"lastBusyAtMs":%s}\n' "$AGENT" "$1"; }
h_parked() { printf '{"isBusy":true,"busyOnlyAwaitingApproval":true,"activeAgentId":"%s","lastBusyAtMs":%s}\n' "$AGENT" "$1"; }

# ---------------------------------------------------------------------------
# harness: build an inner script that stubs curl+sleep on PATH, eval-extracts
# the REAL keepawake functions out of the repo-root boxup, runs one scenario,
# and prints a flat result block.
#
# $1 = newline-separated /health bodies, one per curl call (the LAST repeats)
# $2 = the scenario name (see the case block inside)
# $3 = INTERVAL_CFG   ("" => key unset => the baked 20-minute default)
# $4 = SEND_REPLY     (the /api/sendPrompt body; default {"accepted":true})
# $5 = SEND_CURL_RC   (curl's exit code for the send; default 0)
# $6 = HEALTH_FAIL    (curl's exit code for /health; "" => it answers)
# ---------------------------------------------------------------------------
run_case() {
  local seq="$1" scenario="$2" interval="${3:-}" reply="${4:-\{\"accepted\":true\}}" \
        sendrc="${5:-0}" healthfail="${6:-}" inner
  inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
WORK="\$(mktemp -d)"
RUN_DIR="\$WORK/run"; mkdir -p "\$RUN_DIR"
LOGLINES="\$WORK/log"; : > "\$LOGLINES"
BIN="\$WORK/bin"; mkdir -p "\$BIN"

printf '%s\n' '$seq' > "\$WORK/hseq"
export HEALTH_SEQ="\$WORK/hseq" HSEQ_CUR="\$WORK/hseqcur"
export CURL_CALLS="\$WORK/curl-calls"; : > "\$CURL_CALLS"
export CURL_HITS="\$WORK/curl-hits";   : > "\$CURL_HITS"
export SEND_REPLY='$reply'
export SEND_CURL_RC='$sendrc'
export HEALTH_FAIL='$healthfail'

# --- the curl stub ---------------------------------------------------------
# Records the whole argv of every call (one arg per line, '--' between calls),
# then answers by URL. /health pops the next line of HEALTH_SEQ; the last line
# repeats, so a ten-iteration poll can be driven by a two-line sequence.
cat > "\$BIN/curl" <<'CURLEOF'
#!/bin/sh
for a in "\$@"; do printf '%s\n' "\$a"; done >> "\$CURL_CALLS"
echo '--' >> "\$CURL_CALLS"
url=""
for a in "\$@"; do case "\$a" in http*) url="\$a" ;; esac; done
case "\$url" in
  */health)
    echo health >> "\$CURL_HITS"
    if [ -n "\$HEALTH_FAIL" ]; then exit "\$HEALTH_FAIL"; fi
    i=\$(cat "\$HSEQ_CUR" 2>/dev/null || echo 0); i=\$((i + 1)); echo "\$i" > "\$HSEQ_CUR"
    n=\$(wc -l < "\$HEALTH_SEQ")
    [ "\$i" -gt "\$n" ] && i="\$n"
    sed -n "\${i}p" "\$HEALTH_SEQ"
    ;;
  */api/sendPrompt)
    echo send >> "\$CURL_HITS"
    if [ "\$SEND_CURL_RC" != 0 ]; then exit "\$SEND_CURL_RC"; fi
    printf '%s\n' "\$SEND_REPLY"
    ;;
  *) exit 1 ;;
esac
CURLEOF
chmod +x "\$BIN/curl"
# The post-fire poll sleeps 1 s per iteration; a no-op stub keeps the suite fast
# without changing how many reads the loop makes or when it breaks out.
printf '#!/bin/sh\nexit 0\n' > "\$BIN/sleep"; chmod +x "\$BIN/sleep"
PATH="\$BIN:\$PATH"

# --- stubs around the extracted code --------------------------------------
log(){ printf '%s\n' "\$*" >> "\$LOGLINES"; }
have(){ command -v "\$1" >/dev/null 2>&1; }
# The ONLY config stub: the real [keepawake].interval_min lookup, so the
# default / floor / off logic in keepawake_interval_min is the code under test.
INTERVAL_CFG='$interval'
config_get(){
  if [ "\$1" = keepawake ] && [ "\$2" = interval_min ] && [ -n "\$INTERVAL_CFG" ]; then
    printf '%s\n' "\$INTERVAL_CFG"; return 0
  fi
  return 1
}

# --- the K6 seams and the run-dir state ------------------------------------
BOXUP_GATEWAY_URL="http://127.0.0.1:1340"
BOXUP_GATEWAY_JSON="\$WORK/gateway.json"
printf '{"port":1340,"pid":42,"scheme":"http","host":"0.0.0.0","token":"$TOKEN"}\n' > "\$BOXUP_GATEWAY_JSON"
KEEPAWAKE_DEFAULT_MIN=20
KEEPAWAKE_FLOOR_MIN=10
KEEPAWAKE_RETRY_S=90
KEEPAWAKE_POLL_S=10
KEEPAWAKE_PROMPT="Reply with only the word: ok"
KEEPAWAKE_STAMP="\$RUN_DIR/last-keepawake"
KEEPAWAKE_UNREACH_STAMP="\$RUN_DIR/last-keepawake-unreach"
KEEPAWAKE_UNREACH_WARN="\$RUN_DIR/last-keepawake-unreach-warn"
KEEPAWAKE_WARN_STAMP="\$RUN_DIR/last-keepawake-warn"
KEEPAWAKE_OFF_STAMP="\$RUN_DIR/last-keepawake-off"
KEEPAWAKE_RC_FILE="\$RUN_DIR/keepawake"
KEEPAWAKE_LOG="\$WORK/boxup-keepawake.log"
KEEPAWAKE_BASELINE="\$WORK/.boxup-keepawake-baseline"
TAILSCALED_LOG="\$WORK/tailscaled.log"
: > "\$TAILSCALED_LOG"

# --- extract the REAL functions -------------------------------------------
extract_fn_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in keepawake_interval_min keepawake_json_get keepawake_health \\
          keepawake_gateway_token keepawake_fire keepawake_hourly \\
          keepawake_record keepawake_log_attempt keepawake_jumps_raw \\
          keepawake_jumps keepawake_converge keepawake_guard \\
          keepawake_status_tokens; do
  eval "\$(extract_fn_from "\$BOXUP" "\$fn")"
done

backdate(){ f="\$1"; s="\$2"; echo \$(( \$(date +%s) - s )) > "\$f"; }

case "$scenario" in
  guard)
    keepawake_guard; grc=\$?
    ;;
  guard-twice-immediate)
    # Two calls back to back: the second must be swallowed by the cadence stamp.
    keepawake_guard; keepawake_guard; grc=\$?
    ;;
  unreachable-floor-15s)
    # One unreachable tick, then a tick 15 s later: inside the 90 s floor, so
    # the second must make NO curl call at all.
    keepawake_guard
    backdate "\$KEEPAWAKE_UNREACH_STAMP" 15
    echo '--MARK--' >> "\$CURL_HITS"
    keepawake_guard; grc=\$?
    ;;
  unreachable-floor-91s)
    keepawake_guard
    backdate "\$KEEPAWAKE_UNREACH_STAMP" 91
    echo '--MARK--' >> "\$CURL_HITS"
    keepawake_guard; grc=\$?
    ;;
  unreachable-ten)
    # Ten unreachable ticks, each just past the retry floor. Ten attempt-log
    # lines, but only ONE "gateway unreachable" line (the hourly gate).
    i=0
    while [ "\$i" -lt 10 ]; do
      keepawake_guard
      backdate "\$KEEPAWAKE_UNREACH_STAMP" 91
      i=\$((i + 1))
    done
    grc=\$?
    ;;
  young-stamp)
    # The cadence stamp is 60 s old with a 20-minute interval: nothing at all.
    backdate "\$KEEPAWAKE_STAMP" 60
    keepawake_guard; grc=\$?
    ;;
  off-twice)
    keepawake_guard; keepawake_guard; grc=\$?
    ;;
  parked-warn-twice)
    # Two parked-blocked fires inside the hour: two attempt lines, ONE WARN.
    keepawake_guard
    rm -f "\$KEEPAWAKE_STAMP"
    keepawake_guard; grc=\$?
    ;;
  baseline)
    # 3 jumps at converge time, 2 more afterwards: the baseline is written once
    # and never rewritten, so jumps = 5 - 3 = 2.
    printf '2026/09/01 00:00:01 monitor: time jump detected\n' >> "\$TAILSCALED_LOG"
    printf '2026/09/01 01:00:01 monitor: time jump detected\n' >> "\$TAILSCALED_LOG"
    printf '2026/09/01 02:00:01 monitor: time jump detected\n' >> "\$TAILSCALED_LOG"
    keepawake_converge
    base1="\$(cat "\$KEEPAWAKE_BASELINE")"
    printf '2026/09/02 00:00:01 monitor: time jump detected\n' >> "\$TAILSCALED_LOG"
    printf '2026/09/02 03:00:01 monitor: time jump detected\n' >> "\$TAILSCALED_LOG"
    keepawake_converge          # second converge: MUST NOT rewrite the baseline
    echo "baseline1=\$base1 baseline2=\$(cat "\$KEEPAWAKE_BASELINE") raw=\$(keepawake_jumps_raw) jumps=\$(keepawake_jumps)"
    grc=0
    ;;
  tokens)
    keepawake_guard
    echo "tokens:\$(keepawake_status_tokens)"
    grc=0
    ;;
  tokens-off)
    echo "tokens:\$(keepawake_status_tokens)"
    grc=0
    ;;
esac

# --- report ----------------------------------------------------------------
rec=NONE; [ -f "\$KEEPAWAKE_RC_FILE" ] && rec="\$(cat "\$KEEPAWAKE_RC_FILE")"
stamp=no; [ -f "\$KEEPAWAKE_STAMP" ] && stamp=yes
retry=no; [ -f "\$KEEPAWAKE_UNREACH_STAMP" ] && retry=yes
echo "rc=\${grc:-?} record=\${rec%% *} stamp=\$stamp retry=\$retry hits=\$(tr '\n' ',' < "\$CURL_HITS")"
echo "attemptstart:"
cat "\$KEEPAWAKE_LOG" 2>/dev/null || true
echo "attemptend:"
echo "curlstart:"
cat "\$CURL_CALLS"
echo "curlend:"
echo "logstart:"
cat "\$LOGLINES"
echo "logend:"
rm -rf "\$WORK"
INNER
  timeout 120 bash "$inner"
  rm -f "$inner"
}

r1()      { printf '%s\n' "$1" | sed -n 1p; }
field()   { printf '%s' "$1" | sed -n "s/.*\\b$2=\\([^ ]*\\).*/\\1/p"; }
attempts(){ printf '%s\n' "$1" | sed -n '/^attemptstart:$/,/^attemptend:$/p' | sed '1d;$d'; }
curlargv(){ printf '%s\n' "$1" | sed -n '/^curlstart:$/,/^curlend:$/p' | sed '1d;$d'; }
logs()    { printf '%s\n' "$1" | sed -n '/^logstart:$/,/^logend:$/p' | sed '1d;$d'; }

# ===========================================================================
# (1) THE FIRE. One idle /health, then a busy one, so the guard fires and sees
# the turn start. The assertions are on the REQUEST itself, because that is the
# contract with the gateway and every part of it was learned the hard way:
#   * agentId is the activeAgentId from THIS tick's /health   [mutant m4: a
#     hard-coded uuid — the gateway restarts and the id changes]
#   * Authorization: Bearer <token from the discovery file>
#   * NO Origin header                     [mutant m1: the gateway 403s one]
#   * the exact prompt and directAddressedAcceptance:true
# ===========================================================================
o="$(run_case "$(h_idle 1000)
$(h_busy 2000)" guard)"
argv="$(curlargv "$o")"
body="$(printf '%s\n' "$argv" | grep '"agentId"' | head -1)"
if [ "$(field "$(r1 "$o")" record)" = ok ] \
   && printf '%s\n' "$argv" | grep -qx "Authorization: Bearer $TOKEN" \
   && ! printf '%s\n' "$argv" | grep -qi '^Origin:' \
   && printf '%s\n' "$argv" | grep -qx 'content-type: application/json' \
   && printf '%s\n' "$argv" | grep -qx 'POST' \
   && [ "$body" = "{\"agentId\":\"$AGENT\",\"prompt\":\"Reply with only the word: ok\",\"directAddressedAcceptance\":true}" ] \
   && printf '%s\n' "$(logs "$o")" | grep -q 'keepawake: fired ok'; then
  pass "(1) fire: exact body, agentId from /health, Bearer from the discovery file, NO Origin  [mutants m1, m4]"
else
  bad  "(1) request wrong: [$(r1 "$o")] body=[$body] argv=[$(printf '%s' "$argv" | tr '\n' ' ')]"
fi

# ===========================================================================
# (2) MUTANT m2. A genuinely running turn (isBusy true, NOT awaiting approval)
# already refreshed the platform's idle clock, so firing beside it would spend a
# model turn for nothing. No sendPrompt call, the cadence stamp still advances
# (the guard did its thinking for this window), and the outcome is `skip`.
# ===========================================================================
o="$(run_case "$(h_busy 3000)" guard)"
if [ "$(field "$(r1 "$o")" record)" = skip ] \
   && [ "$(field "$(r1 "$o")" stamp)" = yes ] \
   && ! printf '%s\n' "$(r1 "$o")" | grep -q 'send' \
   && printf '%s\n' "$(logs "$o")" | grep -q 'keepawake: skip busy'; then
  pass "(2) isBusy && !busyOnlyAwaitingApproval => no sendPrompt, stamp advanced, rc=skip  [mutant m2]"
else
  bad  "(2) busy skip wrong: [$(r1 "$o")] log=[$(logs "$o")]"
fi

# ===========================================================================
# (3) MUTANT m3, AND THE MOTIVATING CASE. A turn parked on an approval widget
# sets busyOnlyAwaitingApproval and does NOT refresh lastBusyAtMs — so the box
# is sliding toward a pause while looking busy. The guard must FIRE into it
# (treating it as busy is mutant m3) and then report which of two things
# happened. Here lastBusyAtMs never moves: parked-blocked, plus the once-an-hour
# operator WARN. The second fire inside the hour must NOT repeat the WARN.
# ===========================================================================
o="$(run_case "$(h_parked 4000)" parked-warn-twice)"
warns="$(printf '%s\n' "$(logs "$o")" | grep -c 'check: WARN keepawake: agent has a parked approval widget')"
if [ "$(field "$(r1 "$o")" record)" = parked-blocked ] \
   && printf '%s\n' "$(r1 "$o")" | grep -q 'send' \
   && [ "$warns" = 1 ] \
   && [ "$(attempts "$o" | grep -c 'rc=parked-blocked')" = 2 ] \
   && printf '%s\n' "$(logs "$o")" | grep -q 'clock NOT refreshed — parked approval blocks keep-awake'; then
  pass "(3) parked + static clock => it FIRES, rc=parked-blocked, WARN exactly once an hour  [mutant m3]"
else
  bad  "(3) parked-blocked wrong: [$(r1 "$o")] warns=$warns attempts=[$(attempts "$o")]"
fi

# ===========================================================================
# (3b) The same parked entry, but lastBusyAtMs ADVANCES in the follow-up reads:
# the new turn ran beside the parked one and refreshed the idle clock. That is
# parked-ok, and there must be no operator WARN — nothing is wrong.
# ===========================================================================
o="$(run_case "$(h_parked 4000)
$(h_parked 9999)" guard)"
if [ "$(field "$(r1 "$o")" record)" = parked-ok ] \
   && ! printf '%s\n' "$(logs "$o")" | grep -q 'check: WARN keepawake' \
   && printf '%s\n' "$(logs "$o")" | grep -q 'fired through parked approval — clock refreshed' \
   && attempts "$o" | grep -q 'rc=parked-ok before=4000 after=9999'; then
  pass "(3b) parked + advancing clock => rc=parked-ok, no WARN, before/after both recorded"
else
  bad  "(3b) parked-ok wrong: [$(r1 "$o")] attempts=[$(attempts "$o")] log=[$(logs "$o")]"
fi

# ===========================================================================
# (3c) The r1 empirical gate's finding 3. lastBusyAtMs is a wall-clock stamp on
# the gateway's side and it can go BACKWARDS — a gateway restart re-initialises
# it, and these boxes take real time jumps, which is the very thing the feature
# measures. A clock that moved from 4000 to 3000 did NOT get refreshed by our
# turn, so this must be parked-blocked. Testing `!=` instead of `>` reports it as
# parked-ok: a false success in exactly the path the feature exists to diagnose.
# ===========================================================================
o="$(run_case "$(h_parked 4000)
$(h_parked 3000)" guard)"
if [ "$(field "$(r1 "$o")" record)" = parked-blocked ] \
   && attempts "$o" | grep -q 'rc=parked-blocked before=4000 after=3000' \
   && printf '%s\n' "$(logs "$o")" | grep -q 'clock NOT refreshed'; then
  pass "(3c) a lastBusyAtMs that moved BACKWARDS is parked-blocked, not parked-ok  [mutant m16]"
else
  bad  "(3c) a regressed clock was read as a refresh: [$(r1 "$o")] attempts=[$(attempts "$o")]"
fi

# ===========================================================================
# (4) MUTANTS m5 and m6. curl exits 7 (connection refused): the tick must NOT
# fail (m5), the MAIN cadence stamp must NOT advance (m6 — otherwise a gateway
# that was down for one tick costs a whole 20-minute window), and the DEDICATED
# retry stamp must. The attempt line is `before=- after=-`, because nothing was
# read: a skipped measurement that silently vanished would corrupt the
# experiment's denominator.
# ===========================================================================
o="$(run_case "$(h_idle 1000)" guard "" '{"accepted":true}' 0 7)"
if [ "$(field "$(r1 "$o")" rc)" = 0 ] \
   && [ "$(field "$(r1 "$o")" record)" = unreachable ] \
   && [ "$(field "$(r1 "$o")" stamp)" = no ] \
   && [ "$(field "$(r1 "$o")" retry)" = yes ] \
   && attempts "$o" | grep -q 'rc=unreachable before=- after=-' \
   && printf '%s\n' "$(logs "$o")" | grep -q 'keepawake: gateway unreachable'; then
  pass "(4) unreachable => rc 0, MAIN stamp untouched, retry stamp set, 'before=- after=-'  [mutants m5, m6]"
else
  bad  "(4) unreachable handling wrong: [$(r1 "$o")] attempts=[$(attempts "$o")]"
fi

# ===========================================================================
# (4b) MUTANT m6b, the retry floor itself. Without it, an unreachable gateway
# is retried every tick — 240 requests an hour instead of 40 — because the main
# stamp is deliberately not advanced. A tick 15 s after an unreachable one must
# make NO curl call; a tick 91 s after one must.
# ===========================================================================
o="$(run_case "$(h_idle 1000)" unreachable-floor-15s "" '{"accepted":true}' 0 7)"
after_mark="$(printf '%s' "$(field "$(r1 "$o")" hits)" | sed 's/.*--MARK--,//')"
if [ -z "$after_mark" ]; then
  pass "(4b-i) a tick 15 s after an unreachable one makes NO curl call (inside the 90 s floor)  [mutant m6b]"
else
  bad  "(4b-i) the floor did not hold: hits after the mark = [$after_mark]"
fi
o="$(run_case "$(h_idle 1000)" unreachable-floor-91s "" '{"accepted":true}' 0 7)"
after_mark="$(printf '%s' "$(field "$(r1 "$o")" hits)" | sed 's/.*--MARK--,//')"
if printf '%s' "$after_mark" | grep -q health; then
  pass "(4b-ii) a tick 91 s after an unreachable one DOES retry"
else
  bad  "(4b-ii) the retry never came back: hits after the mark = [$after_mark]"
fi
o="$(run_case "$(h_idle 1000)" unreachable-ten "" '{"accepted":true}' 0 7)"
if [ "$(attempts "$o" | grep -c 'rc=unreachable')" = 10 ] \
   && [ "$(printf '%s\n' "$(logs "$o")" | grep -c 'keepawake: gateway unreachable')" = 1 ]; then
  pass "(4b-iii) ten unreachable ticks => TEN attempt lines but ONE log line (hourly gate)"
else
  bad  "(4b-iii) wrong line counts: attempts=$(attempts "$o" | grep -c 'rc=unreachable') logs=$(printf '%s\n' "$(logs "$o")" | grep -c 'gateway unreachable')"
fi

# ===========================================================================
# (5) The cadence. A stamp 60 s old with a 20-minute interval means the guard
# returns before reading anything at all — not even /health. An idle tick has to
# be free, because it runs every 15 s.
# ===========================================================================
o="$(run_case "$(h_idle 1000)" young-stamp)"
if [ -z "$(field "$(r1 "$o")" hits)" ] && [ "$(field "$(r1 "$o")" record)" = NONE ] \
   && [ -z "$(attempts "$o")" ]; then
  pass "(5) stamp younger than interval_min => no curl, no attempt line, no state change"
else
  bad  "(5) the cadence stamp did not gate the tick: [$(r1 "$o")]"
fi

# ===========================================================================
# (6) OFF. interval_min = 0 is the ABANDON setting the experiment can reach, and
# it must cost exactly nothing: no /health, no fire, no attempt line — just one
# breadcrumb an hour so an operator can tell "configured off" from "broken".
# ===========================================================================
o="$(run_case "$(h_idle 1000)" off-twice 0)"
if [ -z "$(field "$(r1 "$o")" hits)" ] \
   && [ -z "$(attempts "$o")" ] \
   && [ "$(printf '%s\n' "$(logs "$o")" | grep -c 'keepawake: off')" = 1 ]; then
  pass "(6) interval_min=0 => nothing called, no attempt lines, ONE 'off' line an hour"
else
  bad  "(6) off is not a no-op: [$(r1 "$o")] log=[$(logs "$o")]"
fi
# and the floor: 1..9 is raised to 10, so a fat-fingered interval cannot cost
# 1440 model turns a day.
o="$(run_case "$(h_idle 1000)
$(h_busy 2000)" tokens 3)"
if printf '%s\n' "$o" | grep -q 'tokens:keepawake=on'; then
  pass "(6b) interval_min=3 is accepted as ON (raised to the 10-minute floor)"
else
  bad  "(6b) sub-floor interval did not stay on: [$o]"
fi

# ===========================================================================
# (7) MUTANT m7. `jumps` is the experiment's numerator and it MUST be relative
# to a per-install baseline: without the subtraction a box that has slept eight
# times in its life reports eight jumps the moment 5.4.0 lands. The baseline is
# written once by converge and never rewritten, or every rollout would silently
# reset the count.
# ===========================================================================
o="$(run_case "$(h_idle 1000)" baseline)"
bl="$(printf '%s\n' "$o" | grep '^baseline1=')"
if printf '%s' "$bl" | grep -q 'baseline1=3 baseline2=3 raw=5 jumps=2'; then
  pass "(7) baseline written ONCE at converge (3), never rewritten, jumps = 5 - 3 = 2  [mutant m7]"
else
  bad  "(7) baseline arithmetic wrong: [$bl]"
fi

# ===========================================================================
# (8) The four status tokens (K4), on the REAL print_status. Same technique and
# the same stub world as test-boxup-disk-guard.sh's (b1)/(b2): everything else
# on the line is healthy, so the keepawake tokens are the only thing under test.
# They sit AFTER disk=, which is what keeps every existing reader unmoved.
# ===========================================================================
status_line() {
  local interval="$1" inner
  inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
WORK="\$(mktemp -d)"
RUN_DIR="\$WORK/run"; mkdir -p "\$RUN_DIR"
LOGLINES="\$WORK/log"; : > "\$LOGLINES"
BIN="\$WORK/bin"; mkdir -p "\$BIN"
printf '#!/bin/sh\necho "Use%%"\nprintf " 22%%%%\\\\n"\n' > "\$BIN/df"; chmod +x "\$BIN/df"
PATH="\$BIN:\$PATH"
printf '1\n' > "\$WORK/ipv4_fwd"; printf '1\n' > "\$WORK/ipv6_fwd"

BOXUP_VERSION=test
ROOT="\$WORK/root"; mkdir -p "\$ROOT"
STATE_DIR="\$ROOT/state/tailscale"
AUTHKEY_EXPIRES="\$ROOT/secrets/ts-authkey.expires"
WORKER_PID="\$RUN_DIR/worker.pid"
FREEZE_SECS=60
DISK_STATE="\$RUN_DIR/disk"; DISK_STAMP="\$RUN_DIR/last-disk-guard"
DISK_WARN_STAMP="\$RUN_DIR/last-disk-warn"
BOXUP_DISK_WARN_PCT=80; BOXUP_DISK_FAIL_PCT=90
BOXUP_DISK_TRUNCATE_MIN_BYTES=1048576; DISK_GUARD_TRUNCATE="\$WORK/nothing.log"
KEEPAWAKE_DEFAULT_MIN=20; KEEPAWAKE_FLOOR_MIN=10
KEEPAWAKE_RC_FILE="\$RUN_DIR/keepawake"
KEEPAWAKE_BASELINE="\$WORK/baseline"
TAILSCALED_LOG="\$WORK/tailscaled.log"
printf '2026/09/01 00:00:01 monitor: time jump detected\n' > "\$TAILSCALED_LOG"
printf '2026/09/02 00:00:01 monitor: time jump detected\n' >> "\$TAILSCALED_LOG"
printf '2026/09/03 00:00:01 monitor: time jump detected\n' >> "\$TAILSCALED_LOG"
echo 1 > "\$KEEPAWAKE_BASELINE"
echo "ok 1788382445" > "\$KEEPAWAKE_RC_FILE"

INTERVAL_CFG='$interval'
config_get(){
  if [ "\$1" = keepawake ] && [ "\$2" = interval_min ] && [ -n "\$INTERVAL_CFG" ]; then
    printf '%s\n' "\$INTERVAL_CFG"; return 0
  fi
  return 1
}
log(){ printf '%s\n' "\$*" >> "\$LOGLINES"; }
have(){ command -v "\$1" >/dev/null 2>&1; }
read_ts_fields(){ backend=Running; online=yes; exitn=yes; ts_tags="tag:grok-box"; ts_keyexpiry=""; mapfail=0; }
read_box_name(){ echo grok-box-008; }
boxup_git_sha(){ echo abc1234; }
authkey_expiry_state(){ echo ok; }
tunnel_state(){ echo up; }
# grokfleet-jobs J9 appended two more tokens after the keepawake four. They are
# not this suite's concern, so they are stubbed exactly like tunnel_state above;
# tests/test-boxup-jobs.sh (case 12) owns their content.
jobs_status_tokens(){ printf 'job=- job_state=-'; }
bash -c 'sleep 300; :' _ tailscaled --statedir "\$STATE_DIR" </dev/null >/dev/null 2>&1 &
wpid=\$!; echo "\$wpid" > "\$WORKER_PID"
date +%s > "\$RUN_DIR/hb"
pgrep(){ case "\$*" in *sshd*) echo 4242 ;; *tailscaled*) echo "\$wpid" ;; *) return 1 ;; esac; }

extract_fn_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in disk_used_pct disk_level disk_status_token refresh_fail_count \\
          repair_fail_count tunnel_fail_count keepawake_interval_min \\
          keepawake_jumps_raw keepawake_jumps keepawake_status_tokens \\
          print_status; do
  eval "\$(extract_fn_from "\$BOXUP" "\$fn")"
done
print_status
command kill -9 "\$wpid" 2>/dev/null || true
rm -rf "\$WORK"
INNER
  timeout 60 bash "$inner" 2>/dev/null
  rm -f "$inner"
}
line="$(status_line 20 | sed -n 1p)"
if printf '%s\n' "$line" | grep -Eq ' disk=22% keepawake=on keepawake_last=2026-[0-9-]+T[0-9:]+Z keepawake_rc=ok jumps=2 job=- job_state=-$'; then
  pass "(8) status: the four keepawake tokens follow disk=, jumps is baseline-subtracted (3-1=2)"
else
  bad  "(8) status tokens missing/misplaced: [$line]"
fi
line="$(status_line 0 | sed -n 1p)"
if printf '%s\n' "$line" | grep -q ' keepawake=off '; then
  pass "(8b) status: interval_min=0 shows keepawake=off"
else
  bad  "(8b) off not reflected in the status line: [$line]"
fi

# ===========================================================================
# (9) MUTANT m8. The gateway ACCEPTED the prompt but no turn ever appeared —
# `isBusy` stays false for the whole 10 s watch. That is `inert`, NOT `ok`:
# reporting it as ok would put a window where nothing ran into the experiment's
# EXERCISED denominator and quietly bias the verdict toward KEEP.
# ===========================================================================
o="$(run_case "$(h_idle 1000)" guard)"
if [ "$(field "$(r1 "$o")" record)" = inert ] \
   && attempts "$o" | grep -q 'rc=inert' \
   && printf '%s\n' "$(logs "$o")" | grep -q 'fired but not busy after 10 s'; then
  pass "(9) accepted but never busy => rc=inert (NOT ok)  [mutant m8]"
else
  bad  "(9) inert not reported: [$(r1 "$o")] attempts=[$(attempts "$o")]"
fi

# ===========================================================================
# (10) MUTANT m9. A refusal — an HTTP error or a body without "accepted":true —
# is `refused`, and the MAIN stamp still advances so a sick gateway is not
# hammered every 15 s. Both refusal shapes are checked.
# ===========================================================================
o="$(run_case "$(h_idle 1000)" guard "" '{"accepted":false,"reason":"no such agent"}')"
if [ "$(field "$(r1 "$o")" record)" = refused ] \
   && [ "$(field "$(r1 "$o")" stamp)" = yes ] \
   && attempts "$o" | grep -q 'rc=refused before=1000 after=-'; then
  pass "(10a) \"accepted\":false => rc=refused, main stamp advanced (no tight retry)  [mutant m9]"
else
  bad  "(10a) accepted:false not refused: [$(r1 "$o")] attempts=[$(attempts "$o")]"
fi
o="$(run_case "$(h_idle 1000)" guard "" '' 22)"
if [ "$(field "$(r1 "$o")" record)" = refused ] && [ "$(field "$(r1 "$o")" rc)" = 0 ]; then
  pass "(10b) an HTTP failure (curl rc 22 => 500) is also rc=refused, and the tick still returns 0"
else
  bad  "(10b) curl failure on the send not handled: [$(r1 "$o")]"
fi

# ===========================================================================
# (11) MUTANT m10. THE MEASUREMENT INVARIANT: every outcome appends EXACTLY ONE
# rc= line, skips and unreachables included. The attempt log is the denominator
# of the whole experiment — an unlogged skip is not a saving, it is a slot the
# readout would count as `missing` and therefore as evidence of a sleep that
# never happened.
# ===========================================================================
miss=""
check_one_line() {
  local seq="$1" scen="$2" want="$3" interval="${4:-}" reply="${5:-\{\"accepted\":true\}}" \
        sendrc="${6:-0}" hf="${7:-}" out n
  out="$(run_case "$seq" "$scen" "$interval" "$reply" "$sendrc" "$hf")"
  n="$(attempts "$out" | grep -c "rc=$want ")"
  [ "$n" = 1 ] || miss="$miss $want(n=$n)"
  attempts "$out" | grep -q "^[0-9-]\{10\}T[0-9:]\{8\}Z rc=$want before=[0-9-]* after=[0-9-]*$" \
    || miss="$miss $want(format)"
}
check_one_line "$(h_idle 1000)
$(h_busy 2000)" guard ok
check_one_line "$(h_idle 1000)" guard inert
check_one_line "$(h_busy 3000)" guard skip
check_one_line "$(h_idle 1000)" guard refused "" '{"accepted":false}'
check_one_line "$(h_idle 1000)" guard unreachable "" '{"accepted":true}' 0 7
check_one_line "$(h_parked 4000)" guard parked-blocked
check_one_line "$(h_parked 4000)
$(h_parked 8000)" guard parked-ok
if [ -z "$miss" ]; then
  pass "(11) all seven outcomes append exactly one well-formed rc= line — skips and unreachables included  [mutant m10]"
else
  bad  "(11) attempt-log lines wrong for:$miss"
fi

# ===========================================================================
# (12) THE READOUT (acceptance 3). Fixture days built to the blueprint, driving
# tests/keepawake-readout.sh. The classifier is a TOTAL ORDERED function and
# two of these fixtures exist only to pin the ORDER:
#   * 20 inert + 52 ok is `defect`, not `exercised` — rule 2 before rule 3
#     [mutant m12 reverses them and this day lands in the denominator]
#   * 36 ok + 36 skip is `exercised`, not `activity` — rule 3 before rule 4
# and two pin the treatment of ABSENT slots:
#   * 40 ok with 32 slots absent is STILL exercised (the box fired all day and
#     slept anyway — the most abandon-ward evidence there is)
#   * 20 ok with 52 absent is unclassified   [mutant m13 counts a missing slot
#     as ok and flips this to exercised]
# Finally, only exercised days are in the denominator: the jump on the activity
# day must NOT be counted [mutant m11 counts every box-day carrying 5.4.0].
# ===========================================================================
FIX="$(mktemp -d)"
mkfixture() {
  # mkfixture <box> <day> <count:rc> ...  — lines are laid on 20-minute slots
  # from 00:00Z, in order, so `40 ok` occupies the day's first 40 slots and the
  # remaining 32 are absent exactly as a paused box would leave them.
  local box="$1" day="$2"; shift 2
  local dir="$FIX/$box" slot=0 spec n rc h m
  mkdir -p "$dir"
  for spec in "$@"; do
    n="${spec%%:*}"; rc="${spec##*:}"
    while [ "$n" -gt 0 ]; do
      h=$(( (slot * 20) / 60 )); m=$(( (slot * 20) % 60 ))
      printf '%s rc=%s before=1000 after=2000\n' \
        "$(printf '%sT%02d:%02d:05Z' "$day" "$h" "$m")" "$rc" >> "$dir/boxup-keepawake.log"
      slot=$((slot + 1)); n=$((n - 1))
    done
  done
}
mkjump() { printf '%s 01:09:53 monitor: time jump detected\n' "$(printf '%s' "$2" | tr - /)" >> "$FIX/$1/tailscaled.log"; }

mkfixture b1 2026-09-03 72:ok                                   # => exercised
mkfixture b2 2026-09-03 40:skip 32:ok                           # => activity
mkfixture b3 2026-09-03 20:inert 52:ok                          # => defect
mkfixture b4 2026-09-03 36:ok 36:skip                           # => exercised
mkfixture b5 2026-09-03 20:ok 20:skip 10:inert 22:unreachable   # => unclassified
mkfixture b6 2026-09-03 40:ok                                   # => exercised (32 absent)
mkfixture b7 2026-09-03 20:ok                                   # => unclassified (52 absent)
# b8: two sparse days with a completely ABSENT day between them. 2026-09-04 has
# no attempt line at all, which is the ONLY shape an `off` day can legitimately
# take — an off guard writes nothing.
mkfixture b8 2026-09-03 5:ok                                    # => unclassified
mkfixture b8 2026-09-05 5:ok                                    # => unclassified
printf '2026-09-04\n' > "$FIX/b8/off-days"
# b9: a whole day of parked-blocked fires. The r1 empirical gate found the
# readout DROPPED this token outright — no row, no warning, rc 0 — so a real
# box-day of blocked fires vanished from the evidence entirely.
mkfixture b9 2026-09-03 72:parked-blocked                       # => unclassified
# an unreachable line in its real `before=- after=-` shape must parse too
printf '2026-09-03T23:50:05Z rc=unreachable before=- after=-\n' >> "$FIX/b5/boxup-keepawake.log"
mkjump b1 2026-09-03    # exercised day  => IN the numerator
mkjump b2 2026-09-03    # activity day   => NOT in the numerator
mkjump b6 2026-09-03    # exercised day (with absent slots) => IN

ro="$(bash "$READOUT" "$FIX" 2>/dev/null)"
cls() { printf '%s\n' "$ro" | awk -v b="$1" '$1 == b { print $NF }'; }
want=""
[ "$(cls b1)" = exercised    ] || want="$want b1=$(cls b1)"
[ "$(cls b2)" = activity     ] || want="$want b2=$(cls b2)"
[ "$(cls b3)" = defect       ] || want="$want b3=$(cls b3)"
[ "$(cls b4)" = exercised    ] || want="$want b4=$(cls b4)"
[ "$(cls b5)" = unclassified ] || want="$want b5=$(cls b5)"
[ "$(cls b6)" = exercised    ] || want="$want b6=$(cls b6)"
[ "$(cls b7)" = unclassified ] || want="$want b7=$(cls b7)"
[ "$(cls b9)" = unclassified ] || want="$want b9=$(cls b9)"
if [ -z "$want" ]; then
  pass "(12a) the seven fixture days classify exactly as the blueprint states  [mutants m12, m13]"
else
  bad  "(12a) misclassified:$want"
fi
if printf '%s\n' "$ro" | grep -q 'exercised box-days: 3  (boxes: 3)' \
   && printf '%s\n' "$ro" | grep -q 'jumps in exercised days: 2'; then
  pass "(12b) only exercised days are in the denominator; the activity day's jump is excluded  [mutant m11]"
else
  bad  "(12b) denominator/numerator wrong: [$(printf '%s\n' "$ro" | grep -E 'exercised box-days|jumps in')]"
fi
# NOTE the row-existence guard on this and (12f): `awk '$1 == "b6" {...}'` on a
# table with NO b6 row matches nothing and exits 0, so the assertion would pass
# vacuously exactly when the readout had dropped the box entirely. That is not
# hypothetical — it is how mutant m14 first slipped past (12f).
b6row="$(printf '%s\n' "$ro" | grep '^b6 ' || true)"
if [ -n "$b6row" ] && printf '%s\n' "$b6row" | awk '{ exit !($11 == 32 && $4 == 40) }'; then
  pass "(12c) absent slots are counted as missing (b6: 40 ok, 32 missing) and the day still counts"
else
  bad  "(12c) missing-slot accounting wrong: [${b6row:-NO-ROW}]"
fi
if printf '%s\n' "$ro" | grep -q 'verdict: INSUFFICIENT'; then
  pass "(12d) 3 exercised box-days is below the 20-day / 5-box floor => INSUFFICIENT, no verdict"
else
  bad  "(12d) a verdict was issued on 3 box-days: [$(printf '%s\n' "$ro" | grep verdict)]"
fi
# ---------------------------------------------------------------------------
# (12f) THE r1 EMPIRICAL GATE'S FINDING 1. Every one of the seven rc tokens must
# be counted and must reach the table. `parked-blocked` was missing from the
# readout's rank function, so a day of blocked fires was rejected as an unknown
# outcome and disappeared: no row, no warning, rc 0, zero days — a real box-day
# of evidence deleted. It must appear, with its 72 slots accounted for, and it
# must NOT be exercised (the fire was accepted but the idle clock never moved).
# ---------------------------------------------------------------------------
b9row="$(printf '%s\n' "$ro" | grep '^b9 ' || true)"
if [ -n "$b9row" ] && printf '%s\n' "$b9row" | awk '{ exit !($10 == 72 && $11 == 0 && $NF == "unclassified") }'; then
  pass "(12f) parked-blocked lines are counted, land in the table, and are NOT exercised  [mutant m14]"
else
  bad  "(12f) parked-blocked dropped or miscounted: [${b9row:-NO-ROW}]"
fi
# the memo's exact repro: a log holding ONE parked-blocked line must still row.
SOLO="$(mktemp -d)"; mkdir -p "$SOLO/solo"
printf '2026-09-03T04:20:11Z rc=parked-blocked before=1000 after=1000\n' > "$SOLO/solo/boxup-keepawake.log"
if [ "$(bash "$READOUT" "$SOLO" 2>/dev/null | awk '$1 == "solo" { print $10 }')" = 1 ]; then
  pass "(12f-ii) a log of a SINGLE parked-blocked line still produces a box-day row"
else
  bad  "(12f-ii) a lone parked-blocked line produced no row: [$(bash "$READOUT" "$SOLO" 2>&1 | tail -3)]"
fi
rm -rf "$SOLO"

# ---------------------------------------------------------------------------
# (12e) THE r1 EMPIRICAL GATE'S FINDING 2. `off-days` is the one input the
# readout cannot derive, and it is operator-supplied, so it is checked against
# the evidence instead of trusted over it. A day the box recorded attempts on
# was NOT off, and letting the input win there would let a hand-written date
# delete a real — possibly abandon-ward — box-day from the denominator.
#   (i)  a day WITH attempts listed as off => the whole run is REFUSED, rc 3,
#        no table and no verdict
#   (ii) a day with NO attempt lines at all => off, as rule 1 intends
# ---------------------------------------------------------------------------
if [ "$(printf '%s\n' "$ro" | awk '$1 == "b8" && $2 == "2026-09-04" { print $NF }')" = off ]; then
  pass "(12e-i) a fully ABSENT day listed in off-days classifies as off (rule 1)"
else
  bad  "(12e-i) an absent off-day was not honoured: [$(printf '%s\n' "$ro" | grep '^b8')]"
fi
printf 'all\n' > "$FIX/b7/off-days"
ro2="$(bash "$READOUT" "$FIX" 2>"$FIX/err")"; rc2=$?
if [ "$rc2" = 3 ] \
   && grep -q 'REFUSED off-days for b7 2026-09-03: the day has 20 attempt line(s)' "$FIX/err" \
   && ! printf '%s\n' "$ro2" | grep -q 'verdict:'; then
  pass "(12e-ii) off-days on a day WITH attempts is refused (rc 3, no table, no verdict)  [mutant m15]"
else
  bad  "(12e-ii) an off-days conflict was applied instead of refused: rc=$rc2 err=[$(cat "$FIX/err")]"
fi
rm -rf "$FIX"

# ===========================================================================
# (13) The wiring. Like the disk guard, keepawake_guard runs from run_tick
# OUTSIDE the converge lock — a tick that skips on lock contention must still
# keep the box awake, since a converge that takes twenty minutes is exactly when
# the box would otherwise be pausing.
# ===========================================================================
rt="$(awk '/^run_tick\(\) \{/{i=1} i{print} i&&/^\}$/{exit}' "$BOXUP")"
if printf '%s\n' "$rt" | grep -q 'keepawake_guard' \
   && [ "$(printf '%s\n' "$rt" | grep -n 'keepawake_guard' | head -1 | cut -d: -f1)" -lt \
        "$(printf '%s\n' "$rt" | grep -n 'run_with_converge_lock' | head -1 | cut -d: -f1)" ]; then
  pass "(13) run_tick calls keepawake_guard BEFORE (and outside) the converge lock"
else
  bad  "(13) keepawake_guard is not wired into run_tick ahead of the lock"
fi
# and converge writes the baseline, so a box that never fires still has one.
eb="$(awk '/^do_ensure_body\(\) \{/{i=1} i{print} i&&/^\}$/{exit}' "$BOXUP")"
if printf '%s\n' "$eb" | grep -q 'keepawake_converge'; then
  pass "(13b) do_ensure_body runs keepawake_converge (the jumps baseline)"
else
  bad  "(13b) converge does not write the keepawake baseline"
fi

# ===========================================================================
# (14) The two K6 seams survive the sudo re-exec. `boxup once` needs root, so a
# non-root invocation re-execs itself under `sudo env …` with an EXPLICIT
# variable list, and anything not on that list is silently dropped. The r1 gate
# of the disk guard found exactly that hole for the disk knobs; the same hole
# would aim a gate's canary run back at the REAL gateway while looking like it
# worked. Drives the REAL require_root with a fake `sudo` that prints its argv.
# ===========================================================================
reexec_argv() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
W="\$(mktemp -d)"; BIN="\$W/bin"; mkdir -p "\$BIN"
printf '#!/bin/sh\nprintf "%%s\\n" "\$@"\n' > "\$BIN/sudo"
chmod +x "\$BIN/sudo"
PATH="\$BIN:\$PATH"
ROOT="\$W/box-setup"; SELF="\$W/boxup"
BOXUP_DISK_WARN_PCT=80; BOXUP_DISK_FAIL_PCT=90
BOXUP_DISK_TRUNCATE_MIN_BYTES=1; BOXUP_DISK_INTERVAL=60
DISK_GUARD_TRUNCATE=/tmp/x.log
BOXUP_GATEWAY_URL=http://127.0.0.1:9999
BOXUP_GATEWAY_JSON=/tmp/canary-gateway.json
log(){ :; }
have(){ command -v "\$1" >/dev/null 2>&1; }
id(){ case "\$*" in "-u") echo 1000 ;; *) command id "\$@" ;; esac; }
eval "\$(awk '/^require_root\(\) \{/{i=1} i{print} i&&/^\}\$/{exit}' "$BOXUP")"
( require_root once )
rm -rf "\$W"
INNER
  timeout 30 bash "$inner"
  rm -f "$inner"
}
argv="$(reexec_argv)"
missing=""
for kv in BOXUP_GATEWAY_URL=http://127.0.0.1:9999 BOXUP_GATEWAY_JSON=/tmp/canary-gateway.json; do
  printf '%s\n' "$argv" | grep -qx "$kv" || missing="$missing $kv"
done
if [ -z "$missing" ]; then
  pass "(14) require_root forwards BOXUP_GATEWAY_URL/BOXUP_GATEWAY_JSON across the sudo re-exec"
else
  bad  "(14) gateway seams LOST at the sudo re-exec:$missing — argv was: [$(printf '%s' "$argv" | tr '\n' ' ')]"
fi

echo
[ "$fail" = 0 ] && echo "ALL PASS (test-boxup-keepawake.sh)" || echo "FAILURES (test-boxup-keepawake.sh)"
exit "$fail"
