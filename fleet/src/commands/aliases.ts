// aliases.ts — status/check/rollout re-based on the phase-1 engine (D3/F2/F9/M4).
//
// These three are NOT bash-verbatim (D3): phase 1 already replaced them by
// design, so their output is the phase-1 inventory/upgrade output plus a few
// re-emitted summary lines. This module holds the alias-specific PURE helpers;
// cli.ts wires them to runInventory / runUpgradePass and the locality guard.
//
//   status  = inventory table + fleet summary lines (F2 Q1 addendum)
//   check   = inventory + rc 1 if any box not OK; --notify ⇒ notify warn (F5)
//   rollout = upgrade --apply with --all/--canary mapped 1:1; --dirty accepted
//             for compatibility (M4); bare rollout ⇒ 3-line refusal rc 2 (F9)

import { log } from "../log.ts";
import type { InventoryResult, ProbeResult } from "../inventory.ts";
import { driftCell } from "../inventory.ts";

/** The bare-rollout refusal (main:636-639, fleetctl→fleet2), 3 lines, rc 2. */
export function rolloutRefusal(): number {
  log("rollout: refusing to guess targets. Use:");
  log("  fleet2 rollout <box...>      deploy to explicit boxes");
  log("  fleet2 rollout --all         deploy to the whole fleet (canary first)");
  return 2;
}

/** rollout canary log (F9): `rollout: canary=<box> (policy=<config|dynamic>)`. */
export function rolloutCanaryLine(box: string, policy: "config" | "dynamic"): string {
  return `rollout: canary=${box} (policy=${policy})`;
}

/** --dirty compatibility log (M4). */
export const ROLLOUT_DIRTY_COMPAT_LINE =
  "rollout: --dirty is accepted for compatibility; fleet2 deploys the resolved ref, never the working tree";

/**
 * status fleet summary lines from the inventory rows (F2 Q1 addendum, main:303/306).
 * MIXED-version when >1 distinct non-unknown boxup VERSION across probed boxes;
 * drift when any probed box's version != target version. Both halves are keyed
 * on VERSION since D5 (62eebe6/1928c26): every fleet2-only commit to main
 * restamps each box with a fresh repo sha at the SAME boxup version, so counting
 * shas here reported a MIXED fleet with zero drift after every such commit.
 * Returns the lines to log (may be empty).
 */
export function statusSummaryLines(res: InventoryResult): string[] {
  const target = res.target;
  const lines: string[] = [];
  const versions = new Set<string>();
  let anyDrift = false;
  for (const r of res.rows) {
    if (r.version !== "-" && r.version !== "?" && r.version !== "unknown") versions.add(r.version);
    if (target && driftCell(r, target) === "yes") anyDrift = true;
  }
  const targetSha = target ? target.sha : "unknown";
  if (versions.size > 1)
    lines.push(`status: fleet is MIXED-version (${versions.size} distinct versions); target=${targetSha}`);
  if (anyDrift) lines.push(`status: some boxes drift from target=${targetSha}`);
  return lines;
}

/**
 * check verdict from inventory rows (F5): unhealthy = a probed box whose CHECK is
 * not OK (FAIL, or `-` when the tunnel is down). Returns {rc, unhealthy[]}.
 */
export function checkVerdict(rows: ProbeResult[]): { rc: 0 | 1; unhealthy: string[] } {
  const unhealthy = rows.filter((r) => r.check !== "OK").map((r) => r.box);
  return { rc: unhealthy.length > 0 ? 1 : 0, unhealthy };
}

/** The check summary line (main:414-shape, F5): `check: N unhealthy: <boxes>`. */
export function checkSummaryLine(unhealthy: string[]): string {
  return `check: ${unhealthy.length} unhealthy: ${unhealthy.join(" ")}`;
}
