// main.ts — the TUI entry point (TUI-D5/D7/D10/D11, ported to Ink).
//
// `cmdTui` resolves config (rc 2 on a bad/absent config), refuses a non-TTY
// (rc 1), then hands the whole terminal over to Ink: alt screen, raw mode,
// resize and restore-on-every-exit-path are Ink's, not ours. What used to be
// `term.ts` is now `render-options.ts` plus the crash barrier below.

import type { Env } from "../env.ts";
import React from "react";
import { render } from "ink";
import App, { type AppDeps } from "./app.tsx";
import { initialState, POLL_INTERVAL_MS } from "./state.ts";
import { makeApiClient, type ApiClient } from "./api-client.ts";
import { resolveTuiConfig, TuiConfigError, type ConfigFs, nodeConfigFs } from "./config.ts";
import { makeRenderOptions, processIo, type RenderIo } from "./render-options.ts";
import { log } from "../log.ts";
import { hostZone, resolveTsOptions } from "./ts-options.ts";

/** The refusal the hand-rolled core raised as `NotATtyError`; the text and the
 *  rc are unchanged. */
export const NOT_A_TTY_MESSAGE = "tui: refusing to start — stdin is not a TTY (run in an interactive terminal)";

export interface TuiDeps {
  env: Env;
  io?: RenderIo;
  configFs?: ConfigFs;
  /** injected client factory (tests); defaults to the real fetch client. */
  makeClient?: (url: string, token: string) => ApiClient;
  now?: () => number;
  /** the fleet poll's period; defaults to POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
  /** the viewer's IANA zone; defaults to the host's (tests inject a fixed one). */
  resolveZone?: () => string;
}

/**
 * cmdTui — the entry (already dispatched from cli.ts; laptop-runnable, no
 * locality guard). Returns the process rc; it resolves when the user quits.
 */
export async function cmdTui(rest: string[], deps: TuiDeps): Promise<number> {
  const io = deps.io ?? processIo;
  const now = deps.now ?? (() => Date.now());
  const noColor = process.env.NO_COLOR !== undefined;
  const ts = resolveTsOptions(rest, process.env.FLEET_TUI_UTC, deps.resolveZone ?? hostZone);

  let cfg;
  try {
    cfg = resolveTuiConfig(deps.configFs ?? nodeConfigFs);
  } catch (e) {
    if (e instanceof TuiConfigError) {
      log(e.message);
      return 2;
    }
    throw e;
  }

  // A14: refuse a non-interactive terminal BEFORE Ink touches anything.
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    log(NOT_A_TTY_MESSAGE);
    return 1;
  }

  const client = (deps.makeClient ?? ((u, t) => makeApiClient(u, t)))(cfg.url, cfg.token);
  const appDeps: AppDeps = {
    client,
    now,
    pollIntervalMs: deps.pollIntervalMs ?? POLL_INTERVAL_MS,
  };

  const instance = render(
    React.createElement(App, { initial: initialState(now(), noColor, ts), deps: appDeps }),
    makeRenderOptions(io),
  );
  const detach = installCrashBarrier(instance.unmount, io);
  try {
    await instance.waitUntilExit();
  } finally {
    detach();
  }
  return 0;
}

/**
 * The one thing Ink does not cover: an uncaught exception or an unhandled
 * rejection. Ink's own `signal-exit` registration restores the terminal on
 * SIGINT/SIGTERM/SIGHUP and on a normal exit, but a crash must also leave the
 * alt screen before the process dies.
 *
 * `unmount()` writes `1049l` + `25h`; the empty `write` that follows takes a
 * callback that fires only once every earlier write to the same stream has been
 * handed to the kernel, so the exit cannot race the teardown (`process.exit`
 * alone does not wait on stream callbacks). The unref'd 200 ms timer is the
 * fallback for a destroyed or errored stdout whose callback never fires, so a
 * crash can never hang the process instead of ending it.
 */
export function installCrashBarrier(unmount: () => void, io: RenderIo): () => void {
  const onFatal = (e: unknown): void => {
    try {
      unmount(); // idempotent
    } catch {
      /* best-effort */
    }
    log(e instanceof Error ? (e.stack ?? e.message) : String(e));
    try {
      io.stdout.write("", () => process.exit(1));
    } catch {
      process.exit(1);
    }
    setTimeout(() => process.exit(1), 200).unref();
  };
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
  return () => {
    process.off("uncaughtException", onFatal);
    process.off("unhandledRejection", onFatal);
  };
}

export { hostZone, resolveTsOptions } from "./ts-options.ts";
