// tone.test.ts — the palette and the glyph set (fleet-tui-visual V8 a/b).
//
// V1 says colour is decided in ONE place and named ONCE. This file pins that:
// every Tone maps to its named constant and nothing else, NO_COLOR erases every
// prop, and the V2 glyph set is measured with `string-width` so a future glyph
// that renders as a width-2 cell (any emoji) fails here rather than silently
// shearing every column in the table.

import { test, expect, describe } from "bun:test";
import stringWidth from "string-width";
import {
  ACCENT,
  BANNER_DARK,
  BANNER_LIGHT,
  DOWN,
  HEADER_BG,
  MAIN,
  MUTED,
  OK,
  SELECTION_BG,
  SELECTION_FG,
  WARN,
  bannerProps,
  headerBarProps,
  selectionProps,
  toneProps,
  type Tone,
} from "../../src/tui/tone.ts";
import { GLYPH } from "../../src/tui/model.ts";

const ALL_TONES: Tone[] = ["ok", "warn", "down", "muted", "main", "accent", "plain"];

describe("V1 palette", () => {
  test("each tone maps to its named constant", () => {
    expect(toneProps("ok", false)).toEqual({ color: OK });
    expect(toneProps("warn", false)).toEqual({ color: WARN });
    expect(toneProps("down", false)).toEqual({ color: DOWN });
    expect(toneProps("muted", false)).toEqual({ color: MUTED });
    expect(toneProps("main", false)).toEqual({ color: MAIN });
    expect(toneProps("accent", false)).toEqual({ color: ACCENT });
    expect(toneProps("plain", false)).toEqual({});
  });

  test("the palette is one main, one accent and four semantic colours, all distinct", () => {
    const all = [MAIN, ACCENT, OK, WARN, DOWN, MUTED];
    expect(new Set(all).size).toBe(all.length);
    for (const c of [...all, SELECTION_BG, SELECTION_FG, HEADER_BG]) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("NO_COLOR erases EVERY prop, for every tone and every helper", () => {
    for (const t of ALL_TONES) {
      expect(toneProps(t, true)).toEqual({});
      expect(bannerProps(t, true)).toEqual({});
    }
    expect(selectionProps(true)).toEqual({});
    expect(headerBarProps(true)).toEqual({});
  });

  test("`dim` is gone: no tone renders with dimColor", () => {
    for (const t of ALL_TONES) expect(Object.keys(toneProps(t, false))).not.toContain("dimColor");
  });

  test("V7: a banner paints its semantic colour as the GROUND", () => {
    expect(bannerProps("down", false)).toEqual({ color: BANNER_LIGHT, backgroundColor: DOWN });
    expect(bannerProps("warn", false)).toEqual({ color: BANNER_DARK, backgroundColor: WARN });
  });

  test("V1: the selected row is a darker-MAIN bar, never `inverse`", () => {
    expect(selectionProps(false)).toEqual({ color: SELECTION_FG, backgroundColor: SELECTION_BG });
    expect(headerBarProps(false)).toEqual({ backgroundColor: HEADER_BG });
  });
});

describe("V2 glyphs", () => {
  test("every status glyph is exactly one cell wide", () => {
    for (const [name, g] of Object.entries(GLYPH)) {
      expect(`${name}:${stringWidth(g)}`).toBe(`${name}:1`);
      expect([...g].length).toBe(1);
    }
  });

  test("the frame, separator and sparkline glyphs are one cell wide too", () => {
    for (const g of ["╭", "╮", "╰", "╯", "─", "│", "·", "↑", "↓", "—", "…", ...("▁▂▃▄▅▆▇█")]) {
      expect(`${g}:${stringWidth(g)}`).toBe(`${g}:1`);
    }
  });

  test("no glyph is an emoji (a width-2 cell would shear the table)", () => {
    for (const g of Object.values(GLYPH)) expect(/\p{Emoji_Presentation}|️/u.test(g)).toBe(false);
  });

  test("`!` is no longer a health glyph — degraded is ◆", () => {
    expect(Object.values(GLYPH)).not.toContain("!");
    expect(GLYPH.degraded).toBe("◆");
    expect(GLYPH.asleep).toBe("☾");
  });
});
