#!/bin/bash
# test-boxup-jobs.sh — box-free coverage for boxup 5.5.0's job runner
# (blueprint grokfleet-jobs, J1/J2/J6/J9, cases (1)-(13)).
# Run from anywhere:  bash tests/test-boxup-jobs.sh   (or: make test)
# Exit 0 = all pass, 1 = a failure. Needs no root, no network and no box, and
# touches nothing outside its own mktemp dirs.
#
# Everything below drives the REAL functions extracted out of the repo-root
# `boxup` — no reimplementation — in the shape tests/test-boxup-disk-guard.sh
# established and tests/test-boxup-keepawake.sh extended. What is stubbed is
# environment, never logic:
#
#   * BOX_SETUP_JOBS / BOX_SETUP_RUN point the durable record tree and the
#     ephemeral run dir at mktemp paths. They are the documented seams (boxup
#     forwards both across its sudo re-exec), and pointing them at a scratch
#     tree is what lets the REAL `bash boxup job-wrapper <id>` run as the
#     detached child of the REAL spawn_detached. Nothing about the wrapper is
#     faked in the cases that exercise it.
#   * the job CONSTANTS are eval'd out of boxup rather than restated, so a
#     changed threshold or retention bound fails here instead of passing
#     silently. The ONE exception is JOBS_STOP_GRACE_S, lowered to 2 s so the
#     TERM->KILL case does not cost ten seconds; the ladder it drives is
#     otherwise the shipped one.
#   * `df` is a stub on PATH driven by a sequence file, exactly as the
#     disk-guard suite drives the pressure path.
#   * `kill` is a shell FUNCTION that records its argv and forwards to the real
#     one, so `stop`'s TERM-then-KILL sequence is directly observable.
#   * a fake `boxup` script (a real file whose basename is `boxup`) stands in
#     for the wrapper wherever a case needs a process with a specific argv or a
#     specific signal behaviour. Its cmdline is the genuine article — `bash
#     <path>/boxup job-wrapper <id>` — which is the whole point: the matcher
#     under test reads /proc/<pid>/cmdline and nothing else.
#
# Big logs are SPARSE (`truncate -s`), so the real 64 MiB and 1 GiB thresholds
# are exercised at their shipped values without writing 64 MiB anywhere.
#
# Cases, and the blueprint mutant each one kills:
#   (1)   start writes every record file and takes the slot; the real wrapper
#         runs the command, the log carries its output, rc/ended are recorded
#         and the slot is released
#   (2)   a second start while the first is live => rc 75          [mutant j1]
#   (3)   a stale slot whose job has no live wrapper is broken with a WARN and
#         the retry succeeds                                       [mutant j2]
#   (4)   `status` derives every state from the FILES: done / failed / timeout /
#         stopped / crashloop / running / lost:died / lost:image-swap, and a
#         MISSING rc file is never `done`                  [mutants j3, j15, j4]
#   (4b)  after a simulated swap (the run dir cleared) a live UNRELATED process
#         holding the recorded pgid number is not the job: `status` says
#         lost:image-swap and the keep-alive path restarts        [mutant j26]
#   (4c)  a live <id> wrapper with no marker => the marker is re-created from it
#         and no second instance is launched                      [mutant j27]
#   (4d)  with the marker absent and a live `boxup job status <id>` poll AND a
#         live `sh -c` child mentioning <id> in flight, the scan matches
#         neither, the restart proceeds, and the marker points at the NEW
#         wrapper                                            [mutants j28, j29]
#   (5)   a durable record with no rc and no marker => lost:image-swap; a stale
#         slot with a dead job is broken while a live one is not   [mutant j4]
#   (6)   keep-alive restart with the 20->60->180->600 backoff, and a service
#         gets NO wall-clock cap                             [mutants j5, j20]
#   (7)   5 restarts inside 10 min => rc=crashloop and the guard stops
#         restarting; 4 inside the window does not             [mutant j6]
#   (8)   stop sends TERM to the process GROUP, then KILL after the grace, and
#         records rc 143 / state stopped                          [mutant j7]
#   (9)   `log <id> <offset>` returns exactly the bytes from that offset, and
#         is bounded to 1 MiB per call                             [mutant j8]
#   (10)  a 64 MiB log is NOT truncated and 64 MiB + 1 IS, through
#         disk_truncate_one with the explicit 64 MiB floor; the counters move,
#         and a line written by the still-running wrapper AFTER the truncation
#         appears in `log` (the inherited descriptor survives)
#                                                     [mutants j9, j30, j36]
#   (10b) with the wrapper appending DURING the guard run, no line is split and
#         every line written after the truncation survives         [mutant j31]
#   (10c) `status` reports truncations / truncated_total, and both are exact
#         across two truncations                            [mutants j32, j34]
#   (10e) a job log replaced by a SYMLINK is refused by the mutator: the target
#         is untouched, the counters do not move, and a WARN is logged
#                                                                 [mutant j35]
#   (10f) with DISK_GUARD_TRUNCATE overridden to a list WITHOUT the job entry,
#         the 64 MiB bound still fires AND the pressure path still SELECTS and
#         reclaims a job log                          [mutants j38, j39, j40]
#   (10g) the tree is shellcheck-clean and (10f) still passes — i.e. the
#         suppression is present and the built-in expansion is unquoted
#   (11)  terminal records are pruned by AGE and by COUNT           [mutant j25]
#   (11b) under disk pressure disk_guard TRUNCATES a job log (the size after is
#         the assertion, not allowlist membership)
#   (12)  jobs_guard is wired into run_tick outside the converge lock, and runs
#         while that lock is held
#   (13)  no new setsid/nohup/disown outside spawn_detached, and the wrapper is
#         launched with its own argv shape rather than through a shell
#   (14)  5.5.1: after a simulated swap the guard restarts the service AND
#         re-takes the one-job slot, so the status tokens name it again and a
#         second start is refused rc 75                     [mutants s1, s2]
#   (14b) a restart never steals a slot another LIVE job holds: it is deferred
#         to a later tick and the refusal is logged          [mutants s3, s4]
#   (15)  5.5.2: driven through the REAL run_tick entry point the installed
#         worker calls, with the run dir ABSENT the way a swap leaves it, the
#         service restarts, the run dir and slot come back, and a second start
#         is refused                                    [mutants g1, g2, g4]
#   (15b) a tick that SKIPS on a contended converge lock has still supervised
#         jobs, because the guard runs before the lock          [mutant g3]
#   (15c) a slot path that cannot be created is reported as such (rc 2) and
#         blocks the restart, instead of being reported as contention
#                                                                [mutant g4]
#
# NOTE (blueprint (10d)): detecting a fast writer's regenerated log from the
# COUNTER rather than from sizes is a BRAIN-side property — the box's job is to
# report the counters, which (10c) pins. There is no box half to test.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
BOXUP="$ROOT/boxup"
fail=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; fail=1; }

[ -f "$BOXUP" ] || { echo "cannot find $BOXUP"; exit 1; }

# ---------------------------------------------------------------------------
# harness: build an inner script that points the two seams at a scratch tree,
# eval-extracts the REAL job + disk functions out of boxup, runs one scenario,
# and prints a flat result block.
#
# $1 = the scenario name (see the case block inside)
# $2 = the `df` percent sequence, one per line (the last repeats); may be empty
# $3 = DISK_GUARD_TRUNCATE for this scenario ("" => the shipped default)
#
# NB: the inner script below is written through an UNQUOTED heredoc, so the outer
# shell expands it. Backticks are command substitution even inside a comment —
# an unescaped `word` in prose runs `word`. Every $ that belongs to the inner
# script is escaped, and prose uses 'single quotes' rather than backticks.
# ---------------------------------------------------------------------------
run_case() {
  local scenario="$1" dfseq="${2:-}" dgt="${3:-}" inner rc
  inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
WORK="\$(mktemp -d)"
# Every process this scenario starts is DETACHED (that is the mechanism under
# test), so 'jobs -p' cannot see it. They are found instead by the seam they all
# inherit in their environment, and killed by process GROUP.
cleanup(){
  local d p pg mypg
  mypg=\$(ps -o pgid= -p \$\$ 2>/dev/null | tr -d ' ')
  for d in /proc/[0-9]*; do
    p="\${d##*/}"
    grep -qa "BOX_SETUP_JOBS=\$WORK/jobs" "\$d/environ" 2>/dev/null || continue
    pg=\$(ps -o pgid= -p "\$p" 2>/dev/null | tr -d ' ')
    # NEVER signal our OWN process group: that would kill this cleanup halfway
    # through and leave the rest of the scenario's processes alive to answer a
    # later scenario's /proc scan.
    if [ -n "\$pg" ] && [ "\$pg" != "\$mypg" ]; then
      command kill -9 -- "-\$pg" 2>/dev/null
    else
      command kill -9 "\$p" 2>/dev/null
    fi
  done
  command kill -9 \$(jobs -p) 2>/dev/null
  rm -rf "\$WORK"
}
trap cleanup EXIT

export BOX_SETUP_JOBS="\$WORK/jobs"
export BOX_SETUP_RUN="\$WORK/run"
RUN_DIR="\$WORK/run"
mkdir -p "\$RUN_DIR" "\$WORK/jobs" "\$WORK/bin" "\$WORK/fake"
LOGLINES="\$WORK/log"; : > "\$LOGLINES"
KILLS="\$WORK/kills"; : > "\$KILLS"
BIN="\$WORK/bin"

# --- the df stub (the disk-guard suite's technique) ------------------------
printf '%s\n' '$dfseq' > "\$WORK/dfseq"
export DF_SEQ="\$WORK/dfseq" DF_CUR="\$WORK/dfcur"
cat > "\$BIN/df" <<'DFEOF'
#!/bin/sh
i=\$(cat "\$DF_CUR" 2>/dev/null || echo 0); i=\$((i + 1)); echo "\$i" > "\$DF_CUR"
n=\$(wc -l < "\$DF_SEQ")
[ "\$i" -gt "\$n" ] && i="\$n"
v=\$(sed -n "\${i}p" "\$DF_SEQ")
[ "\$v" = broken ] && exit 1
echo 'Use%'; echo "\${v}%"
DFEOF
chmod +x "\$BIN/df"
PATH="\$BIN:\$PATH"

# --- the fake wrapper -------------------------------------------------------
# A REAL file called \`boxup\`, so a process running it has the genuine argv
# \`bash <path>/boxup job-wrapper <id>\` that is_job_wrapper_proc must match.
# WMODE picks its behaviour; WLOG (when set) is opened ONCE with >> so the
# inherited-O_APPEND property is the real one.
cat > "\$WORK/fake/boxup" <<'FAKEEOF'
#!/bin/bash
mode="\${WMODE:-idle}"
if [ -n "\${WLOG:-}" ]; then exec >> "\$WLOG" 2>&1; fi
case "\$mode" in
  notermi) trap '' TERM; while :; do sleep 0.2; done ;;
  after)   while [ ! -f "\$WGO" ]; do sleep 0.05; done
           echo "AFTER-TRUNCATION"; while :; do sleep 0.2; done ;;
  burst)   i=0
           while :; do i=\$((i + 1)); printf 'LINE-%s\n' "\$i"; sleep 0.002; done ;;
  *)       while :; do sleep 0.2; done ;;
esac
FAKEEOF
chmod +x "\$WORK/fake/boxup"

# fake_wrapper <id> [WMODE] [WLOG] [WGO] -> prints the pid. stdout/stderr MUST
# go to /dev/null: any helper that inherits the pipe this inner script writes to
# would block the outer command substitution until it died.
fake_wrapper() {
  (
    exec env WMODE="\${2:-idle}" WLOG="\${3:-}" WGO="\${4:-}" \\
      setsid -f bash "\$WORK/fake/boxup" job-wrapper "\$1" ) >/dev/null 2>&1 &
  local p=\$!
  # setsid re-parents; find the descendant whose cmdline names this id.
  local i=0 found=""
  while [ "\$i" -lt 100 ]; do
    for d in /proc/[0-9]*; do
      if tr '\0' ' ' < "\$d/cmdline" 2>/dev/null | grep -q "fake/boxup job-wrapper \$1 "; then
        found="\${d##*/}"; break
      fi
    done
    [ -n "\$found" ] && break
    sleep 0.05; i=\$((i + 1))
  done
  printf '%s' "\$found"
}

# fake_poll <id> -> a live \`bash <path>/boxup job status <id>\` (NOT a wrapper)
fake_poll() {
  bash "\$WORK/fake/boxup" job status "\$1" >/dev/null 2>&1 &
  printf '%s' "\$!"
}

# --- stubs around the extracted code ---------------------------------------
log(){ printf '%s\n' "\$*" >> "\$LOGLINES"; }
have(){ command -v "\$1" >/dev/null 2>&1; }
ensure_dirs(){ mkdir -p "\$RUN_DIR" 2>/dev/null || true; }
# Records every signal boxup sends and forwards it unchanged, so the TERM->KILL
# sequence is observable without altering it.
kill(){ printf '%s\n' "\$*" >> "\$KILLS"; command kill "\$@"; }

# --- the REAL constants, eval'd out of boxup -------------------------------
SET_MIN_INTERVAL=20
eval "\$(sed -n '/^BOXUP_DISK_WARN_PCT=/,/^DISK_WARN_STAMP=/p' "\$BOXUP")"
eval "\$(sed -n '/^JOBS_DIR=/,/^JOBS_CRASHLOOP_WINDOW_S=/p' "\$BOXUP")"
JOBS_STOP_GRACE_S=2          # the ONE lowered constant (see the header)
mkdir -p "\$JOBS_RUN_DIR"
$( [ -n "$dgt" ] && printf 'DISK_GUARD_TRUNCATE=%s\n' "$dgt" )

extract_fn_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in spawn_detached refresh_backoff_window \\
          disk_used_pct disk_level disk_allowlisted disk_truncate_one disk_guard \\
          is_job_wrapper_proc jobs_rec jobs_marker jobs_read jobs_read_raw \\
          jobs_valid_id jobs_live jobs_scan_wrapper jobs_terminal jobs_state \\
          jobs_slot_id jobs_slot_release jobs_slot_held jobs_slot_claim \\
          jobs_bound_logs \\
          jobs_record_truncation jobs_restart_state jobs_restart_one \\
          jobs_supervise jobs_prune jobs_guard jobs_status_tokens \\
          jobs_launch_wrapper jobs_usage jobs_cmd_start jobs_cmd_status \\
          jobs_cmd_log jobs_cmd_stop jobs_cmd_ls cmd_job; do
  eval "\$(extract_fn_from "\$BOXUP" "\$fn")"
done
SELF="\$BOXUP"   # the wrapper spawn_detached launches is the REAL boxup

# --- helpers ---------------------------------------------------------------
# mkrec <id> [k=v ...]: fabricate a durable record.
mkrec(){
  local id="\$1"; shift
  local d="\$JOBS_DIR/\$id" kv
  mkdir -p "\$d"
  : > "\$d/log"
  for kv in "\$@"; do printf '%s' "\${kv#*=}" > "\$d/\${kv%%=*}"; done
}
sz(){ stat -c %s "\$1" 2>/dev/null || echo -1; }
waitfor(){ local f="\$1" i=0; while [ "\$i" -lt 200 ]; do [ -e "\$f" ] && return 0; sleep 0.05; i=\$((i+1)); done; return 1; }
alive(){ command kill -0 "\$1" 2>/dev/null; }

case "$scenario" in

start-ok)
  jobs_cmd_start J1 --cap 30 --cwd "\$WORK" -- echo hello-from-job
  src=\$?
  waitfor "\$JOBS_DIR/J1/rc" || true
  echo "start_rc=\$src"
  echo "cmd=[\$(cat "\$JOBS_DIR/J1/cmd")]"
  echo "cwd=[\$(cat "\$JOBS_DIR/J1/cwd")]"
  echo "kind=[\$(cat "\$JOBS_DIR/J1/kind")]"
  echo "cap=[\$(cat "\$JOBS_DIR/J1/cap")]"
  echo "keep=[\$(cat "\$JOBS_DIR/J1/keep_alive")]"
  echo "swap=[\$(cat "\$JOBS_DIR/J1/restart_on_swap")]"
  echo "trunc=[\$(cat "\$JOBS_DIR/J1/truncations")/\$(cat "\$JOBS_DIR/J1/truncated_total")]"
  echo "pgid=[\$(cat "\$JOBS_DIR/J1/pgid" 2>/dev/null)]"
  echo "started=[\$(cat "\$JOBS_DIR/J1/started" 2>/dev/null)]"
  echo "ended=[\$(cat "\$JOBS_DIR/J1/ended" 2>/dev/null)]"
  echo "rc=[\$(cat "\$JOBS_DIR/J1/rc" 2>/dev/null)]"
  echo "logtext=[\$(tr -d '\n' < "\$JOBS_DIR/J1/log")]"
  echo "state=[\$(jobs_state J1)]"
  echo "slotgone=[\$([ -d "\$JOBS_SLOT" ] && echo no || echo yes)]"
  echo "markergone=[\$([ -f "\$(jobs_marker J1)" ] && echo no || echo yes)]"
  ;;

start-busy)
  jobs_cmd_start J1 --cap 60 -- sleep 60 >/dev/null 2>&1
  waitfor "\$(jobs_marker J1)" || true
  sleep 0.3
  out="\$(jobs_cmd_start J2 --cap 60 -- sleep 60 2>&1)"; src=\$?
  echo "second_rc=\$src"
  echo "second_out=[\$out]"
  echo "j2_created=[\$([ -d "\$JOBS_DIR/J2" ] && echo yes || echo no)]"
  echo "slot_id=[\$(jobs_slot_id)]"
  ;;

stale-slot)
  # A slot naming a job with a DEAD wrapper and no rc: liveness says stale, and
  # the age is irrelevant (mutant j2 breaks on age alone and cannot do this).
  mkdir -p "\$JOBS_SLOT"
  echo DEADJOB > "\$JOBS_SLOT/id"; date +%s > "\$JOBS_SLOT/at"
  mkrec DEADJOB kind=run cap=60 keep_alive=0 restart_on_swap=1
  echo 999999 > "\$(jobs_marker DEADJOB)"
  jobs_slot_held; held=\$?
  echo "held_rc=\$held"
  echo "slot_after=[\$([ -d "\$JOBS_SLOT" ] && echo present || echo broken)]"
  echo "warn=[\$(grep -c 'breaking a STALE job slot id=DEADJOB' "\$LOGLINES")]"
  jobs_cmd_start J9 --cap 30 -- echo retried >/dev/null 2>&1; echo "retry_rc=\$?"
  waitfor "\$JOBS_DIR/J9/rc" || true
  echo "retry_state=[\$(jobs_state J9)]"
  ;;

states)
  mkrec S_done   kind=run rc=0
  mkrec S_failed kind=run rc=3
  mkrec S_to     kind=run rc=124
  mkrec S_to_svc kind=service rc=124
  mkrec S_stop   kind=run rc=143 stopped=1
  mkrec S_crash  kind=service rc=crashloop
  mkrec S_died   kind=run
  echo 999999 > "\$(jobs_marker S_died)"
  mkrec S_swap   kind=run
  mkrec S_run    kind=service keep_alive=1
  rp="\$(fake_wrapper S_run)"
  echo "\$rp" > "\$(jobs_marker S_run)"
  for id in S_done S_failed S_to S_to_svc S_stop S_crash S_died S_swap S_run; do
    echo "state_\$id=[\$(jobs_state "\$id")]"
  done
  echo "state_missing=[\$(jobs_state NOSUCH; echo "rc=\$?")]"
  ;;

swap-pgid-reuse)
  # The record's pgid is a LIVE unrelated process; the marker is gone (the run
  # dir is what a swap clears). Liveness must ignore the pgid entirely.
  sleep 300 >/dev/null 2>&1 & other=\$!
  opg=\$(ps -o pgid= -p \$other | tr -d ' ')
  mkrec SVCSWAP kind=service keep_alive=1 restart_on_swap=1 cap=1 pgid="\$opg"
  printf 'sleep 300' > "\$JOBS_DIR/SVCSWAP/cmd"
  printf '%s' "\$WORK" > "\$JOBS_DIR/SVCSWAP/cwd"
  echo "state_before=[\$(jobs_state SVCSWAP)]"
  jobs_supervise
  waitfor "\$(jobs_marker SVCSWAP)" || true
  sleep 0.5
  newpid="\$(cat "\$(jobs_marker SVCSWAP)" 2>/dev/null)"
  echo "restarted=[\$(grep -c 'job=SVCSWAP restarting' "\$LOGLINES")]"
  echo "newpid_is_wrapper=[\$(is_job_wrapper_proc "\$newpid" SVCSWAP && echo yes || echo no)]"
  echo "other_alive=[\$(alive "\$other" && echo yes || echo no)]"
  echo "state_after=[\$(jobs_state SVCSWAP)]"
  ;;

live-wrapper-no-marker)
  mkrec SVCLIVE kind=service keep_alive=1 restart_on_swap=1
  printf 'sleep 300' > "\$JOBS_DIR/SVCLIVE/cmd"
  wp="\$(fake_wrapper SVCLIVE)"
  echo "wrapper_pid=[\$wp]"
  jobs_supervise
  sleep 0.3
  echo "marker=[\$(cat "\$(jobs_marker SVCLIVE)" 2>/dev/null)]"
  echo "recreated=[\$(grep -c 'wrapper already live' "\$LOGLINES")]"
  echo "restarted=[\$(grep -c 'job=SVCLIVE restarting' "\$LOGLINES")]"
  n=0
  for d in /proc/[0-9]*; do
    is_job_wrapper_proc "\${d##*/}" SVCLIVE && n=\$((n + 1))
  done
  echo "wrapper_count=[\$n]"
  ;;

poll-not-matched)
  mkrec SVCPOLL kind=service keep_alive=1 restart_on_swap=1 cap=1
  printf 'sleep 300' > "\$JOBS_DIR/SVCPOLL/cmd"
  printf '%s' "\$WORK" > "\$JOBS_DIR/SVCPOLL/cwd"
  pp="\$(fake_poll SVCPOLL)"
  sh -c 'sleep 300 # SVCPOLL' >/dev/null 2>&1 & shp=\$!
  sleep 0.3
  echo "poll_pid=[\$pp]"
  echo "scan_before=[\$(jobs_scan_wrapper SVCPOLL || echo none)]"
  echo "poll_matches=[\$(is_job_wrapper_proc "\$pp" SVCPOLL && echo yes || echo no)]"
  echo "shc_matches=[\$(is_job_wrapper_proc "\$shp" SVCPOLL && echo yes || echo no)]"
  jobs_supervise
  waitfor "\$(jobs_marker SVCPOLL)" || true
  sleep 0.5
  mk="\$(cat "\$(jobs_marker SVCPOLL)" 2>/dev/null)"
  echo "marker=[\$mk]"
  echo "marker_is_poll=[\$([ "\$mk" = "\$pp" ] && echo yes || echo no)]"
  echo "marker_is_shc=[\$([ "\$mk" = "\$shp" ] && echo yes || echo no)]"
  echo "marker_is_wrapper=[\$(is_job_wrapper_proc "\$mk" SVCPOLL && echo yes || echo no)]"
  ;;

slot-live-not-broken)
  jobs_cmd_start LIVE --cap 60 -- sleep 60 >/dev/null 2>&1
  waitfor "\$(jobs_marker LIVE)" || true
  sleep 0.3
  jobs_slot_held; echo "held_rc=\$?"
  echo "slot_after=[\$([ -d "\$JOBS_SLOT" ] && echo present || echo broken)]"
  echo "broke=[\$(grep -c 'breaking a STALE' "\$LOGLINES")]"
  ;;

keepalive-backoff)
  mkrec SVCBACK kind=service keep_alive=1 restart_on_swap=1 cap=1
  printf 'sleep 60' > "\$JOBS_DIR/SVCBACK/cmd"
  printf '%s' "\$WORK" > "\$JOBS_DIR/SVCBACK/cwd"
  jobs_supervise                                   # first restart: no backoff
  waitfor "\$(jobs_marker SVCBACK)" || true
  sleep 0.4
  p1="\$(cat "\$(jobs_marker SVCBACK)")"
  echo "r1=[\$(cat "\$(jobs_restart_state SVCBACK)")]"
  # A service has NO cap: with cap=1 in the record, a capped run would be dead
  # within a second (mutant j20). Wait past it and assert it is still there.
  sleep 2
  echo "svc_alive_after_cap=[\$(alive "\$p1" && echo yes || echo no)]"
  command kill -9 "\$p1" 2>/dev/null
  sleep 0.3
  jobs_supervise                                   # inside the 20 s window
  echo "r2=[\$(cat "\$(jobs_restart_state SVCBACK)")]"
  echo "restarts_so_far=[\$(grep -c 'job=SVCBACK restarting' "\$LOGLINES")]"
  # Back-date the last-restart stamp past the window that applies AFTER one
  # restart, which is 60 s, not 20: the ladder advances with the count.
  read -r n first last < "\$(jobs_restart_state SVCBACK)"
  echo "\$n \$first \$((last - 65))" > "\$(jobs_restart_state SVCBACK)"
  jobs_supervise
  sleep 0.4
  echo "r3=[\$(cat "\$(jobs_restart_state SVCBACK)")]"
  echo "restarts_total=[\$(grep -c 'job=SVCBACK restarting' "\$LOGLINES")]"
  # One per line: the outer 'field' helper anchors on the whole line, so two
  # k=[v] pairs sharing a line make the first capture swallow the rest.
  echo "window0=[\$(refresh_backoff_window 0)]"
  echo "window1=[\$(refresh_backoff_window 1)]"
  echo "window2=[\$(refresh_backoff_window 2)]"
  echo "window3=[\$(refresh_backoff_window 3)]"
  ;;

crashloop)
  mkrec SVCLOOP kind=service keep_alive=1 restart_on_swap=1
  printf 'true' > "\$JOBS_DIR/SVCLOOP/cmd"
  mkdir -p "\$JOBS_SLOT"; echo SVCLOOP > "\$JOBS_SLOT/id"; date +%s > "\$JOBS_SLOT/at"
  now=\$(date +%s)
  # four restarts inside the window: NOT a crashloop yet
  echo "4 \$((now - 60)) \$((now - 60))" > "\$(jobs_restart_state SVCLOOP)"
  jobs_restart_one SVCLOOP >/dev/null 2>&1
  echo "rc_at_4=[\$(cat "\$JOBS_DIR/SVCLOOP/rc" 2>/dev/null)]"
  # five inside the window: crashloop
  echo "5 \$((now - 60)) \$((now - 60))" > "\$(jobs_restart_state SVCLOOP)"
  jobs_restart_one SVCLOOP; echo "restart_rc=\$?"
  echo "rc=[\$(cat "\$JOBS_DIR/SVCLOOP/rc" 2>/dev/null)]"
  echo "ended=[\$(cat "\$JOBS_DIR/SVCLOOP/ended" 2>/dev/null)]"
  echo "state=[\$(jobs_state SVCLOOP)]"
  echo "slot=[\$([ -d "\$JOBS_SLOT" ] && echo present || echo released)]"
  echo "logline=[\$(grep -c 'CRASHLOOP' "\$LOGLINES")]"
  # five OUTSIDE the window: the counter resets instead of latching
  rm -f "\$JOBS_DIR/SVCLOOP/rc"
  echo "5 \$((now - 4000)) \$((now - 4000))" > "\$(jobs_restart_state SVCLOOP)"
  jobs_restart_one SVCLOOP >/dev/null 2>&1
  echo "rc_outside_window=[\$(cat "\$JOBS_DIR/SVCLOOP/rc" 2>/dev/null)]"
  ;;

stop-term-kill)
  mkrec SVCSTOP kind=service keep_alive=1
  wp="\$(fake_wrapper SVCSTOP notermi)"
  pg=\$(ps -o pgid= -p "\$wp" | tr -d ' ')
  printf '%s' "\$pg" > "\$JOBS_DIR/SVCSTOP/pgid"
  echo "\$wp" > "\$(jobs_marker SVCSTOP)"
  mkdir -p "\$JOBS_SLOT"; echo SVCSTOP > "\$JOBS_SLOT/id"; date +%s > "\$JOBS_SLOT/at"
  echo "live_before=[\$(jobs_live SVCSTOP && echo yes || echo no)]"
  jobs_cmd_stop SVCSTOP; echo "stop_rc=\$?"
  sleep 0.3
  echo "term=[\$(grep -c -- "-TERM -- -\$pg" "\$KILLS")]"
  echo "killsig=[\$(grep -c -- "-KILL -- -\$pg" "\$KILLS")]"
  echo "gone=[\$(alive "\$wp" && echo no || echo yes)]"
  echo "rc=[\$(cat "\$JOBS_DIR/SVCSTOP/rc")]"
  echo "stopped=[\$(cat "\$JOBS_DIR/SVCSTOP/stopped")]"
  echo "state=[\$(jobs_state SVCSTOP)]"
  echo "slot=[\$([ -d "\$JOBS_SLOT" ] && echo present || echo released)]"
  # idempotent on a terminal record: no new signals
  : > "\$KILLS"
  jobs_cmd_stop SVCSTOP >/dev/null 2>&1; echo "again_rc=\$?"
  echo "again_signals=[\$(wc -l < "\$KILLS")]"
  ;;

log-offsets)
  mkrec L kind=run
  printf 'ABCDEFGHIJ' > "\$JOBS_DIR/L/log"
  echo "off0=[\$(jobs_cmd_log L 0)]"
  echo "off5=[\$(jobs_cmd_log L 5)]"
  echo "off9=[\$(jobs_cmd_log L 9)]"
  echo "off10=[\$(jobs_cmd_log L 10)]"
  echo "offdefault=[\$(jobs_cmd_log L)]"
  jobs_cmd_log L notanumber >/dev/null 2>&1; echo "badoff_rc=\$?"
  # the 1 MiB per-call bound
  head -c \$((JOBS_LOG_FETCH_MAX + 100)) /dev/zero | tr '\0' 'x' > "\$JOBS_DIR/L/log"
  echo "capped=[\$(jobs_cmd_log L 0 | wc -c)]"
  echo "capped_from_50=[\$(jobs_cmd_log L 50 | wc -c)]"
  ;;

bound-boundary)
  mkrec B kind=run
  wp="\$(fake_wrapper B after "\$JOBS_DIR/B/log" "\$WORK/go")"
  echo "\$wp" > "\$(jobs_marker B)"
  truncate -s "\$JOBS_LOG_MAX_BYTES" "\$JOBS_DIR/B/log"
  jobs_bound_logs
  echo "at_bound_size=[\$(sz "\$JOBS_DIR/B/log")]"
  echo "at_bound_trunc=[\$(cat "\$JOBS_DIR/B/truncations" 2>/dev/null || echo 0)]"
  truncate -s \$((JOBS_LOG_MAX_BYTES + 1)) "\$JOBS_DIR/B/log"
  jobs_bound_logs
  echo "over_trunc=[\$(cat "\$JOBS_DIR/B/truncations")]"
  echo "over_total=[\$(cat "\$JOBS_DIR/B/truncated_total")]"
  echo "prefix=[\$(grep -c 'jobs_guard: job=B: truncated' "\$LOGLINES")]"
  echo "no_disk_prefix=[\$(grep -c '^disk-guard: truncated' "\$LOGLINES")]"
  touch "\$WORK/go"
  sleep 0.6
  echo "size_after=[\$(sz "\$JOBS_DIR/B/log")]"
  echo "marker_line=[\$(grep -c 'log truncated on box at' "\$JOBS_DIR/B/log")]"
  echo "post_line=[\$(grep -c '^AFTER-TRUNCATION\$' "\$JOBS_DIR/B/log")]"
  echo "no_log1=[\$([ -e "\$JOBS_DIR/B/log.1" ] && echo present || echo absent)]"
  ;;

bound-concurrent)
  mkrec C kind=run
  wp="\$(fake_wrapper C burst "\$JOBS_DIR/C/log")"
  echo "\$wp" > "\$(jobs_marker C)"
  sleep 0.4
  truncate -s \$((JOBS_LOG_MAX_BYTES + 1)) "\$JOBS_DIR/C/log"
  jobs_bound_logs
  sleep 0.6
  command kill -9 "\$wp" 2>/dev/null
  sleep 0.2
  # Every surviving line is either the guard's marker or a WHOLE LINE-<n>:
  # nothing is split and nothing is interleaved.
  bad_lines=\$(grep -vc -E '^(LINE-[0-9]+|\[log truncated on box at .*\])\$' "\$JOBS_DIR/C/log" || true)
  echo "malformed=[\$bad_lines]"
  echo "post_lines=[\$(grep -c '^LINE-[0-9]*\$' "\$JOBS_DIR/C/log")]"
  echo "truncations=[\$(cat "\$JOBS_DIR/C/truncations")]"
  ;;

counters-two)
  mkrec T kind=run
  truncate -s \$((JOBS_LOG_MAX_BYTES + 1)) "\$JOBS_DIR/T/log"
  jobs_bound_logs
  truncate -s \$((JOBS_LOG_MAX_BYTES + 5)) "\$JOBS_DIR/T/log"
  jobs_bound_logs
  echo "status=[\$(jobs_cmd_status T)]"
  echo "expect_total=[\$((JOBS_LOG_MAX_BYTES + 1 + JOBS_LOG_MAX_BYTES + 5))]"
  ;;

symlink-refused)
  mkrec S kind=run
  printf 'VICTIM-CONTENT' > "\$WORK/victim"
  rm -f "\$JOBS_DIR/S/log"
  ln -s "\$WORK/victim" "\$JOBS_DIR/S/log"
  truncate -s \$((JOBS_LOG_MAX_BYTES + 1)) "\$WORK/victim"
  jobs_bound_logs
  echo "victim_size=[\$(sz "\$WORK/victim")]"
  echo "truncations=[\$(jobs_read "\$JOBS_DIR/S" truncations 0)]"
  echo "total=[\$(jobs_read "\$JOBS_DIR/S" truncated_total 0)]"
  echo "warn=[\$(grep -c 'REFUSED to truncate' "\$LOGLINES")]"
  echo "link_intact=[\$([ -L "\$JOBS_DIR/S/log" ] && echo yes || echo no)]"
  ;;

override-allowlist)
  # DISK_GUARD_TRUNCATE was overridden by the caller to a list WITHOUT the job
  # entry. Both halves must still work.
  echo "list=[\$DISK_GUARD_TRUNCATE]"
  echo "builtin=[\$DISK_GUARD_BUILTIN_TRUNCATE]"
  mkrec O kind=run
  truncate -s \$((JOBS_LOG_MAX_BYTES + 1)) "\$JOBS_DIR/O/log"
  jobs_bound_logs
  echo "bound_size=[\$(sz "\$JOBS_DIR/O/log")]"
  echo "bound_trunc=[\$(cat "\$JOBS_DIR/O/truncations")]"
  # the PRESSURE path: the candidate loop must NAME a job log on its own. The
  # mutator's DEFAULT 1 GiB floor applies here, so the log is 2 GiB (sparse).
  mkrec P kind=run
  truncate -s \$((2 * 1024 * 1024 * 1024)) "\$JOBS_DIR/P/log"
  disk_guard
  echo "pressure_size=[\$(sz "\$JOBS_DIR/P/log")]"
  echo "pressure_trunc=[\$(cat "\$JOBS_DIR/P/truncations")]"
  echo "pressure_total=[\$(cat "\$JOBS_DIR/P/truncated_total")]"
  echo "state=[\$(cat "\$DISK_STATE")]"
  ;;

pressure-default)
  mkrec P kind=run
  truncate -s \$((2 * 1024 * 1024 * 1024)) "\$JOBS_DIR/P/log"
  disk_guard
  echo "size=[\$(sz "\$JOBS_DIR/P/log")]"
  echo "trunc=[\$(cat "\$JOBS_DIR/P/truncations")]"
  ;;

prune)
  now=\$(date +%s)
  # phase 1: 10 recent + 3 aged past the retention window; COUNT prunes none.
  i=0
  while [ "\$i" -lt 10 ]; do
    mkrec "R\$i" kind=run rc=0 ended_epoch=\$((now - i * 60))
    i=\$((i + 1))
  done
  i=0
  while [ "\$i" -lt 3 ]; do
    mkrec "OLD\$i" kind=run rc=0 ended_epoch=\$((now - 8 * 86400 - i))
    i=\$((i + 1))
  done
  mkrec ACTIVE kind=service keep_alive=1
  echo 999999 > "\$(jobs_marker ACTIVE)"
  jobs_prune
  echo "p1_recent=[\$(ls -d "\$JOBS_DIR"/R* 2>/dev/null | wc -l)]"
  echo "p1_old=[\$(ls -d "\$JOBS_DIR"/OLD* 2>/dev/null | wc -l)]"
  echo "p1_active=[\$([ -d "\$JOBS_DIR/ACTIVE" ] && echo kept || echo GONE)]"
  # phase 2: 25 recent terminal records; only the 20 newest survive.
  rm -rf "\$JOBS_DIR"/R*
  i=0
  while [ "\$i" -lt 25 ]; do
    mkrec "K\$i" kind=run rc=0 ended_epoch=\$((now - i * 60))
    i=\$((i + 1))
  done
  jobs_prune
  echo "p2_kept=[\$(ls -d "\$JOBS_DIR"/K* 2>/dev/null | wc -l)]"
  echo "p2_newest=[\$([ -d "\$JOBS_DIR/K0" ] && echo kept || echo GONE)]"
  echo "p2_rank20=[\$([ -d "\$JOBS_DIR/K19" ] && echo kept || echo GONE)]"
  echo "p2_rank21=[\$([ -d "\$JOBS_DIR/K20" ] && echo kept || echo GONE)]"
  echo "p2_oldest=[\$([ -d "\$JOBS_DIR/K24" ] && echo kept || echo GONE)]"
  ;;

guard-under-lock)
  mkrec G kind=run
  truncate -s \$((JOBS_LOG_MAX_BYTES + 1)) "\$JOBS_DIR/G/log"
  CONVERGE_LOCK="\$RUN_DIR/converge.v2.lock"
  : > "\$CONVERGE_LOCK"
  # Hold the converge lock in another process for the whole call.
  ( flock 9; sleep 3 ) >/dev/null 2>&1 9>"\$CONVERGE_LOCK" &
  holder=\$!
  sleep 0.3
  jobs_guard; echo "guard_rc=\$?"
  echo "size=[\$(sz "\$JOBS_DIR/G/log")]"
  echo "trunc=[\$(cat "\$JOBS_DIR/G/truncations")]"
  command kill "\$holder" 2>/dev/null
  ;;

tokens)
  echo "tokens_idle=[\$(jobs_status_tokens)]"
  jobs_cmd_start TOK --cap 60 -- sleep 60 >/dev/null 2>&1
  waitfor "\$(jobs_marker TOK)" || true
  sleep 0.3
  echo "tokens_running=[\$(jobs_status_tokens)]"
  ;;

swap-retakes-slot)
  # The 5.5.1 defect: after a swap the tick restarts the service but the slot
  # stays gone, so 'boxup status' reports no job and the box accepts a second.
  mkrec SVCSLOT kind=service keep_alive=1 restart_on_swap=1 cap=1
  printf 'sleep 300' > "\$JOBS_DIR/SVCSLOT/cmd"
  printf '%s' "\$WORK" > "\$JOBS_DIR/SVCSLOT/cwd"
  mkdir -p "\$JOBS_SLOT"; echo SVCSLOT > "\$JOBS_SLOT/id"; date +%s > "\$JOBS_SLOT/at"
  wp="\$(fake_wrapper SVCSLOT)"
  echo "\$wp" > "\$(jobs_marker SVCSLOT)"
  echo "before_state=[\$(jobs_state SVCSLOT)]"
  echo "before_tokens=[\$(jobs_status_tokens)]"
  # the simulated image swap: kill the group and clear the RUN dir, which is
  # exactly what a swap does to /run (and what a reboot does too)
  pg=\$(ps -o pgid= -p "\$wp" 2>/dev/null | tr -d ' ')
  [ -n "\$pg" ] && command kill -9 -- "-\$pg" 2>/dev/null
  sleep 0.3
  rm -rf "\$RUN_DIR"               # the swap, faithfully: ALL of /run is gone
  echo "swap_state=[\$(jobs_state SVCSLOT)]"
  echo "swap_slot=[\$(jobs_slot_id 2>/dev/null || echo NONE)]"
  echo "swap_rundir=[\$([ -d "\$JOBS_RUN_DIR" ] && echo present || echo ABSENT)]"
  # The run dir is NOT re-created here. A swap deletes it outright, and every
  # consumer below must cope with that; re-creating it first is a weaker event
  # than the one this case is named after, and it is what let the 5.5.1 ENOENT
  # regression reach a live box.
  jobs_guard
  waitfor "\$(jobs_marker SVCSLOT)" || true
  sleep 0.5
  echo "restart_state=[\$(jobs_state SVCSLOT)]"
  echo "restart_slot=[\$(jobs_slot_id 2>/dev/null || echo NONE)]"
  echo "restart_tokens=[\$(jobs_status_tokens)]"
  echo "restart_rundir=[\$([ -d "\$JOBS_RUN_DIR" ] && echo present || echo ABSENT)]"
  # THE invariant: the box must refuse a second job again
  out="\$(jobs_cmd_start SECOND --cap 60 -- sleep 30 2>&1)"; src=\$?
  echo "second_rc=[\$src]"
  echo "second_out=[\$out]"
  echo "second_created=[\$([ -d "\$JOBS_DIR/SECOND" ] && echo yes || echo no)]"
  n=0
  for d in /proc/[0-9]*; do
    is_job_wrapper_proc "\${d##*/}" SECOND && n=\$((n + 1))
  done
  echo "second_wrappers=[\$n]"
  ;;

slot-not-stolen)
  # A service needs a restart while ANOTHER job legitimately holds the slot.
  # Restarting into it would be the same two-jobs-on-one-box outcome, reached
  # from the other side, so the restart must WAIT.
  jobs_cmd_start HOLDER --cap 120 -- sleep 120 >/dev/null 2>&1
  waitfor "\$(jobs_marker HOLDER)" || true
  sleep 0.3
  mkrec SVCWAIT kind=service keep_alive=1 restart_on_swap=1 cap=1
  printf 'sleep 300' > "\$JOBS_DIR/SVCWAIT/cmd"
  printf '%s' "\$WORK" > "\$JOBS_DIR/SVCWAIT/cwd"
  echo "holder_slot=[\$(jobs_slot_id)]"
  echo "svc_state_before=[\$(jobs_state SVCWAIT)]"
  jobs_guard
  sleep 0.5
  echo "slot_after=[\$(jobs_slot_id 2>/dev/null || echo NONE)]"
  echo "holder_state=[\$(jobs_state HOLDER)]"
  echo "svc_state_after=[\$(jobs_state SVCWAIT)]"
  echo "refusal_logged=[\$(grep -c 'job=SVCWAIT NOT restarting' "\$LOGLINES")]"
  n=0
  for d in /proc/[0-9]*; do
    is_job_wrapper_proc "\${d##*/}" SVCWAIT && n=\$((n + 1))
  done
  echo "svc_wrappers=[\$n]"
  ;;

tick-restarts-after-swap)
  # The entry point the installed WORKER actually calls, not jobs_guard direct.
  # run_tick is extracted whole; only the neighbours are stubbed, so the guard's
  # position inside it and its behaviour with an ABSENT run dir are both real.
  eval "\$(extract_fn_from "\$BOXUP" run_tick)"
  disk_guard(){ echo "disk_guard ran" >> "\$LOGLINES"; }
  keepawake_guard(){ echo "keepawake_guard ran" >> "\$LOGLINES"; }
  do_tick(){ echo "do_tick ran" >> "\$LOGLINES"; }
  LOCK_RC=\${LOCK_RC:-0}
  run_with_converge_lock(){ echo "converge_lock ran" >> "\$LOGLINES"; return "\$LOCK_RC"; }
  mkrec SVCTICK kind=service keep_alive=1 restart_on_swap=1 cap=1
  printf 'sleep 300' > "\$JOBS_DIR/SVCTICK/cmd"
  printf '%s' "\$WORK" > "\$JOBS_DIR/SVCTICK/cwd"
  mkdir -p "\$JOBS_SLOT"; echo SVCTICK > "\$JOBS_SLOT/id"; date +%s > "\$JOBS_SLOT/at"
  wp="\$(fake_wrapper SVCTICK)"
  echo "\$wp" > "\$(jobs_marker SVCTICK)"
  pg=\$(ps -o pgid= -p "\$wp" 2>/dev/null | tr -d ' ')
  [ -n "\$pg" ] && command kill -9 -- "-\$pg" 2>/dev/null
  sleep 0.3
  rm -rf "\$RUN_DIR"               # the swap, faithfully: ALL of /run is gone
  echo "pre_rundir=[\$([ -d "\$JOBS_RUN_DIR" ] && echo present || echo ABSENT)]"
  echo "pre_state=[\$(jobs_state SVCTICK)]"
  run_tick; echo "tick_rc=[\$?]"
  waitfor "\$(jobs_marker SVCTICK)" || true
  sleep 0.5
  echo "post_state=[\$(jobs_state SVCTICK)]"
  echo "post_slot=[\$(jobs_slot_id 2>/dev/null || echo NONE)]"
  echo "post_tokens=[\$(jobs_status_tokens)]"
  echo "post_rundir=[\$([ -d "\$JOBS_RUN_DIR" ] && echo present || echo ABSENT)]"
  out="\$(jobs_cmd_start SECOND --cap 60 -- sleep 30 2>&1)"; src=\$?
  echo "second_rc=[\$src]"
  echo "guard_before_lock=[\$(grep -n 'converge_lock ran\\|do_tick ran' "\$LOGLINES" | head -1 | cut -d: -f1)]"
  echo "restart_line=[\$(grep -c 'job=SVCTICK restarting' "\$LOGLINES")]"
  ;;

tick-contended-lock)
  # A tick that SKIPS on a contended converge lock must still have supervised
  # jobs: the guard runs before the lock is taken, which is why it is placed
  # where it is. rc 200 is the skip path.
  eval "\$(extract_fn_from "\$BOXUP" run_tick)"
  disk_guard(){ :; }
  keepawake_guard(){ :; }
  do_tick(){ echo "do_tick ran" >> "\$LOGLINES"; }
  run_with_converge_lock(){ return 200; }
  mkrec SVCLOCK kind=service keep_alive=1 restart_on_swap=1 cap=1
  printf 'sleep 300' > "\$JOBS_DIR/SVCLOCK/cmd"
  printf '%s' "\$WORK" > "\$JOBS_DIR/SVCLOCK/cwd"
  rm -rf "\$RUN_DIR"
  run_tick; echo "tick_rc=[\$?]"
  waitfor "\$(jobs_marker SVCLOCK)" || true
  sleep 0.5
  echo "state=[\$(jobs_state SVCLOCK)]"
  echo "slot=[\$(jobs_slot_id 2>/dev/null || echo NONE)]"
  echo "do_tick_ran=[\$(grep -c 'do_tick ran' "\$LOGLINES")]"
  echo "hb=[\$([ -f "\$RUN_DIR/hb" ] && echo written || echo missing)]"
  ;;

slot-path-unusable)
  # The only deterministic way the slot mkdir fails once the run dir exists:
  # something left a regular FILE where .slot must be a directory. A claim that
  # reported success here would restart with no slot and hand the box a second
  # job — the same invariant break, from a third direction.
  mkrec SVCFILE kind=service keep_alive=1 restart_on_swap=1 cap=1
  printf 'sleep 300' > "\$JOBS_DIR/SVCFILE/cmd"
  printf '%s' "\$WORK" > "\$JOBS_DIR/SVCFILE/cwd"
  rm -rf "\$JOBS_SLOT"
  : > "\$JOBS_SLOT"                       # a FILE, not a directory
  echo "slot_is_file=[\$([ -f "\$JOBS_SLOT" ] && echo yes || echo no)]"
  jobs_slot_claim SVCFILE; echo "claim_rc=[\$?]"
  jobs_guard
  sleep 0.5
  echo "state=[\$(jobs_state SVCFILE)]"
  echo "took_slot=[\$([ -d "\$JOBS_SLOT" ] && echo yes || echo no)]"
  echo "could_not_take=[\$(grep -c 'could not TAKE the job slot' "\$LOGLINES")]"
  echo "wrong_held_msg=[\$(grep -c 'held by ?' "\$LOGLINES")]"
  n=0
  for d in /proc/[0-9]*; do
    is_job_wrapper_proc "\${d##*/}" SVCFILE && n=\$((n + 1))
  done
  echo "wrappers=[\$n]"
  ;;

ls-and-usage)
  mkrec A kind=run rc=0 started=t1 ended=t2
  mkrec B kind=service keep_alive=1
  echo "ls=[\$(jobs_cmd_ls | tr '\n' ';')]"
  cmd_job bogus >/dev/null 2>&1; echo "bogus_rc=\$?"
  cmd_job status >/dev/null 2>&1; echo "noargs_rc=\$?"
  jobs_cmd_start 'bad/id' -- true >/dev/null 2>&1; echo "badid_rc=\$?"
  jobs_cmd_start GOOD --cap notanumber -- true >/dev/null 2>&1; echo "badcap_rc=\$?"
  jobs_cmd_start GOOD --kind bogus -- true >/dev/null 2>&1; echo "badkind_rc=\$?"
  jobs_cmd_start GOOD --cap 30 >/dev/null 2>&1; echo "nocmd_rc=\$?"
  ;;

esac
INNER
  timeout 180 bash "$inner" 2>/dev/null
  rc=$?
  rm -f "$inner"
  return $rc
}

field() { printf '%s\n' "$1" | sed -n "s/^$2=\[\(.*\)\]\$/\1/p" | head -1; }

# ---------------------------------------------------------------------------
# (1) start writes every record file, runs the command, records the outcome
# ---------------------------------------------------------------------------
o="$(run_case start-ok)"
ok=1
[ "$(printf '%s\n' "$o" | sed -n 's/^start_rc=//p')" = 0 ] || ok=0
[ "$(field "$o" cmd)" = "echo hello-from-job" ] || ok=0
[ "$(field "$o" kind)" = run ] || ok=0
[ "$(field "$o" cap)" = 30 ] || ok=0
[ "$(field "$o" keep)" = 0 ] || ok=0
[ "$(field "$o" swap)" = 1 ] || ok=0
[ "$(field "$o" trunc)" = "0/0" ] || ok=0
[ "$(field "$o" rc)" = 0 ] || ok=0
[ "$(field "$o" state)" = done ] || ok=0
[ "$(field "$o" logtext)" = "hello-from-job" ] || ok=0
[ "$(field "$o" slotgone)" = yes ] || ok=0
[ "$(field "$o" markergone)" = yes ] || ok=0
case "$(field "$o" pgid)" in ''|*[!0-9]*) ok=0 ;; esac
[ -n "$(field "$o" started)" ] && [ -n "$(field "$o" ended)" ] || ok=0
if [ "$ok" = 1 ]; then
  pass "(1) start records cmd/cwd/kind/cap/keep_alive/pgid, runs it through the REAL wrapper, logs its output, records rc + ended, releases the slot"
else
  bad  "(1) start/record/wrapper round-trip wrong: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (2) a second start while the first is live => rc 75          [mutant j1]
# ---------------------------------------------------------------------------
o="$(run_case start-busy)"
if [ "$(printf '%s\n' "$o" | sed -n 's/^second_rc=//p')" = 75 ] && \
   [ "$(field "$o" j2_created)" = no ] && \
   [ "$(field "$o" slot_id)" = J1 ] && \
   printf '%s' "$(field "$o" second_out)" | grep -q 'job=busy'; then
  pass "(2) a second start while a job is live is refused with rc 75 and creates no record"
else
  bad  "(2) one-job-per-box not enforced: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (3) a stale slot is broken with a WARN, liveness-based       [mutant j2]
# ---------------------------------------------------------------------------
o="$(run_case stale-slot)"
if [ "$(printf '%s\n' "$o" | sed -n 's/^held_rc=//p')" = 1 ] && \
   [ "$(field "$o" slot_after)" = broken ] && \
   [ "$(field "$o" warn)" -ge 1 ] && \
   [ "$(printf '%s\n' "$o" | sed -n 's/^retry_rc=//p')" = 0 ] && \
   [ "$(field "$o" retry_state)" = done ]; then
  pass "(3) a slot whose job has no live wrapper is stale REGARDLESS of age, is broken with a WARN, and the retry starts"
else
  bad  "(3) stale-slot break wrong: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (4) status derives every state from the files       [mutants j3, j4, j15]
# ---------------------------------------------------------------------------
o="$(run_case states)"
ok=1
[ "$(field "$o" state_S_done)"   = done ]            || ok=0
[ "$(field "$o" state_S_failed)" = failed ]          || ok=0
[ "$(field "$o" state_S_to)"     = timeout ]         || ok=0
[ "$(field "$o" state_S_to_svc)" = failed ]          || ok=0
[ "$(field "$o" state_S_stop)"   = stopped ]         || ok=0
[ "$(field "$o" state_S_crash)"  = crashloop ]       || ok=0
[ "$(field "$o" state_S_died)"   = "lost:died" ]     || ok=0
[ "$(field "$o" state_S_swap)"   = "lost:image-swap" ] || ok=0
[ "$(field "$o" state_S_run)"    = running ]         || ok=0
printf '%s' "$(field "$o" state_missing)" | grep -q '^unknownrc=1$' || ok=0
if [ "$ok" = 1 ]; then
  pass "(4) status derives done/failed/timeout/stopped/crashloop/running/lost:died/lost:image-swap from the FILES, and a missing rc is never done"
else
  bad  "(4) state derivation wrong: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (4b) a reused pgid after a swap is not the job              [mutant j26]
# ---------------------------------------------------------------------------
o="$(run_case swap-pgid-reuse)"
if [ "$(field "$o" state_before)" = "lost:image-swap" ] && \
   [ "$(field "$o" restarted)" -ge 1 ] && \
   [ "$(field "$o" newpid_is_wrapper)" = yes ] && \
   [ "$(field "$o" other_alive)" = yes ] && \
   [ "$(field "$o" state_after)" = running ]; then
  pass "(4b) a live UNRELATED process holding the recorded pgid is not the job: status says lost:image-swap and the keep-alive path restarts"
else
  bad  "(4b) pgid was read as liveness: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (4c) a live wrapper with no marker => marker re-created      [mutant j27]
# ---------------------------------------------------------------------------
o="$(run_case live-wrapper-no-marker)"
if [ -n "$(field "$o" wrapper_pid)" ] && \
   [ "$(field "$o" marker)" = "$(field "$o" wrapper_pid)" ] && \
   [ "$(field "$o" recreated)" -ge 1 ] && \
   [ "$(field "$o" restarted)" = 0 ] && \
   [ "$(field "$o" wrapper_count)" = 1 ]; then
  pass "(4c) a live <id> wrapper with no marker has its marker RE-CREATED and no second instance is launched"
else
  bad  "(4c) duplicate-service closure wrong: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (4d) an in-flight poll and an `sh -c` child are not the wrapper
#                                                        [mutants j28, j29]
# ---------------------------------------------------------------------------
o="$(run_case poll-not-matched)"
if [ "$(field "$o" scan_before)" = none ] && \
   [ "$(field "$o" poll_matches)" = no ] && \
   [ "$(field "$o" shc_matches)" = no ] && \
   [ "$(field "$o" marker_is_poll)" = no ] && \
   [ "$(field "$o" marker_is_shc)" = no ] && \
   [ "$(field "$o" marker_is_wrapper)" = yes ]; then
  pass "(4d) a live 'boxup job status <id>' poll and a live 'sh -c' child mentioning <id> match NEITHER: the restart proceeds and the marker names the new wrapper"
else
  bad  "(4d) the matcher is not whole-field: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (5) a LIVE slot is never broken (the other half of (3))       [mutant j4]
# ---------------------------------------------------------------------------
o="$(run_case slot-live-not-broken)"
if [ "$(printf '%s\n' "$o" | sed -n 's/^held_rc=//p')" = 0 ] && \
   [ "$(field "$o" slot_after)" = present ] && \
   [ "$(field "$o" broke)" = 0 ]; then
  pass "(5) a slot held by a LIVE job is not broken, and no WARN is logged"
else
  bad  "(5) a live slot was broken: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (6) keep-alive restart with backoff; a service gets NO cap
#                                                        [mutants j5, j20]
# ---------------------------------------------------------------------------
o="$(run_case keepalive-backoff)"
r1="$(field "$o" r1)"; r2="$(field "$o" r2)"; r3="$(field "$o" r3)"
if [ "${r1%% *}" = 1 ] && [ "${r2%% *}" = 1 ] && [ "${r3%% *}" = 2 ] && \
   [ "$(field "$o" restarts_so_far)" = 1 ] && \
   [ "$(field "$o" restarts_total)" = 2 ] && \
   [ "$(field "$o" svc_alive_after_cap)" = yes ] && \
   [ "$(field "$o" window0)" = 20 ] && [ "$(field "$o" window1)" = 60 ] && \
   [ "$(field "$o" window2)" = 180 ] && [ "$(field "$o" window3)" = 600 ]; then
  pass "(6) keep-alive restarts on the 20->60->180->600 ladder (a second restart inside the window is suppressed), and a service runs with NO wall-clock cap"
else
  bad  "(6) keep-alive backoff / service cap wrong: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (7) crashloop after 5 restarts inside 10 minutes             [mutant j6]
# ---------------------------------------------------------------------------
o="$(run_case crashloop)"
if [ -z "$(field "$o" rc_at_4)" ] && \
   [ "$(field "$o" rc)" = crashloop ] && \
   [ -n "$(field "$o" ended)" ] && \
   [ "$(field "$o" state)" = crashloop ] && \
   [ "$(field "$o" slot)" = released ] && \
   [ "$(field "$o" logline)" -ge 1 ] && \
   [ "$(printf '%s\n' "$o" | sed -n 's/^restart_rc=//p')" = 1 ] && \
   [ -z "$(field "$o" rc_outside_window)" ]; then
  pass "(7) 5 restarts inside 10 min records rc=crashloop, releases the slot and stops restarting; 4 does not, and 5 spread beyond the window does not"
else
  bad  "(7) crashloop rule wrong: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (8) stop: TERM the group, then KILL, rc 143                  [mutant j7]
# ---------------------------------------------------------------------------
o="$(run_case stop-term-kill)"
if [ "$(field "$o" live_before)" = yes ] && \
   [ "$(field "$o" term)" -ge 1 ] && \
   [ "$(field "$o" killsig)" -ge 1 ] && \
   [ "$(field "$o" gone)" = yes ] && \
   [ "$(field "$o" rc)" = 143 ] && \
   [ "$(field "$o" state)" = stopped ] && \
   [ "$(field "$o" slot)" = released ] && \
   [ "$(field "$o" again_signals)" = 0 ]; then
  pass "(8) stop signals the process GROUP with TERM, escalates to KILL after the grace, records rc 143 / stopped, and is idempotent on a terminal record"
else
  bad  "(8) stop sequence wrong: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (9) log offsets are exact and bounded to 1 MiB               [mutant j8]
# ---------------------------------------------------------------------------
o="$(run_case log-offsets)"
if [ "$(field "$o" off0)" = ABCDEFGHIJ ] && \
   [ "$(field "$o" off5)" = FGHIJ ] && \
   [ "$(field "$o" off9)" = J ] && \
   [ -z "$(field "$o" off10)" ] && \
   [ "$(field "$o" offdefault)" = ABCDEFGHIJ ] && \
   [ "$(printf '%s\n' "$o" | sed -n 's/^badoff_rc=//p')" = 2 ] && \
   [ "$(field "$o" capped)" = 1048576 ] && \
   [ "$(field "$o" capped_from_50)" = 1048576 ]; then
  pass "(9) 'log <id> <offset>' returns exactly the bytes from that offset (offset 0 is the whole file) and never more than 1 MiB per call"
else
  bad  "(9) log offset/bound wrong: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (10) the 64 MiB bound, in place, through the guard's sole mutator
#                                                   [mutants j9, j30, j36]
# ---------------------------------------------------------------------------
o="$(run_case bound-boundary)"
if [ "$(field "$o" at_bound_size)" = 67108864 ] && \
   [ "$(field "$o" at_bound_trunc)" = 0 ] && \
   [ "$(field "$o" over_trunc)" = 1 ] && \
   [ "$(field "$o" over_total)" = 67108865 ] && \
   [ "$(field "$o" prefix)" -ge 1 ] && \
   [ "$(field "$o" no_disk_prefix)" = 0 ] && \
   [ "$(field "$o" marker_line)" = 1 ] && \
   [ "$(field "$o" post_line)" = 1 ] && \
   [ "$(field "$o" no_log1)" = absent ] && \
   [ "$(field "$o" size_after)" -lt 200 ]; then
  pass "(10) a 64 MiB log is left alone and 64 MiB + 1 is truncated to zero through disk_truncate_one with the explicit floor; the counters move, the line carries the jobs_guard prefix, and a line the still-running wrapper writes AFTER the truncation lands in the visible log"
else
  bad  "(10) the log bound is wrong: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (10b) a writer appending DURING the truncation                [mutant j31]
# ---------------------------------------------------------------------------
o="$(run_case bound-concurrent)"
if [ "$(field "$o" malformed)" = 0 ] && \
   [ "$(field "$o" post_lines)" -ge 1 ] && \
   [ "$(field "$o" truncations)" = 1 ]; then
  pass "(10b) with the wrapper appending throughout, no line is split or interleaved and every line written after the truncation survives"
else
  bad  "(10b) the truncation raced the writer: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (10c) both counters are reported, exactly, across two truncations
#                                                       [mutants j32, j34]
# ---------------------------------------------------------------------------
o="$(run_case counters-two)"
st="$(field "$o" status)"
want="$(field "$o" expect_total)"
if printf '%s' "$st" | grep -q ' truncations=2 ' && \
   printf '%s' "$st" | grep -q " truncated_total=$want\$"; then
  pass "(10c) status reports truncations=2 and the exact cumulative truncated_total, so the brain never has to infer a truncation from sizes"
else
  bad  "(10c) counters not reported/exact: [$st] want_total=[$want]"
fi

# ---------------------------------------------------------------------------
# (10e) a job log swapped for a symlink is refused             [mutant j35]
# ---------------------------------------------------------------------------
o="$(run_case symlink-refused)"
if [ "$(field "$o" victim_size)" = 67108865 ] && \
   [ "$(field "$o" truncations)" = 0 ] && \
   [ "$(field "$o" total)" = 0 ] && \
   [ "$(field "$o" warn)" -ge 1 ] && \
   [ "$(field "$o" link_intact)" = yes ]; then
  pass "(10e) a job log replaced by a symlink is refused by the mutator: the target is untouched, the counters do not move, and the refusal is WARNed"
else
  bad  "(10e) the symlink gate was bypassed: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (10f) an override that drops the job entry breaks NEITHER half
#                                                  [mutants j38, j39, j40]
# ---------------------------------------------------------------------------
o10f="$(run_case override-allowlist '93
40' '/tmp/some-other-canary.log')"
tenf_ok=1
[ "$(field "$o10f" list)" = /tmp/some-other-canary.log ] || tenf_ok=0
[ "$(field "$o10f" bound_size)" -lt 200 ] || tenf_ok=0
[ "$(field "$o10f" bound_trunc)" = 1 ] || tenf_ok=0
[ "$(field "$o10f" pressure_size)" -lt 200 ] || tenf_ok=0
[ "$(field "$o10f" pressure_trunc)" = 1 ] || tenf_ok=0
[ "$(field "$o10f" pressure_total)" = 2147483648 ] || tenf_ok=0
if [ "$tenf_ok" = 1 ]; then
  pass "(10f) with DISK_GUARD_TRUNCATE overridden to a list WITHOUT the job entry, the 64 MiB bound still fires AND disk_guard's candidate loop still SELECTS and reclaims a job log under pressure"
else
  bad  "(10f) an override disabled the bound or the reclaim: [$(printf '%s' "$o10f" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (10g) the same, on a shellcheck-clean tree: the suppression is present and
# the built-in expansion is unquoted (quoting it leaves the glob literal and
# every comparison fails SILENTLY)
# ---------------------------------------------------------------------------
if ! command -v shellcheck >/dev/null 2>&1; then
  pass "(10g) SKIPPED (shellcheck not installed)"
elif shellcheck -S warning "$BOXUP" >/dev/null 2>&1; then
  if [ "$tenf_ok" = 1 ] && \
     grep -q 'shellcheck disable=SC2086' "$BOXUP" && \
     grep -q 'for f in \$DISK_GUARD_TRUNCATE \$DISK_GUARD_BUILTIN_TRUNCATE' "$BOXUP" && \
     grep -q 'for p in \$DISK_GUARD_BUILTIN_TRUNCATE' "$BOXUP"; then
    pass "(10g) the tree is shellcheck-clean at warning severity AND (10f) still passes — both allowlist consumers expand the built-in pattern UNQUOTED under the existing suppression"
  else
    bad  "(10g) shellcheck-clean but the unquoted expansion is missing from one of the two consumers (or (10f) failed)"
  fi
else
  bad  "(10g) shellcheck -S warning is NOT clean on boxup"
fi

# ---------------------------------------------------------------------------
# (11) terminal records are pruned by AGE and by COUNT         [mutant j25]
# ---------------------------------------------------------------------------
o="$(run_case prune)"
if [ "$(field "$o" p1_recent)" = 10 ] && \
   [ "$(field "$o" p1_old)" = 0 ] && \
   [ "$(field "$o" p1_active)" = kept ] && \
   [ "$(field "$o" p2_kept)" = 20 ] && \
   [ "$(field "$o" p2_newest)" = kept ] && \
   [ "$(field "$o" p2_rank20)" = kept ] && \
   [ "$(field "$o" p2_rank21)" = GONE ] && \
   [ "$(field "$o" p2_oldest)" = GONE ]; then
  pass "(11) terminal records are pruned 7 d past their end AND bounded to the 20 most recent; a non-terminal record is never pruned"
else
  bad  "(11) prune is not both age- and count-bounded: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (11b) under pressure, disk_guard actually TRUNCATES a job log (the size
# after is the assertion — the allowlist is consumed through an unquoted
# expansion, so membership proves nothing)
# ---------------------------------------------------------------------------
o="$(run_case pressure-default '93
40')"
if [ "$(field "$o" size)" -lt 200 ] && [ "$(field "$o" trunc)" = 1 ]; then
  pass "(11b) at FAIL level disk_guard reclaims a job log through the built-in allowlist entry and moves the same counters the per-job bound does"
else
  bad  "(11b) the pressure reclaim did not truncate a job log: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (12) jobs_guard runs outside the converge lock, and while it is held
# ---------------------------------------------------------------------------
o="$(run_case guard-under-lock)"
guard_ln="$(grep -n '^  jobs_guard || true' "$BOXUP" | head -1 | cut -d: -f1)"
keep_ln="$(grep -n '^  keepawake_guard || true' "$BOXUP" | head -1 | cut -d: -f1)"
lock_ln="$(grep -n '^  run_with_converge_lock try do_tick' "$BOXUP" | head -1 | cut -d: -f1)"
if [ -n "$guard_ln" ] && [ -n "$keep_ln" ] && [ -n "$lock_ln" ] && \
   [ "$keep_ln" -lt "$guard_ln" ] && [ "$guard_ln" -lt "$lock_ln" ] && \
   [ "$(printf '%s\n' "$o" | sed -n 's/^guard_rc=//p')" = 0 ] && \
   [ "$(field "$o" size)" -lt 200 ] && [ "$(field "$o" trunc)" = 1 ]; then
  pass "(12) jobs_guard sits in run_tick right after keepawake_guard and BEFORE the converge lock, and does its work while another process holds that lock"
else
  bad  "(12) jobs_guard placement/behaviour under the lock wrong: guard=[$guard_ln] keepawake=[$keep_ln] lock=[$lock_ln] out=[$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (13) no new spawn primitive, and the wrapper's own argv shape
# ---------------------------------------------------------------------------
sd_start="$(grep -n '^spawn_detached() {' "$BOXUP" | head -1 | cut -d: -f1)"
sd_end="$(awk -v s="$sd_start" 'NR>=s && /^\}$/ {print NR; exit}' "$BOXUP")"
offenders=0
while IFS= read -r ln; do
  n="${ln%%:*}"; text="${ln#*:}"
  case "${text#"${text%%[![:space:]]*}"}" in \#*) continue ;; esac
  [ "$n" -ge "$sd_start" ] && [ "$n" -le "$sd_end" ] && continue
  offenders=$((offenders + 1))
done < <(grep -nE '\b(setsid|nohup|disown)\b' "$BOXUP")
if [ "$offenders" = 0 ] && \
   grep -q 'spawn_detached "\$rec/log" bash "\$SELF" job-wrapper "\$id"' "$BOXUP" && \
   ! grep -qE 'spawn_detached .*(sh|bash) -c .*job-wrapper' "$BOXUP"; then
  pass "(13) the job runner adds no spawn primitive outside spawn_detached, and launches the wrapper as 'bash <boxup> job-wrapper <id>' rather than through a shell"
else
  bad  "(13) spawn discipline broken: offenders=$offenders"
fi

# ---------------------------------------------------------------------------
# (14) after a swap the tick RE-TAKES the one-job slot, so the status tokens
# tell the truth again and the box refuses a second job   [mutants s1, s2]
# ---------------------------------------------------------------------------
o="$(run_case swap-retakes-slot)"
ok=1
[ "$(field "$o" before_state)"   = running ]                   || ok=0
[ "$(field "$o" before_tokens)"  = "job=SVCSLOT job_state=running" ] || ok=0
[ "$(field "$o" swap_state)"     = "lost:image-swap" ]         || ok=0
[ "$(field "$o" swap_slot)"      = NONE ]                      || ok=0
[ "$(field "$o" restart_state)"  = running ]                   || ok=0
[ "$(field "$o" restart_slot)"   = SVCSLOT ]                   || ok=0
[ "$(field "$o" restart_tokens)" = "job=SVCSLOT job_state=running" ] || ok=0
[ "$(field "$o" swap_rundir)"    = ABSENT ]                    || ok=0
[ "$(field "$o" restart_rundir)" = present ]                   || ok=0
[ "$(field "$o" second_rc)"      = 75 ]                        || ok=0
[ "$(field "$o" second_created)" = no ]                        || ok=0
[ "$(field "$o" second_wrappers)" = 0 ]                        || ok=0
printf '%s' "$(field "$o" second_out)" | grep -q 'job=busy' || ok=0
if [ "$ok" = 1 ]; then
  pass "(14) after a swap that DELETES the run dir the guard re-creates it, restarts the service and re-takes the slot: the tokens name it again and a second start is refused rc 75"
else
  bad  "(14) the slot was not re-taken on restart: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (14b) a restart never STEALS a slot another live job holds   [mutants s3, s4]
# ---------------------------------------------------------------------------
o="$(run_case slot-not-stolen)"
if [ "$(field "$o" holder_slot)"     = HOLDER ] && \
   [ "$(field "$o" svc_state_before)" = "lost:image-swap" ] && \
   [ "$(field "$o" slot_after)"       = HOLDER ] && \
   [ "$(field "$o" holder_state)"     = running ] && \
   [ "$(field "$o" svc_state_after)"  = "lost:image-swap" ] && \
   [ "$(field "$o" svc_wrappers)"     = 0 ] && \
   [ "$(field "$o" refusal_logged)" -ge 1 ]; then
  pass "(14b) a service whose restart would need a slot another LIVE job holds is not restarted and does not steal it; the refusal is logged and the next tick retries"
else
  bad  "(14b) the restart stole or ignored a live slot: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (15) the REAL entry point: run_tick, with the run dir ABSENT the way an image
# swap leaves it                                        [mutants g1, g2, g4]
# ---------------------------------------------------------------------------
o="$(run_case tick-restarts-after-swap)"
ok=1
[ "$(field "$o" pre_rundir)"  = ABSENT ]  || ok=0
[ "$(field "$o" pre_state)"   = "lost:image-swap" ] || ok=0
[ "$(field "$o" tick_rc)"     = 0 ]       || ok=0
[ "$(field "$o" post_state)"  = running ] || ok=0
[ "$(field "$o" post_slot)"   = SVCTICK ] || ok=0
[ "$(field "$o" post_tokens)" = "job=SVCTICK job_state=running" ] || ok=0
[ "$(field "$o" post_rundir)" = present ] || ok=0
[ "$(field "$o" second_rc)"   = 75 ]      || ok=0
[ "$(field "$o" restart_line)" -ge 1 ]    || ok=0
if [ "$ok" = 1 ]; then
  pass "(15) driven through the REAL run_tick with the run dir DELETED, the guard re-creates it, restarts the service, re-takes the slot, and the box refuses a second job"
else
  bad  "(15) run_tick did not recover a swapped-away service: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (15b) a tick that skips on a contended converge lock has still supervised
# jobs, because the guard runs before the lock is taken        [mutant g3]
# ---------------------------------------------------------------------------
o="$(run_case tick-contended-lock)"
if [ "$(field "$o" tick_rc)" = 0 ] && \
   [ "$(field "$o" state)"   = running ] && \
   [ "$(field "$o" slot)"    = SVCLOCK ] && \
   [ "$(field "$o" do_tick_ran)" = 0 ] && \
   [ "$(field "$o" hb)"      = written ]; then
  pass "(15b) a tick that SKIPS on a contended converge lock has still restarted the service and stamped hb — the guard runs before the lock, not inside it"
else
  bad  "(15b) job supervision was lost to a contended lock: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (15c) a claim that CANNOT take the slot is reported as such, and no restart
# happens                                                        [mutant g4]
# ---------------------------------------------------------------------------
o="$(run_case slot-path-unusable)"
if [ "$(field "$o" slot_is_file)"   = yes ] && \
   [ "$(field "$o" claim_rc)"       = 2 ] && \
   [ "$(field "$o" state)"          = "lost:image-swap" ] && \
   [ "$(field "$o" took_slot)"      = no ] && \
   [ "$(field "$o" wrappers)"       = 0 ] && \
   [ "$(field "$o" could_not_take)" -ge 1 ] && \
   [ "$(field "$o" wrong_held_msg)" = 0 ]; then
  pass "(15c) a slot path that cannot be created returns 2, blocks the restart, and logs 'could not TAKE' rather than the misleading 'held by ?' that made the 5.5.1 wedge unreadable"
else
  bad  "(15c) an unusable slot path was reported as a success or as contention: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# extra: the two status tokens, and the small surface (ls / usage / validation)
# ---------------------------------------------------------------------------
o="$(run_case tokens)"
if [ "$(field "$o" tokens_idle)" = "job=- job_state=-" ] && \
   [ "$(field "$o" tokens_running)" = "job=TOK job_state=running" ]; then
  pass "(t) 'boxup status' carries job= and job_state=, '-' when the box has no job"
else
  bad  "(t) status tokens wrong: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

o="$(run_case ls-and-usage)"
if printf '%s' "$(field "$o" ls)" | grep -q 'id=A state=done kind=run' && \
   printf '%s' "$(field "$o" ls)" | grep -q 'id=B state=lost:image-swap kind=service' && \
   [ "$(printf '%s\n' "$o" | sed -n 's/^bogus_rc=//p')" = 2 ] && \
   [ "$(printf '%s\n' "$o" | sed -n 's/^noargs_rc=//p')" = 2 ] && \
   [ "$(printf '%s\n' "$o" | sed -n 's/^badid_rc=//p')" = 2 ] && \
   [ "$(printf '%s\n' "$o" | sed -n 's/^badcap_rc=//p')" = 2 ] && \
   [ "$(printf '%s\n' "$o" | sed -n 's/^badkind_rc=//p')" = 2 ] && \
   [ "$(printf '%s\n' "$o" | sed -n 's/^nocmd_rc=//p')" = 2 ]; then
  pass "(u) 'job ls' lists every record with its derived state, and every malformed invocation is rc 2 (never a partial start)"
else
  bad  "(u) ls/usage/validation wrong: [$(printf '%s' "$o" | tr '\n' ' ')]"
fi

if [ "$fail" = 0 ]; then
  echo "ALL PASS (test-boxup-jobs.sh)"
  exit 0
fi
echo "FAILURES (test-boxup-jobs.sh)"
exit 1
