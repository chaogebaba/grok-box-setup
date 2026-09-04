// job-wiring.ts — the production seams `grokfleet job` runs on (jobs J8).
//
// Kept out of job.ts for the same reason lease-wiring is kept out of lease.ts:
// that module takes an `ApiClient`, a clock, an interrupt registration and an
// output sink, and every one of them is a real thing only here.

import type { Env } from "../env.ts";
import { makeApiClient } from "../tui/api-client.ts";
import { resolveTuiConfig } from "../tui/config.ts";
import type { JobDeps } from "./job.ts";

/** SIGINT/SIGTERM ⇒ tell the job to stop, then keep waiting for it (J8). */
function onInterrupt(fn: () => void): () => void {
  const handlers: Array<[NodeJS.Signals, () => void]> = [];
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const h = (): void => fn();
    process.on(sig, h);
    handlers.push([sig, h]);
  }
  return () => {
    for (const [sig, h] of handlers) process.off(sig, h);
  };
}

export function makeJobDeps(env: Env, stdout: (s: string) => void): JobDeps {
  const tui = resolveTuiConfig(env);
  return {
    api: makeApiClient(tui.base, tui.token),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onInterrupt,
    out: stdout,
  };
}
