// job-cli.test.ts — `grokfleet job` (blueprint grokfleet-jobs J8).

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { cmdJob, parseStart, idArg, rcFor, RC_NOTHING_RAN, RC_TIMEOUT, RC_INTERRUPTED } from "../../src/commands/job.ts";
import type { ApiClient, ClientResult, Job, StartedJob } from "../../src/tui/api-client.ts";
import { RC } from "../../src/upgrade.ts";
import { setLogSink } from "../../src/log.ts";

let logs: string[] = [];
let restore: (l: string) => void;
beforeEach(() => {
  logs = [];
  restore = setLogSink((l) => logs.push(l));
});
afterEach(() => setLogSink(restore));

function job(over: Partial<Job> = {}): Job {
  return {
    job_id: "J1",
    box: "grok-box-001",
    kind: "run",
    state: "running",
    rc: null,
    holder: "admin-one",
    purpose: "gate",
    cmd: "make test",
    cwd: "/workspace",
    wall_cap_s: 2400,
    keep_alive: false,
    lease_id: "L1",
    created_at: null,
    started_at: null,
    ended_at: null,
    last_poll_at: null,
    log_bytes: 0,
    log_truncated: false,
    lost_reason: null,
    ...over,
  };
}

const ok = <T>(value: T): ClientResult<T> => ({ ok: true, value });

/** An API that walks a scripted sequence of job states. */
function fakeApi(over: Partial<ApiClient> & { states?: Job[] } = {}): ApiClient {
  const states = over.states ?? [job({ state: "done", rc: 0 })];
  let i = 0;
  const base = {
    startJob: async (): Promise<ClientResult<StartedJob>> =>
      ok({ job_id: "J1", box: "grok-box-001", lease_id: "L1", state: "running" }),
    getJob: async (): Promise<ClientResult<Job>> => ok(states[Math.min(i++, states.length - 1)]!),
    listJobs: async (): Promise<ClientResult<Job[]>> => ok([job()]),
    stopJob: async (): Promise<ClientResult<Job>> => ok(job({ state: "stopped", rc: 143 })),
    jobLog: async (): Promise<ClientResult<{ text: string; next: number; truncated: boolean }>> =>
      ok({ text: "", next: 0, truncated: false }),
  } as unknown as ApiClient;
  return { ...base, ...over } as ApiClient;
}

function deps(api: ApiClient, out: string[] = []) {
  return {
    api,
    sleep: async () => {},
    onInterrupt: () => () => {},
    out: (s: string) => void out.push(s),
  };
}

describe("J8 — parsing", () => {
  test("everything after -- is the command, verbatim and unsplit", () => {
    const p = parseStart(["--purpose", "gate", "--", "cd /w && make test -j4"]);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // Re-quoting here is how a command with an embedded quote gets mangled: the
    // API sends one string and the box's runner hands it to `sh -c`.
    expect(p.opts.cmd).toBe("cd /w && make test -j4");
  });

  test("a bare box index is accepted, like every other command", () => {
    const p = parseStart(["--box", "8", "--purpose", "gate", "--", "true"]);
    expect(p.ok && p.opts.box).toBe("grok-box-008");
  });

  test("--purpose is required, and so is a command", () => {
    expect(parseStart(["--", "true"]).ok).toBe(false);
    expect(parseStart(["--purpose", "gate"]).ok).toBe(false);
  });

  test("a service with --cap is REFUSED, not silently uncapped", () => {
    const p = parseStart(["--kind", "service", "--cap", "60", "--purpose", "p", "--", "true"]);
    expect(p.ok).toBe(false);
    // Dropping it silently would be found out only by the job that never ends.
    if (!p.ok) expect(p.message).toContain("no deadline");
  });

  test("an id that starts with '-' needs '--' first (J open item)", () => {
    expect(idArg(["--", "-Ab3xyz"])).toBe("-Ab3xyz");
    expect(idArg(["J1"])).toBe("J1");
  });
});

describe("J8 — exit codes", () => {
  test("a job's own rc passes through", () => {
    expect(rcFor(job({ state: "done", rc: 0 }))).toBe(0);
    expect(rcFor(job({ state: "failed", rc: 2 }))).toBe(2);
  });

  test("the box's cap is 124, and a lost job is 255 — NOTHING RAN", () => {
    expect(rcFor(job({ state: "timeout", rc: 124 }))).toBe(RC_TIMEOUT);
    // 255 is the one code a remote command cannot produce, which is what makes
    // "no capacity" distinguishable from "the build failed".
    expect(rcFor(job({ state: "lost", rc: null }))).toBe(RC_NOTHING_RAN);
    expect(rcFor(job({ state: "crashloop", rc: null }))).toBe(RC_NOTHING_RAN);
  });

  test("job run exits with the remote rc", async () => {
    const rc = await cmdJob(["run", "--purpose", "gate", "--", "make test"], deps(fakeApi({ states: [job({ state: "failed", rc: 3 })] })));
    expect(rc).toBe(3);
  });

  test("a start that never happened exits 255 and carries the reason map", async () => {
    const out: string[] = [];
    const api = fakeApi({
      startJob: async () => ({
        ok: false,
        kind: "error",
        status: 409,
        message: "no box satisfies the request",
        reasons: { "grok-box-001": "boxup lacks job runner" },
      }),
    } as unknown as Partial<ApiClient>);
    const rc = await cmdJob(["run", "--json", "--purpose", "gate", "--", "make test"], deps(api, out));
    expect(rc).toBe(RC_NOTHING_RAN);
    const env = JSON.parse(out.join("")) as { job_id: string | null; reasons: Record<string, string> };
    // The ABSENCE of job_id is how a caller tells "nothing ran" from "ran and
    // failed" — 255 alone is also ssh's transport failure.
    expect(env.job_id).toBeNull();
    expect(env.reasons["grok-box-001"]).toBe("boxup lacks job runner");
  });

  test("job start returns immediately with the id, rc 0", async () => {
    const out: string[] = [];
    const rc = await cmdJob(["start", "--json", "--purpose", "gate", "--", "sleep 600"], deps(fakeApi(), out));
    expect(rc).toBe(RC.OK);
    expect((JSON.parse(out.join("")) as { job_id: string }).job_id).toBe("J1");
  });

  test("an interrupt sends stop and exits 130", async () => {
    let fire: (() => void) | undefined;
    let stopped = false;
    const api = fakeApi({
      states: [job({ state: "running" }), job({ state: "running" }), job({ state: "stopped", rc: 143 })],
      stopJob: async () => {
        stopped = true;
        return ok(job({ state: "stopped", rc: 143 }));
      },
    } as unknown as Partial<ApiClient>);
    const d = {
      ...deps(api),
      onInterrupt: (fn: () => void) => {
        fire = fn;
        return () => {};
      },
      sleep: async () => {
        fire?.(); // the interrupt lands while we are waiting
      },
    };
    const rc = await cmdJob(["run", "--purpose", "gate", "--", "sleep 600"], d);
    // Exiting immediately would leave the box running a job nobody watches.
    expect(stopped).toBe(true);
    expect(rc).toBe(RC_INTERRUPTED);
  });

  test("a poll failure is not a verdict: the wait continues", async () => {
    let calls = 0;
    const api = fakeApi({
      getJob: async () => {
        calls++;
        if (calls < 3) return { ok: false, kind: "link_down", message: "link down" };
        return ok(job({ state: "done", rc: 0 }));
      },
    } as unknown as Partial<ApiClient>);
    const rc = await cmdJob(["run", "--purpose", "gate", "--", "true"], deps(api));
    expect(rc).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

describe("J8 — reads", () => {
  test("ls prints one line per job", async () => {
    const rc = await cmdJob(["ls"], deps(fakeApi()));
    expect(rc).toBe(RC.OK);
    expect(logs.some((l) => l.includes("J1") && l.includes("grok-box-001"))).toBe(true);
  });

  test("an unknown subcommand is usage, and `help` is not", async () => {
    expect(await cmdJob(["wat"], deps(fakeApi()))).toBe(RC.USAGE);
    expect(await cmdJob(["help"], deps(fakeApi()))).toBe(RC.OK);
  });
});
