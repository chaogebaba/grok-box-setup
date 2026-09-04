// job-tick.ts — the brain's half of a job: poll the box, mirror the log, close
// the row out (blueprint grokfleet-jobs J5/J6/J11).
//
// THE BOX IS AUTHORITATIVE. This pass never decides what a job is doing; it asks
// `boxup job status <id>` and writes down the answer. That is what makes every
// failure mode here benign: a poll that times out, a tick that runs out of
// budget, a VPS that reboots mid-job — all of them leave a job running on the
// box under the box's OWN wall-clock cap, and the next poll catches up.
//
// THE BUDGET (J5). Polls are serial (the per-box loop is), each is at most two
// 20-second ssh calls, and eleven running jobs would otherwise blow past the
// 5-minute timer. So the pass spends at most JOB_POLL_BUDGET_S and defers the
// rest, checking BEFORE each call rather than after — a check after the call has
// already spent the time it was meant to protect. Deferral is safe and the
// blueprint says so out loud: the box record is authoritative, the cap is
// box-side, and a CLI that is waiting uses `GET /v1/jobs/:id?refresh=1` instead
// of this pass. The due set is ordered never-polled-first so nothing starves.
//
// NO TRANSACTION SPANS AN SSH (state-store D5). Each poll is one UPDATE issued
// after its ssh has already returned.

import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import type { Runner } from "../runner.ts";
import type { Store } from "../store/db.ts";
import type { StoreState } from "../store/state.ts";
import type { NotifyLevel } from "../notify.ts";
import { log } from "../log.ts";
import {
  ALERTING_STATES,
  JOB_LOG_FETCH_MAX,
  JOB_LOG_MIRROR_MAX,
  JOB_POLL_BUDGET_S,
  JOB_SSH_TIMEOUT_MS,
  boxupJobCommand,
  isTerminal,
  parseJobStatus,
  stateFromBox,
  type JobState,
} from "../jobs.ts";
import { dueJobs, loseJob, updateJob, type JobRow } from "../store/jobs.ts";
import { releaseLease } from "../store/leases.ts";
import { tunnelSsh } from "../tunnel.ts";

/** The VPS-side log mirror, behind a seam so tests stay in memory. */
export interface JobLogSink {
  append(jobId: string, text: string): void;
  size(jobId: string): number;
  read(jobId: string, offset: number, limit: number): string;
}

/** `$FLEET_STATE/jobs/<job_id>.log`. Every failure is swallowed: a log mirror
 *  that cannot be written must never take down a reconcile tick. */
export function nodeJobLogs(fleetState: string): JobLogSink {
  const dir = `${fleetState}/jobs`;
  const path = (id: string): string => `${dir}/${id}.log`;
  return {
    append(id, text) {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(path(id), text);
      } catch {
        /* swallowed — see above */
      }
    },
    size(id) {
      try {
        return statSync(path(id)).size;
      } catch {
        return 0;
      }
    },
    read(id, offset, limit) {
      try {
        return readFileSync(path(id), "utf8").slice(offset, offset + limit);
      } catch {
        return "";
      }
    },
  };
}

export interface JobTickDeps {
  store: Store;
  state: StoreState;
  runner: Runner;
  boxKey: string;
  knownHosts: string;
  logs: JobLogSink;
  notify: (level: NotifyLevel, msg: string) => Promise<void> | void;
  /** J11: one alert per job per terminal state, through the `alerts` table. */
  alertRenotifySecs?: number;
  budgetS?: number;
  /** injected so a test can drive the budget without real elapsed time. */
  monotonicMs?: () => number;
}

/** J11: the terminal alert fires once. The row reaches a terminal state exactly
 *  once, so the throttle is belt and braces — but a re-poll of a `lost` job that
 *  the box later re-reports would otherwise alert twice. */
const JOB_ALERT_RENOTIFY_SECS = 86400;

export interface JobTickApi {
  /**
   * Poll what the budget allows.
   *
   * `pollable` is the set of boxes this tick may ssh into. A job on a box
   * outside it is NOT touched and not counted against the budget: an asleep box
   * has a FROZEN job, not a lost one — the box is suspended, the process is
   * intact, and it resumes with the box — so its `last_poll_at` deliberately
   * stays where it was.
   *
   * `known` is every box the fleet still has. A job on a box that is gone
   * (retired, forgotten) can never be polled again, so it is closed as `lost`.
   */
  poll(pollable: Set<string>, known: Set<string>, now: number): Promise<void>;
}

export class JobTick implements JobTickApi {
  constructor(private readonly deps: JobTickDeps) {}

  async poll(pollable: Set<string>, known: Set<string>, now: number): Promise<void> {
    const due = dueJobs(this.deps.store);
    if (due.length === 0) return;

    const budgetMs = (this.deps.budgetS ?? JOB_POLL_BUDGET_S) * 1000;
    const clock = this.deps.monotonicMs ?? (() => Date.now());
    const start = clock();
    let polled = 0;
    let deferred = 0;

    for (const job of due) {
      if (!known.has(job.box)) {
        loseJob(this.deps.store, job.job_id, "box-gone", now);
        log(`job: ${job.job_id} on ${job.box} ⇒ lost (box is no longer in the fleet)`);
        await finish(this.deps, job, "lost", now);
        continue;
      }
      if (!pollable.has(job.box)) continue; // frozen, not lost — see the doc above

      // BEFORE the call, never after: the point is not to START work we cannot
      // afford. The first job is always polled, so the pass cannot stall.
      if (polled > 0 && clock() - start >= budgetMs) {
        deferred++;
        continue;
      }
      polled++;
      await pollJob(this.deps, job, now);
    }
    if (deferred > 0) {
      log(`job: polled ${polled}, deferred ${deferred} to the next tick (budget ${budgetMs / 1000}s)`);
    }
  }
}

/**
 * Poll ONE job: ask the box, mirror what the log grew by, write one UPDATE.
 *
 * A module function rather than a method because the API calls it too:
 * `GET /v1/jobs/:id?refresh=1` runs exactly this inline, so a waiting CLI is not
 * tied to the 5-minute tick (J5). One implementation, so the on-demand path and
 * the tick cannot drift into disagreeing about what a status line means.
 */
export async function pollJob(deps: JobTickDeps, job: JobRow, now: number): Promise<void> {
  const res = await tunnelSsh(
    deps.runner,
    job.box,
    deps.boxKey,
    boxupJobCommand(["job", "status", job.job_id]),
    { timeoutMs: JOB_SSH_TIMEOUT_MS, knownHosts: deps.knownHosts },
  );
  const st = parseJobStatus(res.stdout);
  if (st === undefined) {
    // No reading. NOT a state: an unreadable status means we do not know, and
    // inventing `lost` here would kill a healthy job over one bad ssh. Stamp the
    // poll so this job goes to the back of the queue, and try again next tick.
    updateJob(deps.store, job.job_id, { state: job.state, lastPollAt: now });
    log(`job: ${job.job_id} on ${job.box} — status unreadable (rc ${res.code}), unchanged`);
    return;
  }

  const mapped = stateFromBox(st.boxState);
  const m = await mirror(deps, job, st, now);

  updateJob(deps.store, job.job_id, {
    state: mapped.state,
    rc: st.rc ?? null,
    startedAt: job.started_at ?? (st.started !== undefined ? isoToEpoch(st.started) : null),
    endedAt: isTerminal(mapped.state) ? (job.ended_at ?? now) : null,
    lastPollAt: now,
    logBytes: st.logBytes,
    logOffset: m.offset,
    logTruncated: m.truncated,
    truncations: st.truncations,
    lostReported: m.lostReported,
    mirrored: m.mirrored,
    lostReason: mapped.lostReason,
  });

  if (isTerminal(mapped.state) && !isTerminal(job.state)) {
    await finish(deps, job, mapped.state, now, st.rc ?? null);
  }
}

interface MirrorResult {
  offset: number;
  mirrored: number;
  lostReported: number;
  truncated: boolean;
}

/**
 * Fetch what the log grew by, and account for anything the box discarded.
 *
 * TRUNCATION IS DETECTED FROM THE COUNTER, NEVER FROM SIZES (J6/r6-B1). A size
 * comparison looks equivalent and is not: a job writing fast enough can have its
 * NEW generation already longer than our old offset by the time we look, and we
 * would splice a stale byte range into the middle of the mirror with nothing to
 * show that it happened.
 */
async function mirror(
  deps: JobTickDeps,
  job: JobRow,
  st: { truncations: number; truncatedTotal: number; logBytes: number },
  now: number,
): Promise<MirrorResult> {
  let offset = job.log_offset;
  let mirrored = job.mirrored;
  let lostReported = job.lost_reported;
  let truncated = job.log_truncated === 1;

  if (st.truncations > job.truncations) {
    // How much output was destroyed that we never fetched, SINCE THE PREVIOUS
    // MARKER — both terms grow between polls, so the increment is the difference
    // of the two running totals, not of one of them (r8-B2).
    const runningLost = st.truncatedTotal - mirrored;
    const lostNow = runningLost - lostReported;
    deps.logs.append(
      job.job_id,
      `\n[log truncated on box at ${new Date(now * 1000).toISOString()}; ` +
        `${lostNow < 0 ? 0 : lostNow} bytes never mirrored since the previous marker]\n`,
    );
    lostReported = runningLost;
    offset = 0; // the new generation starts at 0; never fetch from a stale offset
    truncated = true;
  }

  if (mirrored >= JOB_LOG_MIRROR_MAX) {
    // The mirror is at its own bound. Stop fetching rather than grow the VPS
    // copy without limit; the box copy stays authoritative until it is pruned.
    if (!truncated) {
      deps.logs.append(
        job.job_id,
        `\n[mirror stopped at ${JOB_LOG_MIRROR_MAX} bytes; fetch the rest from the box]\n`,
      );
    }
    return { offset, mirrored, lostReported, truncated: true };
  }

  if (st.logBytes <= offset) return { offset, mirrored, lostReported, truncated };

  const res = await tunnelSsh(
    deps.runner,
    job.box,
    deps.boxKey,
    boxupJobCommand(["job", "log", job.job_id, String(offset)]),
    { timeoutMs: JOB_SSH_TIMEOUT_MS, knownHosts: deps.knownHosts },
  );
  if (res.code !== 0) return { offset, mirrored, lostReported, truncated };
  // The box bounds its own reply; bound it again here so a boxup that ignored
  // its cap cannot make the VPS write an unbounded chunk.
  const chunk = res.stdout.length > JOB_LOG_FETCH_MAX ? res.stdout.slice(0, JOB_LOG_FETCH_MAX) : res.stdout;
  if (chunk.length === 0) return { offset, mirrored, lostReported, truncated };
  deps.logs.append(job.job_id, chunk);
  return { offset: offset + chunk.length, mirrored: mirrored + chunk.length, lostReported, truncated };
}

/** Terminal housekeeping: release the lease we took, and alert if it went badly. */
async function finish(
  deps: JobTickDeps,
  job: JobRow,
  state: JobState,
  now: number,
  rc: number | null = null,
): Promise<void> {
  // Only a lease this job ACQUIRED is released. A caller-supplied lease belongs
  // to the caller and outlives the job (J3) — releasing it would pull the box
  // out from under whatever they do next. Ownership is a recorded column, never
  // inferred from the holder.
  if (job.lease_id !== null && job.owned_lease === 1) {
    releaseLease(deps.store, job.lease_id, now);
  }
  if (!ALERTING_STATES.includes(state)) return;
  if (!deps.state.alertDue(job.box, `job-${state}`, deps.alertRenotifySecs ?? JOB_ALERT_RENOTIFY_SECS, now)) {
    return;
  }
  const rcPart = rc === null ? "" : ` rc=${rc}`;
  await deps.notify("warn", `${job.box}: job ${job.job_id} ${state}${rcPart} (${job.purpose})`);
}

/** `2026-09-04T22:31:08Z` ⇒ epoch seconds, or null when it is not a timestamp. */
function isoToEpoch(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
