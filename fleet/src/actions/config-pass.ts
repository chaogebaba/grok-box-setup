// config-pass.ts — reconcile_config_pass port (main:2345-2453) + F1/F2 canary policy.
//
// managed_files_present ⇒ silent no-op (feature off). Canary FIRST (F1: verbatim
// pass-start line + a SEPARATE `config: canary policy=<fixed|dynamic>` line),
// then the rest in reconcile_target_boxes order, SERIALLY. Guard: tunnel up AND
// checkfail count <= 3. Canary routing: tunnel-down / checkfail>3 ⇒ log+skip+
// fall-through; push rc 0 ⇒ reset cfgfail + ok; rc 6 ⇒ skip canary + fall-
// through; rc 3/4/5 ⇒ bump cfgfail, notify when >3, fail + rc 1, ABORT the pass.
// Non-canary arms mirror bash. rc is LOGGED, never folded into the run rc (D6c).
//
// Canary policy (F1/F2): if configCanary is set ⇒ FIXED (that box). If absent ⇒
// DYNAMIC = the lowest-index enrolled box whose tunnel is up at pass start; if
// NONE reachable ⇒ NO canary (log the F1 line), count one skip, and STILL run
// the non-canary loop over every target box.

import type { Runner } from "../runner.ts";
import type { ReconcileStateApi } from "../reconcile/state.ts";
import type { NotifyLevel } from "../notify.ts";
import { tunnelUp } from "../tunnel.ts";
import { pushManaged, type ManagedSource } from "./config-push.ts";
import type { PushDeps } from "./config-push.ts";
import { log } from "../log.ts";

export interface ConfigPassDeps {
  runner: Runner;
  env: PushDeps["env"];
  source: ManagedSource;
  state: ReconcileStateApi;
  notify: (level: NotifyLevel, msg: string) => Promise<void> | void;
  /** target boxes in reconcile order (parseEnrolled / FLEET_BOXES). */
  targetBoxes: string[];
  /** [fleet-brain].canary_box (fixed) or undefined (dynamic). */
  configCanary: string | undefined;
  /** true iff managed files exist (managed_files_present). */
  managedFilesPresent: boolean;
  apply: boolean;
}

export interface ConfigPassResult {
  rc: 0 | 1;
  ok: number;
  skipped: number;
  failed: number;
  canary: string | undefined;
  policy: "fixed" | "dynamic";
  /**
   * Per-box config verdict for the TUI-D4 history snapshot's `config` field:
   * "in-sync" (cur==want), "drift" (would-push / pushed / content failure), or
   * "skip" (tunnel down / checkfail>3 / unreachable rc 6 / never pushed this
   * tick). Boxes absent from the map ⇒ snapshot `config` = null. Added for
   * TUI-D4; folding it in is additive — the rc/ok/skipped/failed contract is
   * unchanged.
   */
  perBox: Map<string, "in-sync" | "drift" | "skip">;
}

/**
 * Choose the config-pass canary (F1/F2). Returns {canary, policy}. Dynamic ⇒
 * lowest-index target box whose tunnel is up (targetBoxes is already index-
 * sorted by parseEnrolled), or undefined when none reachable.
 */
async function chooseCanary(
  deps: ConfigPassDeps,
): Promise<{ canary: string | undefined; policy: "fixed" | "dynamic" }> {
  if (deps.configCanary !== undefined) return { canary: deps.configCanary, policy: "fixed" };
  for (const b of deps.targetBoxes) {
    if (await tunnelUp(deps.runner, b)) return { canary: b, policy: "dynamic" };
  }
  return { canary: undefined, policy: "dynamic" };
}

export async function configPass(deps: ConfigPassDeps): Promise<ConfigPassResult> {
  if (!deps.managedFilesPresent) {
    return { rc: 0, ok: 0, skipped: 0, failed: 0, canary: undefined, policy: "dynamic", perBox: new Map() };
  }
  const mode = deps.apply ? "apply" : "dry-run";
  const unknownSink = new Set<string>();
  const pushDeps: PushDeps = { runner: deps.runner, env: deps.env, source: deps.source, unknownSink };

  const { canary, policy } = await chooseCanary(deps);
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  let rc: 0 | 1 = 0;
  const perBox = new Map<string, "in-sync" | "drift" | "skip">();

  // Map a pushManaged result to the snapshot `config` verdict (TUI-D4). A rc-0
  // push is "in-sync" iff the box's cur== the rendered want; otherwise the file
  // was (or would be) rewritten ⇒ "drift". Any nonzero content rc ⇒ "drift"
  // (the box is not at want). rc 6 (unreachable) is a "skip" (handled inline).
  const verdict = (r: { rc: number; cur?: string; want?: string }): "in-sync" | "drift" => {
    if (r.rc === 0 && r.cur !== undefined && r.want !== undefined && r.cur === r.want) return "in-sync";
    return "drift";
  };

  // Pass-start line — bash verbatim in BOTH policies (F1). `<canary>` is the
  // resolved box, or "none" when dynamic found no reachable box.
  log(`config: pass start (${mode}) — canary-first over tunnels (canary=${canary ?? "none"})`);
  // F3 (r1 gate parity): bash emits NO `config: canary policy=` line. Suppress it
  // in fixed-policy mode (the bash-equivalent mode where `[fleet-brain].canary_box`
  // is set) for byte-identical logs. Keep it ONLY for dynamic-canary mode, which
  // bash never had, so operators can still see the dynamic selection.
  if (policy === "dynamic") log(`config: canary policy=${policy}`);

  const push = (box: string): Promise<{ rc: number; cur?: string; want?: string }> =>
    pushManaged(box, !deps.apply, pushDeps);

  // Canary first (when one was chosen).
  if (canary === undefined) {
    // F1: no reachable box ⇒ NO canary; count one skip; continue over all targets.
    log("config: no canary — no box reachable over a tunnel, continuing without canary protection");
    skipped++;
  } else {
    const cf = deps.state.checkfailCount(canary);
    if (deps.state.readHostkeyMismatch(canary)) {
      // D11(c): the config push is a tunnel WRITE, so it is deferred for as long
      // as the marker is set — the push lands on the tick after the repair
      // re-binds the pin. The shape mirrors the tunnel-down canary: log, skip,
      // continue without canary protection.
      log(`config: ${canary} deferred — host key mismatch`);
      perBox.set(canary, "skip");
      skipped++;
    } else if (!(await tunnelUp(deps.runner, canary))) {
      log(
        `config: canary ${canary} tunnel down — canary check skipped this tick, continuing without canary protection`,
      );
      perBox.set(canary, "skip");
      skipped++;
    } else if (cf > 3) {
      log(
        `config: canary ${canary} skipped — checkfail=${cf} (>3), continuing without canary protection`,
      );
      perBox.set(canary, "skip");
      skipped++;
    } else {
      const cr = await push(canary);
      const crc = cr.rc;
      if (crc === 0) {
        deps.state.resetCfgfail(canary);
        perBox.set(canary, verdict(cr));
        ok++;
      } else if (crc === 6) {
        log(
          `config: canary ${canary} unreachable over tunnel — canary check skipped this tick, continuing without canary protection`,
        );
        perBox.set(canary, "skip");
        skipped++;
      } else {
        // content failure 3/4/5 ⇒ abort the rest this tick.
        perBox.set(canary, "drift");
        const cn = deps.state.bumpCfgfail(canary);
        if (cn > 3) {
          await deps.notify(
            "warn",
            `config push failing for ${canary}: ${cn} consecutive failures — config pass aborted`,
          );
        } else {
          log(
            `config: canary ${canary} push/validate FAILED (rc=${crc}, count=${cn}) — config pass aborted this tick`,
          );
        }
        failed++;
        rc = 1;
        logUnknown(unknownSink);
        log(`config: pass done (${mode}) ok=${ok} skipped=${skipped} failed=${failed}`);
        return { rc, ok, skipped, failed, canary, policy, perBox };
      }
    }
  }

  // The rest, serially, in target order (minus the canary).
  for (const b of deps.targetBoxes) {
    if (b === canary) continue;
    if (deps.state.readHostkeyMismatch(b)) {
      // D11(c), as for the canary above.
      log(`config: ${b} deferred — host key mismatch`);
      perBox.set(b, "skip");
      skipped++;
      continue;
    }
    if (!(await tunnelUp(deps.runner, b))) {
      log(`config: skip ${b} — tunnel down (drift reported when the box returns)`);
      perBox.set(b, "skip");
      skipped++;
      continue;
    }
    if (deps.state.checkfailCount(b) > 3) {
      log(`config: skip ${b} — checkfail over threshold (>3; drift reported when the box returns)`);
      perBox.set(b, "skip");
      skipped++;
      continue;
    }
    const br = await push(b);
    const brc = br.rc;
    if (brc === 0) {
      deps.state.resetCfgfail(b);
      perBox.set(b, verdict(br));
      ok++;
    } else if (brc === 6) {
      log(`config: skip ${b} — unreachable over tunnel`); // NO cfgfail bump (D6d)
      perBox.set(b, "skip");
      skipped++;
    } else {
      perBox.set(b, "drift");
      const n = deps.state.bumpCfgfail(b);
      if (n > 3) await deps.notify("warn", `config push failing for ${b}: ${n} consecutive failures`);
      failed++;
      rc = 1;
    }
  }

  logUnknown(unknownSink);
  log(`config: pass done (${mode}) ok=${ok} skipped=${skipped} failed=${failed}`);
  return { rc, ok, skipped, failed, canary, policy, perBox };
}

function logUnknown(sink: Set<string>): void {
  if (sink.size > 0) {
    const list = [...sink].sort().join(" ");
    log(`config: unknown-but-well-formed keys (allowed, forward-compat): ${list}`);
  }
}
