// status.ts — parse a `boxup status` line COMPLETELY (D6, F8/S1, T1).
//
// Parsing is TOKEN-KEYED (`k=v` split on spaces), never positional, never a
// whole-line regex — the token order in boxup:2161-2194 puts `tunnel=` LAST,
// after `tags= keyexpiry=` and the conditional refresh/repair/auth/authkey
// tokens, and must not be assumed. Garbage never throws (T1).
//
// `v=5.3.0/abc123` → version 5.3.0, sha abc123; `v=5.3.0` (no sha) → version
// 5.3.0, sha "unknown"; missing v= → both "unknown".

export interface BoxStatus {
  version: string;
  sha: string;
  /** Box name from name= (or undefined). */
  name: string | undefined;
  /** The box's OWN tunnel= token (stored as boxTunnel; never the table TUNNEL). */
  boxTunnel: string | undefined;
  tags: string | undefined;
  keyexpiry: string | undefined;
  /** authkey= token verbatim (e.g. `EXPIRED:2026-11-27`) or undefined. */
  authkey: string | undefined;
  /** Every parsed token, for callers that need a rarely-used field. */
  tokens: Record<string, string>;
}

/** Split a `v=` value into version + sha per status_line_sha (fleetctl:243). */
export function splitVersion(vToken: string | undefined): { version: string; sha: string } {
  if (vToken === undefined) return { version: "unknown", sha: "unknown" };
  const slash = vToken.indexOf("/");
  if (slash < 0) return { version: vToken, sha: "unknown" };
  return { version: vToken.slice(0, slash), sha: vToken.slice(slash + 1) };
}

/**
 * Parse a status line. Accepts the `check=OK ` prefix (boxup:2205) transparently
 * — the `check=OK` token is captured but the real fields still parse. Never
 * throws; garbage input yields version/sha "unknown".
 */
export function parseStatusLine(line: string | null | undefined): BoxStatus {
  const tokens: Record<string, string> = {};
  if (typeof line === "string") {
    for (const tok of line.trim().split(/\s+/)) {
      if (tok === "") continue;
      const eq = tok.indexOf("=");
      if (eq <= 0) continue; // no key, or `=v` — ignore, never throw
      const k = tok.slice(0, eq);
      const v = tok.slice(eq + 1);
      // First token wins (mirrors boxup FIRST-match); do not clobber.
      if (!(k in tokens)) tokens[k] = v;
    }
  }
  const { version, sha } = splitVersion(tokens["v"]);
  return {
    version,
    sha,
    name: tokens["name"],
    boxTunnel: tokens["tunnel"],
    tags: tokens["tags"],
    keyexpiry: tokens["keyexpiry"],
    authkey: tokens["authkey"],
    tokens,
  };
}

/** Result of parsing a `boxup check` invocation's combined output. */
export interface CheckResult {
  ok: boolean;
  /** reason= on a FAIL line (boxup:2206), else undefined. */
  reason: string | undefined;
  /** Parsed status when rc 0 (the `check=OK ` line carries it), else undefined. */
  status: BoxStatus | undefined;
}

/**
 * Interpret a `boxup check` call: rc 0 ⇒ output is `check=OK ` + status line;
 * rc 1 ⇒ output is `check=FAIL reason=…` with NO status line (G4/S-C).
 */
export function parseCheck(code: number | null, output: string): CheckResult {
  if (code === 0) {
    return { ok: true, reason: undefined, status: parseStatusLine(output) };
  }
  // FAIL: pull reason= token if present.
  let reason: string | undefined;
  const m = output.match(/reason=(\S+)/);
  if (m) reason = m[1];
  return { ok: false, reason, status: undefined };
}
