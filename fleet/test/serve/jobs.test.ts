// jobs.test.ts — the reconcile job registry singleton (§3, mutant: job singleton)
// + the /v1/reconcile / /v1/jobs route behavior (202 / 409 / 404 / done).

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { JobRegistry } from "../../src/serve/jobs.ts";
import { makeFetch } from "../../src/serve/server.ts";
import type { TickRunner } from "../../src/serve/context.ts";
import { fakeContext, postReq, getReq, fakeSyscalls, fakeLockDeps } from "./helpers.ts";
import { setLogSink } from "../../src/log.ts";

let restore: (l: string) => void;
beforeEach(() => {
  restore = setLogSink(() => {});
});
afterEach(() => setLogSink(restore));

describe("JobRegistry singleton (mutant: allow a second concurrent job)", () => {
  test("a second start while one runs is refused with the running id", async () => {
    const reg = new JobRegistry(() => "j1");
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const o1 = reg.start(async () => {
      await gate;
      return { rc: 0, log: [] };
    });
    expect(o1).toEqual({ started: true, id: "j1" });
    expect(reg.isRunning()).toBe(true);
    const o2 = reg.start(async () => ({ rc: 0, log: [] }));
    expect(o2).toEqual({ started: false, runningId: "j1" });
    // finish the first job, then the singleton frees.
    releaseFirst();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(reg.isRunning()).toBe(false);
  });

  test("a settled job records state=done + rc + log; a crash settles rc 1", async () => {
    const reg = new JobRegistry(() => "j2");
    reg.start(async () => ({ rc: 7, log: ["did a thing"] }));
    await new Promise((r) => setTimeout(r, 5));
    expect(reg.get("j2")).toEqual({ id: "j2", state: "done", rc: 7, log: ["did a thing"] });

    const reg2 = new JobRegistry(() => "j3");
    reg2.start(async () => {
      throw new Error("boom");
    });
    await new Promise((r) => setTimeout(r, 5));
    const rec = reg2.get("j3");
    expect(rec?.state).toBe("done");
    expect(rec?.rc).toBe(1);
    expect(rec?.log?.[0]).toMatch(/crashed: boom/);
  });
});

describe("/v1/reconcile + /v1/jobs routes", () => {
  test("POST /v1/reconcile ⇒ 202 {job_id}; a second ⇒ 409 job_running", async () => {
    // A tick that blocks so the job stays running for the second POST.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tick: TickRunner = { async run() { await gate; return 0; } };
    const { sys } = fakeSyscalls();
    const ctx = await fakeContext({ tick, lockDeps: fakeLockDeps(sys) });
    const fetch = makeFetch(ctx);

    const r1 = await fetch(postReq("/v1/reconcile", "ADMINSECRET", { confirm: "fleet" }));
    expect(r1.status).toBe(202);
    const body1 = await r1.json();
    expect(body1.job_id).toBe("job-fixed-1");

    const r2 = await fetch(postReq("/v1/reconcile", "ADMINSECRET", { confirm: "fleet" }));
    expect(r2.status).toBe(409);
    expect((await r2.json()).error.code).toBe("job_running");

    release();
    await new Promise((r) => setTimeout(r, 5));

    // GET /v1/jobs/:id ⇒ done rc 0.
    const j = await fetch(getReq("/v1/jobs/job-fixed-1", "ADMINSECRET"));
    expect(j.status).toBe(200);
    const jb = await j.json();
    expect(jb.state).toBe("done");
    expect(jb.rc).toBe(0);
  });

  test("GET /v1/jobs/:unknown ⇒ 404 (TUI re-polls /v1/fleet)", async () => {
    const ctx = await fakeContext();
    const fetch = makeFetch(ctx);
    const r = await fetch(getReq("/v1/jobs/nope", "ADMINSECRET"));
    expect(r.status).toBe(404);
  });

  test("readonly token cannot GET /v1/jobs (admin scope)", async () => {
    const ctx = await fakeContext();
    const fetch = makeFetch(ctx);
    const r = await fetch(getReq("/v1/jobs/job-fixed-1", "READSECRET"));
    expect(r.status).toBe(403);
  });
});
