// tui-crash-fixture.ts — a deliberate crash under a real pty (fleet-tui-ink D3).
//
// The compiled TUI has no way to be told to throw, so the crash barrier is
// exercised here instead: the SAME `makeRenderOptions` and the SAME
// `installCrashBarrier` the entry point uses, over a trivial Ink tree, followed
// by an uncaught exception. The smoke then asserts that the alt-screen teardown
// bytes reached the terminal BEFORE the process ended, and that it ended.

import React from "react";
import { render, Text } from "ink";
import { makeRenderOptions, processIo } from "../../src/tui/render-options.ts";
import { installCrashBarrier } from "../../src/tui/main.ts";

const instance = render(React.createElement(Text, null, "crash fixture"), makeRenderOptions(processIo));
installCrashBarrier(instance.unmount, processIo);
setTimeout(() => {
  throw new Error("pty smoke: deliberate crash");
}, 300);
