// main.ts — the TUI loop (TUI-D5/D7/D10/D11). `cmdTui` wires the terminal core,
// the 5s /v1/fleet poll, the key loop, modals, and the filter. The key handling
// is a PURE reducer (handleKey) so it is exercised with a fake stdin, TTY-free.

import type { Env } from "../env.ts";
import { Terminal, NotATtyError, type TermIo, nodeTermIo } from "./term.ts";
import {
  renderFrame,
  filteredBoxes,
  viewContent,
  viewRowsAvailable,
  viewportWindow,
  type TuiState,
  type ModalState,
  type Size,
  type ViewKind,
} from "./render.ts";
import { makeApiClient, type ApiClient, type FleetView } from "./api-client.ts";
import { resolveTuiConfig, TuiConfigError, type ConfigFs, nodeConfigFs } from "./config.ts";
import { actionForKey, RECONCILE_ACTION, confirmValue, needsTarget, type ActionSpec } from "./actions.ts";
import type { SnapshotLine } from "../history/schema.ts";
import { log } from "../log.ts";

const STALE_SECONDS = 15 * 60;
export const POLL_INTERVAL_MS = 5000; // TUI-D7

/** An effect the loop must perform after a key is handled (kept out of the
 *  pure reducer so handleKey stays testable). */
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
 * from none to the first selection. It is driven from the loop rather than from
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
 * never the LINK DOWN path swallowing the answer. A readonly token hitting the
 * admin-scoped journal route gets the API's 403 turned into plain words (D3).
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
 * kind and the same CAPTURED box. A response that lands after the operator
 * closed the view, or opened a different one, is dropped rather than painted
 * under the wrong title (D6).
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

/** Recompute tickAgeS + link/stale from the current view + clock. */
export function deriveFreshness(state: TuiState): TuiState {
  let tickAgeS: number | null = null;
  if (state.snapshotTs !== null) {
    const t = Date.parse(state.snapshotTs);
    if (!Number.isNaN(t)) tickAgeS = Math.max(0, Math.floor((state.nowMs - t) / 1000));
  }
  return { ...state, tickAgeS };
}

/** Clamp/repair the selection after the filtered list changes (A15): a
 *  disappeared selection falls back to the first row; the filter is cleared
 *  ONLY when it matches nothing. */
export function recoverSelection(state: TuiState): TuiState {
  let filtering = state.filtering;
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
  // preserve the selected box across a re-read by name (A15).
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
  // restore selection to the same box if it still exists in the filtered list.
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
 *  and an Effect for the loop to perform. PURE (no I/O). */
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
      // the detail effect is driven by the NAME CHANGE from the loop (B4), not
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
 * close, `r` refetches. `r` is VIEW-SCOPED and targets the CAPTURED box, not the
 * current selection — the poll may have moved the selection underneath, and the
 * view's subject is the capture (D4). History's `r` goes to the history client
 * method for that same captured box.
 */
function handleViewKey(state: TuiState, key: string, size: Size): { state: TuiState; effect: Effect } {
  const v = state.view!;
  if (key === "\x1b" || key === "q") {
    // close. The loop then re-evaluates the detail effect: if the selection
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

export interface TuiDeps {
  env: Env;
  io?: TermIo;
  configFs?: ConfigFs;
  /** injected client factory (tests); defaults to the real fetch client. */
  makeClient?: (url: string, token: string) => ApiClient;
  now?: () => number;
}

/**
 * cmdTui — the entry (already dispatched from cli.ts; laptop-runnable, no
 * locality guard). Resolves config (rc 2 on a bad/absent config), refuses a
 * non-TTY (rc 1), then runs the loop. Returns the process rc; the loop runs
 * until the user quits.
 */
export async function cmdTui(rest: string[], deps: TuiDeps): Promise<number> {
  void rest;
  const io = deps.io ?? nodeTermIo;
  const now = deps.now ?? (() => Date.now());
  const noColor = process.env.NO_COLOR !== undefined;

  let cfg;
  try {
    cfg = resolveTuiConfig(deps.configFs ?? nodeConfigFs);
  } catch (e) {
    if (e instanceof TuiConfigError) {
      log(e.message);
      return 2;
    }
    throw e;
  }

  const client = (deps.makeClient ?? ((u, t) => makeApiClient(u, t)))(cfg.url, cfg.token);
  const term = new Terminal(io);
  try {
    term.start();
  } catch (e) {
    if (e instanceof NotATtyError) {
      log(e.message);
      return 1;
    }
    throw e;
  }

  let state = initialState(now(), noColor);
  let running = true;

  const size = (): Size => term.size();
  const repaint = () => {
    state = deriveFreshness({ ...state, nowMs: now() });
    term.paint(renderFrame(state, size()));
  };

  // B4: the box the detail pane's data belongs to. The effect fires on every
  // CHANGE of the selected name — including the first poll's selection, which
  // no key arm ever announced (gate r2).
  let loadedDetailBox: string | null = null;

  const poll = async () => {
    const r = await client.fleet();
    if (r.ok) state = applyFleet(state, r.value, now());
    else if (r.kind === "unauthorized" || r.kind === "forbidden") state = { ...applyLinkDown(state, now()), message: r.message };
    else state = applyLinkDown(state, now());
    repaint();
  };

  /** Fire the detail effect iff the selected name changed and no view is open. */
  const syncDetail = async () => {
    const eff = detailEffectFor(state, loadedDetailBox);
    if (eff.type !== "load-detail") return;
    loadedDetailBox = eff.box;
    await runEffect(eff);
  };

  const runEffect = async (effect: Effect) => {
    switch (effect.type) {
      case "quit":
        running = false;
        break;
      case "refresh":
        await poll();
        break;
      case "load-detail": {
        // ONE combined effect (B4): the D1 box facts AND the 24h history the
        // sparkline feeds on. Both are stored WITH the box name they were
        // fetched for, so the pane can refuse to show them under another box.
        const [d, h] = await Promise.all([client.box(effect.box), client.history(effect.box, 24)]);
        if (d.ok) state = { ...state, detailFacts: { box: effect.box, facts: d.value } };
        if (h.ok) state = { ...state, detail: { box: effect.box, lines: h.value } };
        if ((!d.ok && d.kind === "link_down") || (!h.ok && h.kind === "link_down")) {
          state = applyLinkDown(state, now());
        }
        repaint();
        break;
      }
      case "load-view": {
        const r =
          effect.kind === "diff"
            ? await client.diff(effect.box)
            : effect.kind === "journal"
              ? await client.journal(effect.box, JOURNAL_LINES)
              : undefined;
        if (effect.kind === "history") {
          // D4: view-scoped `r` — one request for the CAPTURED box; the shared
          // `state.detail` is deliberately left alone.
          const h = await client.history(effect.box, 24);
          state = applyViewResult(state, effect.kind, effect.box, h.ok ? { lines: undefined, history: h.value } : { error: viewError(h) });
        } else if (r !== undefined) {
          state = applyViewResult(state, effect.kind, effect.box, r.ok ? { lines: r.value.log } : { error: viewError(r, effect.kind) });
        }
        repaint();
        break;
      }
      case "run-action": {
        state = { ...state, message: `${effect.spec.label} ${effect.box}…` };
        repaint();
        const res = await runAction(client, effect);
        state = { ...state, message: res };
        await poll(); // immediate refresh after an action (TUI-D7)
        break;
      }
      case "none":
        break;
    }
  };

  const unsubKey = term.onKey((data) => {
    void (async () => {
      // a chunk may carry an escape sequence (arrows) or a single char.
      const keys = splitKeys(data);
      for (const k of keys) {
        const { state: next, effect } = handleKey(state, k, size());
        state = next;
        await runEffect(effect);
        // a move, or a view close onto a different box, changes the selected
        // name; that CHANGE is what loads the detail (B4/D6).
        await syncDetail();
      }
      repaint();
    })();
  });
  const unsubResize = term.onResize(() => repaint());

  await poll();
  await syncDetail(); // the startup-selected box loads without a keypress (r2).
  const timer = setInterval(() => {
    void (async () => {
      await poll();
      await syncDetail();
    })();
  }, POLL_INTERVAL_MS);

  // wait until the user quits.
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!running) {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });

  clearInterval(timer);
  unsubKey();
  unsubResize();
  term.restore();
  return 0;
}

/** Run one action via the client; return a human status line. */
async function runAction(client: ApiClient, e: { spec: ActionSpec; box: string; to?: string }): Promise<string> {
  const { spec, box, to } = e;
  let r;
  switch (spec.kind) {
    case "check": r = await client.check(box); break;
    case "config-push": r = await client.configPush(box); break;
    case "rotate-key": r = await client.rotateKey(box); break;
    case "rename": r = await client.rename(box, to ?? ""); break;
    case "reconcile": {
      const jr = await client.reconcile();
      return jr.ok ? `reconcile job started: ${jr.value.job_id}` : `reconcile failed: ${jr.message}`;
    }
  }
  if (!r.ok) return `${spec.label} ${box} failed: ${r.message}`;
  return `${spec.label} ${box} → rc=${r.value.rc}`;
}

/** Split an input chunk into individual keys, keeping known escape sequences
 *  (arrows) intact. */
export function splitKeys(data: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] === "\x1b") {
      // arrow sequences: ESC [ A/B/C/D
      if (data[i + 1] === "[" && data[i + 2] !== undefined) {
        keys.push(data.slice(i, i + 3));
        i += 3;
        continue;
      }
      keys.push("\x1b"); // lone Esc
      i += 1;
      continue;
    }
    keys.push(data[i]!);
    i += 1;
  }
  return keys;
}
