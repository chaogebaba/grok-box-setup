// Message.tsx — the transient status/action line. V6: OK when it reads as a
// success, DOWN when it names an error or a failure, plain otherwise —
// `messageTone` decides, and the model test pins the table.

import React from "react";
import { Box, Text } from "ink";
import { messageTone } from "../model.ts";
import { toneProps } from "../tone.ts";

export default function Message({ text, noColor }: { text: string; noColor: boolean }): React.ReactElement {
  return (
    <Box flexShrink={0} height={1}>
      <Text {...toneProps(messageTone(text), noColor)} wrap="truncate">
        {text}
      </Text>
    </Box>
  );
}
