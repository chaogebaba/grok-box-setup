// inputs.ts — per-box reconcile inputs.
//
// devFields() is a PURE port of dev_field (main:3287-3309): given the devices
// JSON body and a box name, derive online / fresh / dupcount / bothOnline /
// staleId / liveId, matching bash's jq semantics exactly:
//   - a device matches the box iff base(hostname // name) == box, where
//     base(h) = h with a trailing `-1` split-brain suffix stripped;
//   - online   = any matching device with online===true;
//   - dupcount = number of matching devices;
//   - bothOnline = (#online >= 2);
//   - fresh    = any matching device with (now - lastSeen) <= FLEET_STALE_SECS
//                (missing lastSeen ⇒ epoch 0 ⇒ not fresh);
//   - staleId  = nodeId||id of the OLDEST OFFLINE dup (sort_by lastSeen||created);
//   - liveId   = nodeId||id of the first ONLINE dup.
// On a read-only run devs="" ⇒ callers pass unknown/0/no (never "absent").
//
// daysUntil() ports days_until (main:3263-3268): integer days, trunc toward zero
// (bash $(( )) ), "unknown" if unparseable. VPS-side clock.

import { baseName } from "../tailscale.ts";

export interface DevFields {
  online: "yes" | "no";
  fresh: "yes" | "no";
  dupcount: number;
  bothOnline: "yes" | "no";
  staleId: string;
  liveId: string;
}

interface RawDevice {
  hostname?: string;
  name?: string;
  online?: boolean;
  lastSeen?: string;
  created?: string;
  nodeId?: string;
  id?: string;
}

/** Parse an ISO8601 to epoch seconds; NaN inputs ⇒ 0 (bash `// 0`). */
function iso(s: string | undefined): number {
  if (typeof s !== "string" || s === "") return 0;
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

/**
 * Compute dev_field-equivalent derived fields for a box. `body` is the raw
 * devices JSON (empty/invalid ⇒ all-unknown defaults). `nowSec` and `staleSecs`
 * are injectable for deterministic tests (default: real clock, 600).
 */
export function devFields(
  body: string,
  box: string,
  opts: { nowSec?: number; staleSecs?: number } = {},
): DevFields {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const staleSecs = opts.staleSecs ?? 600;
  const EMPTY: DevFields = {
    online: "no",
    fresh: "no",
    dupcount: 0,
    bothOnline: "no",
    staleId: "",
    liveId: "",
  };
  if (body.trim() === "") return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return EMPTY;
  }
  const devices = (parsed as { devices?: unknown })?.devices;
  if (!Array.isArray(devices)) return EMPTY;

  const ds = (devices as RawDevice[]).filter((d) => baseName(d.hostname ?? d.name ?? "") === box);
  const on = ds.filter((d) => d.online === true);
  const off = ds
    .filter((d) => d.online !== true)
    .slice()
    .sort((a, b) => {
      const ka = a.lastSeen ?? a.created ?? "";
      const kb = b.lastSeen ?? b.created ?? "";
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

  // bash: any matching device with `now - (lastSeen // epoch0) <= stale`. A
  // missing lastSeen ⇒ epoch 0 ⇒ now-0 = now, which is > stale in practice ⇒
  // not fresh. We replicate exactly.
  const fresh = ds.some((d) => nowSec - iso(d.lastSeen) <= staleSecs) ? "yes" : "no";

  return {
    online: on.length > 0 ? "yes" : "no",
    fresh,
    dupcount: ds.length,
    bothOnline: on.length >= 2 ? "yes" : "no",
    staleId: off[0]?.nodeId ?? off[0]?.id ?? "",
    liveId: on[0]?.nodeId ?? on[0]?.id ?? "",
  };
}

/** days_until (main:3263-3268): trunc((epoch(date) - now)/86400), or "unknown". */
export function daysUntil(dateStr: string, nowSec?: number): number | "unknown" {
  // bash: date -u -d "$d" +%s. Accept YYYY-MM-DD (interpreted UTC midnight).
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? `${dateStr}T00:00:00Z` : dateStr);
  if (Number.isNaN(t)) return "unknown";
  const epoch = Math.floor(t / 1000);
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  // trunc toward zero to match bash $(( ))
  return Math.trunc((epoch - now) / 86400);
}
