// render.ts — render_managed port (main:1904-1946) + managed_header (main:1878-1884).
//
// Merge = fleet.toml then boxes/<box>.toml, key-level LAST-WINS per (table,key);
// (table,key) order = FIRST-SEEN over the concatenated stream; a box override
// replaces the VALUE in place (never reorders). Comments/blank lines dropped.
// Table headers emitted once, in first-seen order, before their first key. One
// deterministic pass ⇒ identical inputs give identical bytes. No inputs ⇒
// header only.

/** The fixed 4-line header (main:1878-1884), byte-verbatim. */
export const MANAGED_HEADER = [
  "# managed.toml — WRITTEN BY THE VPS BRAIN (fleetctl). DO NOT EDIT.",
  "# Hand edits are overwritten on the next reconcile. Precedence on the box:",
  "# env > managed.toml > config.toml > default. Disable locally with",
  "# [managed] enabled = false in config.toml.",
].join("\n");

function trim(s: string): string {
  return s.replace(/^[ \t\r]+/, "").replace(/[ \t\r]+$/, "");
}

/**
 * Merge the concatenated TOML-subset inputs (fleet-wide first, then per-box)
 * into the canonical body, mirroring the awk exactly. Returns the body WITHOUT
 * the header (caller prepends). Comments/blanks dropped; table headers once.
 */
export function mergeManaged(inputs: string[]): string {
  const order: string[] = [];
  const seen = new Set<string>();
  const tbl = new Map<string, string>();
  const key = new Map<string, string>();
  const val = new Map<string, string>();
  let sec = "";
  const SUBSEP = "\u0001";

  for (const text of inputs) {
    for (const raw of text.split("\n")) {
      const line = trim(raw);
      if (line === "" || line.startsWith("#")) continue;
      if (/^\[.*\]$/.test(line)) {
        sec = trim(line.slice(1, -1));
        continue;
      }
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = trim(line.slice(0, eq));
      const v = trim(line.slice(eq + 1));
      const id = sec + SUBSEP + k;
      if (!seen.has(id)) {
        seen.add(id);
        order.push(id);
        tbl.set(id, sec);
        key.set(id, k);
      }
      val.set(id, v); // LAST-WINS
    }
  }

  const out: string[] = [];
  let lastTbl = "\u0002"; // sentinel that no real table equals
  for (const id of order) {
    const t = tbl.get(id)!;
    if (t !== lastTbl) {
      out.push(`[${t}]`);
      lastTbl = t;
    }
    out.push(`${key.get(id)} = ${val.get(id)}`);
  }
  return out.join("\n");
}

/**
 * render_managed <box>: header + merged body. `fleetToml`/`boxToml` are the file
 * CONTENTS or undefined when absent (the caller resolves existence). No inputs ⇒
 * header only. Returns the full rendered text (header + "\n" + body when a body
 * exists, else just the header) with a trailing newline, matching bash's
 * `managed_header` (printf '%s\n' ×4 ⇒ trailing \n) + awk body (each line \n).
 */
export function renderManaged(fleetToml: string | undefined, boxToml: string | undefined): string {
  const inputs: string[] = [];
  if (fleetToml !== undefined) inputs.push(fleetToml);
  if (boxToml !== undefined) inputs.push(boxToml);
  const header = MANAGED_HEADER + "\n";
  if (inputs.length === 0) return header;
  const body = mergeManaged(inputs);
  return body === "" ? header : header + body + "\n";
}

const KNOWN_KEYS = new Set(["ssh\u0001password", "tailscale\u0001version", "update\u0001repo"]);

/** unknown_managed_keys (main:1990-2013): well-formed but unknown table.key list. */
export function unknownManagedKeys(text: string): string[] {
  const SUBSEP = "\u0001";
  const seen = new Set<string>();
  const out: string[] = [];
  let sec = "";
  for (const raw of text.split("\n")) {
    const line = trim(raw);
    if (line === "" || line.startsWith("#")) continue;
    if (/^\[.*\]$/.test(line)) {
      sec = trim(line.slice(1, -1));
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = trim(line.slice(0, eq));
    if (k === "") continue;
    const id = sec + SUBSEP + k;
    if (KNOWN_KEYS.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(`${sec}.${k}`);
  }
  return out;
}
