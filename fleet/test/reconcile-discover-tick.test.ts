// reconcile-discover-tick.test.ts — zero-touch join D1/D5/D7 INSIDE the tick.
//
// Placement is a decision in its own right, so it is tested through the real
// runReconcile: adopt before the membership loop AND before the empty-membership
// early return; the hysteresis marker written at the row-e evaluation inside the
// loop; repair after the loop and BEFORE the snapshot; the summary reaching the
// snapshot line and GET /v1/fleet.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReconcile, type ReconcileDeps } from "../src/reconcile/run.ts";
import { ReconcileState, type StateFs } from "../src/reconcile/state.ts";
import { RunContext, TailscaleKeys, type KeyTransport } from "../src/reconcile/tailscale-keys.ts";
import type { DiscoverDeps } from "../src/reconcile/discover.ts";
import { FakeRunner, result } from "./fake-runner.ts";
import { testEnv, testRollout } from "./helpers.ts";
import { setLogSink } from "../src/log.ts";
import type { ManagedSource } from "../src/actions/config-push.ts";
import type { UpgradeDeps } from "../src/upgrade.ts";
import type { SnapshotLine } from "../src/history/schema.ts";
import { makeFetch } from "../src/serve/server.ts";
import { fakeContext, getReq } from "./serve/helpers.ts";

let logs: string[] = [];
let prevSink: (l: string) => void;
const dirs: string[] = [];
beforeEach(() => {
  logs = [];
  prevSink = setLogSink((l) => logs.push(l));
});
afterEach(() => {
  setLogSink(prevSink);
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function memState(): { state: ReconcileState; store: Map<string, string> } {
  const store = new Map<string, string>();
  const fs: StateFs = {
    read: (p) => store.get(p),
    write: (p, d) => store.set(p, d),
    remove: (p) => store.delete(p),
    mkdirp: () => {},
    chmod: () => {},
    rename: () => {},
    exists: (p) => store.has(p),
    tmpname: (d, p) => `${d}/${p}x`,
  };
  return { state: new ReconcileState("/s", fs), store };
}

const noManaged: ManagedSource & { present: false } = {
  present: false,
  fleetToml: () => undefined,
  boxToml: () => undefined,
};

interface Trace {
  order: string[];
  adopts: string[];
  inspects: string[];
}

function traceDeps(trace: Trace, over: Partial<DiscoverDeps> = {}): DiscoverDeps {
  return {
    apiToken: true,
    boxPassword: "pw",
    async listPeers() {
      trace.order.push("listPeers");
      return [{ index: 3, name: "grok-box-003", ip: "100.64.0.1", online: "yes" }];
    },
    async probe() {
      trace.order.push("probe");
      return { reachable: true, hostname: "", boxup: "5.3.0" };
    },
    async adopt(box) {
      trace.order.push(`adopt:${box}`);
      trace.adopts.push(box);
      return { rc: 0 };
    },
    async inspect(box) {
      trace.order.push(`inspect:${box}`);
      trace.inspects.push(box);
      return { ok: true, coherent: false, reason: "[fleet] block missing" };
    },
    ...over,
  };
}

function baseDeps(over: Partial<ReconcileDeps>): { deps: ReconcileDeps; lines: SnapshotLine[]; state: ReconcileState } {
  const { state } = memState();
  const transport: KeyTransport = { async request() { return { code: 200, body: '{"devices":[]}' }; } };
  const ctx = new RunContext();
  const lines: SnapshotLine[] = [];
  const deps: ReconcileDeps = {
    runner: new FakeRunner(() => result({ stdout: "" })), // tunnels down
    env: testEnv(),
    rollout: testRollout(),
    state,
    keys: new TailscaleKeys(transport, "https://api", "-", "PAT", ctx),
    ctx,
    notify: () => {},
    targetBoxes: [],
    configCanary: undefined,
    managedSource: noManaged,
    managedFilesPresent: false,
    upgradeDeps: {} as UpgradeDeps,
    targetSha: undefined,
    targetVersion: undefined,
    apply: true,
    nowSec: 1_000_000,
    history: (l) => lines.push(l),
    ...over,
  };
  return { deps, lines, state: deps.state };
}

describe("D1 placement inside the tick", () => {
  test("adopt runs BEFORE the empty-membership early return (a brand-new VPS still adopts)", async () => {
    const trace: Trace = { order: [], adopts: [], inspects: [] };
    const { deps, lines } = baseDeps({ targetBoxes: [], discover: traceDeps(trace) });
    const r = await runReconcile(deps);
    expect(r.rc).toBe(0);
    expect(trace.adopts).toEqual(["grok-box-003"]);
    expect(logs.some((l) => l.includes("no enrolled boxes"))).toBe(true);
    // and the early-return snapshot still carries the summary.
    expect(lines[0]!.discover).toEqual({ candidates: 1, adopted: 1, repaired: 0, skipped: [] });
  });

  test("repair runs AFTER the membership loop and before the snapshot is written", async () => {
    const trace: Trace = { order: [], adopts: [], inspects: [] };
    // A box the API says is ONLINE with the tunnel DOWN ⇒ row e incoherent.
    const online = JSON.stringify({
      devices: [{ hostname: "grok-box-008", id: "1", online: true, lastSeen: "2999-01-01T00:00:00Z" }],
    });
    const transport: KeyTransport = { async request() { return { code: 200, body: online }; } };
    const ctx = new RunContext();
    const notes: string[] = [];
    const { deps, lines, state } = baseDeps({
      targetBoxes: ["grok-box-008"],
      discover: traceDeps(trace, { async listPeers() { trace.order.push("listPeers"); return []; } }),
      keys: new TailscaleKeys(transport, "https://api", "-", "PAT", ctx),
      ctx,
      notify: (lvl, msg) => { notes.push(`${lvl}: ${msg}`); },
    });

    // Tick 1: the condition holds once ⇒ marker 1, no repair.
    await runReconcile(deps);
    expect(state.readRepairPending("grok-box-008")).toEqual({ runs: 1, tick: 1 });
    expect(trace.inspects).toEqual([]);

    // Tick 2: the condition holds again ⇒ marker 2 stamped by THIS tick ⇒ repair.
    await runReconcile(deps);
    expect(state.readRepairPending("grok-box-008")).toEqual({ runs: 2, tick: 2 });
    expect(trace.inspects).toEqual(["grok-box-008"]);
    expect(trace.adopts).toEqual(["grok-box-008"]);
    expect(lines[1]!.discover!.repaired).toBe(1); // repair completed BEFORE writeSnapshot
    expect(logs.some((l) => l.includes("repair: grok-box-008 repaired"))).toBe(true);
    // D5: repair does NOT suppress the row-e alert — alertIncoherent notifies at
    // n >= 2, i.e. on this very tick, alongside the repair line.
    expect(notes.some((n) => n.includes("incoherent-both-dead"))).toBe(true);
    expect(state.bumpIncoherent("grok-box-008")).toBe(3); // the counter kept running
  });

  test("the marker RESETS on a tick where the incoherent condition does not hold", async () => {
    const trace: Trace = { order: [], adopts: [], inspects: [] };
    const online = JSON.stringify({
      devices: [{ hostname: "grok-box-008", id: "1", online: true, lastSeen: "2999-01-01T00:00:00Z" }],
    });
    let body = online;
    const transport: KeyTransport = { async request() { return { code: 200, body }; } };
    const ctx = new RunContext();
    const { deps, state } = baseDeps({
      targetBoxes: ["grok-box-008"],
      discover: traceDeps(trace, { async listPeers() { return []; } }),
      keys: new TailscaleKeys(transport, "https://api", "-", "PAT", ctx),
      ctx,
    });
    await runReconcile(deps);
    expect(state.readRepairPending("grok-box-008")!.runs).toBe(1);
    // The box goes to sleep (absent from the device list) ⇒ row e says asleep.
    body = '{"devices":[]}';
    await runReconcile(deps);
    expect(state.readRepairPending("grok-box-008")).toEqual({ runs: 0, tick: 2 });
    expect(trace.inspects).toEqual([]);
  });

  test("no discover deps ⇒ no discovery and NO `discover` field (D6e / hermetic ticks)", async () => {
    const { deps, lines } = baseDeps({ targetBoxes: [] });
    await runReconcile(deps);
    expect(lines[0]!.discover).toBeUndefined();
  });
});

describe("D7 the summary reaches GET /v1/fleet", () => {
  test("handleFleet names `discover` explicitly, and answers null for an older line", async () => {
    const withDiscover: SnapshotLine = {
      v: 1,
      ts: "2026-09-01T00:00:00Z",
      apply: true,
      canary: null,
      boxes: [],
      discover: { candidates: 2, adopted: 1, repaired: 0, skipped: [{ name: "grok-box-004", reason: "unreachable" }] },
    };
    const state = mkdtempSync(join(tmpdir(), "fleet2-disc-"));
    dirs.push(state);
    mkdirSync(join(state, "history"), { recursive: true });
    writeFileSync(join(state, "history", "2026-09-01.jsonl"), JSON.stringify(withDiscover) + "\n");
    const ctx = await fakeContext({ enrolled: [] });
    (ctx as { env: { FLEET_STATE: string } }).env.FLEET_STATE = state;
    (ctx as { env: { FLEET_CONFIG: string } }).env.FLEET_CONFIG = join(state, "nope.toml");
    (ctx as { now?: () => Date }).now = () => new Date("2026-09-01T00:05:00Z");
    const fetch = makeFetch(ctx);
    const r = await fetch(getReq("/v1/fleet", "READSECRET"));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { discover: unknown };
    expect(body.discover).toEqual(withDiscover.discover);

    // A pre-5.6.0 line has no such field: the response says null, never throws.
    const older: SnapshotLine = { v: 1, ts: "2026-09-01T00:01:00Z", apply: true, canary: null, boxes: [] };
    writeFileSync(join(state, "history", "2026-09-01.jsonl"), JSON.stringify(older) + "\n");
    const r2 = await fetch(getReq("/v1/fleet", "READSECRET"));
    expect(((await r2.json()) as { discover: unknown }).discover).toBeNull();
  });
});
