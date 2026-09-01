#!/bin/bash
# test-boxup-tunnel-stray.sh — box-free coverage for boxup 5.3.1's
# "supervise_tunnel adopts or kills a stray same-port tunnel" (blueprint
# boxup-tunnel-stray-adopt, D1/D2/D3/D5). Run from anywhere:
#   bash tests/test-boxup-tunnel-stray.sh   (or: make test)
# Exit 0 = all pass, 1 = a failure.
#
# Everything here drives the REAL functions extracted out of the repo-root
# `boxup` — no reimplementation. The candidate processes are REAL processes
# carrying the tunnel argv (the same technique the M9/M10 selector tests use),
# so the /proc/<pid>/cmdline NUL-token walk and the /proc/<pid>/stat start-time
# comparison run against real kernel data. Only the environment around them is
# stubbed: config_get/fleet_port/fleet_configured, log, spawn_detached, and a
# `kill` wrapper that RECORDS the exact pid of every signal before really
# sending it.
#
# What this covers (D5):
#   (a) one stray, no pidfile      => adopted, pidfile=stray, fail.tunnel reset, NO spawn
#   (b) two candidates             => NEWEST kept, the other TERMed by exact pid
#   (c) right -R but wrong key,
#       and right key but wrong port => NOT candidates; spawn path runs; decoys live
#   (d) zero candidates            => spawn path exactly as before (fails++, backoff stamp)
#   (e) status line carries tunnelfail=N
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
BOXUP="$ROOT/boxup"
fail=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; fail=1; }

[ -f "$BOXUP" ] || { echo "cannot find $BOXUP"; exit 1; }

# ---------------------------------------------------------------------------
# harness: build an inner script that eval-extracts the REAL tunnel functions
# out of boxup, stubs the world around them, spawns the requested candidate /
# decoy processes, runs supervise_tunnel once, and prints a flat result line.
#
# $1 = the "processes" spec: newline-separated `label|port|key` triples. `key`
#      is `real` (the fixture key path) or any other literal path. Each becomes
#      one live process whose argv carries `-R 127.0.0.1:<port>:localhost:22`
#      and `-i <key>`, spawned in the listed order (so the LAST one is newest).
# $2 = initial fail.tunnel contents ("" => file absent)
# $3 = initial tunnel.pid contents  ("" => file absent)
# ---------------------------------------------------------------------------
PORT=20005
run_supervise() {
  local procs="$1" initfail="$2" initpid="$3" inner
  inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
PORT="$PORT"
WORK="\$(mktemp -d)"
RUN_DIR="\$WORK/run"; mkdir -p "\$RUN_DIR"
TUNNEL_PID="\$RUN_DIR/tunnel.pid"
TUNNEL_KEY="\$WORK/tunnel_ed25519"; : > "\$TUNNEL_KEY"
TUNNEL_LOG="\$WORK/tunnel.log"
EVENTS="\$WORK/events"; : > "\$EVENTS"
LOGLINES="\$WORK/log"; : > "\$LOGLINES"
[ -n "$initfail" ] && echo "$initfail" > "\$RUN_DIR/fail.tunnel"

# --- spawn the candidate / decoy processes --------------------------------
# Real processes: the argv tokens below land in /proc/<pid>/cmdline exactly as
# NUL-separated words (they are ignored positional params of the -c script).
pids=""; labels=""
while IFS='|' read -r label lport lkey; do
  [ -n "\$label" ] || continue
  case "\$lkey" in real) lkey="\$TUNNEL_KEY" ;; esac
  # NB: the trailing \`; :\` matters — bash exec-optimizes a lone simple command
  # under -c, which would replace the process image and DISCARD this argv.
  bash -c 'sleep 30; :' _ -N -T -o ExitOnForwardFailure=yes \\
      -i "\$lkey" -R "127.0.0.1:\$lport:localhost:22" -p 22 fleet@vps \\
      </dev/null >/dev/null 2>&1 &
  p=\$!
  pids="\$pids \$p"; labels="\$labels \$label:\$p"
  eval "PID_\$label=\$p"
  command sleep 0.35        # distinct /proc stat field-22 start times
done <<'PROCS'
$procs
PROCS
[ -n "$initpid" ] && echo "$initpid" > "\$TUNNEL_PID"

# --- stubs -----------------------------------------------------------------
fleet_configured(){ return 0; }
config_get(){ case "\$1 \$2" in "fleet vps") echo vps.example ;; "fleet port") echo 22 ;; *) return 1 ;; esac; }
fleet_port(){ echo "\$PORT"; }
ensure_tunnel_key(){ return 0; }
log(){ printf '%s\n' "\$*" >> "\$LOGLINES"; }
spawn_detached(){ echo "SPAWN" >> "\$EVENTS"; }
sleep(){ command sleep 0.2; }     # collapse the 1s KILL sweep / 0.3s settle
pgrep(){ case "\$*" in *ssh*) printf '%s\n' \$pids ;; *) return 1 ;; esac; }
kill(){
  case "\$1" in
    -0)     command kill -0 "\$2" 2>/dev/null; return \$? ;;
    -KILL)  echo "KILL:\$2" >> "\$EVENTS"; command kill -KILL "\$2" 2>/dev/null; return 0 ;;
    -TERM)  echo "TERM:\$2" >> "\$EVENTS"; command kill -TERM "\$2" 2>/dev/null; return 0 ;;
    -*)     echo "SIG\$1:\$2" >> "\$EVENTS"; command kill "\$1" "\$2" 2>/dev/null; return 0 ;;
    *)      echo "TERM:\$1" >> "\$EVENTS"; command kill "\$1" 2>/dev/null; return 0 ;;
  esac
}

extract_fn_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in tunnel_candidates tunnel_starttime tunnel_newest tunnel_pid \\
          tunnel_backoff_window tunnel_fail_count supervise_tunnel; do
  eval "\$(extract_fn_from "\$BOXUP" "\$fn")"
done

supervise_tunnel
rc=\$?

# --- report ----------------------------------------------------------------
# NB: `2>/dev/null` on the reader does NOT silence a missing-file redirect (the
# SHELL prints that, not the command), so guard with -f instead.
pidfile=""; [ -f "\$TUNNEL_PID" ] && pidfile="\$(tr -d '[:space:]' < "\$TUNNEL_PID")"
failn=NONE; [ -f "\$RUN_DIR/fail.tunnel" ] && failn="\$(tr -d '[:space:]' < "\$RUN_DIR/fail.tunnel")"
spawned=no; grep -q '^SPAWN\$' "\$EVENTS" && spawned=yes
adopted=no; grep -q 'adopted stray' "\$LOGLINES" && adopted=yes
stamp=no; [ -f "\$RUN_DIR/last-tunnel" ] && stamp=yes
termed=""; while IFS= read -r l; do case "\$l" in TERM:*|KILL:*) termed="\$termed \${l#*:}" ;; esac; done < "\$EVENTS"
alive=""
for p in \$pids; do command kill -0 "\$p" 2>/dev/null && alive="\$alive \$p"; done
echo "rc=\$rc pidfile=\$pidfile fail=\$failn spawned=\$spawned adopted=\$adopted stamp=\$stamp"
echo "labels:\$labels"
echo "signalled:\$termed"
echo "alive:\$alive"
exec 2>/dev/null        # the shell's async "Killed" job notices, not an error
for p in \$pids; do command kill -9 "\$p" 2>/dev/null || true; done
wait 2>/dev/null || true
rm -rf "\$WORK"
INNER
  timeout 60 bash "$inner"
  rm -f "$inner"
}

# label_pid <labels-line> <label> -> the pid we spawned for that label
label_pid() {
  local line="$1" want="$2" tok
  for tok in ${line#labels:}; do
    case "$tok" in "$want":*) printf '%s' "${tok#*:}"; return 0 ;; esac
  done
  return 1
}
field() { printf '%s' "$1" | sed -n "s/.*\\b$2=\\([^ ]*\\).*/\\1/p"; }

# ---------------------------------------------------------------------------
# (a) one stray with our exact argv and NO pidfile => ADOPTED. The pidfile must
# name the stray, fail.tunnel must be reset to 0 (this is what stops the
# backoff ladder from parking the box), and NOTHING may be spawned. Deleting
# the adopt branch, or dropping the fail.tunnel reset, flips this.
# ---------------------------------------------------------------------------
outa="$(run_supervise 'stray|20005|real' 4 '')"
a1="$(printf '%s\n' "$outa" | sed -n 1p)"
alab="$(printf '%s\n' "$outa" | sed -n 2p)"
stray="$(label_pid "$alab" stray)"
if [ "$(field "$a1" pidfile)" = "$stray" ] && [ "$(field "$a1" fail)" = 0 ] \
   && [ "$(field "$a1" spawned)" = no ] && [ "$(field "$a1" adopted)" = yes ]; then
  pass "(a) lone stray adopted: pidfile=stray, fail.tunnel reset to 0, no spawn"
else
  bad "(a) stray NOT adopted (want pidfile=$stray fail=0 spawned=no adopted=yes): [$a1]"
fi

# ---------------------------------------------------------------------------
# (b) two candidates => the NEWEST is kept and the other is signalled BY EXACT
# PID. Keeping the oldest instead flips the pidfile assertion; a `pkill -f`
# style sweep would signal both.
# ---------------------------------------------------------------------------
outb="$(run_supervise 'old|20005|real
new|20005|real' 3 '')"
b1="$(printf '%s\n' "$outb" | sed -n 1p)"
blab="$(printf '%s\n' "$outb" | sed -n 2p)"
bsig="$(printf '%s\n' "$outb" | sed -n 3p)"; bsig="${bsig#signalled:}"
balive="$(printf '%s\n' "$outb" | sed -n 4p)"; balive="${balive#alive:}"
bold="$(label_pid "$blab" old)"; bnew="$(label_pid "$blab" new)"
sig_old=no; sig_new=no; live_new=no
for p in $bsig; do [ "$p" = "$bold" ] && sig_old=yes; [ "$p" = "$bnew" ] && sig_new=yes; done
for p in $balive; do [ "$p" = "$bnew" ] && live_new=yes; done
if [ "$(field "$b1" pidfile)" = "$bnew" ] && [ "$sig_old" = yes ] \
   && [ "$sig_new" = no ] && [ "$live_new" = yes ] && [ "$(field "$b1" spawned)" = no ]; then
  pass "(b) two candidates: NEWEST kept (pidfile+alive), the older TERMed by exact pid, no spawn"
else
  bad "(b) wrong survivor/kill (keep=$bnew drop=$bold): [$b1] signalled:[$bsig] alive:[$balive]"
fi

# ---------------------------------------------------------------------------
# (c) NEITHER a right-port-wrong-key process NOR a right-key-wrong-port process
# is a candidate. Both must survive untouched and the spawn path must run.
# Matching on `-R` alone (dropping the -i check) makes the wrong-key decoy a
# candidate and suppresses the spawn — this test is what catches that.
# ---------------------------------------------------------------------------
outc="$(run_supervise 'wrongkey|20005|/tmp/some-other-key
wrongport|20009|real' '' '')"
c1="$(printf '%s\n' "$outc" | sed -n 1p)"
clab="$(printf '%s\n' "$outc" | sed -n 2p)"
csig="$(printf '%s\n' "$outc" | sed -n 3p)"; csig="${csig#signalled:}"
calive="$(printf '%s\n' "$outc" | sed -n 4p)"; calive="${calive#alive:}"
ck="$(label_pid "$clab" wrongkey)"; cp="$(label_pid "$clab" wrongport)"
live_k=no; live_p=no
for p in $calive; do [ "$p" = "$ck" ] && live_k=yes; [ "$p" = "$cp" ] && live_p=yes; done
if [ "$(field "$c1" spawned)" = yes ] && [ "$(field "$c1" adopted)" = no ] \
   && [ "$live_k" = yes ] && [ "$live_p" = yes ] && [ -z "$(printf '%s' "$csig" | tr -d ' ')" ]; then
  pass "(c) wrong-key and wrong-port decoys are NOT candidates: untouched, spawn path runs"
else
  bad "(c) decoy mishandled (wrongkey=$ck wrongport=$cp): [$c1] signalled:[$csig] alive:[$calive]"
fi

# ---------------------------------------------------------------------------
# (d) zero candidates => the pre-5.3.1 spawn path, unchanged: fail.tunnel
# increments (2 -> 3) and last-tunnel is stamped for the backoff window.
# ---------------------------------------------------------------------------
outd="$(run_supervise '' 2 '')"
d1="$(printf '%s\n' "$outd" | sed -n 1p)"
if [ "$(field "$d1" spawned)" = yes ] && [ "$(field "$d1" fail)" = 3 ] \
   && [ "$(field "$d1" stamp)" = yes ] && [ "$(field "$d1" adopted)" = no ]; then
  pass "(d) zero candidates: spawn path exactly as before (fail.tunnel 2->3, backoff stamped)"
else
  bad "(d) spawn path changed with no candidates (want spawned=yes fail=3 stamp=yes): [$d1]"
fi

# ---------------------------------------------------------------------------
# (d2) steady state: one candidate, fail.tunnel already 0. It must be left
# completely alone — never signalled, never respawned — and the counter stays
# 0. This is the every-tick path on a healthy box, so a regression here would
# TERM the live tunnel once per tick.
# ---------------------------------------------------------------------------
oute="$(run_supervise 'mine|20005|real' 0 '')"
e1="$(printf '%s\n' "$oute" | sed -n 1p)"
esig="$(printf '%s\n' "$oute" | sed -n 3p)"; esig="${esig#signalled:}"
if [ "$(field "$e1" spawned)" = no ] && [ "$(field "$e1" fail)" = 0 ] \
   && [ -z "$(printf '%s' "$esig" | tr -d ' ')" ]; then
  pass "(d2) a single candidate is never signalled and never respawned (steady state)"
else
  bad "(d2) lone candidate disturbed: [$e1] signalled:[$esig]"
fi

# ---------------------------------------------------------------------------
# (e) D3 — the status line carries `tunnelfail=N` next to `tunnel=`. Drives the
# REAL print_status with the REAL tunnel_state / tunnel_pid / tunnel_fail_count
# extracted from boxup; only the unrelated helpers are stubbed.
# ---------------------------------------------------------------------------
status_line() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
WORK="\$(mktemp -d)"
RUN_DIR="\$WORK/run"; mkdir -p "\$RUN_DIR"
TUNNEL_PID="\$RUN_DIR/tunnel.pid"
WORKER_PID="\$RUN_DIR/worker.pid"
BOXUP_VERSION=test
echo "$1" > "\$RUN_DIR/fail.tunnel"
fleet_configured(){ return 0; }
read_ts_fields(){ backend=Running; online=yes; exitn=yes; ts_tags=tag:grok-box; ts_keyexpiry=""; auth=""; }
read_box_name(){ echo grok-box-005; }
boxup_git_sha(){ echo abc1234; }
refresh_fail_count(){ echo 0; }
repair_fail_count(){ echo 0; }
authkey_expiry_state(){ echo ok; }
pgrep(){ return 1; }
extract_fn_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in tunnel_pid tunnel_state tunnel_fail_count print_status; do
  eval "\$(extract_fn_from "\$BOXUP" "\$fn")"
done
print_status
rm -rf "\$WORK"
INNER
  timeout 20 bash "$inner"; rm -f "$inner"
}
sl="$(status_line 7)"
case "$sl" in
  *"tunnel=down tunnelfail=7"*) pass "(e) status line shows tunnelfail=N beside tunnel= (tunnel=down tunnelfail=7)" ;;
  *) bad "(e) status line missing tunnelfail=7: [$sl]" ;;
esac
sl0="$(status_line 0)"
case "$sl0" in
  *"tunnel=down tunnelfail=0"*) pass "(e) a healthy counter still prints tunnelfail=0 (field always present)" ;;
  *) bad "(e) tunnelfail=0 not printed: [$sl0]" ;;
esac

# ---------------------------------------------------------------------------
# (f) house rule: the tunnel supervisor must never use pkill, and must not have
# regressed to a `pgrep -f` argv-substring match.
# ---------------------------------------------------------------------------
# Comment lines are stripped first: the house rule itself is written down in
# boxup's header, and the removed `pgrep -n -f` is named in a comment.
codehits="$(grep -vE '^[[:space:]]*#' "$BOXUP" | grep -nE 'pkill|pgrep[[:space:]]+(-[a-z]+[[:space:]]+)*-f' || true)"
if [ -z "$codehits" ]; then
  pass "(f) boxup CODE uses neither pkill nor pgrep -f (per-pid /proc selection only)"
else
  bad "(f) boxup regressed to pkill / pgrep -f: [$(printf '%s' "$codehits" | head -3)]"
fi

if [ "$fail" = 0 ]; then echo "ALL PASS"; else echo "SOME FAILED"; fi
exit "$fail"
