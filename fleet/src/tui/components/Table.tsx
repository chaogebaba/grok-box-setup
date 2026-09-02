// Table.tsx — THIN: one <Text> per line the model produced. The column header,
// the padding, the CONFIG column, the selection marker and the windowing all
// happen in model.ts / layout.ts.

import React from "react";
import { Box, Text } from "ink";
import { toneProps } from "../tone.ts";
import type { TableLine } from "../model.ts";

export default function Table({ lines, noColor }: { lines: TableLine[]; noColor: boolean }): React.ReactElement {
  return (
    <Box flexShrink={0} flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i} flexShrink={0} height={1}>
          <Text {...toneProps(line.tone, noColor)} inverse={line.selected === true && !noColor} wrap="truncate">
            {line.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
