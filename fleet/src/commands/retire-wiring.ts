// retire-wiring.ts — production `RetireOps` (blueprint fleet2-state-store D4).
//
// Three side effects and a lock probe. Everything policy-shaped lives in
// retire.ts; this file only touches the world.

import type { Env } from "../env.ts";
import type { ParsedConfig } from "../config.ts";
import type { Runner } from "../runner.ts";
import { resolveTokenFile, fetchTransport } from "../tailscale.ts";
import { RunContext, TailscaleKeys } from "../reconcile/tailscale-keys.ts";
import { openStore, storePath } from "../store/db.ts";
import { StoreState } from "../store/state.ts";
import { removeAuthorizedKeysLines, type RetireOps, type RetireStoreHandle } from "./retire.ts";
import { vpsAuthorizedKeysPath } from "./enroll-wiring.ts";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const LOCK_TIMEOUT_MS = 95_000;

export function makeRetireOps(env: Env, cfg: ParsedConfig, runner: Runner): RetireOps {
  const etcAkDir = process.env.FLEET_ETC_AK_DIR ?? `${env.FLEET_ETC}/authorized-keys.d`;
  const keysPromise = (async () => {
    const ctx = new RunContext();
    let token: string | undefined;
    try {
      token = await fetchTransport.readToken(resolveTokenFile(env, cfg));
    } catch {
      token = undefined;
    }
    return new TailscaleKeys(fetchTransport, env.FLEET_TS_API, env.FLEET_TS_TAILNET, token ?? "", ctx);
  })();

  return {
    removeVpsAuthorizedKey(port, pubkey) {
      const path = vpsAuthorizedKeysPath();
      try {
        if (!existsSync(path)) return 0;
        const { text, removed } = removeAuthorizedKeysLines(readFileSync(path, "utf8"), port, pubkey);
        if (removed === 0) return 0;
        writeFileSync(path, text);
        chmodSync(path, 0o600);
        return removed;
      } catch {
        return undefined;
      }
    },
    removeEtcLine(box) {
      try {
        rmSync(`${etcAkDir}/${box}.line`, { force: true });
        return true;
      } catch {
        return false;
      }
    },
    async revokeKey(keyId) {
      const keys = await keysPromise;
      const r = await keys.deleteKey(keyId);
      return { ok: r.ok, code: r.code };
    },
    async acquireLock() {
      // The same `flock -w 90 … -c :` probe rename and `grokfleet state` use: it
      // proves the lock was free within the window rather than holding it for
      // the command's duration.
      if (Bun.which("flock") === null) return "open-fail";
      const r = await runner.run(["flock", "-w", "90", `${env.FLEET_STATE}/reconcile.lock`, "-c", ":"], {
        timeoutMs: LOCK_TIMEOUT_MS,
      });
      return r.code === 0 ? "ok" : "busy";
    },
  };
}

/** Open the store read-write for retire; undefined when there is no store yet. */
export function makeRetireOpen(env: Env, version: string): () => RetireStoreHandle | undefined {
  return () => {
    const path = storePath(env.FLEET_STATE);
    if (!existsSync(path)) return undefined;
    const store = openStore({ path, dir: env.FLEET_STATE });
    const state = new StoreState(store, {
      paths: { fleetState: env.FLEET_STATE, etc: env.FLEET_ETC, version },
    });
    return { store, state, close: () => store.close() };
  };
}
