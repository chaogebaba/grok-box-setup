// Footer.tsx — the scope-aware key legend, one or two lines per the model's
// width rule. The line COUNT is part of the row budget, so this component must
// emit exactly what `footerSegmentLines` returns and nothing else. V6: key
// letters ACCENT, their words MUTED, the three groups split by a MAIN `│`.

import React from "react";
import { Box } from "ink";
import Segments from "./Segments.tsx";
import type { Seg } from "../model.ts";

export default function Footer({ lines, noColor }: { lines: Seg[][]; noColor: boolean }): React.ReactElement {
  return (
    <Box flexShrink={0} flexDirection="column">
      {lines.map((segs, i) => (
        <Segments key={i} segments={segs} noColor={noColor} />
      ))}
    </Box>
  );
}
