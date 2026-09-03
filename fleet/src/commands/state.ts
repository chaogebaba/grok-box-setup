// commands/state.ts — `grokfleet state <sub>` (blueprint fleet2-state-store D6/D8).
//
//   grokfleet state check                    read-only report + quick_check
//   grokfleet state backup                   force today's backup now
//   grokfleet state restore <file>           copy a backup over fleet.db
//   grokfleet state import [--force]         replay the 5.7.1 files into the store
//   grokfleet state reconcile-files [--apply] resolve a reported divergence
//
// Exit codes: 0 ok, 2 usage, 3 config/integrity (RC.TARGET), 6 the reconcile
// lock was busy for the whole 90 s wait (RC.LOCK_BUSY), 7 recorded but the
// legacy export failed (RC.EXPORT_FAILED).

import type { Env } from "../env.ts";
import type { Runner } from "../runner.ts";
import { RC } from "../upgrade.ts";
import { ConfigError, openStore, storePath, type Store } from "../store/db.ts";
import { KNOWN_SCHEMA } from "../store/schema.ts";
import { StoreState, resolvePort } from "../store/state.ts";
import { exportAll, importLegacy, parseAuthorizedKeysMap } from "../store/legacy.ts";
import { currentFindings } from "../store/divergence.ts";
import { backupDir, dailyMaintenance, restoreFile } from "../store/backup.ts";
import { boxIndex } from "../boxes.ts";
import { log } from "../log.ts";
import { existsSync, readFileSync, readdirSync } from "node:fs";

/** The message `rename` already prints for the same condition. */
export const RECONCILE_BUSY_LINE =
  "reconcile busy — could not acquire the reconcile lock within 90s; refusing";

export interface StateCmdDeps {
  env: Env;
  runner: Runner;
  version: string;
  notify: (level: "info" | "warn", msg: string) => Promise<void>;
  /** injectable lock seam; production probes `flock -w 90` exactly as rename does. */
  acquireLock?: () => Promise<"ok" | "busy" | "open-fail">;
  out?: (s: string) => void;
  now?: () => number;
  /** agent-ux U2: emit ONE JSON document on stdout instead of the human table. */
  json?: boolean;
}

function stdout(deps: StateCmdDeps): (s: string) => void {
  return deps.out ?? ((s) => process.stdout.write(s));
}

/**
 * `flock -w 90 $FLEET_STATE/reconcile.lock -c :`, the same probe
 * `rename-wiring.ts:228` uses. It proves the lock was free within the window
 * rather than holding it for the command's duration — deliberately identical to
 * the existing rename behaviour so both commands refuse in the same conditions.
 */
export function makeLockProbe(env: Env, runner: Runner): () => Promise<"ok" | "busy" | "open-fail"> {
  return async () => {
    if (Bun.which("flock") === null) return "open-fail";
    const r = await runner.run(["flock", "-w", "90", `${env.FLEET_STATE}/reconcile.lock`, "-c", ":"], {
      timeoutMs: 95_000,
    });
    return r.code === 0 ? "ok" : "busy";
  };
}

export async function cmdState(rest: string[], deps: StateCmdDeps): Promise<number> {
  const sub = rest[0];
  const args = rest.slice(1);
  switch (sub) {
    case "check":
      return stateCheck(deps);
    case "backup":
      return stateBackup(deps);
    case "restore":
      return stateRestore(args, deps);
    case "import":
      return stateImport(args, deps);
    case "reconcile-files":
      return stateReconcileFiles(args, deps);
    default:
      log(
        "usage: grokfleet state <check|backup|restore <file>|import [--force]|reconcile-files [--apply]>",
      );
      return RC.USAGE;
  }
}

// --- check -------------------------------------------------------------------

/**
 * READ-ONLY (D8/r3-n3): no migrations, no divergence check, no writes at all —
 * except the ONE statement that clears a set integrity flag when the check
 * passes, which happens through a separate read-write reopen under the lock.
 */
async function stateCheck(deps: StateCmdDeps): Promise<number> {
  const out = stdout(deps);
  const json = deps.json === true;
  const path = storePath(deps.env.FLEET_STATE);
  if (!existsSync(path)) {
    if (json) out(JSON.stringify({ store: path, present: false }, null, 2) + "\n");
    else out(`state check: no store at ${path} (it is created by the first tick)\n`);
    return RC.OK;
  }

  let store: Store;
  try {
    store = openStore({ path, dir: deps.env.FLEET_STATE, readonly: true, now: deps.now });
  } catch (e) {
    if (e instanceof ConfigError) {
      log(e.message);
      await deps.notify("warn", e.message);
      return RC.TARGET;
    }
    throw e;
  }

  const verdict = store.quickCheck();
  const flagged = store.integrityFailedAt();
  if (json) {
    // ONE document, no trailing prose (U2). Same facts as the table.
    out(
      JSON.stringify(
        {
          store: path,
          present: true,
          schema: {
            user_version: store.userVersion(),
            min_reader: store.meta("min_reader") ?? null,
            known: KNOWN_SCHEMA,
          },
          legacy_import: {
            at: store.meta("legacy_imported_at") ?? null,
            source: store.meta("legacy_import_source") ?? null,
          },
          last_backup: {
            date: store.meta("last_backup_date") ?? null,
            kept: countBackups(deps.env.FLEET_STATE),
          },
          quick_check: verdict,
          integrity: flagged === undefined ? "ok" : "failed",
          integrity_failed_at: flagged === undefined ? null : new Date(flagged * 1000).toISOString(),
          boxes: boxRowsJson(store),
          divergence: findingsJson(store),
          warnings: portWarnings(store),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    out(`store         ${path}\n`);
    out(`schema        user_version=${store.userVersion()} min_reader=${store.meta("min_reader") ?? "?"} (this grokfleet knows ${KNOWN_SCHEMA})\n`);
    out(`legacy import ${store.meta("legacy_imported_at") ?? "never"} (source=${store.meta("legacy_import_source") ?? "-"})\n`);
    out(`last backup   ${store.meta("last_backup_date") ?? "never"} (${countBackups(deps.env.FLEET_STATE)} kept)\n`);
    out(`quick_check   ${verdict}\n`);
    out(`integrity     ${flagged === undefined ? "ok" : `FAILED at ${new Date(flagged * 1000).toISOString()}`}\n`);

    printRows(out, store);
    printFindings(out, store);
    printPortWarnings(out, store);
  }

  if (verdict !== "ok") {
    store.close();
    const msg = `state check: quick_check FAILED on ${path} — ${verdict}`;
    log(msg);
    await deps.notify("warn", msg);
    return RC.TARGET;
  }

  store.close();

  if (flagged === undefined) return RC.OK;

  // The check passed and the flag is set: clear it. That single statement needs
  // a read-write handle, and it must not race a tick, so it takes the reconcile
  // lock. On a timeout the (passing) result above still stands — we simply leave
  // the flag set and say so.
  const lock = deps.acquireLock ?? makeLockProbe(deps.env, deps.runner);
  const got = await lock();
  if (got !== "ok") {
    // U4: a non-zero rc is never silent AND never explained on stdout — stdout
    // is data (the report above, possibly JSON). Both lines go to the journal.
    log(
      `state check: ${RECONCILE_BUSY_LINE} — integrity flag left SET; re-run when the tick is idle`,
    );
    return RC.LOCK_BUSY;
  }
  const rw = openStore({ path, dir: deps.env.FLEET_STATE, now: deps.now });
  rw.clearIntegrityFailed();
  rw.audit({ actor: "operator", action: "integrity-cleared", rc: 0 });
  rw.close();
  out("integrity flag CLEARED (quick_check ok)\n");
  return RC.OK;
}

function countBackups(fleetState: string): number {
  try {
    return readdirSync(backupDir(fleetState)).filter((f) => /^fleet-\d{4}-\d{2}-\d{2}\.db$/.test(f)).length;
  } catch {
    return 0;
  }
}

function printRows(out: (s: string) => void, store: Store): void {
  const rows = store.db
    .query("SELECT name, idx, port, phase, enrol_stage, enrol_warn FROM boxes ORDER BY phase, name")
    .all() as Array<{ name: string; idx: number | null; port: number | null; phase: string; enrol_stage: number; enrol_warn: string | null }>;
  const enrolled = rows.filter((r) => r.phase === "enrolled");
  out(`boxes         ${enrolled.length} enrolled, ${rows.filter((r) => r.phase === "enrolling").length} enrolling, ${rows.filter((r) => r.phase === "retired").length} retired\n`);
  for (const r of rows) {
    if (r.phase === "enrolled") continue;
    // `state check` lists the non-enrolled rows and nothing about their
    // ONLINE-ness: that is a Tailscale fact this local check does not have.
    out(`  ${r.phase.padEnd(9)} ${r.name}\tport=${r.port ?? "-"}\tstage=${r.enrol_stage}${r.enrol_warn ? `\twarn=${r.enrol_warn}` : ""}\n`);
  }
}

// --- the same facts as data (agent-ux U2) ------------------------------------

interface BoxRowJson {
  name: string;
  idx: number | null;
  port: number | null;
  phase: string;
  enrol_stage: number;
  enrol_warn: string | null;
}

function allBoxRows(store: Store): BoxRowJson[] {
  return store.db
    .query("SELECT name, idx, port, phase, enrol_stage, enrol_warn FROM boxes ORDER BY phase, name")
    .all() as BoxRowJson[];
}

function boxRowsJson(store: Store): {
  enrolled: number;
  enrolling: number;
  retired: number;
  rows: BoxRowJson[];
} {
  const rows = allBoxRows(store);
  return {
    enrolled: rows.filter((r) => r.phase === "enrolled").length,
    enrolling: rows.filter((r) => r.phase === "enrolling").length,
    retired: rows.filter((r) => r.phase === "retired").length,
    rows,
  };
}

function findingsJson(store: Store): Array<{ kind: string; name: string; first_seen: string; last_seen: string }> {
  return currentFindings(store).map((r) => ({
    kind: r.kind,
    name: r.name,
    first_seen: new Date(r.first_seen * 1000).toISOString(),
    last_seen: new Date(r.last_seen * 1000).toISOString(),
  }));
}

/** The two WARNING conditions `printPortWarnings` renders, as strings. */
function portWarnings(store: Store): string[] {
  const w: string[] = [];
  const dup = store.db
    .query(
      `SELECT port, GROUP_CONCAT(name, ' ') AS names, COUNT(*) AS n
       FROM boxes WHERE phase = 'enrolled' AND port IS NOT NULL GROUP BY port HAVING n > 1`,
    )
    .all() as Array<{ port: number; names: string; n: number }>;
  for (const d of dup) {
    w.push(`port ${d.port} is held by ${d.n} enrolled rows: ${d.names} (expected only inside a rename window)`);
  }
  const noPort = store.db
    .query("SELECT name FROM boxes WHERE phase = 'enrolled' AND port IS NULL")
    .all() as Array<{ name: string }>;
  for (const r of noPort) w.push(`${r.name} has no port (unparseable index) — the tick skips it`);
  return w;
}

function printFindings(out: (s: string) => void, store: Store): void {
  const f = currentFindings(store);
  if (f.length === 0) {
    out("divergence    none\n");
    return;
  }
  out(`divergence    ${f.length} finding(s)\n`);
  for (const r of f) {
    out(
      `  ${r.kind.padEnd(10)} ${r.name}\tfirst_seen=${new Date(r.first_seen * 1000).toISOString()}\tlast_seen=${new Date(r.last_seen * 1000).toISOString()}\n`,
    );
  }
}

/**
 * The "no two ENROLLED rows share a port outside a rename window" invariant is a
 * WARNING here, never a schema constraint (D3): the rename window legitimately
 * holds two rows on one port.
 */
function printPortWarnings(out: (s: string) => void, store: Store): void {
  const dup = store.db
    .query(
      `SELECT port, GROUP_CONCAT(name, ' ') AS names, COUNT(*) AS n
       FROM boxes WHERE phase = 'enrolled' AND port IS NOT NULL GROUP BY port HAVING n > 1`,
    )
    .all() as Array<{ port: number; names: string; n: number }>;
  for (const d of dup) {
    out(`WARNING       port ${d.port} is held by ${d.n} enrolled rows: ${d.names} (expected only inside a rename window)\n`);
  }
  const noPort = store.db
    .query("SELECT name FROM boxes WHERE phase = 'enrolled' AND port IS NULL")
    .all() as Array<{ name: string }>;
  for (const r of noPort) {
    out(`WARNING       ${r.name} has no port (unparseable index) — the tick skips it\n`);
  }
}

// --- backup / restore --------------------------------------------------------

async function stateBackup(deps: StateCmdDeps): Promise<number> {
  const out = stdout(deps);
  const store = openStore({ path: storePath(deps.env.FLEET_STATE), dir: deps.env.FLEET_STATE, now: deps.now });
  const r = dailyMaintenance(store, { fleetState: deps.env.FLEET_STATE, force: true });
  store.close();
  if (r.integrityFailed !== undefined) {
    const msg = `state backup: quick_check FAILED (${r.integrityFailed}) — no backup taken; integrity flag set`;
    log(msg);
    await deps.notify("warn", msg);
    return RC.TARGET;
  }
  out(`backup ${r.file} (quick_check ${r.quickCheck}, ${r.ms}ms)\n`);
  if (r.pruned && r.pruned.length > 0) out(`pruned ${r.pruned.join(", ")}\n`);
  return RC.OK;
}

async function stateRestore(args: string[], deps: StateCmdDeps): Promise<number> {
  const out = stdout(deps);
  const from = args[0];
  if (from === undefined) {
    log("usage: grokfleet state restore <backup-file>");
    return RC.USAGE;
  }
  const path = storePath(deps.env.FLEET_STATE);
  const r = restoreFile({ fleetState: deps.env.FLEET_STATE, from, dbPath: path });
  if (r.rc !== 0) {
    log(r.message);
    return r.rc;
  }
  out(`${r.message}\n`);
  const store = openStore({ path, dir: deps.env.FLEET_STATE, now: deps.now });
  const verdict = store.quickCheck();
  if (verdict !== "ok") {
    store.close();
    const msg = `state restore: the restored file FAILS quick_check (${verdict}) — flag left set`;
    log(msg);
    await deps.notify("warn", msg);
    return RC.TARGET;
  }
  store.clearIntegrityFailed();
  store.audit({ actor: "operator", action: "restore", rc: 0, detail: from });
  const rows = (store.db.query("SELECT COUNT(*) AS n FROM boxes").get() as { n: number }).n;
  store.close();
  out(`quick_check ok — ${rows} box row(s); integrity flag cleared\n`);
  return RC.OK;
}

// --- import ------------------------------------------------------------------

async function stateImport(args: string[], deps: StateCmdDeps): Promise<number> {
  const out = stdout(deps);
  const force = args.includes("--force");
  const unknown = args.find((a) => a.startsWith("--") && a !== "--force");
  if (unknown !== undefined) {
    log(`state import: unknown flag ${unknown}`);
    return RC.USAGE;
  }
  // `--force` mutates membership, so it takes the reconcile lock exactly as
  // rename does (r4-B4).
  if (force) {
    const lock = deps.acquireLock ?? makeLockProbe(deps.env, deps.runner);
    const got = await lock();
    if (got !== "ok") {
      log(RECONCILE_BUSY_LINE);
      return RC.LOCK_BUSY;
    }
  }
  const store = openStore({ path: storePath(deps.env.FLEET_STATE), dir: deps.env.FLEET_STATE, now: deps.now });
  let outcome;
  try {
    outcome = importLegacy(store, { fleetState: deps.env.FLEET_STATE, etc: deps.env.FLEET_ETC, force });
  } catch (e) {
    store.close();
    if (e instanceof ConfigError) {
      log(e.message);
      await deps.notify("warn", e.message);
      return RC.TARGET;
    }
    throw e;
  }
  if (outcome.kind === "already") {
    out("state import: already imported (meta.legacy_imported_at is set) — use --force to replay\n");
    store.close();
    return RC.OK;
  }
  if (outcome.kind === "fresh") {
    out("state import: no enrolled.tsv — recorded a fresh store\n");
    store.close();
    return RC.OK;
  }
  const st = new StoreState(store, {
    paths: { fleetState: deps.env.FLEET_STATE, etc: deps.env.FLEET_ETC, version: deps.version },
  });
  st.exportAll();
  const errs = st.takeExportErrors();
  store.close();
  out(`state import: ${outcome.boxes} box(es), ${outcome.keys} key row(s), ${outcome.ledger} ledger record(s)\n`);
  if (errs.length > 0) {
    const msg = `state import: recorded; export failed: ${errs[0]}`;
    log(msg);
    await deps.notify("warn", msg);
    return RC.EXPORT_FAILED;
  }
  return RC.OK;
}

// --- reconcile-files ---------------------------------------------------------

/**
 * D6: dry-run by default. `--apply` imports FILE-ONLY rows with the D6 import
 * values (pubkey from `authorized-keys.map`), reviving a `retired` row rather
 * than inserting a second one, and deletes the finding it resolved. STORE-ONLY
 * rows are only PRINTED, with the `retire` command the operator may run —
 * automatic retirement is out of scope, deliberately.
 */
async function stateReconcileFiles(args: string[], deps: StateCmdDeps): Promise<number> {
  const raw = stdout(deps);
  const json = deps.json === true;
  // U2: with --json the ONLY thing on stdout is the one document, so the human
  // prose is suppressed at the sink rather than at every call site.
  const out = (s: string): void => {
    if (!json) raw(s);
  };
  const entries: Array<{ kind: string; name: string; port_column?: string | null; action: string }> = [];
  const apply = args.includes("--apply");
  const unknown = args.find((a) => a.startsWith("--") && a !== "--apply" && a !== "--json");
  if (unknown !== undefined) {
    log(`state reconcile-files: unknown flag ${unknown}`);
    return RC.USAGE;
  }
  if (apply) {
    const lock = deps.acquireLock ?? makeLockProbe(deps.env, deps.runner);
    const got = await lock();
    if (got !== "ok") {
      log(RECONCILE_BUSY_LINE);
      return RC.LOCK_BUSY;
    }
  }

  const store = openStore({ path: storePath(deps.env.FLEET_STATE), dir: deps.env.FLEET_STATE, now: deps.now });
  const findings = currentFindings(store);
  if (findings.length === 0) {
    out("state reconcile-files: no divergence findings\n");
    if (json) raw(JSON.stringify({ apply, findings: [] }, null, 2) + "\n");
    store.close();
    return RC.OK;
  }

  const enrolledPath = `${deps.env.FLEET_STATE}/enrolled.tsv`;
  const fileRows = readFileRows(enrolledPath);
  const pubkeys = parseAuthorizedKeysMap(readIf(`${deps.env.FLEET_ETC}/authorized-keys.map`));
  const st = new StoreState(store, {
    paths: { fleetState: deps.env.FLEET_STATE, etc: deps.env.FLEET_ETC, version: deps.version },
  });

  let adopted = 0;
  for (const f of findings) {
    if (f.kind === "store-only") {
      out(`store-only ${f.name} — the file lacks this enrolled row; the next export restores it.\n`);
      out(`           to remove the box instead:  grokfleet retire ${f.name}\n`);
      entries.push({ kind: "store-only", name: f.name, action: "none" });
      continue;
    }
    const rawPort = fileRows.get(f.name);
    if (!apply) {
      out(`file-only  ${f.name} (port column ${JSON.stringify(rawPort ?? "")}) — would import into the store\n`);
      entries.push({ kind: "file-only", name: f.name, port_column: rawPort ?? null, action: "would-import" });
      continue;
    }
    const { port, warn } = resolvePort(f.name, rawPort);
    if (warn !== undefined) log(warn);
    const at = store.now();
    const existing = st.boxRow(f.name);
    store.tx(() => {
      if (existing !== undefined) {
        // A name that matches a RETIRED (or enrolling) row is REVIVED on the
        // same row — never a second INSERT (D6/r5-n3).
        store.db
          .query(
            `UPDATE boxes SET phase='enrolled', port=?, idx=?, retired_at=NULL, updated_at=?,
                              pubkey=COALESCE(?,pubkey) WHERE box_id=?`,
          )
          .run(port, boxIndex(f.name) ?? null, at, pubkeys.get(f.name) ?? null, existing.box_id);
        store.audit({
          actor: "operator",
          action: "reconcile-files-revive",
          box: f.name,
          rc: 0,
          at,
          detail: `${existing.phase} -> enrolled`,
        });
      } else {
        store.db
          .query(
            `INSERT INTO boxes(name,idx,port,phase,created_at,enrolled_at,updated_at,pubkey)
             VALUES(?,?,?,'enrolled',?,NULL,?,?)`,
          )
          .run(f.name, boxIndex(f.name) ?? null, port, at, at, pubkeys.get(f.name) ?? null);
        store.audit({ actor: "operator", action: "reconcile-files-import", box: f.name, rc: 0, at });
      }
      store.db.query("DELETE FROM divergence_findings WHERE name = ?").run(f.name);
      store.audit({ actor: "operator", action: "divergence-cleared", box: f.name, at, detail: "reconcile-files" });
    });
    adopted += 1;
    out(`file-only  ${f.name} — imported (port=${port ?? "-"}, pubkey=${pubkeys.has(f.name) ? "from map" : "none"})\n`);
    entries.push({ kind: "file-only", name: f.name, port_column: rawPort ?? null, action: "imported" });
  }

  if (apply && adopted > 0) {
    exportAllSafely(st, out);
  }
  const errs = st.takeExportErrors();
  store.close();
  if (!apply) out("state reconcile-files: dry-run — re-run with --apply to act\n");
  if (json) raw(JSON.stringify({ apply, findings: entries }, null, 2) + "\n");
  if (errs.length > 0) {
    const msg = `state reconcile-files: recorded; export failed: ${errs[0]}`;
    log(msg);
    await deps.notify("warn", msg);
    return RC.EXPORT_FAILED;
  }
  return RC.OK;
}

function exportAllSafely(st: StoreState, out: (s: string) => void): void {
  st.exportAll();
  if (!st.hasExportError()) out("exported enrolled.tsv + authorized-keys.map\n");
}

function readFileRows(path: string): Map<string, string | undefined> {
  const m = new Map<string, string | undefined>();
  const raw = readIf(path);
  if (raw === undefined) return m;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const f = t.split("\t");
    const name = (f[0] ?? "").trim();
    if (name === "" || m.has(name)) continue;
    m.set(name, f[1]);
  }
  return m;
}

function readIf(p: string): string | undefined {
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** Re-exported so the CLI can print `exportAll` results without importing legacy. */
export { exportAll };
