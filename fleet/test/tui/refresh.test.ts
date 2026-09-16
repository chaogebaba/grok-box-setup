// refresh.test.ts — `r` must RETIRE its own progress message.
//
// The bug this pins: `applyFleet` cleared the message only when it was exactly
// CONNECTING_MESSAGE, so "refreshing…" set by the `r` arm was never cleared by
// anything — the TUI stayed live (the poll kept ticking, keys kept working) but
// the status line said "refreshing…" until a view key wiped it.

import { test, expect, describe } from "bun:test";
import { mount, settle, silentClient } from "./ink-harness.ts";
import { box, state } from "./helpers.ts";
import { applyFleet, applyLinkDown, handleKey, initialState, REFRESHING_MESSAGE } from "../../src/tui/state.ts";
import type { ApiClient, FleetView } from "../../src/tui/api-client.ts";
import type { SnapshotBox } from "../../src/history/schema.ts";

const THREE: SnapshotBox[] = [box("grok-box-001"), box("grok-box-002"), box("grok-box-003")];
const view = (boxes = [box("grok-box-1")]): FleetView => ({
  snapshot_ts: "2026-05-01T00:01:00Z",
  apply: false,
  apply_source: "config",
  canary: null,
  scope: "admin",
  discover: null,
  boxes,
});
const NOW = Date.parse("2026-05-01T00:01:05Z");

describe("the `refreshing…` message is retired by the poll it started", () => {
  test("`r` sets it", () => {
    expect(handleKey(state(), "r").state.message).toBe(REFRESHING_MESSAGE);
  });

  test("the fleet answer clears it", () => {
    const s = handleKey(state(), "r").state;
    expect(applyFleet(s, view(), NOW).message).toBeUndefined();
  });

  test("a FAILED refresh clears it too (no spinner under LINK DOWN)", () => {
    const s = handleKey(state(), "r").state;
    expect(applyLinkDown(s, NOW).message).toBeUndefined();
  });

  test("an ACTION's message still survives the refresh the action triggers", () => {
    const s = { ...state({ boxes: [box("grok-box-1")] }), message: "check grok-box-1 → rc=0" };
    expect(applyFleet(s, view(), NOW).message).toBe("check grok-box-1 → rc=0");
  });

  // note (S1, gate r1): the same clearTransient() path also retires the
  // opening "connecting…" banner when the FIRST poll fails, not just when it
  // succeeds — base code left "connecting…" under LINK DOWN forever, since
  // applyLinkDown never touched `message` at all.
  test("a FIRST failed poll clears the connecting… banner too", () => {
    const s = initialState(NOW, true);
    expect(applyLinkDown(s, NOW).message).toBeUndefined();
  });
});

describe("through the mounted app", () => {
  test("r shows the note, and the answer takes it away", async () => {
    let release: ((v: { ok: true; value: FleetView }) => void) | undefined;
    const client = silentClient({
      fleet: (() => new Promise((r) => { release = r as never; })) as ApiClient["fleet"],
    });
    const m = mount(state({ boxes: THREE }), { client });
    await settle(40);
    await m.press("r");
    expect(m.lastFrame()).toContain("refreshing…");
    release?.({ ok: true, value: view(THREE) });
    await settle(60);
    expect(m.lastFrame()).not.toContain("refreshing…");
    m.unmount();
  });

  test("a refresh that fails does not leave the note on screen", async () => {
    const client = silentClient({
      fleet: (async () => ({ ok: false, kind: "link_down", message: "link down" })) as ApiClient["fleet"],
    });
    const m = mount(state({ boxes: THREE }), { client });
    await settle(40);
    await m.press("r");
    await settle(60);
    expect(m.lastFrame()).not.toContain("refreshing…");
    m.unmount();
  });
});
