// mint-key.ts — `grokfleet mint-key <grok-box-N>` (F1), a THIN CLI WRAPPER over the
// phase-2 actions/mint.ts:mintKey. NO second mint path — reconcile row-c and
// this command call the SAME function (F1). The wrapper adds ONLY argument
// handling + the process rc; every failure arm is mintKey's.
//
// F1 usage split (fixes actions/mint.ts:50-53 which emits the non-grok line for
// a MISSING arg where bash emits a usage line, main:1651):
//   empty     ⇒ `usage: grokfleet mint-key <grok-box-N>`            rc 2
//   non-grok  ⇒ `mint-key: refusing non-grok box '<box>'`        rc 2
// (mutant m15: arms collapsed ⇒ killed.)

import type { Env } from "../env.ts";
import type { ParsedConfig } from "../config.ts";
import { BunRunner, type Runner } from "../runner.ts";
import { ReconcileState, nodeStateFs } from "../reconcile/state.ts";
import { RunContext, TailscaleKeys } from "../reconcile/tailscale-keys.ts";
import { resolveTokenFile, fetchTransport, type TailscaleTransport } from "../tailscale.ts";
import { mintKey } from "../actions/mint.ts";
import { log } from "../log.ts";

export interface MintKeyCliDeps {
  env: Env;
  cfg: ParsedConfig;
  /** injectable (tests); defaults to a real BunRunner. */
  runner?: Runner;
  /** injectable transport (tests); defaults to fetchTransport. */
  transport?: TailscaleTransport;
  /** injectable state (tests). */
  state?: ReconcileState;
  nowMs?: number;
}

/** cmd_mint_key wrapper. Returns the process rc (0/1/2). */
export async function cmdMintKey(box: string, deps: MintKeyCliDeps): Promise<number> {
  // F1 usage split — BEFORE mintKey (whose own guard cannot tell empty from
  // non-grok). Empty arg ⇒ usage rc 2; a non-empty non-grok name ⇒ refusal rc 2.
  if (box === "") {
    log("usage: grokfleet mint-key <grok-box-N>");
    return 2;
  }
  if (!/^grok-box-[0-9]/.test(box)) {
    log(`mint-key: refusing non-grok box '${box}'`);
    return 2;
  }

  const runner = deps.runner ?? new BunRunner();
  const transport = deps.transport ?? fetchTransport;
  const state = deps.state ?? new ReconcileState(deps.env.FLEET_STATE, nodeStateFs);
  const ctx = new RunContext();

  const tokenFile = resolveTokenFile(deps.env, deps.cfg);
  let token: string | undefined;
  try {
    token = await transport.readToken(tokenFile);
  } catch {
    token = undefined;
  }
  const keys =
    token !== undefined
      ? new TailscaleKeys(transport, deps.env.FLEET_TS_API, deps.env.FLEET_TS_TAILNET, token, ctx)
      : new TailscaleKeys(transport, deps.env.FLEET_TS_API, deps.env.FLEET_TS_TAILNET, "", ctx);

  const res = await mintKey(box, { runner, env: deps.env, keys, state, nowMs: deps.nowMs });
  return res.rc;
}
