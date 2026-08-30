// boxes.ts — box name/index/port helpers (D3, T2) and enrolled.tsv membership
// (T3), byte-for-byte matching fleetctl's box_index_from_name (fleetctl:886),
// port_for (:897) and reconcile_target_boxes (:2641).

const BOX_NAME_RE = /^grok-box-[0-9]+$/;
const UNPARSEABLE_INDEX = 999999;

/**
 * grok-box-NNN → decimal N (F1 octal fix precedent: parse base 10, never octal).
 * A bare 1..3-digit N is also accepted (fleetctl callers pass raw indices).
 * Returns undefined when the name does not parse.
 */
export function boxIndex(nameOrIndex: string): number | undefined {
  const raw = nameOrIndex;
  const n = raw.startsWith("grok-box-") ? raw.slice("grok-box-".length) : raw;
  // Match fleetctl's case: grok-box-[0-9]{1,3} or a bare 1..3-digit index.
  const okName = /^grok-box-[0-9]{1,3}$/.test(raw);
  const okBare = /^[0-9]{1,3}$/.test(raw);
  if (!okName && !okBare) return undefined;
  if (!/^[0-9]+$/.test(n)) return undefined;
  return Number.parseInt(n, 10); // base 10, never octal
}

/** port_for: 20000 + index. Throws only when the caller ignored a bad name. */
export function portFor(box: string): number | undefined {
  const idx = boxIndex(box);
  return idx === undefined ? undefined : 20000 + idx;
}

/** Strict box-name validation for explicit args (F7.4): ^grok-box-[0-9]+$. */
export function isValidBoxName(name: string): boolean {
  return BOX_NAME_RE.test(name);
}

/**
 * Parse enrolled.tsv content into an ordered, deduped box-name list —
 * identical to fleetctl reconcile_target_boxes (:2641):
 *  - each line is `name<TAB>port`; take field 1;
 *  - blank lines and (blueprint T3) comment lines (`#…`) ignored;
 *  - dedup by name (first occurrence wins under stable numeric sort);
 *  - order numerically by box index; an unparseable name gets a large sentinel
 *    index so it sorts LAST but is still emitted (never silently dropped).
 */
export function parseEnrolled(content: string): string[] {
  const seen = new Set<string>();
  const rows: Array<{ idx: number; name: string }> = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("#")) continue; // T3: comment lines ignored
    const name = line.split("\t")[0]?.trim() ?? "";
    if (name === "") continue;
    if (seen.has(name)) continue; // dedup by name
    seen.add(name);
    const idx = boxIndex(name) ?? UNPARSEABLE_INDEX;
    rows.push({ idx, name });
  }
  // Numeric sort by index; ties (e.g. grok-box-3 + grok-box-003 both index 3)
  // broken by NAME ASCENDING to match GNU coreutils `sort -u -k2,2 | sort -n
  // -k1,1` (phase-2 I2/P4). String ascending puts grok-box-003 before
  // grok-box-3 ('0' < '3'). Stable across equal (idx,name) pairs.
  rows.sort((a, b) => (a.idx !== b.idx ? a.idx - b.idx : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows.map((r) => r.name);
}

/**
 * Membership for a run (F7.5): FLEET_BOXES (space-separated) overrides
 * enrolled.tsv with the same split semantics as fleetctl:2643. Otherwise the
 * enrolled.tsv content is parsed. `fleetBoxes` is the raw env value or undefined.
 */
export function resolveMembership(
  fleetBoxes: string | undefined,
  enrolledContent: string | undefined,
): string[] {
  if (fleetBoxes !== undefined && fleetBoxes.trim() !== "") {
    return fleetBoxes.split(/\s+/).filter((s) => s !== "");
  }
  if (enrolledContent === undefined) return [];
  return parseEnrolled(enrolledContent);
}

/**
 * Order an explicit target set (F7.4): validate each, dedup, put the canary
 * first if it is among them, then the remaining in argv order. Invalid names
 * are returned separately so the caller can refuse (rc 2).
 */
export function orderExplicit(
  args: string[],
  canary: string | undefined,
): { ordered: string[]; invalid: string[] } {
  const invalid: string[] = [];
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const a of args) {
    if (!isValidBoxName(a)) {
      invalid.push(a);
      continue;
    }
    if (seen.has(a)) continue;
    seen.add(a);
    valid.push(a);
  }
  if (invalid.length > 0) return { ordered: [], invalid };
  const ordered: string[] = [];
  if (canary && seen.has(canary)) ordered.push(canary);
  for (const b of valid) {
    if (b === canary) continue;
    ordered.push(b);
  }
  return { ordered, invalid };
}
