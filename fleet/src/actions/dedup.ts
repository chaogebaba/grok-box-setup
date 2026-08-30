// dedup.ts — reconcile_dedup port (main:3149-3177): delete-then-rename (row b).
//
// Re-GET the devices (fresh, main:3151); API read fail or malformed ⇒ latch +
// rc 1. Then DELETE /device/<stale_id>; on failure latch + rc 1. Then, if a live
// id exists, POST /device/<live_id>/name {"name":box}; on failure latch + rc 1.
// ORDER is DELETE stale BEFORE POST rename (tests:609-613).

import type { TailscaleKeys } from "../reconcile/tailscale-keys.ts";
import { devFields } from "../reconcile/inputs.ts";
import { log } from "../log.ts";

export interface DedupResult {
  rc: 0 | 1;
}

export interface DedupDeps {
  keys: TailscaleKeys;
  nowSec?: number;
  staleSecs?: number;
}

function is2xx(code: number): boolean {
  return code >= 200 && code < 300;
}

/** devices_json_valid (main:2627-2632): parses AND has a `.devices` array. */
function devicesValid(body: string): boolean {
  try {
    const v = JSON.parse(body) as { devices?: unknown };
    return Array.isArray(v.devices);
  } catch {
    return false;
  }
}

export async function dedup(box: string, deps: DedupDeps): Promise<DedupResult> {
  // Re-GET devices (fresh). getDevices latches on non-2xx internally.
  const g = await deps.keys.getDevices();
  if (!is2xx(g.code)) {
    log(`reconcile: dedup ${box} API read failed — skip`);
    return { rc: 1 };
  }
  if (!devicesValid(g.body)) {
    log(`reconcile: dedup ${box} API body malformed — READ-ONLY latch, skip`);
    deps.keys.ctx.latch();
    return { rc: 1 };
  }
  const f = devFields(g.body, box, { nowSec: deps.nowSec, staleSecs: deps.staleSecs });
  if (f.staleId === "") {
    log(`reconcile: dedup ${box} no stale id`);
    return { rc: 1 };
  }
  const del = await deps.keys.deleteDevice(f.staleId); // DELETE stale FIRST
  if (!del.ok) {
    log(`reconcile: dedup ${box} DELETE ${f.staleId} HTTP ${del.code}`);
    return { rc: 1 }; // deleteDevice already latched
  }
  log(`reconcile: dedup ${box} deleted stale device ${f.staleId}`);
  if (f.liveId !== "") {
    const ren = await deps.keys.renameDevice(f.liveId, box); // THEN rename live
    if (ren.ok) {
      log(`reconcile: dedup ${box} renamed live ${f.liveId} -> ${box}`);
    } else {
      log(`reconcile: dedup ${box} rename HTTP ${ren.code}`);
      return { rc: 1 }; // renameDevice already latched
    }
  }
  return { rc: 0 };
}
