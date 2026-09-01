// app.tsx — the Ink application (fleet-tui-ink D2/D3).
//
// The whole TUI is one component: `TuiState` lives in a `useReducer`, the key
// reducer and the poll/selection transitions are the same pure functions the
// hand-rolled loop called, and every side effect (fetches, quit) is an `Effect`
// the reducer RETURNS and a single drain effect performs. Layout, resize, raw
// mode, the alt screen and terminal restore are Ink's job now.

import React, { useCallback, useEffect, useReducer, useRef } from "react";
import { Box, useApp, useInput, useWindowSize } from "ink";
import Header from "./components/Header.tsx";
import Banner from "./components/Banner.tsx";
import Discover from "./components/Discover.tsx";
import Table from "./components/Table.tsx";
import Detail from "./components/Detail.tsx";
import Modal from "./components/Modal.tsx";
import Message from "./components/Message.tsx";
import Footer from "./components/Footer.tsx";
import View from "./components/View.tsx";
import { toReducerKeys } from "./keys.ts";
import {
  bannerText,
  detailLines,
  discoverText,
  footerLines,
  messageText,
  modalLines,
  viewLines,
  type Size,
} from "./model.ts";
import { DETAIL_GAP, rowRegionRows, showDetail, tableViewLines, tableWidth } from "./layout.ts";
import {
  applyFleet,
  applyLinkDown,
  applyViewResult,
  detailEffectFor,
  handleKey,
  selectedBoxName,
  shouldPoll,
  viewError,
  JOURNAL_LINES,
  POLL_INTERVAL_MS,
  type Effect,
  type TuiState,
  type ViewKind,
} from "./state.ts";
import type { ApiClient, BoxDetail, FleetView } from "./api-client.ts";
import type { SnapshotLine } from "../history/schema.ts";
import type { ActionSpec } from "./actions.ts";

/** What `App` needs from the outside world. Everything is injectable so the
 *  frame and key tests run TTY-free and network-free. */
export interface AppDeps {
  client: ApiClient;
  now: () => number;
  /** the 5s fleet poll's period; tests inject a short one. */
  pollIntervalMs: number;
  /** called when the reducer asks to quit (defaults to Ink's `exit`). */
  onQuit?: () => void;
}

// --- the wrapper state -------------------------------------------------------
/** `TuiState` plus the effects the last action asked for. `seq` increments on
 *  EVERY action so an identical consecutive effect still runs. */
interface Wrapper {
  tui: TuiState;
  pending: Effect[];
  seq: number;
}

export type Action =
  | { type: "key"; key: string; size: Size }
  | { type: "fleet"; view: FleetView; now: number }
  | { type: "link-down"; now: number; message?: string }
  | { type: "detail"; box: string; facts?: BoxDetail; history?: SnapshotLine[] }
  | { type: "view-result"; kind: ViewKind; box: string; payload: { lines?: string[]; history?: SnapshotLine[]; error?: string } }
  | { type: "action-done"; message: string }
  | { type: "drain"; n: number };

export function reduce(w: Wrapper, action: Action): Wrapper {
  switch (action.type) {
    case "key": {
      const { state, effect } = handleKey(w.tui, action.key, action.size);
      return { tui: state, pending: [...w.pending, effect], seq: w.seq + 1 };
    }
    case "fleet":
      return { ...w, tui: applyFleet(w.tui, action.view, action.now), seq: w.seq + 1 };
    case "link-down": {
      const next = applyLinkDown(w.tui, action.now);
      return { ...w, tui: action.message === undefined ? next : { ...next, message: action.message }, seq: w.seq + 1 };
    }
    case "detail": {
      let tui = w.tui;
      if (action.facts !== undefined) tui = { ...tui, detailFacts: { box: action.box, facts: action.facts } };
      if (action.history !== undefined) tui = { ...tui, detail: { box: action.box, lines: action.history } };
      return { ...w, tui, seq: w.seq + 1 };
    }
    case "view-result":
      return { ...w, tui: applyViewResult(w.tui, action.kind, action.box, action.payload), seq: w.seq + 1 };
    case "action-done":
      return { ...w, tui: { ...w.tui, message: action.message }, seq: w.seq + 1 };
    case "drain":
      return { ...w, pending: w.pending.slice(action.n), seq: w.seq + 1 };
  }
}

// --- the app -----------------------------------------------------------------
export default function App({ initial, deps }: { initial: TuiState; deps: AppDeps }): React.ReactElement {
  const [w, dispatch] = useReducer(reduce, { tui: initial, pending: [], seq: 0 });
  const state = w.tui;
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const size: Size = { cols: columns, rows };

  // The timer and the effect runners read the CURRENT state through this ref
  // rather than closing over a stale one.
  const stateRef = useRef(state);
  stateRef.current = state;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const poll = useCallback(async () => {
    const d = depsRef.current;
    const r = await d.client.fleet();
    if (r.ok) dispatch({ type: "fleet", view: r.value, now: d.now() });
    else if (r.kind === "unauthorized" || r.kind === "forbidden") dispatch({ type: "link-down", now: d.now(), message: r.message });
    else dispatch({ type: "link-down", now: d.now() });
  }, []);

  const runEffect = useCallback(
    async (effect: Effect): Promise<void> => {
      const d = depsRef.current;
      switch (effect.type) {
        case "quit":
          (d.onQuit ?? exit)();
          break;
        case "refresh":
          await poll();
          break;
        case "load-detail": {
          // ONE combined effect (B4): the D1 box facts AND the 24h history the
          // sparkline feeds on. Both are stored WITH the box name they were
          // fetched for, so the pane can refuse to show them under another box.
          const [det, hist] = await Promise.all([d.client.box(effect.box), d.client.history(effect.box, 24)]);
          dispatch({
            type: "detail",
            box: effect.box,
            facts: det.ok ? det.value : undefined,
            history: hist.ok ? hist.value : undefined,
          });
          if ((!det.ok && det.kind === "link_down") || (!hist.ok && hist.kind === "link_down")) {
            dispatch({ type: "link-down", now: d.now() });
          }
          break;
        }
        case "load-view": {
          if (effect.kind === "history") {
            // D4: view-scoped `r` — one request for the CAPTURED box; the
            // shared `state.detail` is deliberately left alone.
            const h = await d.client.history(effect.box, 24);
            dispatch({
              type: "view-result",
              kind: effect.kind,
              box: effect.box,
              payload: h.ok ? { history: h.value } : { error: viewError(h) },
            });
            break;
          }
          const r = effect.kind === "diff" ? await d.client.diff(effect.box) : await d.client.journal(effect.box, JOURNAL_LINES);
          dispatch({
            type: "view-result",
            kind: effect.kind,
            box: effect.box,
            payload: r.ok ? { lines: r.value.log } : { error: viewError(r, effect.kind) },
          });
          break;
        }
        case "run-action": {
          const res = await runAction(d.client, effect);
          dispatch({ type: "action-done", message: res });
          await poll(); // immediate refresh after an action (TUI-D7)
          break;
        }
        case "none":
          break;
      }
    },
    [exit, poll],
  );
  const runEffectRef = useRef(runEffect);
  runEffectRef.current = runEffect;

  // --- effect drain ----------------------------------------------------------
  const pending = w.pending;
  useEffect(() => {
    if (pending.length === 0) return;
    const batch = pending.slice();
    dispatch({ type: "drain", n: batch.length });
    for (const e of batch) void runEffectRef.current(e);
    // keyed on `seq`, so an identical consecutive effect still runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.seq]);

  // --- the 5s fleet poll -----------------------------------------------------
  // EMPTY deps on purpose: the interval is installed ONCE. Re-installing it on
  // every state change (which is what putting `state` in the deps does) resets
  // the timer on every keystroke and the poll never fires under typing.
  useEffect(() => {
    void poll(); // the first read, without waiting a whole period
    const id = setInterval(() => {
      if (!shouldPoll(stateRef.current)) return;
      void poll();
    }, depsRef.current.pollIntervalMs);
    return () => clearInterval(id);
  }, [poll]);

  // --- the detail load (B4 / D6) ---------------------------------------------
  const loadedDetailBoxRef = useRef<string | null>(null);
  const selectedName = selectedBoxName(state);
  const viewOpen = state.view !== undefined;
  useEffect(() => {
    // While a view is open the load is SUPPRESSED and the ref is left untouched,
    // so closing the view onto a different selection fires it exactly once.
    if (viewOpen) return;
    const eff = detailEffectFor(stateRef.current, loadedDetailBoxRef.current);
    if (eff.type === "load-detail") {
      loadedDetailBoxRef.current = eff.box;
      void runEffectRef.current(eff);
    }
  }, [selectedName, viewOpen]);

  // --- keys ------------------------------------------------------------------
  useInput((input, key) => {
    for (const k of toReducerKeys(input, key)) dispatch({ type: "key", key: k, size: sizeRef.current });
  });

  // --- the frame -------------------------------------------------------------
  const noColor = state.noColor;
  const banner = bannerText(state, size);
  const discover = discoverText(state, size);
  const message = messageText(state);
  const footer = footerLines(state, size);
  const detailOn = showDetail(state, size);
  const leftW = tableWidth(size);

  return (
    <Box flexDirection="column" flexShrink={0} width={size.cols} height={size.rows}>
      <Header state={state} size={size} />
      {banner !== undefined ? <Banner text={banner.text} tone={banner.tone} noColor={noColor} /> : null}
      {discover !== undefined && !viewOpen ? <Discover text={discover} noColor={noColor} /> : null}
      <Box flexShrink={0} height={1} />
      {viewOpen ? (
        <>
          <View lines={viewLines(state, size)} noColor={noColor} />
          {message !== undefined ? (
            <>
              <Box flexShrink={0} height={1} />
              <Message text={message} noColor={noColor} />
            </>
          ) : null}
          <Box flexShrink={0} height={1} />
          <Footer lines={footer} noColor={noColor} />
        </>
      ) : (
        <>
          <Box flexDirection="row" flexShrink={0} height={rowRegionRows(state, size)} overflow="hidden">
            <Box flexShrink={0} flexDirection="column" width={detailOn ? leftW : size.cols}>
              <Table lines={tableViewLines(state, size)} noColor={noColor} />
            </Box>
            {detailOn ? (
              <Box flexShrink={0} flexDirection="column" marginLeft={DETAIL_GAP} width={size.cols - leftW - DETAIL_GAP}>
                <Detail lines={detailLines(state)} noColor={noColor} />
              </Box>
            ) : null}
          </Box>
          {state.modal !== undefined || message !== undefined ? <Box flexShrink={0} height={1} /> : null}
          {state.modal !== undefined ? (
            <Modal lines={modalLines(state)} noColor={noColor} />
          ) : message !== undefined ? (
            <Message text={message} noColor={noColor} />
          ) : null}
          <Box flexShrink={0} height={1} />
          <Footer lines={footer} noColor={noColor} />
        </>
      )}
    </Box>
  );
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

export { POLL_INTERVAL_MS };
