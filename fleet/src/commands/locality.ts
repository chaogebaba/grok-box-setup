// locality.ts — the VPS-only refusal (F2/M2), implemented ONCE at the shared
// engine entry so status/check/rollout AND inventory/upgrade refuse identically.
//
// F2: the phase-1 status/check/rollout re-base changed LOCALITY (laptop-or-VPS
// ⇒ VPS-only). On a host with no FLEET_BOX_KEY these commands print
//   `<cmd>: VPS-only in fleet2 — this command now runs over the reverse tunnels (docs/FLEET-BRAIN.md §retirement)`
// and exit rc 6 (the house "refused" code), instead of per-box ssh noise.
// M2: the guard lives ONCE here; `fleet2 upgrade` refuses the same as
// `fleet2 rollout` (the rollout alias adds NO guard of its own).
//
// `list` and `ssh` (and `remove-timer`) are laptop-runnable (M1) and do NOT call
// this guard.

import { log } from "../log.ts";

const VPS_ONLY_SUFFIX =
  "VPS-only in fleet2 — this command now runs over the reverse tunnels (docs/FLEET-BRAIN.md §retirement)";

/**
 * Refuse (rc 6) with the VPS-only line for `cmd` when the box access key is
 * absent (the VPS-only precondition). Returns true iff it refused. `exists` is
 * the result of a Bun.file(boxKey).exists() probe (injected for tests).
 */
export function refuseVpsOnly(cmd: string, keyExists: boolean): boolean {
  if (keyExists) return false;
  log(`${cmd}: ${VPS_ONLY_SUFFIX}`);
  return true;
}
