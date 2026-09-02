// tone.ts — the ONLY place colour is decided (fleet-tui-ink D2).
//
// The model layer emits plain strings plus a semantic `Tone`; the components
// turn a Tone into Ink `<Text>` props here and nowhere else. With NO_COLOR set
// the result is `{}`, which is exactly what the old `sgr()` did when
// `state.noColor` was true — so a NO_COLOR frame carries no styling at all.

export type Tone = "ok" | "warn" | "down" | "dim" | "plain";

export interface ToneProps {
  color?: string;
  dimColor?: boolean;
}

export function toneProps(tone: Tone, noColor: boolean): ToneProps {
  if (noColor) return {};
  switch (tone) {
    case "ok":
      return { color: "green" };
    case "warn":
      return { color: "yellow" };
    case "down":
      return { color: "red" };
    case "dim":
      return { dimColor: true };
    case "plain":
      return {};
  }
}
