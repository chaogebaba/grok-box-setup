// jobs.test.ts — the `jobs` table (blueprint grokfleet-jobs J4/J5).

import { describe, expect, test } from "bun:test";
import { KNOWN_SCHEMA } from "../../src/store/schema.ts";
import {
  activeJobFor,
  activeJobs,
  createJob,
  dueJobs,
  jobById,
  jobsAvailable,
  listJobs,
  loseJob,
  newJobId,
  updateJob,
} from "../../src/store/jobs.ts";
import { acquireLease } from "../../src/store/leases.ts";
import { memStore, T0 } from "./helpers.ts";
import type { Store } from "../../src/store/db.ts";

function seedBox(store: Store, name: string, phase = "enrolled"): number {
  const idx = Number.parseInt(name.replace(/^\D+/, ""), 10);
  store.db
    .query(`INSERT INTO boxes(name,idx,port,phase,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .run(name, idx, 20000 + idx, phase, T0, T0);
  return (store.db.query("SELECT box_id FROM boxes WHERE name=?").get(name) as { box_id: number }).box_id;
}

function mkJob(
  store: Store,
  box: string,
  over: Partial<{ kind: "run" | "service"; leaseId: string | null; ownedLease: boolean; now: number }> = {},
) {
  const boxId = (store.db.query("SELECT box_id FROM boxes WHERE name=?").get(box) as { box_id: number }).box_id;
  return createJob(store, {
    jobId: newJobId(),
    boxId,
    box,
    leaseId: over.leaseId ?? null,
    ownedLease: over.ownedLease ?? false,
    kind: over.kind ?? "run",
    holder: "ci:runner-3",
    purpose: "gate",
    cmd: "make test",
    cwd: "/workspace",
    wallCapS: 2400,
    keepAlive: false,
    now: over.now ?? T0,
  });
}

describe("J4 — the schema", () => {
  test("v4 exists, is additive, and min_reader is still 1", () => {
    const s = memStore();
    expect(KNOWN_SCHEMA).toBe(4);
    expect(s.userVersion()).toBe(4);
    expect(s.meta("min_reader")).toBe("1");
    expect(jobsAvailable(s)).toBe(true);
    s.close();
  });

  test("a job id is 22 base64url characters", () => {
    for (let i = 0; i < 50; i++) expect(newJobId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  test("the state CHECK refuses a state outside the eight", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    const j = mkJob(s, "grok-box-008");
    // Writing a state the brain does not have must fail LOUDLY at the schema,
    // not sit in the table waiting to confuse the poller.
    expect(() =>
      s.db.query("UPDATE jobs SET state='wedged' WHERE job_id=?").run(j.job_id),
    ).toThrow();
    s.close();
  });
});

describe("J7 — one job per box", () => {
  test("activeJobFor sees starting and running, and stops seeing a terminal job", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    const j = mkJob(s, "grok-box-008");
    expect(activeJobFor(s, "grok-box-008")?.job_id).toBe(j.job_id);

    updateJob(s, j.job_id, { state: "running", lastPollAt: T0 + 5 });
    expect(activeJobFor(s, "grok-box-008")?.job_id).toBe(j.job_id);

    updateJob(s, j.job_id, { state: "done", rc: 0, lastPollAt: T0 + 10, endedAt: T0 + 10 });
    // The slot is free again — a box accumulates terminal rows for its whole
    // life and only the open ones occupy it.
    expect(activeJobFor(s, "grok-box-008")).toBeUndefined();
    s.close();
  });

  test("activeJobs is ONE query keyed by box name (the /v1/fleet shape)", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    seedBox(s, "grok-box-009");
    const a = mkJob(s, "grok-box-008");
    const b = mkJob(s, "grok-box-009");
    updateJob(s, b.job_id, { state: "done", rc: 0, lastPollAt: T0 });
    const m = activeJobs(s);
    expect([...m.keys()]).toEqual(["grok-box-008"]);
    expect(m.get("grok-box-008")?.job_id).toBe(a.job_id);
    s.close();
  });
});

describe("J5 — the due order", () => {
  test("a NEVER-POLLED job sorts ahead of one polled long ago, so nothing starves", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    seedBox(s, "grok-box-009");
    const old = mkJob(s, "grok-box-008", { now: T0 });
    updateJob(s, old.job_id, { state: "running", lastPollAt: T0 + 1 });
    const fresh = mkJob(s, "grok-box-009", { now: T0 + 2 }); // last_poll_at IS NULL

    // MUTANT: order by `last_poll_at ASC` alone and SQLite sorts NULL first
    // anyway — but order by `COALESCE(last_poll_at, <now>)` and the new job goes
    // LAST, which is the starvation this ordering exists to prevent.
    expect(dueJobs(s).map((j) => j.job_id)).toEqual([fresh.job_id, old.job_id]);
    s.close();
  });

  test("terminal jobs are not due", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    const j = mkJob(s, "grok-box-008");
    updateJob(s, j.job_id, { state: "failed", rc: 2, lastPollAt: T0 });
    expect(dueJobs(s)).toEqual([]);
    s.close();
  });
});

describe("the update is COALESCE-shaped", () => {
  test("a poll that read a status but fetched no log does not zero the counters", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    const j = mkJob(s, "grok-box-008");
    updateJob(s, j.job_id, { state: "running", lastPollAt: T0, logBytes: 500, mirrored: 500, logOffset: 500 });
    // The next poll names only the state and the stamp.
    updateJob(s, j.job_id, { state: "running", lastPollAt: T0 + 5 });
    const after = jobById(s, j.job_id)!;
    expect(after.log_bytes).toBe(500);
    expect(after.mirrored).toBe(500);
    expect(after.log_offset).toBe(500);
    expect(after.last_poll_at).toBe(T0 + 5);
    s.close();
  });

  test("log_offset CAN be reset to 0 — the truncation path depends on it", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    const j = mkJob(s, "grok-box-008");
    updateJob(s, j.job_id, { state: "running", lastPollAt: T0, logOffset: 900 });
    updateJob(s, j.job_id, { state: "running", lastPollAt: T0 + 5, logOffset: 0 });
    // COALESCE keeps a stored value when the field is ABSENT, not when it is 0.
    // Getting this wrong would make the brain re-fetch from a stale offset after
    // every box-side truncation, splicing old bytes into the mirror.
    expect(jobById(s, j.job_id)!.log_offset).toBe(0);
    s.close();
  });
});

describe("loseJob", () => {
  test("closes an OPEN job and leaves a terminal one alone", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    const open = mkJob(s, "grok-box-008");
    loseJob(s, open.job_id, "box-gone", T0 + 30);
    const a = jobById(s, open.job_id)!;
    expect(a.state).toBe("lost");
    expect(a.lost_reason).toBe("box-gone");

    updateJob(s, open.job_id, { state: "done", rc: 0, lastPollAt: T0 + 40 });
    loseJob(s, open.job_id, "later", T0 + 50);
    // A finished job is not re-lost: the WHERE clause is what stops a late
    // sweep from overwriting a real result with `lost`.
    expect(jobById(s, open.job_id)!.state).toBe("done");
    s.close();
  });
});

describe("lease ownership is recorded, not inferred", () => {
  test("a caller-supplied lease is owned_lease=0 even with the same holder", () => {
    const s = memStore();
    const boxId = seedBox(s, "grok-box-008");
    const acq = acquireLease(s, {
      boxId,
      box: "grok-box-008",
      kind: "ephemeral",
      holder: "ci:runner-3",
      purpose: "gate",
      now: T0,
    });
    expect(acq.ok).toBe(true);
    if (!acq.ok) return;
    const j = mkJob(s, "grok-box-008", { leaseId: acq.lease.lease_id, ownedLease: false });
    // Same holder on both. Inferring ownership from the holder — which is the
    // obvious shortcut — would release a lease the caller still needs.
    expect(jobById(s, j.job_id)!.owned_lease).toBe(0);
    expect(jobById(s, j.job_id)!.holder).toBe(acq.lease.holder);
    s.close();
  });
});

describe("listJobs", () => {
  test("filters by state and by box", () => {
    const s = memStore();
    seedBox(s, "grok-box-008");
    seedBox(s, "grok-box-009");
    const a = mkJob(s, "grok-box-008");
    const b = mkJob(s, "grok-box-009");
    updateJob(s, b.job_id, { state: "failed", rc: 3, lastPollAt: T0 });
    expect(listJobs(s, { box: "grok-box-008" }).map((j) => j.job_id)).toEqual([a.job_id]);
    expect(listJobs(s, { state: "failed" }).map((j) => j.job_id)).toEqual([b.job_id]);
    expect(listJobs(s).length).toBe(2);
    s.close();
  });
});
