// render.ts — pure frame functions (TUI-D5). Every frame is a pure function of
// (state, size) → string, so it is snapshot-tested TTY-free. Null/missing
// per-box fields render `-`. Colors go through a NO_COLOR-aware palette. Layout
// per §5: header, box table (glyphs + CONFIG column), detail pane (24h
// sparkline), footer keys; modals + LINK DOWN / STALE banners.

import type { SnapshotBox, SnapshotLine } from "../history/schema.ts";
import type { Scope } from "../serve/tokens.ts";

export interface Size {
  cols: number;
  rows: number;
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
  /** a transient status/action message (footer). */
  message?: string;
  /** an open modal, if any. */
  modal?: ModalState;
  /** whether NO_COLOR is set. */
  noColor: boolean;
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
  const applyStr = state.apply === null ? "apply=?" : state.apply ? "apply=ON" : "apply=off";
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
  if (state.detail && state.detail.box === b.name) {
    rows.push(`24h: ${sparkline(state.detail.lines, b.name)}`);
  } else {
    rows.push(sgr(state, C.dim, "24h: (loading…)"));
  }
  void size;
  return rows;
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

// --- footer keys (scope-aware, TUI-D7/R3-A1) ---------------------------------
export function renderFooter(state: TuiState, size: Size): string {
  const admin = state.scope === "admin";
  const keys: string[] = ["↑/↓ select", "/ filter", "r refresh", "q quit"];
  const actionKeys = ["P push", "M rotate", "R rename", "T check", "C reconcile"];
  const rendered = admin ? actionKeys.join("  ") : sgr(state, C.dim, actionKeys.join("  ") + "  (admin token required)");
  const line = `${keys.join("  ")}   ${rendered}`;
  return sgr(state, C.dim, pad(stripToWidth(line, size.cols), size.cols));
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
  lines.push(renderFooter(state, size));
  return lines.join("\n");
}

/** Pad to a visible width; when colored we can't measure easily, so only pad in
 *  NO_COLOR mode (the snapshot tests run NO_COLOR; live color mode just spaces). */
function padVisible(s: string, w: number, noColor: boolean): string {
  if (!noColor) return s; // live mode: skip precise padding (color escapes)
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
