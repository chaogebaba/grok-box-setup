// views.test.ts — 5.7.0 lane: the D1 detail rows, the D2/D3/D4 view frames, the
// D5 footer re-layout and the D5b viewport. Every assertion is on a PURE render
// function, so the whole file is TTY-free.

import { test, expect, describe } from "bun:test";
import {
  detailLines,
  footerLines,
  viewLines,
  viewContent,
  viewChromeRows,
  viewRowsAvailable,
  viewportWindow,
  historyRows,
  HISTORY_MAX_ROWS,
  type Size,
} from "../../src/tui/model.ts";
import type { TuiState, ViewState } from "../../src/tui/state.ts";
import { frameOf } from "./ink-harness.ts";

/** The model's rows as plain text (the old painters returned strings). */
const renderDetail = (s: TuiState, _size: Size): string[] => detailLines(s).map((l) => l.text);
const renderFooter = (s: TuiState, size: Size): string[] => footerLines(s, size);
const renderView = (s: TuiState, size: Size): string[] => viewLines(s, size).map((l) => l.text);
import type { SnapshotLine } from "../../src/history/schema.ts";
import type { BoxDetail } from "../../src/tui/api-client.ts";
import { box, state, SIZE_120x40 } from "./helpers.ts";

const SIZE_100x24 = { cols: 100, rows: 24 };
const SIZE_140x40 = { cols: 140, rows: 40 };

const FACTS: BoxDetail = {
  name: "grok-box-1",
  checkfail_count: 3,
  asleep_since: "2026-03-20T09:46:40Z",
  asleep_last: "2026-03-20T10:46:40Z",
  expires_at: "2026-06-01",
  api_backoff: { fails: 2, next_retry: "2026-03-20T12:33:20Z" },
};

/** A snapshot line carrying one box, for the history view. */
function line(ts: string, over: Partial<SnapshotLine["boxes"][0]> = {}, apply = false): SnapshotLine {
  return { v: 1, ts, apply, canary: null, boxes: [box("grok-box-1", over)] };
}

// --- D1: the detail pane rows ------------------------------------------------
describe("D1 detail pane rows", () => {
  test("all five facts render as labelled rows", () => {
    const s = state({ detailFacts: { box: "grok-box-1", facts: FACTS } });
    const pane = renderDetail(s, SIZE_120x40).join("\n");
    expect(pane).toContain("checkfail#: 3");
    expect(pane).toContain("expires: 2026-06-01");
    expect(pane).toContain("asleep since: 2026-03-20T09:46:40Z");
    expect(pane).toContain("asleep last: 2026-03-20T10:46:40Z");
    expect(pane).toContain("api backoff: 2 fails, retry 2026-03-20T12:33:20Z");
  });

  // Acceptance 1's older-engine half: a 5.6.0 API omits every field.
  test("a 5.6.0 engine's answer (all fields absent) renders — on every row", () => {
    const older: BoxDetail = {
      name: "grok-box-1",
      checkfail_count: null,
      asleep_since: null,
      asleep_last: null,
      expires_at: null,
      api_backoff: null,
    };
    const pane = renderDetail(state({ detailFacts: { box: "grok-box-1", facts: older } }), SIZE_120x40).join("\n");
    expect(pane).toContain("checkfail#: —");
    expect(pane).toContain("expires: —");
    expect(pane).toContain("asleep since: —");
    expect(pane).toContain("asleep last: —");
    expect(pane).toContain("api backoff: —");
  });

  test("with NO facts loaded at all the rows still render, as —", () => {
    const pane = renderDetail(state({ detailFacts: undefined }), SIZE_120x40).join("\n");
    expect(pane).toContain("checkfail#: —");
    expect(pane).toContain("api backoff: —");
  });

  // B4's in-flight rule, and the mutant "detail fields rendered without the
  // box-name match": facts fetched for box A must never appear under box B.
  test("facts stored for ANOTHER box render — , never that box's numbers", () => {
    const s = state({
      boxes: [box("grok-box-1"), box("grok-box-2")],
      selected: 1, // grok-box-2 selected …
      detailFacts: { box: "grok-box-1", facts: FACTS }, // … facts are box-1's
    });
    const pane = renderDetail(s, SIZE_120x40).join("\n");
    expect(pane).toContain("── grok-box-2");
    expect(pane).toContain("checkfail#: —");
    expect(pane).not.toContain("checkfail#: 3");
    expect(pane).not.toContain("2026-06-01");
  });

  // the ledger's "detail fields shown from the FLEET LINE instead of the box
  // endpoint" mutant: the snapshot row says checkfail, the endpoint says the
  // count is 0, and the count row must follow the ENDPOINT.
  test("the count comes from the box endpoint, NOT from the fleet line's boolean", () => {
    const facts: BoxDetail = { ...FACTS, checkfail_count: 0 };
    const s = state({
      boxes: [box("grok-box-1", { checkfail: true, asleep: true, expiry_days: 7 })],
      detailFacts: { box: "grok-box-1", facts },
    });
    const pane = renderDetail(s, SIZE_120x40).join("\n");
    expect(pane).toContain("checkfail: yes"); // the fleet line's boolean, unchanged
    expect(pane).toContain("checkfail#: 0"); // the endpoint's count, which differs
    expect(pane).toContain("expires: 2026-06-01"); // the endpoint's date, not 7d
  });

  test("SNAPSHOT: the pane during an in-flight switch shows no stale numbers", () => {
    const s = state({
      boxes: [box("grok-box-1"), box("grok-box-2")],
      selected: 1,
      detailFacts: { box: "grok-box-1", facts: FACTS },
    });
    expect(renderDetail(s, SIZE_120x40).join("\n")).toBe(
      [
        "── grok-box-2 ─────",
        "tunnel: up   check: OK   ver: 5.3.0",
        "drift: no   config: in-sync   expiry: 40d",
        "checkfail: no   asleep: no",
        "canary: none",
        "checkfail#: —   expires: —",
        "asleep since: —",
        "asleep last: —",
        "api backoff: —",
        "24h: (loading…)",
      ].join("\n"),
    );
  });
});

// --- D5: the footer ----------------------------------------------------------
describe("D5 footer re-layout", () => {
  test("SNAPSHOT at 100 cols: two lines, navigation+views then actions", () => {
    const f = renderFooter(state({ scope: "admin" }), SIZE_100x24);
    expect(f.length).toBe(2);
    expect(f[0]!.trimEnd()).toBe("↑/↓ select  / filter  r refresh  q quit  D diff  J journal  H history");
    expect(f[1]!.trimEnd()).toBe("P push  M rotate  R rename  T check  C reconcile");
  });
  test("SNAPSHOT at 140 cols: one line carrying every key", () => {
    const f = renderFooter(state({ scope: "admin" }), SIZE_140x40);
    expect(f.length).toBe(1);
    expect(f[0]!.trimEnd()).toBe(
      "↑/↓ select  / filter  r refresh  q quit  D diff  J journal  H history  P push  M rotate  R rename  T check  C reconcile",
    );
  });
  test("no key falls off at >= 100 cols, at any width and either scope", () => {
    const keys = ["↑/↓", "/ filter", "r refresh", "q quit", "D diff", "J journal", "H history", "P push", "M rotate", "R rename", "T check", "C reconcile"];
    for (const cols of [100, 110, 119, 120, 121, 130, 140, 200]) {
      for (const scope of ["admin", "readonly"] as const) {
        const joined = renderFooter(state({ scope }), { cols, rows: 40 }).join("\n");
        for (const k of keys) expect(joined).toContain(k);
      }
    }
  });
  test("every footer line is padded to exactly the width", () => {
    for (const line of renderFooter(state(), SIZE_100x24)) expect(line.length).toBe(100);
  });
});

// --- D5b: the viewport -------------------------------------------------------
describe("D5b viewport", () => {
  test("the window is [offset, offset+rows) and the offset clamps to the end", () => {
    expect(viewportWindow(100, 0, 10)).toEqual({ start: 0, end: 10, offset: 0 });
    expect(viewportWindow(100, 50, 10)).toEqual({ start: 50, end: 60, offset: 50 });
    // past the end ⇒ clamped to total − rows.
    expect(viewportWindow(100, 999, 10)).toEqual({ start: 90, end: 100, offset: 90 });
    // negative ⇒ clamped to 0.
    expect(viewportWindow(100, -5, 10)).toEqual({ start: 0, end: 10, offset: 0 });
    // content shorter than the window ⇒ no scroll at all.
    expect(viewportWindow(3, 7, 10)).toEqual({ start: 0, end: 3, offset: 0 });
  });

  // gate note 1: the blank SPACERS and the message line are chrome too.
  test("the chrome count includes the spacers, the message line and BOTH footer lines", () => {
    const base = state({ view: { kind: "diff", box: "grok-box-1", offset: 0, loading: false, lines: ["x"] } });
    // 100 cols ⇒ two footer lines: header + spacer + title + spacer + 2 footer.
    expect(viewChromeRows(base, SIZE_100x24)).toBe(6);
    // a message adds its own spacer AND the line.
    expect(viewChromeRows({ ...base, message: "hi" }, SIZE_100x24)).toBe(8);
    // a banner adds one more row above.
    const banner: TuiState = { ...base, link: { up: false, sinceMs: 0 }, nowMs: 1000 };
    expect(viewChromeRows(banner, SIZE_100x24)).toBe(7);
    // 140 cols ⇒ ONE footer line.
    expect(viewChromeRows(base, SIZE_140x40)).toBe(5);
  });

  test("SNAPSHOT at 24 rows × 100 cols: the window fits and the FOOTER IS LAST", async () => {
    const content = Array.from({ length: 200 }, (_, i) => `diff line ${i}`);
    const s = state({ view: { kind: "diff", box: "grok-box-1", offset: 0, loading: false, lines: content } });
    const frame = (await frameOf(s, SIZE_100x24)).split("\n");
    // the frame occupies EXACTLY the terminal: chrome + the painted window.
    expect(frame.length).toBe(24);
    expect(frame[frame.length - 1]).toContain("P push"); // footer still last
    expect(frame[frame.length - 2]).toContain("D diff"); // …and its first line
    // the indicator sits in the title.
    expect(frame.find((l) => l.includes("── diff grok-box-1"))).toContain(`rows 1–${viewRowsAvailable(s, SIZE_100x24)} of 200`);
    // only the window is painted: the last content row is not line 199.
    expect(frame.join("\n")).not.toContain("diff line 199");
  });

  // the ledger's D5b mutant: render ALL rows instead of the window.
  test("a 200-row view never paints more rows than the terminal has", async () => {
    const content = Array.from({ length: 200 }, (_, i) => `L${i}`);
    const s = state({ view: { kind: "diff", box: "grok-box-1", offset: 0, loading: false, lines: content } });
    expect((await frameOf(s, SIZE_100x24)).split("\n").length).toBeLessThanOrEqual(24);
  });

  test("scrolled to the end, the window clamps and the last row is the last row", () => {
    const content = Array.from({ length: 50 }, (_, i) => `L${i}`);
    const s = state({ view: { kind: "diff", box: "grok-box-1", offset: 9999, loading: false, lines: content } });
    const rows = renderView(s, SIZE_100x24);
    expect(rows[rows.length - 1]).toContain("L49");
    expect(rows[0]).toContain("of 50");
  });

  test("a resize shrinks the window and the offset RE-clamps to the new end", async () => {
    const content = Array.from({ length: 50 }, (_, i) => `L${i}`);
    // an offset past the end at BOTH sizes, so both frames must clamp it.
    const s = state({ view: { kind: "diff", box: "grok-box-1", offset: 48, loading: false, lines: content } });
    const tall = (await frameOf(s, { cols: 100, rows: 40 })).split("\n");
    const short = (await frameOf(s, { cols: 100, rows: 12 })).split("\n");
    expect(tall.length).toBe(40);
    expect(short.length).toBe(12);
    // the last content row is L49 at BOTH sizes: the offset never runs off.
    expect(tall.join("\n")).toContain("L49");
    expect(short.join("\n")).toContain("L49");
    // and the SHRUNK frame starts further down, because its window is smaller.
    expect(tall.join("\n")).toContain("rows 17–50 of 50");
    expect(short.join("\n")).toContain("rows 45–50 of 50");
  });
});

// --- D2 / D3 / D4: the view frames -------------------------------------------
describe("D2 diff view", () => {
  test("the diff body is rendered under a title naming the CAPTURED box", () => {
    const s = state({ view: { kind: "diff", box: "grok-box-2", offset: 0, loading: false, lines: ["--- a", "+++ b"] } });
    const rows = renderView(s, SIZE_120x40);
    expect(rows[0]).toContain("── diff grok-box-2");
    expect(rows.join("\n")).toContain("--- a");
  });
  test("an EMPTY diff renders `in sync`, not an empty screen", () => {
    const s = state({ view: { kind: "diff", box: "grok-box-1", offset: 0, loading: false, lines: [] } });
    expect(viewContent(s)).toEqual(["in sync"]);
  });
  test("a client link error renders `link error` in the view frame", () => {
    const s = state({ view: { kind: "diff", box: "grok-box-1", offset: 0, loading: false, error: "link error" } });
    expect(viewContent(s)).toEqual(["link error"]);
  });
});

describe("D3 journal view", () => {
  test("journal lines render in the same frame", () => {
    const s = state({ view: { kind: "journal", box: "grok-box-1", offset: 0, loading: false, lines: ["unit started"] } });
    const rows = renderView(s, SIZE_120x40);
    expect(rows[0]).toContain("── journal grok-box-1");
    expect(rows.join("\n")).toContain("unit started");
  });
  // the ledger's "drop the 403 handling" mutant.
  test("a readonly token's 403 is words in the frame, not a crash", async () => {
    const s = state({
      scope: "readonly",
      view: { kind: "journal", box: "grok-box-1", offset: 0, loading: false, error: "journal: admin token required" },
    });
    expect(viewContent(s)).toEqual(["journal: admin token required"]);
    expect(await frameOf(s, SIZE_120x40)).toContain("journal: admin token required");
  });
});

describe("D4 history view", () => {
  const LINES = [line("2026-05-01T03:00:00Z"), line("2026-05-01T02:00:00Z"), line("2026-05-01T01:00:00Z")];
  test("one row per snapshot line, NEWEST FIRST, with the D4 columns", () => {
    const rows = historyRows(LINES, "grok-box-1");
    expect(rows[0]).toContain("TS");
    expect(rows[0]).toContain("APPLY");
    expect(rows[1]).toContain("2026-05-01T03:00:00Z"); // newest first
    expect(rows[3]).toContain("2026-05-01T01:00:00Z");
    expect(rows[1]).toContain("up"); // tunnel
    expect(rows[1]).toContain("OK"); // check
  });
  // the ledger's "history not newest-first" mutant.
  test("the newest ts is the FIRST data row, never the last", () => {
    const rows = historyRows(LINES, "grok-box-1").slice(1);
    expect(rows[0]!.startsWith("2026-05-01T03:00:00Z")).toBe(true);
    expect(rows[rows.length - 1]!.startsWith("2026-05-01T01:00:00Z")).toBe(true);
  });
  // gate note 7: the 288 cap keeps the NEWEST rows.
  test("the 288-row cap keeps the NEWEST rows and drops the oldest", () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      line(`2026-05-01T${String(23 - Math.floor(i / 20)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`),
    );
    const rows = historyRows(many, "grok-box-1");
    expect(rows.length).toBe(HISTORY_MAX_ROWS + 1); // +1 header
    expect(rows[1]).toContain(many[0]!.ts); // the newest survived
    expect(rows.join("\n")).not.toContain(many[399]!.ts); // the oldest did not
  });
  test("no apply_source column — a snapshot line records `apply` only (B2)", () => {
    expect(historyRows(LINES, "grok-box-1")[0]).not.toContain("SOURCE");
  });
  test("an empty history says so rather than painting a blank frame", () => {
    const s = state({ view: { kind: "history", box: "grok-box-1", offset: 0, loading: false, history: [] } });
    expect(viewContent(s)).toEqual(["(no history in the last 24h)"]);
  });
  test("the apply column reflects each line's own apply flag", () => {
    const mixed = [line("2026-05-01T02:00:00Z", {}, true), line("2026-05-01T01:00:00Z", {}, false)];
    const rows = historyRows(mixed, "grok-box-1");
    expect(rows[1]!.trimEnd().endsWith("yes")).toBe(true);
    expect(rows[2]!.trimEnd().endsWith("no")).toBe(true);
  });
});

// --- the view frame vs. the table + banners ----------------------------------
describe("an open view replaces the table, under the banners", () => {
  const view: ViewState = { kind: "diff", box: "grok-box-1", offset: 0, loading: false, lines: ["--- a"] };
  test("the box table and the ZTJ discover row are BOTH suppressed", async () => {
    const s = state({
      boxes: [box("grok-box-1"), box("grok-box-2")],
      discover: { candidates: 2, adopted: 1, repaired: 0, skipped: [] },
      view,
    });
    const frame = await frameOf(s, SIZE_120x40);
    expect(frame).toContain("── diff grok-box-1");
    expect(frame).not.toContain("TUNNEL"); // the table header is gone
    expect(frame).not.toContain("discover:"); // and so is the discover row
    expect(frame).not.toContain("grok-box-2");
  });
  test("LINK DOWN still renders ABOVE the view (existing precedence)", async () => {
    const s = state({ view, link: { up: false, sinceMs: Date.parse("2026-05-01T00:00:00Z") }, nowMs: Date.parse("2026-05-01T00:00:45Z") });
    const frame = (await frameOf(s, SIZE_120x40)).split("\n");
    expect(frame[0]).toContain("fleet2"); // header
    expect(frame[1]).toContain("LINK DOWN 45s"); // banner, still first
    expect(frame.join("\n")).toContain("── diff grok-box-1");
  });
  test("STALE still renders above the view too", async () => {
    const s = state({ view, tickAgeS: 16 * 60, link: { up: true } });
    expect((await frameOf(s, SIZE_120x40)).split("\n")[1]).toContain("STALE");
  });
  test("the header keeps ticking while a view is open (Acceptance 3)", async () => {
    const s = state({ view, tickAgeS: 42 });
    expect((await frameOf(s, SIZE_120x40)).split("\n")[0]).toContain("tick=42s");
  });
});
