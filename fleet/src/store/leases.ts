// store/leases.ts — box leases, the workload layer's step 1 (blueprint
// fleet2-lease-api L1/L3).
//
// A lease is a ROW. "This box is in use" is one predicate and one predicate
// only, stated here once and used by every surface (L3, r9-B1):
//
//     released_at IS NULL   ⇒  the lease still DEFERS and still holds the box's
//                              slot — whatever its `state` is: `active`, `lost`
//                              inside its grace, or `expired` inside its grace.
//
// Every terminal transition therefore either sets `released_at` immediately
// (`released`), SCHEDULES it (`expired` at the expired-grace end, `lost` at the
// lost-grace end or earlier when the box comes back), or lets the holder's
// DELETE set it during a grace (r8-B1).
//
// LOCKING: nothing in this file takes the reconcile lock (L2). The
// one-deferring-lease-per-box invariant is the schema's partial unique index, so
// two concurrent acquires for the same box are serialised by SQLite: one INSERT
// wins, the other raises a constraint error the API renders as 409. That is safe
// only because the tick keeps out of long write transactions (state-store D5)
// and `busy_timeout=5000` is set (r3-n3) — a change to either turns concurrent
// acquires into SQLITE_BUSY and must revisit L2.

import { randomBytes } from "node:crypto";
import type { Store } from "./db.ts";

export type LeaseKind = "ephemeral" | "service";
export type LeaseState = "active" | "released" | "expired" | "lost";

/** One `leases` row, joined to its box NAME (every caller wants the name). */
export interface LeaseRow {
  lease_id: string;
  box_id: number;
  box: string;
  kind: LeaseKind;
  holder: string;
  purpose: string;
  created_at: number;
  expires_at: number | null;
  renewed_at: number | null;
  released_at: number | null;
  state: LeaseState;
  expired_at: number | null;
  lost_at: number | null;
  lost_reason: string | null;
}

/** The ephemeral TTL when the caller names none (L1: 2 h). */
export const LEASE_DEFAULT_TTL_S = 7200;
/** The largest TTL a single acquire/renew may ask for (L1: 24 h). */
export const LEASE_MAX_TTL_S = 86400;
/** L1/r7-B1: a HARD lifetime bound measured from `created_at`, not a sliding
 *  window per renew. Config `[leases].ephemeral_max_life_s`. */
export const LEASE_EPHEMERAL_MAX_LIFE_S = 86400;
/** L3/r7-B2: how long an `expired` row keeps deferring. Shorter than the lost
 *  grace because the box is HEALTHY. Config `[leases].expired_grace_s`. */
export const LEASE_EXPIRED_GRACE_S = 600;
/** L3: how long a `lost` row keeps deferring when nobody releases it. Config
 *  `[leases].lost_grace_s`. */
export const LEASE_LOST_GRACE_S = 1800;

/** The knobs the `[leases]` config table can move (all of them optional). */
export interface LeaseLimits {
  ephemeralMaxLifeS: number;
  expiredGraceS: number;
  lostGraceS: number;
}

export const DEFAULT_LEASE_LIMITS: LeaseLimits = {
  ephemeralMaxLifeS: LEASE_EPHEMERAL_MAX_LIFE_S,
  expiredGraceS: LEASE_EXPIRED_GRACE_S,
  lostGraceS: LEASE_LOST_GRACE_S,
};

/** L1: 22 characters of base64url over 16 random bytes. */
export function newLeaseId(): string {
  return randomBytes(16).toString("base64url");
}

/** Does this store carry the `leases` table (schema v3)? */
export function leasesAvailable(store: Store): boolean {
  return store.userVersion() >= 3;
}

const SELECT_JOINED =
  `SELECT l.lease_id, l.box_id, b.name AS box, l.kind, l.holder, l.purpose, l.created_at,
          l.expires_at, l.renewed_at, l.released_at, l.state, l.expired_at, l.lost_at, l.lost_reason
     FROM leases l JOIN boxes b ON b.box_id = l.box_id`;

/** One lease by id, or undefined. */
export function leaseById(store: Store, id: string): LeaseRow | undefined {
  if (!leasesAvailable(store)) return undefined;
  return ((store.db.query(`${SELECT_JOINED} WHERE l.lease_id = ?`).get(id) as LeaseRow | null) ?? undefined);
}

/**
 * Every lease that still DEFERS, keyed by box NAME. ONE query — `GET /v1/fleet`
 * attaches the field to eleven boxes from this single read, never one query per
 * box (r10-B1).
 */
export function deferringLeases(store: Store): Map<string, LeaseRow> {
  const out = new Map<string, LeaseRow>();
  if (!leasesAvailable(store)) return out;
  const rows = store.db.query(`${SELECT_JOINED} WHERE l.released_at IS NULL`).all() as LeaseRow[];
  for (const r of rows) out.set(r.box, r);
  return out;
}

/** The deferring lease on one box, or undefined. */
export function deferringLeaseFor(store: Store, box: string): LeaseRow | undefined {
  if (!leasesAvailable(store)) return undefined;
  return (
    (store.db.query(`${SELECT_JOINED} WHERE l.released_at IS NULL AND b.name = ?`).get(box) as LeaseRow | null) ??
    undefined
  );
}

export interface ListLeasesOptions {
  /** include RELEASED rows too (`--all` / `?all=1`). Default: false. */
  all?: boolean;
  /** filter WITHIN the chosen set. */
  state?: LeaseState;
}

/** L3: the default set is `released_at IS NULL` — all three deferring states. */
export function listLeases(store: Store, opts: ListLeasesOptions = {}): LeaseRow[] {
  if (!leasesAvailable(store)) return [];
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.all !== true) where.push("l.released_at IS NULL");
  if (opts.state !== undefined) {
    where.push("l.state = ?");
    args.push(opts.state);
  }
  const sql = `${SELECT_JOINED}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY l.created_at DESC, l.lease_id`;
  return store.db.query(sql).all(...(args as never[])) as LeaseRow[];
}

export interface AcquireArgs {
  boxId: number;
  box: string;
  kind: LeaseKind;
  holder: string;
  purpose: string;
  /** ephemeral only; ignored for `service` (which has expires_at NULL). */
  ttlS?: number;
  now: number;
}

export type AcquireResult = { ok: true; lease: LeaseRow } | { ok: false; conflict: true };

/**
 * INSERT one lease. A racing second acquire on the same box loses to the partial
 * unique index and comes back `{ok:false, conflict:true}` — the 409 the API
 * serves. No lock is taken (L2).
 */
export function acquireLease(store: Store, a: AcquireArgs): AcquireResult {
  const id = newLeaseId();
  const expires = a.kind === "ephemeral" ? a.now + clampTtl(a.ttlS) : null;
  try {
    store.tx(() => {
      store.db
        .query(
          `INSERT INTO leases(lease_id,box_id,kind,holder,purpose,created_at,expires_at,state)
           VALUES(?,?,?,?,?,?,?,'active')`,
        )
        .run(id, a.boxId, a.kind, a.holder, a.purpose, a.now, expires);
      store.audit({
        actor: a.holder,
        action: "lease-acquire",
        box: a.box,
        rc: 0,
        at: a.now,
        detail: `${id} kind=${a.kind} purpose=${a.purpose}`,
      });
    });
  } catch (e) {
    if (isConstraint(e)) return { ok: false, conflict: true };
    throw e;
  }
  return { ok: true, lease: leaseById(store, id)! };
}

/** A TTL the caller asked for, clamped into [1, LEASE_MAX_TTL_S]. */
export function clampTtl(ttlS: number | undefined): number {
  if (ttlS === undefined || !Number.isFinite(ttlS) || ttlS <= 0) return LEASE_DEFAULT_TTL_S;
  return Math.min(Math.floor(ttlS), LEASE_MAX_TTL_S);
}

function isConstraint(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /constraint/i.test(msg);
}

export type RenewResult =
  | { ok: true; lease: LeaseRow }
  | { ok: false; code: "not_active" }
  | { ok: false; code: "lifetime_cap"; created_at: number; cap_at: number };

/**
 * Renew an ACTIVE lease.
 *
 * r7-B1: for an `ephemeral` lease the new `expires_at` may never exceed
 * `created_at + ephemeralMaxLifeS` — a HARD bound from creation, not a sliding
 * 24 h per call. A renew that would cross it is CLAMPED to the bound; a renew AT
 * or PAST it is refused `lifetime_cap`. So `--ttl 24h` is a valid, simply
 * unrenewable lease. The cap is per LEASE: release-then-acquire starts a fresh
 * one. `service` leases have no bound — that is what the kind is for.
 */
export function renewLease(
  store: Store,
  id: string,
  ttlS: number | undefined,
  now: number,
  limits: LeaseLimits = DEFAULT_LEASE_LIMITS,
): RenewResult {
  const row = leaseById(store, id);
  if (row === undefined || row.state !== "active") return { ok: false, code: "not_active" };
  if (row.kind === "service") {
    store.tx(() => {
      store.db.query("UPDATE leases SET renewed_at=? WHERE lease_id=?").run(now, id);
      store.audit({ actor: row.holder, action: "lease-renew", box: row.box, rc: 0, at: now, detail: `${id} service` });
    });
    return { ok: true, lease: leaseById(store, id)! };
  }
  const capAt = row.created_at + limits.ephemeralMaxLifeS;
  if (now >= capAt) return { ok: false, code: "lifetime_cap", created_at: row.created_at, cap_at: capAt };
  const want = now + clampTtl(ttlS);
  const next = Math.min(want, capAt);
  store.tx(() => {
    store.db.query("UPDATE leases SET expires_at=?, renewed_at=? WHERE lease_id=?").run(next, now, id);
    store.audit({
      actor: row.holder,
      action: "lease-renew",
      box: row.box,
      rc: 0,
      at: now,
      detail: `${id} expires_at=${next}${next === capAt ? " (clamped to lifetime cap)" : ""}`,
    });
  });
  return { ok: true, lease: leaseById(store, id)! };
}

export type ReleaseResult = { ok: true; lease: LeaseRow } | { ok: false; code: "not_found" };

/**
 * DELETE /v1/leases/:id — idempotent for every terminal state (r1-B5, r8-B1):
 *
 *   * `released`                       ⇒ 200 as is, nothing written;
 *   * `active`                         ⇒ state='released', released_at=now;
 *   * `expired` / `lost` still in grace ⇒ released_at=now, `state` KEPT (with
 *     `lost_reason` / `expired_at`), so the holder's DELETE ends the grace early
 *     and the box is eligible on the next acquire;
 *   * a row already SWEPT (released_at set) ⇒ a no-op 200 (r9-n2).
 */
export function releaseLease(store: Store, id: string, now: number): ReleaseResult {
  const row = leaseById(store, id);
  if (row === undefined) return { ok: false, code: "not_found" };
  if (row.released_at !== null) return { ok: true, lease: row };
  store.tx(() => {
    if (row.state === "active") {
      store.db.query("UPDATE leases SET state='released', released_at=? WHERE lease_id=?").run(now, id);
    } else {
      // `expired` / `lost` KEEP their state and their reason; only the grace ends.
      store.db.query("UPDATE leases SET released_at=? WHERE lease_id=?").run(now, id);
    }
    store.audit({
      actor: row.holder,
      action: "lease-release",
      box: row.box,
      rc: 0,
      at: now,
      detail: `${id} from=${row.state}`,
    });
  });
  return { ok: true, lease: leaseById(store, id)! };
}

/**
 * L3, per tick BEFORE the action loop: an `active` ephemeral lease whose
 * `expires_at` has passed becomes `expired`.
 *
 * `released_at` is NOT set here (r7-B2): the row keeps deferring AND keeps the
 * unique-index slot for the expired grace, because expiry can happen under a
 * running command (r6-B2). `sweepGraces` sets `released_at` when the grace ends.
 * Mutant (l19) sets it immediately and the expired-slot test catches it.
 */
export function expireDue(store: Store, now: number): LeaseRow[] {
  if (!leasesAvailable(store)) return [];
  const due = store.db
    .query(`${SELECT_JOINED} WHERE l.state='active' AND l.expires_at IS NOT NULL AND l.expires_at < ?`)
    .all(now) as LeaseRow[];
  for (const r of due) {
    store.tx(() => {
      store.db.query("UPDATE leases SET state='expired', expired_at=? WHERE lease_id=?").run(now, r.lease_id);
      store.audit({ actor: r.holder, action: "lease-expired", box: r.box, rc: 0, at: now, detail: r.lease_id });
    });
  }
  return due;
}

/** L3: mark an active lease `lost`, with the `observed` label as the reason. */
export function markLost(store: Store, row: LeaseRow, reason: string, now: number): void {
  store.tx(() => {
    store.db
      .query("UPDATE leases SET state='lost', lost_at=?, lost_reason=? WHERE lease_id=?")
      .run(now, reason, row.lease_id);
    store.audit({
      actor: row.holder,
      action: "lease-lost",
      box: row.box,
      rc: 0,
      at: now,
      detail: `${row.lease_id} reason=${reason}`,
    });
  });
}

export interface SweepGracesArgs {
  now: number;
  limits: LeaseLimits;
  /**
   * r2-n1: a `lost` grace may end EARLY once the box's `observed` has been back
   * in {healthy, drifted} for two consecutive ticks — a transient tailnet blip
   * must not take a box out of an eleven-box pool for half an hour. The caller
   * supplies the predicate (it reads `snapshot_boxes`, see `healthyTwoTicks`).
   */
  healthyTwoTicks?: (box: string) => boolean;
}

/**
 * End the graces: set `released_at` on `expired` rows past their grace and on
 * `lost` rows past theirs (or back-healthy for two consecutive ticks).
 *
 * r2-B1's requirement — an expired lease must not defer forever — IS this
 * function. Mutant (l9) drops the expired arm and the
 * expired-box-deferring-forever test fails.
 */
export function sweepGraces(store: Store, a: SweepGracesArgs): LeaseRow[] {
  if (!leasesAvailable(store)) return [];
  const open = store.db.query(`${SELECT_JOINED} WHERE l.released_at IS NULL AND l.state IN ('expired','lost')`).all() as LeaseRow[];
  const swept: LeaseRow[] = [];
  for (const r of open) {
    let action: string | undefined;
    if (r.state === "expired" && r.expired_at !== null && a.now >= r.expired_at + a.limits.expiredGraceS) {
      action = "lease-expired-released";
    } else if (r.state === "lost" && r.lost_at !== null) {
      if (a.now >= r.lost_at + a.limits.lostGraceS) action = "lease-lost-expired";
      else if (a.healthyTwoTicks?.(r.box) === true) action = "lease-lost-expired";
    }
    if (action === undefined) continue;
    store.tx(() => {
      store.db.query("UPDATE leases SET released_at=? WHERE lease_id=?").run(a.now, r.lease_id);
      store.audit({ actor: r.holder, action: action!, box: r.box, rc: 0, at: a.now, detail: r.lease_id });
    });
    swept.push(r);
  }
  return swept;
}

/**
 * When the deferral ends, for a row in a grace. EXACT for `expired`; an UPPER
 * BOUND for `lost`, whose grace may end earlier on two healthy ticks (r10-n1).
 * `null` for an `active` lease and for a row that has already been released.
 */
export function graceEndsAt(row: LeaseRow, limits: LeaseLimits = DEFAULT_LEASE_LIMITS): number | null {
  if (row.released_at !== null) return null;
  if (row.state === "expired" && row.expired_at !== null) return row.expired_at + limits.expiredGraceS;
  if (row.state === "lost" && row.lost_at !== null) return row.lost_at + limits.lostGraceS;
  return null;
}

// --- the two consecutive-tick predicates (r3-B2 / r4-B1) ---------------------

/**
 * The box's TWO most recent `snapshot_boxes` rows, newest first.
 *
 * SOURCE, stated once: `snapshot_boxes`, never `box_counters.checkfail`. They
 * are DIFFERENT predicates — a down tunnel reads `unhealthy` but never bumps
 * `checkfail`.
 *
 * "Previous tick" is EXACT ORDINAL ARITHMETIC on the monotonic `tick_seq`
 * (`prev.tick === current.tick - 1`), never a wall clock and never an interval:
 * grokfleet does not know its own cadence, which lives in the systemd timer.
 */
export function lastTwoObserved(store: Store, box: string): Array<{ tick: number; observed: string }> {
  if (store.userVersion() < 2) return [];
  return store.db
    .query("SELECT tick, observed FROM snapshot_boxes WHERE name = ? ORDER BY tick DESC LIMIT 2")
    .all(box) as Array<{ tick: number; observed: string }>;
}

/**
 * True iff the box's two most recent snapshots are CONSECUTIVE ticks and BOTH
 * satisfy `pred`.
 *
 * The conservative branch (r3-B2): when there is no row at `tick - 1` the answer
 * is FALSE — no loss is declared and no grace is ended early. Mutant (l11) reads
 * only the current tick and the missing-previous-snapshot test fails.
 */
export function twoConsecutiveTicks(
  rows: Array<{ tick: number; observed: string }>,
  pred: (observed: string) => boolean,
): boolean {
  if (rows.length < 2) return false;
  const [cur, prev] = rows as [{ tick: number; observed: string }, { tick: number; observed: string }];
  if (prev.tick !== cur.tick - 1) return false;
  return pred(cur.observed) && pred(prev.observed);
}

/** The `observed` labels that END a lost lease's grace early (r2-n1). */
export function isBackHealthy(observed: string): boolean {
  return observed === "healthy" || observed === "drifted";
}
