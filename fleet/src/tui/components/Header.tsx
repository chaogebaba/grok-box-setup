// Header.tsx — one line: the fleet counters, apply reading, tick age, scope and
// link state, read left→right as identity, health, mode, link (V4). The whole
// row sits on HEADER_BG so it reads as a BAR and not as one more text line.
// Thin: the text, the widths and the tones are the model's job.

import React from "react";
import { Box, Text } from "ink";
import { headerSegments, type Size } from "../model.ts";
import { headerBarProps, toneProps } from "../tone.ts";
import type { TuiState } from "../state.ts";

export default function Header({ state, size }: { state: TuiState; size: Size }): React.ReactElement {
  const noColor = state.noColor;
  const bar = headerBarProps(noColor);
  return (
    <Box flexShrink={0} height={1}>
      {headerSegments(state, size).map((s, i) => (
        <Text key={i} {...bar} {...toneProps(s.tone, noColor)} bold={!noColor && s.bold === true} wrap="truncate">
          {s.text}
        </Text>
      ))}
    </Box>
  );
}
