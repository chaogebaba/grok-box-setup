#!/bin/bash
# install.sh — seed /workspace/box-setup from this repo.
#
# Usage (on the box, as root or passwordless sudo):
#   git clone https://github.com/chaogebaba/grok-box-setup.git /tmp/grok-box-setup
#   sudo bash /tmp/grok-box-setup/install.sh
#   sudo /workspace/box-setup/boxup once
#
# Env:
#   BOX_SETUP_ROOT   install destination (default /workspace/box-setup)
#   BOX_SETUP_ONCE=1 run `boxup once` after install
#   BOX_SETUP_AUTHKEY=tskey-...   write secrets/ts-authkey (reusable, non-ephemeral)
#   BOX_SSH_PASSWORD=...          ssh password for root/box (else config.toml,
#                                 else 12345678)
#
# Never copies state/ from the repo. Never copies hostname. Never overwrites an
# existing config.toml. Cleans up the v4 script layout (dual copies at DEST
# root + DEST/scripts, /usr/local/sbin helpers) — v5 is one file, one copy.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${BOX_SETUP_ROOT:-/workspace/box-setup}"
# PREFIX lets a test install the PATH symlink into a throwaway root. Empty =>
# the real /. Mirrors vps/install-vps.sh, which has had it since F4. It affects
# ONLY the symlink directory below; $DEST is unchanged, because the link TARGET
# must resolve on the live system even under a scratch PREFIX.
PREFIX="${PREFIX:-}"

log() { echo "install: $*"; }

INSTALL_LOG="${BOX_SETUP_INSTALL_LOG:-/var/log/boxup-install.log}"
STATE_DIR_MIG="$DEST/state/tailscale"

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo env BOX_SETUP_ROOT="$DEST" \
      PREFIX="$PREFIX" \
      BOX_SETUP_ONCE="${BOX_SETUP_ONCE:-}" \
      BOX_SETUP_AUTHKEY="${BOX_SETUP_AUTHKEY:-}" \
      BOX_SETUP_GIT_SHA="${BOX_SETUP_GIT_SHA:-}" \
      BOX_SSH_PASSWORD="${BOX_SSH_PASSWORD:-}" \
      BOX_SETUP_INSTALL_LOG="$INSTALL_LOG" \
      bash "$0" "$@"
  fi
  echo "install: need root" >&2
  exit 1
fi

# F4 (box-8 r4 incident) — the disruptive tail (tailscaled recycle + restart +
# `boxup once`) tears down the tailnet, which on these boxes is the SAME
# interface an SSH install rides on. Run inline, the SIGTERM drops the SSH
# session and HUPs install.sh dead BEFORE it restarts tailscaled — box offline
# 25+ min, no self-heal until the hourly `once`. So the foreground copies files
# then re-execs THIS disruptive tail as a session-detached, HUP-immune process
# (setsid + `trap '' HUP`, output to $INSTALL_LOG) and returns 0 promptly. This
# branch IS that detached process; it never touches the file copy (already
# done) — it only performs recycle -> restart -> once and logs DONE.
#
# do_migration_recycle: the disruptive E1 recycle. Selects the exact-`--statedir`
# tailscaled, SIGTERM, poll ≤10s, SIGKILL, verify gone. Defined here so the
# detached branch can call it without running any foreground code.
do_migration_recycle() {
  bash "$DEST/boxup" stop >/dev/null 2>&1 || true
  local pid match i
  for pid in $(pgrep -x tailscaled 2>/dev/null || true); do
    # Exact-token match: split argv on NULs, require a LITERAL
    # `--statedir=$STATE_DIR_MIG` argument (not a prefix of a longer path, so
    # `--statedir=$STATE_DIR_MIG-other` is NOT selected).
    match=0
    while IFS= read -r -d '' arg; do
      [ "$arg" = "--statedir=$STATE_DIR_MIG" ] && match=1
    done < "/proc/$pid/cmdline" 2>/dev/null || true
    [ "$match" = 1 ] || continue
    log "E1 migration: SIGTERM tailscaled pid=$pid (exact --statedir=$STATE_DIR_MIG)"
    kill "$pid" 2>/dev/null || true
    # Poll up to 10s for graceful exit, then SIGKILL.
    i=0
    while [ "$i" -lt 50 ]; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2; i=$((i + 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      log "E1 migration: pid=$pid still alive after 10s — SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
      sleep 0.3
    fi
    if kill -0 "$pid" 2>/dev/null; then
      log "E1 migration: WARNING pid=$pid STILL alive after SIGKILL — the new daemon may not bind cleanly" >&2
    else
      log "E1 migration: pid=$pid gone"
    fi
  done
}

# run_detached_phase: the HUP-immune body. Order (F4): kill old (recycle) ->
# start new + converge (`boxup once`) -> log DONE. If a build change fired the
# migration we ALWAYS run `boxup once` afterwards even when BOX_SETUP_ONCE was
# not requested — otherwise we would have killed tailscaled and never restarted
# it, which is exactly the box-8 r4 brick. rc of `boxup once` is preserved in
# the log (201 = converge lock busy — surfaced, not faked; a clean once now
# exits 0 → DONE (rc=0), P2-2 5.2.0).
run_detached_phase() {
  trap '' HUP
  local migrate="${BOX_SETUP_MIGRATE:-0}" want_once="${BOX_SETUP_ONCE:-}" rc=0
  log "detached phase start (pid=$$, HUP-immune) migrate=$migrate once=${want_once:-0}"
  if [ "$migrate" = 1 ]; then
    log "E1 migration: build change ver ${BOX_SETUP_MIG_IVER:-none}->${BOX_SETUP_MIG_NVER:-?} sha ${BOX_SETUP_MIG_ISHA:-none}->${BOX_SETUP_MIG_NSHA:-?} — recycling tailscaled to clear any inherited converge-lock wedge"
    do_migration_recycle
  fi
  if [ "$migrate" = 1 ] || [ "$want_once" = 1 ]; then
    log "running boxup once"
    rc=0; bash "$DEST/boxup" once || rc=$?
    [ "$rc" = 0 ] || log "boxup once exited rc=$rc (rc≠0; 201 = converge lock busy — surfaced, not faked)"
  else
    log "next: sudo $DEST/boxup once"
    log "then follow $DEST/docs/AGENT.md"
  fi
  log "DONE (rc=$rc)"
  return 0
}

if [ "${BOX_SETUP_DETACHED:-}" = 1 ]; then
  run_detached_phase
  exit 0
fi

log "repo=$REPO_ROOT dest=$DEST"

# D2: the converge lock requires util-linux flock. Without it boxup would have
# to run converges/ticks UNLOCKED (mutual exclusion lost) — boxup now REFUSES
# that at runtime, so a box with no flock cannot converge at all. Fail the
# install loudly rather than deploy a box that can never self-heal.
if ! command -v flock >/dev/null 2>&1; then
  echo "install: FATAL — util-linux 'flock' not found. boxup's converge lock" >&2
  echo "install: requires it; without flock boxup refuses to run (D2). Install" >&2
  echo "install: util-linux (apt-get install -y util-linux) and re-run." >&2
  exit 1
fi

# Stop the old worker BEFORE replacing files: the running copy knows its own
# argv shape best. boxup's own reaper also recognizes v4 workers as a backstop.
if [ -x "$DEST/box-bootstrap.sh" ] && [ ! -f "$DEST/boxup" ]; then
  bash "$DEST/box-bootstrap.sh" --stop >/dev/null 2>&1 || true
fi

# E1 — one-shot version/sha-change tailscaled recycle. Before H1, tailscaled
# could inherit the converge-lock fd and hold it for life, wedging every tick.
# flock --close prevents that for NEW daemons but cannot free an ALREADY-leaked
# fd, and the two runtime detectors we tried were proven inert. Trigger on ANY
# build change — installed VERSION != new VERSION *OR* installed GIT_SHA != new
# GIT_SHA (F1(a), box-8 r3: a same-version reinstall with a different sha
# 5.1.0/059c658 -> 5.1.0/87e783b is a REAL upgrade, but a VERSION-only gate
# skipped it and left the pre-H1 daemon wedged). NOT a comment-marker heuristic
# — the marker keys on disk contents while the LIVE daemon is a separate
# generation. On a change we recycle tailscaled unconditionally: exact-token
# select, SIGTERM, poll up to 10s, SIGKILL, verify gone; the `boxup once` in the
# detached phase restarts it via the flock --close path. ~5s connectivity blip,
# bounded. Runs once per upgrade, never in a tick; no sentinel file. (NB: F1(b)
# also VERSIONS the lock path — converge.v2.lock — so even if this recycle is
# somehow skipped, a v2 tick flocks a different file and an inherited pre-H1
# daemon can no longer wedge it. Belt AND braces.)
#
# F4 (box-8 r4 incident): the recycle SIGTERM tears down tailscaled — and on
# these boxes the ONLY inbound route is the tailnet it serves, so an install
# run over SSH rides the very interface this kills. Running the recycle
# SYNCHRONOUSLY in the SSH-attached process dropped the tailnet, killed the SSH
# session, and HUP'd install.sh (its child) DEAD before it could restart
# tailscaled — box-8 sat offline 25+ min with no self-heal until the hourly
# `once`. Every install/update on this fleet rides the tailnet, so that is the
# NORMAL case. FIX: the recycle + restart + `boxup once` now run inside the
# SESSION-DETACHED, HUP-IMMUNE re-exec (run_detached_phase, near the top). Here
# in the foreground we only COMPUTE the migration DECISION — and it MUST happen
# BEFORE the file copy below overwrites $DEST/VERSION and $DEST/GIT_SHA.
#
# Compute the migration DECISION now, from the CURRENTLY installed files.
# MIGRATE=1 means the detached phase will call do_migration_recycle then
# `boxup once`.
installed_ver=""; [ -f "$DEST/VERSION" ] && installed_ver="$(tr -d '[:space:]' < "$DEST/VERSION" 2>/dev/null || true)"
new_ver=""; [ -f "$REPO_ROOT/VERSION" ] && new_ver="$(tr -d '[:space:]' < "$REPO_ROOT/VERSION" 2>/dev/null || true)"
installed_sha=""; [ -f "$DEST/GIT_SHA" ] && installed_sha="$(tr -d '[:space:]' < "$DEST/GIT_SHA" 2>/dev/null || true)"
# The new sha: fleetctl rollout sets $BOX_SETUP_GIT_SHA (git archive has no
# .git); else rev-parse the source tree (a `boxup update` clone has .git).
new_sha="${BOX_SETUP_GIT_SHA:-}"
[ -n "$new_sha" ] || new_sha="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
MIGRATE=0
if [ -f "$DEST/boxup" ] && { { [ -n "$new_ver" ] && [ "$installed_ver" != "$new_ver" ]; } \
     || { [ "$new_sha" != unknown ] && [ "$installed_sha" != "$new_sha" ]; }; }; then
  MIGRATE=1
fi

mkdir -p "$DEST"/{bin,docs,etc,secrets,state/tailscale,state/ssh}

# Atomic executable install (D3/M2): write to a UNIQUE mktemp file INSIDE $DEST
# then rename onto the destination. Same directory ⇒ rename(2) ⇒ atomic swap;
# a running bash keeps its fd on the old inode and finishes reading the old
# file uninterrupted (precedent: rustup / dpkg self-replace). A fixed dotfile
# name would let two concurrent installs (D5's hourly self-heal makes that
# plausible) truncate each other's partial write and then atomically install a
# corrupt file — mktemp gives each install its own scratch inode.
install_atomic() {
  local mode="$1" src="$2" dst="$3" tmp
  tmp="$(mktemp "$(dirname "$dst")/.install.XXXXXX")" || return 1
  if ! install -m "$mode" "$src" "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$dst"
}

# Refuse to install a boxup that lost its tail sentinel (D5): the shim's
# corruption predicate keys on `# boxup-eof` being the literal last line, and a
# truncated boxup still parses (bash -n stops at a statement boundary) and
# execs silently. Refuse LOUDLY and leave the existing installed boxup
# untouched — we check BEFORE writing, and install_atomic's rename ordering
# means a refusal never half-replaces the live file.
if [ "$(tail -n1 "$REPO_ROOT/boxup")" != "# boxup-eof" ]; then
  echo "install: FATAL — $REPO_ROOT/boxup is missing its '# boxup-eof' tail sentinel;" >&2
  echo "install: refusing to install a possibly-truncated boxup. Existing install left untouched." >&2
  exit 1
fi

install_atomic 0755 "$REPO_ROOT/boxup" "$DEST/boxup"
install_atomic 0755 "$REPO_ROOT/box-bootstrap.sh" "$DEST/box-bootstrap.sh"
install_atomic 0755 "$REPO_ROOT/install.sh" "$DEST/install.sh"
install -m 0644 "$REPO_ROOT/etc/config.example.toml" "$DEST/etc/config.example.toml"
install -m 0644 "$REPO_ROOT/docs/"*.md "$DEST/docs/" 2>/dev/null || true
install -m 0644 "$REPO_ROOT/README.md" "$DEST/README.md" 2>/dev/null || true
install -m 0644 "$REPO_ROOT/VERSION" "$DEST/VERSION" 2>/dev/null || true

# Stamp the installed git sha (D10). Sources, in order: $BOX_SETUP_GIT_SHA
# (set by fleetctl rollout, whose git archive carries no .git); a rev-parse of
# the source tree ($REPO_ROOT — `boxup update`'s clone has .git); else
# "unknown". Boxup surfaces it in status as v=<version>/<sha>.
box_git_sha="${BOX_SETUP_GIT_SHA:-}"
if [ -z "$box_git_sha" ]; then
  box_git_sha="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
fi
[ -n "$box_git_sha" ] || box_git_sha="unknown"
printf '%s\n' "$box_git_sha" > "$DEST/GIT_SHA"
chmod 0644 "$DEST/GIT_SHA" 2>/dev/null || true
log "stamped GIT_SHA=$box_git_sha"

# config.toml is the user's, not ours. Seed it once, never overwrite it, so a
# custom ssh password survives every later install.
if [ ! -e "$DEST/config.toml" ]; then
  install -m 0600 "$REPO_ROOT/etc/config.example.toml" "$DEST/config.toml"
  log "seeded config.toml (defaults; edit [ssh].password to change the login)"
else
  chmod 0600 "$DEST/config.toml" 2>/dev/null || true
  log "kept existing config.toml"
fi

[ -e "$DEST/hostname" ] || : > "$DEST/hostname"

if [ -n "${BOX_SETUP_AUTHKEY:-}" ]; then
  umask 077
  printf '%s\n' "$BOX_SETUP_AUTHKEY" > "$DEST/secrets/ts-authkey"
  chmod 600 "$DEST/secrets/ts-authkey"
  umask 022
  log "wrote secrets/ts-authkey"
fi

chmod 700 "$DEST/state" "$DEST/state/tailscale" "$DEST/state/ssh" \
  "$DEST/secrets" 2>/dev/null || true

# --- v4 cleanup --------------------------------------------------------------
# One copy of one file replaces eight scripts installed twice. Remove the old
# layout so nothing stale can ever be executed again. Never touches state/,
# secrets/, bin/, hostname or config.toml.
V4_SCRIPTS="start-tailscaled.sh tailscale-selfheal.sh ensure-ip-forward.sh \
  refresh-exitnode-if-needed.sh health-tick-forward.sh \
  tailscale-exitnode-nat.sh pick-name.sh"
for s in $V4_SCRIPTS; do
  rm -f "$DEST/$s" "/usr/local/sbin/$s" || true
done
rm -f /usr/local/sbin/box-bootstrap.sh /usr/local/sbin/tailscaled || true
rm -rf "${DEST:?}/scripts" "${DEST:?}/lib" /usr/local/sbin/lib || true
rm -f "$DEST/RUNBOOK.md" "$DEST/etc/default-tailscaled" /etc/default/tailscaled || true

# Reap any surviving v4 selfheal worker (boxup recognizes the old argv too).
bash "$DEST/boxup" stop >/dev/null 2>&1 || true

log "installed boxup $(cat "$DEST/VERSION" 2>/dev/null || echo '?') at $DEST"

# bug-triage (6): put boxup on PATH. Until now this installer never did —
# `grep 'ln -s' install.sh` had zero hits, every operator hint in this file is
# absolute, and boxup's own `export PATH` (boxup:36) only covers ITS children.
# The practical cost is that `boxup status` over ssh on 003/004 required the
# full /workspace/box-setup/boxup. vps/install-vps.sh has linked grokfleet into
# /usr/local/bin since F4; the box side never got the equivalent.
#
# mkdir -p + `ln -sfn` so a re-run is idempotent (and replaces a stale link
# from an install with a different $DEST). The TARGET is the REAL, non-PREFIX
# $DEST path: under a PREFIX= scratch install only the LINK moves, so a test
# never writes to the live /usr/local/bin and a real install never points at a
# scratch tree. Both halves are `|| true`: a read-only /usr is a reason to skip
# the convenience link, never to fail an install that already succeeded.
BIN_LINK_DIR="$PREFIX/usr/local/bin"
if mkdir -p "$BIN_LINK_DIR" 2>/dev/null && ln -sfn "$DEST/boxup" "$BIN_LINK_DIR/boxup" 2>/dev/null; then
  log "linked $BIN_LINK_DIR/boxup -> $DEST/boxup"
else
  log "could not link $BIN_LINK_DIR/boxup -> $DEST/boxup (not fatal; use $DEST/boxup)"
fi

# F4 — hand the disruptive tail to a session-detached, HUP-immune process.
# Disruptive work is pending when the build changed (MIGRATE=1 ⇒ tailscaled
# recycle) OR `boxup once` was requested. Neither is safe to run inline over an
# SSH session riding the tailnet (box-8 r4). We copied every file already
# (order: copy files → detach → kill old → start new → once → DONE), so the
# detached process only needs the recycle decision + the once flag, passed via
# env. The foreground prints the reconnect guidance BEFORE the tailnet drops
# and returns 0 promptly with a pointer to the log.
if [ "$MIGRATE" = 1 ] || [ "${BOX_SETUP_ONCE:-}" = 1 ]; then
  : > "$INSTALL_LOG" 2>/dev/null || true
  chmod 600 "$INSTALL_LOG" 2>/dev/null || true
  if [ "$MIGRATE" = 1 ]; then
    log "the tailnet will drop for ~20s during the tailscaled recycle; reconnect and run \`sudo $DEST/boxup status\` (progress in $INSTALL_LOG)"
  else
    log "converging in the background; reconnect and run \`sudo $DEST/boxup status\` (progress in $INSTALL_LOG)"
  fi
  # setsid ⇒ new session, no controlling terminal, immune to the SSH SIGHUP;
  # run_detached_phase also `trap '' HUP` belt-and-braces. stdio → the log.
  # setsid appears in install.sh (not boxup); the H9 lint is scoped to boxup.
  setsid env BOX_SETUP_DETACHED=1 \
    BOX_SETUP_ROOT="$DEST" \
    BOX_SETUP_ONCE="${BOX_SETUP_ONCE:-}" \
    BOX_SETUP_INSTALL_LOG="$INSTALL_LOG" \
    BOX_SETUP_MIGRATE="$MIGRATE" \
    BOX_SETUP_MIG_IVER="$installed_ver" BOX_SETUP_MIG_NVER="$new_ver" \
    BOX_SETUP_MIG_ISHA="$installed_sha" BOX_SETUP_MIG_NSHA="$new_sha" \
    bash "$DEST/install.sh" >>"$INSTALL_LOG" 2>&1 < /dev/null &
  log "detached installer running (pid=$!); returning now — see $INSTALL_LOG for DONE"
else
  log "next: sudo $DEST/boxup once"
  log "then follow $DEST/docs/AGENT.md"
fi

exit 0
