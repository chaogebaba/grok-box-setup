// Footer.tsx — the scope-aware key legend, one or two lines per the model's
// width rule. The line COUNT is part of the row budget, so this component must
// emit exactly what `footerLines` returns and nothing else.

import React from "react";
import { Box, Text } from "ink";
import { toneProps } from "../tone.ts";

export default function Footer({ lines, noColor }: { lines: string[]; noColor: boolean }): React.ReactElement {
  return (
    <Box flexShrink={0} flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i} flexShrink={0} height={1}>
          <Text {...toneProps("dim", noColor)} wrap="truncate">
            {line}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
