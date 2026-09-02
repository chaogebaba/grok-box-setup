// tick-snapshot.test.ts — the TICK writes its snapshot into the store, and the
// API reads it back out (blueprint fleet2-state-store D3/D4, Phase B).
//
// The two halves of the swap meet here: `runReconcile` records a tick, and the
// same handlers that used to read `history/<day>.jsonl` serve it. Everything
// between is the round-trip already covered in snapshots.test.ts; what this file
// proves is that the WIRING carries the tick ordinal and the `observed` label
// through, and that the retention DELETE runs once per tick.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runReconcile, type ReconcileDeps } from "../../src/reconcile/run.ts";
import { RunContext, TailscaleKeys, type KeyTransport } from "../../src/reconcile/tailscale-keys.ts";
import type { ManagedSource } from "../../src/actions/config-push.ts";
import type { UpgradeDeps } from "../../src/upgrade.ts";
import { openStore, storePath, type Store } from "../../src/store/db.ts";
import { StoreState } from "../../src/store/state.ts";
import { observedFor, readLatestMeta, readLatestSnapshot, writeSnapshot } from "../../src/store/snapshots.ts";
import { SNAPSHOT_RETENTION_DAYS } from "../../src/store/schema.ts";
import { handleBox, handleFleet, handleHistory } from "../../src/serve/handlers.ts";
import { FakeRunner, result } from "../fake-runner.ts";
import { testEnv, testRollout } from "../helpers.ts";
import { setLogSink } from "../../src/log.ts";
import { cleanup, suiteScratch } from "./helpers.ts";

// This file's own scratch bucket; dropped whole when the file finishes.
const SCRATCH = suiteScratch("tick-snapshot");
afterAll(() => SCRATCH.clean());

const NOW = 1_780_000_000;
const dirs: string[] = [];
let prevSink: (l: string) => void;
beforeEach(() => {
  prevSink = setLogSink(() => {});
});
afterEach(() => {
  setLogSink(prevSink);
  for (const d of dirs.splice(0)) cleanup(d);
});

const noManaged: ManagedSource & { present: false } = {
  present: false,
  fleetToml: () => undefined,
  boxToml: () => undefined,
};

/** A tick wired to a REAL store, with the production snapshot hook. */
function tickDeps(
  store: Store,
  fleetState: string,
  over: Partial<ReconcileDeps> = {},
): ReconcileDeps {
  const ctx = new RunContext();
  const transport: KeyTransport = { async request() { return { code: 200, body: '{"devices":[]}' }; } };
  return {
    runner: new FakeRunner(() => result({ stdout: "" })), // every tunnel down
    env: testEnv({ FLEET_STATE: fleetState }),
    rollout: testRollout(),
    // The production tick's state IS the store, so `bumpTick` persists in
    // `engine` and consecutive ticks get consecutive ordinals.
    state: new StoreState(store),
    store,
    keys: new TailscaleKeys(transport, "https://api", "-", "PAT", ctx),
    ctx,
    notify: () => {},
    targetBoxes: [],
    configCanary: undefined,
    managedSource: noManaged,
    managedFilesPresent: false,
    upgradeDeps: {} as UpgradeDeps,
    targetSha: "abc1234",
    targetVersion: "5.9.0",
    apply: true,
    nowSec: NOW,
    history: (line, c) =>
      writeSnapshot(store, {
        tick: c.tick,
        line,
        observed: c.observed,
        target: { ref: "main", sha: "abc1234", version: "5.9.0" },
      }),
    ...over,
  };
}

function fixture(): { dir: string; state: string; store: Store } {
  const dir = SCRATCH.dir("tick-snap");
  dirs.push(dir);
  const state = `${dir}/state`;
  const store = openStore({ path: storePath(state), dir: state, now: () => NOW });
  return { dir, state, store };
}

describe("the tick records its snapshot in the store", () => {
  test("an empty fleet still records a tick, with the resolved target beside it", async () => {
    const f = fixture();
    const r = await runReconcile(tickDeps(f.store, f.state));
    expect(r.rc).toBe(0);
    const line = readLatestSnapshot(f.store)!;
    expect(line.boxes).toEqual([]);
    expect(line.apply).toBe(true);
    expect(line.ts).toBe(new Date(NOW * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));
    // the three target_* columns are stored but stay OFF the line
    expect(readLatestMeta(f.store)!.target).toEqual({ ref: "main", sha: "abc1234", version: "5.9.0" });
    expect(JSON.stringify(line)).not.toContain("abc1234");
    f.store.close();
  });

  test("a tunnel-down member the API says is offline is recorded as `asleep`, keyed by the tick ordinal", async () => {
    const f = fixture();
    const st = new StoreState(f.store);
    st.recordEnrolled("grok-box-008", 20008, "AAAAKEY");
    const deps = tickDeps(f.store, f.state, { targetBoxes: ["grok-box-008"] });
    await runReconcile(deps);

    const line = readLatestSnapshot(f.store)!;
    expect(line.boxes.map((b) => `${b.name}:${b.tunnel}:${b.check}`)).toEqual(["grok-box-008:down:-"]);
    // The devices GET returns an EMPTY device list, so the API says the box is
    // NOT online while the tunnel is down: both paths dead, which the decision
    // table calls row-`alert-asleep` and `observe` therefore names `asleep`.
    // `unhealthy` would be the wrong word — there is nothing to be unhealthy
    // about a box that is simply gone.
    expect(observedFor(f.store, "grok-box-008")).toBe("asleep");
    // The snapshot is keyed by the tick ordinal the engine bumped.
    const tick = (f.store.db.query("SELECT tick FROM snapshots").get() as { tick: number }).tick;
    expect(tick).toBe(st.currentTick());
    f.store.close();
  });

  test("two ticks are two snapshots; the newest wins every read", async () => {
    const f = fixture();
    await runReconcile(tickDeps(f.store, f.state));
    await runReconcile(tickDeps(f.store, f.state, { nowSec: NOW + 300 }));
    expect((f.store.db.query("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number }).n).toBe(2);
    expect(readLatestSnapshot(f.store)!.ts).toBe(
      new Date((NOW + 300) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    );
    f.store.close();
  });

  test("the 92-day retention runs once per tick", async () => {
    const f = fixture();
    // A snapshot older than the window, written directly.
    writeSnapshot(f.store, {
      tick: 1,
      line: {
        v: 1,
        ts: new Date((NOW - (SNAPSHOT_RETENTION_DAYS + 1) * 86400) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        apply: true,
        canary: null,
        boxes: [],
      },
      observed: new Map(),
    });
    await runReconcile(tickDeps(f.store, f.state));
    // Exactly one snapshot survives, and it is THIS tick's — the stale one was
    // deleted by the retention DELETE the tick runs before it records.
    const rows = f.store.db.query("SELECT ts FROM snapshots").all() as Array<{ ts: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ts).toBe(NOW);
    f.store.close();
  });
});

describe("the API reads the store, and degrades to the 5.8.0 answer without one", () => {
  /** A minimal ServerContext for the readonly handlers. */
  function ctxFor(fleetState: string): Parameters<typeof handleFleet>[0] {
    return {
      env: testEnv({ FLEET_STATE: fleetState, FLEET_CONFIG: `${fleetState}/no-such-config.toml` }),
      now: () => new Date(NOW * 1000),
    } as unknown as Parameters<typeof handleFleet>[0];
  }

  test("GET /v1/boxes/:name carries `phase` and `observed`", async () => {
    const f = fixture();
    const st = new StoreState(f.store);
    st.recordEnrolled("grok-box-008", 20008, "AAAAKEY");
    await runReconcile(tickDeps(f.store, f.state, { targetBoxes: ["grok-box-008"] }));
    f.store.close();

    const body = (await handleBox(ctxFor(f.state), "grok-box-008").json()) as {
      phase: string | null;
      observed: string | null;
      box: { tunnel: string } | null;
    };
    expect(body.phase).toBe("enrolled");
    expect(body.observed).toBe("asleep");
    expect(body.box!.tunnel).toBe("down");
  });

  test("a RETIRED box still answers, with its phase — the row is the history", async () => {
    const f = fixture();
    const st = new StoreState(f.store);
    st.recordEnrolled("grok-box-008", 20008, "AAAAKEY");
    await runReconcile(tickDeps(f.store, f.state, { targetBoxes: ["grok-box-008"] }));
    st.transition("grok-box-008", "enrolled", "retired", "operator");
    f.store.close();

    const body = (await handleBox(ctxFor(f.state), "grok-box-008").json()) as { phase: string; observed: string };
    expect(body.phase).toBe("retired");
    // the label is the last tick's reading, which is exactly what history means
    expect(body.observed).toBe("asleep");
  });

  test("GET /v1/history serves the store slice, newest-first", async () => {
    const f = fixture();
    const st = new StoreState(f.store);
    st.recordEnrolled("grok-box-008", 20008, "AAAAKEY");
    await runReconcile(tickDeps(f.store, f.state, { targetBoxes: ["grok-box-008"] }));
    await runReconcile(tickDeps(f.store, f.state, { targetBoxes: ["grok-box-008"], nowSec: NOW + 300 }));
    f.store.close();

    const body = (await handleHistory(ctxFor(f.state), "grok-box-008", 24).json()) as {
      lines: Array<{ ts: string }>;
    };
    expect(body.lines).toHaveLength(2);
    expect(body.lines[0]!.ts > body.lines[1]!.ts).toBe(true);
    // a box that was never recorded has no history, and that is not an error
    const none = (await handleHistory(ctxFor(f.state), "grok-box-404", 24).json()) as { lines: unknown[] };
    expect(none.lines).toEqual([]);
  });

  test("with NO store at all the readonly endpoints answer exactly as they did with an empty history/", async () => {
    const dir = SCRATCH.dir("tick-snap-empty");
    dirs.push(dir);
    const fleet = (await handleFleet(ctxFor(dir), { scope: "readonly", name: "t" } as never).json()) as {
      snapshot_ts: string | null;
      boxes: unknown[];
      discover: unknown;
    };
    expect(fleet.snapshot_ts).toBeNull();
    expect(fleet.boxes).toEqual([]);
    expect(fleet.discover).toBeNull();
    const box = (await handleBox(ctxFor(dir), "grok-box-008").json()) as { phase: null; observed: null; box: null };
    expect(box.box).toBeNull();
    expect(box.phase).toBeNull();
    expect(box.observed).toBeNull();
  });
});
