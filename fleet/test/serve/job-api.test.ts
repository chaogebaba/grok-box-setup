// job-api.test.ts — the /v1/jobs surface (blueprint grokfleet-jobs J3/J7).

import { afterAll, describe, expect, test } from "bun:test";
import { makeFetch } from "../../src/serve/server.ts";
import { fakeContext, getReq, postReq, TWO_TOKENS, jsonBody, jsonError } from "./helpers.ts";
import { suiteScratch } from "../store/helpers.ts";
import { openStore, storePath } from "../../src/store/db.ts";
import { writeSnapshot } from "../../src/store/snapshots.ts";
import { testRollout } from "../helpers.ts";
import { FakeRunner, result } from "../fake-runner.ts";
import { listLeases } from "../../src/store/leases.ts";
import { listJobs } from "../../src/store/jobs.ts";
import { ineligibleReason, type BoxFacts } from "../../src/serve/lease-eligibility.ts";
import type { SnapshotBox } from "../../src/history/schema.ts";
import type { Observed } from "../../src/reconcile/observe.ts";

const SCRATCH = suiteScratch("serve-jobs");
afterAll(() => SCRATCH.clean());

const NOW = 1_780_000_000;
const ADMIN = "ADMINSECRET";
const READ = "READSECRET";
/** The fleet runs boxup 5.5.2; anything below 5.5.0 has no job runner (J3). */
const WITH_RUNNER = "5.5.2";

function snapBox(name: string, ver: string): SnapshotBox {
  return {
    name,
    tunnel: "up",
    check: "OK",
    ver,
    drift: "no",
    config: "in-sync",
    checkfail: false,
    asleep: false,
    expiry_days: 40,
  };
}

function seedFleet(prefix: string, boxes: Array<{ name: string; ver?: string }>): string {
  const dir = SCRATCH.dir(prefix);
  const store = openStore({ path: storePath(dir), dir, now: () => NOW });
  try {
    for (const b of boxes) {
      const idx = Number.parseInt(b.name.replace(/^\D+/, ""), 10);
      store.db
        .query(`INSERT INTO boxes(name,idx,port,phase,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
        .run(b.name, idx, 20000 + idx, "enrolled", NOW, NOW);
    }
    const observed = new Map<string, Observed>(boxes.map((b) => [b.name, "healthy" as Observed]));
    writeSnapshot(store, {
      tick: 7,
      line: {
        v: 1,
        ts: new Date(NOW * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        apply: true,
        canary: null,
        boxes: boxes.map((b) => snapBox(b.name, b.ver ?? WITH_RUNNER)),
      },
      observed,
    });
  } finally {
    store.close();
  }
  return dir;
}

/** A box that starts jobs happily and reports whatever `status` is set to. */
function boxRunner(over: { startRc?: number; status?: string; logText?: string } = {}): FakeRunner {
  return new FakeRunner((argv) => {
    const cmd = argv[argv.length - 1] ?? "";
    if (cmd.includes("job' 'start")) return result({ code: over.startRc ?? 0 });
    if (cmd.includes("job' 'status")) {
      return result({
        stdout:
          over.status ??
          "state=running pid=41 pgid=41 rc=- started=2026-09-04T22:00:00Z ended=- log_bytes=0 truncations=0 truncated_total=0",
      });
    }
    if (cmd.includes("job' 'log")) return result({ stdout: over.logText ?? "" });
    if (cmd.includes("job' 'stop")) return result({ stdout: "job=x state=stopped rc=143" });
    return result({ code: 1 });
  });
}

async function ctxFor(dir: string, runner = boxRunner()) {
  return fakeContext({
    fleetState: dir,
    tokenBody: TWO_TOKENS,
    enrolled: ["grok-box-001", "grok-box-002"],
    rollout: testRollout({ canary: "grok-box-008" }),
    now: () => new Date(NOW * 1000),
    runner,
  });
}

const START = { cmd: "make test", purpose: "gate" };

describe("J3 — eligibility gains one reason", () => {
  const facts = (over: Partial<BoxFacts> = {}): BoxFacts => ({
    name: "grok-box-001",
    index: 1,
    phase: "enrolled",
    observed: "healthy",
    ver: WITH_RUNNER,
    ...over,
  });
  const input = (over: Record<string, unknown> = {}) =>
    ({
      boxes: [],
      snapshotTs: NOW,
      now: NOW,
      rolloutCanary: "grok-box-008",
      kind: "ephemeral" as const,
      require: {},
      ...over,
    }) as Parameters<typeof ineligibleReason>[1];

  test("a pre-5.5.0 box is refused ONLY when a job is being placed", () => {
    const old = facts({ ver: "5.4.0" });
    expect(ineligibleReason(old, input())).toBeUndefined();
    expect(ineligibleReason(old, input({ requireJobRunner: true }))).toBe("boxup lacks job runner");
  });

  test("an explicit boxup_version requirement is reported FIRST", () => {
    // The caller asked about a version; tell them about that, not about a
    // runner they never mentioned (the J3 precedence).
    const old = facts({ ver: "5.4.0" });
    const r = ineligibleReason(old, input({ requireJobRunner: true, require: { boxup_version: "9.9.9" } }));
    expect(r).toBe("boxup 5.4.0 < required 9.9.9");
  });

  test("a box WITH the runner passes", () => {
    expect(ineligibleReason(facts(), input({ requireJobRunner: true }))).toBeUndefined();
  });
});

describe("J7 — POST /v1/jobs", () => {
  test("starts a job, takes a lease, and reports it on /v1/fleet", async () => {
    const dir = seedFleet("start", [{ name: "grok-box-001" }, { name: "grok-box-002" }]);
    const ctx = await ctxFor(dir);
    const fetch = makeFetch(ctx);

    const r = await fetch(postReq("/v1/jobs", ADMIN, START));
    expect(r.status).toBe(201);
    const b = await jsonBody(r);
    expect(typeof b.job_id).toBe("string");
    expect(b.state).toBe("running");
    expect(typeof b.lease_id).toBe("string");

    // The lease the JOB took shows up like any other lease…
    const store = openStore({ path: storePath(dir), dir });
    expect(listLeases(store).length).toBe(1);
    expect(listJobs(store)[0]!.owned_lease).toBe(1);
    store.close();

    // …and the box carries a `job` field on the single endpoint the TUI polls.
    const fleet = await jsonBody(await fetch(getReq("/v1/fleet", READ)));
    const boxes = fleet.boxes as Array<{ name: string; job: { job_id: string; state: string } | null }>;
    const withJob = boxes.filter((x) => x.job !== null);
    expect(withJob.length).toBe(1);
    expect(withJob[0]!.job!.job_id).toBe(b.job_id as string);
  });

  test("a SECOND job on the same box is 409 box_busy", async () => {
    const dir = seedFleet("busy", [{ name: "grok-box-001" }]);
    const ctx = await ctxFor(dir);
    const fetch = makeFetch(ctx);

    expect((await fetch(postReq("/v1/jobs", ADMIN, START))).status).toBe(201);
    const r2 = await fetch(postReq("/v1/jobs", ADMIN, { ...START, box: "grok-box-001" }));
    // The first job holds the box's lease, so the second cannot even get one:
    // 409 either way, which is the contract a caller keys on.
    expect(r2.status).toBe(409);
  });

  test("the box's rc 75 (slot taken) is a 409, and the row + lease are cleaned up", async () => {
    const dir = seedFleet("slot", [{ name: "grok-box-001" }]);
    const ctx = await ctxFor(dir, boxRunner({ startRc: 75 }));
    const fetch = makeFetch(ctx);

    const r = await fetch(postReq("/v1/jobs", ADMIN, START));
    expect(r.status).toBe(409);
    expect((await jsonError(r)).error.code).toBe("box_busy");

    const store = openStore({ path: storePath(dir), dir });
    const rows = listJobs(store);
    // The row exists (it was written BEFORE the ssh, on purpose) but it is
    // closed, so nothing polls it forever…
    expect(rows.length).toBe(1);
    expect(rows[0]!.state).toBe("lost");
    expect(rows[0]!.lost_reason).toBe("box-slot-busy");
    // …and the lease we took for a job that never ran is handed back.
    expect(listLeases(store).length).toBe(0);
    store.close();
  });

  test("a service takes no cap, and a run's cap is bounded", async () => {
    const dir = seedFleet("cap", [{ name: "grok-box-001" }]);
    const fetch = makeFetch(await ctxFor(dir));
    const svc = await fetch(postReq("/v1/jobs", ADMIN, { ...START, kind: "service", wall_cap_s: 60 }));
    expect(svc.status).toBe(400);
    const big = await fetch(postReq("/v1/jobs", ADMIN, { ...START, wall_cap_s: 999999 }));
    expect(big.status).toBe(400);
  });

  test("readonly cannot start a job", async () => {
    const dir = seedFleet("scope", [{ name: "grok-box-001" }]);
    const fetch = makeFetch(await ctxFor(dir));
    expect((await fetch(postReq("/v1/jobs", READ, START))).status).toBe(403);
  });

  test("a fleet with no job-runner boxes answers 409 and NAMES the reason", async () => {
    const dir = seedFleet("old", [{ name: "grok-box-001", ver: "5.4.0" }]);
    const fetch = makeFetch(await ctxFor(dir));
    const r = await fetch(postReq("/v1/jobs", ADMIN, START));
    expect(r.status).toBe(409);
    const b = await jsonBody(r);
    expect((b.reasons as Record<string, string>)["grok-box-001"]).toBe("boxup lacks job runner");
  });
});

describe("J7 — reads", () => {
  test("GET /v1/jobs lists, and readonly scope is enough", async () => {
    const dir = seedFleet("list", [{ name: "grok-box-001" }]);
    const fetch = makeFetch(await ctxFor(dir));
    await fetch(postReq("/v1/jobs", ADMIN, START));
    const r = await fetch(getReq("/v1/jobs", READ));
    expect(r.status).toBe(200);
    expect((await jsonBody(r)).jobs as unknown[]).toHaveLength(1);
  });

  test("GET /v1/jobs/:id?refresh=1 polls the box inline", async () => {
    const dir = seedFleet("refresh", [{ name: "grok-box-001" }]);
    const ctx = await ctxFor(
      dir,
      boxRunner({
        status:
          "state=done pid=- pgid=41 rc=0 started=2026-09-04T22:00:00Z ended=2026-09-04T22:05:00Z log_bytes=0 truncations=0 truncated_total=0",
      }),
    );
    const fetch = makeFetch(ctx);
    const started = await jsonBody(await fetch(postReq("/v1/jobs", ADMIN, START)));
    const id = started.job_id as string;

    // Without refresh the row still says what the start path wrote.
    expect((await jsonBody(await fetch(getReq(`/v1/jobs/${encodeURIComponent(id)}`, READ)))).state).toBe("running");
    // With it, the box is asked NOW — this is what frees a waiting CLI from the
    // 5-minute tick.
    const after = await jsonBody(await fetch(getReq(`/v1/jobs/${encodeURIComponent(id)}?refresh=1`, READ)));
    expect(after.state).toBe("done");
    expect(after.rc).toBe(0);
  });

  test("the log endpoint answers RAW BYTES with the next offset in a header", async () => {
    const dir = seedFleet("log", [{ name: "grok-box-001" }]);
    const ctx = await ctxFor(
      dir,
      boxRunner({
        status:
          "state=running pid=41 pgid=41 rc=- started=2026-09-04T22:00:00Z ended=- log_bytes=5 truncations=0 truncated_total=0",
        logText: "hello",
      }),
    );
    const fetch = makeFetch(ctx);
    const started = await jsonBody(await fetch(postReq("/v1/jobs", ADMIN, START)));
    const id = started.job_id as string;
    await fetch(getReq(`/v1/jobs/${encodeURIComponent(id)}?refresh=1`, READ)); // mirrors the bytes

    const r = await fetch(getReq(`/v1/jobs/${encodeURIComponent(id)}/log`, READ));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/plain");
    expect(await r.text()).toBe("hello");
    expect(r.headers.get("x-job-log-offset")).toBe("5");
  });

  test("an unknown id is 404 on every read", async () => {
    const dir = seedFleet("404", [{ name: "grok-box-001" }]);
    const fetch = makeFetch(await ctxFor(dir));
    expect((await fetch(getReq("/v1/jobs/nope", READ))).status).toBe(404);
    expect((await fetch(getReq("/v1/jobs/nope/log", READ))).status).toBe(404);
  });
});

describe("J7 — stop", () => {
  test("stops a running job, releases its lease, and is IDEMPOTENT", async () => {
    const dir = seedFleet("stop", [{ name: "grok-box-001" }]);
    const ctx = await ctxFor(dir);
    const fetch = makeFetch(ctx);
    const started = await jsonBody(await fetch(postReq("/v1/jobs", ADMIN, START)));
    const id = started.job_id as string;

    const r1 = await fetch(postReq(`/v1/jobs/${encodeURIComponent(id)}/stop`, ADMIN, {}));
    expect(r1.status).toBe(200);
    const b1 = await jsonBody(r1);
    expect(b1.state).toBe("stopped");
    expect(b1.rc).toBe(143);

    const store = openStore({ path: storePath(dir), dir });
    expect(listLeases(store).length).toBe(0);
    store.close();

    // Twice must succeed: a retrying client is the normal case, not an error.
    const r2 = await fetch(postReq(`/v1/jobs/${encodeURIComponent(id)}/stop`, ADMIN, {}));
    expect(r2.status).toBe(200);
    expect((await jsonBody(r2)).state).toBe("stopped");
  });

  test("readonly cannot stop", async () => {
    const dir = seedFleet("stop-scope", [{ name: "grok-box-001" }]);
    const fetch = makeFetch(await ctxFor(dir));
    const started = await jsonBody(await fetch(postReq("/v1/jobs", ADMIN, START)));
    const id = started.job_id as string;
    expect((await fetch(postReq(`/v1/jobs/${encodeURIComponent(id)}/stop`, READ, {}))).status).toBe(403);
  });
});
