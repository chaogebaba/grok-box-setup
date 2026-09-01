// Modal.tsx — the typed-name confirm, APPENDED below the table rather than
// replacing it (the hand-rolled TUI's semantics).

import React from "react";
import { Box, Text } from "ink";
import { toneProps } from "../tone.ts";
import type { ToneLine } from "../model.ts";

export default function Modal({ lines, noColor }: { lines: ToneLine[]; noColor: boolean }): React.ReactElement {
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
