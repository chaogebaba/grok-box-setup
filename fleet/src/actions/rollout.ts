// rollout.ts — row-d rollout adapter (D10/F8). Thin wrapper over the phase-1
// upgrade engine, invoked AT MOST ONCE per tick (never per box — F8 fixes bash's
// per-box re-trigger defect).
//
// The reconcile per-box loop only RECORDS drifted boxes. After the loop, BEFORE
// the config pass, reconcile calls runRolloutOnce with the collected set:
//   auto=false (default, gated) ⇒ emit `reconcile: WOULD rollout <box> <cur>→<target>`
//                                 for each drifted box; no engine call.
//   auto=true  ⇒ run the phase-1 upgrade engine ONCE over the set (canary-first
//               per phase-1 F3, H1/G1 command, F1 verify).
// Target resolution is best-effort (F8): a failed resolveTarget ⇒ drift unknown,
// no row d, one warn line, run rc UNCHANGED (reconcile never returns rc 3).

import type { RolloutConfig } from "../config.ts";
import type { UpgradeDeps, UpgradeArgs, PassResult } from "../upgrade.ts";
import { runUpgradePass } from "../upgrade.ts";
import { log } from "../log.ts";

export interface DriftedBox {
  box: string;
  /**
   * D5 — the box's current boxup VERSION (from the check/status probe), or
   * "unknown". This is the drift key on both sides; the stamped sha is
   * informational and is printed once per line as the target's provenance.
   */
  cur: string;
}

export interface RolloutOnceDeps {
  rollout: RolloutConfig;
  /** target sha resolved this tick (F8 best-effort), or undefined ⇒ unresolved. */
  targetSha: string | undefined;
  targetVersion: string | undefined;
  /** phase-1 upgrade deps, used only when auto=true. */
  upgradeDeps: UpgradeDeps;
  /** injectable for tests: run the phase-1 pass (defaults to runUpgradePass). */
  runPass?: (deps: UpgradeDeps, args: UpgradeArgs) => Promise<PassResult>;
}

export interface RolloutOnceResult {
  /** true iff the engine was actually invoked (auto=true with a non-empty set). */
  ran: boolean;
  pass?: PassResult;
}

/**
 * Run (or WOULD-log) the collected drifted set once. `drifted` is the boxes the
 * per-box loop found with drift=yes.
 */
export async function runRolloutOnce(
  drifted: DriftedBox[],
  deps: RolloutOnceDeps,
): Promise<RolloutOnceResult> {
  if (drifted.length === 0) return { ran: false };
  const targetSha = deps.targetSha ?? "unknown";
  // D5: the WOULD/rollout lines name VERSIONS, because the version is what the
  // drift decision was made on. The target sha rides along in parentheses as
  // the provenance of that version — it is not what was compared.
  const targetVersion = deps.targetVersion ?? "unknown";

  if (!deps.rollout.auto) {
    // gated: log WOULD for each drifted box, no engine call.
    for (const d of drifted) {
      log(`reconcile: WOULD rollout ${d.box} ${d.cur}→${targetVersion} (${targetSha})`);
    }
    return { ran: false };
  }

  // auto=true: run the phase-1 engine ONCE over the drifted set (canary-first).
  // D5: one line per pass naming the target version and its sha.
  log(
    `reconcile: rollout ${drifted.length} drifted box(es) → ${targetVersion} (${targetSha}): ${drifted
      .map((d) => `${d.box} ${d.cur}`)
      .join(", ")}`,
  );
  const runPass = deps.runPass ?? runUpgradePass;
  const boxes = drifted.map((d) => d.box);
  const args: UpgradeArgs = {
    to: undefined, // the engine resolves [rollout].target itself
    boxes,
    all: false,
    apply: true,
    canary: deps.rollout.canary,
    json: false,
    debugExec: false,
  };
  const pass = await runPass(deps.upgradeDeps, args);
  return { ran: true, pass };
}
