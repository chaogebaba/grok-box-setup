// fleet-merge.test.ts — §7 snapshot-vs-marker merge (mutant: drop the live-marker
// override, or let probe fields be overridden). GET /v1/fleet = the newest
// SNAPSHOT + live markers; live markers (checkfail/asleep/expiry) OVERRIDE the
// snapshot copies, probe-derived fields (tunnel/check/ver/drift/config) come
// from the snapshot ONLY. Uses a real FLEET_STATE under the worker scratch.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { makeFetch } from "../../src/serve/server.ts";
import { fakeContext, getReq, seedBoxRow, seedSnapshots } from "./helpers.ts";
import { suiteScratch } from "../store/helpers.ts";
import type { SnapshotLine } from "../../src/history/schema.ts";
import { setLogSink } from "../../src/log.ts";

// This file's own scratch bucket; dropped whole when the file finishes.
const SCRATCH = suiteScratch("fleet-merge");
afterAll(() => SCRATCH.clean());

let dirs: string[] = [];
let restore: (l: string) => void;
beforeEach(() => {
  restore = setLogSink(() => {});
});
afterEach(() => {
  setLogSink(restore);
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/**
 * state-store D3: the snapshot lives in the STORE, and so do the "live markers"
 * the fleet response merges over it — they have been store columns since 5.8.0.
 * A test that used to drop a daily jsonl plus `<box>.checkfail` files now seeds
 * both through the store.
 */
function stateWith(line: SnapshotLine, markers: Record<string, Parameters<typeof seedBoxRow>[2]> = {}): string {
  const s = SCRATCH.dir("grokfleet-merge");
  dirs.push(s);
  for (const [name, m] of Object.entries(markers)) seedBoxRow(s, name, m);
  seedSnapshots(s, [line]);
  return s;
}

async function ctxFor(state: string, enrolled: string[]) {
  const c = await fakeContext({ enrolled });
  // point the context at the real tmp state (fakeContext used a nonexistent one).
  (c as { env: { FLEET_STATE: string } }).env.FLEET_STATE = state;
  // and at a config path that does NOT exist, so these merge cases stay about
  // the snapshot/marker merge and never depend on a real /opt/grok-fleet.
  (c as { env: { FLEET_CONFIG: string } }).env.FLEET_CONFIG = join(state, "no-such-config.toml");
  return c;
}

describe("GET /v1/fleet snapshot + live-marker merge", () => {
  test("live *.checkfail / *.asleep override the snapshot copies", async () => {
    const line: SnapshotLine = {
      v: 1,
      ts: "2026-04-01T00:00:00Z",
      apply: false,
      canary: "grok-box-1",
      boxes: [
        { name: "grok-box-1", tunnel: "up", check: "OK", ver: "5.3.0", drift: "no", config: "in-sync", checkfail: false, asleep: false, expiry_days: 40 },
      ],
    };
    // live markers say the box is now checkfailing AND asleep (snapshot said not).
    const state = stateWith(line, {
      "grok-box-1": { checkfail: 2, asleep: { since: 1700000000, last: 0 } },
    });
    const ctx = await ctxFor(state, ["grok-box-1"]);
    (ctx as { now?: () => Date }).now = () => new Date("2026-04-01T00:05:00Z");
    const fetch = makeFetch(ctx);
    const r = await fetch(getReq("/v1/fleet", "READSECRET"));
    const body = await r.json();
    const b = body.boxes[0];
    // live markers WIN.
    expect(b.checkfail).toBe(true);
    expect(b.asleep).toBe(true);
    // probe-derived fields come from the SNAPSHOT (never overridden).
    expect(b.check).toBe("OK");
    expect(b.ver).toBe("5.3.0");
    expect(b.config).toBe("in-sync");
    expect(b.drift).toBe("no");
    // snapshot_ts + scope surfaced.
    expect(body.snapshot_ts).toBe("2026-04-01T00:00:00Z");
    expect(body.scope).toBe("readonly");
  });

  test("no markers ⇒ snapshot copies pass through unchanged", async () => {
    const line: SnapshotLine = {
      v: 1,
      ts: "2026-04-02T00:00:00Z",
      apply: true,
      canary: null,
      boxes: [
        { name: "grok-box-1", tunnel: "down", check: "-", ver: "-", drift: "unknown", config: null, checkfail: false, asleep: false, expiry_days: null },
      ],
    };
    const state = stateWith(line);
    const ctx = await ctxFor(state, ["grok-box-1"]);
    (ctx as { now?: () => Date }).now = () => new Date("2026-04-02T00:05:00Z");
    const fetch = makeFetch(ctx);
    const body = await (await fetch(getReq("/v1/fleet", "ADMINSECRET"))).json();
    expect(body.boxes[0].checkfail).toBe(false);
    expect(body.boxes[0].config).toBeNull();
    // R2: `apply` is read LIVE; ctxFor points FLEET_CONFIG at nothing, so the
    // snapshot value stands and the response SAYS so (see fleet-apply-live).
    expect(body.apply).toBe(true);
    expect(body.apply_source).toBe("snapshot");
  });

  test("GET /v1/health tick_age_s derives from the newest snapshot ts", async () => {
    const line: SnapshotLine = {
      v: 1, ts: "2026-04-03T00:00:00Z", apply: false, canary: null, boxes: [],
    };
    const state = stateWith(line);
    const ctx = await ctxFor(state, []);
    // pin the clock 90s after the snapshot ts.
    (ctx as { now?: () => Date }).now = () => new Date("2026-04-03T00:01:30Z");
    const fetch = makeFetch(ctx);
    const body = await (await fetch(getReq("/v1/health"))).json();
    expect(body.tick_age_s).toBe(90);
  });

  test("GET /v1/health with NO snapshot ⇒ tick_age_s null", async () => {
    const s = SCRATCH.dir("grokfleet-merge");
    dirs.push(s);
    const ctx = await ctxFor(s, []);
    const fetch = makeFetch(ctx);
    const body = await (await fetch(getReq("/v1/health"))).json();
    expect(body.tick_age_s).toBeNull();
  });
});
