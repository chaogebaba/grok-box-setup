// mint.ts — cmd_mint_key port (main:1649-1717) + seed (main:1562-1599).
//
// rc map (§3, S3):
//   2  missing/non-grok box name
//   1  create non-2xx (LATCH); response w/o .key (no latch); response w/o .id
//      (no latch, abandon, do NOT seed); seed/verify failure (REVOKE); meta-
//      persist failure (REVOKE)
//   0  seed verified AND meta persisted AND <box>.expires written
//
// Seed (main:1576): key on STDIN through the Runner's stdin pipe, sha256 local,
// remote command EXACTLY main:1576 shape. Verify (main:1582-1598): boxup status
// non-empty AND seed_status_converged AND read-back of .expires == expires.
// revoke_minted_key (main:1637-1647) on both failure arms.

import type { Runner } from "../runner.ts";
import type { Env } from "../env.ts";
import type { TailscaleKeys } from "../reconcile/tailscale-keys.ts";
import type { ReconcileState } from "../reconcile/state.ts";
import { tunnelSsh } from "../tunnel.ts";
import { boxIndex, isValidBoxName } from "../boxes.ts";
import { parseStatusLine } from "../status.ts";
import {
  renderSeedCommand,
  seedStatusConverged,
  keySha256,
  BOX_AUTHKEY_EXPIRES,
  BOX_ROOT,
} from "../reconcile/seed-remote.ts";
import { log } from "../log.ts";

const SEED_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 20_000;

export interface MintDeps {
  runner: Runner;
  env: Env;
  keys: TailscaleKeys;
  state: ReconcileState;
  /** FLEET_KEY_EXPIRY_SECS (default 7776000). */
  keyExpirySecs?: number;
  nowMs?: number;
}

export interface MintResult {
  rc: 0 | 1 | 2;
}

/** cmd_mint_key (main:1649-1717). */
export async function mintKey(box: string, deps: MintDeps): Promise<MintResult> {
  // rc 2: bad name (main:1651-1652). fleetctl accepts grok-box-[0-9]* — mirror it.
  if (box === "" || !/^grok-box-[0-9]/.test(box)) {
    log(`mint-key: refusing non-grok box '${box}'`);
    return { rc: 2 };
  }

  const create = await deps.keys.createKey(deps.keyExpirySecs ?? 7776000, deps.nowMs);
  if (create.code < 200 || create.code >= 300) {
    // create non-2xx already latched inside createKey (main:1657-1663)
    log(`mint-key: key-create FAILED (HTTP ${create.code}) — old key on ${box} left intact`);
    return { rc: 1 };
  }
  if (create.key === undefined) {
    log(`mint-key: response had no .key — old key on ${box} left intact`); // main:1668-1671
    return { rc: 1 };
  }
  if (create.id === undefined) {
    // main:1678-1683: cannot persist identity ⇒ abandon, do NOT seed, no latch
    log(
      `mint-key: key-create response had no .id — cannot persist key identity; abandoning this key (old key on ${box} left intact)`,
    );
    return { rc: 1 };
  }
  const expdate = create.expires!; // normalized YYYY-MM-DD by createKey

  // Seed + verify.
  const seeded = await seedKeyOverTunnel(box, create.key, expdate, deps);
  if (!seeded) {
    await revokeMintedKey(box, create.id, "seed/verify FAILED on", "; re-mint on next rejoin/expiry trigger", deps);
    return { rc: 1 };
  }

  // Persist meta (main:1707-1711). Bash records the RAW `$expires` here (not the
  // normalized $expdate); the field is informational (only .id is read back).
  deps.state.mkdirState();
  if (!deps.state.recordKeyMeta(boxIndex(box)!, create.id, create.expiresRaw ?? expdate)) {
    await revokeMintedKey(box, create.id, "FAILED to persist key meta for", "; re-mint on next rejoin/expiry trigger", deps);
    return { rc: 1 };
  }

  // Mint-window marker (main:1714): AFTER verified seed + persisted meta.
  deps.state.writeExpires(box, expdate);
  log(`mint-key: ${box} seeded a fresh per-box key (expires ${expdate}); verified via boxup status; key id recorded`);
  return { rc: 0 };
}

/** seed_key_over_tunnel (main:1562-1599). Key on STDIN; verify converged + expires. */
export async function seedKeyOverTunnel(
  box: string,
  key: string,
  expires: string,
  deps: MintDeps,
): Promise<boolean> {
  const wantSha = await keySha256(key);
  const cmd = renderSeedCommand(expires, wantSha);
  const seed = await tunnelSsh(deps.runner, box, deps.env.FLEET_BOX_KEY, cmd, {
    stdin: `${key}\n`, // key travels on STDIN, never argv (M11)
    timeoutMs: SEED_TIMEOUT_MS,
  });
  if (seed.code !== 0) {
    const firstLine = (seed.stderr.split("\n")[0] ?? "").slice(0, 200);
    log(`mint-key: seed stderr: ${firstLine}`);
    return false;
  }
  // Verify: boxup status non-empty ∧ converged ∧ read-back .expires == expires.
  const st = await tunnelSsh(deps.runner, box, deps.env.FLEET_BOX_KEY, `sudo ${BOX_ROOT}/boxup status`, {
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  if (st.code !== 0 || st.stdout.trim() === "") return false;
  if (!seedStatusConverged(st.stdout)) return false;
  void parseStatusLine; // status parsing available if needed; converge uses raw tokens
  const readBack = await tunnelSsh(
    deps.runner,
    box,
    deps.env.FLEET_BOX_KEY,
    `sudo cat '${BOX_AUTHKEY_EXPIRES}'`,
    { timeoutMs: STATUS_TIMEOUT_MS },
  );
  return readBack.stdout.replace(/\s+/g, "") === expires;
}

/** revoke_minted_key (main:1637-1647): DELETE; non-2xx-non-404 ⇒ latch. */
export async function revokeMintedKey(
  box: string,
  keyid: string,
  why: string,
  suffix: string,
  deps: MintDeps,
): Promise<void> {
  log(`mint-key: ${why} ${box} — REVOKING the just-minted key id=${keyid}${suffix}`);
  const r = await deps.keys.deleteKey(keyid);
  if (r.ok) {
    log(`mint-key: revoked the just-minted key id=${keyid} (HTTP ${r.code})`);
  } else {
    log(`mint-key: could NOT revoke key id=${keyid} (HTTP ${r.code}) — manual revoke required`);
    deps.keys.ctx.latch();
  }
}

/**
 * mint_window_valid (main:1724-1736): true (skip re-mint) iff <box>.expires
 * exists AND key_meta_id non-empty AND date parses AND daysUntil >= 7.
 */
export function mintWindowValid(box: string, deps: { state: ReconcileState; nowSec?: number }): boolean {
  const d = deps.state.readExpiresDate(box);
  if (d === undefined) return false;
  const idx = boxIndex(box);
  if (idx === undefined) return false;
  if (deps.state.keyMetaId(idx) === undefined) return false;
  // daysUntil >= 7 (import here to avoid a cycle at module top)
  const t = /^\d{4}-\d{2}-\d{2}$/.test(d) ? Date.parse(`${d}T00:00:00Z`) : Date.parse(d);
  if (Number.isNaN(t)) return false;
  const now = deps.nowSec ?? Math.floor(Date.now() / 1000);
  const days = Math.trunc((Math.floor(t / 1000) - now) / 86400);
  return days >= 7;
}

void isValidBoxName;
