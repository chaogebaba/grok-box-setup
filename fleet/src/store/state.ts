// store/state.ts — the bun:sqlite implementation of the per-tick state surface
// (blueprint fleet2-state-store D3/D5/D6/D7 Phase A).
//
// Same interface as the 5.7.1 file class (`ReconcileStateApi`, reconcile/
// state.ts), different storage. Three behaviour changes are DELIBERATE and are
// the reason the store exists:
//
//   1. A failed write is a failed write. 5.7.1 swallowed every counter write
//      error for bash parity (reconcile/state.ts:37-43) and read a corrupt
//      counter as `0`, so "absent", "corrupt" and "zero" were the same thing
//      (survey §4f). Here a corrupt file cannot occur and a write that cannot
//      commit throws out of `openStore` as a ConfigError (rc 3) instead.
//   2. Mint is ONE statement (`recordKey`), closing the crash window between
//      `keys/<idx>.json` and `<box>.expires` (survey §4b).
//   3. Membership is `WHERE phase='enrolled'` — from 5.8.0 on, everywhere
//      (D7/r2-B5). A row that is `enrolling` or `retired` is not a member, is
//      not exported, and is not adoptable.
//
// Every membership write and every key write is followed by the LEGACY EXPORT
// (D6): 5.7.1 must be able to read `enrolled.tsv`, `authorized-keys.map`,
// `<box>.expires` and `keys/<idx>.json` at any moment, because rolling back to
// it is the Phase A rollback. Export failures are NOT swallowed: they are
// collected here and drained by the caller, which turns them into rc 7.

import type { Store } from "./db.ts";
import type { DiscoverRecord, ReconcileStateApi } from "../reconcile/state.ts";
import { boxIndex, portFor } from "../boxes.ts";
import { exportKeyFiles, exportMembership, type ExportPaths } from "./legacy.ts";
import { log } from "../log.ts";

/** One `boxes` row, as every reader in grokfleet wants it. */
export interface BoxRow {
  box_id: number;
  name: string;
  idx: number | null;
  port: number | null;
  phase: "enrolling" | "enrolled" | "retired";
  enrol_stage: number;
  enrol_fail_streak: number;
  enrol_warn: string | null;
  pubkey: string | null;
  created_at: number;
  enrolled_at: number | null;
  retired_at: number | null;
  updated_at: number;
}

const COUNTER_COLUMNS = [
  "checkfail",
  "seedfail",
  "cfgfail",
  "incoherent",
  "keepawake_fail",
  "tickwedge_seen",
] as const;
type CounterColumn = (typeof COUNTER_COLUMNS)[number];

/** The three membership phases (D4). */
export type Phase = BoxRow["phase"];

/** `transition` result: rc 1 names the phase the row ACTUALLY holds (D4). */
export interface TransitionResult {
  rc: 0 | 1;
  /** the row's phase when the assertion failed (undefined when the row is absent). */
  actual?: Phase;
  message?: string;
}

/** One `enrolling` row, as the resume pass wants it (D5). */
export interface EnrollingRow {
  name: string;
  stage: number;
  streak: number;
  warn: string | null;
  created_at: number;
}

/** D5: the five external stages of the enrol saga, in `enroll.ts` order. */
export const ENROL_STAGES = 5;

/** D5: `enrol-stuck` fires at this many ATTEMPTED-and-failed stages. */
export const ENROL_STUCK_STREAK = 3;

/** D5: and then at most once per 24 h, throttled through the `alerts` table. */
export const ENROL_STUCK_RENOTIFY_SECS = 86400;

export interface StoreStateOptions {
  /** where the legacy export writes; omit to disable the export (tests). */
  paths?: ExportPaths;
}

export class StoreState implements ReconcileStateApi {
  readonly store: Store;
  private readonly paths: ExportPaths | undefined;
  private readonly exportErrors: string[] = [];
  /** names logged as port-less this tick, so the log line fires once each (D3). */
  private readonly portlessLogged = new Set<string>();

  constructor(store: Store, opts: StoreStateOptions = {}) {
    this.store = store;
    this.paths = opts.paths;
  }

  // --- legacy export (D6) ----------------------------------------------------

  /**
   * Export failures are RECORDED, never thrown and never swallowed (r3-B1,
   * r4-n4). The store write has already committed when the export runs, so the
   * mutation is a success; the lag is what the caller reports (rc 7, one notify,
   * and the next tick's divergence check).
   */
  private runExport(what: "membership" | "keys", box?: string): void {
    if (this.paths === undefined) return;
    try {
      if (what === "membership") exportMembership(this.store, this.paths);
      else exportKeyFiles(this.store, this.paths, box!);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.exportErrors.push(msg);
      log(`state store: legacy export (${what}${box ? ` ${box}` : ""}) FAILED — ${msg}`);
    }
  }

  /** Re-export ONE box's key artefacts (retire drops the row, then calls this,
   *  and the export REMOVES `<box>.expires` and `keys/<idx>.json`). */
  exportKeysFor(box: string): void {
    this.runExport("keys", box);
  }

  /** Export every legacy artefact (used after an import or a bulk change). */
  exportAll(): void {
    this.runExport("membership");
    for (const r of this.enrolledRows()) this.runExport("keys", r.name);
  }

  /** Drain the recorded export failures (the caller turns these into rc 7). */
  takeExportErrors(): string[] {
    return this.exportErrors.splice(0, this.exportErrors.length);
  }

  /** Peek without draining. */
  hasExportError(): boolean {
    return this.exportErrors.length > 0;
  }

  // --- boxes / membership ----------------------------------------------------

  boxRow(name: string): BoxRow | undefined {
    return (this.store.db.query("SELECT * FROM boxes WHERE name = ?").get(name) as BoxRow | null) ?? undefined;
  }

  boxId(name: string): number | undefined {
    const r = this.store.db.query("SELECT box_id FROM boxes WHERE name = ?").get(name) as { box_id?: number } | null;
    return r?.box_id;
  }

  allRows(): BoxRow[] {
    return this.store.db.query("SELECT * FROM boxes ORDER BY name").all() as BoxRow[];
  }

  rowsByPhase(phase: BoxRow["phase"]): BoxRow[] {
    return this.store.db.query("SELECT * FROM boxes WHERE phase = ? ORDER BY name").all(phase) as BoxRow[];
  }

  /** Every enrolled row, in the tick's canonical order (see `orderRows`). */
  enrolledRows(): BoxRow[] {
    return orderRows(this.rowsByPhase("enrolled"));
  }

  /**
   * MEMBERSHIP for the tick, the inventory, the upgrade planner, the index
   * collision rail and the export: `phase='enrolled'` ONLY (D4/B6).
   *
   * A row whose `port` is NULL (the tsv column was non-numeric AND the name's
   * index is unparseable, D3/r2-B3) is SKIPPED with one log line per tick — a
   * deliberate behaviour change from 5.7.1, where such a row reached `sshArgv`
   * and threw (tunnel.ts:73-74,95-96).
   */
  membership(): string[] {
    const out: string[] = [];
    for (const r of this.enrolledRows()) {
      if (r.port === null) {
        if (!this.portlessLogged.has(r.name)) {
          this.portlessLogged.add(r.name);
          log(`reconcile: ${r.name} skipped — no port (unparseable index)`);
        }
        continue;
      }
      out.push(r.name);
    }
    return out;
  }

  /**
   * The `excluded` map `selectCandidates` takes as its third parameter (D4):
   * an `enrolling` row belongs to the repair/resume pass and a `retired` name is
   * NOT adoptable. Read ONCE per tick, with membership.
   */
  excludedNames(): Map<string, "retired" | "enrolling"> {
    const m = new Map<string, "retired" | "enrolling">();
    for (const r of this.rowsByPhase("enrolling")) m.set(r.name, "enrolling");
    for (const r of this.rowsByPhase("retired")) m.set(r.name, "retired");
    return m;
  }

  /**
   * Record a box as ENROLLED — the enrol saga's STAGE 5 (D5). Idempotent on the
   * name. Exports.
   *
   * When the row is `enrolling` this IS the `enrolling -> enrolled` transition:
   * the phase change, the stage/streak/warn reset and the audit row all commit
   * together, so a crash can never leave a member whose saga still says it is
   * mid-enrolment. The audit row keeps Phase A's `enrolled` action name and
   * carries the phase change in its detail rather than emitting a second row.
   */
  recordEnrolled(name: string, port: number, pubkey?: string): void {
    const at = this.store.now();
    const idx = boxIndex(name) ?? null;
    this.store.tx(() => {
      const existing = this.boxRow(name);
      if (existing === undefined) {
        this.store.db
          .query(
            `INSERT INTO boxes(name,idx,port,phase,enrol_stage,created_at,enrolled_at,updated_at,pubkey)
             VALUES(?,?,?,'enrolled',?,?,?,?,?)`,
          )
          .run(name, idx, port, ENROL_STAGES, at, at, at, pubkey ?? null);
      } else {
        this.store.db
          .query(
            `UPDATE boxes SET idx=?, port=?, phase='enrolled', enrolled_at=COALESCE(enrolled_at,?),
                              retired_at=NULL, enrol_stage=?, enrol_fail_streak=0, enrol_warn=NULL,
                              updated_at=?, pubkey=COALESCE(?,pubkey) WHERE box_id=?`,
          )
          .run(idx, port, at, ENROL_STAGES, at, pubkey ?? null, existing.box_id);
      }
      const from = existing?.phase;
      this.store.audit({
        actor: "grokfleet",
        action: "enrolled",
        box: name,
        rc: 0,
        at,
        detail: from !== undefined && from !== "enrolled" ? `${from} -> enrolled port=${port}` : `port=${port}`,
      });
    });
    this.runExport("membership");
  }

  // --- phase transitions (D4) -------------------------------------------------

  /**
   * `enrolling -> enrolled -> retired -> enrolling` (re-adoption). Asserts
   * `from`, updates the row and writes the `audit` row IN THE SAME TRANSACTION;
   * a wrong `from` is rc 1 with the phase the row actually holds in the message
   * and NOTHING written.
   *
   * DEVIATION from the blueprint's `transition(box_id, …)`: the parameter is the
   * box NAME. `box_id` is a surrogate key that exists so child tables survive a
   * rename; every caller here (retire, enroll, reconcile-files) holds a name, and
   * making each of them resolve the id first would only move the same lookup
   * outward. `audit.box` records the name either way.
   */
  transition(name: string, from: Phase, to: Phase, actor: string, detail?: string): TransitionResult {
    const row = this.boxRow(name);
    if (row === undefined) {
      return { rc: 1, message: `${name}: no store row — cannot transition ${from} -> ${to}` };
    }
    if (row.phase !== from) {
      return {
        rc: 1,
        actual: row.phase,
        message: `${name}: expected phase '${from}' but the row is '${row.phase}' — refusing the ${from} -> ${to} transition`,
      };
    }
    const at = this.store.now();
    this.store.tx(() => {
      if (to === "retired") {
        this.store.db
          .query("UPDATE boxes SET phase='retired', retired_at=?, updated_at=? WHERE box_id=?")
          .run(at, at, row.box_id);
      } else if (to === "enrolling") {
        // Re-adoption on the SAME row (D4): a fresh saga, counters reset and the
        // key row dropped — the box will mint a new one.
        this.store.db
          .query(
            `UPDATE boxes SET phase='enrolling', enrol_stage=0, enrol_fail_streak=0, enrol_warn=NULL,
                              retired_at=NULL, enrolled_at=?, updated_at=? WHERE box_id=?`,
          )
          .run(at, at, row.box_id);
        this.store.db.query("DELETE FROM box_keys WHERE box_id=?").run(row.box_id);
        this.store.db
          .query(
            `UPDATE box_counters SET checkfail=0, seedfail=0, cfgfail=0, incoherent=0,
                                     keepawake_fail=0, tickwedge_seen=NULL, driftpair=NULL,
                                     repair_pending_runs=0, repair_pending_tick=NULL,
                                     hostkey_mismatch=0, asleep_since=NULL, asleep_last_alert=NULL
             WHERE box_id=?`,
          )
          .run(row.box_id);
      } else {
        this.store.db
          .query(
            `UPDATE boxes SET phase='enrolled', enrolled_at=COALESCE(enrolled_at,?), retired_at=NULL,
                              enrol_stage=?, enrol_fail_streak=0, enrol_warn=NULL, updated_at=? WHERE box_id=?`,
          )
          .run(at, ENROL_STAGES, at, row.box_id);
      }
      this.store.audit({
        actor,
        action: "phase",
        box: name,
        rc: 0,
        at,
        detail: detail === undefined ? `${from} -> ${to}` : `${from} -> ${to}: ${detail}`,
      });
    });
    // A phase change moves the box in or out of membership, so both exports have
    // to follow it. Retiring also drops the box's key artefacts.
    this.runExport("membership");
    if (to !== "enrolled") this.runExport("keys", name);
    return { rc: 0 };
  }

  // --- the enrol saga (D5) ----------------------------------------------------

  /**
   * Open (or resume) the saga for `name` and return the stage already reached.
   *
   * - no row            ⇒ INSERT `phase='enrolling'`, `enrol_stage=0` ⇒ stage 0
   * - `enrolling` row   ⇒ resume from its recorded stage
   * - `retired` row     ⇒ `transition(retired -> enrolling)` on the SAME row
   *                       (new `enrolled_at`, counters reset, key row deleted),
   *                       then stage 0
   * - `enrolled` row    ⇒ stage 0 and the phase UNCHANGED. This is the repair
   *                       path: `discover` re-runs the whole enrol against an
   *                       enrolled box to rewrite its artefacts, and moving it to
   *                       `enrolling` would drop a healthy member out of
   *                       membership for the rest of the tick.
   */
  beginEnrol(name: string, port: number, pubkey?: string): { stage: number } {
    const at = this.store.now();
    const idx = boxIndex(name) ?? null;
    const row = this.boxRow(name);
    if (row === undefined) {
      this.store.tx(() => {
        this.store.db
          .query(
            `INSERT INTO boxes(name,idx,port,phase,enrol_stage,created_at,enrolled_at,updated_at,pubkey)
             VALUES(?,?,?,'enrolling',0,?,NULL,?,?)`,
          )
          .run(name, idx, port, at, at, pubkey ?? null);
        this.store.audit({ actor: "grokfleet", action: "enrol-begin", box: name, rc: 0, at, detail: `port=${port}` });
      });
      return { stage: 0 };
    }
    if (row.phase === "retired") {
      this.transition(name, "retired", "enrolling", "grokfleet", "re-adoption");
      if (pubkey !== undefined) {
        this.store.db.query("UPDATE boxes SET pubkey=?, port=?, updated_at=? WHERE box_id=?").run(pubkey, port, at, row.box_id);
      }
      return { stage: 0 };
    }
    if (row.phase === "enrolled") {
      this.rebindIfNewKeypair(row, pubkey, port, at);
      return { stage: 0 };
    }
    // An `enrolling` row: refresh the pubkey/port the probe just read and resume.
    this.rebindIfNewKeypair(row, pubkey, port, at);
    if (pubkey !== undefined || row.port !== port) {
      this.store.db
        .query("UPDATE boxes SET pubkey=COALESCE(?,pubkey), port=?, updated_at=? WHERE box_id=?")
        .run(pubkey ?? null, port, at, row.box_id);
    }
    return { stage: row.enrol_stage };
  }

  /**
   * A1 (5.12.1) — a box that presents a NEW tunnel keypair is a NEW box.
   *
   * A box's tunnel keypair is generated once, on the box, by boxup's first run.
   * The only way it changes is that the box was re-imaged (or its state was
   * wiped), which also destroys `secrets/ts-authkey`. So a pubkey that differs
   * from the one on file is proof that whatever key the brain thinks it seeded
   * no longer exists on the box. Keeping the `box_keys` row across that is what
   * made `grok-box-011` unrecoverable on 2026-09-06: the row said "minted
   * 2026-08-30, expires in 80 days", `mintWindowValid` agreed, the tick skipped
   * the mint every 5 minutes, and the box had no authkey to rejoin with.
   *
   * Two things happen here, and BOTH are load-bearing:
   *   (a) the stale key is FORGOTTEN, so nothing claims a key exists;
   *   (b) `enrolled_at` moves to now, so `bindingAt` marks the new binding and
   *       `mintWindowValid` rejects any key row minted before it. (b) is the
   *       belt to (a)'s braces: it also catches a key row that survives by some
   *       other route, e.g. a mint that lands between the forget and the seed.
   *
   * A row with a NULL `pubkey` (imported by `store/legacy.ts`, which has no
   * pubkey to import) is treated as a mismatch and forgotten ONCE — the same
   * enrol records the material, so it cannot repeat. `undefined` pubkey means
   * the caller did not read one, which proves nothing and changes nothing.
   */
  private rebindIfNewKeypair(row: BoxRow, pubkey: string | undefined, port: number, at: number): void {
    if (pubkey === undefined) return;
    if (row.pubkey === pubkey) return; // same keypair — same box, same key
    this.store.tx(() => {
      this.store.db.query("DELETE FROM box_keys WHERE box_id=?").run(row.box_id);
      this.store.db
        .query("UPDATE boxes SET pubkey=?, port=?, enrolled_at=?, updated_at=? WHERE box_id=?")
        .run(pubkey, port, at, at, row.box_id);
      this.store.audit({
        actor: "grokfleet",
        action: "rebind",
        box: row.name,
        rc: 0,
        at,
        detail:
          row.pubkey === null
            ? "no recorded tunnel pubkey — key forgotten, binding re-dated"
            : "new tunnel pubkey — key forgotten, binding re-dated",
      });
    });
    this.runExport("keys", row.name);
    log(`state store: ${row.name} presented a new tunnel pubkey — forgot its recorded key; the next tick re-mints`);
  }

  /**
   * A stage COMPLETED. Records the stage and RESETS `enrol_fail_streak` — the
   * streak counts attempted-and-failed stages, and a stage that advanced is
   * progress whatever else it reported.
   *
   * `warn` is stage 2's case: `recordEtcMapping` failing is a WARNING today and
   * stays one, so the stage advances with the warning recorded (D5).
   */
  advanceStage(name: string, stage: number, warn?: string): void {
    const id = this.boxId(name);
    if (id === undefined) return;
    this.store.db
      .query("UPDATE boxes SET enrol_stage=?, enrol_fail_streak=0, enrol_warn=?, updated_at=? WHERE box_id=?")
      .run(stage, warn ?? null, this.store.now(), id);
  }

  /**
   * A stage was ATTEMPTED and FAILED: record the warning, bump the streak, do
   * NOT advance. Returns the new streak. A budget deferral, a preflight skip or
   * a lost mutation slot never reaches here — none of those attempted anything.
   */
  failStage(name: string, stage: number, warn: string): number {
    const id = this.boxId(name);
    if (id === undefined) return 0;
    this.store.db
      .query("UPDATE boxes SET enrol_fail_streak = enrol_fail_streak + 1, enrol_warn=?, updated_at=? WHERE box_id=?")
      .run(`stage ${stage}: ${warn}`, this.store.now(), id);
    return this.boxRow(name)?.enrol_fail_streak ?? 0;
  }

  /** The `enrolling` rows the resume pass owns, OLDEST `created_at` first (D5). */
  enrollingRows(): EnrollingRow[] {
    return (
      this.store.db
        .query(
          `SELECT name, enrol_stage AS stage, enrol_fail_streak AS streak, enrol_warn AS warn, created_at
           FROM boxes WHERE phase='enrolling' ORDER BY created_at ASC, name ASC`,
        )
        .all() as EnrollingRow[]
    );
  }

  // --- alerts (D5's first consumer) -------------------------------------------

  /**
   * Is an alert of `kind` DUE for this box? Records the send when it is, so the
   * throttle is state rather than a per-process memory: the first occurrence
   * fires, and a repeat only once `renotifySecs` have passed.
   *
   * This is the `alerts` table's first writer. Alert POLICY at large (digests,
   * repeat windows for the other twelve sites) is the alert-dedup blueprint's
   * job; this is the one row D5 needs.
   */
  alertDue(box: string, kind: string, renotifySecs: number, now: number = this.store.now()): boolean {
    const id = this.boxId(box);
    // FAIL OPEN. There is no row to hang a throttle on, so the send cannot be
    // recorded and the next tick will ask again — but a dedup layer that cannot
    // find its state must page twice rather than go quiet. (Unreachable from
    // today's callers: every one of them iterates rows the store handed back.)
    if (id === undefined) return true;
    const row = this.store.db
      .query("SELECT first_seen, last_sent, count FROM alerts WHERE box_id=? AND kind=?")
      .get(id, kind) as { first_seen: number; last_sent: number | null; count: number } | null;
    if (row !== null && row.last_sent !== null && now - row.last_sent < renotifySecs) return false;
    this.store.db
      .query(
        `INSERT INTO alerts(box_id,kind,first_seen,last_sent,count,cleared_at) VALUES(?,?,?,?,1,NULL)
         ON CONFLICT(box_id,kind) DO UPDATE SET last_sent=excluded.last_sent, count=count+1, cleared_at=NULL`,
      )
      .run(id, kind, row?.first_seen ?? now, now);
    return true;
  }

  /** Clear an alert row (the condition went away). */
  alertClear(box: string, kind: string): void {
    const id = this.boxId(box);
    if (id === undefined) return;
    this.store.db
      .query("UPDATE alerts SET cleared_at=?, last_sent=NULL WHERE box_id=? AND kind=?")
      .run(this.store.now(), id, kind);
  }

  /**
   * Rename inheritance (D5/B2): the new row copies EXACTLY what 5.7.1's
   * `copyState` copied — `checkfail`, `cfgfail` and the key row. The other six
   * counters start at their defaults, and the key export follows the key copy.
   */
  copyRenameState(old: string, neu: string): void {
    const from = this.boxId(old);
    const to = this.boxId(neu);
    if (from === undefined || to === undefined) return;
    this.store.tx(() => {
      this.store.db.query("INSERT OR IGNORE INTO box_counters(box_id) VALUES(?)").run(to);
      // COALESCE, because the OLD box may have no `box_counters` row at all:
      // counter rows are created lazily on the first bump, so a box enrolled and
      // renamed before its first failing tick has none, and the bare subselects
      // returned NULL into two NOT NULL columns — which made `copyState` throw,
      // which rename-wiring reported as "failed to copy brain state". Nothing
      // inherits a count that was never recorded, so 0 is the right value.
      this.store.db
        .query(
          `UPDATE box_counters SET checkfail = COALESCE((SELECT checkfail FROM box_counters WHERE box_id = ?), 0),
                                   cfgfail   = COALESCE((SELECT cfgfail   FROM box_counters WHERE box_id = ?), 0)
           WHERE box_id = ?`,
        )
        .run(from, from, to);
      this.store.db
        .query(
          `INSERT INTO box_keys(box_id,key_id,expires_raw,expires_date,minted_at)
           SELECT ?, key_id, expires_raw, expires_date, minted_at FROM box_keys WHERE box_id = ?
           ON CONFLICT(box_id) DO UPDATE SET key_id=excluded.key_id, expires_raw=excluded.expires_raw,
                                             expires_date=excluded.expires_date, minted_at=excluded.minted_at`,
        )
        .run(to, from);
      this.store.audit({ actor: "grokfleet", action: "rename-copy", box: neu, rc: 0, detail: `from ${old}` });
    });
    this.runExport("keys", neu);
  }

  /** Delete a row and every child (rename's LAST step; `retire --forget` in B). */
  deleteBox(name: string): void {
    const row = this.boxRow(name);
    if (row === undefined) return;
    this.store.tx(() => {
      this.store.db.query("DELETE FROM boxes WHERE box_id = ?").run(row.box_id);
      this.store.audit({ actor: "grokfleet", action: "row-deleted", box: name, rc: 0 });
    });
    this.runExport("membership");
  }

  // --- counters --------------------------------------------------------------

  /**
   * Counter writes need a `boxes` row; the FK guarantees it. A name with no row
   * (only reachable through the `FLEET_BOXES` membership override, which
   * bypasses the store on purpose) drops the write with one log line rather than
   * inventing a membership row that the export would then publish.
   */
  private counterRow(box: string, create: boolean): number | undefined {
    const id = this.boxId(box);
    if (id === undefined) {
      if (create) log(`state store: ${box} has no store row — counter write dropped`);
      return undefined;
    }
    if (create) this.store.db.query("INSERT OR IGNORE INTO box_counters(box_id) VALUES(?)").run(id);
    return id;
  }

  private readCounter(box: string, col: CounterColumn): number {
    const id = this.boxId(box);
    if (id === undefined) return 0;
    const r = this.store.db.query(`SELECT ${col} AS v FROM box_counters WHERE box_id = ?`).get(id) as
      | { v?: number }
      | null;
    return r?.v ?? 0;
  }

  private bump(box: string, col: CounterColumn): number {
    const id = this.counterRow(box, true);
    if (id === undefined) return 0;
    this.store.db.query(`UPDATE box_counters SET ${col} = ${col} + 1 WHERE box_id = ?`).run(id);
    return this.readCounter(box, col);
  }

  private setCounter(box: string, col: CounterColumn, v: number): void {
    const id = this.counterRow(box, true);
    if (id === undefined) return;
    this.store.db.query(`UPDATE box_counters SET ${col} = ? WHERE box_id = ?`).run(v, id);
  }

  // checkfail — reset writes 0 (5.7.1 `echo 0 >`).
  bumpCheckfail(box: string): number {
    return this.bump(box, "checkfail");
  }
  resetCheckfail(box: string): void {
    this.setCounter(box, "checkfail", 0);
  }
  checkfailCount(box: string): number {
    return this.readCounter(box, "checkfail");
  }

  // seedfail — reset writes 0.
  bumpSeedfail(box: string): number {
    return this.bump(box, "seedfail");
  }
  resetSeedfail(box: string): void {
    this.setCounter(box, "seedfail", 0);
  }

  // cfgfail — 5.7.1 reset is `rm -f`, which READS as 0. Column 0 is the same
  // observable state (survey §2a): nothing distinguishes absent from zero.
  bumpCfgfail(box: string): number {
    return this.bump(box, "cfgfail");
  }
  resetCfgfail(box: string): void {
    this.setCounter(box, "cfgfail", 0);
  }

  // incoherent — same: 5.7.1 reset is `rm -f`, observable value 0.
  bumpIncoherent(box: string): number {
    return this.bump(box, "incoherent");
  }
  resetIncoherent(box: string): void {
    this.setCounter(box, "incoherent", 0);
  }

  // keepawake-fail streak + tickwedge high-water (5.13.0 D1a). Same column
  // idiom as the counters above: the file class resets `keepawake-fail` with
  // `rm -f` (reads 0) and stores `tickwedge` as a bare int (absent ⇒ 0); the
  // store reads 0 from a fresh row, so the two implementations are observably
  // identical. `resetKeepawakeFail` writes 0 (the `rm -f` observable) and
  // `setTickwedge` writes the value.
  bumpKeepawakeFail(box: string): number {
    return this.bump(box, "keepawake_fail");
  }
  resetKeepawakeFail(box: string): void {
    this.setCounter(box, "keepawake_fail", 0);
  }
  lastTickwedge(box: string): number | null {
    // A28: NULL column ⇒ null (never recorded, first sight is silent). Distinct
    // from a recorded 0, which a real 0→1 wedge pages against. `readCounter`
    // collapses NULL to 0, so read the column directly.
    const id = this.boxId(box);
    if (id === undefined) return null;
    const r = this.store.db.query("SELECT tickwedge_seen AS v FROM box_counters WHERE box_id = ?").get(id) as
      | { v?: number | null }
      | null;
    if (r === null || r === undefined || r.v === null || r.v === undefined) return null;
    return r.v;
  }
  setTickwedge(box: string, n: number): void {
    this.setCounter(box, "tickwedge_seen", n);
  }

  // driftpair (5.14.3 D5-noise) — a TEXT column, not a counter, so it has its
  // own accessors rather than riding COUNTER_COLUMNS. NULL column ⇒ null (never
  // recorded, first sight emits and records), the same first-sight rule as
  // `tickwedge_seen`. A box with no `box_counters` row at all also reads null.
  driftPair(box: string): string | null {
    const id = this.boxId(box);
    if (id === undefined) return null;
    const r = this.store.db.query("SELECT driftpair AS v FROM box_counters WHERE box_id = ?").get(id) as
      | { v?: string | null }
      | null;
    if (r === null || r === undefined || r.v === null || r.v === undefined || r.v === "") return null;
    return r.v;
  }
  setDriftPair(box: string, pair: string): boolean {
    // A name with no `boxes` row cannot get a counter row (the FK), so the write
    // is dropped and read-back returns null ⇒ false ⇒ the D5 line fires again.
    // A committed write is confirmed by re-reading it — the same fail-open,
    // read-back contract the file implementation documents.
    //
    // r2 (gate BLOCKER): the whole thing is wrapped so a mid-tick sqlite write
    // failure (SQLITE_BUSY after busy_timeout, FULL, IOERR — bun:sqlite THROWS
    // on any of these) can NEVER escape into runReconcile and kill the tick.
    // `ReconcileStateApi.setDriftPair` is contracted to return false when the
    // write is not confirmed and to never throw; a caught error is exactly "not
    // confirmed", so the next tick re-reads null and re-emits the D5 line — the
    // same log-every-tick fall-back as an unwritable store. The `counterRow`
    // INSERT is inside the try for the same reason: it is also a write.
    try {
      const id = this.counterRow(box, true);
      if (id === undefined) return false;
      this.store.db.query("UPDATE box_counters SET driftpair = ? WHERE box_id = ?").run(pair, id);
      return this.driftPair(box) === pair;
    } catch (e) {
      log(`state store: ${box} driftpair write not confirmed (${e instanceof Error ? e.message : String(e)}) — D5 line will log again next tick`);
      return false;
    }
  }

  // logMemo (5.14.4) — once-per-transition memo for non-per-box journal lines,
  // stored in the EXISTING meta(key,value) table (schema.ts V1) — NO migration.
  // Absent/blank ⇒ null (first sight). setLogMemo confirms with a read-back and
  // NEVER throws (the B1 lesson): a sqlite write failure (BUSY/FULL/IOERR — or a
  // BEFORE INSERT/UPDATE trigger RAISE(ABORT) in the test) is caught and reported
  // as false, so the tick completes and the line re-emits next tick.
  logMemo(key: string): string | null {
    try {
      const v = this.store.meta(key);
      return v === undefined || v === "" ? null : v;
    } catch {
      return null;
    }
  }
  setLogMemo(key: string, value: string): boolean {
    try {
      this.store.setMeta(key, value);
      return this.logMemo(key) === value;
    } catch (e) {
      log(`state store: log memo '${key}' write not confirmed (${e instanceof Error ? e.message : String(e)}) — the line will log again next tick`);
      return false;
    }
  }

  // asleep — "<since> <last_alert>"; 5.7.1 reset is `rm -f`, i.e. ABSENT, which
  // is distinguishable from zero here (both columns NULL) and must stay so: the
  // 2h first-alert gate keys off the marker's absence.
  readAsleep(box: string): { since: number; last: number } | undefined {
    const id = this.boxId(box);
    if (id === undefined) return undefined;
    const r = this.store.db
      .query("SELECT asleep_since AS s, asleep_last_alert AS l FROM box_counters WHERE box_id = ?")
      .get(id) as { s?: number | null; l?: number | null } | null;
    if (r === null || r === undefined || r.s === null || r.s === undefined) return undefined;
    return { since: r.s, last: r.l ?? 0 };
  }
  writeAsleep(box: string, since: number, last: number): void {
    const id = this.counterRow(box, true);
    if (id === undefined) return;
    this.store.db
      .query("UPDATE box_counters SET asleep_since = ?, asleep_last_alert = ? WHERE box_id = ?")
      .run(since, last, id);
  }
  resetAsleep(box: string): void {
    const id = this.boxId(box);
    if (id === undefined) return;
    this.store.db
      .query("UPDATE box_counters SET asleep_since = NULL, asleep_last_alert = NULL WHERE box_id = ?")
      .run(id);
  }

  // repair_pending_runs — "<runs> <tick>"; absent until first written.
  readRepairPending(box: string): { runs: number; tick: number } | undefined {
    const id = this.boxId(box);
    if (id === undefined) return undefined;
    const r = this.store.db
      .query("SELECT repair_pending_runs AS r, repair_pending_tick AS t FROM box_counters WHERE box_id = ?")
      .get(id) as { r?: number; t?: number | null } | null;
    if (r === null || r === undefined || r.t === null || r.t === undefined) return undefined;
    return { runs: r.r ?? 0, tick: r.t };
  }
  bumpRepairPending(box: string, tick: number): number {
    const id = this.counterRow(box, true);
    if (id === undefined) return 0;
    const prev = this.readRepairPending(box);
    const runs = (prev?.runs ?? 0) + 1;
    this.store.db
      .query("UPDATE box_counters SET repair_pending_runs = ?, repair_pending_tick = ? WHERE box_id = ?")
      .run(runs, tick, id);
    return runs;
  }
  resetRepairPending(box: string, tick: number): void {
    const id = this.counterRow(box, true);
    if (id === undefined) return;
    this.store.db
      .query("UPDATE box_counters SET repair_pending_runs = 0, repair_pending_tick = ? WHERE box_id = ?")
      .run(tick, id);
  }

  // hostkey_mismatch — presence-only in 5.7.1, a 0/1 column here.
  readHostkeyMismatch(box: string): boolean {
    const id = this.boxId(box);
    if (id === undefined) return false;
    const r = this.store.db.query("SELECT hostkey_mismatch AS v FROM box_counters WHERE box_id = ?").get(id) as
      | { v?: number }
      | null;
    return (r?.v ?? 0) !== 0;
  }
  setHostkeyMismatch(box: string): void {
    const id = this.counterRow(box, true);
    if (id === undefined) return;
    this.store.db.query("UPDATE box_counters SET hostkey_mismatch = 1 WHERE box_id = ?").run(id);
  }
  clearHostkeyMismatch(box: string): void {
    const id = this.boxId(box);
    if (id === undefined) return;
    this.store.db.query("UPDATE box_counters SET hostkey_mismatch = 0 WHERE box_id = ?").run(id);
  }

  // --- key material (D5) -----------------------------------------------------

  readExpiresDate(box: string): string | undefined {
    const id = this.boxId(box);
    if (id === undefined) return undefined;
    const r = this.store.db.query("SELECT expires_date AS d FROM box_keys WHERE box_id = ?").get(id) as
      | { d?: string }
      | null;
    return r?.d;
  }

  /**
   * 5.7.1 wrote `<box>.expires` on its own. Here it is half of the `box_keys`
   * row, so a standalone call updates the expiry of an EXISTING key row and is
   * otherwise a no-op with a log line — a `<box>.expires` with no key file was
   * exactly the mint crash window this blueprint closes (D6/r3-n5).
   */
  writeExpires(box: string, date: string): void {
    const id = this.boxId(box);
    if (id === undefined) return;
    const r = this.store.db.query("UPDATE box_keys SET expires_date = ? WHERE box_id = ?").run(date, id);
    if (Number(r.changes ?? 0) === 0) {
      log(`state store: ${box} has no key row — expiry ${date} not recorded (mint records both in one write)`);
      return;
    }
    this.runExport("keys", box);
  }

  keyMetaId(index: number, box?: string): string | undefined {
    const id = box !== undefined ? this.boxId(box) : this.boxIdByIndex(index);
    if (id === undefined) return undefined;
    const r = this.store.db.query("SELECT key_id AS k FROM box_keys WHERE box_id = ?").get(id) as
      | { k?: string }
      | null;
    return r?.k !== undefined && r.k !== "" ? r.k : undefined;
  }

  recordKeyMeta(index: number, id: string, expires: string, box?: string): boolean {
    const name = box ?? this.nameByIndex(index);
    if (name === undefined) return false;
    const date = expires.slice(0, 10);
    return this.recordKey(name, { keyId: id, expiresRaw: expires, expiresDate: date });
  }

  /** D5: key id + BOTH expiry forms in one statement. */
  recordKey(box: string, meta: { keyId: string; expiresRaw: string; expiresDate: string }): boolean {
    if (meta.keyId === "") return false; // a blank id cannot satisfy the invariant
    if (meta.expiresDate.length !== 10) return false; // CHECK(length=10) would reject it
    const id = this.boxId(box);
    if (id === undefined) {
      log(`state store: ${box} has no store row — key meta NOT recorded`);
      return false;
    }
    try {
      this.store.db
        .query(
          `INSERT INTO box_keys(box_id,key_id,expires_raw,expires_date,minted_at) VALUES(?,?,?,?,?)
           ON CONFLICT(box_id) DO UPDATE SET key_id=excluded.key_id, expires_raw=excluded.expires_raw,
                                             expires_date=excluded.expires_date, minted_at=excluded.minted_at`,
        )
        .run(id, meta.keyId, meta.expiresRaw, meta.expiresDate, this.store.now());
    } catch (e) {
      // A rejected statement leaves the PREVIOUS row untouched (test (d)).
      log(`state store: ${box} key meta rejected — ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    this.runExport("keys", box);
    return true;
  }

  /**
   * Drop a box's key row WITHOUT exporting (D4/D6, the retire path). The caller
   * exports afterwards, and with no key row `exportKeyFiles` REMOVES
   * `<box>.expires` and `keys/<idx>.json` — which is what retiring a box should
   * leave behind: no key material for a box that no longer has a key.
   */
  dropKeyRow(box: string): void {
    const id = this.boxId(box);
    if (id === undefined) return;
    this.store.db.query("DELETE FROM box_keys WHERE box_id = ?").run(id);
  }

  /**
   * A1/r2-R3: forget the key AND export, so `<box>.expires` and
   * `keys/<idx>.json` go away with the row. `dropKeyRow` deliberately does not
   * export because the retire path exports once at the end; forget owns its
   * export.
   *
   * The r1 gate found this method declared on both implementations, described
   * in the docs as the re-image mechanism, and called by nothing — the actual
   * forget on the enrol path is an inline DELETE inside `rebindIfNewKeypair`'s
   * transaction, which is the better implementation there because it commits
   * with the `enrolled_at` re-dating in one go. Rather than delete a method
   * with a real use, r2 gave it its ONE caller:
   * `grokfleet state forget-key <box>`, the operator repair for a box the tick
   * cannot fix on its own. If that command ever goes away, so should this.
   *
   * The DELETE and the audit row commit TOGETHER. The export follows the
   * commit, not inside it: `runExport` writes files, and a transaction that
   * rolled back after removing them would leave the row without its artefacts.
   * A crash between commit and export leaves a stale `<box>.expires` on disk
   * with no row behind it, which the next export removes — the safe direction,
   * because a file with no row is inert while a row with no file is a key the
   * engine believes in.
   */
  forgetKey(box: string): void {
    const row = this.boxRow(box);
    if (row === undefined) return;
    const at = this.store.now();
    this.store.tx(() => {
      this.store.db.query("DELETE FROM box_keys WHERE box_id=?").run(row.box_id);
      this.store.audit({
        actor: "grokfleet",
        action: "forget-key",
        box,
        rc: 0,
        at,
        detail: "key row dropped",
      });
    });
    this.runExport("keys", box);
  }

  /** A1: when the current key row was minted (epoch seconds). */
  keyMintedAt(box: string): number | undefined {
    const id = this.boxId(box);
    if (id === undefined) return undefined;
    const r = this.store.db.query("SELECT minted_at AS t FROM box_keys WHERE box_id = ?").get(id) as
      | { t?: number }
      | null;
    return typeof r?.t === "number" ? r.t : undefined;
  }

  /**
   * A1: when the box's CURRENT tunnel binding was established.
   *
   * `boxes.enrolled_at` is that instant. It used to mean "first ever enrolled"
   * (every write was `COALESCE(enrolled_at, now)`), which made it useless for
   * this: a re-imaged box keeps its row and its `enrolled_at`. `beginEnrol`
   * now moves it forward whenever the box presents a tunnel pubkey that is not
   * the one on file, so the column means what its name says — the start of the
   * binding that is in force. A legacy-imported row has NULL here (legacy.ts
   * imports leave it NULL on purpose) and yields `undefined`, which makes the
   * guard fall open rather than re-mint a whole imported fleet.
   */
  bindingAt(box: string): number | undefined {
    const r = this.boxRow(box);
    return r?.enrolled_at ?? undefined;
  }

  private boxIdByIndex(index: number): number | undefined {
    const r = this.store.db
      .query("SELECT box_id FROM boxes WHERE idx = ? AND phase = 'enrolled' ORDER BY name LIMIT 1")
      .get(index) as { box_id?: number } | null;
    return r?.box_id;
  }
  private nameByIndex(index: number): string | undefined {
    const r = this.store.db
      .query("SELECT name FROM boxes WHERE idx = ? AND phase = 'enrolled' ORDER BY name LIMIT 1")
      .get(index) as { name?: string } | null;
    return r?.name;
  }

  // --- engine (tick ordinal + API backoff) -----------------------------------

  private engine(): { tick_seq: number; api_fails: number; api_backoff_min: number | null; api_next_retry: number | null } {
    return this.store.db.query("SELECT * FROM engine WHERE id = 1").get() as {
      tick_seq: number;
      api_fails: number;
      api_backoff_min: number | null;
      api_next_retry: number | null;
    };
  }

  bumpTick(): number {
    this.store.db.run("UPDATE engine SET tick_seq = tick_seq + 1 WHERE id = 1");
    return this.engine().tick_seq;
  }
  currentTick(): number {
    return this.engine().tick_seq;
  }

  recordApiFailure(nowSec: number): { n: number; mins: number } {
    this.store.db.run("UPDATE engine SET api_fails = api_fails + 1 WHERE id = 1");
    const n = this.engine().api_fails;
    const mins = n === 1 ? 5 : n === 2 ? 10 : 20;
    this.store.db
      .query("UPDATE engine SET api_backoff_min = ?, api_next_retry = ? WHERE id = 1")
      .run(mins, nowSec + mins * 60);
    return { n, mins };
  }
  resetApiFailure(): void {
    this.store.db.run("UPDATE engine SET api_fails = 0, api_backoff_min = NULL, api_next_retry = NULL WHERE id = 1");
  }
  /** READ-ONLY (5.7.0 D1): never the recording path. */
  apiFails(): number {
    return this.engine().api_fails;
  }
  nextRetry(): number | undefined {
    return this.engine().api_next_retry ?? undefined;
  }

  // --- discover ledger -------------------------------------------------------

  readDiscoverLedger(): DiscoverRecord[] {
    const rows = this.store.db
      .query("SELECT name, last_attempt, failures, reason, last_tick FROM discover_ledger ORDER BY name")
      .all() as Array<{
      name: string;
      last_attempt: number | null;
      failures: number;
      reason: string | null;
      last_tick: number | null;
    }>;
    return rows.map((r) => ({
      name: r.name,
      last_attempt: r.last_attempt ?? 0,
      failures: r.failures,
      reason: r.reason ?? "",
      last_tick: r.last_tick ?? 0,
    }));
  }

  /** Whole-ledger replace, exactly the 5.7.1 semantics, in one transaction. */
  writeDiscoverLedger(records: DiscoverRecord[]): void {
    this.store.tx(() => {
      this.store.db.run("DELETE FROM discover_ledger");
      const ins = this.store.db.query(
        "INSERT INTO discover_ledger(name,last_attempt,failures,reason,last_tick) VALUES(?,?,?,?,?)",
      );
      for (const r of records) {
        if (typeof r.name !== "string" || r.name === "") continue;
        ins.run(r.name, r.last_attempt ?? null, r.failures ?? 0, r.reason ?? null, r.last_tick ?? null);
      }
    });
  }

  /** No-op: the store's directory is created by `openStore`. */
  mkdirState(): void {
    /* openStore mkdir -p's $FLEET_STATE before it opens the file */
  }
}

/**
 * The tick's canonical box order, IDENTICAL to `parseEnrolled` (boxes.ts:44-64):
 * numeric by index, an unparseable index sorting LAST behind a sentinel, ties
 * broken by name ascending. Kept in lockstep so a 5.8.0 tick visits boxes in the
 * same order a 5.7.1 tick did.
 */
export function orderRows(rows: BoxRow[]): BoxRow[] {
  const UNPARSEABLE = 999999;
  return [...rows].sort((a, b) => {
    const ai = a.idx ?? UNPARSEABLE;
    const bi = b.idx ?? UNPARSEABLE;
    if (ai !== bi) return ai - bi;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

/**
 * The D3 port rule for an imported/adopted row: the tsv (or rename) column when
 * it is numeric, else `portFor(name)` with a warning, else NULL when the name's
 * index is unparseable too. 5.7.1's parser discarded the column entirely
 * (boxes.ts:57-70), so a bad column must never stop the engine.
 */
export function resolvePort(name: string, rawColumn: string | undefined): { port: number | null; warn?: string } {
  if (rawColumn !== undefined && /^[0-9]+$/.test(rawColumn.trim())) {
    return { port: Number.parseInt(rawColumn.trim(), 10) };
  }
  const derived = portFor(name);
  if (derived !== undefined) {
    return {
      port: derived,
      warn: `state store: ${name} had a non-numeric port column (${JSON.stringify(rawColumn ?? "")}) — using portFor() ${derived}`,
    };
  }
  return {
    port: null,
    warn: `state store: ${name} has an unparseable index and a non-numeric port column — port NULL; the tick will skip it`,
  };
}
