// diff.test.ts — GET /v1/boxes/:name/diff (readonly) surfaces the config-diff
// core's rc + captured log, and re-emits a one-line reason on a nonzero rc
// (R2-A1) rather than an empty body / a 500.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { makeFetch } from "../../src/serve/server.ts";
import { fakeContext, getReq } from "./helpers.ts";
import { FakeRunner, result } from "../fake-runner.ts";
import { setLogSink } from "../../src/log.ts";

let restore: (l: string) => void;
beforeEach(() => {
  restore = setLogSink(() => {});
});
afterEach(() => setLogSink(restore));

describe("GET /v1/boxes/:name/diff", () => {
  test("an unreachable box ⇒ HTTP 200 with a nonzero rc and a non-empty log (R2-A1)", async () => {
    // ss shows the tunnel up so the diff proceeds to the dry-run ssh, which
    // fails (ssh rc 255) ⇒ the core returns rc 2 and emits a reason line.
    const runner = new FakeRunner((argv) => {
      if (argv[0] === "ss") return result({ stdout: "LISTEN 0 0 127.0.0.1:20001 0.0.0.0:*", code: 0 });
      if (argv[0] === "diff") return result({ stdout: "", code: 0 });
      // the dry-run remote script over ssh fails (unreachable).
      return result({ code: 255, stdout: "", stderr: "ssh: connect refused" });
    });
    const ctx = await fakeContext({ runner, enrolled: ["grok-box-1"] });
    const fetch = makeFetch(ctx);
    const r = await fetch(getReq("/v1/boxes/grok-box-1/diff", "READSECRET"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.rc).not.toBe(0);
    expect(body.log.length).toBeGreaterThan(0); // a reason was re-emitted
  });

  test("readonly scope is sufficient for diff", async () => {
    const runner = new FakeRunner(() => result({ stdout: "", code: 0 })); // tunnel down ⇒ rc 2
    const ctx = await fakeContext({ runner, enrolled: ["grok-box-1"] });
    const fetch = makeFetch(ctx);
    const r = await fetch(getReq("/v1/boxes/grok-box-1/diff", "READSECRET"));
    expect(r.status).toBe(200); // not 403
  });
});
