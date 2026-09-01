// state.ts — the TUI's STATE and its pure transitions (fleet-tui-ink D1).
//
// Everything here is I/O-free and terminal-free: the key reducer (`handleKey`),
// the poll/selection/view transitions, and the shapes they operate on. The Ink
// app (`app.tsx`) drives these through `useReducer`; the tests drive them
// directly. `TuiState` is unchanged from the hand-rolled TUI.

import type { SnapshotBox, SnapshotDiscover, SnapshotLine } from "../history/schema.ts";
import type { BoxDetail, FleetView } from "./api-client.ts";
import type { Scope } from "../serve/tokens.ts";
import type { ActionSpec } from "./actions.ts";
import { actionForKey, RECONCILE_ACTION, confirmValue, needsTarget } from "./actions.ts";
import { filteredBoxes, viewContent, viewRowsAvailable, viewportWindow, type Size } from "./model.ts";

export const POLL_INTERVAL_MS = 5000; // TUI-D7

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
  /** the D1 detail facts, stored WITH the box name they were fetched for. */
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

/** An effect the app must perform after a key is handled (kept out of the pure
 *  reducer so handleKey stays testable). */
export type Effect =
  | { type: "none" }
  | { type: "quit" }
  | { type: "refresh" }
  | { type: "load-detail"; box: string }
  /** fetch (or refetch) an open view's content for its CAPTURED box (D2/D3/D4). */
  | { type: "load-view"; kind: ViewKind; box: string }
  | { type: "run-action"; spec: ActionSpec; box: string; to?: string };

/** The default size used when a caller does not supply one (tests, headless). */
const DEFAULT_SIZE: Size = { cols: 120, rows: 40 };

/** The selected box's NAME, or undefined when nothing is selected. */
export function selectedBoxName(state: TuiState): string | undefined {
  return filteredBoxes(state)[state.selected]?.name;
}

/**
 * B4: the detail effect fires whenever the SELECTED BOX NAME CHANGES, including
 * from none to the first selection. It is driven from the app rather than from
 * the key arms, because the name also changes on the first poll that yields a
 * list (the startup-selected box never loaded — gate r2) and on any
 * selection-recovery path that lands on a different box.
 *
 * D6: while a view is open it is SUPPRESSED ENTIRELY. `loadedBox` is left
 * untouched by the suppression, so closing a view onto a different selection
 * fires the effect exactly once.
 */
export function detailEffectFor(state: TuiState, loadedBox: string | null): Effect {
  if (state.view !== undefined) return { type: "none" };
  const name = selectedBoxName(state);
  if (name === undefined || name === loadedBox) return { type: "none" };
  return { type: "load-detail", box: name };
}

/** D3: the journal window the view asks for. */
export const JOURNAL_LINES = 80;

/**
 * The line a failed view fetch renders IN THE VIEW FRAME — never a crash, and
 * never the LINK DOWN path swallowing the answer.
 */
export function viewError(r: { ok: false; kind: string; message: string }, kind?: ViewKind): string {
  if (r.kind === "forbidden" && kind === "journal") return "journal: admin token required";
  if (r.kind === "forbidden") return `${kind ?? "view"}: forbidden`;
  if (r.kind === "unauthorized") return "unauthorized (check the token)";
  if (r.kind === "link_down") return "link error";
  return r.message;
}

/**
 * Store a view fetch's outcome — but ONLY when the open view is still the same
 * kind and the same CAPTURED box (D6).
 */
export function applyViewResult(
  state: TuiState,
  kind: ViewKind,
  box: string,
  payload: { lines?: string[]; history?: SnapshotLine[]; error?: string },
): TuiState {
  const v = state.view;
  if (v === undefined || v.kind !== kind || v.box !== box) return state;
  return {
    ...state,
    view: {
      ...v,
      loading: false,
      error: payload.error,
      lines: payload.error === undefined && payload.lines !== undefined ? payload.lines : v.lines,
      history: payload.error === undefined && payload.history !== undefined ? payload.history : v.history,
      // a refetch starts the reader at the top of the new content.
      offset: 0,
    },
  };
}

/**
 * D6: whether the 5s `GET /v1/fleet` poll runs on this tick. It ALWAYS does —
 * an open view does not pause it, so the header's tick age keeps moving.
 *
 * This exists as a named predicate rather than as a bare interval body so the
 * rule is pinned by a test.
 */
export function shouldPoll(state: TuiState): boolean {
  void state;
  return true;
}

/** Recompute tickAgeS + link/stale from the current view + clock. */
export function deriveFreshness(state: TuiState): TuiState {
  let tickAgeS: number | null = null;
  if (state.snapshotTs !== null) {
    const t = Date.parse(state.snapshotTs);
    if (!Number.isNaN(t)) tickAgeS = Math.max(0, Math.floor((state.nowMs - t) / 1000));
  }
  return { ...state, tickAgeS };
}

/** Clamp/repair the selection after the filtered list changes (A15). */
export function recoverSelection(state: TuiState): TuiState {
  const filtering = state.filtering;
  let filter = state.filter;
  let list = filteredBoxes(state);
  if (filter !== "" && list.length === 0 && !filtering) {
    // filter matches nothing (and we are not mid-typing) ⇒ clear it (A15).
    filter = "";
    list = state.boxes;
  }
  let selected = state.selected;
  if (selected >= list.length) selected = 0;
  if (selected < 0) selected = 0;
  return { ...state, filter, filtering, selected };
}

/** Apply a fresh fleet view to the state (preserve selection by box name). */
export function applyFleet(state: TuiState, view: FleetView, nowMs: number): TuiState {
  const prevList = filteredBoxes(state);
  const prevName = prevList[state.selected]?.name;
  let next: TuiState = {
    ...state,
    boxes: view.boxes,
    snapshotTs: view.snapshot_ts,
    apply: view.apply,
    applySource: view.apply_source,
    canary: view.canary,
    scope: view.scope,
    discover: view.discover,
    link: { up: true },
    nowMs,
  };
  next = deriveFreshness(next);
  const list = filteredBoxes(next);
  if (prevName !== undefined) {
    const idx = list.findIndex((b) => b.name === prevName);
    if (idx >= 0) next = { ...next, selected: idx };
  }
  return recoverSelection(next);
}

/** Mark the link down (keep last-good data). */
export function applyLinkDown(state: TuiState, nowMs: number): TuiState {
  if (state.link.up) return deriveFreshness({ ...state, link: { up: false, sinceMs: nowMs }, nowMs });
  return deriveFreshness({ ...state, nowMs });
}

/** A single key/byte handled against the current state. Returns the next state
 *  and an Effect for the app to perform. PURE (no I/O). */
export function handleKey(state: TuiState, key: string, size: Size = DEFAULT_SIZE): { state: TuiState; effect: Effect } {
  // --- modal mode ---
  if (state.modal) {
    return handleModalKey(state, key);
  }
  // --- view mode (D2/D3/D4) ---
  // Checked BEFORE the normal-mode switch, exactly as the modal branch is, so
  // `q` closes an open view instead of quitting the TUI (gate note 4).
  if (state.view) {
    return handleViewKey(state, key, size);
  }
  // --- filter mode ---
  if (state.filtering) {
    if (key === "\r" || key === "\n" || key === "\x1b") {
      // Enter/Esc: leave filter-typing; Esc also clears the filter.
      const filter = key === "\x1b" ? "" : state.filter;
      return { state: recoverSelection({ ...state, filtering: false, filter }), effect: { type: "none" } };
    }
    if (key === "\x7f" || key === "\b") {
      return { state: recoverSelection({ ...state, filter: state.filter.slice(0, -1) }), effect: { type: "none" } };
    }
    if (key.length === 1 && key >= " ") {
      return { state: recoverSelection({ ...state, filter: state.filter + key }), effect: { type: "none" } };
    }
    return { state, effect: { type: "none" } };
  }

  // --- normal mode ---
  const list = filteredBoxes(state);
  switch (key) {
    case "q":
    case "\x03": // Ctrl-C
      return { state, effect: { type: "quit" } };
    case "r":
      return { state: { ...state, message: "refreshing…" }, effect: { type: "refresh" } };
    case "/":
      return { state: { ...state, filtering: true, filter: "" }, effect: { type: "none" } };
    case "j":
    case "\x1b[B": {
      // the detail effect is driven by the NAME CHANGE from the app (B4), not
      // emitted here: a clamped move at the end of the list changes nothing.
      const selected = Math.min(state.selected + 1, Math.max(0, list.length - 1));
      return { state: { ...state, selected }, effect: { type: "none" } };
    }
    case "k":
    case "\x1b[A": {
      const selected = Math.max(state.selected - 1, 0);
      return { state: { ...state, selected }, effect: { type: "none" } };
    }
    case "D":
    case "J":
    case "H": {
      // D2/D3/D4. Inert when nothing is selected.
      const box = list[state.selected]?.name;
      if (box === undefined) return { state, effect: { type: "none" } };
      const kind: ViewKind = key === "D" ? "diff" : key === "J" ? "journal" : "history";
      if (kind === "history") {
        // D4: renders from the ALREADY-LOADED per-selection history — no second
        // request and no second endpoint. The captured copy is taken here.
        const lines = state.detail !== undefined && state.detail.box === box ? state.detail.lines : [];
        return {
          state: { ...state, message: undefined, view: { kind, box, offset: 0, loading: false, history: [...lines] } },
          effect: { type: "none" },
        };
      }
      return {
        state: { ...state, message: undefined, view: { kind, box, offset: 0, loading: true } },
        effect: { type: "load-view", kind, box },
      };
    }
  }

  // --- action keys (scope-aware, TUI-D7/R3-A1) ---
  const upper = key.toUpperCase();
  if (upper === RECONCILE_ACTION.key) {
    return openActionModal(state, RECONCILE_ACTION, "fleet");
  }
  const spec = actionForKey(key);
  if (spec) {
    if (state.scope !== "admin") {
      return { state: { ...state, message: "admin token required for that action" }, effect: { type: "none" } };
    }
    const box = list[state.selected]?.name;
    if (box === undefined) return { state, effect: { type: "none" } };
    if (!spec.danger) {
      // non-destructive (check): run immediately, no modal.
      return { state: { ...state, message: `${spec.label} ${box}…` }, effect: { type: "run-action", spec, box } };
    }
    return openActionModal(state, spec, box);
  }

  return { state, effect: { type: "none" } };
}

/**
 * Keys inside an open view (D2/D3/D4): `j/k` and the arrows scroll, `Esc`/`q`
 * close, `r` refetches the CAPTURED box.
 */
function handleViewKey(state: TuiState, key: string, size: Size): { state: TuiState; effect: Effect } {
  const v = state.view!;
  if (key === "\x1b" || key === "q") {
    // close. The app then re-evaluates the detail effect: if the selection
    // moved while the view was open, it fires exactly once (D6).
    return { state: { ...state, view: undefined }, effect: { type: "none" } };
  }
  if (key === "\x03") return { state, effect: { type: "quit" } }; // Ctrl-C still quits
  if (key === "r") {
    return {
      state: { ...state, view: { ...v, loading: true, error: undefined } },
      effect: { type: "load-view", kind: v.kind, box: v.box },
    };
  }
  const down = key === "j" || key === "\x1b[B";
  const up = key === "k" || key === "\x1b[A";
  if (down || up) {
    const total = viewContent(state).length;
    const rows = viewRowsAvailable(state, size);
    const next = viewportWindow(total, v.offset + (down ? 1 : -1), rows).offset;
    return { state: { ...state, view: { ...v, offset: next } }, effect: { type: "none" } };
  }
  return { state, effect: { type: "none" } };
}

function openActionModal(state: TuiState, spec: ActionSpec, box: string): { state: TuiState; effect: Effect } {
  if (state.scope !== "admin") {
    return { state: { ...state, message: "admin token required for that action" }, effect: { type: "none" } };
  }
  const modal: ModalState = {
    actionLabel: spec.label,
    box,
    typed: "",
    target: needsTarget(spec) ? "" : undefined,
    field: needsTarget(spec) ? "target" : "confirm",
    note: spec.note,
    expect: confirmValue(spec, box),
  };
  return { state: { ...state, modal, message: undefined }, effect: { type: "none" } };
}

function handleModalKey(state: TuiState, key: string): { state: TuiState; effect: Effect } {
  const m = state.modal!;
  if (key === "\x1b") {
    // Esc cancels.
    return { state: { ...state, modal: undefined, message: "cancelled" }, effect: { type: "none" } };
  }
  if (key === "\r" || key === "\n") {
    // Two-field (rename): Tab/Enter on target moves to confirm.
    if (m.field === "target") {
      if ((m.target ?? "") === "") return { state, effect: { type: "none" } };
      return { state: { ...state, modal: { ...m, field: "confirm" } }, effect: { type: "none" } };
    }
    // confirm field: the typed value must equal the expected confirm.
    if (m.typed !== m.expect) {
      return { state: { ...state, message: `confirm mismatch (expected "${m.expect}")` }, effect: { type: "none" } };
    }
    const spec = m.actionLabel === RECONCILE_ACTION.label ? RECONCILE_ACTION : actionForKey(specKeyFromLabel(m.actionLabel))!;
    const to = m.target;
    return {
      state: { ...state, modal: undefined, message: `${m.actionLabel} ${m.box}…` },
      effect: { type: "run-action", spec, box: m.box, to },
    };
  }
  if (key === "\t") {
    // toggle field for the two-field modal.
    if (m.target !== undefined) {
      return { state: { ...state, modal: { ...m, field: m.field === "target" ? "confirm" : "target" } }, effect: { type: "none" } };
    }
    return { state, effect: { type: "none" } };
  }
  const backspace = key === "\x7f" || key === "\b";
  const active = m.field;
  if (backspace) {
    const upd = active === "target" ? { target: (m.target ?? "").slice(0, -1) } : { typed: m.typed.slice(0, -1) };
    return { state: { ...state, modal: { ...m, ...upd } }, effect: { type: "none" } };
  }
  if (key.length === 1 && key >= " ") {
    const upd = active === "target" ? { target: (m.target ?? "") + key } : { typed: m.typed + key };
    return { state: { ...state, modal: { ...m, ...upd } }, effect: { type: "none" } };
  }
  return { state, effect: { type: "none" } };
}

/** Reverse-map a modal's action label to its trigger key. */
function specKeyFromLabel(label: string): string {
  switch (label) {
    case "config-push": return "P";
    case "rotate-key": return "M";
    case "rename": return "R";
    case "check": return "T";
    default: return "";
  }
}

/** The initial state before the first poll. */
export function initialState(nowMs: number, noColor: boolean): TuiState {
  return {
    boxes: [],
    snapshotTs: null,
    apply: null,
    applySource: "snapshot",
    canary: null,
    scope: "readonly",
    discover: null,
    tickAgeS: null,
    link: { up: false, sinceMs: nowMs },
    nowMs,
    selected: 0,
    filter: "",
    filtering: false,
    message: "connecting…",
    noColor,
  };
}
