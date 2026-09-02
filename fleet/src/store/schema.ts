// schema.ts — the fleet2 state-store schema (blueprint fleet2-state-store D2/D3).
//
// ONE schema number lives in `PRAGMA user_version`; `meta.min_reader` is the
// LOWEST schema number that can still operate a file at that version. Every
// migration in this blueprint is ADDITIVE (new tables, nullable columns, new
// indexes), so a NEWER file stays readable by an OLDER binary and `min_reader`
// never moves — that is what makes the Phase B → Phase A rollback safe (D2).
//
// Migration rules (D2):
//   - forward-only, one transaction each, `IF NOT EXISTS` DDL;
//   - `PRAGMA user_version` is bumped INSIDE the migration's own transaction, so
//     a crash between the DDL and the bump replays cleanly;
//   - a migration that ever needs to be DESTRUCTIVE must bump `min_reader` and
//     ship `fleet2 state downgrade`. None is in scope.
//
// v1 (Phase A, fleet2 5.8.0) carries EVERY column Phase B uses (`phase`,
// `enrol_stage`, `retired_at`) so v2 adds only tables — see D2/D3.

/** The highest schema this binary knows how to create and operate. */
export const KNOWN_SCHEMA = 1;

/** Timestamps everywhere in the store are integer epoch SECONDS, UTC. */
export const AUDIT_RETENTION_DAYS = 92;

export interface Migration {
  /** the `user_version` this migration produces. */
  to: number;
  /** `meta.min_reader` after this migration (never lowered). */
  minReader: number;
  /** DDL/DML, executed in order inside ONE transaction. */
  statements: string[];
}

// --- v1 ---------------------------------------------------------------------
//
// Names are validated by the EXISTING `BOX_NAME_RE` (`^grok-box-[0-9]+$`,
// boxes.ts:31) — NOT "three digits" (D3/B1): legacy 1–2 digit names are legal
// rows until an operator renames them.
//
// `boxes` uses a SURROGATE key (`box_id`) so a rename never rewrites a child
// table's foreign key. There is deliberately NO UNIQUE on `idx` or `port`: the
// rename window legitimately holds two rows on one port
// (rename-wiring.ts:80-85,103-118), and `grok-box-3` + `grok-box-003` are both
// legal rows until one is renamed. The invariant "no two ENROLLED rows share a
// port outside a rename window" is REPORTED by `fleet2 state check`, never
// enforced by the schema.
const V1: string[] = [
  `CREATE TABLE IF NOT EXISTS meta(
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   ) STRICT`,

  // Exactly one row, created by this migration (D3).
  `CREATE TABLE IF NOT EXISTS engine(
     id              INTEGER PRIMARY KEY CHECK(id=1),
     tick_seq        INTEGER NOT NULL DEFAULT 0,
     api_fails       INTEGER NOT NULL DEFAULT 0,
     api_backoff_min INTEGER,
     api_next_retry  INTEGER
   ) STRICT`,
  `INSERT OR IGNORE INTO engine(id) VALUES(1)`,

  `CREATE TABLE IF NOT EXISTS boxes(
     box_id            INTEGER PRIMARY KEY,
     name              TEXT NOT NULL UNIQUE,
     idx               INTEGER,
     port              INTEGER,
     phase             TEXT NOT NULL CHECK(phase IN ('enrolling','enrolled','retired')),
     enrol_stage       INTEGER NOT NULL DEFAULT 0,
     enrol_fail_streak INTEGER NOT NULL DEFAULT 0,
     enrol_warn        TEXT,
     pubkey            TEXT,
     created_at        INTEGER NOT NULL,
     enrolled_at       INTEGER,
     retired_at        INTEGER,
     updated_at        INTEGER NOT NULL
   ) STRICT`,

  // The eight `<box>.*` marker files, one column each; reset semantics are
  // preserved column by column (survey §2a) by the accessors in store/state.ts.
  `CREATE TABLE IF NOT EXISTS box_counters(
     box_id              INTEGER PRIMARY KEY REFERENCES boxes(box_id) ON DELETE CASCADE,
     checkfail           INTEGER NOT NULL DEFAULT 0,
     seedfail            INTEGER NOT NULL DEFAULT 0,
     cfgfail             INTEGER NOT NULL DEFAULT 0,
     incoherent          INTEGER NOT NULL DEFAULT 0,
     repair_pending_runs INTEGER NOT NULL DEFAULT 0,
     repair_pending_tick INTEGER,
     hostkey_mismatch    INTEGER NOT NULL DEFAULT 0,
     asleep_since        INTEGER,
     asleep_last_alert   INTEGER
   ) STRICT`,

  // One row = today's `keys/<idx>.json` PLUS `<box>.expires` — the two-file mint
  // crash window (survey §4b) collapses into one statement (D5).
  `CREATE TABLE IF NOT EXISTS box_keys(
     box_id       INTEGER PRIMARY KEY REFERENCES boxes(box_id) ON DELETE CASCADE,
     key_id       TEXT NOT NULL,
     expires_raw  TEXT NOT NULL,
     expires_date TEXT NOT NULL CHECK(length(expires_date)=10),
     minted_at    INTEGER NOT NULL
   ) STRICT`,

  // NOTE (Phase A): this table has NO WRITER in 5.8.0. It exists in v1 so the
  // alert-dedup blueprint (c) has a table to stand on without a migration; every
  // alert site still throttles off `box_counters` exactly as 5.7.1 does.
  `CREATE TABLE IF NOT EXISTS alerts(
     box_id     INTEGER NOT NULL REFERENCES boxes(box_id) ON DELETE CASCADE,
     kind       TEXT NOT NULL,
     first_seen INTEGER NOT NULL,
     last_sent  INTEGER,
     count      INTEGER NOT NULL DEFAULT 0,
     cleared_at INTEGER,
     PRIMARY KEY(box_id, kind)
   ) STRICT`,

  // The `audit` TABLE is v1 (r4-B1) so Phase A's divergence check and
  // `reconcile-files` have a record. The FILE `audit.log` is UNCHANGED and stays
  // unbounded (operator logrotate). `audit.box` is plain TEXT, not a foreign
  // key, so a `retire --forget` in Phase B keeps its history.
  `CREATE TABLE IF NOT EXISTS audit(
     id     INTEGER PRIMARY KEY,
     at     INTEGER NOT NULL,
     actor  TEXT NOT NULL,
     action TEXT NOT NULL,
     box    TEXT,
     rc     INTEGER,
     job    TEXT,
     detail TEXT
   ) STRICT`,
  `CREATE INDEX IF NOT EXISTS audit_at ON audit(at)`,

  // Keyed by NAME so a file-only finding (which has no box_id) fits (r4-B2).
  // No retention: rows are deleted on clear and bounded by the number of
  // diverging names.
  `CREATE TABLE IF NOT EXISTS divergence_findings(
     name          TEXT PRIMARY KEY,
     kind          TEXT NOT NULL CHECK(kind IN ('file-only','store-only')),
     first_seen    INTEGER NOT NULL,
     last_seen     INTEGER NOT NULL,
     last_reported INTEGER
   ) STRICT`,

  // Keyed by name on purpose: candidates are not boxes yet. Values unchanged
  // from `discover.json` (288-tick prune / 64-record cap live in discover.ts).
  `CREATE TABLE IF NOT EXISTS discover_ledger(
     name         TEXT PRIMARY KEY,
     last_attempt INTEGER,
     failures     INTEGER NOT NULL,
     reason       TEXT,
     last_tick    INTEGER
   ) STRICT`,
];

export const MIGRATIONS: Migration[] = [{ to: 1, minReader: 1, statements: V1 }];

/** Every v1 table, in the order a full replay must DELETE them (children first). */
export const V1_TABLES_CHILD_FIRST = [
  "box_keys",
  "box_counters",
  "alerts",
  "boxes",
  "divergence_findings",
  "discover_ledger",
  "audit",
] as const;
