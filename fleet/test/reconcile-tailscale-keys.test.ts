// T2 (latch) + D7 — Tailscale key/device mutation surface. FakeApi records the
// method+url+body sequence; asserts endpoints/bodies verbatim, clamp, expires
// normalisation, 2xx/404 semantics, and the run-wide READ-ONLY latch.

import { test, expect, describe } from "bun:test";
import {
  TailscaleKeys,
  RunContext,
  clampExpirySecs,
  mintPayload,
  normalizeExpires,
  type KeyTransport,
} from "../src/reconcile/tailscale-keys.ts";

interface Call {
  method: string;
  url: string;
  body?: string;
}

function fakeApi(responder: (c: Call) => { code: number; body: string }): {
  transport: KeyTransport;
  calls: Call[];
} {
  const calls: Call[] = [];
  const transport: KeyTransport = {
    async request(method, url, _headers, _timeoutMs, body) {
      calls.push({ method, url, body });
      return responder({ method, url, body });
    },
  };
  return { transport, calls };
}

const BASE = "https://api.tailscale.com/api/v2";
const TN = "-";

function mk(responder: (c: Call) => { code: number; body: string }) {
  const { transport, calls } = fakeApi(responder);
  const ctx = new RunContext();
  const keys = new TailscaleKeys(transport, BASE, TN, "SECRET-PAT", ctx);
  return { keys, ctx, calls };
}

describe("clamp + payload + expires", () => {
  test("clampExpirySecs [1, 7776000]", () => {
    expect(clampExpirySecs(7776000)).toBe(7776000);
    expect(clampExpirySecs(9999999)).toBe(7776000); // over cap ⇒ clamp down
    expect(clampExpirySecs(0)).toBe(7776000); // <=0 ⇒ default
    expect(clampExpirySecs(-5)).toBe(7776000);
    expect(clampExpirySecs("abc")).toBe(7776000);
    expect(clampExpirySecs(undefined)).toBe(7776000);
    expect(clampExpirySecs(3600)).toBe(3600);
  });
  test("mintPayload is the exact capabilities shape (main:1520-1526)", () => {
    const p = JSON.parse(mintPayload(7776000));
    expect(p).toEqual({
      capabilities: { devices: { create: { reusable: true, ephemeral: false, preauthorized: true, tags: ["tag:grok-box"] } } },
      expirySeconds: 7776000,
    });
  });
  test("normalizeExpires: first 10 chars, +90d fallback", () => {
    expect(normalizeExpires("2026-11-27T12:00:00Z", () => "FALLBACK")).toBe("2026-11-27");
    expect(normalizeExpires("garbage", () => "FALLBACK")).toBe("FALLBACK");
    expect(normalizeExpires(undefined, () => "FALLBACK")).toBe("FALLBACK");
  });
});

describe("createKey", () => {
  test("POST /tailnet/-/keys with clamped body; parses key/id/expires", async () => {
    const { keys, calls, ctx } = mk(() => ({
      code: 200,
      body: JSON.stringify({ key: "tskey-abc", id: "kID", expires: "2026-11-27T00:00:00Z" }),
    }));
    const r = await keys.createKey(7776000);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${BASE}/tailnet/${TN}/keys`);
    expect(JSON.parse(calls[0]!.body!).expirySeconds).toBe(7776000);
    expect(r.key).toBe("tskey-abc");
    expect(r.id).toBe("kID");
    expect(r.expires).toBe("2026-11-27");
    expect(ctx.readonly).toBe(false);
  });

  test("m14: an over-max expiry is clamped at the createKey call site (POST body = 7776000)", async () => {
    // The mint call site (createKey) MUST clamp via clampExpirySecs. Passing an
    // over-max value proves the clamp runs HERE, not just in the pure helper: if
    // the call-site clamp is bypassed (m14) the POST body carries 9999999.
    const { keys, calls } = mk(() => ({
      code: 200,
      body: JSON.stringify({ key: "tskey-abc", id: "kID", expires: "2026-11-27T00:00:00Z" }),
    }));
    await keys.createKey(9999999); // > FLEET_KEY_EXPIRY_MAX (7776000)
    expect(JSON.parse(calls[0]!.body!).expirySeconds).toBe(7776000);
  });

  test("non-2xx ⇒ latch + undefined fields", async () => {
    const { keys, ctx } = mk(() => ({ code: 500, body: "" }));
    const r = await keys.createKey(7776000);
    expect(r.code).toBe(500);
    expect(r.key).toBeUndefined();
    expect(r.id).toBeUndefined();
    expect(ctx.readonly).toBe(true); // B-1 latch
  });

  test("2xx without .key ⇒ key undefined (no latch)", async () => {
    const { keys, ctx } = mk(() => ({ code: 200, body: JSON.stringify({ id: "kID" }) }));
    const r = await keys.createKey(7776000);
    expect(r.key).toBeUndefined();
    expect(r.id).toBe("kID");
    expect(ctx.readonly).toBe(false);
  });

  test("2xx without .id ⇒ id undefined (no latch)", async () => {
    const { keys, ctx } = mk(() => ({ code: 200, body: JSON.stringify({ key: "tskey-x" }) }));
    const r = await keys.createKey(7776000);
    expect(r.key).toBe("tskey-x");
    expect(r.id).toBeUndefined();
    expect(ctx.readonly).toBe(false);
  });
});

describe("deleteKey (revoke) — 2xx or 404 ok", () => {
  test("DELETE /keys/<id>; 200 ok, 404 ok, 500 not ok", async () => {
    for (const [code, ok] of [
      [200, true],
      [404, true],
      [500, false],
    ] as const) {
      const { keys, calls } = mk(() => ({ code, body: "" }));
      const r = await keys.deleteKey("kOLD");
      expect(calls[0]!.method).toBe("DELETE");
      expect(calls[0]!.url).toBe(`${BASE}/tailnet/${TN}/keys/kOLD`);
      expect(r.ok).toBe(ok);
    }
  });
});

describe("deleteDevice + renameDevice (dedup) — latch on failure", () => {
  test("deleteDevice DELETE /device/<id>; latches on non-2xx", async () => {
    const { keys, calls, ctx } = mk(() => ({ code: 200, body: "" }));
    const r = await keys.deleteDevice("STALE");
    expect(calls[0]!.url).toBe(`${BASE}/device/STALE`);
    expect(r.ok).toBe(true);
    expect(ctx.readonly).toBe(false);

    const bad = mk(() => ({ code: 403, body: "" }));
    await bad.keys.deleteDevice("STALE");
    expect(bad.ctx.readonly).toBe(true);
  });

  test("renameDevice POST /device/<id>/name {name:box}; latches on non-2xx", async () => {
    const { keys, calls, ctx } = mk(() => ({ code: 200, body: "" }));
    const r = await keys.renameDevice("LIVE", "grok-box-8");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`${BASE}/device/LIVE/name`);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ name: "grok-box-8" });
    expect(r.ok).toBe(true);
    expect(ctx.readonly).toBe(false);

    const bad = mk(() => ({ code: 500, body: "" }));
    await bad.keys.renameDevice("LIVE", "grok-box-8");
    expect(bad.ctx.readonly).toBe(true);
  });
});

describe("T2 latch is run-wide and irreversible", () => {
  test("once latched by any failed call it stays latched", async () => {
    const ctx = new RunContext();
    expect(ctx.readonly).toBe(false);
    ctx.latch();
    expect(ctx.readonly).toBe(true);
    ctx.latch();
    expect(ctx.readonly).toBe(true);
  });

  test("token never appears in a URL", async () => {
    const { keys, calls } = mk(() => ({ code: 200, body: "{}" }));
    await keys.getDevices();
    expect(calls[0]!.url.includes("SECRET-PAT")).toBe(false);
  });
});
