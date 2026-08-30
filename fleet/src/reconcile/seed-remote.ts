// seed-remote.ts — the seed remote command (D8, main:1576 + main:2124-2136).
//
// The remote SCRIPT (seed_remote_script, main:2124-2136) is a VERBATIM heredoc:
// zero interpolation, reads env only, and carries NO apostrophe / backtick /
// #-comment (E1) because it is executed as `sudo env … sh -c '<script>'`. The
// WRAPPER (main:1576) is apostrophe-BEARING by design — the env values are
// F6-validated and the script is the fixed literal below. The key travels on
// STDIN, never argv (M11); the sha256 is computed locally.

import { assertRemoteValue } from "../remote.ts";

// Box paths (main:801-805).
export const BOX_ROOT = "/workspace/box-setup";
export const BOX_AUTHKEY = `${BOX_ROOT}/secrets/ts-authkey`;
export const BOX_AUTHKEY_TMP = `${BOX_ROOT}/secrets/.ts-authkey.tmp`;
export const BOX_AUTHKEY_EXPIRES = `${BOX_ROOT}/secrets/ts-authkey.expires`;

/**
 * seed_remote_script (main:2124-2136) — VERBATIM. No apostrophe/backtick/comment
 * (scanned by T-srs). Reads SEED_TMP/SEED_DST/SEED_EXP_FILE/SEED_EXP/SEED_SHA
 * from the env.
 */
export const SEED_REMOTE_SCRIPT = [
  "set -e",
  "umask 077",
  'cat > "$SEED_TMP"',
  'got=$(sha256sum "$SEED_TMP" | cut -d" " -f1)',
  'if [ "$got" != "$SEED_SHA" ]; then rm -f "$SEED_TMP"; echo SEED_SHA_MISMATCH >&2; exit 3; fi',
  'mv -f "$SEED_TMP" "$SEED_DST"',
  'chmod 600 "$SEED_DST"',
  'printf "%s\\n" "$SEED_EXP" > "$SEED_EXP_FILE"',
  'chmod 600 "$SEED_EXP_FILE"',
].join("\n");

/**
 * Render the seed wrapper command (main:1576):
 *   sudo env SEED_TMP='…' SEED_DST='…' SEED_EXP_FILE='…' SEED_EXP='<date>'
 *            SEED_SHA='<hex>' sh -c '<seed_remote_script>'
 * `expires` and `wantSha` are F6-validated (they must not carry a `'` that would
 * break the wrapper). The script literal is fixed and apostrophe-free.
 */
export function renderSeedCommand(expires: string, wantSha: string): string {
  assertRemoteValue("expires", expires);
  assertRemoteValue("sha", wantSha);
  return (
    `sudo env SEED_TMP='${BOX_AUTHKEY_TMP}' SEED_DST='${BOX_AUTHKEY}' ` +
    `SEED_EXP_FILE='${BOX_AUTHKEY_EXPIRES}' SEED_EXP='${expires}' SEED_SHA='${wantSha}' ` +
    `sh -c '${SEED_REMOTE_SCRIPT}'`
  );
}

/**
 * seed_status_converged (main:1607-1622): true iff the box converged onto a
 * fresh key. `authkey=EXPIRED*` (case-insensitive) or `authkey=unknown-expiry`
 * ⇒ NOT converged; absent token or `expiring:<date>` ⇒ converged.
 */
export function seedStatusConverged(statusLine: string): boolean {
  for (const tok of statusLine.trim().split(/\s+/)) {
    if (!tok.startsWith("authkey=")) continue;
    const v = tok.slice("authkey=".length);
    if (/^expired(:|$)/i.test(v)) return false;
    if (v === "unknown-expiry") return false;
  }
  return true;
}

/** sha256 hex of `<key>\n` (bash: printf '%s\n' | sha256sum), computed locally. */
export async function keySha256(key: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${key}\n`);
  return hasher.digest("hex");
}
