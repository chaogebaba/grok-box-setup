#!/bin/bash
# test-install-boxup-symlink.sh — install.sh puts boxup on PATH
# (bug-triage (6): `grep 'ln -s' install.sh` used to return zero hits, so every
# operator hint was absolute and `boxup status` over ssh needed the full
# /workspace/box-setup/boxup).
# Run from anywhere:  bash tests/test-install-boxup-symlink.sh   (or: make test)
# Exit 0 = all pass, 1 = a failure. Needs no root and writes only under mktemp.
#
# This drives the REAL repo-root install.sh end to end against a throwaway repo
# and a throwaway DEST, using the same technique as the F4 e2e test in
# tests/test-iter3-fixes.sh: PATH shims for `id` (reports root) and `pgrep`
# (no tailscaled ⇒ no recycle work), plus a fake `boxup` carrying the
# `# boxup-eof` sentinel the installer refuses to install without.
#
# PREFIX is what makes the assertion safe to run anywhere: the LINK goes under
# a scratch root while its TARGET stays the real $DEST path, so the suite never
# writes to the machine's /usr/local/bin and a real install can never point at
# a scratch tree.
#
# What this covers:
#   (1) the link exists, IS a symlink, and resolves to the installed boxup
#   (2) the target is the REAL $DEST/boxup, never PREFIX-rooted
#   (3) a second install is idempotent — still one symlink, same target
#   (4) a re-install with a DIFFERENT $DEST repoints the link (ln -sfn, not
#       ln -s, which would fail on an existing link and leave it stale)
#   (5) install.sh forwards PREFIX across its sudo re-exec, so a non-root
#       PREFIX install cannot silently write to the real /usr/local/bin
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
INSTALL="$ROOT/install.sh"
fail=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; fail=1; }

[ -f "$INSTALL" ] || { echo "cannot find $INSTALL"; exit 1; }

# ---------------------------------------------------------------------------
# harness: a minimal valid repo + PATH shims, then run the REAL install.sh.
# WORK is set by the caller; each install writes to the DEST it is given and
# links under $WORK/prefix.
# ---------------------------------------------------------------------------
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BINDIR="$WORK/bin"; REPO="$WORK/repo"
mkdir -p "$BINDIR" "$REPO/etc" "$REPO/docs"

cat > "$BINDIR/id" <<'SH'
#!/bin/sh
[ "$1" = -u ] && { echo 0; exit 0; }
exec /usr/bin/id "$@"
SH
cat > "$BINDIR/pgrep" <<'SH'
#!/bin/sh
exit 1
SH
chmod +x "$BINDIR/id" "$BINDIR/pgrep"

# The installer REFUSES a boxup without its tail sentinel, so the fake carries
# one. `once` and `stop` are no-ops: this test is about the link, not converge.
cat > "$REPO/boxup" <<'SH'
#!/bin/bash
case "${1:-}" in once) : ;; stop) : ;; esac
exit 0
# boxup-eof
SH
cat > "$REPO/box-bootstrap.sh" <<'SH'
#!/bin/bash
exit 0
SH
cp "$INSTALL" "$REPO/install.sh"
echo "9.9.9" > "$REPO/VERSION"
printf '[ssh]\npassword = "x"\n' > "$REPO/etc/config.example.toml"
echo "# doc" > "$REPO/docs/AGENT.md"
echo "# readme" > "$REPO/README.md"
chmod +x "$REPO/boxup" "$REPO/box-bootstrap.sh" "$REPO/install.sh"

# run_install <dest> -> the installer's rc; output goes to $WORK/install.out
run_install() {
  local dest="$1"
  mkdir -p "$dest"
  PATH="$BINDIR:$PATH" \
    BOX_SETUP_ROOT="$dest" \
    PREFIX="$WORK/prefix" \
    BOX_SETUP_GIT_SHA=deadbee \
    BOX_SETUP_INSTALL_LOG="$WORK/install.log" \
    timeout 120 bash "$REPO/install.sh" > "$WORK/install.out" 2>&1
  echo $?
}

LINK="$WORK/prefix/usr/local/bin/boxup"
DEST_A="$WORK/dest-a"
DEST_B="$WORK/dest-b"

# ---------------------------------------------------------------------------
# (1) a first install creates the link, and it is a SYMLINK that resolves to
# the boxup this install just wrote. A plain copy would pass an -e check and
# then rot on the next upgrade, so the -L and -ef assertions both matter.
# ---------------------------------------------------------------------------
rc="$(run_install "$DEST_A")"
if [ "$rc" != 0 ]; then
  bad "(1) install.sh exited $rc: [$(tail -3 "$WORK/install.out")]"
elif [ -L "$LINK" ] && [ -x "$LINK" ] && [ "$LINK" -ef "$DEST_A/boxup" ]; then
  pass "(1) install.sh created $LINK as a symlink resolving to the installed boxup"
else
  bad "(1) no usable symlink at $LINK: $(ls -l "$LINK" 2>&1)"
fi

# ---------------------------------------------------------------------------
# (2) the TARGET is the REAL $DEST path, not a PREFIX-rooted one. Linking to
# "$PREFIX$DEST/boxup" would look identical under a scratch install and dangle
# on every real box.
# ---------------------------------------------------------------------------
tgt="$(readlink "$LINK" 2>/dev/null || true)"
if [ "$tgt" = "$DEST_A/boxup" ]; then
  pass "(2) link target is the REAL $DEST_A/boxup (not PREFIX-rooted)"
else
  bad "(2) wrong link target: [$tgt] want [$DEST_A/boxup]"
fi

# ---------------------------------------------------------------------------
# (3) idempotent: installing again over the same DEST leaves exactly one
# symlink with the same target and does not fail the install.
# ---------------------------------------------------------------------------
rc="$(run_install "$DEST_A")"
tgt2="$(readlink "$LINK" 2>/dev/null || true)"
n="$(find "$WORK/prefix/usr/local/bin" -name boxup | wc -l)"
if [ "$rc" = 0 ] && [ "$tgt2" = "$DEST_A/boxup" ] && [ "$n" = 1 ]; then
  pass "(3) a second install is idempotent: one symlink, same target, rc 0"
else
  bad "(3) re-install not idempotent: rc=$rc target=[$tgt2] count=$n"
fi

# ---------------------------------------------------------------------------
# (4) a re-install with a DIFFERENT DEST REPOINTS the link. This is what `-fn`
# buys: plain `ln -s` would fail on the existing link and leave it aimed at the
# old tree, and `ln -sf` without -n would follow the existing link and create
# the new one INSIDE the old directory.
# ---------------------------------------------------------------------------
rc="$(run_install "$DEST_B")"
tgt3="$(readlink "$LINK" 2>/dev/null || true)"
if [ "$rc" = 0 ] && [ "$tgt3" = "$DEST_B/boxup" ] && [ ! -e "$DEST_A/boxup/boxup" ]; then
  pass "(4) a re-install with a new DEST repoints the link (ln -sfn, no nesting)"
else
  bad "(4) link not repointed: rc=$rc target=[$tgt3] want [$DEST_B/boxup]"
fi

# ---------------------------------------------------------------------------
# (5) PREFIX must survive install.sh's non-root sudo re-exec. If it is dropped
# there, a `PREFIX=... bash install.sh` run as a normal user re-execs under
# sudo WITHOUT it and writes the link into the machine's real /usr/local/bin —
# the exact accident this test would otherwise cause on a root CI runner.
# ---------------------------------------------------------------------------
if grep -q 'PREFIX="\${PREFIX:-}"' "$INSTALL" \
   && awk '/exec sudo env/{i=1} i{print} i&&/bash "\$0"/{exit}' "$INSTALL" | grep -q 'PREFIX="\$PREFIX"'; then
  pass "(5) install.sh defines PREFIX and forwards it across the sudo re-exec"
else
  bad "(5) install.sh does not forward PREFIX across its sudo re-exec"
fi

echo
[ "$fail" = 0 ] && echo "ALL PASS (test-install-boxup-symlink.sh)" || echo "FAILURES (test-install-boxup-symlink.sh)"
exit "$fail"
