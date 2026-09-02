// membership.ts — the ONE place every read path asks "which boxes are members?"
// (blueprint fleet2-state-store D4/D7 Phase A).
//
// From 5.8.0 the answer is `boxes WHERE phase='enrolled'` — for the tick, the
// inventory, the upgrade planner, the index-collision rail and the export
// (D4/B6). `enrolling` rows belong to the resume pass (Phase B) and `retired`
// rows are history; neither is a member and neither is adoptable.
//
// Precedence, unchanged from 5.7.1 except for the middle step:
//   1. `FLEET_BOXES` (space-separated) — the explicit test/override seam;
//   2. the STORE, when `$FLEET_STATE/fleet.db` exists and is migrated;
//   3. `enrolled.tsv`, for the window on a fresh VPS between install and the
//      first tick, when no store file exists yet. The first tick creates the
//      store, imports the files into it and exports them back (D6).

import { existsSync, readFileSync } from "node:fs";
import type { Env } from "../env.ts";
import { resolveMembership } from "../boxes.ts";
import { openStore, storePath, ConfigError, type Store } from "./db.ts";
import { StoreState } from "./state.ts";
import { ReconcileState, nodeStateFs, type ReconcileStateApi } from "../reconcile/state.ts";

/** Read-only membership for a NON-tick caller. Never migrates, never writes. */
export function readMembership(env: Env): string[] {
  if (env.FLEET_BOXES !== undefined && env.FLEET_BOXES.trim() !== "") {
    return resolveMembership(env.FLEET_BOXES, undefined);
  }
  const path = storePath(env.FLEET_STATE);
  if (existsSync(path)) {
    try {
      const store = openStore({ path, dir: env.FLEET_STATE, readonly: true });
      try {
        // A 0-byte or un-migrated file has no `boxes` table; fall through to the
        // legacy file rather than throwing at a read path.
        if (store.userVersion() >= 1) return new StoreState(store).membership();
      } finally {
        store.close();
      }
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      // A file this binary must not operate (D2 min_reader): fall back to the
      // exported files, which are exactly what a rolled-back binary reads.
    }
  }
  return resolveMembership(undefined, readIf(`${env.FLEET_STATE}/enrolled.tsv`));
}

/**
 * A READ-ONLY state handle for a read path (the API's GET endpoints, the CLI's
 * detail readers). WAL snapshot isolation is what makes this safe while a tick
 * writes — survey §4e was exactly this hazard on the marker files.
 *
 * Falls back to the 5.7.1 FILE reader when there is no store yet (the window
 * between install and the first tick) so no read path has to special-case it.
 */
export function openReadState(env: Env): { state: ReconcileStateApi; close(): void } {
  const path = storePath(env.FLEET_STATE);
  if (existsSync(path)) {
    try {
      const store = openStore({ path, dir: env.FLEET_STATE, readonly: true });
      if (store.userVersion() >= 1) {
        return { state: new StoreState(store), close: () => store.close() };
      }
      store.close();
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
    }
  }
  return { state: new ReconcileState(env.FLEET_STATE, nodeStateFs), close: () => {} };
}

/**
 * A READ-WRITE store handle for an API MUTATION (rotate). The caller already
 * holds the reconcile lock. Returns undefined when there is no store yet, so
 * the caller keeps the 5.7.1 file path for that window.
 */
export function openWriteState(
  env: Env,
  version: string,
): { store: Store; state: StoreState; close(): void } | undefined {
  const path = storePath(env.FLEET_STATE);
  if (!existsSync(path)) return undefined;
  const store = openStore({ path, dir: env.FLEET_STATE });
  const state = new StoreState(store, {
    paths: { fleetState: env.FLEET_STATE, etc: env.FLEET_ETC, version },
  });
  return { store, state, close: () => store.close() };
}

/**
 * D8: is `meta.integrity_failed_at` set? Cheap enough for a per-request check on
 * the mutation path, and deliberately NOT consulted on the readonly path.
 */
export function integrityBlocked(env: Env): boolean {
  const path = storePath(env.FLEET_STATE);
  if (!existsSync(path)) return false;
  try {
    const store = openStore({ path, dir: env.FLEET_STATE, readonly: true });
    try {
      return store.userVersion() >= 1 && store.integrityFailedAt() !== undefined;
    } finally {
      store.close();
    }
  } catch {
    // A store that will not even open read-only is a refusal in its own right;
    // the mutation path treats it as blocked rather than writing blind.
    return true;
  }
}

function readIf(p: string): string | undefined {
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  } catch {
    return undefined;
  }
}
