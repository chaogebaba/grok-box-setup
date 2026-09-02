// Segments.tsx — the shared painter for a line the model cut into per-cell
// pieces (fleet-tui-visual V3). One <Text> per segment inside one row Box, so a
// drifted VER can glow without painting the whole row yellow.
//
// `override` is how the selected row becomes a BAR: V1 paints the whole row in
// SELECTION_FG on SELECTION_BG, so the per-cell tones are deliberately dropped
// for that one row rather than fighting the background.

import React from "react";
import { Box, Text } from "ink";
import { toneProps, type ToneProps } from "../tone.ts";
import type { Seg } from "../model.ts";

export default function Segments({
  segments,
  noColor,
  override,
  bold,
}: {
  segments: Seg[];
  noColor: boolean;
  override?: ToneProps;
  bold?: boolean;
}): React.ReactElement {
  return (
    <Box flexShrink={0} height={1}>
      {segments.map((s, i) => (
        <Text
          key={i}
          {...(override !== undefined ? override : toneProps(s.tone, noColor))}
          bold={!noColor && (bold === true || s.bold === true)}
          wrap="truncate"
        >
          {s.text}
        </Text>
      ))}
    </Box>
  );
}
