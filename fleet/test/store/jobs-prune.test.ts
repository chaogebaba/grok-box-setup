// jobs-prune.test.ts — brain-side job retention (blueprint grokfleet-5.14.0 D3).
//
// `pruneJobs(store, retentionDays, at, logs)` deletes TERMINAL job rows — and
// their mirrored log files — older than `retentionDays`, keyed on
// `COALESCE(ended_at, last_poll_at)`. Non-terminal rows are NEVER touched;
// `retain_days = 0` disables the pass before any query; the log file is unlinked
// BEFORE the row is deleted; the pass is guarded by `jobsAvailable` so a pre-v4
// store returns 0 without throwing; and `logs === undefined` prunes rows only.
//
// Every assertion is at the store layer with an in-memory `JobLogSink` fake, the
// same seam `reconcile-jobs.test.ts` fakes today, so "the log file is unlinked"
// is proven without touching disk.

import { describe, expect, test } from "bun:test";
import { createJob, jobById, newJobId, pruneJobs, updateJob } from "../../src/store/jobs.ts";
import { TERMINAL_STATES, type JobLogSink, type JobState } from "../../src/jobs.ts";
import { memStore, T0 } from "./helpers.ts";
import type { Store } from "../../src/store/db.ts";

const DAY = 86_400;

/** An in-memory log sink that records which ids were removed and in what order
 *  RELATIVE to the DELETE — a probe wraps `remove` to snapshot the row's
 *  existence at unlink time, which is how the unlink-BEFORE-DELETE ordering is
 *  asserted without disk. */
function memLogs(): JobLogSink & { has(id: string): boolean; removed: string[] } {
  const files = new Set<string>();
  return {
    append(id) {
      files.add(id);
    },
    size: () => 0,
    read: () => "",
    remove(id) {
      files.delete(id);
      this.removed.push(id);
    },
    has: (id) => files.has(id),
    removed: [] as string[],
  };
}

function seedBox(store: Store, name: string): number {
  const idx = Number.parseInt(name.replace(/^\D+/, ""), 10);
  store.db
    .query(`INSERT INTO boxes(name,idx,port,phase,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .run(name, idx, 20000 + idx, "enrolled", T0, T0);
  return (store.db.query("SELECT box_id FROM boxes WHERE name=?").get(name) as { box_id: number }).box_id;
}

/** Create a job and drive it to `state`, setting `ended_at`/`last_poll_at` so the
 *  COALESCE cutoff can be exercised. `endedAt: null` leaves ended_at unset so the
 *  prune must fall back to `last_poll_at`. */
function mkJob(
  store: Store,
  box: string,
  opts: { state: JobState; endedAt: number | null; lastPollAt: number; logs?: JobLogSink },
): string {
  const boxId = (store.db.query("SELECT box_id FROM boxes WHERE name=?").get(box) as { box_id: number }).box_id;
  const jobId = newJobId();
  createJob(store, {
    jobId,
    boxId,
    box,
    leaseId: null,
    ownedLease: false,
    kind: "run",
    holder: "ci:runner-3",
    purpose: "gate",
    cmd: "make test",
    cwd: "/workspace",
    wallCapS: 2400,
    keepAlive: false,
    now: T0,
  });
  opts.logs?.append(jobId, "log-bytes");
  updateJob(store, jobId, {
    state: opts.state,
    startedAt: T0,
    endedAt: opts.endedAt,
    lastPollAt: opts.lastPollAt,
  });
  return jobId;
}

describe("D3 — pruneJobs", () => {
  test("a terminal row at 31 d is pruned; the same state at 29 d is kept", () => {
    // 30-day window; `at` is NOW. ended_at 31 d ago ⇒ gone, 29 d ago ⇒ kept.
    for (const st of TERMINAL_STATES) {
      const s = memStore();
      seedBox(s, "grok-box-001");
      const logs = memLogs();
      const old = mkJob(s, "grok-box-001", { state: st, endedAt: T0 - 31 * DAY, lastPollAt: T0 - 31 * DAY, logs });
      const fresh = mkJob(s, "grok-box-001", { state: st, endedAt: T0 - 29 * DAY, lastPollAt: T0 - 29 * DAY, logs });
      const n = pruneJobs(s, 30, T0, logs);
      expect(n).toBe(1);
      expect(jobById(s, old)).toBeUndefined();
      expect(jobById(s, fresh)).not.toBeUndefined();
      s.close();
    }
  });

  // MUTANT: prune ignores the state filter (a running row 40 d old is deleted).
  test("a NON-terminal (running) row at 40 d is NEVER touched", () => {
    const s = memStore();
    seedBox(s, "grok-box-001");
    const logs = memLogs();
    const running = mkJob(s, "grok-box-001", { state: "running", endedAt: null, lastPollAt: T0 - 40 * DAY, logs });
    const starting = mkJob(s, "grok-box-001", { state: "starting", endedAt: null, lastPollAt: T0 - 40 * DAY, logs });
    const n = pruneJobs(s, 30, T0, logs);
    expect(n).toBe(0);
    expect(jobById(s, running)).not.toBeUndefined();
    expect(jobById(s, starting)).not.toBeUndefined();
    s.close();
  });

  // MUTANT: `retain_days = 0` prunes everything.
  test("retain_days = 0 disables the pass — nothing pruned, no query, no unlink", () => {
    const s = memStore();
    seedBox(s, "grok-box-001");
    const logs = memLogs();
    const old = mkJob(s, "grok-box-001", { state: "done", endedAt: T0 - 999 * DAY, lastPollAt: T0 - 999 * DAY, logs });
    const n = pruneJobs(s, 0, T0, logs);
    expect(n).toBe(0);
    expect(jobById(s, old)).not.toBeUndefined();
    expect(logs.removed).toEqual([]);
    s.close();
  });

  // MUTANT: prune uses `created_at` instead of COALESCE(ended_at,last_poll_at).
  test("a NULL ended_at falls back to last_poll_at for the cutoff", () => {
    const s = memStore();
    seedBox(s, "grok-box-001");
    const logs = memLogs();
    // ended_at NULL, last_poll_at 31 d ago ⇒ pruned via the fallback. created_at
    // is T0 (recent), so a `created_at`-keyed prune would wrongly KEEP it.
    const j = mkJob(s, "grok-box-001", { state: "failed", endedAt: null, lastPollAt: T0 - 31 * DAY, logs });
    const n = pruneJobs(s, 30, T0, logs);
    expect(n).toBe(1);
    expect(jobById(s, j)).toBeUndefined();
    s.close();
  });

  // MUTANT: prune deletes rows but leaves the log files.
  test("the mirrored log file for a pruned job is unlinked; a retained job's is left alone", () => {
    const s = memStore();
    seedBox(s, "grok-box-001");
    const logs = memLogs();
    const doomed = mkJob(s, "grok-box-001", { state: "done", endedAt: T0 - 31 * DAY, lastPollAt: T0 - 31 * DAY, logs });
    const keptTerminal = mkJob(s, "grok-box-001", { state: "done", endedAt: T0 - 1 * DAY, lastPollAt: T0 - 1 * DAY, logs });
    const running = mkJob(s, "grok-box-001", { state: "running", endedAt: null, lastPollAt: T0 - 40 * DAY, logs });
    const n = pruneJobs(s, 30, T0, logs);
    expect(n).toBe(1);
    expect(logs.has(doomed)).toBe(false); // unlinked
    expect(logs.has(keptTerminal)).toBe(true); // recent terminal — file left
    expect(logs.has(running)).toBe(true); // non-terminal — file left
    s.close();
  });

  // MUTANT: prune unlinks the log AFTER the DELETE. A remove-BEFORE-delete
  // ordering means the row still exists at unlink time; a probe on `remove`
  // captures that.
  test("the log is removed BEFORE the row (a crash leaves a row with no log, not a file with no row)", () => {
    const s = memStore();
    seedBox(s, "grok-box-001");
    const logs = memLogs();
    const doomed = mkJob(s, "grok-box-001", { state: "done", endedAt: T0 - 31 * DAY, lastPollAt: T0 - 31 * DAY, logs });
    let rowPresentAtUnlink: boolean | undefined;
    const orig = logs.remove.bind(logs);
    logs.remove = (id: string) => {
      if (id === doomed) rowPresentAtUnlink = jobById(s, doomed) !== undefined;
      orig(id);
    };
    pruneJobs(s, 30, T0, logs);
    expect(rowPresentAtUnlink).toBe(true); // the row still existed when the log was unlinked
    expect(jobById(s, doomed)).toBeUndefined(); // and is gone afterwards
    s.close();
  });

  test("pruneJobs does not add its own throw around remove — a swallowing sink is silent", () => {
    const s = memStore();
    seedBox(s, "grok-box-001");
    // The production sink (nodeJobLogs) swallows unlink errors internally; model
    // that with a sink that catches its own throw, and assert pruneJobs stays
    // silent and still deletes the row. (nodeJobLogs' OWN swallow is covered in
    // reconcile-jobs.test.ts, where unlinkSync of a missing file is exercised.)
    const swallowing: JobLogSink = {
      append: () => {},
      size: () => 0,
      read: () => "",
      remove: (id) => {
        try {
          throw new Error("unlink failed for " + id);
        } catch {
          /* swallowed, exactly as nodeJobLogs does */
        }
      },
    };
    const doomed = mkJob(s, "grok-box-001", { state: "done", endedAt: T0 - 31 * DAY, lastPollAt: T0 - 31 * DAY });
    expect(() => pruneJobs(s, 30, T0, swallowing)).not.toThrow();
    expect(jobById(s, doomed)).toBeUndefined();
    s.close();
  });

  // MUTANT: log line only when N > 0 — asserted at the run.ts layer; here the
  // return value is the source of that N, so N===0 when nothing matched.
  test("returns 0 when nothing matched (drives the 'log line only when N>0' rule)", () => {
    const s = memStore();
    seedBox(s, "grok-box-001");
    mkJob(s, "grok-box-001", { state: "done", endedAt: T0 - 1 * DAY, lastPollAt: T0 - 1 * DAY });
    expect(pruneJobs(s, 30, T0, memLogs())).toBe(0);
    s.close();
  });

  test("logs === undefined prunes ROWS ONLY (never the DELETE) and does not throw", () => {
    const s = memStore();
    seedBox(s, "grok-box-001");
    const doomed = mkJob(s, "grok-box-001", { state: "done", endedAt: T0 - 31 * DAY, lastPollAt: T0 - 31 * DAY });
    const n = pruneJobs(s, 30, T0, undefined);
    expect(n).toBe(1);
    expect(jobById(s, doomed)).toBeUndefined();
    s.close();
  });

  // MUTANT: prune not guarded by jobsAvailable (a v3 store must NOT throw).
  test("a v3 store (no jobs table available) ticks without throwing and prunes nothing", () => {
    const s = memStore();
    seedBox(s, "grok-box-001");
    const doomed = mkJob(s, "grok-box-001", { state: "done", endedAt: T0 - 31 * DAY, lastPollAt: T0 - 31 * DAY });
    // Drop the store BELOW v4 so `jobsAvailable` is false. The rows still exist,
    // but the guard must short-circuit before any query.
    s.db.run("PRAGMA user_version = 3");
    expect(s.userVersion()).toBe(3);
    let n = 0;
    expect(() => {
      n = pruneJobs(s, 30, T0, memLogs());
    }).not.toThrow();
    expect(n).toBe(0);
    // restore so the row is still readable for the assertion
    s.db.run("PRAGMA user_version = 6");
    expect(jobById(s, doomed)).not.toBeUndefined();
    s.close();
  });
});
