// layout.ts — the ROW BUDGET (fleet-tui-ink D1/D2).
//
// The arithmetic here is the single authority on how many lines each region of
// the table frame may occupy, and every chrome component emits exactly the
// lines this file counts (pinned by the chrome-agreement test). It depends only
// on the pure text producers in `model.ts`, so it can be reasoned about and
// tested without mounting anything.

import type { TuiState } from "./state.ts";
import {
  DETAIL_GAP,
  DETAIL_ROWS,
  bannerText,
  clipSegments,
  detailLines,
  detailWidth,
  discoverText,
  filteredBoxes,
  fitSegments,
  footerLines,
  messageText,
  modalLines,
  rowsIndicator,
  segText,
  tableLines,
  tableWidth,
  viewportWindow,
  type Size,
  type TableLine,
  type Viewport,
} from "./model.ts";

// The column geometry moved to `model.ts` when `detailLines` started framing its
// card to the pane width; re-exported here because layout.ts has always been
// where the components import it from.
export { DETAIL_GAP, tableWidth, detailWidth } from "./model.ts";

/** The table's own column-header row (`NAME TUNNEL CHECK …`). It is a fixed
 *  cost of the table region, not a box row, so the window arithmetic below
 *  subtracts it before deciding how many box rows fit. */
export const TABLE_HEADER_ROWS = 1;

/**
 * The chrome the TABLE frame spends, in the order the frame emits it: header,
 * banner when one is showing, the discover row when one is showing, the blank
 * spacer, then (modal ⇒ blank + modal lines; else message ⇒ blank + message
 * line), the blank before the footer, and the footer's own lines.
 */
export function tableChromeRows(state: TuiState, size: Size): number {
  let n = 1; // header
  if (bannerText(state, size) !== undefined) n += 1;
  if (discoverText(state, size) !== undefined) n += 1;
  n += 1; // blank spacer after the header/banner/discover
  if (state.modal) n += 1 + modalLines(state).length;
  else if (messageText(state) !== undefined) n += 2; // blank spacer + the message
  n += 1; // blank spacer before the footer
  n += footerLines(state, size).length;
  return n;
}

/** Rows available to the whole table region (its column header included). */
export function tableRows(state: TuiState, size: Size): number {
  return Math.max(1, size.rows - tableChromeRows(state, size));
}

/** Rows available to BOX rows, before the `rows a–b of N` indicator is charged. */
export function boxRowsAvailable(state: TuiState, size: Size): number {
  return Math.max(1, tableRows(state, size) - TABLE_HEADER_ROWS);
}

/** Whether the filtered fleet is taller than the rows it may paint. */
export function hasMore(state: TuiState, size: Size): boolean {
  return filteredBoxes(state).length > boxRowsAvailable(state, size);
}

/** Box rows actually painted: the indicator occupies the LAST available line,
 *  so a fleet that overflows gets one fewer box row. */
export function tableContentRows(state: TuiState, size: Size): number {
  return Math.max(1, boxRowsAvailable(state, size) - (hasMore(state, size) ? 1 : 0));
}

/**
 * The window of box rows to paint, bottom-anchored on the selection: once the
 * selection scrolls past the window it sits on the LAST visible row. Derived
 * from `state.selected` on every render, so the reducer keeps no offset field.
 */
export function tableWindow(state: TuiState, size: Size): Viewport {
  const rows = tableContentRows(state, size);
  const selected = state.selected;
  const offset = selected < rows ? 0 : selected - rows + 1;
  return viewportWindow(filteredBoxes(state).length, offset, rows);
}

/**
 * The table region's lines: the column header, the windowed box rows, and — iff
 * the fleet overflows — the `rows a–b of N` indicator as the last line. Never
 * more than `tableRows` lines.
 */
export function tableViewLines(state: TuiState, size: Size): TableLine[] {
  // The model pads the column-header row to the FULL terminal width (that is
  // what the hand-rolled painter did). When the Detail pane shares the row with
  // it the table column is narrower, so clip to the pane — otherwise Ink
  // truncates the padding and leaves a stray ellipsis in the header.
  const width = showDetail(state, size) ? tableWidth(size) : size.cols;
  const clip = (l: TableLine): TableLine =>
    l.text.length > width
      ? { ...l, text: l.text.slice(0, width), segments: l.segments === undefined ? undefined : clipSegments(l.segments, width) }
      : l;
  const all = tableLines(state, size).map(clip);
  const head = all[0]!;
  const body = all.slice(1);
  if (filteredBoxes(state).length === 0) return [head, ...body]; // the "(no boxes)" line
  const win = tableWindow(state, size);
  // V1: the selected row is a BAR, so its segments run the full width of the
  // table column rather than stopping at the last cell's text.
  const bar = (l: TableLine): TableLine => {
    if (l.selected !== true || l.segments === undefined) return l;
    const segments = fitSegments(l.segments, width);
    return { ...l, segments, text: segText(segments) };
  };
  const out: TableLine[] = [head, ...body.slice(win.start, win.end).map(bar)];
  if (hasMore(state, size)) {
    out.push({ text: rowsIndicator(win, filteredBoxes(state).length), tone: "muted" });
  }
  return out;
}

/** Whether the Detail pane is painted at this size. It is OMITTED rather than
 *  clipped: below 100 columns (the long-standing cutoff) and whenever the row
 *  budget cannot hold its fixed height. */
export function showDetail(state: TuiState, size: Size): boolean {
  return size.cols >= 100 && tableRows(state, size) >= DETAIL_ROWS && detailLines(state, detailWidth(size)).length > 0;
}

/** The height of the side-by-side row region: the taller of the two columns,
 *  capped by the budget. It is never PADDED, so a short fleet puts the footer
 *  directly after the content. */
export function rowRegionRows(state: TuiState, size: Size): number {
  const content = Math.max(tableViewLines(state, size).length, showDetail(state, size) ? DETAIL_ROWS : 0);
  return Math.min(tableRows(state, size), content);
}
