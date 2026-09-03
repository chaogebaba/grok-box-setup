// leases.test.ts — the `leases` table and its sweeps (blueprint
// fleet2-lease-api L1/L3/L7).
//
// Every mutant this file kills is named at its assertion.

import { describe, expect, test } from "bun:test";
import { openStore } from "../../src/store/db.ts";
import { KNOWN_SCHEMA } from "../../src/store/schema.ts";
import {
  acquireLease,
  clampTtl,
  DEFAULT_LEASE_LIMITS,
  deferringLeaseFor,
  deferringLeases,
  expireDue,
  graceEndsAt,
  isBackHealthy,
  lastTwoObserved,
  leaseById,
  leasesAvailable,
  listLeases,
  markLost,
  newLeaseId,
  releaseLease,
  renewLease,
  sweepGraces,
  twoConsecutiveTicks,
  LEASE_EPHEMERAL_MAX_LIFE_S,
  LEASE_EXPIRED_GRACE_S,
  LEASE_LOST_GRACE_S,
  type LeaseRow,
} from "../../src/store/leases.ts";
import { memStore, T0 } from "./helpers.ts";
import type { Store } from "../../src/store/db.ts";

function seedBox(store: Store, name: string, phase = "enrolled"): number {
  const idx = Number.parseInt(name.replace(/^\D+/, ""), 10);
  store.db
    .query(
      `INSERT INTO boxes(name,idx,port,phase,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
    )
    .run(name, idx, 20000 + idx, phase, T0, T0);
  return (store.db.query("SELECT box_id FROM boxes WHERE name=?").get(name) as { box_id: number }).box_id;
}

function seedSnapshotRow(store: Store, tick: number, name: string, observed: string): void {
  store.db.query("INSERT OR IGNORE INTO snapshots(tick,ts,apply) VALUES(?,?,0)").run(tick, T0 + tick);
  store.db
    .query(
      `INSERT INTO snapshot_boxes(tick,name,tunnel,"check",ver,drift,config,checkfail,asleep,expiry_days,observed)
       VALUES(?,?,'up','OK','5.3.0','no',NULL,0,0,NULL,?)`,
    )
    .run(tick, name, observed);
}

function acquire(store: Store, box: string, over: Partial<{ kind: "ephemeral" | "service"; ttlS: number; now: number; holder: string }> = {}) {
  const id = (store.db.query("SELECT box_id FROM boxes WHERE name=?").get(box) as { box_id: number }).box_id;
  return acquireLease(store, {
    boxId: id,
    box,
    kind: over.kind ?? "ephemeral",
    holder: over.holder ?? "ci:runner-3",
    purpose: "gate",
    ttlS: over.ttlS,
    now: over.now ?? T0,
  });
}

describe("L1 — the schema", () => {
  test("v3 exists, is additive, and min_reader is still 1", () => {
    const s = memStore();
    expect(KNOWN_SCHEMA).toBe(3);
    expect(s.userVersion()).toBe(3);
    expect(s.meta("min_reader")).toBe("1");
    expect(leasesAvailable(s)).toBe(true);
    s.close();
  });

  test("MUTANT (l1): the partial unique index refuses a SECOND deferring lease", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    expect(acquire(s, "grok-box-008").ok).toBe(true);
    // Drop the index and this second acquire succeeds — that is mutant (l1).
    const second = acquire(s, "grok-box-008", { holder: "other" });
    expect(second.ok).toBe(false);
    // …and a RELEASED lease frees the slot, because the index is partial.
    const first = listLeases(s)[0]!;
    releaseLease(s, first.lease_id, T0 + 10);
    expect(acquire(s, "grok-box-008", { now: T0 + 11, holder: "other" }).ok).toBe(true);
    s.close();
  });

  test("a lease id is 22 base64url characters", () => {
    for (let i = 0; i < 50; i++) expect(newLeaseId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test("a `service` lease has expires_at NULL; an ephemeral one gets the TTL", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    const svc = acquire(s, "grok-box-008", { kind: "service" });
    expect(svc.ok && svc.lease.expires_at).toBeNull();
    s.close();

    const s2 = memStore();
    seedBox(s2, "grok-box-009");
    const eph = acquire(s2, "grok-box-009", { ttlS: 3600 });
    expect(eph.ok && eph.lease.expires_at).toBe(T0 + 3600);
    s2.close();
  });

  test("a TTL is clamped into (0, 24h] and defaults to 2h", () => {
    expect(clampTtl(undefined)).toBe(7200);
    expect(clampTtl(0)).toBe(7200);
    expect(clampTtl(100)).toBe(100);
    expect(clampTtl(999_999)).toBe(86400);
  });
});

describe("L2/L3 — expiry, graces and the deferral rule", () => {
  test("expiry marks the row `expired` and does NOT release it (MUTANT l19)", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    acquire(s, "grok-box-008", { ttlS: 60 });
    const due = expireDue(s, T0 + 61);
    expect(due).toHaveLength(1);
    const row = listLeases(s)[0]!;
    expect(row.state).toBe("expired");
    expect(row.expired_at).toBe(T0 + 61);
    // The SLOT is still held: this is what mutant (l19) breaks.
    expect(row.released_at).toBeNull();
    expect(deferringLeaseFor(s, "grok-box-008")).toBeDefined();
    expect(acquire(s, "grok-box-008", { now: T0 + 62 }).ok).toBe(false);
    s.close();
  });

  test("MUTANT (l9): the expired grace ENDS, so an expired lease never defers forever", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    acquire(s, "grok-box-008", { ttlS: 60 });
    expireDue(s, T0 + 61);
    // Inside the grace: still deferring.
    expect(sweepGraces(s, { now: T0 + 61 + LEASE_EXPIRED_GRACE_S - 1, limits: DEFAULT_LEASE_LIMITS })).toHaveLength(0);
    expect(deferringLeaseFor(s, "grok-box-008")).toBeDefined();
    // Past it: swept, and the box is acquirable again.
    expect(sweepGraces(s, { now: T0 + 61 + LEASE_EXPIRED_GRACE_S, limits: DEFAULT_LEASE_LIMITS })).toHaveLength(1);
    expect(deferringLeaseFor(s, "grok-box-008")).toBeUndefined();
    expect(acquire(s, "grok-box-008", { now: T0 + 5000 }).ok).toBe(true);
    s.close();
  });

  test("the LOST grace ends at 30 min, or EARLY on two consecutive healthy ticks (r2-n1)", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    acquire(s, "grok-box-008");
    markLost(s, listLeases(s)[0]!, "asleep", T0 + 10);
    // Not yet, and no early end while the box is still not back.
    expect(sweepGraces(s, { now: T0 + 100, limits: DEFAULT_LEASE_LIMITS, healthyTwoTicks: () => false })).toHaveLength(0);
    // Two consecutive healthy ticks end it early.
    expect(sweepGraces(s, { now: T0 + 100, limits: DEFAULT_LEASE_LIMITS, healthyTwoTicks: () => true })).toHaveLength(1);
    expect(deferringLeaseFor(s, "grok-box-008")).toBeUndefined();
    s.close();

    // …and without the early end it lapses at the grace.
    const s2 = memStore();
    seedBox(s2, "grok-box-008");
    acquire(s2, "grok-box-008");
    markLost(s2, listLeases(s2)[0]!, "asleep", T0);
    expect(sweepGraces(s2, { now: T0 + LEASE_LOST_GRACE_S, limits: DEFAULT_LEASE_LIMITS })).toHaveLength(1);
    s2.close();
  });

  test("MUTANT (l7): deferral is `released_at IS NULL`, not `state='active'`", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    acquire(s, "grok-box-008");
    markLost(s, listLeases(s)[0]!, "unhealthy", T0 + 5);
    const map = deferringLeases(s);
    expect(map.get("grok-box-008")?.state).toBe("lost");
    // A lost lease still holds the box.
    expect(acquire(s, "grok-box-008", { now: T0 + 6 }).ok).toBe(false);
    s.close();
  });

  test("MUTANT (l20): DELETE on an EXPIRED row ends the grace and frees the slot", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    acquire(s, "grok-box-008", { ttlS: 60 });
    expireDue(s, T0 + 61);
    const id = listLeases(s)[0]!.lease_id;
    const r = releaseLease(s, id, T0 + 62);
    expect(r.ok).toBe(true);
    const row = leaseById(s, id)!;
    // The state and its reason are KEPT; only the deferral ends.
    expect(row.state).toBe("expired");
    expect(row.expired_at).toBe(T0 + 61);
    expect(row.released_at).toBe(T0 + 62);
    expect(acquire(s, "grok-box-008", { now: T0 + 63 }).ok).toBe(true);
    s.close();
  });

  test("DELETE is idempotent for every terminal state, and a swept row is a no-op (r9-n2)", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    acquire(s, "grok-box-008");
    const id = listLeases(s)[0]!.lease_id;
    expect(releaseLease(s, id, T0 + 1).ok).toBe(true);
    expect(leaseById(s, id)!.state).toBe("released");
    // Second DELETE: still 200, and released_at is NOT rewritten.
    expect(releaseLease(s, id, T0 + 99).ok).toBe(true);
    expect(leaseById(s, id)!.released_at).toBe(T0 + 1);
    expect(releaseLease(s, "nope", T0).ok).toBe(false);
    s.close();
  });

  test("`lost` keeps its reason through a DELETE", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    acquire(s, "grok-box-008");
    const id = listLeases(s)[0]!.lease_id;
    markLost(s, leaseById(s, id)!, "hostkey_mismatch", T0 + 5);
    releaseLease(s, id, T0 + 6);
    const row = leaseById(s, id)!;
    expect(row.state).toBe("lost");
    expect(row.lost_reason).toBe("hostkey_mismatch");
    expect(row.released_at).toBe(T0 + 6);
    s.close();
  });

  test("grace_ends_at is exact for `expired` and an upper bound for `lost` (r10-n1)", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    acquire(s, "grok-box-008", { ttlS: 60 });
    expireDue(s, T0 + 61);
    expect(graceEndsAt(listLeases(s)[0]!)).toBe(T0 + 61 + LEASE_EXPIRED_GRACE_S);
    s.close();

    const s2 = memStore();
    seedBox(s2, "grok-box-008");
    acquire(s2, "grok-box-008");
    markLost(s2, listLeases(s2)[0]!, "asleep", T0 + 3);
    expect(graceEndsAt(listLeases(s2)[0]!)).toBe(T0 + 3 + LEASE_LOST_GRACE_S);
    // An ACTIVE lease has no grace.
    const s3 = memStore();
    seedBox(s3, "grok-box-008");
    const a = acquire(s3, "grok-box-008");
    expect(graceEndsAt((a as { lease: LeaseRow }).lease)).toBeNull();
    s2.close();
    s3.close();
  });
});

describe("L2 — renew and the lifetime cap (r7-B1)", () => {
  test("MUTANT (l18): the cap is measured from created_at, not from now", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    acquire(s, "grok-box-008", { ttlS: 7200 });
    const id = listLeases(s)[0]!.lease_id;

    // A renew one minute short of the cap is CLAMPED to the cap, not extended
    // 24 h beyond it — which is exactly what mutant (l18) would do.
    const near = T0 + LEASE_EPHEMERAL_MAX_LIFE_S - 60;
    const r1 = renewLease(s, id, 86400, near);
    expect(r1.ok).toBe(true);
    expect(r1.ok && r1.lease.expires_at).toBe(T0 + LEASE_EPHEMERAL_MAX_LIFE_S);
    expect(r1.ok && r1.lease.renewed_at).toBe(near);

    // A renew AT the cap is refused.
    const r2 = renewLease(s, id, 3600, T0 + LEASE_EPHEMERAL_MAX_LIFE_S);
    expect(r2.ok).toBe(false);
    expect(!r2.ok && r2.code).toBe("lifetime_cap");
    expect(!r2.ok && r2.code === "lifetime_cap" && r2.cap_at).toBe(T0 + LEASE_EPHEMERAL_MAX_LIFE_S);
    s.close();
  });

  test("a `service` lease has no lifetime bound", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    acquire(s, "grok-box-008", { kind: "service" });
    const id = listLeases(s)[0]!.lease_id;
    const r = renewLease(s, id, undefined, T0 + 10 * LEASE_EPHEMERAL_MAX_LIFE_S);
    expect(r.ok).toBe(true);
    expect(r.ok && r.lease.expires_at).toBeNull();
    s.close();
  });

  test("renew on a non-active lease is `not_active`", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    acquire(s, "grok-box-008");
    const id = listLeases(s)[0]!.lease_id;
    releaseLease(s, id, T0 + 1);
    const r = renewLease(s, id, undefined, T0 + 2);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("not_active");
    s.close();
  });

  test("the cap is per LEASE: release-then-acquire starts a fresh bound (r8-n3)", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    acquire(s, "grok-box-008");
    const first = listLeases(s)[0]!.lease_id;
    releaseLease(s, first, T0 + 100);
    const again = acquire(s, "grok-box-008", { now: T0 + 101 });
    expect(again.ok).toBe(true);
    const r = renewLease(s, (again as { lease: LeaseRow }).lease.lease_id, 3600, T0 + 200);
    expect(r.ok).toBe(true);
    s.close();
  });
});

describe("L3 — the two consecutive-tick predicates (r3-B2/r4-B1)", () => {
  test("the source is snapshot_boxes, newest first, and it is EXACT tick arithmetic", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    seedSnapshotRow(s, 40, "grok-box-008", "unhealthy");
    seedSnapshotRow(s, 41, "grok-box-008", "healthy");
    const rows = lastTwoObserved(s, "grok-box-008");
    expect(rows.map((r) => r.tick)).toEqual([41, 40]);
    s.close();
  });

  test("MUTANT (l11): a GAP in the tick ordinals is the conservative branch", () => {
    // 39 and 41 are both healthy, but 40 is missing: not two CONSECUTIVE ticks.
    expect(
      twoConsecutiveTicks(
        [
          { tick: 41, observed: "healthy" },
          { tick: 39, observed: "healthy" },
        ],
        isBackHealthy,
      ),
    ).toBe(false);
    // One row only is also the conservative branch.
    expect(twoConsecutiveTicks([{ tick: 41, observed: "healthy" }], isBackHealthy)).toBe(false);
    // Consecutive and both healthy ⇒ true.
    expect(
      twoConsecutiveTicks(
        [
          { tick: 41, observed: "drifted" },
          { tick: 40, observed: "healthy" },
        ],
        isBackHealthy,
      ),
    ).toBe(true);
    // Consecutive but only one healthy ⇒ false.
    expect(
      twoConsecutiveTicks(
        [
          { tick: 41, observed: "healthy" },
          { tick: 40, observed: "unhealthy" },
        ],
        isBackHealthy,
      ),
    ).toBe(false);
  });

  test("`drifted` counts as back-healthy; the four bad labels do not", () => {
    expect(isBackHealthy("healthy")).toBe(true);
    expect(isBackHealthy("drifted")).toBe(true);
    for (const bad of ["asleep", "incoherent", "hostkey_mismatch", "unhealthy", "api_unknown"]) {
      expect(isBackHealthy(bad)).toBe(false);
    }
  });
});

describe("L2 — listing and audit", () => {
  test("the default set is the deferring rows; --all adds released ones", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    seedBox(s, "grok-box-009");
    acquire(s, "grok-box-008");
    const gone = acquire(s, "grok-box-009");
    releaseLease(s, (gone as { lease: LeaseRow }).lease.lease_id, T0 + 1);
    expect(listLeases(s).map((l) => l.box)).toEqual(["grok-box-008"]);
    expect(listLeases(s, { all: true })).toHaveLength(2);
    expect(listLeases(s, { all: true, state: "released" }).map((l) => l.box)).toEqual(["grok-box-009"]);
    s.close();
  });

  test("every write leaves an audit row with actor=<holder> and a lease-* action", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    acquire(s, "grok-box-008", { ttlS: 60 });
    const id = listLeases(s)[0]!.lease_id;
    renewLease(s, id, 60, T0 + 10);
    expireDue(s, T0 + 500);
    releaseLease(s, id, T0 + 501);
    const rows = s.db.query("SELECT actor, action FROM audit ORDER BY id").all() as Array<{
      actor: string;
      action: string;
    }>;
    expect(rows.map((r) => r.action)).toEqual([
      "lease-acquire",
      "lease-renew",
      "lease-expired",
      "lease-release",
    ]);
    for (const r of rows) expect(r.actor).toBe("ci:runner-3");
    s.close();
  });

  test("a box row deleted cascades its leases away", () => {
    const s = memStore();
    const id = seedBox(s, "grok-box-008");
    acquire(s, "grok-box-008");
    s.db.query("DELETE FROM boxes WHERE box_id=?").run(id);
    expect(listLeases(s, { all: true })).toHaveLength(0);
    s.close();
  });
});

describe("a v2 store has no lease layer at all", () => {
  test("every reader is inert rather than throwing", () => {
    const s = openStore({ path: ":memory:", now: () => T0 });
    // Simulate a Phase B file by pretending the migration stopped at v2.
    s.db.run("PRAGMA user_version = 2");
    expect(leasesAvailable(s)).toBe(false);
    expect(deferringLeases(s).size).toBe(0);
    expect(listLeases(s)).toEqual([]);
    expect(leaseById(s, "whatever")).toBeUndefined();
    expect(expireDue(s, T0)).toEqual([]);
    expect(sweepGraces(s, { now: T0, limits: DEFAULT_LEASE_LIMITS })).toEqual([]);
    s.close();
  });
});
