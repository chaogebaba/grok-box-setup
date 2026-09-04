// store/jobs.ts — the `jobs` table (blueprint grokfleet-jobs J4/J5).
//
// A job is a ROW here and a DIRECTORY on the box, and the box's copy is the
// authoritative one: this table is a cache of what the box last said, plus the
// bookkeeping the box cannot know (which lease the job runs under, who asked
// for it, how much of the log has been mirrored to the VPS).
//
// LOCKING, and it is the rule the whole poll pass is built around: nothing here
// takes the reconcile lock, and NO transaction spans an ssh (state-store D5).
// Every poll is ONE `UPDATE … WHERE job_id = ?` issued after the ssh has already
// returned. A poll that never returns therefore holds nothing.
//
// The one-job-per-box invariant is NOT a unique index, unlike the lease slot it
// resembles. It cannot be: a box accumulates many terminal job rows over its
// life and only `starting|running` occupy the slot, and SQLite has no partial
// index over a state SET that would stay correct as rows move between states.
// It is a checked read in `activeJobFor`, and the real enforcement is the box's
// own atomic-mkdir slot, which answers rc 75. So a lost race here does not
// double-start a job; it gets the box's refusal instead, which the API renders
// as the same 409.

import { randomBytes } from "node:crypto";
import type { Store } from "./db.ts";
import type { JobKind, JobState } from "../jobs.ts";

/** One `jobs` row, joined to its box NAME (every caller wants the name). */
export interface JobRow {
  job_id: string;
  box_id: number;
  box: string;
  lease_id: string | null;
  /** 1 when the job acquired the lease and must release it (J3). */
  owned_lease: number;
  kind: JobKind;
  holder: string;
  purpose: string;
  cmd: string;
  cwd: string;
  wall_cap_s: number | null;
  keep_alive: number;
  state: JobState;
  rc: number | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  last_poll_at: number | null;
  log_bytes: number;
  /** how far into the CURRENT log generation this brain has mirrored. */
  log_offset: number;
  log_truncated: number;
  /** the box's monotonic truncation count as of the last poll (J6/r6-B1). */
  truncations: number;
  /** cumulative bytes this brain has already REPORTED as lost, per J6. */
  lost_reported: number;
  /** cumulative bytes this brain has mirrored across all log generations. */
  mirrored: number;
  lost_reason: string | null;
}

/** J4: the same 22-char base64url as a lease id — and it can start with `-`. */
export function newJobId(): string {
  return randomBytes(16).toString("base64url");
}

/** Does this store carry the `jobs` table (schema v4)? */
export function jobsAvailable(store: Store): boolean {
  return store.userVersion() >= 4;
}

const SELECT_JOINED = `SELECT j.job_id, j.box_id, b.name AS box, j.lease_id, j.owned_lease, j.kind, j.holder, j.purpose,
          j.cmd, j.cwd, j.wall_cap_s, j.keep_alive, j.state, j.rc, j.created_at, j.started_at,
          j.ended_at, j.last_poll_at, j.log_bytes, j.log_offset, j.log_truncated, j.truncations,
          j.lost_reported, j.mirrored, j.lost_reason
     FROM jobs j JOIN boxes b ON b.box_id = j.box_id`;

/** The two states that occupy the box's single job slot. */
const OPEN_STATES = "('starting','running')";

export function jobById(store: Store, id: string): JobRow | undefined {
  if (!jobsAvailable(store)) return undefined;
  return (store.db.query(`${SELECT_JOINED} WHERE j.job_id = ?`).get(id) as JobRow | null) ?? undefined;
}

/** The `starting|running` job on one box, or undefined. The 409 predicate. */
export function activeJobFor(store: Store, box: string): JobRow | undefined {
  if (!jobsAvailable(store)) return undefined;
  return (
    (store.db
      .query(`${SELECT_JOINED} WHERE j.state IN ${OPEN_STATES} AND b.name = ? ORDER BY j.created_at DESC`)
      .get(box) as JobRow | null) ?? undefined
  );
}

/**
 * Every open job keyed by box NAME. ONE query — `GET /v1/fleet` attaches the
 * field to eleven boxes from this single read, never a query per box (the lease
 * r10-B1 shape).
 */
export function activeJobs(store: Store): Map<string, JobRow> {
  const out = new Map<string, JobRow>();
  if (!jobsAvailable(store)) return out;
  for (const r of store.db.query(`${SELECT_JOINED} WHERE j.state IN ${OPEN_STATES}`).all() as JobRow[]) {
    out.set(r.box, r);
  }
  return out;
}

export interface ListJobsOptions {
  state?: JobState;
  box?: string;
  /** default 200; the API pages by nothing else, so keep it generous. */
  limit?: number;
}

export function listJobs(store: Store, opts: ListJobsOptions = {}): JobRow[] {
  if (!jobsAvailable(store)) return [];
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.state !== undefined) {
    where.push("j.state = ?");
    args.push(opts.state);
  }
  if (opts.box !== undefined) {
    where.push("b.name = ?");
    args.push(opts.box);
  }
  const sql = `${SELECT_JOINED}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
     ORDER BY j.created_at DESC, j.job_id LIMIT ?`;
  args.push(opts.limit ?? 200);
  return store.db.query(sql).all(...(args as never[])) as JobRow[];
}

/**
 * J5: the due set — every open job, oldest poll first, NEVER-POLLED FIRST.
 *
 * `last_poll_at IS NULL` sorts before every timestamp, which is what keeps a
 * brand-new job from starving behind a long-running one on a busy fleet: the
 * budget takes the head of this list, so a job that has never been polled is
 * always at the front of the queue.
 */
export function dueJobs(store: Store): JobRow[] {
  if (!jobsAvailable(store)) return [];
  return store.db
    .query(
      `${SELECT_JOINED} WHERE j.state IN ${OPEN_STATES}
        ORDER BY j.last_poll_at IS NULL DESC, j.last_poll_at ASC, j.created_at ASC`,
    )
    .all() as JobRow[];
}

export interface CreateJobArgs {
  jobId: string;
  boxId: number;
  box: string;
  leaseId: string | null;
  /** true when the job acquired the lease itself and therefore releases it. */
  ownedLease: boolean;
  kind: JobKind;
  holder: string;
  purpose: string;
  cmd: string;
  cwd: string;
  wallCapS: number | null;
  keepAlive: boolean;
  now: number;
}

/**
 * INSERT one job in `starting`. The caller has already checked `activeJobFor`;
 * this does not re-check, because the authoritative refusal is the box's slot
 * (see the header) and a second check here would only narrow, never close, the
 * window.
 */
export function createJob(store: Store, a: CreateJobArgs): JobRow {
  store.tx(() => {
    store.db
      .query(
        `INSERT INTO jobs(job_id,box_id,lease_id,owned_lease,kind,holder,purpose,cmd,cwd,wall_cap_s,
                          keep_alive,state,created_at,log_bytes,log_offset,log_truncated,truncations,
                          lost_reported,mirrored)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,'starting',?,0,0,0,0,0,0)`,
      )
      .run(
        a.jobId,
        a.boxId,
        a.leaseId,
        a.ownedLease ? 1 : 0,
        a.kind,
        a.holder,
        a.purpose,
        a.cmd,
        a.cwd,
        a.wallCapS,
        a.keepAlive ? 1 : 0,
        a.now,
      );
    store.audit({
      actor: a.holder,
      action: "job-start",
      box: a.box,
      rc: 0,
      at: a.now,
      // The command is audited: "what did this box actually run" is the first
      // question anyone asks about a job, and the row can be pruned.
      detail: `${a.jobId} kind=${a.kind} purpose=${a.purpose} cmd=${a.cmd}`,
    });
  });
  return jobById(store, a.jobId)!;
}

/** The fields ONE poll writes. Everything is optional but `state`. */
export interface JobUpdate {
  state: JobState;
  rc?: number | null;
  startedAt?: number | null;
  endedAt?: number | null;
  lastPollAt: number;
  logBytes?: number;
  logOffset?: number;
  logTruncated?: boolean;
  truncations?: number;
  lostReported?: number;
  mirrored?: number;
  lostReason?: string | null;
}

/**
 * ONE `UPDATE … WHERE job_id = ?`, issued AFTER the ssh returned (D5). Fields
 * the caller left out keep their stored value — a poll that read a status line
 * but fetched no log must not zero the log counters.
 */
export function updateJob(store: Store, id: string, u: JobUpdate): void {
  if (!jobsAvailable(store)) return;
  store.db
    .query(
      `UPDATE jobs SET
         state         = ?,
         rc            = COALESCE(?, rc),
         started_at    = COALESCE(?, started_at),
         ended_at      = COALESCE(?, ended_at),
         last_poll_at  = ?,
         log_bytes     = COALESCE(?, log_bytes),
         log_offset    = COALESCE(?, log_offset),
         log_truncated = COALESCE(?, log_truncated),
         truncations   = COALESCE(?, truncations),
         lost_reported = COALESCE(?, lost_reported),
         mirrored      = COALESCE(?, mirrored),
         lost_reason   = COALESCE(?, lost_reason)
       WHERE job_id = ?`,
    )
    .run(
      u.state,
      u.rc ?? null,
      u.startedAt ?? null,
      u.endedAt ?? null,
      u.lastPollAt,
      u.logBytes ?? null,
      u.logOffset ?? null,
      u.logTruncated === undefined ? null : u.logTruncated ? 1 : 0,
      u.truncations ?? null,
      u.lostReported ?? null,
      u.mirrored ?? null,
      u.lostReason ?? null,
      id,
    );
}

/**
 * Force a job to `lost` without asking the box — for the cases where asking is
 * impossible: the box was retired, or its record is gone. Separate from
 * `updateJob` so the reason is always supplied.
 */
export function loseJob(store: Store, id: string, reason: string, now: number): void {
  if (!jobsAvailable(store)) return;
  store.db
    .query(
      `UPDATE jobs SET state='lost', lost_reason=?, ended_at=COALESCE(ended_at,?), last_poll_at=?
       WHERE job_id=? AND state IN ('starting','running')`,
    )
    .run(reason, now, now, id);
}
