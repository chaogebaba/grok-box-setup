// model.ts — the TUI's presentation MODEL (fleet-tui-ink D1).
//
// RULE: everything here returns plain strings or plain data. Not one ANSI byte
// is produced in this file. Colour is a semantic `Tone` the components hand to
// `toneProps` (tone.ts); layout is Ink's job. These functions are the old
// `render.ts` painters with every `sgr()` call removed, which is what lets the
// parity fixtures in `test/tui/fixtures/` compare the new frames against the
// hand-rolled painter byte for byte.

import type { SnapshotBox, SnapshotLine } from "../history/schema.ts";
import type { TuiState } from "./state.ts";
import type { Tone } from "./tone.ts";

export interface Size {
  cols: number;
  rows: number;
}

/** One painted line: its plain text plus how to colour it. */
export interface ToneLine {
  text: string;
  tone: Tone;
  /** the old painter's `C.bold` — kept as a flag so the components stay thin. */
  bold?: boolean;
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

// --- health ------------------------------------------------------------------
/** Glyph + tone for a box's health (TUI-D5). Order: incident > degraded >
 *  asleep > healthy > down/unknown. `◌` (asleep) is DIM, never an error tone. */
export function boxHealth(state: TuiState, b: SnapshotBox): { glyph: string; tone: Tone } {
  void state;
  if (b.asleep) return { glyph: "◌", tone: "dim" }; // dim, NOT an error colour
  if (b.check === "FAIL") return { glyph: "✕", tone: "down" }; // incident
  if (b.checkfail || b.drift === "yes" || b.config === "drift") return { glyph: "!", tone: "warn" }; // degraded
  if (b.tunnel === "up" && b.check === "OK") return { glyph: "●", tone: "ok" }; // healthy
  return { glyph: "○", tone: "dim" }; // down / never-probed / unknown
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
export function headerText(state: TuiState, size: Size): string {
  const c = counts(state.boxes);
  const applyStr =
    state.apply === null
      ? "apply=?"
      : `apply=${state.apply ? "ON" : "off"}${state.applySource === "config" ? "" : "?"}`;
  const tick = state.tickAgeS === null ? "tick=?" : `tick=${fmtAge(state.tickAgeS)}`;
  const linkStr = state.link.up ? "link=up" : "link=DOWN";
  const scopeStr = state.scope === "admin" ? "admin" : "readonly";
  const left = `fleet2 ${c.total} boxes  ●${c.healthy} !${c.degraded} ✕${c.down} ◌${c.asleep}  ${applyStr}  ${tick}`;
  const right = `${scopeStr}  ${linkStr}`;
  return pad(stripToWidth(`${left}   ${right}`, size.cols), size.cols);
}

// --- box table ---------------------------------------------------------------
const TABLE_HEADER_COLS = { glyph: 2, name: 14, tunnel: 7, check: 6, ver: 10, drift: 7, config: 9, expiry: 8 };

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
  rows.push({ text: pad(head, size.cols), tone: "dim" });

  const list = filteredBoxes(state);
  for (let i = 0; i < list.length; i++) {
    const b = list[i]!;
    const health = boxHealth(state, b);
    const dash = (v: string | null | undefined): string => (v === null || v === undefined || v === "" ? "-" : String(v));
    const isCanary = state.canary !== null && b.name === state.canary;
    const cells =
      `${pad("", 0)}${health.glyph} ` +
      `${pad(b.name, TABLE_HEADER_COLS.name)}` +
      `${pad(dash(b.tunnel), TABLE_HEADER_COLS.tunnel)}` +
      `${pad(dash(b.check), TABLE_HEADER_COLS.check)}` +
      `${pad(dash(b.ver), TABLE_HEADER_COLS.ver)}` +
      `${pad(dash(b.drift), TABLE_HEADER_COLS.drift)}` +
      `${pad(dash(b.config), TABLE_HEADER_COLS.config)}` +
      `${pad(b.expiry_days === null ? "-" : `${b.expiry_days}d`, TABLE_HEADER_COLS.expiry)}` +
      `${showCanaryCol ? (isCanary ? "  C" : "   ") : ""}`;
    // Selection: reverse video (`selected`), and in NO_COLOR mode a leading '>'
    // so a colourless frame still encodes which row is selected.
    const selected = i === state.selected;
    rows.push({
      text: selected && state.noColor ? `>${cells.slice(1)}` : cells,
      tone: health.tone,
      selected,
    });
  }
  if (list.length === 0) {
    rows.push({ text: pad(state.filter !== "" ? "(no boxes match filter)" : "(no boxes)", size.cols), tone: "dim" });
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

/** The Detail pane's lines — exactly DETAIL_ROWS of them when a box is
 *  selected, none otherwise. */
export function detailLines(state: TuiState): DetailLine[] {
  const list = filteredBoxes(state);
  const b = list[state.selected];
  if (b === undefined) return [];
  const rows: DetailLine[] = [];
  rows.push({ text: `── ${b.name} ─────`, tone: "plain", bold: true });
  rows.push({ text: `tunnel: ${b.tunnel}   check: ${b.check}   ver: ${b.ver}`, tone: "plain" });
  rows.push({
    text: `drift: ${b.drift}   config: ${b.config ?? "-"}   expiry: ${b.expiry_days === null ? "-" : b.expiry_days + "d"}`,
    tone: "plain",
  });
  rows.push({ text: `checkfail: ${b.checkfail ? "yes" : "no"}   asleep: ${b.asleep ? "yes" : "no"}`, tone: "plain" });
  const canaryLabel = state.canary === null ? "canary: none" : state.canary === b.name ? "canary: THIS box" : `canary: ${state.canary}`;
  rows.push({ text: canaryLabel, tone: "plain" });
  // D1: the facts the engine records and this pane never showed. Rendered ONLY
  // when the stored facts carry the SELECTED box's name — during an in-flight
  // switch the rows read `—`, never box A's numbers under box B's header.
  const f = state.detailFacts !== undefined && state.detailFacts.box === b.name ? state.detailFacts.facts : undefined;
  rows.push({ text: `checkfail#: ${dashEm(f?.checkfail_count)}   expires: ${dashEm(f?.expires_at)}`, tone: "plain" });
  rows.push({ text: `asleep since: ${dashEm(f?.asleep_since)}`, tone: "plain" });
  rows.push({ text: `asleep last: ${dashEm(f?.asleep_last)}`, tone: "plain" });
  const ab = f?.api_backoff;
  rows.push({
    text: `api backoff: ${ab === null || ab === undefined ? DASH : `${ab.fails} fails, retry ${dashEm(ab.next_retry)}`}`,
    tone: "plain",
  });
  if (state.detail && state.detail.box === b.name) {
    rows.push({ text: `24h: ${sparkline(state.detail.lines, b.name)}`, tone: "plain" });
  } else {
    rows.push({ text: "24h: (loading…)", tone: "dim" });
  }
  return rows;
}

// --- discover summary row (D7) -----------------------------------------------
/**
 * One line, no new view: what the last tick's discover pass saw and did. Absent
 * on a pre-5.6.0 snapshot and on a tick with discovery disabled, and the frame
 * simply has no row then.
 */
export function discoverText(state: TuiState, size: Size): string | undefined {
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
  return pad(stripToWidth(line, size.cols), size.cols);
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

// --- footer keys (scope-aware, TUI-D7/R3-A1) ---------------------------------
/**
 * The footer is a LIST OF LINES: the view keys `D diff  J journal  H history`
 * do not fit beside the navigation and action keys at 100 columns. Two lines
 * below 120 columns — navigation + view keys on line 1, action keys on line 2 —
 * one line otherwise, and only when that one line actually FITS the width.
 */
export function footerLines(state: TuiState, size: Size): string[] {
  const admin = state.scope === "admin";
  const nav = ["↑/↓ select", "/ filter", "r refresh", "q quit"].join("  ");
  const views = ["D diff", "J journal", "H history"].join("  ");
  const actionKeys = ["P push", "M rotate", "R rename", "T check", "C reconcile"].join("  ");
  const actions = admin ? actionKeys : `${actionKeys}  (admin token required)`;
  const navLine = `${nav}  ${views}`;
  const oneLine = `${navLine}  ${actions}`;
  const fit = (s: string): string => pad(stripToWidth(s, size.cols), size.cols);
  if (size.cols >= 120 && oneLine.length <= size.cols) return [fit(oneLine)];
  return [fit(navLine), fit(actions)];
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
    tone: "plain",
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
  rows.push({ text: `┌─ ${m.actionLabel} ${m.box} ─┐`, tone: "plain", bold: true });
  if (m.note) rows.push({ text: m.note, tone: "dim" });
  if (m.target !== undefined) {
    const active = m.field === "target";
    rows.push({ text: `new name: ${m.target}${active ? "_" : ""}`, tone: "plain" });
  }
  const activeConfirm = m.field === "confirm";
  rows.push({ text: `type box name to confirm: ${m.typed}${activeConfirm ? "_" : ""}`, tone: "plain" });
  rows.push({ text: `(expect "${m.expect}")   Enter=confirm  Esc=cancel`, tone: "dim" });
  return rows;
}

/** The literal `rows a–b of N` indicator, shared by the views and the table so
 *  the two never drift apart in wording. */
export function rowsIndicator(win: Viewport, total: number): string {
  const from = total === 0 ? 0 : win.start + 1;
  return `rows ${from}–${win.end} of ${total}`;
}
