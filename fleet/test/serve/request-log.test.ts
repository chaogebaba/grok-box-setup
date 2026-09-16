// request-log.test.ts — F6 (VPS audit r3): the API logged NOTHING per request,
// only `audit:` lines for mutating actions. A structured line now fires at the
// dispatch point (makeFetch) for every non-2xx response and any response over
// REQUEST_LOG_SLOW_MS, staying silent on fast 2xx traffic (a 5s TUI poll would
// otherwise add ~17k lines/day). Mutants: M3 threshold ignored (fast 200
// logs), M4 the presented token value logged instead of its NAME.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { makeFetch } from "../../src/serve/server.ts";
import { fakeContext, getReq } from "./helpers.ts";
import { setLogSink } from "../../src/log.ts";

let logs: string[];
let restore: (l: string) => void;
beforeEach(() => {
  logs = [];
  restore = setLogSink((l) => logs.push(l));
});
afterEach(() => setLogSink(restore));

describe("F6 structured request log", () => {
  test("a 404 logs — method, route template, status, duration, token=-", async () => {
    const ctx = await fakeContext();
    const fetch = makeFetch(ctx);
    const r = await fetch(getReq("/v1/nope-not-a-route", "ADMINSECRET"));
    expect(r.status).toBe(404);
    const lines = logs.filter((l) => l.includes("grokfleet: serve: GET"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("/v1/*unmatched*");
    expect(lines[0]).toContain(" 404 ");
    expect(lines[0]).toMatch(/\d+ms/);
    expect(lines[0]).toContain("token=admin-one");
  });

  test("a fast 200 does not log", async () => {
    // No nowMs override ⇒ real Date.now(), which resolves this synchronous-ish
    // health check in well under the threshold.
    const ctx = await fakeContext();
    const fetch = makeFetch(ctx);
    const r = await fetch(getReq("/v1/health"));
    expect(r.status).toBe(200);
    expect(logs.filter((l) => l.includes("grokfleet: serve: GET"))).toHaveLength(0);
  });

  test("a slow 200 logs, with the route template not the raw path", async () => {
    // Fake clock: first nowMs() call is the wrapper's start, the second is its
    // end (route() and handleFleet call ctx.now(), a SEPARATE Date-returning
    // seam — nowMs is only read by the wrapper itself, so exactly two calls).
    const calls = [1_000, 1_000 + 2001];
    const ctx = await fakeContext({ nowMs: () => calls.shift()! });
    const fetch = makeFetch(ctx);
    const r = await fetch(getReq("/v1/fleet", "READSECRET"));
    expect(r.status).toBe(200);
    const lines = logs.filter((l) => l.includes("grokfleet: serve: GET"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("/v1/fleet");
    expect(lines[0]).toContain(" 200 ");
    expect(lines[0]).toContain("2001ms");
    // token NAME, never the presented token value.
    expect(lines[0]).toContain("token=read-one");
    expect(lines[0]).not.toContain("READSECRET");
  });

  test("a fast 200 under the threshold does not log even with nowMs wired", async () => {
    const calls = [1_000, 1_000 + 5];
    const ctx = await fakeContext({ nowMs: () => calls.shift()! });
    const fetch = makeFetch(ctx);
    await fetch(getReq("/v1/fleet", "READSECRET"));
    expect(logs.filter((l) => l.includes("grokfleet: serve: GET"))).toHaveLength(0);
  });

  test("dynamic segments never appear in the route template", async () => {
    const ctx = await fakeContext();
    const fetch = makeFetch(ctx);
    // grok-box-does-not-exist ⇒ 404 from boxGuard, but the TEMPLATE must read
    // /v1/boxes/:box, never the raw box name.
    const r = await fetch(getReq("/v1/boxes/grok-box-does-not-exist", "ADMINSECRET"));
    expect(r.status).toBe(404);
    const lines = logs.filter((l) => l.includes("grokfleet: serve: GET"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("/v1/boxes/:box");
    expect(lines[0]).not.toContain("grok-box-does-not-exist");
  });
});
