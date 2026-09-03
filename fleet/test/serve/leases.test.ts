// leases.test.ts — the /v1/leases surface and its eligibility rules (blueprint
// fleet2-lease-api L2/L3/L7).

import { afterAll, describe, expect, test } from "bun:test";
import { makeFetch } from "../../src/serve/server.ts";
import { fakeContext, getReq, postReq, TWO_TOKENS } from "./helpers.ts";
import { suiteScratch } from "../store/helpers.ts";
import { openStore, storePath } from "../../src/store/db.ts";
import { writeSnapshot } from "../../src/store/snapshots.ts";
import { testRollout } from "../helpers.ts";
import {
  chooseBox,
  compareVersions,
  ineligibleReason,
  leaseReason,
  type BoxFacts,
  type EligibilityInput,
} from "../../src/serve/lease-eligibility.ts";
import { expireDue, listLeases, markLost, type LeaseRow } from "../../src/store/leases.ts";
import type { SnapshotBox } from "../../src/history/schema.ts";
import type { Observed } from "../../src/reconcile/observe.ts";

const SCRATCH = suiteScratch("serve-leases");
afterAll(() => SCRATCH.clean());

const NOW = 1_780_000_000;
const ADMIN = "ADMINSECRET";
const READ = "READSECRET";

function snapBox(name: string, over: Partial<SnapshotBox> = {}): SnapshotBox {
  return {
    name,
    tunnel: "up",
    check: "OK",
    ver: "5.3.0",
    drift: "no",
    config: "in-sync",
    checkfail: false,
    asleep: false,
    expiry_days: 40,
    ...over,
  };
}

/**
 * A REAL `$FLEET_STATE` with three enrolled boxes and one fresh snapshot — the
 * shape every lease endpoint reads.
 */
function seedFleet(
  prefix: string,
  opts: {
    boxes?: Array<{ name: string; phase?: string; observed?: Observed; ver?: string; drift?: string }>;
    snapshotTs?: number;
    tick?: number;
  } = {},
): string {
  const dir = SCRATCH.dir(prefix);
  const boxes = opts.boxes ?? [
    { name: "grok-box-001" },
    { name: "grok-box-002" },
    { name: "grok-box-003" },
  ];
  const store = openStore({ path: storePath(dir), dir, now: () => NOW });
  try {
    for (const b of boxes) {
      const idx = Number.parseInt(b.name.replace(/^\D+/, ""), 10);
      store.db
        .query(`INSERT INTO boxes(name,idx,port,phase,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
        .run(b.name, idx, 20000 + idx, b.phase ?? "enrolled", NOW, NOW);
    }
    const observed = new Map<string, Observed>();
    for (const b of boxes) observed.set(b.name, b.observed ?? "healthy");
    writeSnapshot(store, {
      tick: opts.tick ?? 7,
      line: {
        v: 1,
        ts: new Date((opts.snapshotTs ?? NOW) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        apply: true,
        canary: null,
        boxes: boxes.map((b) => snapBox(b.name, { ver: b.ver ?? "5.3.0", drift: (b.drift ?? "no") as "no" })),
      },
      observed,
    });
  } finally {
    store.close();
  }
  return dir;
}

async function ctxFor(dir: string, over: { canary?: string; configText?: string } = {}) {
  return fakeContext({
    fleetState: dir,
    tokenBody: TWO_TOKENS,
    enrolled: ["grok-box-001", "grok-box-002", "grok-box-003"],
    rollout: testRollout({ canary: over.canary ?? "grok-box-008" }),
    now: () => new Date(NOW * 1000),
    ...(over.configText === undefined ? {} : { configText: over.configText }),
  });
}

function delReq(path: string, token: string): Request {
  return new Request(`http://t${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
}

// --- eligibility, pure -------------------------------------------------------

function facts(over: Partial<BoxFacts> = {}): BoxFacts {
  return { name: "grok-box-001", index: 1, phase: "enrolled", observed: "healthy", ver: "5.3.0", ...over };
}

function elig(over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    boxes: [facts()],
    snapshotTs: NOW,
    now: NOW,
    rolloutCanary: "grok-box-008",
    kind: "ephemeral",
    require: {},
    ...over,
  };
}

const activeLease = (over: Partial<LeaseRow> = {}): LeaseRow => ({
  lease_id: "L1",
  box_id: 1,
  box: "grok-box-001",
  kind: "ephemeral",
  holder: "ci:runner-3",
  purpose: "gate",
  created_at: NOW,
  expires_at: NOW + 3600,
  renewed_at: null,
  released_at: null,
  state: "active",
  expired_at: null,
  lost_at: null,
  lost_reason: null,
  ...over,
});

describe("L2 — eligibility and the r3-n5 reason precedence", () => {
  test("a healthy enrolled box in a fresh snapshot is eligible", () => {
    expect(ineligibleReason(facts(), elig())).toBeUndefined();
  });

  test("every reason string, in precedence order when several apply at once", () => {
    // Leased AND the canary AND asleep AND stale AND enrolling: `leased by` wins.
    const i = elig({ snapshotTs: NOW - 99_999, rolloutCanary: "grok-box-001" });
    const b = facts({ phase: "enrolling", observed: "asleep", lease: activeLease() });
    expect(ineligibleReason(b, i)).toBe(`leased by ci:runner-3 until ${new Date(
      (NOW + 3600) * 1000,
    ).toISOString().replace(/\.\d{3}Z$/, "Z")}`);

    // Drop the lease: the canary arm wins over observed/stale/phase.
    expect(ineligibleReason({ ...b, lease: undefined }, i)).toBe("configured rollout canary");
    // Drop the canary: `observed asleep` beats staleness and phase.
    expect(ineligibleReason({ ...b, lease: undefined }, elig({ snapshotTs: NOW - 99_999 }))).toBe("observed asleep");
    // Healthy but stale.
    expect(
      ineligibleReason(facts({ phase: "enrolling" }), elig({ snapshotTs: NOW - 99_999 })),
    ).toMatch(/^snapshot stale \(/);
    // Fresh: phase is the LAST arm.
    expect(ineligibleReason(facts({ phase: "enrolling" }), elig())).toBe("phase enrolling");
  });

  test("`api_unknown` has its own line, and it outranks staleness", () => {
    expect(ineligibleReason(facts({ observed: "api_unknown" }), elig())).toBe("observed api_unknown (read-only tick)");
  });

  test("MUTANT (l4): a stale snapshot is refused with the age in the reason", () => {
    const r = ineligibleReason(facts(), elig({ snapshotTs: NOW - 1200 }));
    expect(r).toBe("snapshot stale (20m)");
    // 15 minutes exactly is still fresh (the bound is `>`).
    expect(ineligibleReason(facts(), elig({ snapshotTs: NOW - 900 }))).toBeUndefined();
    // No snapshot at all, and a box the latest snapshot has no row for.
    expect(ineligibleReason(facts(), elig({ snapshotTs: null }))).toBe("snapshot stale (none)");
    expect(ineligibleReason(facts({ observed: undefined }), elig())).toBe("snapshot stale (never probed)");
  });

  test("`drifted` is ELIGIBLE by default and refused under require.no_drift (r1-B2)", () => {
    const b = facts({ observed: "drifted" });
    expect(ineligibleReason(b, elig())).toBeUndefined();
    expect(ineligibleReason(b, elig({ require: { no_drift: true } }))).toBe("drifted (require.no_drift)");
  });

  test("require.boxup_version compares numerically", () => {
    expect(compareVersions("5.9.0", "5.10.0")).toBeLessThan(0);
    expect(compareVersions("5.10.0", "5.9.0")).toBeGreaterThan(0);
    expect(compareVersions("5.10.0", "5.10.0")).toBe(0);
    expect(ineligibleReason(facts({ ver: "5.9.0" }), elig({ require: { boxup_version: "5.10.0" } }))).toBe(
      "boxup 5.9.0 < required 5.10.0",
    );
    expect(ineligibleReason(facts({ ver: "5.11.0" }), elig({ require: { boxup_version: "5.10.0" } }))).toBeUndefined();
    expect(ineligibleReason(facts({ ver: "-" }), elig({ require: { boxup_version: "5.10.0" } }))).toBe(
      "boxup unknown < required 5.10.0",
    );
  });

  test("the rollout canary opens ONLY for an ephemeral allow_canary lease (L3/r3-n4)", () => {
    const i = elig({ rolloutCanary: "grok-box-001" });
    expect(ineligibleReason(facts(), i)).toBe("configured rollout canary");
    expect(ineligibleReason(facts(), { ...i, require: { allow_canary: true } })).toBeUndefined();
    // A SERVICE lease on the rollout canary is always refused.
    expect(
      ineligibleReason(facts(), { ...i, kind: "service", require: { allow_canary: true } }),
    ).toBe("configured rollout canary");
  });

  test("the three lease reasons, one per deferring state", () => {
    expect(leaseReason(activeLease({ expires_at: null, kind: "service" }))).toBe("leased by ci:runner-3 (service)");
    expect(leaseReason(activeLease({ state: "lost", lost_reason: "asleep" }))).toBe("lost lease in grace (asleep)");
    expect(leaseReason(activeLease({ state: "expired" }))).toBe("leased by ci:runner-3 (expired, grace)");
  });

  test("the choice is the HIGHEST eligible index, or the named box (r3-n2)", () => {
    const boxes = [facts({ name: "grok-box-001", index: 1 }), facts({ name: "grok-box-009", index: 9 })];
    const r = chooseBox(elig({ boxes }));
    expect(r.chosen?.name).toBe("grok-box-009");
    expect(r.chosen_because).toBe("highest eligible index");
    const named = chooseBox(elig({ boxes, named: "grok-box-001" }));
    expect(named.chosen?.name).toBe("grok-box-001");
    expect(named.chosen_because).toBe("named box");
  });

  test("the reasons map covers enrolled+enrolling, and `retired` only when NAMED (r5-n3)", () => {
    const boxes = [
      facts({ name: "grok-box-001", index: 1, observed: "asleep" }),
      facts({ name: "grok-box-002", index: 2, phase: "enrolling" }),
      facts({ name: "grok-box-009", index: 9, phase: "retired" }),
    ];
    const r = chooseBox(elig({ boxes }));
    expect(Object.keys(r.reasons).sort()).toEqual(["grok-box-001", "grok-box-002"]);
    const named = chooseBox(elig({ boxes, named: "grok-box-009" }));
    expect(named.reasons["grok-box-009"]).toBe("phase retired");
    expect(Object.keys(named.reasons).sort()).toEqual(["grok-box-001", "grok-box-002", "grok-box-009"]);
  });
});

// --- the endpoints -----------------------------------------------------------

describe("L2 — POST /v1/leases", () => {
  test("201 carries the lease, the observed/drift facts and BOTH connect paths (r1-B1)", async () => {
    const dir = seedFleet("acquire-201");
    const fetch = makeFetch(await ctxFor(dir));
    const res = await fetch(postReq("/v1/leases", ADMIN, { purpose: "gate" }));
    expect(res.status).toBe(201);
    const b = (await res.json()) as Record<string, any>;
    expect(b.box).toBe("grok-box-003"); // highest eligible index
    expect(b.chosen_because).toBe("highest eligible index");
    expect(b.kind).toBe("ephemeral");
    expect(b.state).toBe("active");
    expect(b.holder).toBe("admin-one"); // the TOKEN's name
    expect(b.lease_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(b.observed).toBe("healthy");
    expect(b.drift).toBe("no");
    expect(b.connect.cli).toBe(`grokfleet ssh --lease ${b.lease_id} [--via tailnet|tunnel] '<cmd>'`);
    expect(b.connect.tunnel.port).toBe(20003);
    expect(b.connect.tunnel.host).toBe("127.0.0.1");
    expect(b.connect.tailnet.host).toBe("grok-box-003");
    // 2h default TTL.
    expect(Date.parse(b.expires_at) / 1000 - NOW).toBe(7200);
  });

  test("a named box is honoured, and a SECOND acquire on it is 409 `leased by`", async () => {
    const dir = seedFleet("acquire-409");
    const fetch = makeFetch(await ctxFor(dir));
    const first = await fetch(postReq("/v1/leases", ADMIN, { purpose: "a", box: "grok-box-002" }));
    expect(first.status).toBe(201);
    expect(((await first.json()) as { box: string }).box).toBe("grok-box-002");

    const second = await fetch(postReq("/v1/leases", ADMIN, { purpose: "b", box: "grok-box-002" }));
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string }; reasons: Record<string, string> };
    expect(body.error.code).toBe("no_eligible_box");
    expect(body.reasons["grok-box-002"]).toContain("leased by admin-one until");
    // the FULL fleet map comes back, so an agent can pick another box itself.
    expect(Object.keys(body.reasons).sort()).toEqual(["grok-box-001", "grok-box-002", "grok-box-003"]);
    // …and a box that WAS free is named as such, so an agent can retry on it.
    expect(body.reasons["grok-box-001"]).toBe("eligible (not requested)");
  });

  test("409 when the whole fleet is ineligible, with one reason per box", async () => {
    const dir = seedFleet("acquire-none", {
      boxes: [
        { name: "grok-box-001", observed: "asleep" },
        { name: "grok-box-002", observed: "unhealthy" },
      ],
    });
    const fetch = makeFetch(await ctxFor(dir));
    const res = await fetch(postReq("/v1/leases", ADMIN, { purpose: "gate" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reasons: Record<string, string> };
    expect(body.reasons).toEqual({
      "grok-box-001": "observed asleep",
      "grok-box-002": "observed unhealthy",
    });
  });

  test("TWO CONCURRENT acquires for the same named box: one 201, one 409 (L2)", async () => {
    const dir = seedFleet("acquire-race");
    const fetch = makeFetch(await ctxFor(dir));
    const [a, b] = await Promise.all([
      fetch(postReq("/v1/leases", ADMIN, { purpose: "a", box: "grok-box-001" })),
      fetch(postReq("/v1/leases", ADMIN, { purpose: "b", box: "grok-box-001" })),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([201, 409]);
  });

  test("acquire while a fake tick HOLDS the reconcile lock returns 201 immediately (L2)", async () => {
    const dir = seedFleet("acquire-lockfree");
    // The reconcile lock file exists and is 'held' — no lease endpoint consults
    // it, so this must not even slow down, let alone 423.
    const ctx = await ctxFor(dir);
    const fetch = makeFetch(ctx);
    const res = await fetch(postReq("/v1/leases", ADMIN, { purpose: "gate" }));
    expect(res.status).toBe(201);
    expect(res.status).not.toBe(423);
  });

  test("bad bodies are 400, and require.max_disk_pct is REFUSED by name (r1-B3)", async () => {
    const dir = seedFleet("acquire-400");
    const fetch = makeFetch(await ctxFor(dir));
    const cases: Array<[unknown, string]> = [
      [{}, "purpose"],
      [{ purpose: "x", kind: "forever" }, "kind"],
      [{ purpose: "x", ttl_s: -1 }, "ttl_s"],
      [{ purpose: "x", ttl_s: 999999 }, "ttl_s"],
      [{ purpose: "x", box: "not-a-box" }, "box"],
      [{ purpose: "x", require: { max_disk_pct: 80 } }, "max_disk_pct"],
      [{ purpose: "x", require: { nonsense: 1 } }, "nonsense"],
    ];
    for (const [body, needle] of cases) {
      const res = await fetch(postReq("/v1/leases", ADMIN, body));
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain(needle);
    }
  });

  test("the configured rollout canary is refused without allow_canary", async () => {
    const dir = seedFleet("acquire-canary");
    const fetch = makeFetch(await ctxFor(dir, { canary: "grok-box-003" }));
    const res = await fetch(postReq("/v1/leases", ADMIN, { purpose: "gate", box: "grok-box-003" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { reasons: Record<string, string> };
    expect(body.reasons["grok-box-003"]).toBe("configured rollout canary");

    const ok = await fetch(
      postReq("/v1/leases", ADMIN, { purpose: "gate", box: "grok-box-003", require: { allow_canary: true } }),
    );
    expect(ok.status).toBe(201);
  });
});

describe("L2 — renew, release, list, show", () => {
  test("renew returns the new expires_at; the lifetime cap is a 409 naming both bounds", async () => {
    const dir = seedFleet("renew");
    const ctx = await ctxFor(dir);
    const fetch = makeFetch(ctx);
    const acq = (await (await fetch(postReq("/v1/leases", ADMIN, { purpose: "gate" }))).json()) as {
      lease_id: string;
    };
    const r = await fetch(postReq(`/v1/leases/${acq.lease_id}/renew`, ADMIN, { ttl_s: 60 }));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { expires_at: string };
    expect(Date.parse(body.expires_at) / 1000).toBe(NOW + 60);

    // Push the row's created_at back past the cap and renew again.
    const store = openStore({ path: storePath(dir), dir });
    store.db.query("UPDATE leases SET created_at = ? WHERE lease_id = ?").run(NOW - 86400, acq.lease_id);
    store.close();
    const capped = await fetch(postReq(`/v1/leases/${acq.lease_id}/renew`, ADMIN, {}));
    expect(capped.status).toBe(409);
    const cb = (await capped.json()) as { error: { code: string }; created_at: string; cap_at: string };
    expect(cb.error.code).toBe("lifetime_cap");
    expect(Date.parse(cb.cap_at) / 1000).toBe(NOW);
  });

  test("DELETE is 200 and idempotent; a second DELETE changes nothing", async () => {
    const dir = seedFleet("release");
    const fetch = makeFetch(await ctxFor(dir));
    const acq = (await (await fetch(postReq("/v1/leases", ADMIN, { purpose: "gate" }))).json()) as {
      lease_id: string;
    };
    const one = await fetch(delReq(`/v1/leases/${acq.lease_id}`, ADMIN));
    expect(one.status).toBe(200);
    expect(((await one.json()) as { state: string }).state).toBe("released");
    const two = await fetch(delReq(`/v1/leases/${acq.lease_id}`, ADMIN));
    expect(two.status).toBe(200);
    expect((await fetch(delReq("/v1/leases/nope", ADMIN))).status).toBe(404);
  });

  test("GET /v1/leases defaults to the deferring set; ?all=1 and ?state= filter it", async () => {
    const dir = seedFleet("list");
    const fetch = makeFetch(await ctxFor(dir));
    const keep = (await (await fetch(postReq("/v1/leases", ADMIN, { purpose: "keep", box: "grok-box-001" }))).json()) as {
      lease_id: string;
    };
    const gone = (await (await fetch(postReq("/v1/leases", ADMIN, { purpose: "gone", box: "grok-box-002" }))).json()) as {
      lease_id: string;
    };
    await fetch(delReq(`/v1/leases/${gone.lease_id}`, ADMIN));

    const def = (await (await fetch(getReq("/v1/leases", READ))).json()) as { leases: Array<{ lease_id: string }> };
    expect(def.leases.map((l) => l.lease_id)).toEqual([keep.lease_id]);
    const all = (await (await fetch(getReq("/v1/leases?all=1", READ))).json()) as { leases: unknown[] };
    expect(all.leases).toHaveLength(2);
    const rel = (await (await fetch(getReq("/v1/leases?all=1&state=released", READ))).json()) as {
      leases: Array<{ lease_id: string }>;
    };
    expect(rel.leases.map((l) => l.lease_id)).toEqual([gone.lease_id]);
    expect((await fetch(getReq("/v1/leases?state=bogus", READ))).status).toBe(400);

    const one = await fetch(getReq(`/v1/leases/${keep.lease_id}`, READ));
    expect(one.status).toBe(200);
    expect(((await one.json()) as { box: string }).box).toBe("grok-box-001");
    expect((await fetch(getReq("/v1/leases/nope", READ))).status).toBe(404);
  });

  test("SCOPE: readonly may GET but never POST or DELETE", async () => {
    const dir = seedFleet("scope");
    const fetch = makeFetch(await ctxFor(dir));
    expect((await fetch(getReq("/v1/leases", READ))).status).toBe(200);
    expect((await fetch(postReq("/v1/leases", READ, { purpose: "x" }))).status).toBe(403);
    expect((await fetch(postReq("/v1/leases/x/renew", READ, {}))).status).toBe(403);
    expect((await fetch(delReq("/v1/leases/x", READ))).status).toBe(403);
    // …and an unauthenticated request is 401 everywhere.
    expect((await fetch(getReq("/v1/leases"))).status).toBe(401);
  });

  test("every mutation writes an audit line naming the token and the action", async () => {
    const dir = seedFleet("audit");
    const ctx = await ctxFor(dir);
    const lines: string[] = [];
    ctx.auditSink = { append: (_s, l) => lines.push(l.trim()) };
    const fetch = makeFetch(ctx);
    const acq = (await (await fetch(postReq("/v1/leases", ADMIN, { purpose: "gate" }))).json()) as {
      lease_id: string;
    };
    await fetch(postReq(`/v1/leases/${acq.lease_id}/renew`, ADMIN, {}));
    await fetch(delReq(`/v1/leases/${acq.lease_id}`, ADMIN));
    expect(lines.map((l) => l.replace(/^\S+ /, ""))).toEqual([
      "token=admin-one action=lease-acquire box=grok-box-003 rc=0",
      "token=admin-one action=lease-renew box=grok-box-003 rc=0",
      "token=admin-one action=lease-release box=grok-box-003 rc=0",
    ]);
  });
});

describe("L2/L3 — the lease field on /v1/fleet and /v1/boxes/:name", () => {
  test("MUTANT (l22): /v1/fleet carries `lease` on each box entry, any deferring state", async () => {
    const dir = seedFleet("fleet-field");
    const fetch = makeFetch(await ctxFor(dir));
    await fetch(postReq("/v1/leases", ADMIN, { purpose: "gate", box: "grok-box-002" }));
    const view = (await (await fetch(getReq("/v1/fleet", READ))).json()) as {
      boxes: Array<{ name: string; lease: { holder: string; state: string } | null }>;
    };
    const by = new Map(view.boxes.map((b) => [b.name, b.lease]));
    expect(by.get("grok-box-002")?.holder).toBe("admin-one");
    expect(by.get("grok-box-002")?.state).toBe("active");
    expect(by.get("grok-box-001")).toBeNull();
    // GET /v1/history does NOT carry it (history is what was OBSERVED).
    const hist = (await (await fetch(getReq("/v1/history?box=grok-box-002&hours=24", READ))).json()) as {
      lines: Array<{ boxes: Array<Record<string, unknown>> }>;
    };
    expect(hist.lines[0]!.boxes[0]!["lease"]).toBeUndefined();
  });

  test("MUTANT (l21/l22): a box in EXPIRED grace shows lease.state='expired' on BOTH endpoints", async () => {
    const dir = seedFleet("expired-grace");
    const fetch = makeFetch(await ctxFor(dir));
    await fetch(postReq("/v1/leases", ADMIN, { purpose: "gate", box: "grok-box-001", ttl_s: 60 }));
    // A tick expires it; the grace has not lapsed.
    const store = openStore({ path: storePath(dir), dir });
    expireDue(store, NOW + 61);
    store.close();

    const view = (await (await fetch(getReq("/v1/fleet", READ))).json()) as {
      boxes: Array<{ name: string; lease: { state: string; grace_ends_at: string | null } | null }>;
    };
    const f = view.boxes.find((b) => b.name === "grok-box-001")!;
    expect(f.lease?.state).toBe("expired");
    expect(f.lease?.grace_ends_at).not.toBeNull();

    const box = (await (await fetch(getReq("/v1/boxes/grok-box-001", READ))).json()) as {
      lease: { state: string } | null;
    };
    expect(box.lease?.state).toBe("expired");
  });

  test("a LOST lease shows on both endpoints with its reason", async () => {
    const dir = seedFleet("lost-field");
    const fetch = makeFetch(await ctxFor(dir));
    await fetch(postReq("/v1/leases", ADMIN, { purpose: "gate", box: "grok-box-001" }));
    const store = openStore({ path: storePath(dir), dir });
    markLost(store, listLeases(store)[0]!, "asleep", NOW + 5);
    store.close();
    const view = (await (await fetch(getReq("/v1/fleet", READ))).json()) as {
      boxes: Array<{ name: string; lease: { state: string } | null }>;
    };
    expect(view.boxes.find((b) => b.name === "grok-box-001")!.lease?.state).toBe("lost");
    const one = (await (await fetch(getReq(`/v1/leases/${listLeasesId(dir)}`, READ))).json()) as {
      lost_reason: string;
    };
    expect(one.lost_reason).toBe("asleep");
  });

  test("a store WITHOUT the lease table serves `lease: null`, never an error", async () => {
    // A Phase B (v2) file, exactly as a rolled-back binary leaves it. The READ
    // paths open READ-ONLY, so they report "no lease layer" rather than
    // migrating the file forward behind a GET.
    const dir = seedFleet("v2-store");
    const store = openStore({ path: storePath(dir), dir });
    store.db.run("DROP TABLE leases");
    store.db.run("PRAGMA user_version = 2");
    store.close();
    const fetch = makeFetch(await ctxFor(dir));
    const view = (await (await fetch(getReq("/v1/fleet", READ))).json()) as {
      boxes: Array<{ lease: unknown }>;
    };
    for (const b of view.boxes) expect(b.lease).toBeNull();
    const empty = (await (await fetch(getReq("/v1/leases", READ))).json()) as { leases: unknown[] };
    expect(empty.leases).toEqual([]);
    // An ACQUIRE opens read-write, which migrates the file forward — that is
    // what a first lease on an upgraded brain needs, and it is additive.
    expect((await fetch(postReq("/v1/leases", ADMIN, { purpose: "x" }))).status).toBe(201);
  });
});

function listLeasesId(dir: string): string {
  const store = openStore({ path: storePath(dir), dir, readonly: true });
  try {
    return (store.db.query("SELECT lease_id FROM leases LIMIT 1").get() as { lease_id: string }).lease_id;
  } finally {
    store.close();
  }
}
