// job.ts — `grokfleet job <sub>` (blueprint grokfleet-jobs J8).
//
// Like `lease`, this talks ONLY to the admin API — never to a box and never to
// the store, even on the VPS — so one code path serves the laptop and the
// brain. What reaches the box is the API's business.
//
// EXIT CODES, the part a machine caller keys on:
//
//   * `job run` passes the REMOTE command's rc through, any value 0-254,
//     whenever a command RAN;
//   * 255 when NO command ever ran — no eligible box, the box refused, the API
//     was unreachable at start. That is the one code a remote command cannot
//     produce, so "no capacity" is finally distinguishable from "build failed"
//     (rc 1 and rc 6 are ordinary command codes). Same rule as `lease run`;
//   * 124 when the box's wall-clock cap fired — the rc `timeout` carries;
//   * 130 when the CLI itself is interrupted. The interrupt SENDS `stop` and
//     waits for the terminal state, so Ctrl-C does not leave the box running a
//     job nobody is watching.
//
// A caller tells "nothing ran" from "ran and failed" by the ABSENCE of `job_id`
// in the `--json` envelope, never by the number alone: 255 is also ssh's own
// transport failure.

import { RC } from "../upgrade.ts";
import { log } from "../log.ts";
import { RC_POINTER_LINE } from "./rc.ts";
import { isValidBoxName } from "../boxes.ts";
import { JOB_MAX_CAP_S } from "../jobs.ts";
import type { ApiClient, ClientResult, Job } from "../tui/api-client.ts";

/** J8: `job run` polls this often while it waits. */
export const JOB_POLL_MS = 5_000;
/** J8: an interrupt waits this long for the stop to take. */
export const JOB_STOP_WAIT_MS = 15_000;
/** The rc for "no command ever ran". */
export const RC_NOTHING_RAN = 255;
/** The rc the box's cap produces. */
export const RC_TIMEOUT = 124;
/** The rc for an interrupted CLI. */
export const RC_INTERRUPTED = 130;

const TERMINAL = new Set(["done", "failed", "timeout", "stopped", "lost", "crashloop"]);

/** The `--json` envelope (J8), field set stated once. */
export interface JobEnvelope {
  rc: number;
  job_id: string | null;
  box: string | null;
  kind: string | null;
  state: string;
  lease_id: string | null;
  log_bytes: number;
  log_truncated: boolean;
  reasons?: Record<string, string>;
  lost_reason?: string;
}

export const JOB_HELP = [
  "grokfleet job <sub>  — run a bounded command, or a service, on a leased box",
  "",
  "  run   [--box NNN] [--cap <s>] [--cwd <dir>] --purpose <p> -- <cmd...>",
  "        start, stream the log, exit with the command's rc",
  "  start [--box NNN] [--kind run|service] [--cap <s>] [--cwd <dir>]",
  "        [--lease <id>] --purpose <p> -- <cmd...>",
  "        start and return immediately with the job id",
  "  ls    [--state <s>] [--box NNN]        list jobs",
  "  show  [--] <id>                        one job",
  "  log   [--] <id> [--offset <n>]         the log from an offset",
  "  stop  [--] <id>                        SIGTERM the group, then SIGKILL",
  "  wait  [--] <id>                        block until terminal, exit with its rc",
  "",
  "  --json   one JSON envelope on stdout instead of lines",
  "",
  "A job id can begin with '-', so put '--' before it: grokfleet job show -- -Ab…",
  RC_POINTER_LINE,
].join("\n");

export interface JobDeps {
  api: ApiClient;
  /** the poll/wait clock, injected so tests do not sleep. */
  sleep: (ms: number) => Promise<void>;
  /** register an interrupt handler; returns the unregister. */
  onInterrupt: (fn: () => void) => () => void;
  /** where streamed log bytes go (process.stdout.write in production). */
  out: (s: string) => void;
  json?: boolean;
}

/** Parsed argv for the start-shaped subcommands. */
interface StartOpts {
  box?: string;
  kind: "run" | "service";
  capS?: number;
  cwd?: string;
  purpose: string;
  leaseId?: string;
  cmd: string;
}

type ParseResult = { ok: true; opts: StartOpts } | { ok: false; message: string };

/**
 * Everything after `--` is the COMMAND, joined verbatim. It is not re-parsed,
 * not shell-split and not quoted here: the API sends it to the box as one
 * string and the box's runner hands it to `sh -c`. Quoting it twice is how a
 * command with an embedded quote gets mangled.
 */
export function parseStart(argv: string[]): ParseResult {
  const opts: StartOpts = { kind: "run", purpose: "", cmd: "" };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      opts.cmd = argv.slice(i + 1).join(" ");
      break;
    }
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--box": {
        const v = next();
        if (v === undefined || !isValidBoxName(v) ) {
          // Accept a bare index too — every other command does.
          const asName = v !== undefined && /^[0-9]{1,3}$/.test(v) ? `grok-box-${v.padStart(3, "0")}` : undefined;
          if (asName === undefined) return { ok: false, message: `job: invalid --box '${v ?? ""}'` };
          opts.box = asName;
        } else {
          opts.box = v;
        }
        break;
      }
      case "--kind": {
        const v = next();
        if (v !== "run" && v !== "service") return { ok: false, message: "job: --kind must be run or service" };
        opts.kind = v;
        break;
      }
      case "--cap": {
        const v = next();
        const n = v === undefined ? NaN : Number(v);
        if (!Number.isInteger(n) || n <= 0 || n > JOB_MAX_CAP_S) {
          return { ok: false, message: `job: --cap must be an integer in 1..${JOB_MAX_CAP_S}` };
        }
        opts.capS = n;
        break;
      }
      case "--cwd": {
        const v = next();
        if (v === undefined || v === "") return { ok: false, message: "job: --cwd needs a directory" };
        opts.cwd = v;
        break;
      }
      case "--purpose": {
        const v = next();
        if (v === undefined || v.trim() === "") return { ok: false, message: "job: --purpose needs a value" };
        opts.purpose = v.trim();
        break;
      }
      case "--lease": {
        const v = next();
        if (v === undefined || v === "") return { ok: false, message: "job: --lease needs an id" };
        opts.leaseId = v;
        break;
      }
      case "--json":
        break; // handled by the caller
      default:
        return { ok: false, message: `job: unknown option '${a}'` };
    }
  }
  if (opts.purpose === "") return { ok: false, message: "job: --purpose is required" };
  if (opts.cmd.trim() === "") return { ok: false, message: "job: the command is required, after '--'" };
  if (opts.kind === "service" && opts.capS !== undefined) {
    // Refusing beats silently dropping it: a caller who asked for a deadline
    // and got none would find out from the job that never ended.
    return { ok: false, message: "job: a service has no deadline — drop --cap or use --kind run" };
  }
  return { ok: true, opts };
}

/** An id argument, honouring the `--` that a leading-dash id needs. */
export function idArg(argv: string[]): string | undefined {
  const rest = argv[0] === "--" ? argv.slice(1) : argv;
  const id = rest[0];
  return id === undefined || id === "" ? undefined : id;
}

function envelope(over: Partial<JobEnvelope>): JobEnvelope {
  return {
    rc: RC_NOTHING_RAN,
    job_id: null,
    box: null,
    kind: null,
    state: "unknown",
    lease_id: null,
    log_bytes: 0,
    log_truncated: false,
    ...over,
  };
}

function emit(deps: JobDeps, env: JobEnvelope, lines: string[]): number {
  if (deps.json === true) deps.out(JSON.stringify(env) + "\n");
  else for (const l of lines) log(l);
  return env.rc;
}

/** rc for a terminal job (J8): the command's own, or the code for how it died. */
export function rcFor(job: Job): number {
  if (job.state === "timeout") return RC_TIMEOUT;
  if (job.state === "lost" || job.state === "crashloop") return RC_NOTHING_RAN;
  if (job.rc !== null) return job.rc;
  return job.state === "done" ? 0 : 1;
}

async function startJob(deps: JobDeps, o: StartOpts): Promise<ClientResult<{ job_id: string; box: string; lease_id: string | null }>> {
  return deps.api.startJob({
    cmd: o.cmd,
    purpose: o.purpose,
    kind: o.kind,
    ...(o.box === undefined ? {} : { box: o.box }),
    ...(o.cwd === undefined ? {} : { cwd: o.cwd }),
    ...(o.capS === undefined ? {} : { wall_cap_s: o.capS }),
    ...(o.leaseId === undefined ? {} : { lease_id: o.leaseId }),
  });
}

export async function cmdJob(argv: string[], deps: JobDeps): Promise<number> {
  const sub = argv[0] ?? "";
  const rest = argv.slice(1);
  const json = rest.includes("--json") || argv.includes("--json");
  const d: JobDeps = { ...deps, json };

  switch (sub) {
    case "start":
    case "run": {
      const p = parseStart(rest);
      if (!p.ok) {
        log(p.message);
        return RC.USAGE;
      }
      const started = await startJob(d, p.opts);
      if (!started.ok) {
        // NOTHING RAN. The reason map comes straight through so an agent can see
        // which box it could have had.
        const env = envelope({
          state: "not_started",
          ...(started.reasons === undefined ? {} : { reasons: started.reasons }),
        });
        return emit(d, env, [`job: ${started.message}`]);
      }
      const { job_id, box, lease_id } = started.value;
      if (sub === "start") {
        return emit(
          d,
          envelope({ rc: 0, job_id, box, kind: p.opts.kind, state: "running", lease_id }),
          [`job: ${job_id} started on ${box}`],
        );
      }
      return waitAndStream(d, job_id, box, lease_id);
    }

    case "wait": {
      const id = idArg(rest);
      if (id === undefined) {
        log("job: wait needs a job id");
        return RC.USAGE;
      }
      return waitAndStream(d, id, null, null, { stream: false });
    }

    case "ls": {
      const state = optValue(rest, "--state");
      const box = optValue(rest, "--box");
      const r = await d.api.listJobs({
        ...(state === undefined ? {} : { state }),
        ...(box === undefined ? {} : { box }),
      });
      if (!r.ok) {
        log(`job: ${r.message}`);
        return RC.TRANSPORT;
      }
      if (json) {
        d.out(JSON.stringify({ jobs: r.value }) + "\n");
        return RC.OK;
      }
      if (r.value.length === 0) {
        log("no jobs");
        return RC.OK;
      }
      for (const j of r.value) {
        log(`${j.job_id}\t${j.box}\t${j.kind}\t${j.state}\trc=${j.rc ?? "-"}\t${j.purpose}`);
      }
      return RC.OK;
    }

    case "show": {
      const id = idArg(rest);
      if (id === undefined) {
        log("job: show needs a job id");
        return RC.USAGE;
      }
      const r = await d.api.getJob(id, true);
      if (!r.ok) {
        log(`job: ${r.message}`);
        return r.kind === "error" && r.status === 404 ? RC.USAGE : RC.TRANSPORT;
      }
      if (json) d.out(JSON.stringify(r.value) + "\n");
      else {
        for (const [k, v] of Object.entries(r.value)) log(`${k}\t${v === null ? "-" : String(v)}`);
      }
      return RC.OK;
    }

    case "log": {
      const id = idArg(rest);
      if (id === undefined) {
        log("job: log needs a job id");
        return RC.USAGE;
      }
      const offRaw = optValue(rest, "--offset");
      const offset = offRaw !== undefined && /^[0-9]+$/.test(offRaw) ? Number.parseInt(offRaw, 10) : 0;
      const r = await d.api.jobLog(id, offset);
      if (!r.ok) {
        log(`job: ${r.message}`);
        return RC.TRANSPORT;
      }
      d.out(r.value.text);
      return RC.OK;
    }

    case "stop": {
      const id = idArg(rest);
      if (id === undefined) {
        log("job: stop needs a job id");
        return RC.USAGE;
      }
      const r = await d.api.stopJob(id);
      if (!r.ok) {
        log(`job: ${r.message}`);
        return RC.TRANSPORT;
      }
      return emit(
        d,
        envelope({ rc: 0, job_id: id, box: r.value.box, kind: r.value.kind, state: r.value.state, lease_id: r.value.lease_id }),
        [`job: ${id} ${r.value.state}`],
      );
    }

    default:
      log(JOB_HELP);
      return sub === "" || sub === "help" || sub === "--help" ? RC.OK : RC.USAGE;
  }
}

function optValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith("--") ? undefined : v;
}

/**
 * Block until the job is terminal, streaming the log by offset.
 *
 * `?refresh=1` on every poll is what makes this independent of the 5-minute
 * tick (J5): the API asks the box inline. An interrupt sends `stop` and then
 * keeps waiting — briefly — because exiting immediately would leave the box
 * running a job with nobody watching it, which is the failure this whole
 * feature exists to avoid.
 */
async function waitAndStream(
  deps: JobDeps,
  id: string,
  box: string | null,
  leaseId: string | null,
  opts: { stream?: boolean } = {},
): Promise<number> {
  const stream = opts.stream !== false;
  let offset = 0;
  let interrupted = false;
  const off = deps.onInterrupt(() => {
    interrupted = true;
  });
  try {
    for (;;) {
      const r = await deps.api.getJob(id, true);
      if (!r.ok) {
        // A poll failure is not a verdict: keep waiting. The job is on the box
        // under the box's cap, and the link may come back.
        await deps.sleep(JOB_POLL_MS);
        continue;
      }
      const job = r.value;
      if (stream) offset = await drain(deps, id, offset);

      if (TERMINAL.has(job.state)) {
        const env = envelope({
          rc: interrupted ? RC_INTERRUPTED : rcFor(job),
          job_id: id,
          box: job.box ?? box,
          kind: job.kind,
          state: job.state,
          lease_id: job.lease_id ?? leaseId,
          log_bytes: job.log_bytes,
          log_truncated: job.log_truncated,
          ...(job.lost_reason === null ? {} : { lost_reason: job.lost_reason }),
        });
        return emit(deps, env, [`job: ${id} ${job.state} rc=${env.rc}`]);
      }

      if (interrupted) {
        // Send the stop ONCE, then fall through to the normal wait so the log
        // tail and the terminal state still arrive.
        interrupted = false;
        await deps.api.stopJob(id);
        const deadline = JOB_STOP_WAIT_MS;
        let waited = 0;
        while (waited < deadline) {
          await deps.sleep(JOB_POLL_MS);
          waited += JOB_POLL_MS;
          const after = await deps.api.getJob(id, true);
          if (after.ok && TERMINAL.has(after.value.state)) {
            if (stream) offset = await drain(deps, id, offset);
            return emit(
              deps,
              envelope({
                rc: RC_INTERRUPTED,
                job_id: id,
                box: after.value.box ?? box,
                kind: after.value.kind,
                state: after.value.state,
                lease_id: after.value.lease_id ?? leaseId,
                log_bytes: after.value.log_bytes,
                log_truncated: after.value.log_truncated,
              }),
              [`job: ${id} stopped rc=${RC_INTERRUPTED}`],
            );
          }
        }
        return emit(
          deps,
          envelope({ rc: RC_INTERRUPTED, job_id: id, box, state: "stopping", lease_id: leaseId }),
          [`job: ${id} did not reach a terminal state within ${deadline / 1000}s — it may still be running`],
        );
      }
      await deps.sleep(JOB_POLL_MS);
    }
  } finally {
    off();
  }
}

/** Fetch every log byte available from `offset`, printing as we go. */
async function drain(deps: JobDeps, id: string, offset: number): Promise<number> {
  for (;;) {
    const r = await deps.api.jobLog(id, offset);
    if (!r.ok || r.value.text.length === 0) return offset;
    if (deps.json !== true) deps.out(r.value.text);
    if (r.value.next <= offset) return offset; // no progress: stop, never spin
    offset = r.value.next;
  }
}
