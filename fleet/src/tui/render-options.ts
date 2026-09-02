// render-options.ts — the ONE place Ink's render options are decided (D3).
//
// The frame tests mount through this same factory, so the options the goldens
// exercise are the options production uses. The three that matter:
//
//   alternateScreen: true  — Ink owns the alt screen and the cursor, entering on
//                            mount and restoring on unmount, and registers
//                            signal-exit for SIGINT/SIGTERM/SIGHUP/exit. That
//                            replaces the hand-rolled `term.ts` lifecycle; there
//                            are no manual escape sequences anywhere any more.
//   exitOnCtrlC: false     — ctrl-c must reach the reducer (it is the `quit`
//                            arm), not unmount the app behind its back.
//   patchConsole: false    — `log()` writes to stderr and must never be
//                            swallowed or reordered by Ink's console patching.

import type { RenderOptions } from "ink";

export interface RenderIo {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  stderr: NodeJS.WriteStream;
}

/** The real process streams. */
export const processIo: RenderIo = {
  stdout: process.stdout,
  stdin: process.stdin,
  stderr: process.stderr,
};

export function makeRenderOptions(io: RenderIo, opts?: { debug?: boolean }): RenderOptions {
  return {
    stdout: io.stdout,
    stdin: io.stdin,
    stderr: io.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
    alternateScreen: true,
    debug: opts?.debug ?? false,
  };
}
