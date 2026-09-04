// job-handlers.ts — the jobs API (blueprint grokfleet-jobs J7).
//
//   POST   /v1/jobs                    admin     start a job (acquires a lease
//                                                unless the caller supplies one)
//   GET    /v1/jobs?state=&box=        readonly  list
//   GET    /v1/jobs/:id[?refresh=1]    readonly  one row; `refresh` polls inline
//   GET    /v1/jobs/:id/log?offset=    readonly  RAW BYTES, not JSON
//   POST   /v1/jobs/:id/stop           admin     TERM then KILL, idempotent
//
// THE ORDER OF THE START PATH MATTERS. The row is inserted BEFORE the box is
// asked to start anything, and it is inserted in `starting`. If the ssh then
// fails — or the VPS dies between the two — we are left with a `starting` row
// and no process, which the next poll resolves to `lost` from the box's own
// "no record" answer. The other order (start, then insert) can leave a process
// running on a box with nothing in the store that knows it exists, and nothing
// would ever stop it. A row without a process is recoverable; a process without
// a row is not.

import type { ServerContext } from "./context.ts";
import type { RequestAuth } from "./http.ts";
import { err, jsonError, jsonOk } from "./http.ts";
import { writeAudit } from "./audit.ts";
import { boxIndex, isValidBoxName } from "../boxes.ts";
import { openLeaseStore, openLeaseStoreRo } from "../store/membership.ts";
import { readLatestBoxFacts } from "../store/snapshots.ts";
import { acquireLease, deferringLeases, leaseById, releaseLease } from "../store/leases.ts";
import {
  activeJobFor,
  activeJobs,
  createJob,
  jobById,
  jobsAvailable,
  listJobs,
  newJobId,
  updateJob,
  type JobRow,
} from "../store/jobs.ts";
import {
  JOB_DEFAULT_CAP_S,
  JOB_LOG_FETCH_MAX,
  JOB_MAX_CAP_S,
  JOB_SSH_TIMEOUT_MS,
  boxupJobCommand,
  isTerminal,
  startArgs,
  type JobKind,
  type JobState,
} from "../jobs.ts";
import { nodeJobLogs, pollJob, type JobTickDeps } from "../reconcile/job-tick.ts";
import { chooseBox, type BoxFacts } from "./lease-eligibility.ts";
import { StoreState } from "../store/state.ts";
import { tunnelSsh } from "../tunnel.ts";
import { knownHostsFile } from "../hostkey.ts";

type Handle = { store: import("../store/db.ts").Store; close(): void };

function nowSec(ctx: ServerContext): number {
  return Math.floor((ctx.now ? ctx.now() : new Date()).getTime() / 1000);
}

/** READ handle. Read-only on purpose: a GET must never migrate the file. */
function openRead(ctx: ServerContext): Handle | undefined {
  return guard(() => openLeaseStoreRo(ctx.env));
}
/** WRITE handle — opening read-write migrates a pre-v4 file, which is exactly
 *  what the first job needs. */
function openWrite(ctx: ServerContext): Handle | undefined {
  return guard(() => openLeaseStore(ctx.env));
}
function guard(open: () => Handle | undefined): Handle | undefined {
  let h: Handle | undefined;
  try {
    h = open();
  } catch {
    return undefined;
  }
  if (h === undefined) return undefined;
  if (!jobsAvailable(h.store)) {
    h.close();
    return undefined;
  }
  return h;
}

/** The per-box `job` object on `/v1/fleet` and `/v1/boxes/:name` (J7/J12). */
export interface BoxJobField {
  job_id: string;
  kind: JobKind;
  state: JobState;
  holder: string;
  purpose: string;
  started_at: string | null;
}

function boxJobField(j: JobRow): BoxJobField {
  return {
    job_id: j.job_id,
    kind: j.kind,
    state: j.state,
    holder: j.holder,
    purpose: j.purpose,
    started_at: j.started_at === null ? null : new Date(j.started_at * 1000).toISOString(),
  };
}

/**
 * `GET /v1/fleet`'s per-box job map — ONE query per request, never one per box
 * (the lease r10-B1 shape). Empty when there is no store or it predates v4.
 */
export function fleetJobMap(ctx: ServerContext): Map<string, BoxJobField> {
  const out = new Map<string, BoxJobField>();
  const h = openRead(ctx);
  if (h === undefined) return out;
  try {
    for (const [box, row] of activeJobs(h.store)) out.set(box, boxJobField(row));
  } finally {
    h.close();
  }
  return out;
}

/** The full row, as every JSON surface renders it. */
function jobView(j: JobRow): Record<string, unknown> {
  const iso = (t: number | null): string | null => (t === null ? null : new Date(t * 1000).toISOString());
  return {
    job_id: j.job_id,
    box: j.box,
    kind: j.kind,
    state: j.state,
    rc: j.rc,
    holder: j.holder,
    purpose: j.purpose,
    cmd: j.cmd,
    cwd: j.cwd,
    wall_cap_s: j.wall_cap_s,
    keep_alive: j.keep_alive === 1,
    lease_id: j.lease_id,
    created_at: iso(j.created_at),
    started_at: iso(j.started_at),
    ended_at: iso(j.ended_at),
    last_poll_at: iso(j.last_poll_at),
    log_bytes: j.log_bytes,
    log_truncated: j.log_truncated === 1,
    lost_reason: j.lost_reason,
  };
}

const KNOWN_STATES = new Set<JobState>([
  "starting",
  "running",
  "done",
  "failed",
  "timeout",
  "stopped",
  "lost",
  "crashloop",
]);

// --- GET /v1/jobs ------------------------------------------------------------

export function handleJobList(ctx: ServerContext, stateParam: string | null, boxParam: string | null): Response {
  const h = openRead(ctx);
  if (h === undefined) return jsonOk({ jobs: [] });
  try {
    if (stateParam !== null && !KNOWN_STATES.has(stateParam as JobState)) {
      return err.badBody(`jobs: unknown state '${stateParam}'`);
    }
    const rows = listJobs(h.store, {
      state: stateParam === null ? undefined : (stateParam as JobState),
      box: boxParam === null ? undefined : boxParam,
    });
    return jsonOk({ jobs: rows.map(jobView) });
  } finally {
    h.close();
  }
}

// --- GET /v1/jobs/:id --------------------------------------------------------

export async function handleJobGet(ctx: ServerContext, id: string, refresh: boolean): Promise<Response> {
  // `refresh` WRITES (it polls and records), so it needs the write handle. A
  // plain read must not take one, or every GET would migrate the file.
  const h = refresh ? openWrite(ctx) : openRead(ctx);
  if (h === undefined) return jsonError(404, "not_found", `no such job: ${id}`);
  try {
    let row = jobById(h.store, id);
    if (row === undefined) return jsonError(404, "not_found", `no such job: ${id}`);
    if (refresh && !isTerminal(row.state)) {
      // J5: the same poll the tick runs, inline, so a waiting CLI is not tied to
      // the 5-minute timer. It takes no lock and writes the same single UPDATE.
      await pollJob(tickDeps(ctx, h), row, nowSec(ctx));
      row = jobById(h.store, id) ?? row;
    }
    return jsonOk(jobView(row));
  } finally {
    h.close();
  }
}

/** The deps `pollJob` needs, assembled from the server context. */
function tickDeps(ctx: ServerContext, h: Handle): JobTickDeps {
  return {
    store: h.store,
    state: new StoreState(h.store),
    runner: ctx.runner,
    boxKey: ctx.env.FLEET_BOX_KEY,
    knownHosts: knownHostsFile(ctx.env),
    logs: nodeJobLogs(ctx.env.FLEET_STATE),
    // The API never sends the terminal alert: the tick owns alerting, and a
    // `?refresh=1` from a polling CLI would otherwise fire it from whichever
    // path happened to observe the transition first.
    notify: () => {},
  };
}

// --- GET /v1/jobs/:id/log ----------------------------------------------------

/**
 * RAW BYTES, not JSON (J6) — a CI log is not a JSON string, and wrapping it
 * would double its size and force the client to unescape it. The offset and the
 * truncation flag ride in headers.
 */
export function handleJobLog(ctx: ServerContext, id: string, offsetParam: string | null, limitParam: string | null): Response {
  const h = openRead(ctx);
  if (h === undefined) return jsonError(404, "not_found", `no such job: ${id}`);
  try {
    const row = jobById(h.store, id);
    if (row === undefined) return jsonError(404, "not_found", `no such job: ${id}`);
    const offset = parseNonNegative(offsetParam) ?? 0;
    const limit = Math.min(parseNonNegative(limitParam) ?? JOB_LOG_FETCH_MAX, JOB_LOG_FETCH_MAX);
    const logs = nodeJobLogs(ctx.env.FLEET_STATE);
    const body = logs.read(id, offset, limit);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "x-job-log-offset": String(offset + body.length),
        "x-job-log-truncated": row.log_truncated === 1 ? "1" : "0",
        server: "grokfleet",
      },
    });
  } finally {
    h.close();
  }
}

function parseNonNegative(v: string | null): number | undefined {
  if (v === null) return undefined;
  if (!/^[0-9]+$/.test(v)) return undefined;
  return Number.parseInt(v, 10);
}

// --- POST /v1/jobs -----------------------------------------------------------

export async function handleJobCreate(
  ctx: ServerContext,
  auth: RequestAuth,
  body: Record<string, unknown>,
): Promise<Response> {
  const purpose = typeof body["purpose"] === "string" ? (body["purpose"] as string).trim() : "";
  if (purpose === "") return err.badBody("jobs: 'purpose' is required and must be a non-empty string");
  const cmd = typeof body["cmd"] === "string" ? (body["cmd"] as string) : "";
  if (cmd.trim() === "") return err.badBody("jobs: 'cmd' is required and must be a non-empty string");

  const kindRaw = body["kind"] === undefined ? "run" : body["kind"];
  if (kindRaw !== "run" && kindRaw !== "service") {
    return err.badBody("jobs: 'kind' must be 'run' or 'service'");
  }
  const kind = kindRaw as JobKind;

  const named = body["box"] === undefined ? undefined : String(body["box"]);
  if (named !== undefined && !isValidBoxName(named)) return err.badBody(`jobs: invalid box name '${named}'`);

  const cwd = typeof body["cwd"] === "string" && body["cwd"] !== "" ? (body["cwd"] as string) : "/workspace";

  // A service has NO cap — that is what `service` means. Accepting one and
  // silently dropping it would be worse than refusing it.
  let capS: number | null = null;
  if (kind === "run") {
    const raw = body["wall_cap_s"];
    capS = raw === undefined ? JOB_DEFAULT_CAP_S : Number(raw);
    if (!Number.isInteger(capS) || capS <= 0 || capS > JOB_MAX_CAP_S) {
      return err.badBody(`jobs: 'wall_cap_s' must be an integer in 1..${JOB_MAX_CAP_S}`);
    }
  } else if (body["wall_cap_s"] !== undefined) {
    return err.badBody("jobs: a 'service' job takes no 'wall_cap_s' — services have no deadline");
  }

  const suppliedLease = body["lease_id"] === undefined ? undefined : String(body["lease_id"]);

  const h = openWrite(ctx);
  if (h === undefined) {
    return jsonError(409, "no_eligible_box", "no state store with jobs yet — run a reconcile tick first");
  }
  const now = nowSec(ctx);
  try {
    const rows = h.store.db.query("SELECT box_id, name, phase FROM boxes").all() as Array<{
      box_id: number;
      name: string;
      phase: string;
    }>;

    // --- pick the box, and get a lease for it ---
    let box: string;
    let leaseId: string | null;
    let ownedLease: boolean;

    if (suppliedLease !== undefined) {
      const lease = leaseById(h.store, suppliedLease);
      if (lease === undefined) return jsonError(404, "not_found", `no such lease: ${suppliedLease}`);
      if (lease.state !== "active") {
        return jsonError(409, "lease_not_active", `lease ${suppliedLease} is ${lease.state}`);
      }
      if (named !== undefined && named !== lease.box) {
        return err.badBody(`jobs: lease ${suppliedLease} is on ${lease.box}, not ${named}`);
      }
      box = lease.box;
      leaseId = lease.lease_id;
      ownedLease = false; // the caller's lease; the job must not release it (J3)
    } else {
      const { facts, snapshotTs } = boxFacts(h, rows);
      const choice = chooseBox({
        boxes: facts,
        snapshotTs,
        now,
        rolloutCanary: ctx.rollout.canary,
        named,
        // A `service` job holds the box indefinitely, so it takes a `service`
        // lease; a `run` takes an ephemeral one bounded like any other.
        kind: kind === "service" ? "service" : "ephemeral",
        require: {},
        requireJobRunner: true,
      });
      if (choice.chosen === undefined) {
        return new Response(
          JSON.stringify({
            error: { code: "no_eligible_box", message: "no box satisfies the request" },
            reasons: choice.reasons,
          }),
          { status: 409, headers: { "content-type": "application/json", server: "grokfleet" } },
        );
      }
      const boxId = rows.find((r) => r.name === choice.chosen!.name)!.box_id;
      const acq = acquireLease(h.store, {
        boxId,
        box: choice.chosen.name,
        kind: kind === "service" ? "service" : "ephemeral",
        holder: auth.name,
        purpose,
        now,
      });
      if (!acq.ok) {
        const winner = deferringLeases(h.store).get(choice.chosen.name);
        return jsonError(
          409,
          "box_busy",
          `${choice.chosen.name} was leased by ${winner?.holder ?? "another caller"} while we were choosing`,
        );
      }
      box = acq.lease.box;
      leaseId = acq.lease.lease_id;
      ownedLease = true;
    }

    // --- ONE job per box (J7) ---
    const busy = activeJobFor(h.store, box);
    if (busy !== undefined) {
      if (ownedLease && leaseId !== null) releaseLease(h.store, leaseId, now);
      return jsonError(409, "box_busy", `${box} already runs job ${busy.job_id} (${busy.state})`);
    }

    const boxId = rows.find((r) => r.name === box)?.box_id;
    if (boxId === undefined) return jsonError(404, "not_found", `no such box: ${box}`);

    // --- the row FIRST, then the box (see the header) ---
    const jobId = newJobId();
    createJob(h.store, {
      jobId,
      boxId,
      box,
      leaseId,
      ownedLease,
      kind,
      holder: auth.name,
      purpose,
      cmd,
      cwd,
      wallCapS: capS,
      keepAlive: kind === "service",
      now,
    });

    const res = await tunnelSsh(
      ctx.runner,
      box,
      ctx.env.FLEET_BOX_KEY,
      boxupJobCommand(
        startArgs({ id: jobId, kind, capS, cwd, keepAlive: kind === "service", cmd }),
      ),
      { timeoutMs: JOB_SSH_TIMEOUT_MS, knownHosts: knownHostsFile(ctx.env) },
    );
    if (res.code !== 0) {
      // rc 75 is the box's own slot refusal (EX_TEMPFAIL) — its one job slot is
      // taken. That is a 409, not a 500: the fleet is fine, the box is busy. It
      // can happen even after the check above, because the box's atomic slot is
      // the real authority and something else may hold it.
      const busyBox = res.code === 75;
      updateJob(h.store, jobId, {
        state: "lost",
        lastPollAt: now,
        endedAt: now,
        lostReason: busyBox ? "box-slot-busy" : `start-failed-rc-${res.code}`,
      });
      if (ownedLease && leaseId !== null) releaseLease(h.store, leaseId, now);
      writeAudit(
        ctx.env.FLEET_STATE,
        { token: auth.name, action: "job-start", box, rc: res.code },
        ctx.auditSink,
        ctx.now,
      );
      return busyBox
        ? jsonError(409, "box_busy", `${box} refused the job: its job slot is taken`)
        : jsonError(502, "box_error", `${box} could not start the job (rc ${res.code})`);
    }

    updateJob(h.store, jobId, { state: "running", lastPollAt: now, startedAt: now });
    writeAudit(
      ctx.env.FLEET_STATE,
      { token: auth.name, action: "job-start", box, rc: 0 },
      ctx.auditSink,
      ctx.now,
    );
    return new Response(
      JSON.stringify({ job_id: jobId, box, lease_id: leaseId, state: "running" }),
      { status: 201, headers: { "content-type": "application/json", server: "grokfleet" } },
    );
  } finally {
    h.close();
  }
}

/**
 * The snapshot facts eligibility reads, in the shape it wants — the same
 * assembly the lease acquire path does, from the same one snapshot read, so a
 * job and a lease can never disagree about which boxes are eligible.
 */
function boxFacts(
  h: Handle,
  rows: Array<{ box_id: number; name: string; phase: string }>,
): { facts: BoxFacts[]; snapshotTs: number | null } {
  const snap = readLatestBoxFacts(h.store);
  const leased = deferringLeases(h.store);
  const facts: BoxFacts[] = rows.map((r) => {
    const s = snap?.boxes.get(r.name);
    return {
      name: r.name,
      index: boxIndex(r.name) ?? -1,
      phase: r.phase,
      observed: s?.observed,
      ver: s?.ver,
      lease: leased.get(r.name),
    };
  });
  return { facts, snapshotTs: snap?.ts ?? null };
}

// --- POST /v1/jobs/:id/stop --------------------------------------------------

export async function handleJobStop(ctx: ServerContext, auth: RequestAuth, id: string): Promise<Response> {
  const h = openWrite(ctx);
  if (h === undefined) return jsonError(404, "not_found", `no such job: ${id}`);
  const now = nowSec(ctx);
  try {
    const row = jobById(h.store, id);
    if (row === undefined) return jsonError(404, "not_found", `no such job: ${id}`);
    // Idempotent on a terminal state (J7): stopping something already stopped is
    // a no-op that succeeds, not an error. A retrying client must be able to
    // call this twice.
    if (isTerminal(row.state)) return jsonOk(jobView(row));

    const res = await tunnelSsh(
      ctx.runner,
      row.box,
      ctx.env.FLEET_BOX_KEY,
      boxupJobCommand(["job", "stop", id]),
      { timeoutMs: JOB_SSH_TIMEOUT_MS, knownHosts: knownHostsFile(ctx.env) },
    );
    writeAudit(
      ctx.env.FLEET_STATE,
      { token: auth.name, action: "job-stop", box: row.box, rc: res.code },
      ctx.auditSink,
      ctx.now,
    );
    if (res.code !== 0) {
      return jsonError(502, "box_error", `${row.box} could not stop job ${id} (rc ${res.code})`);
    }
    // The box wrote rc 143 and released its slot; record the same here rather
    // than waiting for a poll, so the caller's next GET already agrees.
    updateJob(h.store, id, { state: "stopped", rc: 143, endedAt: now, lastPollAt: now });
    if (row.lease_id !== null && row.owned_lease === 1) releaseLease(h.store, row.lease_id, now);
    return jsonOk(jobView(jobById(h.store, id) ?? row));
  } finally {
    h.close();
  }
}
