// reconcile-jobs.test.ts — the brain-side job poll (blueprint grokfleet-jobs
// J5/J6/J11). Every mutant this file kills is named at its assertion.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { JobTick, pollJob, type JobLogSink, type JobTickDeps } from "../src/reconcile/job-tick.ts";
import { createJob, jobById, newJobId, updateJob, type JobRow } from "../src/store/jobs.ts";
import { acquireLease, leaseById } from "../src/store/leases.ts";
import { StoreState } from "../src/store/state.ts";
import { openStore, type Store } from "../src/store/db.ts";
import { FakeRunner, result } from "./fake-runner.ts";
import { setLogSink } from "../src/log.ts";

const T0 = 1_700_000_000;

let restore: (l: string) => void;
beforeEach(() => {
  restore = setLogSink(() => {});
});
afterEach(() => setLogSink(restore));

function store(): Store {
  return openStore({ path: ":memory:", dir: "/tmp", now: () => T0 });
}

function seedBox(s: Store, name: string): number {
  const idx = Number.parseInt(name.replace(/^\D+/, ""), 10);
  s.db
    .query(`INSERT INTO boxes(name,idx,port,phase,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .run(name, idx, 20000 + idx, "enrolled", T0, T0);
  return (s.db.query("SELECT box_id FROM boxes WHERE name=?").get(name) as { box_id: number }).box_id;
}

/** An in-memory log mirror. */
function memLogs(): JobLogSink & { text(id: string): string } {
  const m = new Map<string, string>();
  return {
    append: (id, t) => m.set(id, (m.get(id) ?? "") + t),
    size: (id) => (m.get(id) ?? "").length,
    read: (id, off, lim) => (m.get(id) ?? "").slice(off, off + lim),
    text: (id) => m.get(id) ?? "",
  };
}

/** The status line boxup answers with. */
function statusLine(o: Partial<{
  state: string;
  rc: string;
  logBytes: number;
  truncations: number;
  truncatedTotal: number;
}> = {}): string {
  return (
    `state=${o.state ?? "running"} pid=41 pgid=41 rc=${o.rc ?? "-"} started=2026-09-04T22:00:00Z ` +
    `ended=- log_bytes=${o.logBytes ?? 0} truncations=${o.truncations ?? 0} ` +
    `truncated_total=${o.truncatedTotal ?? 0}`
  );
}

const isStatus = (argv: string[]): boolean => (argv[argv.length - 1] ?? "").includes("job' 'status");
const isLog = (argv: string[]): boolean => (argv[argv.length - 1] ?? "").includes("job' 'log");

function deps(
  s: Store,
  runner: FakeRunner,
  over: Partial<JobTickDeps> = {},
): JobTickDeps & { logs: ReturnType<typeof memLogs> } {
  const logs = over.logs !== undefined ? (over.logs as ReturnType<typeof memLogs>) : memLogs();
  return {
    store: s,
    state: new StoreState(s),
    runner,
    boxKey: "/k",
    knownHosts: "/kh",
    logs,
    notify: () => {},
    ...over,
    logs,
  } as JobTickDeps & { logs: ReturnType<typeof memLogs> };
}

function mkJob(s: Store, box: string, over: Partial<{ leaseId: string; ownedLease: boolean; kind: "run" | "service" }> = {}): JobRow {
  const boxId = (s.db.query("SELECT box_id FROM boxes WHERE name=?").get(box) as { box_id: number }).box_id;
  const j = createJob(s, {
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
    now: T0,
  });
  updateJob(s, j.job_id, { state: "running", lastPollAt: T0, startedAt: T0 });
  return jobById(s, j.job_id)!;
}

describe("J5 — one poll", () => {
  test("a running job stays running and the log is mirrored by offset", async () => {
    const s = store();
    seedBox(s, "grok-box-008");
    const job = mkJob(s, "grok-box-008");
    const runner = new FakeRunner((argv) => {
      if (isStatus(argv)) return result({ stdout: statusLine({ logBytes: 11 }) });
      if (isLog(argv)) return result({ stdout: "hello world" });
      return result({ code: 1 });
    });
    const d = deps(s, runner);
    await pollJob(d, job, T0 + 60);

    const after = jobById(s, job.job_id)!;
    expect(after.state).toBe("running");
    expect(after.log_offset).toBe(11);
    expect(after.mirrored).toBe(11);
    expect(after.last_poll_at).toBe(T0 + 60);
    expect(d.logs.text(job.job_id)).toBe("hello world");
    s.close();
  });

  test("no log fetch when the box says the log has not grown", async () => {
    const s = store();
    seedBox(s, "grok-box-008");
    const job = mkJob(s, "grok-box-008");
    let logCalls = 0;
    const runner = new FakeRunner((argv) => {
      if (isStatus(argv)) return result({ stdout: statusLine({ logBytes: 0 }) });
      if (isLog(argv)) {
        logCalls++;
        return result({ stdout: "" });
      }
      return result({ code: 1 });
    });
    await pollJob(deps(s, runner), job, T0 + 60);
    // Two ssh calls per poll is the worst case, not the normal one.
    expect(logCalls).toBe(0);
    s.close();
  });

  test("an UNREADABLE status leaves the state alone — it is not a verdict", async () => {
    const s = store();
    seedBox(s, "grok-box-008");
    const job = mkJob(s, "grok-box-008");
    const runner = new FakeRunner(() => result({ code: 255, stdout: "ssh: connect to host port 22: Broken pipe" }));
    await pollJob(deps(s, runner), job, T0 + 60);
    const after = jobById(s, job.job_id)!;
    // MUTANT: read "no status" as `lost` and one bad ssh kills a healthy job.
    expect(after.state).toBe("running");
    expect(after.lost_reason).toBeNull();
    // …but the stamp DOES advance, so this job goes to the back of the queue
    // instead of consuming the budget on every tick.
    expect(after.last_poll_at).toBe(T0 + 60);
    s.close();
  });

  test("the box's `lost:image-swap` becomes state=lost with the reason kept", async () => {
    const s = store();
    seedBox(s, "grok-box-008");
    const job = mkJob(s, "grok-box-008");
    const runner = new FakeRunner((argv) =>
      isStatus(argv) ? result({ stdout: statusLine({ state: "lost:image-swap" }) }) : result({ code: 1 }),
    );
    await pollJob(deps(s, runner), job, T0 + 60);
    const after = jobById(s, job.job_id)!;
    expect(after.state).toBe("lost");
    expect(after.lost_reason).toBe("image-swap");
    expect(after.ended_at).toBe(T0 + 60);
    s.close();
  });

  test("a box state we do not recognise is `lost`, carrying what the box said", async () => {
    const s = store();
    seedBox(s, "grok-box-008");
    const job = mkJob(s, "grok-box-008");
    const runner = new FakeRunner((argv) =>
      isStatus(argv) ? result({ stdout: statusLine({ state: "quiescing" }) }) : result({ code: 1 }),
    );
    await pollJob(deps(s, runner), job, T0 + 60);
    const after = jobById(s, job.job_id)!;
    // Guessing `running` polls forever against a box we do not understand;
    // guessing `failed` invents an rc. `lost:<raw>` names what was actually said.
    expect(after.state).toBe("lost");
    expect(after.lost_reason).toBe("quiescing");
    s.close();
  });
});

describe("J6 — truncation is detected from the COUNTER, never from sizes", () => {
  test("a fast writer whose new generation is already past our offset is still caught", async () => {
    const s = store();
    seedBox(s, "grok-box-008");
    const job = mkJob(s, "grok-box-008");
    const d = deps(s, new FakeRunner((argv) => {
      if (isStatus(argv)) return result({ stdout: statusLine({ logBytes: 100 }) });
      if (isLog(argv)) return result({ stdout: "x".repeat(100) });
      return result({ code: 1 });
    }));
    await pollJob(d, job, T0 + 60);
    expect(jobById(s, job.job_id)!.log_offset).toBe(100);

    // Second poll: the box truncated AND the new generation is ALREADY 150
    // bytes — bigger than our old offset of 100. A size comparison sees growth
    // and splices bytes 100..150 of the NEW log onto the old text. The counter
    // is what makes this visible.
    const d2 = deps(s, new FakeRunner((argv) => {
      if (isStatus(argv)) return result({ stdout: statusLine({ logBytes: 150, truncations: 1, truncatedTotal: 400 }) });
      if (isLog(argv)) return result({ stdout: "y".repeat(150) });
      return result({ code: 1 });
    }), { logs: d.logs });
    await pollJob(d2, jobById(s, job.job_id)!, T0 + 120);

    const after = jobById(s, job.job_id)!;
    expect(after.log_truncated).toBe(1);
    expect(after.truncations).toBe(1);
    // Offset restarted at 0 of the NEW generation and then advanced by 150.
    expect(after.log_offset).toBe(150);
    expect(after.mirrored).toBe(250);
    const text = d.logs.text(job.job_id);
    expect(text).toContain("[log truncated on box at");
    // 400 discarded, 100 of which we had already fetched ⇒ 300 never mirrored.
    expect(text).toContain("300 bytes never mirrored");
    // and the new generation follows the marker, not spliced before it
    expect(text.indexOf("[log truncated")).toBeLessThan(text.indexOf("y".repeat(150)));
    s.close();
  });

  test("the marker reports the PER-EVENT increment, not the running total", async () => {
    const s = store();
    seedBox(s, "grok-box-008");
    const job = mkJob(s, "grok-box-008");
    const logs = memLogs();

    const poll = async (o: Parameters<typeof statusLine>[0], chunk: string, at: number): Promise<void> => {
      const d = deps(s, new FakeRunner((argv) => {
        if (isStatus(argv)) return result({ stdout: statusLine(o) });
        if (isLog(argv)) return result({ stdout: chunk });
        return result({ code: 1 });
      }), { logs });
      await pollJob(d, jobById(s, job.job_id)!, at);
    };

    await poll({ logBytes: 100 }, "a".repeat(100), T0 + 60);
    await poll({ logBytes: 50, truncations: 1, truncatedTotal: 400 }, "b".repeat(50), T0 + 120);
    await poll({ logBytes: 50, truncations: 2, truncatedTotal: 900 }, "c".repeat(50), T0 + 180);

    const text = logs.text(job.job_id);
    // First marker: 400 destroyed − 100 already mirrored = 300.
    expect(text).toContain("300 bytes never mirrored");
    // Second: destroyed running total 900, mirrored 150 ⇒ running lost 750,
    // minus the 300 already reported = 450. MUTANT (j37) reports 750 here.
    expect(text).toContain("450 bytes never mirrored");
    expect(text).not.toContain("750 bytes never mirrored");
    s.close();
  });
});

describe("J11 — terminal handling", () => {
  test("a failed job alerts ONCE and releases a lease it owns", async () => {
    const s = store();
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
    const job = mkJob(s, "grok-box-008", { leaseId: acq.lease.lease_id, ownedLease: true });

    const notes: string[] = [];
    const runner = new FakeRunner((argv) =>
      isStatus(argv) ? result({ stdout: statusLine({ state: "failed", rc: "2" }) }) : result({ code: 1 }),
    );
    const d = deps(s, runner, { notify: (_l, m) => void notes.push(m) });
    await pollJob(d, job, T0 + 60);

    expect(jobById(s, job.job_id)!.state).toBe("failed");
    expect(jobById(s, job.job_id)!.rc).toBe(2);
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("failed rc=2");
    expect(leaseById(s, acq.lease.lease_id)!.released_at).not.toBeNull();

    // Re-polling a job that is already terminal must not alert again — the
    // transition fired once and the row is closed.
    await pollJob(d, jobById(s, job.job_id)!, T0 + 120);
    expect(notes.length).toBe(1);
    s.close();
  });

  test("a CALLER's lease is NOT released when the job ends", async () => {
    const s = store();
    const boxId = seedBox(s, "grok-box-008");
    const acq = acquireLease(s, {
      boxId,
      box: "grok-box-008",
      kind: "ephemeral",
      holder: "ci:runner-3",
      purpose: "gate",
      now: T0,
    });
    if (!acq.ok) return;
    const job = mkJob(s, "grok-box-008", { leaseId: acq.lease.lease_id, ownedLease: false });
    const runner = new FakeRunner((argv) =>
      isStatus(argv) ? result({ stdout: statusLine({ state: "done", rc: "0" }) }) : result({ code: 1 }),
    );
    await pollJob(deps(s, runner), job, T0 + 60);
    // MUTANT (j13): release it anyway and the caller's next command finds the
    // box taken by someone else.
    expect(leaseById(s, acq.lease.lease_id)!.released_at).toBeNull();
    s.close();
  });

  test("done and stopped are SILENT", async () => {
    const s = store();
    seedBox(s, "grok-box-008");
    const job = mkJob(s, "grok-box-008");
    const notes: string[] = [];
    const runner = new FakeRunner((argv) =>
      isStatus(argv) ? result({ stdout: statusLine({ state: "done", rc: "0" }) }) : result({ code: 1 }),
    );
    await pollJob(deps(s, runner, { notify: (_l, m) => void notes.push(m) }), job, T0 + 60);
    expect(notes).toEqual([]);
    s.close();
  });
});

describe("J5 — the pass", () => {
  test("an ASLEEP box is skipped entirely: no ssh, and last_poll_at does NOT move", async () => {
    const s = store();
    seedBox(s, "grok-box-008");
    const job = mkJob(s, "grok-box-008");
    let calls = 0;
    const runner = new FakeRunner(() => {
      calls++;
      return result({ code: 1 });
    });
    const tick = new JobTick(deps(s, runner));
    await tick.poll(new Set(), new Set(["grok-box-008"]), T0 + 300);
    expect(calls).toBe(0);
    // A frozen job is not a lost one: the box is suspended and the process is
    // intact, so nothing about the row changes.
    expect(jobById(s, job.job_id)!.last_poll_at).toBe(T0);
    expect(jobById(s, job.job_id)!.state).toBe("running");
    s.close();
  });

  test("a job on a box that is GONE is closed as lost without an ssh", async () => {
    const s = store();
    seedBox(s, "grok-box-008");
    const job = mkJob(s, "grok-box-008");
    let calls = 0;
    const runner = new FakeRunner(() => {
      calls++;
      return result({ code: 1 });
    });
    const tick = new JobTick(deps(s, runner));
    await tick.poll(new Set(["grok-box-008"]), new Set(), T0 + 300);
    expect(calls).toBe(0);
    expect(jobById(s, job.job_id)!.state).toBe("lost");
    expect(jobById(s, job.job_id)!.lost_reason).toBe("box-gone");
    s.close();
  });

  test("the budget defers the rest — and ALWAYS polls at least one", async () => {
    const s = store();
    const names = ["grok-box-001", "grok-box-002", "grok-box-003", "grok-box-004"];
    for (const n of names) seedBox(s, n);
    for (const n of names) mkJob(s, n);

    let polls = 0;
    const runner = new FakeRunner((argv) => {
      if (isStatus(argv)) {
        polls++;
        return result({ stdout: statusLine({ logBytes: 0 }) });
      }
      return result({ code: 1 });
    });
    // A clock that jumps a full minute per read: the first poll is free, and
    // every check after it is already over budget.
    let t = 0;
    const d = deps(s, runner, { budgetS: 60, monotonicMs: () => (t += 60_000) });
    await new JobTick(d).poll(new Set(names), new Set(names), T0 + 300);

    // MUTANT (j23): drop the budget check and all four are polled, blowing past
    // the 5-minute timer on a busy fleet.
    expect(polls).toBe(1);
    // The three deferred keep their old stamp, so they are FIRST next tick.
    const stamps = names.map((n) => {
      const r = s.db.query("SELECT last_poll_at FROM jobs j JOIN boxes b ON b.box_id=j.box_id WHERE b.name=?").get(n) as { last_poll_at: number };
      return r.last_poll_at;
    });
    expect(stamps.filter((x) => x === T0).length).toBe(3);
    s.close();
  });
});
