// model.test.ts — the presentation model (fleet-tui-ink D1).
//
// These are the assertions that lived in render.test.ts, moved with the
// painters they cover. The only edits are the ones the port forced: `sgr()` is
// gone so the strings are plain, and `boxGlyph` became `boxHealth`, which
// returns a glyph AND a semantic tone instead of a coloured string.

import { test, expect, describe } from "bun:test";
import {
  GLYPH,
  bannerText,
  boxHealth,
  cellTones,
  counts,
  detailLines,
  detailWidth,
  discoverText,
  expiryTone,
  footerLines,
  headerText,
  messageTone,
  modalLines,
  segText,
  tableLines,
} from "../../src/tui/model.ts";
import { MUTED, toneProps } from "../../src/tui/tone.ts";
import { box, state, SIZE_80x24, SIZE_120x40 } from "./helpers.ts";

const DETAIL_W = detailWidth(SIZE_120x40);
const detailText = (s: ReturnType<typeof state>): string =>
  detailLines(s, DETAIL_W).map((l) => l.text).join("\n");

// R2: the header's apply reading must say when it could be STALE. `apply` is
// read live from the config per request; when that read fails the serve falls
// back to the (possibly 34h-old) snapshot value and marks it.
describe("header apply reading (R2 live-vs-fallback, V4 spacing)", () => {
  const applyOf = (s: string): string | undefined => /apply \S+/.exec(s)?.[0];
  test("a LIVE reading is unqualified", () => {
    expect(applyOf(headerText(state({ apply: true, applySource: "config" }), SIZE_120x40))).toBe("apply ON");
    expect(applyOf(headerText(state({ apply: false, applySource: "config" }), SIZE_120x40))).toBe("apply off");
  });
  test("a value that FELL BACK to the snapshot is suffixed with ?", () => {
    expect(applyOf(headerText(state({ apply: true, applySource: "snapshot" }), SIZE_120x40))).toBe("apply ON?");
    expect(applyOf(headerText(state({ apply: false, applySource: "snapshot" }), SIZE_120x40))).toBe("apply off?");
  });
  test("an unknown apply stays apply=? regardless of source", () => {
    expect(applyOf(headerText(state({ apply: null, applySource: "config" }), SIZE_120x40))).toBe("apply ?");
    expect(applyOf(headerText(state({ apply: null, applySource: "snapshot" }), SIZE_120x40))).toBe("apply ?");
  });
});

describe("box health (all states, V2 glyphs)", () => {
  const s = state({ noColor: true });
  test("healthy ● / asleep ☾ (muted, not error) / incident ✖ / degraded ◆ / unknown ○", () => {
    expect(boxHealth(s, box("b", { tunnel: "up", check: "OK" }))).toEqual({ glyph: "●", tone: "ok" });
    expect(boxHealth(s, box("b", { asleep: true }))).toEqual({ glyph: "☾", tone: "muted" });
    expect(boxHealth(s, box("b", { check: "FAIL" }))).toEqual({ glyph: "✖", tone: "down" });
    expect(boxHealth(s, box("b", { checkfail: true }))).toEqual({ glyph: "◆", tone: "warn" });
    expect(boxHealth(s, box("b", { drift: "yes" }))).toEqual({ glyph: "◆", tone: "warn" });
    expect(boxHealth(s, box("b", { config: "drift" }))).toEqual({ glyph: "◆", tone: "warn" });
    expect(boxHealth(s, box("b", { tunnel: "down", check: "-" }))).toEqual({ glyph: "○", tone: "muted" });
  });

  // The mutant the user's complaint names directly: `!` reads as an ERROR while
  // it means "needs attention". No health state may paint it again.
  test("no state produces `!` — the degraded glyph is ◆", () => {
    const every = [
      box("b", { tunnel: "up", check: "OK" }),
      box("b", { asleep: true }),
      box("b", { check: "FAIL" }),
      box("b", { checkfail: true }),
      box("b", { drift: "yes" }),
      box("b", { config: "drift" }),
      box("b", { tunnel: "down", check: "-" }),
      box("b", { tunnel: "-", check: "-", drift: "unknown", config: null }),
    ];
    expect(every.length).toBe(8); // the V8(c) table: eight states, one row each
    for (const b of every) expect(boxHealth(s, b).glyph).not.toBe("!");
    for (const b of every) expect(Object.values(GLYPH)).toContain(boxHealth(s, b).glyph);
  });

  test("asleep takes precedence and is NOT an error glyph or an error colour", () => {
    const h = boxHealth(s, box("b", { asleep: true, checkfail: true, check: "FAIL" }));
    expect(h.glyph).toBe("☾");
    expect(h.tone).toBe("muted");
    expect(toneProps(h.tone, false)).toEqual({ color: MUTED });
  });
});

// --- V3: every cell carries its own meaning ----------------------------------
describe("V3 cell tones", () => {
  test("TUNNEL: up OK, down DOWN, anything else MUTED", () => {
    expect(cellTones(box("b", { tunnel: "up" })).tunnel).toBe("ok");
    expect(cellTones(box("b", { tunnel: "down" })).tunnel).toBe("down");
    expect(cellTones(box("b", { tunnel: "-" })).tunnel).toBe("muted");
  });
  test("CHECK: OK ok, FAIL down, anything else MUTED", () => {
    expect(cellTones(box("b", { check: "OK" })).check).toBe("ok");
    expect(cellTones(box("b", { check: "FAIL" })).check).toBe("down");
    expect(cellTones(box("b", { check: "-" })).check).toBe("muted");
  });
  test("VER is plain until it DRIFTS — then the version to be replaced glows", () => {
    expect(cellTones(box("b", { drift: "no" })).ver).toBe("plain");
    expect(cellTones(box("b", { drift: "unknown" })).ver).toBe("plain");
    expect(cellTones(box("b", { drift: "yes" })).ver).toBe("warn");
  });
  test("DRIFT: yes WARN, no/unknown MUTED", () => {
    expect(cellTones(box("b", { drift: "yes" })).drift).toBe("warn");
    expect(cellTones(box("b", { drift: "no" })).drift).toBe("muted");
    expect(cellTones(box("b", { drift: "unknown" })).drift).toBe("muted");
  });
  test("CONFIG: quiet is the goal state — in-sync and skip MUTED, drift WARN", () => {
    expect(cellTones(box("b", { config: "in-sync" })).config).toBe("muted");
    expect(cellTones(box("b", { config: "skip" })).config).toBe("muted");
    expect(cellTones(box("b", { config: null })).config).toBe("muted");
    expect(cellTones(box("b", { config: "drift" })).config).toBe("warn");
  });
  // The boundary is decide.ts's rotate threshold: a week or less is an incident.
  test("EXPIRY boundaries 7 / 8 / 30 / 31", () => {
    expect(expiryTone(7)).toBe("down");
    expect(expiryTone(8)).toBe("warn");
    expect(expiryTone(30)).toBe("warn");
    expect(expiryTone(31)).toBe("muted");
    expect(expiryTone(0)).toBe("down");
    expect(expiryTone(null)).toBe("muted");
    expect(expiryTone(undefined)).toBe("muted");
  });
  test("a degraded box does NOT paint its whole row warn", () => {
    const s = state({ boxes: [box("grok-box-1", { drift: "yes" })], noColor: false });
    const row = tableLines(s, SIZE_120x40)[1]!;
    expect(row.tone).toBe("warn"); // the row's health…
    const tones = row.segments!.map((x) => x.tone);
    expect(tones).toContain("ok"); // …but the healthy tunnel/check cells stay OK
    expect(tones).toContain("muted"); // …and the quiet cells stay muted
  });
});

describe("V6 messageTone", () => {
  test("an ok/done message is OK, an error/failure is DOWN, anything else plain", () => {
    expect(messageTone("ok: pushed")).toBe("ok");
    expect(messageTone("done")).toBe("ok");
    expect(messageTone("check grok-box-1 → rc=0")).toBe("plain");
    expect(messageTone("config-push grok-box-1 failed: 500")).toBe("down");
    expect(messageTone("reconcile error")).toBe("down");
    // a failure wins over a leading "ok" — the loud reading is the safe one.
    expect(messageTone("ok, but the push failed")).toBe("down");
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
  test("canary C column present ONLY when snapshot canary is non-null; the row cell is ★", () => {
    const rows = texts(state({ canary: "grok-box-1", boxes: [box("grok-box-1")] }));
    expect(rows[0]).toContain("C"); // the column HEADER stays the letter C
    expect(rows[1]!.trimEnd().endsWith("★")).toBe(true);
    expect(texts(state({ canary: null, boxes: [box("grok-box-1")] }))[0]!.trimEnd().endsWith("C")).toBe(false);
  });
  test("null/missing per-box fields render '-'", () => {
    const rows = texts(state({ boxes: [box("grok-box-1", { ver: "-", drift: "unknown", config: null, expiry_days: null })] }));
    expect(rows.find((r) => r.includes("grok-box-1"))).toContain("-");
  });
  test("NO_COLOR selection marked with a leading '>'; in colour it is a bar", () => {
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

describe("detail pane canary label (V5)", () => {
  test("canary label reflects none / THIS box / other", () => {
    expect(detailText(state({ canary: null }))).toContain("canary none");
    expect(detailText(state({ canary: "grok-box-1" }))).toContain(`canary ${GLYPH.canary} this box`);
    expect(detailText(state({ canary: "grok-box-9" }))).toContain("canary grok-box-9");
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
      ...detailLines(s, DETAIL_W).map((l) => l.text),
      ...modalLines(s).map((l) => l.text),
    ];
    for (const line of all) expect(line).not.toContain("\x1b");
  });
});

// The whole segment scheme rests on this: a line's plain `text` — what every
// fixture compares — is EXACTLY the concatenation of the segments the component
// paints. If the two ever drift, a golden can pass while the screen is wrong.
describe("segments and text never drift apart", () => {
  test("every segmented line's text is the join of its segments", () => {
    const s = state({
      boxes: [box("grok-box-1"), box("grok-box-2", { drift: "yes" }), box("grok-box-3", { asleep: true })],
      selected: 1,
      noColor: false,
      canary: "grok-box-1",
      discover: { candidates: 1, adopted: 1, repaired: 0, skipped: [] },
    });
    const lines = [...tableLines(s, SIZE_120x40), ...detailLines(s, DETAIL_W)];
    for (const l of lines) {
      if (l.segments === undefined) continue;
      expect(segText(l.segments)).toBe(l.text);
    }
  });
});
