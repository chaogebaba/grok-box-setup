// T3-order — reconcile_dedup: DELETE stale BEFORE POST rename (tests:587-613),
// latch on any API failure.

import { test, expect, describe } from "bun:test";
import { dedup, type DedupDeps } from "../src/actions/dedup.ts";
import { TailscaleKeys, RunContext, type KeyTransport } from "../src/reconcile/tailscale-keys.ts";

const BASE = "https://api.tailscale.com/api/v2";
const NOW = Date.parse("2026-08-30T12:00:00Z") / 1000;

// Devices fixture: live grok-box-8 online + grok-box-8-1 corpse offline.
const DEVS = JSON.stringify({
  devices: [
    { hostname: "grok-box-8", nodeId: "LIVE", online: true, lastSeen: "2999-01-01T00:00:00Z" },
    { hostname: "grok-box-8-1", nodeId: "STALE", online: false, lastSeen: "2000-01-01T00:00:00Z" },
  ],
});

interface Call {
  method: string;
  url: string;
}
function harness(opts: { getCode?: number; getBody?: string; delCode?: number; renCode?: number }) {
  const calls: Call[] = [];
  const transport: KeyTransport = {
    async request(method, url) {
      calls.push({ method, url });
      if (method === "GET") return { code: opts.getCode ?? 200, body: opts.getBody ?? DEVS };
      if (method === "DELETE") return { code: opts.delCode ?? 200, body: "" };
      if (method === "POST") return { code: opts.renCode ?? 200, body: "" };
      return { code: 500, body: "" };
    },
  };
  const ctx = new RunContext();
  const keys = new TailscaleKeys(transport, BASE, "-", "PAT", ctx);
  const deps: DedupDeps = { keys, nowSec: NOW, staleSecs: 600 };
  return { keys, ctx, calls, deps };
}

describe("dedup order + latch (tests:587-613)", () => {
  test("DELETE stale THEN POST live/name, rc 0", async () => {
    const h = harness({});
    const r = await dedup("grok-box-8", h.deps);
    expect(r.rc).toBe(0);
    const seq = h.calls.map((c) => `${c.method} ${c.url.replace(BASE, "")}`);
    // GET devices, then DELETE /device/STALE, then POST /device/LIVE/name
    expect(seq).toEqual(["GET /tailnet/-/devices?fields=all", "DELETE /device/STALE", "POST /device/LIVE/name"]);
  });

  test("API read fail ⇒ latch, rc 1, no mutation", async () => {
    const h = harness({ getCode: 500 });
    const r = await dedup("grok-box-8", h.deps);
    expect(r.rc).toBe(1);
    expect(h.ctx.readonly).toBe(true);
    expect(h.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  test("malformed body ⇒ latch, rc 1", async () => {
    const h = harness({ getBody: "{not json" });
    const r = await dedup("grok-box-8", h.deps);
    expect(r.rc).toBe(1);
    expect(h.ctx.readonly).toBe(true);
  });

  test("no stale id ⇒ rc 1, no delete", async () => {
    const single = JSON.stringify({ devices: [{ hostname: "grok-box-8", nodeId: "LIVE", online: true, lastSeen: "2999-01-01T00:00:00Z" }] });
    const h = harness({ getBody: single });
    const r = await dedup("grok-box-8", h.deps);
    expect(r.rc).toBe(1);
    expect(h.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  test("DELETE fails ⇒ latch, rc 1, no rename", async () => {
    const h = harness({ delCode: 403 });
    const r = await dedup("grok-box-8", h.deps);
    expect(r.rc).toBe(1);
    expect(h.ctx.readonly).toBe(true);
    expect(h.calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("rename fails ⇒ latch, rc 1", async () => {
    const h = harness({ renCode: 500 });
    const r = await dedup("grok-box-8", h.deps);
    expect(r.rc).toBe(1);
    expect(h.ctx.readonly).toBe(true);
  });
});
