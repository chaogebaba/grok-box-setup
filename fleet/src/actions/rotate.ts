// rotate.ts — reconcile_rotate port (main:2927-2957).
//
// 1. capture the OLD key id BEFORE minting (mint overwrites keys/<N>.json);
// 2. mint+seed+verify the new key — failure ⇒ rc 1 (mint already revoked the
//    just-minted key; OLD key untouched at the API);
// 3. success ⇒ empty old id ⇒ skip revoke rc 0; else DELETE old key: 2xx/404 ok,
//    other ⇒ log "revoke FAILED (HTTP N); new key OK, old key will lapse" — the
//    rotation still returns rc 0 (never fail on a revoke miss).

import { mintKey, type MintDeps } from "./mint.ts";
import { boxIndex } from "../boxes.ts";
import { log } from "../log.ts";

export interface RotateResult {
  rc: 0 | 1;
}

export async function rotate(box: string, deps: MintDeps): Promise<RotateResult> {
  const idx = boxIndex(box);
  const oldId = idx !== undefined ? deps.state.keyMetaId(idx) : undefined;

  const minted = await mintKey(box, deps);
  if (minted.rc !== 0) {
    log(
      `reconcile: rotate ${box} — mint/seed FAILED; new key already revoked by mint-key, NOT rotating; box may need re-mint on next rejoin/expiry trigger`,
    );
    return { rc: 1 };
  }

  if (oldId === undefined || oldId === "") {
    log(`reconcile: rotate ${box} — no recorded old key id; skipping revoke (new key seeded OK)`);
    return { rc: 0 };
  }

  const del = await deps.keys.deleteKey(oldId);
  if (del.ok) {
    log(`reconcile: rotate ${box} — revoked old key id=${oldId} (HTTP ${del.code})`);
  } else {
    // Never fail the rotation on a revoke miss — the new key is seeded + working.
    log(
      `reconcile: rotate ${box} — old key id=${oldId} revoke FAILED (HTTP ${del.code}); new key OK, old key will lapse at its own expiry`,
    );
  }
  return { rc: 0 };
}
