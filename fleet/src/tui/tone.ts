// tone.ts — the ONLY place colour is decided (fleet-tui-ink D2, fleet-tui-visual V1).
//
// The model layer emits plain strings plus a semantic `Tone`; the components
// turn a Tone into Ink `<Text>` props here and nowhere else. With NO_COLOR set
// the result is `{}`, which is exactly what the old `sgr()` did when
// `state.noColor` was true — so a NO_COLOR frame carries no styling at all.
//
// V1: ONE main colour, ONE accent, four semantic colours. Truecolor hex —
// Ink/chalk downgrades to 256/16 colours on its own, so there is no detection
// code here. `dim` is gone: `dimColor` renders as unreadable grey-on-grey on
// several dark themes, so the muted tone is a real colour instead.

/** Chrome: header bar, column headers, frame lines, key hints, `grokfleet`. */
export const MAIN = "#7aa2f7";
/** Interactive emphasis: key letters, the selected row, the canary star. */
export const ACCENT = "#bb9af7";
export const OK = "#9ece6a";
export const WARN = "#e0af68";
export const DOWN = "#f7768e";
export const MUTED = "#565f89";

/** The selected row's bar: a darker MAIN, never `inverse` (which flips every
 *  per-cell colour into an unreadable pair). */
export const SELECTION_BG = "#3d59a1";
export const SELECTION_FG = "#c0caf5";
/** The header bar's ground, so the top line reads as a bar and not as text. */
export const HEADER_BG = "#1f2335";

/** A banner's foreground when it is painted ON one of the semantic grounds. */
export const BANNER_LIGHT = "#ffffff";
export const BANNER_DARK = "#000000";

export type Tone = "ok" | "warn" | "down" | "muted" | "main" | "accent" | "plain";

export interface ToneProps {
  color?: string;
  backgroundColor?: string;
}

export function toneProps(tone: Tone, noColor: boolean): ToneProps {
  if (noColor) return {};
  switch (tone) {
    case "ok":
      return { color: OK };
    case "warn":
      return { color: WARN };
    case "down":
      return { color: DOWN };
    case "muted":
      return { color: MUTED };
    case "main":
      return { color: MAIN };
    case "accent":
      return { color: ACCENT };
    case "plain":
      return {};
  }
}

/** V7: a banner is a BAR — its semantic colour becomes the ground so it cannot
 *  be mistaken for one more line of text. */
export function bannerProps(tone: Tone, noColor: boolean): ToneProps {
  if (noColor) return {};
  switch (tone) {
    case "down":
      return { color: BANNER_LIGHT, backgroundColor: DOWN };
    case "warn":
      return { color: BANNER_DARK, backgroundColor: WARN };
    default:
      return toneProps(tone, noColor);
  }
}

/** V1: the selected row's props, applied to the WHOLE row. */
export function selectionProps(noColor: boolean): ToneProps {
  if (noColor) return {};
  return { color: SELECTION_FG, backgroundColor: SELECTION_BG };
}

/** V4: the header bar's ground. */
export function headerBarProps(noColor: boolean): ToneProps {
  if (noColor) return {};
  return { backgroundColor: HEADER_BG };
}
