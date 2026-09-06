// validate.ts — validate_managed port (main:1955-1981). D4 gate.
//
// REFUSE (ok=false + reason) when the merged text contains: a `[fleet]` table
// (enroll-owned), a table outside {ssh, tailscale, update, managed, keepawake},
// a `[tailscale].tags` key (first-login-only on the box, out of scope for phase
// 2), a `[keepawake]` key other than `interval_min`, an unparsable line (no
// `key=value`), or an empty key. Unknown-but-well-formed keys are otherwise
// ALLOWED (forward-compat). Returns the FIRST-style reasons collected (bash
// prints each to stderr and exits non-zero if any fired).
//
// A8 (5.12.1) — `[keepawake]`.
//
// The keep-awake experiment was ABANDONED (2026-09-06): its readout came in at
// 0.83-1.02 exercised box-days against a 1.15 control, and the way to turn it
// off on every box at once is `[keepawake] interval_min = 0` in
// /etc/grok-fleet/fleet.toml — boxup resolves 0 to "off, the guard is a no-op"
// (boxup `keepawake_interval_min`). Before this change D4 REFUSED that text with
// "table [keepawake] is outside the boxup config subset", and a refusal is
// rc 4 for every box, so the one line meant to disable a feature fleet-wide
// would instead have stopped config pushes fleet-wide.
//
// `[keepawake]` is the ONE table whose keys are closed rather than
// forward-compatible. The forward-compat rule exists so the brain can push a key
// a newer boxup understands and an older one ignores; that is safe when the
// worst case is an ignored line. Here the worst case has a price tag: this guard
// spends a model turn per fire, and the only key that exists is the one that
// decides how often. A typo like `[keepawake] interval = 0` would parse, log as
// "unknown but allowed", leave `interval_min` unset, and boxup would fall back to
// its 20-minute DEFAULT — the feature stays on, at cost, while the operator reads
// a successful push. Refusing the key is what turns that into a visible error.

function trim(s: string): string {
  return s.replace(/^[ \t\r]+/, "").replace(/[ \t\r]+$/, "");
}

const ALLOWED_TABLES = new Set(["ssh", "tailscale", "update", "managed", "keepawake"]);

/** A8: the closed key set for `[keepawake]` — see the header for why it is closed. */
const KEEPAWAKE_KEYS = new Set(["interval_min"]);

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
    if (sec === "keepawake" && !KEEPAWAKE_KEYS.has(k)) {
      reasons.push(`refuse: [keepawake].${k} is not a boxup keep-awake key (only interval_min)`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}
