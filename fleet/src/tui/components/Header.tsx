// Header.tsx — one line: the fleet counters, apply reading, tick age, scope and
// link state. Thin: the text and the width are the model's job.

import React from "react";
import { Box, Text } from "ink";
import { headerText, type Size } from "../model.ts";
import type { TuiState } from "../state.ts";

export default function Header({ state, size }: { state: TuiState; size: Size }): React.ReactElement {
  return (
    <Box flexShrink={0} height={1}>
      <Text bold={!state.noColor} wrap="truncate">
        {headerText(state, size)}
      </Text>
    </Box>
  );
}
