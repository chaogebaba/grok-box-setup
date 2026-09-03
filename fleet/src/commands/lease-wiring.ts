// lease-wiring.ts — the production seams `grokfleet lease` runs on (lease-api L4).
//
// Kept out of lease.ts so that module stays pure enough to test: the CLI logic
// there takes an `ApiClient`, an `exec`, a clock and a timer, and every one of
// them is a real thing only here.

import type { Env } from "../env.ts";
import type { ParsedConfig } from "../config.ts";
import type { Runner } from "../runner.ts";
import { makeApiClient, type ApiClient } from "../tui/api-client.ts";
import { resolveTuiConfig } from "../tui/config.ts";
import { cmdSsh, type SshVia } from "./ssh.ts";
import type { LeaseRunDeps } from "./lease.ts";
import { log } from "../log.ts";

/**
 * `lease run` executes through `grokfleet ssh` itself — the SAME streaming form,
 * the same rc pass-through, the same `--via` default. There is deliberately no
 * second remote-exec path in the codebase.
 */
function makeExec(env: Env, cfg: ParsedConfig, runner: Runner) {
  return async (box: string, command: string, via: SshVia | undefined): Promise<number> => {
    const args = via === undefined ? [box, command] : ["--via", via, box, command];
    return cmdSsh(args, { runner, cfg, env });
  };
}

/** SIGINT/SIGTERM ⇒ release the lease before the process goes away (L4). */
function onSignal(fn: () => void): () => void {
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

export function makeLeaseDeps(
  env: Env,
  cfg: ParsedConfig,
  runner: Runner,
  write: (s: string) => void,
): LeaseRunDeps {
  let client: ApiClient | undefined;
  const api = new Proxy({} as ApiClient, {
    get(_t, prop: string) {
      // Lazy: `grokfleet lease --help` must work on a machine with no tui.toml.
      if (client === undefined) {
        const c = resolveTuiConfig();
        client = makeApiClient(c.url, c.token);
      }
      return (client as unknown as Record<string, unknown>)[prop];
    },
  });
  return {
    api,
    write,
    errWrite: (s) => log(s),
    exec: makeExec(env, cfg, runner),
    now: () => Date.now(),
    interval: (fn, ms) => {
      const h = setInterval(() => void fn(), ms);
      return () => clearInterval(h);
    },
    onSignal,
  };
}
