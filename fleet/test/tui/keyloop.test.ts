// keyloop.test.ts — the PURE key reducer (handleKey), A15 selection recovery,
// filter, modals, scope-gating, and splitKeys. TTY-free (fake stdin ⇒ strings).

import { test, expect, describe } from "bun:test";
import {
  handleKey,
  recoverSelection,
  applyFleet,
  applyLinkDown,
  splitKeys,
  initialState,
  detailEffectFor,
  selectedBoxName,
  applyViewResult,
  viewError,
} from "../../src/tui/main.ts";
import type { FleetView } from "../../src/tui/api-client.ts";
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
      canary: null,
      scope: "admin",
      // grok-box-3 moved to index 0 in the new view; selection should follow it.
      boxes: [box("grok-box-3"), box("grok-box-1")],
    };
    const next = applyFleet(s, view, Date.parse("2026-05-01T00:01:05Z"));
    expect(next.boxes[next.selected]!.name).toBe("grok-box-3");
  });
  test("applyFleet after the selected box vanished falls back to first row", () => {
    const s = state({ boxes: [box("grok-box-1"), box("grok-box-2")], selected: 1 });
    const view: FleetView = {
      snapshot_ts: "2026-05-01T00:01:00Z", apply: false, canary: null, scope: "admin",
      boxes: [box("grok-box-1")], // grok-box-2 gone (e.g. renamed)
    };
    const next = applyFleet(s, view, Date.now());
    expect(next.selected).toBe(0);
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

describe("splitKeys", () => {
  test("splits arrows as 3-char sequences and chars individually", () => {
    expect(splitKeys("\x1b[Bj\x1b[A")).toEqual(["\x1b[B", "j", "\x1b[A"]);
    expect(splitKeys("abc")).toEqual(["a", "b", "c"]);
    expect(splitKeys("\x1b")).toEqual(["\x1b"]); // lone Esc
  });
});

describe("initialState", () => {
  test("starts link-down (connecting) with an empty fleet", () => {
    const s = initialState(1000, true);
    expect(s.link.up).toBe(false);
    expect(s.boxes).toEqual([]);
    expect(s.noColor).toBe(true);
  });
});
