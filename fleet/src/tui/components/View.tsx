// View.tsx — the full-frame diff / journal / history body: the title (carrying
// the `rows a–b of N` indicator) and the windowed content, both from the model.

import React from "react";
import { Box, Text } from "ink";
import { toneProps } from "../tone.ts";
import type { ToneLine } from "../model.ts";

export default function View({ lines, noColor }: { lines: ToneLine[]; noColor: boolean }): React.ReactElement {
  return (
    <Box flexShrink={0} flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i} flexShrink={0} height={1}>
          <Text {...toneProps(line.tone, noColor)} bold={line.bold === true && !noColor} wrap="truncate">
            {line.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
