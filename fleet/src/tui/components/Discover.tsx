// Discover.tsx — the one-line zero-touch-join summary (D7). Never painted while
// a view is open, which is why `viewChromeRows` does not count it. V4: MUTED,
// with any NON-zero count in plain so `1 adopted` stands out from the zeros.

import React from "react";
import Segments from "./Segments.tsx";
import type { Seg } from "../model.ts";

export default function Discover({ segments, noColor }: { segments: Seg[]; noColor: boolean }): React.ReactElement {
  return <Segments segments={segments} noColor={noColor} />;
}
