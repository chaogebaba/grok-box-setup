// model.test.ts — the presentation model (fleet-tui-ink D1).
//
// These are the assertions that lived in render.test.ts, moved with the
// painters they cover. The only edits are the ones the port forced: `sgr()` is
// gone so the strings are plain, and `boxGlyph` became `boxHealth`, which
// returns a glyph AND a semantic tone instead of a coloured string.

import { test, expect, describe } from "bun:test";
import {
  bannerText,
  boxHealth,
  counts,
  detailLines,
  discoverText,
  footerLines,
  headerText,
  modalLines,
  tableLines,
} from "../../src/tui/model.ts";
import { toneProps } from "../../src/tui/tone.ts";
import { box, state, SIZE_80x24, SIZE_120x40 } from "./helpers.ts";

// R2: the header's apply reading must say when it could be STALE. `apply` is
// read live from the config per request; when that read fails the serve falls
// back to the (possibly 34h-old) snapshot value and marks it.
describe("header apply reading (R2 live-vs-fallback)", () => {
  const applyOf = (s: string): string | undefined => s.split(/\s+/).find((w) => w.startsWith("apply="));
  test("a LIVE reading is unqualified", () => {
    expect(applyOf(headerText(state({ apply: true, applySource: "config" }), SIZE_120x40))).toBe("apply=ON");
    expect(applyOf(headerText(state({ apply: false, applySource: "config" }), SIZE_120x40))).toBe("apply=off");
  });
  test("a value that FELL BACK to the snapshot is suffixed with ?", () => {
    expect(applyOf(headerText(state({ apply: true, applySource: "snapshot" }), SIZE_120x40))).toBe("apply=ON?");
    expect(applyOf(headerText(state({ apply: false, applySource: "snapshot" }), SIZE_120x40))).toBe("apply=off?");
  });
  test("an unknown apply stays apply=? regardless of source", () => {
    expect(applyOf(headerText(state({ apply: null, applySource: "config" }), SIZE_120x40))).toBe("apply=?");
    expect(applyOf(headerText(state({ apply: null, applySource: "snapshot" }), SIZE_120x40))).toBe("apply=?");
  });
});

describe("box health (all states)", () => {
  const s = state({ noColor: true });
  test("healthy ● / asleep ◌ (dim, not error) / incident ✕ / degraded ! / down ○", () => {
    expect(boxHealth(s, box("b", { tunnel: "up", check: "OK" }))).toEqual({ glyph: "●", tone: "ok" });
    expect(boxHealth(s, box("b", { asleep: true }))).toEqual({ glyph: "◌", tone: "dim" });
    expect(boxHealth(s, box("b", { check: "FAIL" }))).toEqual({ glyph: "✕", tone: "down" });
    expect(boxHealth(s, box("b", { checkfail: true })).glyph).toBe("!");
    expect(boxHealth(s, box("b", { drift: "yes" })).glyph).toBe("!");
    expect(boxHealth(s, box("b", { config: "drift" })).glyph).toBe("!");
    expect(boxHealth(s, box("b", { tunnel: "down", check: "-" }))).toEqual({ glyph: "○", tone: "dim" });
  });
  test("asleep takes precedence and is NOT an error glyph or an error colour", () => {
    const h = boxHealth(s, box("b", { asleep: true, checkfail: true, check: "FAIL" }));
    expect(h.glyph).toBe("◌");
    expect(h.tone).toBe("dim");
    expect(toneProps(h.tone, false)).toEqual({ dimColor: true });
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
  const texts = (s: ReturnType<typeof state>): string[] => tableLines(s, SIZE_120x40).map((l) => l.text);
  test("CONFIG column shows the snapshot config field; null → '-'", () => {
    const rows = texts(state({ boxes: [box("grok-box-1", { config: "drift" }), box("grok-box-2", { config: null })] }));
    expect(rows.some((r) => r.includes("drift"))).toBe(true);
    expect(rows[0]).toContain("CONFIG");
  });
  test("canary C column present ONLY when snapshot canary is non-null", () => {
    expect(texts(state({ canary: "grok-box-1", boxes: [box("grok-box-1")] }))[0]).toContain("C");
    expect(texts(state({ canary: null, boxes: [box("grok-box-1")] }))[0]!.trimEnd().endsWith("C")).toBe(false);
  });
  test("null/missing per-box fields render '-'", () => {
    const rows = texts(state({ boxes: [box("grok-box-1", { ver: "-", drift: "unknown", config: null, expiry_days: null })] }));
    expect(rows.find((r) => r.includes("grok-box-1"))).toContain("-");
  });
  test("NO_COLOR selection marked with a leading '>'; in colour it is inverse", () => {
    const s = state({ boxes: [box("grok-box-1"), box("grok-box-2")], selected: 1, noColor: true });
    expect(texts(s).find((r) => r.includes("grok-box-2"))!.startsWith(">")).toBe(true);
    const colour = tableLines({ ...s, noColor: false }, SIZE_120x40);
    const row = colour.find((r) => r.text.includes("grok-box-2"))!;
    expect(row.selected).toBe(true);
    expect(row.text.startsWith(">")).toBe(false);
  });
});

describe("banners", () => {
  test("LINK DOWN when link is down (with age)", () => {
    const s = state({ link: { up: false, sinceMs: Date.parse("2026-05-01T00:00:00Z") }, nowMs: Date.parse("2026-05-01T00:00:45Z") });
    const b = bannerText(s, SIZE_80x24)!;
    expect(b.text).toContain("LINK DOWN 45s");
    expect(b.tone).toBe("down");
  });
  test("STALE when snapshot older than 15 min", () => {
    const b = bannerText(state({ tickAgeS: 16 * 60, link: { up: true } }), SIZE_80x24)!;
    expect(b.text).toContain("STALE");
    expect(b.tone).toBe("warn");
  });
  test("UNKNOWN when no snapshot yet", () => {
    expect(bannerText(state({ snapshotTs: null, tickAgeS: null, link: { up: true } }), SIZE_80x24)!.text).toContain("UNKNOWN");
  });
  test("no banner when link up and fresh", () => {
    expect(bannerText(state({ tickAgeS: 10, link: { up: true } }), SIZE_80x24)).toBeUndefined();
  });
});

describe("footer scope-aware dimming (R3-A1)", () => {
  test("readonly scope marks action keys 'admin token required'", () => {
    expect(footerLines(state({ scope: "readonly" }), SIZE_120x40).join("\n")).toContain("admin token required");
  });
  test("admin scope shows the action keys plainly", () => {
    const f = footerLines(state({ scope: "admin" }), SIZE_120x40).join("\n");
    expect(f).toContain("P push");
    expect(f).not.toContain("admin token required");
  });
});

describe("modal (typed-name confirm, TUI-D10)", () => {
  test("push modal states 'single box, no canary gate' and asks for the box name", () => {
    const s = state({
      modal: { actionLabel: "config-push", box: "grok-box-1", typed: "grok", field: "confirm", note: "single box, no canary gate", expect: "grok-box-1" },
    });
    const joined = modalLines(s).map((l) => l.text).join("\n");
    expect(joined).toContain("single box, no canary gate");
    expect(joined).toContain("type box name to confirm: grok");
    expect(joined).toContain('expect "grok-box-1"');
  });
  test("rename modal shows the new-name field", () => {
    const s = state({
      modal: { actionLabel: "rename", box: "grok-box-3", typed: "", target: "grok-box-003", field: "target", expect: "grok-box-3" },
    });
    expect(modalLines(s).map((l) => l.text).join("\n")).toContain("new name: grok-box-003");
  });
});

describe("detail pane sparkline + canary label", () => {
  test("canary label reflects none / THIS box / other", () => {
    const text = (s: ReturnType<typeof state>): string => detailLines(s).map((l) => l.text).join("\n");
    expect(text(state({ canary: null }))).toContain("canary: none");
    expect(text(state({ canary: "grok-box-1" }))).toContain("canary: THIS box");
  });
});

describe("the discover row (D7)", () => {
  test("absent when the snapshot has no discover summary", () => {
    expect(discoverText(state({ discover: null }), SIZE_120x40)).toBeUndefined();
    expect(discoverText(state({ discover: undefined }), SIZE_120x40)).toBeUndefined();
  });
  test("summarises candidates/adopted/repaired/skipped", () => {
    const line = discoverText(state({ discover: { candidates: 2, adopted: 1, repaired: 0, skipped: [] } }), SIZE_120x40)!;
    expect(line).toContain("discover: 2 candidates  1 adopted  0 repaired  0 skipped");
  });
});

describe("no ANSI escapes leave the model", () => {
  test("every text producer returns plain strings", () => {
    const s = state({
      boxes: [box("grok-box-1"), box("grok-box-2")],
      noColor: false, // even in COLOUR mode the model is plain
      canary: "grok-box-1",
      discover: { candidates: 1, adopted: 1, repaired: 0, skipped: [] },
      message: "hi",
      modal: { actionLabel: "check", box: "grok-box-1", typed: "", field: "confirm", expect: "grok-box-1" },
    });
    const all = [
      headerText(s, SIZE_120x40),
      bannerText(s, SIZE_120x40)?.text ?? "",
      discoverText(s, SIZE_120x40) ?? "",
      ...footerLines(s, SIZE_120x40),
      ...tableLines(s, SIZE_120x40).map((l) => l.text),
      ...detailLines(s).map((l) => l.text),
      ...modalLines(s).map((l) => l.text),
    ];
    for (const line of all) expect(line).not.toContain("\x1b");
  });
});
