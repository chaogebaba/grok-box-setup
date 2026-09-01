// Message.tsx — the transient status/action line.

import React from "react";
import { Box, Text } from "ink";
import { toneProps } from "../tone.ts";

export default function Message({ text, noColor }: { text: string; noColor: boolean }): React.ReactElement {
  return (
    <Box flexShrink={0} height={1}>
      <Text {...toneProps("dim", noColor)} wrap="truncate">
        {text}
      </Text>
    </Box>
  );
}
