// retire.ts — `fleet2 retire [--forget] [--dry-run] <grok-box-N>` (blueprint
// fleet2-state-store D4, Phase B).
//
// Un-enrolling a box used to be an operator editing `enrolled.tsv` by hand and
// hoping. That never worked: the discover probe reaches a box by PASSWORD over
// the tailnet, not through the tunnel, so the next tick simply re-adopted the
// name and the removal undid itself. `retire` is the gesture that sticks,
// because the RECORD of it is a store row that the candidate rule consults.
//
// What it does, in order:
//   1. `transition(enrolled -> retired)` (or `enrolling -> retired`, the
//      operator's abort for a saga that will not finish). The row is KEPT — it
//      is the history, and it is what keeps the name un-adoptable.
//   2. removes the VPS `authorized_keys` line for the box's port/key and
//      `$FLEET_ETC/authorized-keys.d/<box>.line` (note 2). The `authorized-keys.map`
//      row goes on its own: that file is EXPORTED from the enrolled rows.
//   3. revokes the recorded Tailscale key id through the existing revoke path,
//      BEST-EFFORT and logged. The node itself stays on the tailnet — removing a
//      machine from the tailnet is a different decision with a different blast
//      radius, and this command does not make it (r2-n8).
//   4. re-exports (D6), which also removes `<box>.expires` and `keys/<idx>.json`.
//
// It deliberately does NOT touch `known_hosts`: a reused name later goes through
// the D11 identity-binding path, which forgets the pin at the moment it rebinds.
//
// `--forget` DELETES the row instead of keeping it (cascading `box_counters`,
// `box_keys` and `alerts`), which frees the name to be an ordinary candidate
// again. `audit` rows are kept by design — `audit.box` is plain TEXT, not a
// foreign key, so the history of a forgotten box survives it.
//
// Re-adoption is an explicit operator gesture only: `fleet2 enroll <box>` on a
// retired name does `transition(retired -> enrolling)` on the SAME row and runs
// the saga.

import type { Env } from "../env.ts";
import type { Runner } from "../runner.ts";
import type { Store } from "../store/db.ts";
import type { StoreState } from "../store/state.ts";
import { RC } from "../upgrade.ts";
import { log } from "../log.ts";

/** The message `rename` and `fleet2 state` already print for a busy lock. */
export const RETIRE_BUSY_LINE =
  "reconcile busy — could not acquire the reconcile lock within 90s; refusing";

/** The side effects retire performs outside the store. */
export interface RetireOps {
  /**
   * Drop every VPS `authorized_keys` line bound to this box's port or key
   * material. Returns the number of lines removed, or undefined on an I/O
   * failure (which is rc 1 — the store write has not happened yet).
   */
  removeVpsAuthorizedKey(port: number, pubkey: string | null): number | undefined;
  /** Remove `$FLEET_ETC/authorized-keys.d/<box>.line`. False ⇒ could not. */
  removeEtcLine(box: string): boolean;
  /** DELETE the Tailscale auth key. Best-effort: a failure is logged, never fatal. */
  revokeKey(keyId: string): Promise<{ ok: boolean; code: number }>;
  /** `flock -w 90` on reconcile.lock, exactly as rename and `fleet2 state` probe it. */
  acquireLock(): Promise<"ok" | "busy" | "open-fail">;
}

export interface RetireStoreHandle {
  store: Store;
  state: StoreState;
  close(): void;
}

export interface RetireDeps {
  env: Env;
  runner: Runner;
  ops: RetireOps;
  notify: (level: "info" | "warn", msg: string) => Promise<void>;
  /** Open the store read-write. undefined ⇒ there is no store yet. */
  open: () => RetireStoreHandle | undefined;
  out?: (s: string) => void;
}

/**
 * Remove the authorized_keys lines that belong to a box: the ones carrying its
 * `permitlisten="127.0.0.1:<port>"` restriction, and the ones carrying its key
 * material. Pure, so the rule is testable without a VPS.
 *
 * Both classes go for the same reason `installVpsAuthorizedKey` drops both: a
 * box that regenerated its tunnel key leaves a line that still names the port,
 * and a box whose port was reassigned leaves a line that still carries the key.
 */
export function removeAuthorizedKeysLines(
  content: string,
  port: number,
  pubkey: string | null,
): { text: string; removed: number } {
  const material = pubkey === null || pubkey === "" ? "" : pubkey.trim().split(/\s+/).pop() ?? "";
  const needle = `permitlisten="127.0.0.1:${port}"`;
  const kept: string[] = [];
  let removed = 0;
  for (const line of content.split("\n")) {
    if (line === "") continue;
    if (line.includes(needle) || (material !== "" && line.includes(material))) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.length === 0 ? "" : kept.join("\n") + "\n", removed };
}

export interface RetireArgs {
  box: string;
  forget: boolean;
  dryRun: boolean;
}

export function parseRetireArgs(args: string[]): RetireArgs | { usage: true } {
  let forget = false;
  let dryRun = false;
  const rest: string[] = [];
  for (const a of args) {
    if (a === "--forget") forget = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("-")) return { usage: true };
    else rest.push(a);
  }
  const box = rest[0];
  if (box === undefined || box === "" || rest.length > 1) return { usage: true };
  return { box, forget, dryRun };
}

export async function cmdRetire(args: string[], deps: RetireDeps): Promise<number> {
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  const parsed = parseRetireArgs(args);
  if ("usage" in parsed) {
    log("usage: fleet2 retire [--forget] [--dry-run] <grok-box-N>");
    return RC.USAGE;
  }
  const { box, forget, dryRun } = parsed;
  if (!/^grok-box-[0-9]/.test(box)) {
    log(`retire: refusing non-grok box '${box}'`);
    return RC.USAGE;
  }

  const handle = deps.open();
  if (handle === undefined) {
    log(`retire: no state store under ${deps.env.FLEET_STATE} — nothing to retire (the first tick creates it)`);
    return RC.TARGET;
  }

  try {
    const row = handle.state.boxRow(box);
    if (row === undefined) {
      log(`retire: ${box} has no store row — nothing to retire`);
      return RC.USAGE;
    }
    if (row.phase === "retired" && !forget) {
      out(`retire: ${box} is already retired (retired_at=${row.retired_at ?? "?"})\n`);
      return RC.OK;
    }

    if (dryRun) {
      out(`retire: DRY-RUN ${box} (phase ${row.phase}${forget ? ", --forget" : ""})\n`);
      out(`retire:   store row      ${forget ? "DELETED (counters, key row and alerts cascade)" : `${row.phase} -> retired (row kept)`}\n`);
      out(`retire:   VPS authorized_keys line for port ${row.port ?? "?"} removed\n`);
      out(`retire:   ${deps.env.FLEET_ETC}/authorized-keys.d/${box}.line removed\n`);
      out(`retire:   Tailscale key ${handle.state.keyMetaId(0, box) ?? "(none recorded)"} revoked (best-effort)\n`);
      out(`retire:   enrolled.tsv + authorized-keys.map + ${box}.expires + keys/${row.idx ?? "?"}.json re-exported\n`);
      out(`retire:   known_hosts pin LEFT (a reused name rebinds through the identity path)\n`);
      return RC.OK;
    }

    // A membership mutation takes the reconcile lock, exactly as rename and
    // `fleet2 state reconcile-files --apply` do (r4-B4).
    const got = await deps.ops.acquireLock();
    if (got === "open-fail") {
      log(`retire: cannot open ${deps.env.FLEET_STATE}/reconcile.lock (is util-linux flock installed?)`);
      return RC.FAILURE;
    }
    if (got !== "ok") {
      log(RETIRE_BUSY_LINE);
      return RC.LOCK_BUSY;
    }

    // (2) the VPS-side artefacts, BEFORE the store write: if the file cannot be
    // rewritten the box keeps its trusted line, and a store row saying `retired`
    // next to a live authorized_keys line is the one state this command must not
    // produce.
    const removed = deps.ops.removeVpsAuthorizedKey(row.port ?? -1, row.pubkey);
    if (removed === undefined) {
      log(`retire: ABORT — could not rewrite the VPS authorized_keys for ${box}; nothing changed`);
      return RC.FAILURE;
    }
    log(`retire: removed ${removed} VPS authorized_keys line(s) for ${box} (port ${row.port ?? "?"})`);
    if (!deps.ops.removeEtcLine(box)) {
      log(`retire: WARNING could not remove ${deps.env.FLEET_ETC}/authorized-keys.d/${box}.line`);
    }

    // (3) revoke the recorded key. Best-effort and logged: the key expires on
    // its own, and a failing Tailscale API must not leave the membership half
    // written.
    const keyId = handle.state.keyMetaId(0, box);
    if (keyId !== undefined && keyId !== "") {
      const del = await deps.ops.revokeKey(keyId);
      if (del.ok) log(`retire: revoked Tailscale key id=${keyId} (HTTP ${del.code})`);
      else log(`retire: key id=${keyId} revoke FAILED (HTTP ${del.code}) — it will lapse at its own expiry`);
    } else {
      log(`retire: ${box} has no recorded key id — nothing to revoke`);
    }

    // (1)+(4) the store write and the export. Dropping the key row first makes
    // the export REMOVE `<box>.expires` and `keys/<idx>.json` rather than leaving
    // a retired box's key material on disk (D6 export set).
    handle.state.dropKeyRow(box);
    handle.state.exportKeysFor(box);
    if (forget) {
      handle.state.deleteBox(box);
      handle.store.audit({ actor: "operator", action: "retire-forget", box, rc: 0, detail: `was ${row.phase}` });
      out(`retire: ${box} FORGOTTEN — row deleted; the name is an ordinary discovery candidate again\n`);
    } else {
      const t = handle.state.transition(box, row.phase, "retired", "operator", "fleet2 retire");
      if (t.rc !== 0) {
        log(`retire: ${t.message}`);
        return RC.FAILURE;
      }
      out(`retire: ${box} retired (row kept; the name is NOT adoptable — 'fleet2 enroll ${box}' revives it)\n`);
    }

    const errs = handle.state.takeExportErrors();
    await deps.notify("info", `retired ${box}${forget ? " (forgotten)" : ""}`);
    if (errs.length > 0) {
      const msg = `retire: ${box} recorded; export failed: ${errs[0]}`;
      log(msg);
      await deps.notify("warn", msg);
      return RC.EXPORT_FAILED;
    }
    return RC.OK;
  } finally {
    handle.close();
  }
}
