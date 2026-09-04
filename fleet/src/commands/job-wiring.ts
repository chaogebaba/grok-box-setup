// job-wiring.ts — the production seams `grokfleet job` runs on (jobs J8).
//
// Kept out of job.ts for the same reason lease-wiring is kept out of lease.ts:
// that module takes an `ApiClient`, a clock, an interrupt registration and an
// output sink, and every one of them is a real thing only here.

import { makeApiClient, type ApiClient } from "../tui/api-client.ts";
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

export function makeJobDeps(stdout: (s: string) => void): JobDeps {
  // LAZY, the same way `lease` is: `grokfleet job help` (and a bare `job`) must
  // work on a machine with no tui.toml. Resolving the admin config up front
  // turns a usage message into a fatal "no url, token" — which is exactly what
  // it did on grok-box-010 before this Proxy.
  let client: ApiClient | undefined;
  const api = new Proxy({} as ApiClient, {
    get(_t, prop: string) {
      if (client === undefined) {
        const c = resolveTuiConfig();
        client = makeApiClient(c.url, c.token);
      }
      return (client as unknown as Record<string, unknown>)[prop];
    },
  });
  return {
    api,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onInterrupt,
    out: stdout,
  };
}
