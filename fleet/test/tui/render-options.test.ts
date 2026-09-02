// render-options.test.ts — the render-option factory's FIXED fields (D3).
//
// These three are load-bearing and easy to lose in a refactor:
//   alternateScreen  — the whole terminal lifecycle (enter/restore, signal-exit)
//   exitOnCtrlC      — ctrl-c is a reducer arm, not an Ink-level unmount
//   patchConsole     — `log()` on stderr must never be swallowed or reordered
// The frame harness mounts through this same factory, so a golden that renders
// is also evidence that these options are the ones in force.

import { test, expect, describe } from "bun:test";
import { makeRenderOptions } from "../../src/tui/render-options.ts";
import { FakeStderr, FakeStdin, FakeStdout } from "./ink-harness.ts";

const io = (): Parameters<typeof makeRenderOptions>[0] => ({
  stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
  stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
  stderr: new FakeStderr() as unknown as NodeJS.WriteStream,
});

describe("makeRenderOptions", () => {
  test("alternateScreen is ON — Ink owns the alt screen and the restore", () => {
    expect(makeRenderOptions(io()).alternateScreen).toBe(true);
  });
  test("exitOnCtrlC is OFF — ctrl-c must reach the reducer", () => {
    expect(makeRenderOptions(io()).exitOnCtrlC).toBe(false);
  });
  test("patchConsole is OFF — log() on stderr is never swallowed", () => {
    expect(makeRenderOptions(io()).patchConsole).toBe(false);
  });
  test("debug is off by default and opt-in for the frame tests", () => {
    expect(makeRenderOptions(io()).debug).toBe(false);
    expect(makeRenderOptions(io(), { debug: true }).debug).toBe(true);
  });
  test("the three streams are the ones handed in", () => {
    const streams = io();
    const opts = makeRenderOptions(streams);
    expect(opts.stdout).toBe(streams.stdout);
    expect(opts.stdin).toBe(streams.stdin);
    expect(opts.stderr).toBe(streams.stderr);
  });
});
