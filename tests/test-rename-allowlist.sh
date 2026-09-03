#!/bin/bash
# test-rename-allowlist.sh — N3/N5 of the 5.10.0 rename (blueprint
# fleet2-rename-grokfleet): NO tracked file mentions the pre-rename name outside
# an explicit, counted allowlist.
#
# The allowlist is `tests/lib/rename-allowlist.txt`, one entry per line:
#
#     <path><TAB><extended regex><TAB><expected number of matching lines>
#
# NEVER a bare path (r2-B6). Exempting a whole file would turn the very test
# that enforces the rename into a blind spot — `tests/test-install-vps.sh` alone
# carries dozens of mentions, and they are the COMPATIBILITY SURFACE UNDER TEST
# (the `fleet2` PATH symlink, `grokfleet.prev` being the 5.9.0 binary,
# `FLEET2_BINARY` still accepted), not leftovers. With a regex and a count, an
# exempt file still fails when an unexpected mention appears or when the number
# of expected ones moves.
#
# Two checks per file, and they are not the same check:
#   1. every allowlist entry's line count is EXACTLY what it declares — so a
#      mention that disappears (a silent loss of compatibility) fails too;
#   2. every line mentioning the old name matches at least one of that file's
#      entries — so a NEW mention fails even in an allowlisted file.
#
# What legitimately stays, and why:
#   * the N2 compatibility surface — the two unit symlinks, the timer Alias, the
#     `/usr/local/bin/fleet2` link, `FLEET2_*` env spellings, `$OPT_DIR/fleet2`
#     and `fleet2.prev` as the things the cutover consumes. ALL of it goes in
#     5.11.0, and these counts are the checklist for that removal.
#   * the soak marker `/var/lib/grok-fleet/fleet2.soak-ok` (r3-n1) — state under
#     $FLEET_STATE that gates flipping apply=true. Renaming it would silently
#     reset an in-flight soak.
#   * blueprint filenames (`fleet2-state-store`, `fleet2-zero-touch-join`,
#     `fleet2-release-install`, `fleet2-rename-grokfleet`) cited from comments —
#     those documents exist under those names; a "corrected" citation is a wrong
#     citation.
#   * historical records under `tmp/orch/` — dispatch logs and gate memos.
#
# Run: bash tests/test-rename-allowlist.sh   (or: make test)
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
ALLOW="$HERE/lib/rename-allowlist.txt"
OLD_NAME='fleet2'
fail=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; fail=1; }

cd "$ROOT" || { echo "cannot cd to $ROOT"; exit 1; }
[ -f "$ALLOW" ] || { echo "missing allowlist $ALLOW"; exit 1; }

# --- the allowlist file itself is well-formed --------------------------------
# A bare path (no regex, no count) is the shape r2-B6 rules out; catching it here
# means the format cannot decay back into whole-file exemptions.
malformed=0
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  n="$(printf '%s' "$line" | awk -F'\t' '{print NF}')"
  if [ "$n" != 3 ]; then
    bad "allowlist line is not <path>TAB<regex>TAB<count>: [$line]"
    malformed=1
  fi
done < "$ALLOW"
[ "$malformed" = 0 ] && pass "N5: every allowlist entry is <path>TAB<regex>TAB<count> (never a bare path)"

# --- 1. every entry's count is exact -----------------------------------------
entry_fail=0
while IFS=$'\t' read -r path re want; do
  case "$path" in ''|'#'*) continue ;; esac
  if [ ! -f "$path" ]; then
    bad "allowlist names a file that does not exist: $path"; entry_fail=1; continue
  fi
  got="$(grep -cE "$re" "$path" 2>/dev/null || true)"
  if [ "$got" != "$want" ]; then
    bad "allowlist count moved: $path /$re/ expected $want lines, found $got"
    entry_fail=1
  fi
done < "$ALLOW"
[ "$entry_fail" = 0 ] && pass "N5: every allowlisted mention is present in exactly the declared number of lines"

# --- 2. no unexpected mention anywhere ---------------------------------------
# Tracked, non-binary files only. For each line carrying the old name, at least
# one allowlist entry for that file must match it.
unexpected=0
checked=0
while IFS= read -r f; do
  # The checker and its manifest necessarily spell the legacy token: the former
  # defines the search and documents the rule, while the latter is structured
  # evidence consumed above. They are not product/source occurrences. Keeping
  # this exclusion explicit avoids a recursive whole-file allowlist entry while
  # preserving the exact-count checks for every file actually under test.
  case "$f" in
    tests/test-rename-allowlist.sh|tests/lib/rename-allowlist.txt) continue ;;
  esac
  [ -f "$f" ] || continue
  grep -Iq "$OLD_NAME" "$f" 2>/dev/null || continue
  checked=$((checked + 1))
  # the regexes allowlisted for THIS file
  res="$(awk -F'\t' -v p="$f" '$1 == p {print $2}' "$ALLOW")"
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    ok=0
    while IFS= read -r re; do
      [ -n "$re" ] || continue
      printf '%s\n' "$hit" | grep -qE "$re" && { ok=1; break; }
    done <<< "$res"
    if [ "$ok" = 0 ]; then
      bad "UNEXPECTED '$OLD_NAME' mention in $f: $hit"
      unexpected=$((unexpected + 1))
    fi
  done <<< "$(grep -nI "$OLD_NAME" "$f")"
done <<< "$(git ls-files)"
if [ "$unexpected" = 0 ]; then
  pass "N3: no tracked file mentions '$OLD_NAME' outside the allowlist ($checked file(s) carry an allowlisted mention)"
fi

# --- 3. the rename actually happened -----------------------------------------
# A guard against the whole suite passing on a tree where nothing was renamed:
# the new name must be everywhere the operator looks.
for probe in \
  'vps/install-vps.sh:grokfleet-reconcile.service' \
  'fleet/src/commands/usage.ts:grokfleet <command>' \
  'fleet/src/log.ts:grokfleet: ' \
  'Makefile:grokfleet-linux-x64'
do
  pf="${probe%%:*}"; ps="${probe#*:}"
  if grep -Fq "$ps" "$pf"; then
    pass "N1: $pf carries the new name ('$ps')"
  else
    bad "N1: $pf does NOT carry '$ps' — the rename is incomplete"
  fi
done

# --- 4. the soak marker was NOT renamed (r3-n1) ------------------------------
if grep -Fq '/var/lib/grok-fleet/fleet2.soak-ok' Makefile; then
  pass "r3-n1: the soak marker keeps its pre-rename path (renaming it would silently reset an in-flight soak)"
else
  bad "r3-n1: the soak marker path changed — an in-flight soak would be silently reset"
fi

echo "-----"
if [ "$fail" = 0 ]; then echo "ALL RENAME-ALLOWLIST TESTS PASSED"; else echo "SOME RENAME-ALLOWLIST TESTS FAILED"; fi
exit "$fail"
