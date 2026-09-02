// Detail.tsx — THIN: one <Text> row per line the model produced, painted from
// the card's segments (V5: MAIN frame, MUTED labels, semantic values).
//
// The pane has a FIXED height of DETAIL_ROWS lines, and `layout.ts` budgets
// against that constant: below it the pane is omitted entirely rather than
// clipped mid-way. The chrome-agreement test pins the two together.

import React from "react";
import { Box, Text } from "ink";
import Segments from "./Segments.tsx";
import { toneProps } from "../tone.ts";
import type { DetailLine } from "../model.ts";

export default function Detail({ lines, noColor }: { lines: DetailLine[]; noColor: boolean }): React.ReactElement {
  return (
    <Box flexShrink={0} flexDirection="column">
      {lines.map((line, i) =>
        line.segments !== undefined ? (
          <Segments key={i} segments={line.segments} noColor={noColor} />
        ) : (
          <Box key={i} flexShrink={0} height={1}>
            <Text {...toneProps(line.tone, noColor)} bold={line.bold === true && !noColor} wrap="truncate">
              {line.text}
            </Text>
          </Box>
        ),
      )}
    </Box>
  );
}
