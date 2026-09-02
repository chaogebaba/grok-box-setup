// Banner.tsx — one line: LINK DOWN > STALE > UNKNOWN (the precedence lives in
// `bannerText`). Rendered only when the model produces one.

import React from "react";
import { Box, Text } from "ink";
import { toneProps, type Tone } from "../tone.ts";

export default function Banner({ text, tone, noColor }: { text: string; tone: Tone; noColor: boolean }): React.ReactElement {
  return (
    <Box flexShrink={0} height={1}>
      <Text {...toneProps(tone, noColor)} wrap="truncate">
        {text}
      </Text>
    </Box>
  );
}
