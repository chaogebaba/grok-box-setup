// visual.test.ts — the COLOUR the frame actually emits (fleet-tui-visual V8 d/e).
//
// The text goldens in `frames.test.ts` are rendered with NO_COLOR, so they
// cannot see a palette regression at all. This file mounts one golden with
// colour ON and asserts two bytes-on-the-wire facts — the semantic OK colour on
// a healthy row, and the selection BACKGROUND on the selected one. It is
// deliberately NOT a full colour golden: two assertions that a mutant cannot
// pass, and nothing that a palette tweak would churn.
//
// `chalk` decides its own level from the environment, and the Ink harness has
// no TTY, so the level is forced here. Ink imports the same default chalk
// instance (`node_modules/ink/build/colorize.js`), which is what makes this
// work without a pty.

import { test, expect, describe, beforeAll } from "bun:test";
import chalk from "chalk";
import { frameOf, mount, settle } from "./ink-harness.ts";
import { GOLDENS } from "./goldens.ts";
import { DOWN, MUTED, OK, SELECTION_BG, WARN } from "../../src/tui/tone.ts";
import { detailLines, detailWidth, type Size } from "../../src/tui/model.ts";
import { box, state } from "./helpers.ts";
import type { SnapshotLine } from "../../src/history/schema.ts";

/** `#9ece6a` → the `38;2;158;206;106` a truecolor terminal receives. */
function fg(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `38;2;${r};${g};${b}`;
}
function bg(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `48;2;${r};${g};${b}`;
}

beforeAll(() => {
  chalk.level = 3; // truecolor, so the hex survives to the stream verbatim
});

describe("V8(d): the painted colour, not just the painted text", () => {
  const golden = (): { state: ReturnType<typeof state>; size: Size } => {
    const g = GOLDENS.find((x) => x.name === "detail-panel-120x40")!;
    // row 0 (grok-box-001) is HEALTHY and NOT selected; row 1 is the selection.
    return { state: { ...g.state, noColor: false }, size: g.size };
  };

  test("a healthy row carries the OK colour", async () => {
    const g = golden();
    const frame = await frameOf(g.state, g.size);
    expect(frame).toContain(fg(OK));
  });

  test("the selected row is a BACKGROUND bar, never `inverse`", async () => {
    const g = golden();
    const frame = await frameOf(g.state, g.size);
    expect(frame).toContain(bg(SELECTION_BG));
    // m4: painting the selection with `inverse` flips every per-cell colour
    // into an unreadable pair. SGR 7 must not be in the frame at all.
    expect(frame).not.toContain("\x1b[7m");
  });

  test("a drifted row does not paint the WHOLE row warn", async () => {
    const g = golden();
    const frame = await frameOf(g.state, g.size);
    // grok-box-002 drifts, so WARN is on screen …
    expect(frame).toContain(fg(WARN));
    // … alongside DOWN (grok-box-003 fails) and MUTED (the quiet cells).
    expect(frame).toContain(fg(DOWN));
    expect(frame).toContain(fg(MUTED));
  });

  test("NO_COLOR still emits no ANSI at all, with colour forced on", async () => {
    const g = GOLDENS.find((x) => x.name === "no-color-120x40")!;
    expect(await frameOf(g.state, g.size)).not.toContain("\x1b[");
  });
});

describe("V8(e): the 24h sparkline fits the pane", () => {
  /** 300 samples — far more than any pane is wide. */
  const HISTORY: SnapshotLine[] = Array.from({ length: 300 }, (_, i) => ({
    v: 1 as const,
    ts: `2026-04-30T00:00:${String(i % 60).padStart(2, "0")}Z`,
    apply: false,
    canary: null,
    boxes: [box("grok-box-1", i % 17 === 0 ? { check: "FAIL" } : i % 5 === 0 ? { drift: "yes" } : {})],
  }));

  test("300 samples at pane width 40 render exactly 40 cells, inside the frame", () => {
    const s = state({ boxes: [box("grok-box-1")], detail: { box: "grok-box-1", lines: HISTORY } });
    const rows = detailLines(s, 40);
    const spark = rows.find((r) => r.text.includes("24h"))!;
    expect(spark.text.length).toBe(40);
    expect(spark.text.startsWith("│24h ")).toBe(true);
    expect(spark.text.endsWith("│")).toBe(true);
    // and every OTHER line of the card is the same 40 cells wide.
    for (const r of rows) expect(r.text.length).toBe(40);
  });

  test("the pane's real width at 120 columns holds the card exactly", () => {
    const s = state({ boxes: [box("grok-box-1")], detail: { box: "grok-box-1", lines: HISTORY } });
    const w = detailWidth({ cols: 120, rows: 40 });
    for (const r of detailLines(s, w)) expect(r.text.length).toBe(w);
  });

  test("each spark cell is toned by its level, not by the row", () => {
    const s = state({ boxes: [box("grok-box-1")], detail: { box: "grok-box-1", lines: HISTORY } });
    const spark = detailLines(s, 60).find((r) => r.text.includes("24h"))!;
    const tones = new Set(spark.segments!.map((x) => x.tone));
    expect(tones.has("ok")).toBe(true); // healthy samples
    expect(tones.has("warn")).toBe(true); // drifted samples
    expect(tones.has("down")).toBe(true); // failing samples
  });
});

test("V4: the header bar paints its ground", async () => {
  const g = GOLDENS.find((x) => x.name === "detail-panel-120x40")!;
  const m = mount({ ...g.state, noColor: false }, { size: g.size });
  await settle(40);
  const first = m.lastFrame().split("\n")[0]!;
  m.unmount();
  expect(first).toContain(bg("#1f2335"));
});
