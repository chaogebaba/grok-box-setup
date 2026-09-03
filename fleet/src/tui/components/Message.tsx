// Message.tsx — the status line (occupancy O4a). It used to be the transient
// message only; it now renders the SEGMENTS `statusLine` composes: the `/filter`
// prompt, the `[free]` badge and the message, each already in its own tone.
// V6's `messageTone` still decides the message segment's colour — inside
// `statusLine`, not here.

import React from "react";
import Segments from "./Segments.tsx";
import type { Seg } from "../model.ts";

export default function Message({ segs, noColor }: { segs: Seg[]; noColor: boolean }): React.ReactElement {
  return <Segments segments={segs} noColor={noColor} />;
}
