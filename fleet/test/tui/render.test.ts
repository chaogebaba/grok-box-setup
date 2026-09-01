// render.test.ts — §7.6 render snapshots: all glyph states, STALE, LINK DOWN,
// modal, 80×24 degraded (detail pane dropped <100 cols), NO_COLOR, CONFIG
// column + canary C only when snapshot canary non-null.

import { test, expect, describe } from "bun:test";
import {
  renderFrame,
  renderHeader,
  renderTable,
  renderDetail,
  renderBanner,
  renderFooter,
  renderModal,
  boxGlyph,
  counts,
} from "../../src/tui/render.ts";
import { box, state, SIZE_80x24, SIZE_120x40 } from "./helpers.ts";

// R2: the header's apply reading must say when it could be STALE. `apply` is
// read live from the config per request; when that read fails the serve falls
// back to the (possibly 34h-old) snapshot value and marks it, and the header
// must show that rather than presenting a stale value as fact.
describe("header apply reading (R2 live-vs-fallback)", () => {
  const applyOf = (s: string) => s.split(/\s+/).find((w) => w.startsWith("apply="));
  test("a LIVE reading is unqualified", () => {
    expect(applyOf(renderHeader(state({ apply: true, applySource: "config" }), SIZE_120x40))).toBe("apply=ON");
    expect(applyOf(renderHeader(state({ apply: false, applySource: "config" }), SIZE_120x40))).toBe("apply=off");
  });
  test("a value that FELL BACK to the snapshot is suffixed with ?", () => {
    expect(applyOf(renderHeader(state({ apply: true, applySource: "snapshot" }), SIZE_120x40))).toBe("apply=ON?");
    expect(applyOf(renderHeader(state({ apply: false, applySource: "snapshot" }), SIZE_120x40))).toBe("apply=off?");
  });
  test("an unknown apply stays apply=? regardless of source", () => {
    expect(applyOf(renderHeader(state({ apply: null, applySource: "config" }), SIZE_120x40))).toBe("apply=?");
    expect(applyOf(renderHeader(state({ apply: null, applySource: "snapshot" }), SIZE_120x40))).toBe("apply=?");
  });
});

describe("box glyphs (all states)", () => {
  const s = state({ noColor: true });
  test("healthy ● / asleep ◌ (dim, not error) / incident ✕ / degraded ! / down ○", () => {
    expect(boxGlyph(s, box("b", { tunnel: "up", check: "OK" }))).toBe("●");
    expect(boxGlyph(s, box("b", { asleep: true }))).toBe("◌");
    expect(boxGlyph(s, box("b", { check: "FAIL" }))).toBe("✕");
    expect(boxGlyph(s, box("b", { checkfail: true }))).toBe("!");
    expect(boxGlyph(s, box("b", { drift: "yes" }))).toBe("!");
    expect(boxGlyph(s, box("b", { config: "drift" }))).toBe("!");
    expect(boxGlyph(s, box("b", { tunnel: "down", check: "-" }))).toBe("○");
  });
  test("asleep takes precedence and is NOT an error glyph", () => {
    // an asleep box that ALSO has checkfail still renders ◌ (dim), never ✕/!.
    expect(boxGlyph(s, box("b", { asleep: true, checkfail: true, check: "FAIL" }))).toBe("◌");
  });
});

describe("counts", () => {
  test("tallies healthy/degraded/down/asleep", () => {
    const c = counts([
      box("a", { check: "OK" }),
      box("b", { asleep: true }),
      box("c", { check: "FAIL" }),
      box("d", { drift: "yes" }),
    ]);
    expect(c).toEqual({ total: 4, healthy: 1, degraded: 1, down: 1, asleep: 1 });
  });
});

describe("table CONFIG column + canary C", () => {
  test("CONFIG column shows the snapshot config field; null → '-'", () => {
    const s = state({ boxes: [box("grok-box-1", { config: "drift" }), box("grok-box-2", { config: null })] });
    const rows = renderTable(s, SIZE_120x40);
    expect(rows.some((r) => r.includes("drift"))).toBe(true);
    // header includes CONFIG.
    expect(rows[0]).toContain("CONFIG");
  });
  test("canary C column present ONLY when snapshot canary is non-null", () => {
    const withCanary = state({ canary: "grok-box-1", boxes: [box("grok-box-1")] });
    expect(renderTable(withCanary, SIZE_120x40)[0]).toContain("C");
    const noCanary = state({ canary: null, boxes: [box("grok-box-1")] });
    // header without a trailing C column.
    expect(renderTable(noCanary, SIZE_120x40)[0]!.trimEnd().endsWith("C")).toBe(false);
  });
  test("null/missing per-box fields render '-'", () => {
    const s = state({ boxes: [box("grok-box-1", { ver: "-", drift: "unknown", config: null, expiry_days: null })] });
    const rows = renderTable(s, SIZE_120x40);
    const row = rows.find((r) => r.includes("grok-box-1"))!;
    expect(row).toContain("-"); // dashes for null fields
  });
  test("NO_COLOR selection marked with a leading '>'", () => {
    const s = state({ boxes: [box("grok-box-1"), box("grok-box-2")], selected: 1, noColor: true });
    const rows = renderTable(s, SIZE_120x40);
    const selRow = rows.find((r) => r.includes("grok-box-2"))!;
    expect(selRow.startsWith(">")).toBe(true);
  });
});

describe("banners", () => {
  test("LINK DOWN when link is down (with age)", () => {
    const s = state({ link: { up: false, sinceMs: Date.parse("2026-05-01T00:00:00Z") }, nowMs: Date.parse("2026-05-01T00:00:45Z") });
    expect(renderBanner(s, SIZE_80x24)).toContain("LINK DOWN 45s");
  });
  test("STALE when snapshot older than 15 min", () => {
    const s = state({ tickAgeS: 16 * 60, link: { up: true } });
    expect(renderBanner(s, SIZE_80x24)).toContain("STALE");
  });
  test("UNKNOWN when no snapshot yet", () => {
    const s = state({ snapshotTs: null, tickAgeS: null, link: { up: true } });
    expect(renderBanner(s, SIZE_80x24)).toContain("UNKNOWN");
  });
  test("no banner when link up and fresh", () => {
    const s = state({ tickAgeS: 10, link: { up: true } });
    expect(renderBanner(s, SIZE_80x24)).toBeUndefined();
  });
});

describe("footer scope-aware dimming (R3-A1)", () => {
  test("readonly scope marks action keys 'admin token required'", () => {
    const s = state({ scope: "readonly" });
    expect(renderFooter(s, SIZE_120x40)).toContain("admin token required");
  });
  test("admin scope shows the action keys plainly", () => {
    const s = state({ scope: "admin" });
    const f = renderFooter(s, SIZE_120x40);
    expect(f).toContain("P push");
    expect(f).not.toContain("admin token required");
  });
});

describe("modal (typed-name confirm, TUI-D10)", () => {
  test("push modal states 'single box, no canary gate' and asks for the box name", () => {
    const s = state({
      modal: { actionLabel: "config-push", box: "grok-box-1", typed: "grok", field: "confirm", note: "single box, no canary gate", expect: "grok-box-1" },
    });
    const rows = renderModal(s, SIZE_120x40);
    const joined = rows.join("\n");
    expect(joined).toContain("single box, no canary gate");
    expect(joined).toContain("type box name to confirm: grok");
    expect(joined).toContain('expect "grok-box-1"');
  });
  test("rename modal shows the new-name field", () => {
    const s = state({
      modal: { actionLabel: "rename", box: "grok-box-3", typed: "", target: "grok-box-003", field: "target", expect: "grok-box-3" },
    });
    const joined = renderModal(s, SIZE_120x40).join("\n");
    expect(joined).toContain("new name: grok-box-003");
  });
});

describe("layout: detail pane dropped <100 cols (80×24 degraded)", () => {
  test("80 cols ⇒ NO detail pane content in the frame", () => {
    const s = state({ boxes: [box("grok-box-1")], detail: { box: "grok-box-1", lines: [] } });
    const frame80 = renderFrame(s, SIZE_80x24);
    // the detail pane header "── grok-box-1" only appears when cols>=100.
    expect(frame80).not.toContain("── grok-box-1");
    const frame120 = renderFrame(s, SIZE_120x40);
    expect(frame120).toContain("── grok-box-1");
  });
  test("frame at 80×24 still renders header + table + footer", () => {
    const s = state();
    const frame = renderFrame(s, SIZE_80x24);
    expect(frame).toContain("fleet2");
    expect(frame).toContain("grok-box-1");
    expect(frame).toContain("q quit");
  });
});

describe("detail pane sparkline + canary label", () => {
  test("canary label reflects none / THIS box / other", () => {
    const none = renderDetail(state({ canary: null }), SIZE_120x40).join("\n");
    expect(none).toContain("canary: none");
    const self = renderDetail(state({ canary: "grok-box-1" }), SIZE_120x40).join("\n");
    expect(self).toContain("canary: THIS box");
  });
});
