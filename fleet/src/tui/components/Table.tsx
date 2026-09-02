// Table.tsx — THIN: one row per line the model produced, each row painted from
// its per-cell segments (V3). The column header, the padding, the CONFIG
// column, the selection marker and the windowing all happen in model.ts /
// layout.ts.

import React from "react";
import { Box, Text } from "ink";
import Segments from "./Segments.tsx";
import { selectionProps, toneProps } from "../tone.ts";
import type { TableLine } from "../model.ts";

export default function Table({ lines, noColor }: { lines: TableLine[]; noColor: boolean }): React.ReactElement {
  return (
    <Box flexShrink={0} flexDirection="column">
      {lines.map((line, i) =>
        line.segments !== undefined ? (
          <Segments
            key={i}
            segments={line.segments}
            noColor={noColor}
            override={line.selected === true && !noColor ? selectionProps(noColor) : undefined}
            bold={line.bold === true || line.selected === true}
          />
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
