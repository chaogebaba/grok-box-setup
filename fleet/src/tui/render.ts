// render.ts — pure frame functions (TUI-D5). Every frame is a pure function of
// (state, size) → string, so it is snapshot-tested TTY-free. Null/missing
// per-box fields render `-`. Colors go through a NO_COLOR-aware palette. Layout
// per §5: header, box table (glyphs + CONFIG column), detail pane (24h
// sparkline), footer keys; modals + LINK DOWN / STALE banners.

import type { SnapshotBox, SnapshotDiscover, SnapshotLine } from "../history/schema.ts";
import type { BoxDetail } from "./api-client.ts";
import type { Scope } from "../serve/tokens.ts";

export interface Size {
  cols: number;
  rows: number;
}

/** The three full-frame views (D2/D3/D4). */
export type ViewKind = "diff" | "journal" | "history";

/**
 * An OPEN full-frame view. Everything here is a COPY captured at open (D6): the
 * box name, and the content. The 5s fleet poll keeps running underneath and may
 * move the selection, but a view's rows never swap under the operator and the
 * title always names the box the view was opened on.
 */
export interface ViewState {
  kind: ViewKind;
  /** the box captured at OPEN — NOT the current selection. */
  box: string;
  /** scroll offset in content rows; clamped at paint time (D5b). */
  offset: number;
  /** true between open/`r` and the response landing. */
  loading: boolean;
  /** captured text content (diff, journal). */
  lines?: string[];
  /** captured history copy, newest-first (D4). */
  history?: SnapshotLine[];
  /** a rendered failure line (403 text, link error, …) instead of content. */
  error?: string;
}

/** A modal in progress (typed-name confirm, TUI-D10). */
export interface ModalState {
  actionLabel: string;
  box: string;
  /** what the user has typed so far (the confirm/box-name). */
  typed: string;
  /** rename's target box (second field) when applicable. */
  target?: string;
  /** which field is active for a two-field modal. */
  field: "confirm" | "target";
  note?: string;
  /** the expected confirm value (box name or "fleet"). */
  expect: string;
}

export interface TuiState {
  /** last-good fleet view (may be stale while link is down). */
  boxes: SnapshotBox[];
  snapshotTs: string | null;
  apply: boolean | null;
  /** "snapshot" ⇒ the live config read failed and this value may be stale; the
   *  header suffixes it with `?` so nobody acts on a stale apply reading. */
  applySource: "config" | "snapshot";
  canary: string | null;
  scope: Scope;
  /** tick age seconds derived from snapshotTs vs now (null unknown). */
  tickAgeS: number | null;
  /** link state: up, or down since epoch-ms. */
  link: { up: true } | { up: false; sinceMs: number };
  /** now (ms) for age/banner computation (injected). */
  nowMs: number;
  /** the selected row index into the FILTERED list. */
  selected: number;
  /** active filter substring ("" = none). */
  filter: string;
  /** true while the filter input is active. */
  filtering: boolean;
  /** the detail pane's 24h history for the selected box (newest-first). */
  detail?: { box: string; lines: SnapshotLine[] };
  /** the D1 detail facts, stored WITH the box name they were fetched for. The
   *  pane renders them ONLY when that name matches the selection, so an
   *  in-flight switch shows `—` rather than the previous box's numbers. */
  detailFacts?: { box: string; facts: BoxDetail };
  /** the open full-frame view, if any (D2/D3/D4). */
  view?: ViewState;
  /** a transient status/action message (footer). */
  message?: string;
  /** an open modal, if any. */
  modal?: ModalState;
  /** whether NO_COLOR is set. */
  noColor: boolean;
  /** zero-touch join summary for the last tick (D7); null/absent ⇒ no row. */
  discover?: SnapshotDiscover | null;
}

// --- ANSI palette (NO_COLOR-aware) -------------------------------------------
const CSI = "\x1b[";
function sgr(state: TuiState, code: string, s: string): string {
  if (state.noColor) return s;
  return `${CSI}${code}m${s}${CSI}0m`;
}
const C = {
  green: "32",
  red: "31",
  yellow: "33",
  dim: "2",
  bold: "1",
  reverse: "7",
  greyfg: "90",
};

const STALE_SECONDS = 15 * 60; // TUI-D7

/** Glyph + color for a box's health (TUI-D5). Order: incident > degraded >
 *  asleep > healthy > down/unknown. `◌` (asleep) is DIM, never an error color. */
export function boxGlyph(state: TuiState, b: SnapshotBox): string {
  if (b.asleep) return sgr(state, C.dim, "◌"); // dim, NOT an error color
  if (b.check === "FAIL") return sgr(state, C.red, "✕"); // incident
  if (b.checkfail || b.drift === "yes" || b.config === "drift") return sgr(state, C.yellow, "!"); // degraded
  if (b.tunnel === "up" && b.check === "OK") return sgr(state, C.green, "●"); // healthy
  return sgr(state, C.dim, "○"); // down / never-probed / unknown
}

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

// --- header ------------------------------------------------------------------
export function renderHeader(state: TuiState, size: Size): string {
  const c = counts(state.boxes);
  const applyStr =
    state.apply === null
      ? "apply=?"
      : `apply=${state.apply ? "ON" : "off"}${state.applySource === "config" ? "" : "?"}`;
  const tick = state.tickAgeS === null ? "tick=?" : `tick=${fmtAge(state.tickAgeS)}`;
  const linkStr = state.link.up
    ? sgr(state, C.green, "link=up")
    : sgr(state, C.red, `link=DOWN`);
  const scopeStr = state.scope === "admin" ? "admin" : sgr(state, C.dim, "readonly");
  const left = `fleet2 ${c.total} boxes  ●${c.healthy} !${c.degraded} ✕${c.down} ◌${c.asleep}  ${applyStr}  ${tick}`;
  const right = `${scopeStr}  ${linkStr}`;
  // best-effort single-line header trimmed to width.
  const line = `${left}   ${right}`;
  return sgr(state, C.bold, pad(stripToWidth(line, size.cols), size.cols));
}

/** strip a string with embedded ANSI to a visible width (approx: we only build
 *  the header from short pieces, so a plain slice on the raw is close enough for
 *  the snapshot tests which run with NO_COLOR). */
function stripToWidth(s: string, cols: number): string {
  // when colored, do not truncate mid-escape; the snapshot tests use NO_COLOR.
  return s.length > cols ? s.slice(0, cols) : s;
}

// --- box table ---------------------------------------------------------------
const TABLE_HEADER_COLS = { glyph: 2, name: 14, tunnel: 7, check: 6, ver: 10, drift: 7, config: 9, expiry: 8 };

/** The filtered box list (case-insensitive substring on name). */
export function filteredBoxes(state: TuiState): SnapshotBox[] {
  if (state.filter === "") return state.boxes;
  const f = state.filter.toLowerCase();
  return state.boxes.filter((b) => b.name.toLowerCase().includes(f));
}

export function renderTable(state: TuiState, size: Size): string[] {
  const rows: string[] = [];
  const showCanaryCol = state.canary !== null; // C glyph only when snapshot canary non-null
  const head =
    `${pad("", TABLE_HEADER_COLS.glyph)}${pad("NAME", TABLE_HEADER_COLS.name)}` +
    `${pad("TUNNEL", TABLE_HEADER_COLS.tunnel)}${pad("CHECK", TABLE_HEADER_COLS.check)}` +
    `${pad("VER", TABLE_HEADER_COLS.ver)}${pad("DRIFT", TABLE_HEADER_COLS.drift)}` +
    `${pad("CONFIG", TABLE_HEADER_COLS.config)}${pad("EXPIRY", TABLE_HEADER_COLS.expiry)}${showCanaryCol ? "  C" : ""}`;
  rows.push(sgr(state, C.dim, pad(head, size.cols)));

  const list = filteredBoxes(state);
  for (let i = 0; i < list.length; i++) {
    const b = list[i]!;
    const glyph = boxGlyph(state, b);
    const dash = (v: string | null | undefined): string => (v === null || v === undefined || v === "" ? "-" : String(v));
    const isCanary = state.canary !== null && b.name === state.canary;
    const cells =
      `${pad("", 0)}${glyph} ` +
      `${pad(b.name, TABLE_HEADER_COLS.name)}` +
      `${pad(dash(b.tunnel), TABLE_HEADER_COLS.tunnel)}` +
      `${pad(dash(b.check), TABLE_HEADER_COLS.check)}` +
      `${pad(dash(b.ver), TABLE_HEADER_COLS.ver)}` +
      `${pad(dash(b.drift), TABLE_HEADER_COLS.drift)}` +
      `${pad(dash(b.config), TABLE_HEADER_COLS.config)}` +
      `${pad(b.expiry_days === null ? "-" : `${b.expiry_days}d`, TABLE_HEADER_COLS.expiry)}` +
      `${showCanaryCol ? (isCanary ? sgr(state, C.green, "  C") : "   ") : ""}`;
    // selection highlight (reverse video) — the visible content is the same so
    // snapshots with NO_COLOR show a stable row; a leading '>' marks selection
    // in NO_COLOR mode so the snapshot still encodes it.
    const selected = i === state.selected;
    if (selected) {
      rows.push(state.noColor ? `>${cells.slice(1)}` : sgr(state, C.reverse, cells));
    } else {
      rows.push(cells);
    }
  }
  if (list.length === 0) {
    rows.push(sgr(state, C.dim, pad(state.filter !== "" ? "(no boxes match filter)" : "(no boxes)", size.cols)));
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

/** Render a drift/health sparkline over the box's 24h history (newest-first
 *  lines → we reverse to oldest-first for a left-to-right timeline). */
export function sparkline(lines: SnapshotLine[], box: string): string {
  const oldestFirst = [...lines].reverse();
  let out = "";
  for (const l of oldestFirst) {
    const b = l.boxes.find((x) => x.name === box);
    if (b === undefined) {
      out += " ";
      continue;
    }
    // map health to a spark height: healthy=high, degraded=mid, incident=low.
    let level = 0;
    if (b.asleep) level = 1;
    else if (b.check === "FAIL") level = 0;
    else if (b.checkfail || b.drift === "yes" || b.config === "drift") level = 3;
    else if (b.tunnel === "up" && b.check === "OK") level = 7;
    else level = 2;
    out += SPARK[level];
  }
  return out;
}

export function renderDetail(state: TuiState, size: Size): string[] {
  const list = filteredBoxes(state);
  const b = list[state.selected];
  if (b === undefined) return [];
  const rows: string[] = [];
  rows.push(sgr(state, C.bold, `── ${b.name} ─────`));
  rows.push(`tunnel: ${b.tunnel}   check: ${b.check}   ver: ${b.ver}`);
  rows.push(`drift: ${b.drift}   config: ${b.config ?? "-"}   expiry: ${b.expiry_days === null ? "-" : b.expiry_days + "d"}`);
  rows.push(`checkfail: ${b.checkfail ? "yes" : "no"}   asleep: ${b.asleep ? "yes" : "no"}`);
  const canaryLabel = state.canary === null ? "canary: none" : state.canary === b.name ? "canary: THIS box" : `canary: ${state.canary}`;
  rows.push(canaryLabel);
  // D1: the facts the engine records and this pane never showed. Rendered ONLY
  // when the stored facts carry the SELECTED box's name — during an in-flight
  // switch the rows read `—`, never box A's numbers under box B's header.
  const f = state.detailFacts !== undefined && state.detailFacts.box === b.name ? state.detailFacts.facts : undefined;
  rows.push(`checkfail#: ${dashEm(f?.checkfail_count)}   expires: ${dashEm(f?.expires_at)}`);
  rows.push(`asleep since: ${dashEm(f?.asleep_since)}`);
  rows.push(`asleep last: ${dashEm(f?.asleep_last)}`);
  const ab = f?.api_backoff;
  rows.push(
    `api backoff: ${
      ab === null || ab === undefined ? DASH : `${ab.fails} fails, retry ${dashEm(ab.next_retry)}`
    }`,
  );
  if (state.detail && state.detail.box === b.name) {
    rows.push(`24h: ${sparkline(state.detail.lines, b.name)}`);
  } else {
    rows.push(sgr(state, C.dim, "24h: (loading…)"));
  }
  void size;
  return rows;
}

// --- discover summary row (D7) -----------------------------------------------
/**
 * One line, no new view: what the last tick's discover pass saw and did. Absent
 * on a pre-5.6.0 snapshot and on a tick with discovery disabled, and the frame
 * simply has no row then. The skip list is summarised by count and the first
 * few names, because it is the only unbounded part of the object.
 */
export function renderDiscover(state: TuiState, size: Size): string | undefined {
  const d = state.discover;
  if (d === null || d === undefined) return undefined;
  const parts = [
    `discover: ${d.candidates} candidate${d.candidates === 1 ? "" : "s"}`,
    `${d.adopted} adopted`,
    `${d.repaired} repaired`,
    `${d.skipped.length} skipped`,
  ];
  let line = parts.join("  ");
  if (d.skipped.length > 0) {
    const shown = d.skipped.slice(0, 3).map((s) => `${s.name}:${s.reason}`);
    const more = d.skipped.length > shown.length ? `, +${d.skipped.length - shown.length} more` : "";
    line += ` (${shown.join(", ")}${more})`;
  }
  return sgr(state, C.dim, pad(stripToWidth(line, size.cols), size.cols));
}

// --- banners -----------------------------------------------------------------
export function renderBanner(state: TuiState, size: Size): string | undefined {
  if (!state.link.up) {
    const age = Math.max(0, Math.floor((state.nowMs - state.link.sinceMs) / 1000));
    return sgr(state, C.red, pad(`LINK DOWN ${fmtAge(age)} — showing last-good data, retrying`, size.cols));
  }
  if (state.tickAgeS !== null && state.tickAgeS >= STALE_SECONDS) {
    return sgr(state, C.yellow, pad(`STALE ${fmtAge(state.tickAgeS)} — snapshot older than 15m`, size.cols));
  }
  if (state.tickAgeS === null && state.snapshotTs === null) {
    return sgr(state, C.yellow, pad("UNKNOWN — no snapshot yet", size.cols));
  }
  return undefined;
}

// --- footer keys (scope-aware, TUI-D7/R3-A1; re-laid out for D5) -------------
/**
 * The footer is now a LIST OF LINES, not one string (D5): the view keys
 * `D diff  J journal  H history` no longer fit beside the navigation and action
 * keys at 100 columns. Two lines below 120 columns — navigation + view keys on
 * line 1, action keys on line 2 — one line otherwise.
 *
 * The `otherwise` carries one extra guard: a single line is only emitted when it
 * actually FITS the width. At 120-130 columns a readonly footer's action half
 * carries the `(admin token required)` note and the composed line runs past the
 * width, and D5's own rule is that no key may fall off at >= 100 columns. Where
 * the two readings disagree the no-key-falls-off rule wins and the footer splits.
 */
export function renderFooter(state: TuiState, size: Size): string[] {
  const admin = state.scope === "admin";
  const nav = ["↑/↓ select", "/ filter", "r refresh", "q quit"].join("  ");
  const views = ["D diff", "J journal", "H history"].join("  ");
  const actionKeys = ["P push", "M rotate", "R rename", "T check", "C reconcile"].join("  ");
  const actions = admin ? actionKeys : `${actionKeys}  (admin token required)`;
  const navLine = `${nav}  ${views}`;
  const oneLine = `${navLine}  ${actions}`;
  const dim = (s: string): string => sgr(state, C.dim, pad(stripToWidth(s, size.cols), size.cols));
  if (size.cols >= 120 && oneLine.length <= size.cols) return [dim(oneLine)];
  return [dim(navLine), dim(actions)];
}

// --- viewport (D5b) ----------------------------------------------------------
/** The painted slice of a view's content: `[start, end)` plus the CLAMPED offset. */
export interface Viewport {
  start: number;
  end: number;
  offset: number;
}

/**
 * Clamp a scroll offset to `[0, max(0, total − rowsAvailable)]` and return the
 * window to paint. The MAIN TABLE does not call this — its behaviour is
 * unchanged and out of scope (gate note 2) — but every view does, so a 40-box
 * fleet's table is never clipped by a change made for the views.
 */
export function viewportWindow(total: number, offset: number, rowsAvailable: number): Viewport {
  const rows = Math.max(1, rowsAvailable);
  const max = Math.max(0, total - rows);
  const clamped = Math.min(Math.max(0, offset), max);
  return { start: clamped, end: Math.min(total, clamped + rows), offset: clamped };
}

/**
 * The non-content rows a view's frame spends. The render layer used to key on
 * columns only and never consult `size.rows`; a view has to, or it paints past
 * the bottom of the terminal and the footer scrolls away.
 *
 * Counted here, in the order `renderFrame` emits them (gate note 1 — the blank
 * SPACERS and the message line are chrome too, and the footer is TWO lines below
 * 120 columns): header, banner when one is showing, the blank after it, the view
 * title, the blank + message line when a message is set, the blank before the
 * footer, and the footer's own lines.
 */
export function viewChromeRows(state: TuiState, size: Size): number {
  let n = 1; // header
  if (renderBanner(state, size) !== undefined) n += 1; // LINK DOWN / STALE / UNKNOWN
  n += 1; // blank spacer after the header/banner
  n += 1; // the view title (carries the `rows a–b of N` indicator)
  if (state.message) n += 2; // blank spacer + the message line
  n += 1; // blank spacer before the footer
  n += renderFooter(state, size).length;
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

/**
 * One row per snapshot line, NEWEST FIRST (the order `readSlice` already
 * returns and `state.detail.lines` already holds), capped at the newest 288.
 * No `apply_source` column: a snapshot line records `apply` only, and
 * provenance is computed live per request rather than recorded (B2).
 */
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
export function renderView(state: TuiState, size: Size): string[] {
  const v = state.view;
  if (v === undefined) return [];
  const content = viewContent(state);
  const win = viewportWindow(content.length, v.offset, viewRowsAvailable(state, size));
  const from = content.length === 0 ? 0 : win.start + 1;
  const indicator = `rows ${from}–${win.end} of ${content.length}`;
  const rows: string[] = [];
  rows.push(sgr(state, C.bold, pad(stripToWidth(`── ${v.kind} ${v.box} ──  ${indicator}`, size.cols), size.cols)));
  for (const line of content.slice(win.start, win.end)) rows.push(stripToWidth(line, size.cols));
  return rows;
}

// --- modal -------------------------------------------------------------------
export function renderModal(state: TuiState, size: Size): string[] {
  const m = state.modal;
  if (m === undefined) return [];
  const rows: string[] = [];
  rows.push(sgr(state, C.bold, `┌─ ${m.actionLabel} ${m.box} ─┐`));
  if (m.note) rows.push(sgr(state, C.dim, m.note));
  if (m.target !== undefined) {
    const active = m.field === "target";
    rows.push(`new name: ${m.target}${active ? "_" : ""}`);
  }
  const activeConfirm = m.field === "confirm";
  rows.push(`type box name to confirm: ${m.typed}${activeConfirm ? "_" : ""}`);
  rows.push(sgr(state, C.dim, `(expect "${m.expect}")   Enter=confirm  Esc=cancel`));
  void size;
  return rows;
}

// --- full frame --------------------------------------------------------------
/** Compose the whole frame. Detail pane dropped when cols < 100 (§5). */
export function renderFrame(state: TuiState, size: Size): string {
  const lines: string[] = [];
  lines.push(renderHeader(state, size));
  const banner = renderBanner(state, size);
  if (banner !== undefined) lines.push(banner);

  // --- an open view REPLACES the table (D2/D3/D4) ---------------------------
  // The LINK DOWN / STALE banners keep their precedence and render ABOVE it;
  // the table and its discover row are suppressed while a view is open. The
  // chrome counted here is exactly what `viewChromeRows` counts.
  if (state.view !== undefined) {
    lines.push("");
    for (const r of renderView(state, size)) lines.push(r);
    if (state.message) {
      lines.push("");
      lines.push(sgr(state, C.dim, stripToWidth(state.message, size.cols)));
    }
    lines.push("");
    for (const f of renderFooter(state, size)) lines.push(f);
    return lines.join("\n");
  }

  const discoverRow = renderDiscover(state, size);
  if (discoverRow !== undefined) lines.push(discoverRow);
  lines.push("");

  const table = renderTable(state, size);
  const detail = size.cols >= 100 ? renderDetail(state, size) : [];

  if (detail.length > 0) {
    // side-by-side: table on the left ~60%, detail on the right.
    const leftW = Math.max(40, Math.floor(size.cols * 0.6));
    const maxRows = Math.max(table.length, detail.length);
    for (let i = 0; i < maxRows; i++) {
      const l = table[i] ?? "";
      const r = detail[i] ?? "";
      lines.push(`${padVisible(l, leftW, state.noColor)}  ${r}`);
    }
  } else {
    for (const t of table) lines.push(t);
  }

  if (state.modal) {
    lines.push("");
    for (const m of renderModal(state, size)) lines.push(m);
  } else if (state.message) {
    lines.push("");
    lines.push(sgr(state, C.dim, stripToWidth(state.message, size.cols)));
  }

  lines.push("");
  for (const f of renderFooter(state, size)) lines.push(f);
  return lines.join("\n");
}

/** Pad to a visible width; when colored we can't measure easily, so only pad in
 *  NO_COLOR mode (the snapshot tests run NO_COLOR; live color mode just spaces). */
function padVisible(s: string, w: number, noColor: boolean): string {
  if (!noColor) return s; // live mode: skip precise padding (color escapes)
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
