// jobs.ts — the in-memory reconcile job registry (TUI-D3/§3, B1).
//
// `POST /v1/reconcile` starts ONE async job that runs a single tick in-process
// under the reconcile lock; a second POST while one runs ⇒ 409 job_running
// (single job at a time). `GET /v1/jobs/:id` ⇒ {state:"running"|"done", rc?,
// log?}; the registry is in-memory and lost on restart (unknown id ⇒ 404, the
// TUI treats that as "result unknown — re-poll /v1/fleet", R2-A11).
//
// The registry is transport-free: the caller supplies the `run` closure (which
// takes the lock + runs the tick + writes the completion audit line). This
// module owns ONLY the singleton gate + id minting + result capture.

export type JobState = "running" | "done";

export interface JobRecord {
  id: string;
  state: JobState;
  rc?: number;
  log?: string[];
}

export type JobResult = { rc: number; log: string[] };

/** Result of a start attempt: a new job, or the id of the one already running. */
export type StartOutcome =
  | { started: true; id: string }
  | { started: false; runningId: string };

export class JobRegistry {
  private jobs = new Map<string, JobRecord>();
  private runningId: string | undefined;

  constructor(private readonly mintId: () => string = defaultJobId) {}

  /**
   * Start a job iff none is running. The `run` closure is invoked immediately
   * (async, not awaited) and its result recorded when it settles; the job then
   * frees the singleton. On a throw the job settles `done` with rc 1 and the
   * error in `log`.
   */
  start(run: () => Promise<JobResult>): StartOutcome {
    if (this.runningId !== undefined) {
      return { started: false, runningId: this.runningId };
    }
    const id = this.mintId();
    this.jobs.set(id, { id, state: "running" });
    this.runningId = id;
    // fire-and-forget; result captured on settle.
    void (async () => {
      try {
        const r = await run();
        this.jobs.set(id, { id, state: "done", rc: r.rc, log: r.log });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.jobs.set(id, { id, state: "done", rc: 1, log: [`reconcile job crashed: ${msg}`] });
      } finally {
        if (this.runningId === id) this.runningId = undefined;
      }
    })();
    return { started: true, id };
  }

  /** Look up a job by id, or undefined (⇒ 404). */
  get(id: string): JobRecord | undefined {
    return this.jobs.get(id);
  }

  /** true iff a job is currently running (test/introspection). */
  isRunning(): boolean {
    return this.runningId !== undefined;
  }
}

/** A short, sortable job id: <epochMs>-<rand>. */
export function defaultJobId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
