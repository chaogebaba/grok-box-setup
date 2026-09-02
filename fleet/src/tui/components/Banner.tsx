// Banner.tsx — one line: LINK DOWN > STALE > UNKNOWN (the precedence lives in
// `bannerText`). Rendered only when the model produces one. V7: the semantic
// colour becomes the GROUND, so a banner cannot be read as one more text line.

import React from "react";
import { Box, Text } from "ink";
import { bannerProps, type Tone } from "../tone.ts";

export default function Banner({ text, tone, noColor }: { text: string; tone: Tone; noColor: boolean }): React.ReactElement {
  return (
    <Box flexShrink={0} height={1}>
      <Text {...bannerProps(tone, noColor)} bold={!noColor} wrap="truncate">
        {text}
      </Text>
    </Box>
  );
}
