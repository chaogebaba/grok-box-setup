// View.tsx — the full-frame diff / journal / history / jobs / joblog body: the
// title (carrying the `rows a–b of N` indicator) and the windowed content, both
// from the model.
//
// 5.14.1 D1: a view line may now be the CURSOR row. `Table.tsx:21` cannot be
// reused literally — that is its `Segments` branch and `override` is a
// `Segments` prop, while a view line is painted by a bare `Text`. So the
// selection is applied here, to the whole line, from the same `selectionProps`
// the table's bar uses. The NO_COLOR marker is the model's job, not this one's.

import React from "react";
import { selectionProps, toneProps } from "../tone.ts";
import { Box, Text } from "ink";
import type { ToneLine } from "../model.ts";

export default function View({ lines, noColor }: { lines: ToneLine[]; noColor: boolean }): React.ReactElement {
  return (
    <Box flexShrink={0} flexDirection="column">
      {lines.map((line, i) => (
        <Box key={i} flexShrink={0} height={1}>
          <Text
            {...(line.selected === true && !noColor ? selectionProps(noColor) : toneProps(line.tone, noColor))}
            bold={!noColor && (line.bold === true || line.selected === true)}
            wrap="truncate"
          >
            {line.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
