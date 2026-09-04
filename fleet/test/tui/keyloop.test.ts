// keyloop.test.ts — the PURE key reducer (handleKey), A15 selection recovery,
// filter, modals and scope-gating. TTY-free: these call the reducer directly.

import { test, expect, describe } from "bun:test";
import {
  handleKey,
  recoverSelection,
  applyFleet,
  applyLinkDown,
  CONNECTING_MESSAGE,
  initialState,
  detailEffectFor,
  selectedBoxName,
  applyViewResult,
  viewError,
  shouldPoll,
} from "../../src/tui/state.ts";
import type { FleetView } from "../../src/tui/api-client.ts";
import type { TuiState } from "../../src/tui/state.ts";
import { box, state } from "./helpers.ts";

describe("navigation", () => {
  // B4: the key arms move the SELECTION only. The detail effect is derived from
  // the resulting NAME CHANGE (detailEffectFor), because the name also changes
  // on the first poll and on selection recovery, neither of which is a keypress.
  test("j/↓ and k/↑ move the selection; the name change is what loads the detail", () => {
    const s = state({ boxes: [box("grok-box-1"), box("grok-box-2")], selected: 0 });
    const down = handleKey(s, "j");
    expect(down.state.selected).toBe(1);
    expect(down.effect).toEqual({ type: "none" });
    expect(detailEffectFor(down.state, "grok-box-1")).toEqual({ type: "load-detail", box: "grok-box-2" });
    const up = handleKey(down.state, "\x1b[A");
    expect(up.state.selected).toBe(0);
    expect(up.effect).toEqual({ type: "none" });
    expect(detailEffectFor(up.state, "grok-box-2")).toEqual({ type: "load-detail", box: "grok-box-1" });
  });
  test("selection clamps at the ends", () => {
    const s = state({ boxes: [box("grok-box-1")], selected: 0 });
    expect(handleKey(s, "j").state.selected).toBe(0); // already last
    expect(handleKey(s, "k").state.selected).toBe(0); // already first
  });
});

describe("q / r / /", () => {
  test("q quits, r refreshes", () => {
    expect(handleKey(state(), "q").effect).toEqual({ type: "quit" });
    expect(handleKey(state(), "\x03").effect).toEqual({ type: "quit" }); // Ctrl-C
    expect(handleKey(state(), "r").effect).toEqual({ type: "refresh" });
  });
  test("/ enters filter mode; typing narrows; Esc clears", () => {
    let s = state({ boxes: [box("grok-box-1"), box("grok-box-2")] });
    s = handleKey(s, "/").state;
    expect(s.filtering).toBe(true);
    s = handleKey(s, "2").state;
    expect(s.filter).toBe("2");
    // Enter leaves filter-typing but keeps the filter.
    s = handleKey(s, "\r").state;
    expect(s.filtering).toBe(false);
    expect(s.filter).toBe("2");
  });
});

describe("A15 selection recovery", () => {
  test("a filter matching nothing (not mid-typing) is cleared", () => {
    const s = state({ boxes: [box("grok-box-1")], filter: "zzz", filtering: false, selected: 0 });
    const r = recoverSelection(s);
    expect(r.filter).toBe(""); // cleared because it matched nothing
  });
  test("a disappeared selection falls back to the first row", () => {
    const s = state({ boxes: [box("grok-box-1"), box("grok-box-2")], selected: 5 });
    expect(recoverSelection(s).selected).toBe(0);
  });
  test("applyFleet preserves the selected box across a re-read by name", () => {
    const s = state({ boxes: [box("grok-box-1"), box("grok-box-2"), box("grok-box-3")], selected: 2 });
    const view: FleetView = {
      snapshot_ts: "2026-05-01T00:01:00Z",
      apply: false,
      apply_source: "config",
      canary: null,
      scope: "admin",
      discover: null,
      // grok-box-3 moved to index 0 in the new view; selection should follow it.
      boxes: [box("grok-box-3"), box("grok-box-1")],
    };
    const next = applyFleet(s, view, Date.parse("2026-05-01T00:01:05Z"));
    expect(next.boxes[next.selected]!.name).toBe("grok-box-3");
  });
  test("applyFleet after the selected box vanished falls back to first row", () => {
    const s = state({ boxes: [box("grok-box-1"), box("grok-box-2")], selected: 1 });
    const view: FleetView = {
      snapshot_ts: "2026-05-01T00:01:00Z", apply: false, apply_source: "config", canary: null,
      scope: "admin", discover: null,
      boxes: [box("grok-box-1")], // grok-box-2 gone (e.g. renamed)
    };
    const next = applyFleet(s, view, Date.now());
    expect(next.selected).toBe(0);
  });
});

// --- r2 fix 4: the opening banner must not outlive the first answer ----------
describe("the `connecting…` message is retired by the first successful poll", () => {
  const view = (boxes = [box("grok-box-1")]): FleetView => ({
    snapshot_ts: "2026-05-01T00:01:00Z",
    apply: false,
    apply_source: "config",
    canary: null,
    scope: "admin",
    discover: null,
    boxes,
  });

  test("initialState opens with it", () => {
    expect(initialState(Date.parse("2026-05-01T00:00:00Z"), true).message).toBe(CONNECTING_MESSAGE);
  });

  test("the first fleet answer clears it", () => {
    const s = initialState(Date.parse("2026-05-01T00:00:00Z"), true);
    expect(applyFleet(s, view(), Date.parse("2026-05-01T00:01:05Z")).message).toBeUndefined();
  });

  test("it does not come back on later polls", () => {
    let s = initialState(Date.parse("2026-05-01T00:00:00Z"), true);
    s = applyFleet(s, view(), Date.parse("2026-05-01T00:01:05Z"));
    s = applyFleet(s, view(), Date.parse("2026-05-01T00:01:10Z"));
    expect(s.message).toBeUndefined();
  });

  // The mutant this guards: clearing the message UNCONDITIONALLY. `run-action`
  // polls immediately after the action, so an unconditional clear would wipe the
  // action's own result off the screen before it could be read.
  test("an ACTION's message survives the refresh the action triggers", () => {
    const s = { ...state({ boxes: [box("grok-box-1")] }), message: "check grok-box-1 → rc=0" };
    expect(applyFleet(s, view(), Date.parse("2026-05-01T00:01:05Z")).message).toBe("check grok-box-1 → rc=0");
  });
});

describe("link down keeps last-good", () => {
  test("applyLinkDown preserves boxes and records the since time once", () => {
    const s = state({ boxes: [box("grok-box-1")], link: { up: true } });
    const down = applyLinkDown(s, 1000);
    expect(down.boxes.length).toBe(1); // last-good kept
    expect(down.link).toEqual({ up: false, sinceMs: 1000 });
    // a second link-down does not reset the sinceMs.
    const down2 = applyLinkDown(down, 5000);
    expect(down2.link).toEqual({ up: false, sinceMs: 1000 });
  });
});

describe("action keys + scope gating", () => {
  test("readonly token: an action key is refused with a message (no effect)", () => {
    const s = state({ scope: "readonly", boxes: [box("grok-box-1")] });
    const r = handleKey(s, "P");
    expect(r.effect).toEqual({ type: "none" });
    expect(r.state.message).toContain("admin token required");
  });
  test("admin: T (check) runs immediately (non-destructive, no modal)", () => {
    const s = state({ scope: "admin", boxes: [box("grok-box-1")], selected: 0 });
    const r = handleKey(s, "T");
    expect(r.effect.type).toBe("run-action");
    if (r.effect.type === "run-action") {
      expect(r.effect.spec.kind).toBe("check");
      expect(r.effect.box).toBe("grok-box-1");
    }
    expect(r.state.modal).toBeUndefined();
  });
  test("admin: P (push) opens a typed-name confirm modal, not an immediate action", () => {
    const s = state({ scope: "admin", boxes: [box("grok-box-1")], selected: 0 });
    const r = handleKey(s, "P");
    expect(r.effect).toEqual({ type: "none" });
    expect(r.state.modal?.actionLabel).toBe("config-push");
    expect(r.state.modal?.expect).toBe("grok-box-1");
    expect(r.state.modal?.note).toBe("single box, no canary gate");
  });
});

describe("modal confirm flow", () => {
  test("wrong typed name ⇒ mismatch message, no action; correct ⇒ run-action", () => {
    let s = state({ scope: "admin", boxes: [box("grok-box-1")], selected: 0 });
    s = handleKey(s, "P").state; // open modal
    // type the wrong name then Enter.
    for (const c of "grok-box-2") s = handleKey(s, c).state;
    let r = handleKey(s, "\r");
    expect(r.effect).toEqual({ type: "none" });
    expect(r.state.message).toContain("confirm mismatch");
    // fix the name: clear + type correct.
    s = r.state;
    for (let i = 0; i < 20; i++) s = handleKey(s, "\x7f").state; // backspace clear
    for (const c of "grok-box-1") s = handleKey(s, c).state;
    r = handleKey(s, "\r");
    expect(r.effect.type).toBe("run-action");
    if (r.effect.type === "run-action") expect(r.effect.spec.kind).toBe("config-push");
    expect(r.state.modal).toBeUndefined();
  });
  test("Esc cancels the modal", () => {
    let s = state({ scope: "admin", boxes: [box("grok-box-1")] });
    s = handleKey(s, "P").state;
    const r = handleKey(s, "\x1b");
    expect(r.state.modal).toBeUndefined();
    expect(r.state.message).toBe("cancelled");
  });
  test("rename modal: target field then confirm, then run-action carries `to`", () => {
    let s = state({ scope: "admin", boxes: [box("grok-box-3")], selected: 0 });
    s = handleKey(s, "R").state; // open rename modal (field=target)
    expect(s.modal?.field).toBe("target");
    for (const c of "grok-box-003") s = handleKey(s, c).state;
    s = handleKey(s, "\r").state; // move to confirm field
    expect(s.modal?.field).toBe("confirm");
    for (const c of "grok-box-3") s = handleKey(s, c).state;
    const r = handleKey(s, "\r");
    expect(r.effect.type).toBe("run-action");
    if (r.effect.type === "run-action") {
      expect(r.effect.spec.kind).toBe("rename");
      expect(r.effect.to).toBe("grok-box-003");
    }
  });
});

// (`splitKeys` is gone: Ink parses the keypress and `keys.ts` maps it — see
// keys.test.ts, which pins the whole table.)

describe("initialState", () => {
  test("starts link-down (connecting) with an empty fleet", () => {
    const s = initialState(1000, true);
    expect(s.link.up).toBe(false);
    expect(s.boxes).toEqual([]);
    expect(s.noColor).toBe(true);
  });
});

// --- 5.7.0: D/J/H views, the B4 detail trigger, the D6 suppression -----------

import type { ViewState } from "../../src/tui/state.ts";

const TWO = [box("grok-box-1"), box("grok-box-2")];

describe("B4: the detail effect fires on a NAME CHANGE, not on a keypress", () => {
  test("the first poll's selection loads WITHOUT a keypress (gate r2)", () => {
    const s = state({ boxes: TWO, selected: 0 });
    expect(detailEffectFor(s, null)).toEqual({ type: "load-detail", box: "grok-box-1" });
  });
  test("a second poll with the SAME selection does not refire it", () => {
    const s = state({ boxes: TWO, selected: 0 });
    expect(detailEffectFor(s, "grok-box-1")).toEqual({ type: "none" });
  });
  test("a single-box fleet gets its detail with no keypress at all", () => {
    const s = state({ boxes: [box("grok-box-9")], selected: 0 });
    expect(detailEffectFor(s, null)).toEqual({ type: "load-detail", box: "grok-box-9" });
  });
  test("an EMPTY fleet asks for nothing", () => {
    expect(detailEffectFor(state({ boxes: [] }), null)).toEqual({ type: "none" });
    expect(selectedBoxName(state({ boxes: [] }))).toBeUndefined();
  });
  test("a clamped j at the end of the list changes no name and refires nothing", () => {
    const s = state({ boxes: [box("grok-box-1")], selected: 0 });
    const after = handleKey(s, "j").state;
    expect(detailEffectFor(after, "grok-box-1")).toEqual({ type: "none" });
  });
  test("selection recovery that lands on a DIFFERENT box fires it once", () => {
    const s = recoverSelection(state({ boxes: TWO, selected: 5 })); // falls back to row 0
    expect(detailEffectFor(s, "grok-box-2")).toEqual({ type: "load-detail", box: "grok-box-1" });
  });
});

describe("D2/D3/D4: opening a view", () => {
  test("D opens the diff view and asks for the selected box's diff", () => {
    const r = handleKey(state({ boxes: TWO, selected: 1 }), "D");
    expect(r.state.view).toMatchObject({ kind: "diff", box: "grok-box-2", offset: 0, loading: true });
    expect(r.effect).toEqual({ type: "load-view", kind: "diff", box: "grok-box-2" });
  });
  test("J opens the journal view", () => {
    const r = handleKey(state({ boxes: TWO, selected: 0 }), "J");
    expect(r.state.view).toMatchObject({ kind: "journal", box: "grok-box-1", loading: true });
    expect(r.effect).toEqual({ type: "load-view", kind: "journal", box: "grok-box-1" });
  });
  // D4: history renders from the ALREADY-LOADED per-selection fetch — no second
  // request and no second endpoint call.
  test("H opens the history view from state.detail, issuing NO request", () => {
    const lines = [{ v: 1 as const, ts: "2026-05-01T02:00:00Z", apply: false, canary: null, boxes: [box("grok-box-1")] }];
    const s = state({ boxes: TWO, selected: 0, detail: { box: "grok-box-1", lines } });
    const r = handleKey(s, "H");
    expect(r.effect).toEqual({ type: "none" }); // NO fetch
    expect(r.state.view).toMatchObject({ kind: "history", box: "grok-box-1", loading: false });
    expect(r.state.view!.history).toEqual(lines);
  });
  test("H with the history loaded for ANOTHER box captures nothing, not that box's rows", () => {
    const lines = [{ v: 1 as const, ts: "2026-05-01T02:00:00Z", apply: false, canary: null, boxes: [box("grok-box-1")] }];
    const s = state({ boxes: TWO, selected: 1, detail: { box: "grok-box-1", lines } });
    expect(handleKey(s, "H").state.view!.history).toEqual([]);
  });
  test("D/J/H are INERT when no box is selected", () => {
    const s = state({ boxes: [], selected: 0 });
    for (const k of ["D", "J", "H"]) {
      const r = handleKey(s, k);
      expect(r.state.view).toBeUndefined();
      expect(r.effect).toEqual({ type: "none" });
    }
  });
});

describe("keys INSIDE an open view", () => {
  const content = Array.from({ length: 100 }, (_, i) => `L${i}`);
  const open = (over: Partial<ViewState> = {}): TuiState =>
    state({ boxes: TWO, selected: 0, view: { kind: "diff", box: "grok-box-1", offset: 0, loading: false, lines: content, ...over } });
  const SMALL = { cols: 100, rows: 24 };

  test("j/↓ and k/↑ scroll rather than moving the table selection", () => {
    const down = handleKey(open(), "j", SMALL);
    expect(down.state.view!.offset).toBe(1);
    expect(down.state.selected).toBe(0); // the table selection did NOT move
    const arrowDown = handleKey(down.state, "\x1b[B", SMALL);
    expect(arrowDown.state.view!.offset).toBe(2);
    const up = handleKey(arrowDown.state, "k", SMALL);
    expect(up.state.view!.offset).toBe(1);
  });
  test("scrolling up at the top clamps at 0", () => {
    expect(handleKey(open(), "k", SMALL).state.view!.offset).toBe(0);
  });
  test("scrolling down at the end clamps to total − rows_available", () => {
    // rows available at 24 rows / 100 cols = 24 − 6 chrome = 18 ⇒ max offset 82.
    let s = open({ offset: 82 });
    s = handleKey(s, "j", SMALL).state;
    expect(s.view!.offset).toBe(82);
  });
  test("Esc closes the view", () => {
    const r = handleKey(open(), "\x1b");
    expect(r.state.view).toBeUndefined();
  });
  // gate note 4: in normal mode `q` quits; in a view it must CLOSE the view,
  // which is why the view branch is checked before the normal-mode switch.
  test("q CLOSES the view instead of quitting the TUI", () => {
    const r = handleKey(open(), "q");
    expect(r.state.view).toBeUndefined();
    expect(r.effect).toEqual({ type: "none" }); // NOT { type: "quit" }
  });
  test("Ctrl-C still quits from inside a view", () => {
    expect(handleKey(open(), "\x03").effect).toEqual({ type: "quit" });
  });
  // D4: `r` is VIEW-SCOPED and targets the CAPTURED box, not the selection.
  test("r refetches the CAPTURED box even after the poll moved the selection", () => {
    const s = state({
      boxes: TWO,
      selected: 1, // the poll moved the selection to grok-box-2 …
      view: { kind: "history", box: "grok-box-1", offset: 3, loading: false, history: [] }, // … the view captured box-1
    });
    const r = handleKey(s, "r");
    expect(r.effect).toEqual({ type: "load-view", kind: "history", box: "grok-box-1" });
    expect(r.state.view!.loading).toBe(true);
  });
  test("an unknown key inside a view does nothing", () => {
    const r = handleKey(open(), "z");
    expect(r.state.view!.offset).toBe(0);
    expect(r.effect).toEqual({ type: "none" });
  });
  test("action keys do NOT reach the danger table from inside a view", () => {
    const r = handleKey(open(), "P");
    expect(r.state.modal).toBeUndefined();
    expect(r.effect).toEqual({ type: "none" });
  });
});

describe("D6: the detail effect is suppressed while a view is open", () => {
  const view: ViewState = { kind: "diff", box: "grok-box-1", offset: 0, loading: false, lines: ["x"] };
  test("poll-driven selection recovery while a view is open fires NO fetch", () => {
    const s = state({ boxes: TWO, selected: 1, view });
    expect(detailEffectFor(s, "grok-box-1")).toEqual({ type: "none" });
  });
  test("even a first-ever selection is suppressed while a view is open", () => {
    expect(detailEffectFor(state({ boxes: TWO, selected: 0, view }), null)).toEqual({ type: "none" });
  });
  test("on CLOSE, a selection that moved fires the effect exactly once", () => {
    const s = state({ boxes: TWO, selected: 1, view });
    const closed = handleKey(s, "\x1b").state;
    const first = detailEffectFor(closed, "grok-box-1");
    expect(first).toEqual({ type: "load-detail", box: "grok-box-2" });
    // …and once the loop records it, not again.
    expect(detailEffectFor(closed, "grok-box-2")).toEqual({ type: "none" });
  });
  test("on close with the SAME selection, nothing is refetched", () => {
    const s = state({ boxes: TWO, selected: 0, view });
    expect(detailEffectFor(handleKey(s, "q").state, "grok-box-1")).toEqual({ type: "none" });
  });
});

describe("view fetch results (applyViewResult / viewError)", () => {
  const open = (over: Partial<ViewState> = {}): TuiState =>
    state({ view: { kind: "diff", box: "grok-box-1", offset: 5, loading: true, ...over } });

  test("a result for the OPEN view is stored and resets the scroll", () => {
    const next = applyViewResult(open(), "diff", "grok-box-1", { lines: ["a", "b"] });
    expect(next.view).toMatchObject({ loading: false, offset: 0, lines: ["a", "b"] });
  });
  test("a result for a DIFFERENT box is dropped, never painted under the wrong title", () => {
    const s = open();
    expect(applyViewResult(s, "diff", "grok-box-2", { lines: ["other"] })).toBe(s);
  });
  test("a result for a different KIND is dropped too", () => {
    const s = open();
    expect(applyViewResult(s, "journal", "grok-box-1", { lines: ["other"] })).toBe(s);
  });
  test("a result landing after the view closed is dropped", () => {
    const s = state({ view: undefined });
    expect(applyViewResult(s, "diff", "grok-box-1", { lines: ["late"] })).toBe(s);
  });
  test("a 403 on the journal becomes plain words, not a crash", () => {
    expect(viewError({ ok: false, kind: "forbidden", message: "admin scope required" }, "journal")).toBe(
      "journal: admin token required",
    );
  });
  test("a link failure becomes `link error`", () => {
    expect(viewError({ ok: false, kind: "link_down", message: "link down" }, "diff")).toBe("link error");
  });
  test("a 401 says the token is the problem", () => {
    expect(viewError({ ok: false, kind: "unauthorized", message: "no" }, "diff")).toContain("token");
  });
  test("any other failure keeps the server's own message", () => {
    expect(viewError({ ok: false, kind: "error", message: "box not enrolled" }, "diff")).toBe("box not enrolled");
  });
  // D8: the read-only test — a failed view fetch shows `link error` IN THE VIEW
  // and leaves the fleet data alone; it is not a reason to drop the last-good
  // box list or to declare the link down.
  test("a failed view fetch leaves the boxes and the link state untouched", () => {
    const s = state({ boxes: TWO, view: { kind: "diff", box: "grok-box-1", offset: 0, loading: true } });
    const next = applyViewResult(s, "diff", "grok-box-1", { error: "link error" });
    expect(next.view!.error).toBe("link error");
    expect(next.boxes).toEqual(TWO);
    expect(next.link).toEqual({ up: true });
    expect(next.snapshotTs).toBe(s.snapshotTs);
  });
  test("an error is stored on the view and clears the loading state", () => {
    const next = applyViewResult(open(), "diff", "grok-box-1", { error: "link error" });
    expect(next.view).toMatchObject({ loading: false, error: "link error" });
  });
});

describe("Acceptance 3: the 5s fleet poll keeps running under an open view", () => {
  const view: ViewState = { kind: "diff", box: "grok-box-1", offset: 2, loading: false, lines: ["--- a", "+++ b"] };
  // the ledger's "poll paused while a view is open" mutant lives here.
  test("shouldPoll is true with a view open, exactly as without one", () => {
    expect(shouldPoll(state({ boxes: TWO, view }))).toBe(true);
    expect(shouldPoll(state({ boxes: TWO }))).toBe(true);
    for (const kind of ["diff", "journal", "history"] as const) {
      expect(shouldPoll(state({ view: { ...view, kind } }))).toBe(true);
    }
  });
  test("a poll landing under an open view updates the header and leaves the view ALONE", () => {
    const s = state({ boxes: TWO, selected: 0, view, snapshotTs: "2026-05-01T00:00:00Z" });
    const fresh: FleetView = {
      snapshot_ts: "2026-05-01T00:05:00Z",
      apply: true,
      apply_source: "config",
      canary: null,
      scope: "admin",
      boxes: TWO,
      discover: null,
    };
    const next = applyFleet(s, fresh, Date.parse("2026-05-01T00:05:20Z"));
    expect(next.snapshotTs).toBe("2026-05-01T00:05:00Z"); // the header moved on
    expect(next.tickAgeS).toBe(20);
    expect(next.view).toEqual(view); // the captured content did NOT
  });
  test("a poll that drops the captured box does not disturb the open view", () => {
    const s = state({ boxes: TWO, selected: 0, view });
    const fresh: FleetView = {
      snapshot_ts: "2026-05-01T00:05:00Z", apply: false, apply_source: "config", canary: null,
      scope: "admin", boxes: [box("grok-box-2")], discover: null, // grok-box-1 de-enrolled
    };
    const next = applyFleet(s, fresh, Date.parse("2026-05-01T00:05:00Z"));
    expect(next.view).toEqual(view); // still box-1's diff, under box-1's title
    expect(detailEffectFor(next, "grok-box-1")).toEqual({ type: "none" }); // and no fetch
  });
});
