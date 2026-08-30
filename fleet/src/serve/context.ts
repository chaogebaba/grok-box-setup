// context.ts — the ServerContext: everything the handlers need, behind seams so
// box-free tests inject fakes (TUI-D1: handlers call the SAME internal modules
// as the CLI commands).

import type { Env } from "../env.ts";
import type { ParsedConfig, RolloutConfig } from "../config.ts";
import type { Runner } from "../runner.ts";
import type { TokenStore } from "./tokens.ts";
import type { JobRegistry } from "./jobs.ts";
import type { AuditSink } from "./audit.ts";
import type { ReconcileDeps } from "../reconcile/run.ts";
import type { WithLockDeps } from "./lock.ts";

/** The seam over the reconcile tick (so the job handler injects deps in tests). */
export interface TickRunner {
  /** assemble + run ONE tick; returns its rc. Production wires
   *  runReconcile(assembleTickDeps(...)) DIRECTLY (never cliReconcile, R3-B1). */
  run(opts: { apply: boolean }): Promise<number>;
}

export interface ServerContext {
  env: Env;
  cfg: ParsedConfig;
  rollout: RolloutConfig;
  runner: Runner;
  tokens: TokenStore;
  jobs: JobRegistry;
  auditSink: AuditSink;
  /** the reconcile lock file path (`${FLEET_STATE}/reconcile.lock`). */
  lockPath: string;
  /** lock deps override (tests inject fake syscalls / clocks). */
  lockDeps?: WithLockDeps;
  /** the tick runner for POST /v1/reconcile. */
  tick: TickRunner;
  /** enrolled membership read (per request, A15). Injected for tests. */
  enrolledBoxes: () => string[];
  /** journalctl presence probe (tests). */
  whichJournalctl?: (bin: string) => boolean;
  /** clock for audit / snapshot_ts (tests). */
  now?: () => Date;
  /** rename deps factory for the API rename path (lock-held variant). */
  makeRenameDeps?: unknown;
  /** override the full ReconcileDeps assembly (tests). */
  assembleTick?: (opts: { apply: boolean }) => Promise<ReconcileDeps>;
}
