// rc.ts — `fleet2 rc`, the discoverable exit-code table (agent-ux U3).
//
// The table is NOT written twice. `RC` in upgrade.ts is the one constant; this
// module attaches a one-line meaning to every DISTINCT number in it and renders
// from that. `RC_MEANING` is typed `Record<RcCode, string>`, so adding a code to
// RC without a meaning here is a COMPILE error and dropping a code from the
// rendering is impossible — the table cannot go stale (mutant (c)).

import { RC } from "../upgrade.ts";

/** Every exit code fleet2 can return (the union of RC's values). */
export type RcCode = (typeof RC)[keyof typeof RC];

/**
 * One line per distinct rc number. Several RC keys share a number on purpose
 * (REFUSED and LOCK_BUSY are both 6 — "refused, nothing done"), so the meaning
 * is keyed by the NUMBER, not the name.
 */
export const RC_MEANING: Readonly<Record<RcCode, string>> = {
  0: "ok",
  1: "verified failure / abort",
  2: "usage",
  3: "target / staging / config",
  4: "enroll: reverse tunnel never came up · config push: render refused by validation",
  5: "policy precheck refused, nothing written",
  6: "refused, nothing done (VPS-only, missing key, reconcile lock held)",
  7: "recorded, but the legacy file export failed",
  124: "ssh --timeout elapsed; fleet2 killed the remote command",
  255: "ssh transport failure (box unreachable)",
};

/** Distinct rc numbers, ascending. Derived from RC — never hand-listed. */
export function rcCodes(): RcCode[] {
  const seen = new Set<RcCode>(Object.values(RC) as RcCode[]);
  return [...seen].sort((a, b) => a - b);
}

/** The human table (stdout, rc 0). */
export function renderRcTable(): string {
  const lines = ["fleet2 exit codes"];
  for (const code of rcCodes()) lines.push(`  ${String(code).padEnd(3)}  ${RC_MEANING[code]}`);
  lines.push("");
  lines.push("stdout is data; diagnostics and errors go to stderr.");
  return lines.join("\n") + "\n";
}

/** The same table as one JSON document (U2: --json on every read command). */
export function renderRcJson(): string {
  return (
    JSON.stringify({ codes: rcCodes().map((code) => ({ code, meaning: RC_MEANING[code] })) }, null, 2) + "\n"
  );
}

/** The pointer line every help text ends with (U3). */
export const RC_POINTER_LINE = "exit codes: fleet2 rc";
