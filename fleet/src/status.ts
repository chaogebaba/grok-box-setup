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

// --- typed box report (5.13.0, box-conditions D1) ---------------------------
//
// `parseStatusLine` puts every unpromoted token in the `tokens` bag and nothing
// reads it (audit §1b). `toReport` is the ONE typed view of the box-reported
// conditions the brain acts on: it derives a `BoxReport` from an
// already-parsed `BoxStatus`, so it costs no extra ssh — every caller already
// holds a parsed line (D1). It is a SEPARATE exported function, NOT a field of
// `BoxStatus`: making `report` required would touch every `BoxStatus`
// construction site and every test that builds one, for no gain (D1).
//
// Token domains are boxup 5.6.1's (audit §4): `disk=` is
// `unknown | N% | N%/warn | N%/fail`; the `keepawake_rc` domain is exactly the
// eight values `keepawake_status_tokens()` can print — `ok inert refused skip
// unreachable parked-ok parked-blocked` plus the literal `-` — and `-`/absence
// ⇒ null (`off` and `error` are NOT values of this token). `keepawake_last=` is
// ISO8601Z, and the literal `never`, an unparseable value, or absence ⇒ null.

/** The disk level boxup reports, or `unknown` when the token is absent/garbage. */
export type DiskLevel = "ok" | "warn" | "fail" | "unknown";

/** The eight `keepawake_rc` values, plus null for `-`/absence (audit §4). */
export type KeepawakeRc =
  | "ok"
  | "inert"
  | "refused"
  | "skip"
  | "unreachable"
  | "parked-ok"
  | "parked-blocked"
  | "-";

/** The `keepawake_rc` domain as a Set, so `toReport` classifies rather than trusts. */
const KEEPAWAKE_RC_VALUES = new Set<string>([
  "ok",
  "inert",
  "refused",
  "skip",
  "unreachable",
  "parked-ok",
  "parked-blocked",
  "-",
]);

/** The typed box report the brain acts on (D1). Every field defaults SAFE. */
export interface BoxReport {
  /** `tickwedge=N`; absent ⇒ 0. */
  tickwedge: number;
  /** `tunnelfail=N`; absent ⇒ 0. */
  tunnelfail: number;
  /** parsed from `disk=unknown | N% | N%/warn | N%/fail`. */
  disk: { pct: number | null; level: DiskLevel };
  /** `keepawake=on|off`; absent ⇒ false. */
  keepawakeOn: boolean;
  /** `keepawake_rc=` verbatim when in-domain and not `-`, else null. */
  keepawakeRc: string | null;
  /** `keepawake_last=` ISO8601Z, else null (`never`/garbage/absent ⇒ null). */
  keepawakeLast: string | null;
  /** `jumps=N`; absent ⇒ 0. */
  jumps: number;
  /** `job_state=<state>` or null. */
  jobState: string | null;
  /** `refresh=failing:N`, else 0. */
  refreshFailing: number;
  /** `repair=failing:N`, else 0. */
  repairFailing: number;
}

/** Parse a bare non-negative integer token, absent/garbage ⇒ 0. */
function intToken(v: string | undefined): number {
  if (v === undefined) return 0;
  return /^[0-9]+$/.test(v) ? Number.parseInt(v, 10) : 0;
}

/** Parse the `failing:N` shape of `refresh=`/`repair=`, else 0. */
function failingCount(v: string | undefined): number {
  if (v === undefined) return 0;
  const m = v.match(/^failing:([0-9]+)$/);
  return m ? Number.parseInt(m[1]!, 10) : 0;
}

/** Parse `disk=` into `{ pct, level }` over its four shapes (audit §4). */
function parseDisk(v: string | undefined): { pct: number | null; level: DiskLevel } {
  if (v === undefined || v === "unknown") return { pct: null, level: "unknown" };
  // `N%`, `N%/warn`, `N%/fail`.
  const m = v.match(/^([0-9]+)%(?:\/(warn|fail))?$/);
  if (m === null) return { pct: null, level: "unknown" };
  const pct = Number.parseInt(m[1]!, 10);
  const level: DiskLevel = m[2] === "warn" ? "warn" : m[2] === "fail" ? "fail" : "ok";
  return { pct, level };
}

/** ISO8601Z, or null when absent, `never`, or unparseable. */
function parseKeepawakeLast(v: string | undefined): string | null {
  if (v === undefined || v === "never") return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

/**
 * Derive the typed `BoxReport` from an already-parsed status line. Never throws
 * — an all-defaulted `BoxStatus` (from `""`/garbage, see `parseStatusLine`)
 * yields a report of all-clear defaults, which is why D1b gates the raise/clear
 * pass on `statusSeen`: a defaulted report must never CLEAR a real condition.
 */
export function toReport(status: BoxStatus): BoxReport {
  const t = status.tokens;
  const rcRaw = t["keepawake_rc"];
  const keepawakeRc =
    rcRaw !== undefined && rcRaw !== "-" && KEEPAWAKE_RC_VALUES.has(rcRaw) ? rcRaw : null;
  return {
    tickwedge: intToken(t["tickwedge"]),
    tunnelfail: intToken(t["tunnelfail"]),
    disk: parseDisk(t["disk"]),
    keepawakeOn: t["keepawake"] === "on",
    keepawakeRc,
    keepawakeLast: parseKeepawakeLast(t["keepawake_last"]),
    jumps: intToken(t["jumps"]),
    jobState: t["job_state"] ?? null,
    refreshFailing: failingCount(t["refresh"]),
    repairFailing: failingCount(t["repair"]),
  };
}
