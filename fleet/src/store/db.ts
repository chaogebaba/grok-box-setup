// db.ts — the ONLY module in grokfleet that imports `bun:sqlite` (blueprint
// fleet2-state-store D1). Everything else goes through `Store`.
//
// D1 open sequence, IN THIS ORDER:
//   1. `process.umask(0o077)` — a deliberate tightening. 5.7.1 writes
//      `enrolled.tsv`, `discover.json` and the counter files at the default
//      umask (0644); both systemd units run as root so nothing else reads them.
//      After a rollback 5.7.1 rewrites its files at its own umask (cosmetic).
//   2. `new Database(path, { create: true })`.
//   3. `PRAGMA foreign_keys=ON` — BEFORE any transaction; it is a NO-OP inside
//      one, so running it later would silently leave the CASCADEs off.
//   4. `PRAGMA journal_mode=WAL; synchronous=NORMAL; busy_timeout=5000`.
//   5. `chmod 0600` on `fleet.db`, `fleet.db-wal`, `fleet.db-shm` (the sidecars
//      only exist after the WAL pragma's first write, so chmod each that exists,
//      and again after migrations have written).
//
// Tables are declared STRICT for real type enforcement. bun's `strict: true`
// Database option is PARAMETER-BINDING strictness, a different thing, and is not
// used here. Positional `?N` gaps are never used (oven-sh/bun#37211).
//
// A read-only or unwritable `$FLEET_STATE` is a ConfigError (rc 3) naming the
// directory and the errno: 5.7.1's swallow-and-continue for counters was bash
// parity, and a tick that cannot persist must not pretend it did.

import { Database } from "bun:sqlite";
import { accessSync, chmodSync, constants, existsSync, mkdirSync } from "node:fs";
import { KNOWN_SCHEMA, MIGRATIONS } from "./schema.ts";
import { log } from "../log.ts";

/** Configuration/environment refusal — the CLI maps this to rc 3 (RC.TARGET). */
export class ConfigError extends Error {
  readonly rc = 3;
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface OpenOptions {
  /** the database file, or ":memory:" for the test seam. */
  path: string;
  /**
   * `$FLEET_STATE`. Defaults to the dirname of `path`. Used for the writability
   * check and named in the ConfigError. Ignored for ":memory:".
   */
  dir?: string;
  /**
   * Open READ-ONLY: no migrations, no writes, no divergence check (D8 — this is
   * what `grokfleet state check` and the readonly API endpoints use).
   */
  readonly?: boolean;
  /** epoch-seconds clock, injected by tests. */
  now?: () => number;
}

function errnoOf(e: unknown): string {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : e instanceof Error ? e.message : String(e);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The store handle. Owns the connection, the schema version contract and the
 * small primitives every other store module builds on (meta, transactions,
 * audit, quick_check).
 */
export class Store {
  readonly db: Database;
  readonly path: string;
  readonly dir: string;
  readonly readonly: boolean;
  readonly now: () => number;

  constructor(db: Database, path: string, dir: string, ro: boolean, now: () => number) {
    this.db = db;
    this.path = path;
    this.dir = dir;
    this.readonly = ro;
    this.now = now;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* best-effort */
    }
  }

  // --- schema / meta ---------------------------------------------------------

  userVersion(): number {
    const r = this.db.query("PRAGMA user_version").get() as { user_version?: number } | null;
    return r?.user_version ?? 0;
  }

  meta(key: string): string | undefined {
    const r = this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value?: string } | null;
    return r?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.query("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
      key,
      value,
    );
  }

  deleteMeta(key: string): void {
    this.db.query("DELETE FROM meta WHERE key = ?").run(key);
  }

  /** Run `fn` inside ONE transaction (rolled back if it throws). */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // --- audit -----------------------------------------------------------------

  /**
   * Append one `audit` row. The FILE `audit.log` is untouched by this — the two
   * records are deliberately separate in Phase A (D3).
   */
  audit(row: {
    actor: string;
    action: string;
    box?: string | null;
    rc?: number | null;
    job?: string | null;
    detail?: string | null;
    at?: number;
  }): void {
    this.db
      .query("INSERT INTO audit(at,actor,action,box,rc,job,detail) VALUES(?,?,?,?,?,?,?)")
      .run(
        row.at ?? this.now(),
        row.actor,
        row.action,
        row.box ?? null,
        row.rc ?? null,
        row.job ?? null,
        row.detail ?? null,
      );
  }

  /** D3 retention: 92 days of `audit`, once per tick. Returns rows deleted. */
  pruneAudit(retentionDays: number, at: number = this.now()): number {
    const cutoff = at - retentionDays * 86400;
    const r = this.db.query("DELETE FROM audit WHERE at < ?").run(cutoff);
    return Number(r.changes ?? 0);
  }

  // --- integrity (D8) --------------------------------------------------------

  /**
   * `PRAGMA quick_check` — returns "ok" or the first failure line. Deliberately
   * NOT `integrity_check`: quick_check skips the (expensive) index-content pass
   * and is what the once-a-day backup step can afford on the tick path.
   */
  quickCheck(): string {
    try {
      const rows = this.db.query("PRAGMA quick_check").all() as Array<{ quick_check?: string }>;
      const first = rows[0]?.quick_check ?? "ok";
      return first;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  integrityFailedAt(): number | undefined {
    const v = this.meta("integrity_failed_at");
    if (v === undefined) return undefined;
    return /^[0-9]+$/.test(v) ? Number.parseInt(v, 10) : undefined;
  }

  setIntegrityFailed(at: number = this.now()): void {
    this.setMeta("integrity_failed_at", String(at));
  }

  clearIntegrityFailed(): void {
    this.deleteMeta("integrity_failed_at");
  }

  /** chmod 0600 on the db and both sidecars (each one that exists). */
  chmodAll(): void {
    if (this.path === ":memory:") return;
    for (const p of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try {
        if (existsSync(p)) chmodSync(p, 0o600);
      } catch {
        /* best-effort: a chmod failure on a file we just created is not fatal */
      }
    }
  }
}

/** The default store path under `$FLEET_STATE`. */
export function storePath(fleetState: string): string {
  return `${fleetState}/fleet.db`;
}

/**
 * Open (and, unless `readonly`, migrate) the state store.
 *
 * Throws `ConfigError` (rc 3) when the directory is unwritable, when the file
 * cannot be opened, or when the file's `user_version` is NEWER than this binary
 * knows and its `min_reader` says this binary must not operate it (D2).
 */
export function openStore(opts: OpenOptions): Store {
  const inMemory = opts.path === ":memory:";
  const dir = opts.dir ?? (inMemory ? ":memory:" : opts.path.replace(/\/[^/]*$/, ""));
  const ro = opts.readonly === true;
  const now = opts.now ?? nowSec;

  // (1) umask BEFORE the file is created, so the db and both sidecars are born
  // 0600 rather than being widened for the instant before the chmod lands.
  process.umask(0o077);

  if (!inMemory && !ro) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      throw new ConfigError(
        `state store: cannot create state directory ${dir} (${errnoOf(e)}) — refusing to run a tick that cannot persist`,
      );
    }
    try {
      accessSync(dir, constants.W_OK);
    } catch (e) {
      throw new ConfigError(
        `state store: state directory ${dir} is not writable (${errnoOf(e)}) — refusing to run a tick that cannot persist`,
      );
    }
    if (existsSync(opts.path)) {
      try {
        accessSync(opts.path, constants.W_OK);
      } catch (e) {
        throw new ConfigError(
          `state store: ${opts.path} is not writable (${errnoOf(e)}) — refusing to run a tick that cannot persist`,
        );
      }
    }
  }

  // (2) open.
  let db: Database;
  try {
    db = ro && !inMemory ? new Database(opts.path, { readonly: true }) : new Database(opts.path, { create: true });
  } catch (e) {
    throw new ConfigError(`state store: cannot open ${opts.path} in ${dir} (${errnoOf(e)})`);
  }

  // (3) foreign_keys BEFORE any transaction — a no-op inside one (note 8).
  try {
    db.run("PRAGMA foreign_keys = ON");
    // (4) durability/concurrency pragmas. WAL is what lets the readonly API
    // endpoints read a consistent snapshot while a tick writes (survey §4e).
    if (!ro) db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA busy_timeout = 5000");
  } catch (e) {
    db.close();
    throw new ConfigError(
      `state store: ${opts.path} in ${dir} rejected its pragmas (${errnoOf(e)}) — is the filesystem read-only?`,
    );
  }

  const store = new Store(db, opts.path, dir, ro, now);
  // (5) chmod the file and whichever sidecars the WAL pragma has created.
  store.chmodAll();

  const current = store.userVersion();

  if (current > KNOWN_SCHEMA) {
    // D2: a NEWER file opens only when its min_reader allows this binary. This
    // is the Phase B → Phase A rollback path.
    const minReaderRaw = safeMinReader(store);
    if (minReaderRaw === undefined || minReaderRaw > KNOWN_SCHEMA) {
      store.close();
      throw new ConfigError(
        `state store: ${opts.path} is schema user_version=${current} min_reader=${minReaderRaw ?? "unknown"}; ` +
          `this grokfleet knows schema ${KNOWN_SCHEMA} and must not operate it — install a newer grokfleet`,
      );
    }
    log(`state store: ${opts.path} user_version=${current} min_reader=${minReaderRaw} — opening as a schema-${KNOWN_SCHEMA} reader`);
    return store;
  }

  if (ro) {
    // D8: `state check` and the readonly readers never migrate. An un-migrated
    // file opened read-only is reported by the caller, not repaired here.
    return store;
  }

  if (current < KNOWN_SCHEMA) {
    try {
      migrate(store, current);
    } catch (e) {
      store.close();
      if (e instanceof ConfigError) throw e;
      throw new ConfigError(
        `state store: migrating ${opts.path} in ${dir} failed (${errnoOf(e)}) — refusing to run a tick that cannot persist`,
      );
    }
    // chmod again: migration 1 is the first WRITE, so `-wal`/`-shm` may only now
    // exist (D1).
    store.chmodAll();
  }

  return store;
}

/** `meta.min_reader` read defensively — a v>KNOWN file may have any shape. */
function safeMinReader(store: Store): number | undefined {
  try {
    const v = store.meta("min_reader");
    if (v === undefined || !/^[0-9]+$/.test(v)) return undefined;
    return Number.parseInt(v, 10);
  } catch {
    return undefined;
  }
}

/** Forward-only migrations; each one in its OWN transaction (D2). */
function migrate(store: Store, from: number): void {
  for (const m of MIGRATIONS) {
    if (m.to <= from) continue;
    store.tx(() => {
      for (const s of m.statements) store.db.run(s);
      // The bump lives INSIDE the transaction, so a crash between the DDL and
      // the bump rolls the whole migration back and the next open replays it.
      store.db.run(`PRAGMA user_version = ${m.to}`);
      store.setMeta("min_reader", String(m.minReader));
      if (store.meta("schema_created_at") === undefined) {
        store.setMeta("schema_created_at", String(store.now()));
      }
    });
    log(`state store: migrated ${store.path} to schema ${m.to} (min_reader ${m.minReader})`);
  }
}
