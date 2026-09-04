// interaction.test.ts — keys, resize, the poll and the detail load driven
// through a mounted Ink app (fleet-tui-ink D5).
//
// Everything here goes in as BYTES on the fake stdin and comes out as a painted
// frame or a recorded client call, so the whole path — Ink's keypress parser,
// keys.ts, the reducer, the effect drain — is exercised, not just the pure
// pieces. TTY-free and network-free.

import { test, expect, describe } from "bun:test";
import { mount, settle, silentClient } from "./ink-harness.ts";
import { box, state } from "./helpers.ts";
import type { ApiClient } from "../../src/tui/api-client.ts";
import type { SnapshotBox } from "../../src/history/schema.ts";

const THREE: SnapshotBox[] = [box("grok-box-001"), box("grok-box-002"), box("grok-box-003")];
const THIRTY: SnapshotBox[] = Array.from({ length: 30 }, (_, i) => box(`grok-box-${String(i + 1).padStart(3, "0")}`));

const ESC = "\x1b";
const CTRL_C = "\x03";
const CTRL_P = "\x10";
const CTRL_R = "\x12";
const CTRL_T = "\x14";
const ALT_J = "\x1bj";
const BACKSPACE = "\x7f";

/** Escape needs Ink's 20 ms pending-escape flush before it is a key. */
async function pressEscape(m: { press: (b: string) => Promise<void> }): Promise<void> {
  await m.press(ESC);
  await settle(40);
}

describe("keys inside an open view", () => {
  const withView = (kind: "diff" = "diff") =>
    state({ boxes: THREE, selected: 0, view: { kind, box: "grok-box-001", offset: 0, loading: false, lines: ["--- a", "+++ b"] } });

  test("q CLOSES the view instead of quitting the TUI", async () => {
    let quit = 0;
    const m = mount(withView(), { onQuit: () => quit++ });
    await settle(40);
    expect(m.lastFrame()).toContain("── diff grok-box-001");
    await m.press("q");
    expect(m.lastFrame()).not.toContain("── diff grok-box-001");
    expect(m.lastFrame()).toContain("WHO"); // the table is back
    expect(quit).toBe(0);
    m.unmount();
  });

  test("Escape closes the view", async () => {
    const m = mount(withView());
    await settle(40);
    await pressEscape(m);
    expect(m.lastFrame()).not.toContain("── diff grok-box-001");
    m.unmount();
  });
});

describe("keys in normal mode", () => {
  test("q quits", async () => {
    let quit = 0;
    const m = mount(state({ boxes: THREE }), { onQuit: () => quit++ });
    await settle(40);
    await m.press("q");
    expect(quit).toBe(1);
    m.unmount();
  });

  test("ctrl-c reaches the reducer and does NOT unmount the app", async () => {
    let quit = 0;
    const m = mount(state({ boxes: THREE }), { onQuit: () => quit++ });
    await settle(40);
    await m.press(CTRL_C);
    // With exitOnCtrlC:true Ink swallows the key and unmounts behind the
    // reducer's back, and this count stays 0.
    expect(quit).toBe(1);
    // still mounted: the next key still moves the selection.
    await m.press("j");
    expect(m.lastFrame()).toContain("> grok-box-002");
    m.unmount();
  });

  test("a two-character write is handled as TWO keys", async () => {
    const m = mount(state({ boxes: THREE, selected: 0 }));
    await settle(40);
    await m.press("jj");
    expect(m.lastFrame()).toContain("> grok-box-003");
    m.unmount();
  });

  test("Escape cancels a modal", async () => {
    const m = mount(state({ boxes: THREE, scope: "admin" }));
    await settle(40);
    await m.press("P");
    expect(m.lastFrame()).toContain("type box name to confirm:");
    await pressEscape(m);
    expect(m.lastFrame()).not.toContain("type box name to confirm:");
    expect(m.lastFrame()).toContain("cancelled");
    m.unmount();
  });

  test("backspace edits the modal's typed name", async () => {
    const m = mount(state({ boxes: THREE, scope: "admin" }));
    await settle(40);
    await m.press("P");
    await m.press("g");
    await m.press("x");
    expect(m.lastFrame()).toContain("type box name to confirm: gx_");
    await m.press(BACKSPACE);
    expect(m.lastFrame()).toContain("type box name to confirm: g_");
    m.unmount();
  });

  test("backspace edits the filter", async () => {
    const m = mount(state({ boxes: THIRTY, selected: 0 }));
    await settle(40);
    await m.press("/");
    await m.press("0");
    await m.press("1");
    expect(m.lastFrame()).toContain("grok-box-001");
    expect(m.lastFrame()).not.toContain("grok-box-002");
    await m.press(BACKSPACE);
    expect(m.lastFrame()).toContain("grok-box-002"); // the filter widened again
    m.unmount();
  });
});

describe("the deliberate no-ops reach nothing", () => {
  test("ctrl-p does NOT open the config-push modal", async () => {
    const m = mount(state({ boxes: THREE, scope: "admin" }));
    await settle(40);
    const before = m.lastFrame();
    await m.press(CTRL_P);
    expect(m.lastFrame()).not.toContain("type box name to confirm:");
    expect(m.lastFrame()).toBe(before);
    m.unmount();
  });

  test("ctrl-r does not refresh and ctrl-t does not POST a check", async () => {
    let checks = 0;
    const client = silentClient({ check: (async () => { checks++; return { ok: true, value: { rc: 0, log: [] } }; }) as ApiClient["check"] });
    const m = mount(state({ boxes: THREE, scope: "admin" }), { client });
    await settle(40);
    const before = m.lastFrame();
    await m.press(CTRL_R);
    await m.press(CTRL_T);
    expect(m.lastFrame()).not.toContain("refreshing…");
    expect(m.lastFrame()).toBe(before);
    expect(checks).toBe(0);
    m.unmount();
  });

  test("alt-j does not move the selection", async () => {
    const m = mount(state({ boxes: THREE, selected: 0 }));
    await settle(40);
    await m.press(ALT_J);
    await settle(40);
    expect(m.lastFrame()).toContain("> grok-box-001");
    m.unmount();
  });
});

test("the 5s poll keeps firing while keys arrive", async () => {
  // Mutant: putting `state` in the poll effect's deps re-installs the interval
  // on every keystroke, so with keys arriving faster than the period it never
  // fires again. Real timers, no fake-timer dependency.
  let polls = 0;
  const client = silentClient({
    fleet: (async () => {
      polls++;
      return { ok: false, kind: "link_down", message: "no link" };
    }) as ApiClient["fleet"],
  });
  const m = mount(state({ boxes: THREE }), { client, pollIntervalMs: 30 });
  const typing = setInterval(() => void m.press("j"), 10);
  await settle(120);
  clearInterval(typing);
  // one immediate read at mount plus at least two interval ticks.
  expect(polls).toBeGreaterThanOrEqual(3);
  m.unmount();
});

test("closing a view after the selection moved loads the detail EXACTLY once", async () => {
  // D6: the load is suppressed while a view is open and the ref it compares
  // against is left untouched, so the close fires it once — and only once.
  const loaded: string[] = [];
  const client = silentClient({
    box: (async (name: string) => {
      loaded.push(name);
      return { ok: false, kind: "error", message: "no" };
    }) as unknown as ApiClient["box"],
    history: (async () => ({ ok: false, kind: "error", message: "no" })) as unknown as ApiClient["history"],
  });
  const s = state({
    boxes: [box("grok-box-001"), box("grok-box-002")],
    selected: 1, // the poll moved the selection …
    view: { kind: "diff", box: "grok-box-001", offset: 0, loading: false, lines: ["x"] }, // … under an open view
  });
  const m = mount(s, { client });
  await settle(60);
  expect(loaded).toEqual([]); // suppressed while the view is open
  await m.press("q"); // close
  await settle(60);
  expect(loaded).toEqual(["grok-box-002"]);
  // and not again on a later render.
  await m.press("k");
  await m.press("j");
  await settle(60);
  expect(loaded).toEqual(["grok-box-002", "grok-box-001", "grok-box-002"]);
  m.unmount();
});
