// remote-script.ts — managed_remote_script port (main:2059-2100), VERBATIM.
//
// Only `$want`, `$dry`, `$BOX_MANAGED`, `$BOX_ROOT` are interpolated at emit
// time; everything else is escaped (the `\$` in bash ⇒ a literal `$` here). The
// body carries ZERO comment lines / apostrophes / backticks (E1) because it runs
// inside `sudo sh -c '<script>'`. Scanned by mrs_scan_test.

export const BOX_ROOT = "/workspace/box-setup";
export const BOX_MANAGED = "/workspace/box-setup/managed.toml";

/**
 * managed_remote_script(wantSha, dry) — emit the POSIX-sh remote script. `dry`
 * is 0|1. The output is byte-identical to bash's heredoc expansion.
 */
export function managedRemoteScript(wantSha: string, dry: 0 | 1): string {
  return [
    "set -e",
    "umask 077",
    `want=${wantSha}`,
    `mf=${BOX_MANAGED}`,
    `bx=${BOX_ROOT}/boxup`,
    `dry=${dry}`,
    "tmp=$mf.tmp",
    'cat > "$tmp"',
    'got=$(sha256sum "$tmp" | cut -d" " -f1)',
    'if [ "$got" != "$want" ]; then echo MANAGED_SHA_MISMATCH >&2; rm -f "$tmp"; exit 3; fi',
    'cur=$(sha256sum "$mf" 2>/dev/null | cut -d" " -f1); [ -n "$cur" ] || cur=none',
    "support=no; enabled=n/a",
    'if grep -q ^MANAGED_FILE= "$bx" 2>/dev/null; then',
    "  support=yes",
    '  enabled=$(bash "$bx" config-get managed enabled 2>/dev/null) && prc=0 || prc=$?',
    '  if [ "$prc" = 0 ]; then',
    '    case "$enabled" in true|false) : ;; *) enabled=unknown ;; esac',
    '  elif [ "$prc" = 1 ]; then',
    "    enabled=true",
    "  else",
    "    enabled=unknown",
    "  fi",
    "fi",
    'if [ "$dry" = 1 ]; then',
    '  rm -f "$tmp"',
    '  echo "cur=$cur want=$want support=$support enabled=$enabled"',
    "  echo ---FILE---",
    '  cat "$mf" 2>/dev/null || true',
    "  exit 0",
    "fi",
    'if [ "$cur" = "$want" ]; then',
    '  rm -f "$tmp"',
    "else",
    '  mv -f "$tmp" "$mf"; chmod 600 "$mf"',
    "fi",
    'now=$(sha256sum "$mf" 2>/dev/null | cut -d" " -f1); [ -n "$now" ] || now=none',
    'echo "sha=$now cur=$cur support=$support enabled=$enabled"',
  ].join("\n");
}

/** The remote command as run by push_managed (main:2217): sudo sh -c '<script>'. */
export function wrapSudoShC(script: string): string {
  return `sudo sh -c '${script}'`;
}

/** sha256 hex of `<text>\n` (bash: printf '%s\n' | sha256sum | awk '{print $1}'). */
export async function textSha256(text: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(`${text}\n`);
  return h.digest("hex");
}

export interface StatusTokens {
  cur: string;
  sha: string;
  support: string;
  enabled: string;
}

/** Parse the FIRST cur=/sha=-bearing line into order-independent tokens (main:2260-2268). */
export function parseStatusTokens(out: string): StatusTokens | undefined {
  const line = out.split("\n").find((l) => /(^| )cur=|(^| )sha=/.test(l));
  if (line === undefined) return undefined;
  const t: StatusTokens = { cur: "", sha: "", support: "", enabled: "" };
  for (const tok of line.trim().split(/\s+/)) {
    if (tok.startsWith("cur=")) t.cur = tok.slice(4);
    else if (tok.startsWith("sha=")) t.sha = tok.slice(4);
    else if (tok.startsWith("support=")) t.support = tok.slice(8);
    else if (tok.startsWith("enabled=")) t.enabled = tok.slice(8);
  }
  return t;
}

/** true iff the output carries a status line (cur=/sha= token) — main:2222. */
export function hadStatus(out: string): boolean {
  return out.split("\n").some((l) => /(^| )cur=|(^| )sha=/.test(l));
}
