// make-tui-fixtures.ts — ONE-OFF (fleet-tui-ink D5, the deletion guard).
//
// Run ONCE, on the commit before `src/tui/render.ts` is deleted:
//
//   cd fleet && bun run scripts/make-tui-fixtures.ts
//
// It renders the HAND-ROLLED painter with `noColor` for every golden in
// `test/tui/goldens.ts` and writes the result to `test/tui/fixtures/*.txt`.
// Those files are the only surviving record of what the old TUI painted, and
// the Ink frame tests compare against them. This script is deleted together
// with render.ts; the fixtures stay.

import { mkdirSync, writeFileSync } from "node:fs";
import { renderFrame } from "../src/tui/render.ts";
import { GOLDENS } from "../test/tui/goldens.ts";

const OUT = new URL("../test/tui/fixtures/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

for (const g of GOLDENS) {
  const frame = renderFrame({ ...g.state, noColor: true } as never, g.size);
  writeFileSync(`${OUT}${g.name}.txt`, frame.endsWith("\n") ? frame : `${frame}\n`);
  console.log(`${g.name}.txt  ${frame.split("\n").length} lines`);
}
console.log(`${GOLDENS.length} fixtures written to ${OUT}`);
