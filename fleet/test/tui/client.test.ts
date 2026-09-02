// client.test.ts — the api-client with a FAKE fetch: happy paths + the LINK
// DOWN classification (5xx / transport / malformed) + auth kinds + confirm body.

import { test, expect, describe } from "bun:test";
import { makeApiClient, type FetchLike } from "../../src/tui/api-client.ts";

/** A fake fetch that records requests and returns a scripted Response. */
function fakeFetch(
  handler: (url: string, init: RequestInit) => { status: number; body: string } | "throw",
): { fetch: FetchLike; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    if (r === "throw") throw new Error("network");
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

describe("GET /v1/fleet", () => {
  test("happy: parses the fleet view", async () => {
    const { fetch } = fakeFetch(() => ({
      status: 200,
      body: JSON.stringify({ snapshot_ts: "t", apply: true, canary: "grok-box-1", scope: "admin", boxes: [{ name: "grok-box-1", tunnel: "up", check: "OK", ver: "5.3.0", drift: "no", config: "in-sync", checkfail: false, asleep: false, expiry_days: 5 }] }),
    }));
    const c = makeApiClient("http://h", "TOK", fetch);
    const r = await c.fleet();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scope).toBe("admin");
      expect(r.value.boxes[0]!.name).toBe("grok-box-1");
    }
  });
  test("R2: apply_source is carried through, and a server that omits it is treated as stale-capable", async () => {
    const bodyWith = (extra: string) =>
      `{"snapshot_ts":"t","apply":true${extra},"canary":null,"scope":"admin","boxes":[]}`;
    const live = makeApiClient("http://h", "TOK", fakeFetch(() => ({ status: 200, body: bodyWith(',"apply_source":"config"') })).fetch);
    const r1 = await live.fleet();
    expect(r1.ok && r1.value.apply_source).toBe("config");
    const fell = makeApiClient("http://h", "TOK", fakeFetch(() => ({ status: 200, body: bodyWith(',"apply_source":"snapshot"') })).fetch);
    const r2 = await fell.fleet();
    expect(r2.ok && r2.value.apply_source).toBe("snapshot");
    // an older serve has no such field: never claim the value is live.
    const old = makeApiClient("http://h", "TOK", fakeFetch(() => ({ status: 200, body: bodyWith("") })).fetch);
    const r3 = await old.fleet();
    expect(r3.ok && r3.value.apply_source).toBe("snapshot");
  });
  test("sends the bearer token", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: JSON.stringify({ boxes: [] }) }));
    await makeApiClient("http://h", "SEKRIT", fetch).fleet();
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe("Bearer SEKRIT");
  });
});

describe("LINK DOWN classification (A14)", () => {
  test("HTTP 5xx ⇒ link_down", async () => {
    const { fetch } = fakeFetch(() => ({ status: 502, body: "" }));
    const r = await makeApiClient("http://h", "T", fetch).fleet();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("link_down");
  });
  test("transport throw ⇒ link_down", async () => {
    const { fetch } = fakeFetch(() => "throw");
    const r = await makeApiClient("http://h", "T", fetch).fleet();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("link_down");
  });
  test("malformed 2xx body ⇒ link_down", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: "not json {{{" }));
    const r = await makeApiClient("http://h", "T", fetch).fleet();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("link_down");
  });
  test("401 ⇒ unauthorized, 403 ⇒ forbidden (NOT link_down)", async () => {
    const un = await makeApiClient("http://h", "T", fakeFetch(() => ({ status: 401, body: JSON.stringify({ error: { code: "unauthorized", message: "no" } }) })).fetch).fleet();
    expect(un.ok).toBe(false);
    if (!un.ok) expect(un.kind).toBe("unauthorized");
    const fb = await makeApiClient("http://h", "T", fakeFetch(() => ({ status: 403, body: JSON.stringify({ error: { code: "forbidden", message: "admin" } }) })).fetch).journal("grok-box-1", 50);
    expect(fb.ok).toBe(false);
    if (!fb.ok) expect(fb.kind).toBe("forbidden");
  });
});

describe("actions send the confirm body", () => {
  test("config-push sends {confirm:<box>}", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: JSON.stringify({ rc: 0, log: [] }) }));
    await makeApiClient("http://h", "T", fetch).configPush("grok-box-1");
    expect(calls[0]!.url).toContain("/v1/boxes/grok-box-1/config-push");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ confirm: "grok-box-1" });
  });
  test("rename sends {to, confirm}", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: JSON.stringify({ rc: 0, log: [] }) }));
    await makeApiClient("http://h", "T", fetch).rename("grok-box-3", "grok-box-003");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ to: "grok-box-003", confirm: "grok-box-3" });
  });
  test("reconcile sends {confirm:'fleet'} and returns the job id", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 202, body: JSON.stringify({ job_id: "j-1" }) }));
    const r = await makeApiClient("http://h", "T", fetch).reconcile();
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ confirm: "fleet" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.job_id).toBe("j-1");
  });
  test("a nonzero domain rc is surfaced as ok:true with rc (rc→HTTP is server's job)", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: JSON.stringify({ rc: 5, log: ["push failed"] }) }));
    const r = await makeApiClient("http://h", "T", fetch).configPush("grok-box-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.rc).toBe(5);
      expect(r.value.log).toContain("push failed");
    }
  });
});

describe("history", () => {
  test("returns the lines array", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: JSON.stringify({ hours: 24, box: "grok-box-1", lines: [{ v: 1, ts: "t", apply: false, canary: null, boxes: [] }] }) }));
    const r = await makeApiClient("http://h", "T", fetch).history("grok-box-1", 24);
    expect(calls[0]!.url).toContain("/v1/history?box=grok-box-1&hours=24");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.length).toBe(1);
  });
});

// --- 5.7.0: the two NEW methods (D1/D2) --------------------------------------

describe("GET /v1/boxes/:name (D1 detail facts)", () => {
  const FULL = JSON.stringify({
    name: "grok-box-1",
    checkfail_count: 3,
    asleep_since: "2026-03-20T09:46:40Z",
    asleep_last: "2026-03-20T10:46:40Z",
    expires_at: "2026-06-01",
    api_backoff: { fails: 2, next_retry: "2026-03-20T12:33:20Z" },
  });
  test("happy: every fact is carried through", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: FULL }));
    const r = await makeApiClient("http://h", "T", fetch).box("grok-box-1");
    expect(calls[0]!.url).toBe("http://h/v1/boxes/grok-box-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.checkfail_count).toBe(3);
      expect(r.value.expires_at).toBe("2026-06-01");
      expect(r.value.api_backoff).toEqual({ fails: 2, next_retry: "2026-03-20T12:33:20Z" });
    }
  });

  // Acceptance 1: a 5.6.0 engine omits all five fields. The shape validator keys
  // on `name` ONLY, so that body VALIDATES and the pane renders `—`; it must not
  // fall into the malformed-body path, which is LINK DOWN.
  test("a 5.6.0 body with none of the fields still validates (never LINK DOWN)", async () => {
    const old = JSON.stringify({ name: "grok-box-1", snapshot_ts: "t", box: null, markers: {} });
    const { fetch } = fakeFetch(() => ({ status: 200, body: old }));
    const r = await makeApiClient("http://h", "T", fetch).box("grok-box-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("grok-box-1");
      expect(r.value.checkfail_count).toBeNull();
      expect(r.value.asleep_since).toBeNull();
      expect(r.value.expires_at).toBeNull();
      expect(r.value.api_backoff).toBeNull();
    }
  });
  test("a body with NO name is malformed ⇒ link_down", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: JSON.stringify({ checkfail_count: 1 }) }));
    const r = await makeApiClient("http://h", "T", fetch).box("grok-box-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("link_down");
  });
  test("a transport failure is link_down, not a throw", async () => {
    const { fetch } = fakeFetch(() => "throw");
    const r = await makeApiClient("http://h", "T", fetch).box("grok-box-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("link_down");
  });
});

describe("GET /v1/boxes/:name/diff (D2)", () => {
  test("happy: the {rc, log} body becomes the view's lines", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: JSON.stringify({ rc: 1, log: ["--- a", "+++ b"] }) }));
    const r = await makeApiClient("http://h", "T", fetch).diff("grok-box-1");
    expect(calls[0]!.url).toBe("http://h/v1/boxes/grok-box-1/diff");
    expect(calls[0]!.init.method).toBe("GET");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.log).toEqual(["--- a", "+++ b"]);
  });
  test("an EMPTY log is a valid answer (the view renders `in sync`)", async () => {
    const { fetch } = fakeFetch(() => ({ status: 200, body: JSON.stringify({ rc: 0, log: [] }) }));
    const r = await makeApiClient("http://h", "T", fetch).diff("grok-box-1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.log).toEqual([]);
  });
  test("a network error is link_down, not a throw", async () => {
    const { fetch } = fakeFetch(() => "throw");
    const r = await makeApiClient("http://h", "T", fetch).diff("grok-box-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("link_down");
  });
  test("the box name is URL-encoded", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: "{}" }));
    await makeApiClient("http://h", "T", fetch).diff("a b/c");
    expect(calls[0]!.url).toBe("http://h/v1/boxes/a%20b%2Fc/diff");
  });
});

describe("GET /v1/boxes/:name/journal wired to the J key (D3)", () => {
  test("happy: 80 lines requested, log returned", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: JSON.stringify({ rc: 0, log: ["unit started"] }) }));
    const r = await makeApiClient("http://h", "T", fetch).journal("grok-box-1", 80);
    expect(calls[0]!.url).toBe("http://h/v1/boxes/grok-box-1/journal?lines=80");
    expect(r.ok && r.value.log).toEqual(["unit started"]);
  });
  test("a readonly token gets 403 ⇒ forbidden (NOT link_down, so the view can word it)", async () => {
    const { fetch } = fakeFetch(() => ({ status: 403, body: JSON.stringify({ error: { message: "admin scope required" } }) }));
    const r = await makeApiClient("http://h", "READONLY", fetch).journal("grok-box-1", 80);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("forbidden");
  });
  test("a network error is link_down, not a throw", async () => {
    const { fetch } = fakeFetch(() => "throw");
    const r = await makeApiClient("http://h", "T", fetch).journal("grok-box-1", 80);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("link_down");
  });
});
