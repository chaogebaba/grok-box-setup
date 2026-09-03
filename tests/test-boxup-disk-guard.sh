#!/bin/bash
# test-boxup-disk-guard.sh — box-free coverage for boxup 5.3.2's root-disk
# pressure guard (blueprint boxup-disk-guard, G1/G2/G3, tests G5a/G5b).
# Run from anywhere:  bash tests/test-boxup-disk-guard.sh   (or: make test)
# Exit 0 = all pass, 1 = a failure. Needs no root and touches nothing outside
# its own mktemp dirs.
#
# Everything below drives the REAL functions extracted out of the repo-root
# `boxup` — no reimplementation. Only the environment around them is stubbed:
#
#   * `df` is a stub script on PATH that pops the next percent from a sequence
#     file, so a single disk_guard call can see 93% before truncation and 40%
#     after it (that is how the POST-truncation state write is proved).
#   * RUN_DIR / the log sink are mktemp paths.
#   * for check_reason ONLY, the two /proc/sys forwarding paths are rewritten to
#     fixture files. That substitution is ENVIRONMENT, not logic: ip_forward is
#     not overridable by any boxup env var, the predicate that reads it sits
#     BEFORE the disk predicate, and without the rewrite this test could only
#     pass on a host that already forwards (a box, not a laptop). No other line
#     of the extracted code is altered.
#
# The owner-switch (runuser/su) branch of disk_truncate_one cannot be exercised
# by a non-root unit test: the fixture files are owned by the user running the
# suite, so the "owner == me" branch is the one that runs, and that is exactly
# what this file asserts (plus a structural assertion that the switch exists).
# Mutant g1 (drop the owner switch) is killed LIVE by the gate on a real box,
# where fs.protected_regular denies root's truncate of /tmp/sand-host.log.
#
# What this covers:
#   (a1) 79% => ok, no truncation, state `79% ok <epoch>`
#   (a2) 80% => warn (>= WARN_PCT, boundary), no truncation
#   (a3) 90% => fail (>= FAIL_PCT, boundary; mutant g3 `>=`->`>` dies here)
#   (a4) 93% => fail + the allowlisted 2 MiB file truncated to 0, the log line
#        carries the PRE-truncation size and percent, and the state records the
#        POST-truncation percent
#   (a5) a NON-allowlisted path handed straight to disk_truncate_one is refused
#        and left intact (mutant g2 `disk_allowlisted` removed dies here)
#   (a6) a SYMLINK named on the allowlist is refused; its target is intact
#  (a6b) the SAME refusal with the min-bytes floor set BELOW the symlink's own
#        pathname length, so the `-L` line is the ONLY thing that can reject it
#   (a7) a file at/below the min-bytes floor is left intact
#   (a8) the 60s rate limit: a second disk_guard inside the window is a no-op
#   (a9) df unavailable => level unknown, no truncation, no crash
#   (b1) print_status emits `disk=` LAST, after tunnel=/tunnelfail=
#   (b2) print_status shows the bare `disk=NN%` at ok and `disk=NN%/fail` at fail
#   (b3) check_reason FAILs with a `disk NN% (after truncation)` reason and
#        do_check exits 1 printing that reason
#   (b4) check_reason emits the once/hour `check: WARN disk NN%` line at warn
#        and does NOT fail the check
#   (b5) the owner switch is structurally present (runuser then su)
#   (b7) require_root forwards the five documented disk knobs across its sudo
#        re-exec, so `BOXUP_DISK_FAIL_PCT=1 boxup once` from a normal shell is
#        not silently discarded
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
BOXUP="$ROOT/boxup"
fail=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; fail=1; }

[ -f "$BOXUP" ] || { echo "cannot find $BOXUP"; exit 1; }

MIB=1048576

# ---------------------------------------------------------------------------
# harness: build an inner script that puts a stub `df` on PATH, eval-extracts
# the REAL disk functions out of boxup, runs one scenario, and prints a flat
# result block.
#
# $1 = newline-separated percents the stub `df` returns, one per call (the LAST
#      one repeats forever). The literal word `broken` makes df exit 1.
# $2 = the scenario name (see the case block inside).
# ---------------------------------------------------------------------------
run_case() {
  local seq="$1" scenario="$2" inner
  inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
MIB=$MIB
WORK="\$(mktemp -d)"
RUN_DIR="\$WORK/run"; mkdir -p "\$RUN_DIR"
LOGLINES="\$WORK/log"; : > "\$LOGLINES"
BIN="\$WORK/bin"; mkdir -p "\$BIN"

# --- the df stub ----------------------------------------------------------
# Pops one percent per invocation from SEQ; the last line repeats. This is what
# lets a single disk_guard call observe 93% on the pre-truncation read and 40%
# on the post-truncation re-read.
printf '%s\n' '$seq' > "\$WORK/seq"
cat > "\$BIN/df" <<'DFEOF'
#!/bin/sh
seq="\$DISK_SEQ"; cur="\$DISK_SEQ_CUR"
i=\$(cat "\$cur" 2>/dev/null || echo 0); i=\$((i + 1)); echo "\$i" > "\$cur"
n=\$(wc -l < "\$seq")
[ "\$i" -gt "\$n" ] && i="\$n"
val=\$(sed -n "\${i}p" "\$seq")
[ "\$val" = broken ] && exit 1
echo 'Use%'
printf ' %s%%\n' "\$val"
DFEOF
chmod +x "\$BIN/df"
export DISK_SEQ="\$WORK/seq" DISK_SEQ_CUR="\$WORK/seqcur"
PATH="\$BIN:\$PATH"

# --- stubs around the extracted code --------------------------------------
log(){ printf '%s\n' "\$*" >> "\$LOGLINES"; }
have(){ command -v "\$1" >/dev/null 2>&1; }

# --- extract the REAL functions -------------------------------------------
extract_fn_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in disk_used_pct disk_level disk_allowlisted disk_truncate_one \\
          disk_guard disk_status_token; do
  eval "\$(extract_fn_from "\$BOXUP" "\$fn")"
done

# The guard's knobs. Defaults are 80/90/1GiB/(/tmp/sand-host.log)/60s; every
# scenario sets them explicitly so a default change cannot silently pass a test.
BOXUP_DISK_WARN_PCT=80
BOXUP_DISK_FAIL_PCT=90
BOXUP_DISK_TRUNCATE_MIN_BYTES=\$MIB          # 1 MiB floor for the fixtures
BOXUP_DISK_INTERVAL=60
DISK_STATE="\$RUN_DIR/disk"
DISK_STAMP="\$RUN_DIR/last-disk-guard"
DISK_WARN_STAMP="\$RUN_DIR/last-disk-warn"

# --- fixtures --------------------------------------------------------------
BIG="\$WORK/allowed.log"                       # 2 MiB, allowlisted
OTHER="\$WORK/not-allowed.log"                 # 2 MiB, NOT allowlisted
SMALL="\$WORK/small.log"                       # 1 MiB exactly (== the floor)
TARGET="\$WORK/symlink-target.log"             # 2 MiB, reached only via a link
LINK="\$WORK/allowed-link.log"                 # symlink -> TARGET, allowlisted
mk(){ head -c "\$2" /dev/zero > "\$1"; }
mk "\$BIG" \$((2 * MIB))
mk "\$OTHER" \$((2 * MIB))
mk "\$SMALL" \$MIB
mk "\$TARGET" \$((2 * MIB))
ln -s "\$TARGET" "\$LINK"

sz(){ stat -c %s "\$1" 2>/dev/null || echo -1; }

case "$scenario" in
  guard)
    DISK_GUARD_TRUNCATE="\$BIG"
    disk_guard; grc=\$?
    ;;
  guard-twice)
    # Two calls back to back: the second must be swallowed by the rate limit,
    # so the state file still holds the FIRST call's percent.
    DISK_GUARD_TRUNCATE="\$BIG"
    disk_guard; disk_guard; grc=\$?
    ;;
  guard-symlink)
    DISK_GUARD_TRUNCATE="\$LINK"
    disk_guard; grc=\$?
    ;;
  truncate-one-symlink-lowfloor)
    # The r1 gate's finding: with the floor at 1 MiB, deleting the \`-L\` refusal
    # SURVIVED, because \`stat -c %s\` does not follow a symlink and reports the
    # link's own pathname length (~26 bytes), which the floor then rejects for
    # the wrong reason. Drop the floor below that length and the \`-L\` line is
    # the only gate left: without it, \`-f\` (which DOES follow) passes, the size
    # check passes, and \`truncate\` follows the link and zeroes the TARGET.
    BOXUP_DISK_TRUNCATE_MIN_BYTES=4
    DISK_GUARD_TRUNCATE="\$LINK"
    disk_truncate_one "\$LINK" 93; grc=\$?
    ;;
  guard-small)
    DISK_GUARD_TRUNCATE="\$SMALL"
    disk_guard; grc=\$?
    ;;
  truncate-one-unlisted)
    # Hand a NON-allowlisted path straight to the mutator. This is the only way
    # to prove the allowlist gate is a gate rather than a side effect of the
    # caller happening to iterate the list (mutant g2).
    DISK_GUARD_TRUNCATE="\$BIG"
    disk_truncate_one "\$OTHER" 93; grc=\$?
    ;;
esac

# --- report ----------------------------------------------------------------
state=NONE; [ -f "\$DISK_STATE" ] && state="\$(cat "\$DISK_STATE")"
stamp=no; [ -f "\$DISK_STAMP" ] && stamp=yes
echo "rc=\${grc:-?} level=\$(disk_level "\$(disk_used_pct)") token=\$(disk_status_token) stamp=\$stamp"
echo "state:\$state"
echo "sizes:big=\$(sz "\$BIG") other=\$(sz "\$OTHER") small=\$(sz "\$SMALL") target=\$(sz "\$TARGET") link=\$([ -L "\$LINK" ] && echo symlink || echo GONE)"
echo "logstart:"
cat "\$LOGLINES"
echo "logend:"
rm -rf "\$WORK"
INNER
  timeout 60 bash "$inner"
  rm -f "$inner"
}

r1()   { printf '%s\n' "$1" | sed -n 1p; }
field(){ printf '%s' "$1" | sed -n "s/.*\\b$2=\\([^ ]*\\).*/\\1/p"; }
sizes(){ printf '%s\n' "$1" | sed -n 's/^sizes://p'; }
statel(){ printf '%s\n' "$1" | sed -n 's/^state://p'; }
logs() { printf '%s\n' "$1" | sed -n '/^logstart:$/,/^logend:$/p'; }

# ===========================================================================
# (a1) 79% => ok. Below BOTH thresholds: no truncation, and the state file
# records `79% ok <epoch>` so an operator (and a future brain column) can read
# the last observation without re-running df.
# ===========================================================================
o="$(run_case 79 guard)"
if [ "$(field "$(r1 "$o")" level)" = ok ] \
   && [ "$(field "$(r1 "$o")" token)" = "79%" ] \
   && [ "$(sizes "$o")" = "big=$((2 * MIB)) other=$((2 * MIB)) small=$MIB target=$((2 * MIB)) link=symlink" ] \
   && printf '%s' "$(statel "$o")" | grep -Eq '^79% ok [0-9]+$'; then
  pass "(a1) 79% => ok, nothing truncated, state '79% ok <epoch>'"
else
  bad  "(a1) 79% not clean ok: [$(r1 "$o")] state=[$(statel "$o")] [$(sizes "$o")]"
fi

# ===========================================================================
# (a2) 80% => warn EXACTLY ON the warn threshold, still no truncation. Only
# FAIL truncates; a warn that started truncating would destroy logs at 80% on
# every box in the fleet.
# ===========================================================================
o="$(run_case 80 guard)"
if [ "$(field "$(r1 "$o")" level)" = warn ] \
   && [ "$(field "$(r1 "$o")" token)" = "80%/warn" ] \
   && printf '%s' "$(statel "$o")" | grep -Eq '^80% warn [0-9]+$' \
   && [ "$(sizes "$o")" = "big=$((2 * MIB)) other=$((2 * MIB)) small=$MIB target=$((2 * MIB)) link=symlink" ]; then
  pass "(a2) 80% => warn at the boundary, no truncation, token 80%/warn"
else
  bad  "(a2) 80% not warn-without-truncation: [$(r1 "$o")] state=[$(statel "$o")] [$(sizes "$o")]"
fi

# ===========================================================================
# (a3) 90% => fail EXACTLY ON the fail threshold. This is mutant g3: flipping
# `-ge` to `-gt` in disk_level reports warn here and this assertion dies.
# The 2 MiB allowlisted file is truncated because 90 is already fail.
# ===========================================================================
o="$(run_case '90
90' guard)"
if [ "$(field "$(r1 "$o")" level)" = fail ] \
   && printf '%s' "$(statel "$o")" | grep -Eq '^90% fail [0-9]+$' \
   && printf '%s\n' "$(sizes "$o")" | grep -q 'big=0 '; then
  pass "(a3) 90% => fail at the boundary (>= not >), allowlisted file truncated  [mutant g3]"
else
  bad  "(a3) 90% did not fail/truncate at the boundary: [$(r1 "$o")] state=[$(statel "$o")] [$(sizes "$o")]"
fi

# ===========================================================================
# (a4) 93% => fail, the allowlisted 2 MiB file goes to 0, the log line carries
# the PRE-truncation size and percent, and the state file records the
# POST-truncation percent (the df stub returns 40 on the re-read). Recording
# the pre-truncation number would make `boxup check` fail a box the guard had
# already rescued.
# ===========================================================================
o="$(run_case '93
40' guard)"
lg="$(logs "$o")"
if printf '%s\n' "$(sizes "$o")" | grep -q "big=0 other=$((2 * MIB)) small=$MIB target=$((2 * MIB))" \
   && printf '%s' "$(statel "$o")" | grep -Eq '^40% ok [0-9]+$' \
   && printf '%s\n' "$lg" | grep -q "disk-guard: truncated .*allowed.log ($((2 * MIB)) B, root 93%)"; then
  pass "(a4) 93% => truncated to 0, log '(2097152 B, root 93%)', state records the POST-truncation 40% ok"
else
  bad  "(a4) fail-path wrong: [$(sizes "$o")] state=[$(statel "$o")] log=[$lg]"
fi

# ===========================================================================
# (a5) MUTANT g2. A non-allowlisted path handed straight to disk_truncate_one
# must be refused (rc 1) and left at 2 MiB. Deleting the `disk_allowlisted`
# call from disk_truncate_one makes this truncate the file and the test dies.
# Driving the mutator directly is the point: asserting only through disk_guard
# (which iterates the allowlist) would pass with the gate removed.
# ===========================================================================
o="$(run_case 93 truncate-one-unlisted)"
if [ "$(field "$(r1 "$o")" rc)" = 1 ] \
   && printf '%s\n' "$(sizes "$o")" | grep -q "other=$((2 * MIB))"; then
  pass "(a5) non-allowlisted path refused by disk_truncate_one (rc 1), file intact  [mutant g2]"
else
  bad  "(a5) non-allowlisted path was NOT refused: [$(r1 "$o")] [$(sizes "$o")]"
fi

# ===========================================================================
# (a6) A SYMLINK named on the allowlist is refused and its 2 MiB target is
# untouched. Following it would turn "truncate this log" into "truncate
# whatever an unprivileged writer in /tmp points this name at".
# ===========================================================================
o="$(run_case 93 guard-symlink)"
if printf '%s\n' "$(sizes "$o")" | grep -q "target=$((2 * MIB)) link=symlink"; then
  pass "(a6) allowlisted SYMLINK refused, target intact, link not replaced"
else
  bad  "(a6) symlink was followed or clobbered: [$(sizes "$o")]"
fi

# ===========================================================================
# (a6b) THE r1 GATE'S BLOCKER. Same refusal, but with the floor at 4 bytes —
# below the symlink's own pathname length — so no other condition can mask a
# missing `-L`. Deleting `[ -L "$f" ] && return 1` makes this truncate the
# 2 MiB target through the link, and the assertion dies. With the floor at
# 1 MiB (as (a6) has it) that same deletion survives, which is exactly what the
# gate caught.
# ===========================================================================
o="$(run_case 93 truncate-one-symlink-lowfloor)"
if [ "$(field "$(r1 "$o")" rc)" = 1 ] \
   && printf '%s\n' "$(sizes "$o")" | grep -q "target=$((2 * MIB)) link=symlink"; then
  pass "(a6b) symlink refused with the floor BELOW its pathname length — the -L line is the only gate  [reviewer mutant r2]"
else
  bad  "(a6b) symlink NOT refused on the -L line alone: [$(r1 "$o")] [$(sizes "$o")]"
fi

# ===========================================================================
# (a7) A file AT the min-bytes floor (1 MiB with the floor at 1 MiB) is left
# alone — the guard truncates what fills a disk, not every small log.
# ===========================================================================
o="$(run_case 93 guard-small)"
if printf '%s\n' "$(sizes "$o")" | grep -q "small=$MIB"; then
  pass "(a7) file at/below the min-bytes floor left intact"
else
  bad  "(a7) sub-floor file was truncated: [$(sizes "$o")]"
fi

# ===========================================================================
# (a8) The rate limit. Two disk_guard calls back to back: the second is
# swallowed, so the state still holds the FIRST call's percent (79) and not the
# second df value (10) the stub would have served.
# ===========================================================================
o="$(run_case '79
10' guard-twice)"
if printf '%s' "$(statel "$o")" | grep -Eq '^79% ok [0-9]+$' \
   && [ "$(field "$(r1 "$o")" stamp)" = yes ]; then
  pass "(a8) rate limit: the second disk_guard inside the window is a no-op"
else
  bad  "(a8) rate limit did not hold: state=[$(statel "$o")] [$(r1 "$o")]"
fi

# ===========================================================================
# (a9) df unavailable (exit 1): level `unknown`, token `disk=unknown`, nothing
# truncated, rc still 0. A broken df must never break a tick or, worse, be read
# as 0% and hide a full disk.
# ===========================================================================
o="$(run_case broken guard)"
if [ "$(field "$(r1 "$o")" level)" = unknown ] \
   && [ "$(field "$(r1 "$o")" token)" = unknown ] \
   && [ "$(field "$(r1 "$o")" rc)" = 0 ] \
   && printf '%s\n' "$(sizes "$o")" | grep -q "big=$((2 * MIB))"; then
  pass "(a9) df broken => level unknown, token disk=unknown, no truncation, rc 0"
else
  bad  "(a9) broken df not handled: [$(r1 "$o")] [$(sizes "$o")]"
fi

# ===========================================================================
# (b) the status line and the check predicate. Same technique, a wider stub set
# (print_status / check_reason pull in the rest of boxup's world).
# $1 = df percent, $2 = `status` or `check` or `docheck`.
# ===========================================================================
run_line() {
  local pct="$1" what="$2" inner
  inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
BOXUP="$BOXUP"
WORK="\$(mktemp -d)"
RUN_DIR="\$WORK/run"; mkdir -p "\$RUN_DIR"
LOGLINES="\$WORK/log"; : > "\$LOGLINES"
BIN="\$WORK/bin"; mkdir -p "\$BIN"
cat > "\$BIN/df" <<'DFEOF'
#!/bin/sh
echo 'Use%'
printf ' %s%%\n' "\$DISK_PCT"
DFEOF
chmod +x "\$BIN/df"
export DISK_PCT="$pct"
PATH="\$BIN:\$PATH"

# ipfwd fixtures: check_reason reads two /proc/sys paths that no boxup env var
# can redirect, and its ipfwd predicate sits BEFORE the disk predicate. The
# extraction below rewrites those two literal paths (and ONLY those) to these
# files so the earlier predicates can pass on a laptop as well as on a box.
printf '1\n' > "\$WORK/ipv4_fwd"
printf '1\n' > "\$WORK/ipv6_fwd"

BOXUP_VERSION=test
ROOT="\$WORK/root"; mkdir -p "\$ROOT"
STATE_DIR="\$ROOT/state/tailscale"
AUTHKEY_EXPIRES="\$ROOT/secrets/ts-authkey.expires"
WORKER_PID="\$RUN_DIR/worker.pid"
FREEZE_SECS=60
DISK_STATE="\$RUN_DIR/disk"
DISK_STAMP="\$RUN_DIR/last-disk-guard"
DISK_WARN_STAMP="\$RUN_DIR/last-disk-warn"
BOXUP_DISK_WARN_PCT=80
BOXUP_DISK_FAIL_PCT=90
BOXUP_DISK_TRUNCATE_MIN_BYTES=1048576
DISK_GUARD_TRUNCATE="\$WORK/nothing.log"

# A REAL process carrying a tailscaled argv bound to STATE_DIR. check_reason's
# "exactly one tailscaled on the statedir" predicate walks /proc/<pid>/cmdline,
# which no stub can fake, so the fixture is a real process (the same technique
# tests/test-boxup-tunnel-stray.sh uses). The trailing semicolon-colon matters:
# bash exec-optimizes a lone simple command under -c and would DISCARD the argv.
# The same pid doubles as the live worker, and a fresh hb passes the freeze
# predicate.
bash -c 'sleep 300; :' _ tailscaled --statedir "\$STATE_DIR" </dev/null >/dev/null 2>&1 &
wpid=\$!; echo "\$wpid" > "\$WORKER_PID"
date +%s > "\$RUN_DIR/hb"

log(){ printf '%s\n' "\$*" >> "\$LOGLINES"; }
have(){ command -v "\$1" >/dev/null 2>&1; }
# the world around print_status / check_reason: everything healthy, so the disk
# predicate is the ONLY thing that can fail the check.
read_ts_fields(){ backend=Running; online=yes; exitn=yes; ts_tags="tag:grok-box"; ts_keyexpiry=""; mapfail=0; }
read_box_name(){ echo grok-box-005; }
boxup_git_sha(){ echo abc1234; }
authkey_expiry_state(){ echo ok; }
tunnel_state(){ echo up; }
name_mismatch(){ return 1; }
has_peers(){ return 0; }
verify_node_identity(){ printf ''; }
resolved_config_tags(){ echo "tag:grok-box"; }
account_unlocked(){ return 0; }
host_keys_present(){ return 0; }
advertised_routes(){ printf '0.0.0.0/0\n::/0\n'; }
id(){ case "\$*" in *-u*) echo 0 ;; *-un*) command id -un ;; box|root) return 0 ;; *) command id "\$@" ;; esac; }
pgrep(){
  case "\$*" in
    *sshd*)       echo 4242 ;;
    *tailscaled*) echo "\$wpid" ;;
    *) return 1 ;;
  esac
}

extract_fn_from(){ awk -v fn="\$2" '\$0 ~ "^"fn"\\\\(\\\\) \\\\{"{i=1} i{print} i&&/^\}\$/{exit}' "\$1"; }
for fn in disk_used_pct disk_level disk_allowlisted disk_truncate_one \\
          disk_guard disk_status_token refresh_fail_count repair_fail_count \\
          tunnel_fail_count print_status do_check; do
  eval "\$(extract_fn_from "\$BOXUP" "\$fn")"
done
# check_reason, with ONLY the two un-redirectable /proc paths rewritten.
eval "\$(extract_fn_from "\$BOXUP" check_reason \\
  | sed -e "s#/proc/sys/net/ipv4/ip_forward#\$WORK/ipv4_fwd#" \\
        -e "s#/proc/sys/net/ipv6/conf/all/forwarding#\$WORK/ipv6_fwd#")"

case "$what" in
  status) print_status ;;
  check)  echo "reason=[\$(check_reason)]" ;;
  docheck) out="\$(do_check 2>>"\$LOGLINES")"; echo "docheck_rc=\$?"; echo "\$out" ;;
esac
echo "logstart:"; cat "\$LOGLINES"; echo "logend:"
command kill -9 "\$wpid" 2>/dev/null || true
rm -rf "\$WORK"
INNER
  timeout 60 bash "$inner" 2>/dev/null
  rm -f "$inner"
}

# ---------------------------------------------------------------------------
# (b1)/(b2) the status token: present, immediately after tunnel=/tunnelfail=,
# bare at ok and level-suffixed at fail. APPEND-ONLY is the contract that keeps
# grokfleet and every legacy reader unaffected (G3) — disk= must never MOVE, but
# a later feature may append after it, and boxup 5.4.0's keepawake tokens do
# exactly that. Both assertions therefore end their value at a space OR at
# end-of-line rather than pinning disk= to the end of the status line.
# ---------------------------------------------------------------------------
o="$(run_line 22 status)"; line="$(r1 "$o")"
if printf '%s\n' "$line" | grep -Eq ' tunnel=up tunnelfail=[0-9]+ disk=22%( |$)'; then
  pass "(b1) status: disk=22% comes immediately after tunnelfail="
else
  bad  "(b1) status token missing/misplaced: [$line]"
fi
o="$(run_line 93 status)"; line="$(r1 "$o")"
if printf '%s\n' "$line" | grep -Eq ' disk=93%/fail( |$)'; then
  pass "(b2) status: disk=93%/fail carries the level at fail"
else
  bad  "(b2) status fail token wrong: [$line]"
fi

# ---------------------------------------------------------------------------
# (b3) check: at fail the reason is the disk one and do_check exits 1 printing
# `check=FAIL reason=disk 93% (after truncation) …`. Every other predicate is
# stubbed healthy, so this is the disk predicate and nothing else.
# ---------------------------------------------------------------------------
o="$(run_line 93 check)"
if printf '%s\n' "$o" | grep -q 'reason=\[disk 93% (after truncation) want < 90%\]'; then
  pass "(b3a) check_reason at 93% => 'disk 93% (after truncation) want < 90%'"
else
  bad  "(b3a) wrong fail reason: [$(r1 "$o")]"
fi
o="$(run_line 93 docheck)"
if printf '%s\n' "$o" | grep -q 'docheck_rc=1' \
   && printf '%s\n' "$o" | grep -q 'check=FAIL reason=disk 93% (after truncation)'; then
  pass "(b3b) do_check exits 1 with 'check=FAIL reason=disk 93% (after truncation) …'"
else
  bad  "(b3b) do_check did not FAIL on disk: [$o]"
fi

# ---------------------------------------------------------------------------
# (b4) check at WARN: a `check: WARN disk 85%` line, but rc 0 and an EMPTY
# reason — warn is visibility, not a health failure. (The stamp lives in a
# fresh RUN_DIR here, so the once/hour throttle always lets the first one out.)
# ---------------------------------------------------------------------------
o="$(run_line 85 check)"
if printf '%s\n' "$o" | grep -q 'reason=\[\]' \
   && printf '%s\n' "$o" | grep -q 'check: WARN disk 85% (>= 80% warn threshold'; then
  pass "(b4a) check at 85%: WARN line emitted, reason stays EMPTY (rc unaffected)"
else
  bad  "(b4a) warn behaviour wrong: [$o]"
fi
o="$(run_line 85 docheck)"
if printf '%s\n' "$o" | grep -q 'docheck_rc=0' && printf '%s\n' "$o" | grep -q 'check=OK '; then
  pass "(b4b) do_check at 85% still exits 0 (warn is not a failure)"
else
  bad  "(b4b) warn flipped the check rc: [$o]"
fi

# ---------------------------------------------------------------------------
# (b5) MUTANT g1, structural half. The owner switch must be present: the
# non-owner path tries runuser and then su, and there is no root-truncate
# fallback. The BEHAVIOURAL half is a live box (fs.protected_regular), which a
# unit test cannot reproduce — see the header.
# ---------------------------------------------------------------------------
fn="$(awk '/^disk_truncate_one\(\) \{/{i=1} i{print} i&&/^\}$/{exit}' "$BOXUP")"
if printf '%s\n' "$fn" | grep -q 'runuser -u "\$owner" -- truncate -c -s 0' \
   && printf '%s\n' "$fn" | grep -q 'su -s /bin/sh "\$owner" -c' \
   && printf '%s\n' "$fn" | grep -q '\[ "\$owner" = "\$me" \]'; then
  pass "(b5) owner switch present: owner==me => plain truncate, else runuser, else su  [mutant g1]"
else
  bad  "(b5) owner switch missing or reshaped in disk_truncate_one"
fi

# ---------------------------------------------------------------------------
# (b7) The knobs survive the sudo re-exec. `boxup once` needs root, so a
# non-root invocation re-execs itself under `sudo env …` with an EXPLICIT
# variable list. Anything not on that list is silently dropped — the r1 gate
# found that `BOXUP_DISK_FAIL_PCT=1 boxup once` from a normal shell therefore
# did nothing at all, while looking like it worked.
#
# This drives the REAL require_root with a fake `sudo` on PATH that prints its
# argv instead of executing, so the forwarded environment is directly
# observable. `id` is stubbed non-root to reach the re-exec at all.
# ---------------------------------------------------------------------------
reexec_argv() {
  local inner; inner="$(mktemp)"
  cat > "$inner" <<INNER
set -u
W="\$(mktemp -d)"; BIN="\$W/bin"; mkdir -p "\$BIN"
printf '#!/bin/sh\nprintf "%%s\\n" "\$@"\n' > "\$BIN/sudo"
chmod +x "\$BIN/sudo"
PATH="\$BIN:\$PATH"
ROOT="\$W/box-setup"; SELF="\$W/boxup"
BOXUP_DISK_WARN_PCT=71
BOXUP_DISK_FAIL_PCT=72
BOXUP_DISK_TRUNCATE_MIN_BYTES=73
BOXUP_DISK_INTERVAL=74
DISK_GUARD_TRUNCATE=/tmp/canary-75.log
# boxup 5.4.0 forwards the two keepawake gateway seams on the same list; the
# extracted require_root runs under `set -u`, so they must exist here. Their own
# forwarding assertion lives in tests/test-boxup-keepawake.sh (14).
BOXUP_GATEWAY_URL=http://127.0.0.1:1340
BOXUP_GATEWAY_JSON=/home/box/sand-data/gateway.json
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
for kv in BOXUP_DISK_WARN_PCT=71 BOXUP_DISK_FAIL_PCT=72 \
          BOXUP_DISK_TRUNCATE_MIN_BYTES=73 BOXUP_DISK_INTERVAL=74 \
          DISK_GUARD_TRUNCATE=/tmp/canary-75.log; do
  printf '%s\n' "$argv" | grep -qx "$kv" || missing="$missing $kv"
done
# the pre-existing forwards must not regress
printf '%s\n' "$argv" | grep -q '^BOX_SETUP_ROOT=' || missing="$missing BOX_SETUP_ROOT"
if [ -z "$missing" ]; then
  pass "(b7) require_root forwards all five disk knobs (and BOX_SETUP_ROOT) across the sudo re-exec"
else
  bad  "(b7) knobs LOST at the sudo re-exec:$missing  — argv was: [$(printf '%s' "$argv" | tr '\n' ' ')]"
fi

# ---------------------------------------------------------------------------
# (b6) the guard is wired into run_tick OUTSIDE the converge lock, so a tick
# that skips on lock contention still watches the disk.
# ---------------------------------------------------------------------------
rt="$(awk '/^run_tick\(\) \{/{i=1} i{print} i&&/^\}$/{exit}' "$BOXUP")"
if printf '%s\n' "$rt" | grep -q 'disk_guard' \
   && [ "$(printf '%s\n' "$rt" | grep -n 'disk_guard' | head -1 | cut -d: -f1)" -lt \
        "$(printf '%s\n' "$rt" | grep -n 'run_with_converge_lock' | head -1 | cut -d: -f1)" ]; then
  pass "(b6) run_tick calls disk_guard BEFORE (and outside) the converge lock"
else
  bad  "(b6) disk_guard is not wired into run_tick ahead of the lock"
fi

echo
[ "$fail" = 0 ] && echo "ALL PASS (test-boxup-disk-guard.sh)" || echo "FAILURES (test-boxup-disk-guard.sh)"
exit "$fail"
