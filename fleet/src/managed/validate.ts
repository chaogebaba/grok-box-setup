// validate.ts — validate_managed port (main:1955-1981). D4 gate.
//
// REFUSE (ok=false + reason) when the merged text contains: a `[fleet]` table
// (enroll-owned), a table outside {ssh, tailscale, update, managed}, a
// `[tailscale].tags` key (first-login-only on the box, out of scope for phase 2),
// an unparsable line (no `key=value`), or an empty key. Unknown-but-well-formed
// keys are ALLOWED (forward-compat). Returns the FIRST-style reasons collected
// (bash prints each to stderr and exits non-zero if any fired).

function trim(s: string): string {
  return s.replace(/^[ \t\r]+/, "").replace(/[ \t\r]+$/, "");
}

const ALLOWED_TABLES = new Set(["ssh", "tailscale", "update", "managed"]);

export interface ValidateResult {
  ok: boolean;
  reasons: string[];
}

export function validateManaged(text: string): ValidateResult {
  const reasons: string[] = [];
  let sec = "";
  for (const raw of text.split("\n")) {
    const line = trim(raw);
    if (line === "" || line.startsWith("#")) continue;
    if (/^\[.*\]$/.test(line)) {
      sec = trim(line.slice(1, -1));
      if (sec === "fleet") {
        reasons.push("refuse: [fleet] table is not brain-managed (enroll owns it)");
      } else if (!ALLOWED_TABLES.has(sec)) {
        reasons.push(`refuse: table [${sec}] is outside the boxup config subset`);
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      reasons.push(`refuse: unparsable line (no key=value): ${line}`);
      continue;
    }
    const k = trim(line.slice(0, eq));
    if (k === "") {
      reasons.push(`refuse: empty key in: ${line}`);
      continue;
    }
    if (sec === "tailscale" && k === "tags") {
      reasons.push("refuse: [tailscale].tags is not managed in Phase 2");
    }
  }
  return { ok: reasons.length === 0, reasons };
}
