// model.ts — the TUI's presentation MODEL (fleet-tui-ink D1, fleet-tui-visual V2–V6).
//
// RULE: everything here returns plain strings or plain data. Not one ANSI byte
// is produced in this file. Colour is a semantic `Tone` the components hand to
// `toneProps` (tone.ts); layout is Ink's job. These functions are the old
// `render.ts` painters with every `sgr()` call removed, which is what lets the
// parity fixtures in `test/tui/fixtures/` compare the new frames against the
// hand-rolled painter byte for byte.
//
// Since fleet-tui-visual the painters emit SEGMENTS as well as text: a line's
// `text` is still the plain joined string every fixture compares against, and
// `segments` is the same string cut into per-cell pieces so a drifted VER can
// glow without painting the whole row yellow. `text` is always exactly the
// concatenation of `segments`, which the model tests pin.

import type { SnapshotBox, SnapshotLine } from "../history/schema.ts";
import type { TuiState } from "./state.ts";
import type { Tone } from "./tone.ts";

export interface Size {
  cols: number;
  rows: number;
}

/** One coloured piece of a line. */
export interface Seg {
  text: string;
  tone: Tone;
  bold?: boolean;
}

/** One painted line: its plain text plus how to colour it. */
export interface ToneLine {
  text: string;
  tone: Tone;
  /** the old painter's `C.bold` — kept as a flag so the components stay thin. */
  bold?: boolean;
  /** per-cell colouring; when present the component paints these, not `text`. */
  segments?: Seg[];
}

/** A table line additionally knows whether it is the selected row. */
export interface TableLine extends ToneLine {
  selected?: boolean;
}

export type DetailLine = ToneLine;

const STALE_SECONDS = 15 * 60; // TUI-D7

/** The Detail pane's FIXED height. The row-budget arithmetic in `layout.ts`
 *  depends on it (the pane is omitted rather than clipped when the budget is
 *  smaller), and the chrome-agreement test pins it against `detailLines`. */
export const DETAIL_ROWS = 10;

/** The gap between the table column and the Detail column. The old painter
 *  composed `padVisible(left, leftW) + "  " + right`, so Detail text starts at
 *  column `leftW + DETAIL_GAP` (74 at 120 columns). Defined here rather than in
 *  `layout.ts` because `detailLines` now needs the pane's width to frame and
 *  truncate its card, and `layout.ts` already imports this file. */
export const DETAIL_GAP = 2;

/** The width of the table column when the Detail pane is shown. */
export function tableWidth(size: Size): number {
  return Math.max(40, Math.floor(size.cols * 0.6));
}

/** The width of the Detail pane, frame included (V5). */
export function detailWidth(size: Size): number {
  return size.cols - tableWidth(size) - DETAIL_GAP;
}

// --- V2 glyphs ---------------------------------------------------------------
/**
 * Every glyph the frame paints as a STATUS, in one place so the width test can
 * measure the set rather than a hand-copied list. All are width 1 in the
 * terminals fleet2 runs in (kitty / alacritty / gnome-terminal / tmux); no
 * emoji, because a width-2 cell breaks Ink's measuring.
 */
export const GLYPH = {
  healthy: "●",
  degraded: "◆",
  down: "✖",
  asleep: "☾",
  unknown: "○",
  canary: "★",
} as const;

// --- small formatters (verbatim from render.ts) ------------------------------
function pad(s: string, w: number): string {
  // pad/truncate to EXACTLY w visible chars (the strings here carry no ANSI).
  if (s.length === w) return s;
  if (s.length > w) return s.slice(0, w);
  return s + " ".repeat(w - s.length);
}

function fmtAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function stripToWidth(s: string, cols: number): string {
  return s.length > cols ? s.slice(0, cols) : s;
}

/** The plain text of a segment list — always what the line's `text` is. */
export function segText(segs: Seg[]): string {
  let out = "";
  for (const s of segs) out += s.text;
  return out;
}

/** Truncate a segment list to `cols`, then pad it out to exactly `cols`. */
export function fitSegments(segs: Seg[], cols: number): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  for (const s of segs) {
    if (used >= cols) break;
    const text = stripToWidth(s.text, cols - used);
    if (text === "") continue;
    out.push({ ...s, text });
    used += text.length;
  }
  if (used < cols) out.push({ text: " ".repeat(cols - used), tone: "plain" });
  return out;
}

/** Truncate a segment list to `cols` WITHOUT padding it. */
export function clipSegments(segs: Seg[], cols: number): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  for (const s of segs) {
    if (used >= cols) break;
    const text = stripToWidth(s.text, cols - used);
    if (text === "") continue;
    out.push({ ...s, text });
    used += text.length;
  }
  return out;
}

const SEP = " · "; // V5: the detail card's field separator (MUTED)

// --- health ------------------------------------------------------------------
/** Glyph + tone for a box's health (TUI-D5, V2). Order: incident > degraded >
 *  asleep > healthy > down/unknown. `☾` (asleep) is MUTED, never an error tone —
 *  a sleeping box is the normal case on this fleet, not a fault. */
export function boxHealth(state: TuiState, b: SnapshotBox): { glyph: string; tone: Tone } {
  void state;
  if (b.asleep) return { glyph: GLYPH.asleep, tone: "muted" }; // muted, NOT an error colour
  if (b.check === "FAIL") return { glyph: GLYPH.down, tone: "down" }; // incident
  if (b.checkfail || b.drift === "yes" || b.config === "drift") return { glyph: GLYPH.degraded, tone: "warn" }; // degraded
  if (b.tunnel === "up" && b.check === "OK") return { glyph: GLYPH.healthy, tone: "ok" }; // healthy
  return { glyph: GLYPH.unknown, tone: "muted" }; // down / never-probed / unknown
}

/** Count fleet health for the header. */
export function counts(boxes: SnapshotBox[]): { total: number; healthy: number; degraded: number; down: number; asleep: number } {
  let healthy = 0;
  let degraded = 0;
  let down = 0;
  let asleep = 0;
  for (const b of boxes) {
    if (b.asleep) asleep++;
    else if (b.check === "FAIL") down++;
    else if (b.checkfail || b.drift === "yes" || b.config === "drift") degraded++;
    else if (b.tunnel === "up" && b.check === "OK") healthy++;
    else down++;
  }
  return { total: boxes.length, healthy, degraded, down, asleep };
}

// --- V3 cell tones -----------------------------------------------------------
/** The EXPIRY column's tone. The boundary is `decide.ts`'s rotate threshold:
 *  a key with a week or less left is an incident, not a warning. */
export function expiryTone(days: number | null | undefined): Tone {
  if (days === null || days === undefined) return "muted";
  if (days <= 7) return "down";
  if (days <= 30) return "warn";
  return "muted";
}

export interface CellTones {
  tunnel: Tone;
  check: Tone;
  ver: Tone;
  drift: Tone;
  config: Tone;
  expiry: Tone;
}

/**
 * V3: every cell carries its OWN meaning; only the glyph and the name carry the
 * row's health. `quiet is the goal state` — an in-sync config and a no-drift box
 * are MUTED so the eye lands on the cells that are not.
 */
export function cellTones(b: SnapshotBox): CellTones {
  return {
    tunnel: b.tunnel === "up" ? "ok" : b.tunnel === "down" ? "down" : "muted",
    check: b.check === "OK" ? "ok" : b.check === "FAIL" ? "down" : "muted",
    // the version that is about to be replaced is the thing that should glow.
    ver: b.drift === "yes" ? "warn" : "plain",
    drift: b.drift === "yes" ? "warn" : "muted",
    config: b.config === "drift" ? "warn" : "muted",
    expiry: expiryTone(b.expiry_days),
  };
}

/** V6: the transient message line's tone. A failure is louder than an "ok". */
export function messageTone(text: string): Tone {
  const t = text.toLowerCase();
  if (t.includes("error") || t.includes("failed")) return "down";
  if (t.startsWith("ok") || t.startsWith("done")) return "ok";
  return "plain";
}

// --- header ------------------------------------------------------------------
/** V4: the header bar, left→right — identity, health, mode, link. */
export function headerSegments(state: TuiState, size: Size): Seg[] {
  const c = counts(state.boxes);
  const stale = state.tickAgeS !== null && state.tickAgeS >= STALE_SECONDS;
  const applyText =
    state.apply === null ? "apply ?" : `apply ${state.apply ? "ON" : "off"}${state.applySource === "config" ? "" : "?"}`;
  const applyTone: Tone = state.apply === null ? "warn" : state.apply ? "ok" : "muted";
  const segs: Seg[] = [
    { text: "fleet2", tone: "main", bold: true },
    { text: ` ${c.total} boxes`, tone: "plain" },
    { text: "  ", tone: "plain" },
    { text: `${GLYPH.healthy} ${c.healthy}`, tone: "ok" },
    { text: "  ", tone: "plain" },
    { text: `${GLYPH.degraded} ${c.degraded}`, tone: "warn" },
    { text: "  ", tone: "plain" },
    { text: `${GLYPH.down} ${c.down}`, tone: "down" },
    { text: "  ", tone: "plain" },
    { text: `${GLYPH.asleep} ${c.asleep}`, tone: "muted" },
    { text: "  ", tone: "plain" },
    { text: applyText, tone: applyTone },
    { text: "  ", tone: "plain" },
    { text: state.tickAgeS === null ? "tick ?" : `tick ${fmtAge(state.tickAgeS)}`, tone: stale ? "warn" : "muted" },
    { text: "   ", tone: "plain" },
    { text: state.scope === "admin" ? "admin" : "readonly", tone: state.scope === "admin" ? "accent" : "muted" },
    { text: "  ", tone: "plain" },
    state.link.up
      ? { text: `link ${GLYPH.healthy} up`, tone: "ok" as Tone }
      : { text: `link ${GLYPH.down} DOWN`, tone: "down" as Tone },
  ];
  return fitSegments(segs, size.cols);
}

export function headerText(state: TuiState, size: Size): string {
  return segText(headerSegments(state, size));
}

// --- box table ---------------------------------------------------------------
// DRIFT is 9, not 7: `unknown` is exactly 7 characters, so a 7-wide cell left no
// gap at all and the fleet read `unknownskip` on screen (r2 fix 1).
const TABLE_HEADER_COLS = { glyph: 2, name: 14, tunnel: 7, check: 6, ver: 10, drift: 9, config: 9, expiry: 8 };

/** The filtered box list (case-insensitive substring on name). */
export function filteredBoxes(state: TuiState): SnapshotBox[] {
  if (state.filter === "") return state.boxes;
  const f = state.filter.toLowerCase();
  return state.boxes.filter((b) => b.name.toLowerCase().includes(f));
}

/**
 * The WHOLE table: the column-header row followed by one row per filtered box
 * (or the empty-list line). `layout.ts` windows it; this function's output is
 * what the parity fixtures compare against.
 */
export function tableLines(state: TuiState, size: Size): TableLine[] {
  const rows: TableLine[] = [];
  const showCanaryCol = state.canary !== null; // C glyph only when snapshot canary non-null
  const head =
    `${pad("", TABLE_HEADER_COLS.glyph)}${pad("NAME", TABLE_HEADER_COLS.name)}` +
    `${pad("TUNNEL", TABLE_HEADER_COLS.tunnel)}${pad("CHECK", TABLE_HEADER_COLS.check)}` +
    `${pad("VER", TABLE_HEADER_COLS.ver)}${pad("DRIFT", TABLE_HEADER_COLS.drift)}` +
    `${pad("CONFIG", TABLE_HEADER_COLS.config)}${pad("EXPIRY", TABLE_HEADER_COLS.expiry)}${showCanaryCol ? "  C" : ""}`;
  const headText = pad(head, size.cols);
  rows.push({ text: headText, tone: "main", bold: true, segments: [{ text: headText, tone: "main", bold: true }] });

  const list = filteredBoxes(state);
  for (let i = 0; i < list.length; i++) {
    const b = list[i]!;
    const health = boxHealth(state, b);
    const t = cellTones(b);
    const dash = (v: string | null | undefined): string => (v === null || v === undefined || v === "" ? "-" : String(v));
    const isCanary = state.canary !== null && b.name === state.canary;
    const selected = i === state.selected;
    const segs: Seg[] = [
      { text: `${health.glyph} `, tone: health.tone },
      { text: pad(b.name, TABLE_HEADER_COLS.name), tone: health.tone, bold: selected },
      { text: pad(dash(b.tunnel), TABLE_HEADER_COLS.tunnel), tone: b.tunnel === null || b.tunnel === undefined ? "muted" : t.tunnel },
      { text: pad(dash(b.check), TABLE_HEADER_COLS.check), tone: b.check === null || b.check === undefined ? "muted" : t.check },
      { text: pad(dash(b.ver), TABLE_HEADER_COLS.ver), tone: t.ver },
      { text: pad(dash(b.drift), TABLE_HEADER_COLS.drift), tone: t.drift },
      { text: pad(dash(b.config), TABLE_HEADER_COLS.config), tone: t.config },
      { text: pad(b.expiry_days === null ? "-" : `${b.expiry_days}d`, TABLE_HEADER_COLS.expiry), tone: t.expiry },
    ];
    if (showCanaryCol) segs.push({ text: isCanary ? `  ${GLYPH.canary}` : "   ", tone: "accent" });
    // Selection: a MAIN-tinted bar (`selected`), and in NO_COLOR mode a leading
    // '>' so a colourless frame still encodes which row is selected.
    if (selected && state.noColor) segs[0] = { ...segs[0]!, text: `>${segs[0]!.text.slice(1)}` };
    rows.push({ text: segText(segs), tone: health.tone, selected, segments: segs });
  }
  if (list.length === 0) {
    const text = pad(state.filter !== "" ? "(no boxes match filter)" : "(no boxes)", size.cols);
    rows.push({ text, tone: "muted", segments: [{ text, tone: "muted" }] });
  }
  return rows;
}

// --- detail pane (24h sparkline) ---------------------------------------------
const SPARK = "▁▂▃▄▅▆▇█";

/** The absent-field marker for the D1 rows (blueprint: absent renders `—`). */
const DASH = "—";
function dashEm(v: string | number | null | undefined): string {
  return v === null || v === undefined ? DASH : String(v);
}

/** Epoch 0 in the shapes the engine can hand us: the API writes the zero time
 *  for "never", and `1970-01-01T00:00:00Z` under `asleep last` reads as a real
 *  event that happened 56 years ago (r2 fix 2). */
const EPOCH_ZERO = /^1970-01-01[T ]00:00:00(\.0+)?(Z|\+00:00)?$/;

/** dashEm for a TIMESTAMP field: absent, empty and epoch 0 all render `—`. */
function dashTs(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "" || v === 0) return DASH;
  const s = String(v);
  return EPOCH_ZERO.test(s) ? DASH : s;
}

/** Health level per history sample: healthy=high, degraded=mid, incident=low. */
function sparkLevel(b: SnapshotBox): number {
  if (b.asleep) return 1;
  if (b.check === "FAIL") return 0;
  if (b.checkfail || b.drift === "yes" || b.config === "drift") return 3;
  if (b.tunnel === "up" && b.check === "OK") return 7;
  return 2;
}

/** V5: one segment per spark cell, toned by its level. */
export function sparkSegments(lines: SnapshotLine[], box: string): Seg[] {
  const oldestFirst = [...lines].reverse();
  const out: Seg[] = [];
  for (const l of oldestFirst) {
    const b = l.boxes.find((x) => x.name === box);
    if (b === undefined) {
      out.push({ text: " ", tone: "muted" });
      continue;
    }
    const level = sparkLevel(b);
    const tone: Tone = level === 7 ? "ok" : level === 3 ? "warn" : level <= 1 ? "down" : "muted";
    out.push({ text: SPARK[level]!, tone });
  }
  return out;
}

/** Render a drift/health sparkline over the box's 24h history (newest-first
 *  lines → we reverse to oldest-first for a left-to-right timeline). */
export function sparkline(lines: SnapshotLine[], box: string): string {
  return segText(sparkSegments(lines, box));
}

/** One `label value` pair of the detail card. */
function field(label: string, value: string, tone: Tone): Seg[] {
  return [
    { text: label, tone: "muted" },
    { text: " ", tone: "muted" },
    { text: value, tone: value === DASH ? "muted" : tone },
  ];
}

function joinFields(groups: Seg[][]): Seg[] {
  const out: Seg[] = [];
  for (const [i, g] of groups.entries()) {
    if (i > 0) out.push({ text: SEP, tone: "muted" });
    out.push(...g);
  }
  return out;
}

/**
 * The Detail pane's lines — exactly DETAIL_ROWS of them when a box is selected,
 * none otherwise. V5: a FRAMED card exactly `width` columns wide, labels muted
 * and values toned like their table cell, every line truncated to the pane so
 * nothing wraps into the frame (the sparkline used to).
 */
export function detailLines(state: TuiState, width: number): DetailLine[] {
  const list = filteredBoxes(state);
  const b = list[state.selected];
  if (b === undefined) return [];
  const t = cellTones(b);
  const inner = Math.max(1, width - 2);

  const body: Seg[][] = [];
  body.push(
    joinFields([
      field("tunnel", b.tunnel, t.tunnel),
      field("check", b.check, t.check),
      field("ver", b.ver, t.ver),
    ]),
  );
  body.push(
    joinFields([
      field("drift", b.drift, t.drift),
      field("config", b.config ?? "-", t.config),
      field("expiry", b.expiry_days === null ? "-" : `${b.expiry_days}d`, t.expiry),
    ]),
  );
  const canary: Seg[] =
    state.canary === null
      ? field("canary", "none", "muted")
      : state.canary === b.name
        ? [
            { text: "canary", tone: "muted" },
            { text: " ", tone: "muted" },
            { text: `${GLYPH.canary} this box`, tone: "accent" },
          ]
        : field("canary", state.canary, "plain");
  body.push(
    joinFields([
      field("checkfail", b.checkfail ? "yes" : "no", b.checkfail ? "warn" : "muted"),
      field("asleep", b.asleep ? "yes" : "no", "muted"),
      canary,
    ]),
  );
  // D1: the facts the engine records and this pane never showed. Rendered ONLY
  // when the stored facts carry the SELECTED box's name — during an in-flight
  // switch the rows read `—`, never box A's numbers under box B's header.
  const f = state.detailFacts !== undefined && state.detailFacts.box === b.name ? state.detailFacts.facts : undefined;
  const cf = f?.checkfail_count;
  body.push(
    joinFields([
      field("checkfail#", dashEm(cf), typeof cf === "number" && cf > 0 ? "warn" : "muted"),
      field("expires", dashTs(f?.expires_at), "plain"),
    ]),
  );
  body.push(field("asleep since", dashTs(f?.asleep_since), "plain"));
  body.push(field("asleep last", dashTs(f?.asleep_last), "plain"));
  const ab = f?.api_backoff;
  body.push(
    ab === null || ab === undefined
      ? field("api backoff", DASH, "muted")
      : [
          { text: "api backoff", tone: "muted" as Tone },
          { text: " ", tone: "muted" as Tone },
          { text: `${ab.fails} fails`, tone: (ab.fails > 0 ? "warn" : "muted") as Tone },
          { text: ", retry ", tone: "muted" as Tone },
          { text: dashTs(ab.next_retry), tone: "plain" as Tone },
        ],
  );
  if (state.detail && state.detail.box === b.name) {
    body.push([
      { text: "24h", tone: "muted" },
      { text: " ", tone: "muted" },
      ...sparkSegments(state.detail.lines, b.name),
    ]);
  } else {
    body.push([{ text: "24h (loading…)", tone: "muted" }]);
  }

  // --- the frame -------------------------------------------------------------
  const rows: DetailLine[] = [];
  const nameFits = stripToWidth(b.name, Math.max(0, inner - 4));
  const rule = Math.max(0, inner - 3 - nameFits.length);
  const top: Seg[] = [
    { text: "╭─ ", tone: "main" },
    { text: nameFits, tone: "main", bold: true },
    { text: ` ${"─".repeat(rule)}╮`, tone: "main" },
  ];
  rows.push({ text: segText(top), tone: "main", bold: true, segments: top });
  for (const line of body) {
    const segs: Seg[] = [
      { text: "│", tone: "main" },
      // BUG FIX (V5): every line is truncated to the pane's inner width, so the
      // 24h sparkline can no longer overflow and wrap into the frame.
      ...fitSegments(line, inner),
      { text: "│", tone: "main" },
    ];
    rows.push({ text: segText(segs), tone: "plain", segments: segs });
  }
  const bottom: Seg[] = [{ text: `╰${"─".repeat(inner)}╯`, tone: "main" }];
  rows.push({ text: segText(bottom), tone: "main", segments: bottom });
  // The budget is fixed at DETAIL_ROWS; if the card does not fit, the bottom
  // line is what goes (V5).
  while (rows.length > DETAIL_ROWS) rows.splice(rows.length - 1, 1);
  return rows;
}

// --- discover summary row (D7) -----------------------------------------------
/**
 * One line, no new view: what the last tick's discover pass saw and did. Absent
 * on a pre-5.6.0 snapshot and on a tick with discovery disabled, and the frame
 * simply has no row then. V4: a NON-zero count is plain against a MUTED line, so
 * `1 adopted` stands out from a row of zeros.
 */
export function discoverSegments(state: TuiState, size: Size): Seg[] | undefined {
  const d = state.discover;
  if (d === null || d === undefined) return undefined;
  const parts: { text: string; n: number }[] = [
    { text: `discover: ${d.candidates} candidate${d.candidates === 1 ? "" : "s"}`, n: d.candidates },
    { text: `${d.adopted} adopted`, n: d.adopted },
    { text: `${d.repaired} repaired`, n: d.repaired },
    { text: `${d.skipped.length} skipped`, n: d.skipped.length },
  ];
  const segs: Seg[] = [];
  for (const [i, p] of parts.entries()) {
    if (i > 0) segs.push({ text: "  ", tone: "muted" });
    segs.push({ text: p.text, tone: p.n > 0 ? "plain" : "muted" });
  }
  if (d.skipped.length > 0) {
    const shown = d.skipped.slice(0, 3).map((s) => `${s.name}:${s.reason}`);
    const more = d.skipped.length > shown.length ? `, +${d.skipped.length - shown.length} more` : "";
    segs.push({ text: ` (${shown.join(", ")}${more})`, tone: "muted" });
  }
  return fitSegments(segs, size.cols);
}

export function discoverText(state: TuiState, size: Size): string | undefined {
  const segs = discoverSegments(state, size);
  return segs === undefined ? undefined : segText(segs);
}

// --- banners -----------------------------------------------------------------
export function bannerText(state: TuiState, size: Size): { text: string; tone: Tone } | undefined {
  if (!state.link.up) {
    const age = Math.max(0, Math.floor((state.nowMs - state.link.sinceMs) / 1000));
    return { text: pad(`LINK DOWN ${fmtAge(age)} — showing last-good data, retrying`, size.cols), tone: "down" };
  }
  if (state.tickAgeS !== null && state.tickAgeS >= STALE_SECONDS) {
    return { text: pad(`STALE ${fmtAge(state.tickAgeS)} — snapshot older than 15m`, size.cols), tone: "warn" };
  }
  if (state.tickAgeS === null && state.snapshotTs === null) {
    return { text: pad("UNKNOWN — no snapshot yet", size.cols), tone: "warn" };
  }
  return undefined;
}

// --- the transient status/action line ----------------------------------------
export function messageText(state: TuiState): string | undefined {
  return state.message;
}

// --- footer keys (scope-aware, TUI-D7/R3-A1, V6) -----------------------------
/**
 * The footer is a LIST OF LINES: the view keys `D diff  J journal  H history`
 * do not fit beside the navigation and action keys at 100 columns. Two lines
 * below 120 columns — navigation + view keys on line 1, action keys on line 2 —
 * one line otherwise, and only when that one line actually FITS the width.
 *
 * V6: the key letter is ACCENT and its word MUTED, and the three groups are
 * separated by a MAIN `│` so the footer is not one unbroken run of letters.
 */
const NAV_KEYS: [string, string][] = [["↑↓", "select"], ["/", "filter"], ["r", "refresh"], ["q", "quit"]];
const VIEW_KEYS: [string, string][] = [["D", "diff"], ["J", "journal"], ["H", "history"]];
const ACTION_KEYS: [string, string][] = [
  ["P", "push"],
  ["M", "rotate"],
  ["R", "rename"],
  ["T", "check"],
  ["C", "reconcile"],
];

function keyGroup(keys: [string, string][]): Seg[] {
  const out: Seg[] = [];
  for (const [i, [k, word]] of keys.entries()) {
    if (i > 0) out.push({ text: "  ", tone: "muted" });
    out.push({ text: k, tone: "accent" });
    out.push({ text: ` ${word}`, tone: "muted" });
  }
  return out;
}

const GROUP_SEP: Seg[] = [
  { text: " ", tone: "muted" },
  { text: "│", tone: "main" },
  { text: " ", tone: "muted" },
];

/** The footer's lines as SEGMENTS; `footerLines` is their plain text. */
export function footerSegmentLines(state: TuiState, size: Size): Seg[][] {
  const admin = state.scope === "admin";
  const nav = keyGroup(NAV_KEYS);
  const views = keyGroup(VIEW_KEYS);
  const actions: Seg[] = keyGroup(ACTION_KEYS);
  if (!admin) actions.push({ text: "  (admin token required)", tone: "muted" });
  const navLine = [...nav, ...GROUP_SEP, ...views];
  const oneLine = [...navLine, ...GROUP_SEP, ...actions];
  if (size.cols >= 120 && segText(oneLine).length <= size.cols) return [fitSegments(oneLine, size.cols)];
  return [fitSegments(navLine, size.cols), fitSegments(actions, size.cols)];
}

export function footerLines(state: TuiState, size: Size): string[] {
  return footerSegmentLines(state, size).map(segText);
}

// --- viewport (D5b) ----------------------------------------------------------
/** The painted slice of a view's content: `[start, end)` plus the CLAMPED offset. */
export interface Viewport {
  start: number;
  end: number;
  offset: number;
}

/** Clamp a scroll offset to `[0, max(0, total − rowsAvailable)]` and return the
 *  window to paint. */
export function viewportWindow(total: number, offset: number, rowsAvailable: number): Viewport {
  const rows = Math.max(1, rowsAvailable);
  const max = Math.max(0, total - rows);
  const clamped = Math.min(Math.max(0, offset), max);
  return { start: clamped, end: Math.min(total, clamped + rows), offset: clamped };
}

/**
 * The non-content rows a VIEW's frame spends, in the order the frame emits them:
 * header, banner when one is showing, the blank after it, the view title, the
 * blank + message line when a message is set, the blank before the footer, and
 * the footer's own lines. The view branch never paints the discover row, so it
 * is deliberately NOT in this count.
 */
export function viewChromeRows(state: TuiState, size: Size): number {
  let n = 1; // header
  if (bannerText(state, size) !== undefined) n += 1; // LINK DOWN / STALE / UNKNOWN
  n += 1; // blank spacer after the header/banner
  n += 1; // the view title (carries the `rows a–b of N` indicator)
  if (messageText(state) !== undefined) n += 2; // blank spacer + the message line
  n += 1; // blank spacer before the footer
  n += footerLines(state, size).length;
  return n;
}

/** Content rows a view may paint at this size (at least one). */
export function viewRowsAvailable(state: TuiState, size: Size): number {
  return Math.max(1, size.rows - viewChromeRows(state, size));
}

// --- views (D2 diff / D3 journal / D4 history) -------------------------------
/** 24h at one tick per 5 min (D4). The cap keeps the NEWEST rows. */
export const HISTORY_MAX_ROWS = 288;

const HIST_COLS = { ts: 22, tunnel: 7, check: 6, ver: 10, drift: 7, config: 9, checkfail: 10, asleep: 7, apply: 5 };

/** One row per snapshot line, NEWEST FIRST, capped at the newest 288. */
export function historyRows(lines: SnapshotLine[], box: string): string[] {
  const head =
    `${pad("TS", HIST_COLS.ts)}${pad("TUNNEL", HIST_COLS.tunnel)}${pad("CHECK", HIST_COLS.check)}` +
    `${pad("VER", HIST_COLS.ver)}${pad("DRIFT", HIST_COLS.drift)}${pad("CONFIG", HIST_COLS.config)}` +
    `${pad("CHECKFAIL", HIST_COLS.checkfail)}${pad("ASLEEP", HIST_COLS.asleep)}${pad("APPLY", HIST_COLS.apply)}`;
  const rows = [head];
  for (const l of lines.slice(0, HISTORY_MAX_ROWS)) {
    const b = l.boxes.find((x) => x.name === box);
    if (b === undefined) {
      rows.push(`${pad(l.ts, HIST_COLS.ts)}(no row for this box)`);
      continue;
    }
    rows.push(
      `${pad(l.ts, HIST_COLS.ts)}${pad(b.tunnel, HIST_COLS.tunnel)}${pad(b.check, HIST_COLS.check)}` +
        `${pad(b.ver, HIST_COLS.ver)}${pad(b.drift, HIST_COLS.drift)}${pad(b.config ?? "-", HIST_COLS.config)}` +
        `${pad(b.checkfail ? "yes" : "no", HIST_COLS.checkfail)}${pad(b.asleep ? "yes" : "no", HIST_COLS.asleep)}` +
        `${pad(l.apply ? "yes" : "no", HIST_COLS.apply)}`,
    );
  }
  return rows;
}

/** The content rows of the open view (before the viewport is applied). */
export function viewContent(state: TuiState): string[] {
  const v = state.view;
  if (v === undefined) return [];
  if (v.error !== undefined) return [v.error];
  if (v.loading) return ["(loading…)"];
  if (v.kind === "history") {
    const lines = v.history ?? [];
    if (lines.length === 0) return ["(no history in the last 24h)"];
    return historyRows(lines, v.box);
  }
  const lines = v.lines ?? [];
  // D2: an empty diff is not an empty screen — it is the answer.
  if (lines.length === 0) return v.kind === "diff" ? ["in sync"] : ["(no output)"];
  return lines;
}

/** The full-frame view body: the title (with the position indicator) + window. */
export function viewLines(state: TuiState, size: Size): ToneLine[] {
  const v = state.view;
  if (v === undefined) return [];
  const content = viewContent(state);
  const win = viewportWindow(content.length, v.offset, viewRowsAvailable(state, size));
  const from = content.length === 0 ? 0 : win.start + 1;
  const indicator = `rows ${from}–${win.end} of ${content.length}`;
  const rows: ToneLine[] = [];
  rows.push({
    text: pad(stripToWidth(`── ${v.kind} ${v.box} ──  ${indicator}`, size.cols), size.cols),
    tone: "main",
    bold: true,
  });
  for (const line of content.slice(win.start, win.end)) rows.push({ text: stripToWidth(line, size.cols), tone: "plain" });
  return rows;
}

// --- modal -------------------------------------------------------------------
export function modalLines(state: TuiState): ToneLine[] {
  const m = state.modal;
  if (m === undefined) return [];
  const rows: ToneLine[] = [];
  rows.push({ text: `┌─ ${m.actionLabel} ${m.box} ─┐`, tone: "main", bold: true });
  if (m.note) rows.push({ text: m.note, tone: "muted" });
  if (m.target !== undefined) {
    const active = m.field === "target";
    rows.push({ text: `new name: ${m.target}${active ? "_" : ""}`, tone: "plain" });
  }
  const activeConfirm = m.field === "confirm";
  rows.push({ text: `type box name to confirm: ${m.typed}${activeConfirm ? "_" : ""}`, tone: "plain" });
  rows.push({ text: `(expect "${m.expect}")   Enter=confirm  Esc=cancel`, tone: "muted" });
  return rows;
}

/** The literal `rows a–b of N` indicator, shared by the views and the table so
 *  the two never drift apart in wording. */
export function rowsIndicator(win: Viewport, total: number): string {
  const from = total === 0 ? 0 : win.start + 1;
  return `rows ${from}–${win.end} of ${total}`;
}
