// regen-goldens.ts — rewrite `fixtures/*.txt` from the model (fleet-tui-visual V8).
//
// The fixtures were captured once from the hand-rolled `renderFrame` before
// render.ts was deleted, and there was no script to make them again. This is
// that script: it reproduces the hand-rolled painter's COMPOSITION —
//
//   header / banner / discover / blank
//   the row region: `padVisible(tableLine, leftW) + "  " + detailLine`, one
//     joined line per row, trailing whitespace trimmed, the Detail column shown
//     whenever `cols >= 100` (the old painter's only cutoff)
//   blank + modal lines, or blank + the message line
//   blank
//   the footer's lines
//
// — out of the same `model.ts` functions the frame tests read. Running it on an
// UNCHANGED tree rewrites every fixture byte for byte, which is what makes the
// diff after a visual change evidence of that change and nothing else.
//
//   bun test/tui/regen-goldens.ts            # rewrite fixtures/
//   bun test/tui/regen-goldens.ts --check    # print the diff, write nothing

import { readFileSync, writeFileSync } from "node:fs";
import {
  bannerText,
  detailLines,
  detailWidth,
  discoverText,
  footerLines,
  headerText,
  messageText,
  modalLines,
  tableLines,
  tableWidth,
  viewLines,
  type Size,
} from "../../src/tui/model.ts";
import type { TuiState } from "../../src/tui/state.ts";
import { GOLDENS } from "./goldens.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;

/** The old painter's Detail cutoff: columns only, never the row budget. */
const OLD_DETAIL_CUTOFF = 100;

export function oldFrame(state: TuiState, size: Size): string[] {
  const out: string[] = [];
  out.push(headerText(state, size));
  const banner = bannerText(state, size);
  if (banner !== undefined) out.push(banner.text);
  const viewOpen = state.view !== undefined;
  const discover = discoverText(state, size);
  if (discover !== undefined && !viewOpen) out.push(discover);
  out.push("");

  const message = messageText(state);
  if (viewOpen) {
    for (const l of viewLines(state, size)) out.push(l.text);
    if (message !== undefined) {
      out.push("");
      out.push(message);
    }
  } else {
    const leftW = tableWidth(size);
    const table = tableLines(state, size).map((l) => l.text);
    const detail = size.cols >= OLD_DETAIL_CUTOFF ? detailLines(state, detailWidth(size)).map((l) => l.text) : [];
    const n = Math.max(table.length, detail.length);
    for (let i = 0; i < n; i++) {
      const l = table[i] ?? "";
      const r = detail[i] ?? "";
      out.push(`${l.length >= leftW ? l : l + " ".repeat(leftW - l.length)}  ${r}`.replace(/[ \t]+$/, ""));
    }
    if (state.modal !== undefined) {
      out.push("");
      for (const m of modalLines(state)) out.push(m.text);
    } else if (message !== undefined) {
      out.push("");
      out.push(message);
    }
  }
  out.push("");
  for (const f of footerLines(state, size)) out.push(f);
  return out;
}

function main(): void {
  const check = process.argv.includes("--check");
  let changed = 0;
  for (const g of GOLDENS) {
    const path = `${FIXTURES}${g.name}.txt`;
    const next = `${oldFrame(g.state, g.size).join("\n")}\n`;
    let prev = "";
    try {
      prev = readFileSync(path, "utf8");
    } catch {
      prev = "";
    }
    if (prev === next) continue;
    changed++;
    if (check) {
      const a = prev.split("\n");
      const b = next.split("\n");
      console.log(`--- ${g.name}`);
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          if (a[i] !== undefined) console.log(`  -${a[i]}`);
          if (b[i] !== undefined) console.log(`  +${b[i]}`);
        }
      }
    } else {
      writeFileSync(path, next);
      console.log(`wrote ${g.name}.txt`);
    }
  }
  console.log(`${changed}/${GOLDENS.length} fixtures ${check ? "would change" : "changed"}`);
}

if (import.meta.main) main();
