// Discover.tsx — the one-line zero-touch-join summary (D7). Never painted while
// a view is open, which is why `viewChromeRows` does not count it.

import React from "react";
import { Box, Text } from "ink";
import { toneProps } from "../tone.ts";

export default function Discover({ text, noColor }: { text: string; noColor: boolean }): React.ReactElement {
  return (
    <Box flexShrink={0} height={1}>
      <Text {...toneProps("dim", noColor)} wrap="truncate">
        {text}
      </Text>
    </Box>
  );
}
