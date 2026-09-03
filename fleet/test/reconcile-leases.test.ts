// reconcile-leases.test.ts — what the TICK does about leases (blueprint
// fleet2-lease-api L3/L7).
//
// The store is REAL (in-memory sqlite) because the whole point of L3 is the
// interaction between the tick and the `leases` rows; everything else — the
// runner, the Tailscale API, the marker state — is the existing fake harness.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runReconcile, LEASE_DEFERRED_ACTIONS, type ReconcileDeps } from "../src/reconcile/run.ts";
import { LeaseTick, CANARY_SKIP_THRESHOLD } from "../src/reconcile/lease-tick.ts";
import { ReconcileState, type StateFs } from "../src/reconcile/state.ts";
import { RunContext, TailscaleKeys, type KeyTransport } from "../src/reconcile/tailscale-keys.ts";
import { FakeRunner, result, isSs } from "./fake-runner.ts";
import { testEnv, testRollout } from "./helpers.ts";
import { CHECK_COMMAND } from "../src/remote.ts";
import { setLogSink } from "../src/log.ts";
import type { ManagedSource } from "../src/actions/config-push.ts";
import type { UpgradeDeps } from "../src/upgrade.ts";
import type { NotifyLevel } from "../src/notify.ts";
import { openStore, type Store } from "../src/store/db.ts";
import { StoreState } from "../src/store/state.ts";
import { acquireLease, listLeases, type LeaseRow } from "../src/store/leases.ts";
import { writeSnapshot } from "../src/store/snapshots.ts";
import type { Observed } from "../src/reconcile/observe.ts";

const NOW = 1_000_000;

let logs: string[] = [];
let prev: (l: string) => void;
beforeEach(() => {
  logs = [];
  prev = setLogSink((l) => logs.push(l));
});
afterEach(() => setLogSink(prev));

function memFs(): StateFs {
  const store = new Map<string, string>();
  return {
    read: (p) => store.get(p),
    write: (p, d) => store.set(p, d),
    remove: (p) => store.delete(p),
    mkdirp: () => {},
    chmod: () => {},
    rename: (f, t) => {
      const v = store.get(f);
      if (v !== undefined) {
        store.set(t, v);
        store.delete(f);
      }
    },
    exists: (p) => store.has(p),
    tmpname: (d, p) => `${d}/${p}x`,
  };
}

const noManaged: ManagedSource & { present: false } = {
  present: false,
  fleetToml: () => undefined,
  boxToml: () => undefined,
};

function fakeKeys(body: string): { keys: TailscaleKeys; ctx: RunContext } {
  const transport: KeyTransport = { async request() { return { code: 200, body }; } };
  const ctx = new RunContext();
  return { keys: new TailscaleKeys(transport, "https://api", "-", "PAT", ctx), ctx };
}

/** A store with the given boxes enrolled. */
function leaseStore(boxes: string[]): { store: Store; state: StoreState } {
  const store = openStore({ path: ":memory:", now: () => NOW });
  for (const name of boxes) {
    const idx = Number.parseInt(name.replace(/^\D+/, ""), 10);
    store.db
      .query("INSERT INTO boxes(name,idx,port,phase,created_at,updated_at) VALUES(?,?,?,'enrolled',?,?)")
      .run(name, idx, 20000 + idx, NOW, NOW);
  }
  return { store, state: new StoreState(store) };
}

function lease(store: Store, box: string, holder = "ci:runner-3", purpose = "gate"): LeaseRow {
  const id = (store.db.query("SELECT box_id FROM boxes WHERE name=?").get(box) as { box_id: number }).box_id;
  const r = acquireLease(store, { boxId: id, box, kind: "ephemeral", holder, purpose, now: NOW });
  if (!r.ok) throw new Error("fixture: acquire failed");
  return r.lease;
}

/** Record one snapshot row per box at `tick`, so the two-tick rules have history. */
function snapshotAt(store: Store, tick: number, observed: Record<string, Observed>): void {
  writeSnapshot(store, {
    tick,
    line: {
      v: 1,
      ts: new Date((NOW + tick) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      apply: true,
      canary: null,
      boxes: Object.keys(observed).map((name) => ({
        name,
        tunnel: "up" as const,
        check: "OK" as const,
        ver: "5.3.0",
        drift: "no" as const,
        config: null,
        checkfail: false,
        asleep: false,
        expiry_days: null,
      })),
    },
    observed: new Map(Object.entries(observed)),
  });
}

interface Harness {
  deps: ReconcileDeps;
  store: Store;
  state: StoreState;
  notes: Array<{ level: NotifyLevel; msg: string }>;
}

/**
 * One DRIFTED box (target version 5.3.1, box on 5.3.0), tunnel up, `boxup check`
 * healthy — the shape that produces a row-d `rollout` action and, with managed
 * files present, a config push.
 */
function harness(over: Partial<ReconcileDeps> = {}, boxes = ["grok-box-008"]): Harness {
  const devs = JSON.stringify({
    devices: boxes.map((hostname) => ({
      hostname,
      online: true,
      lastSeen: "2999-01-01T00:00:00Z",
      tags: ["t"],
      keyExpiryDisabled: true,
    })),
  });
  const { keys, ctx } = fakeKeys(devs);
  const runner = new FakeRunner((argv) => {
    if (isSs(argv)) {
      return result({
        stdout: boxes
          .map((b) => {
            const port = 20000 + Number.parseInt(b.replace(/^\D+/, ""), 10);
            return `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:* users:(("sshd",pid=41,fd=7))`;
          })
          .join("\n"),
      });
    }
    if ((argv[argv.length - 1] ?? "") === CHECK_COMMAND) {
      return result({ code: 0, stdout: "check=OK v=5.3.0/OLDSHA tunnel=up" });
    }
    return result({ code: 0, stdout: "sha=X cur=X support=yes enabled=true" });
  });
  const { store, state } = leaseStore(boxes);
  const notes: Array<{ level: NotifyLevel; msg: string }> = [];
  const notify = (level: NotifyLevel, msg: string): void => {
    notes.push({ level, msg });
  };
  const deps: ReconcileDeps = {
    runner,
    env: testEnv(),
    rollout: testRollout({ auto: false, canary: "grok-box-008" }),
    state: new ReconcileState("/s", memFs()),
    keys,
    ctx,
    notify,
    targetBoxes: boxes,
    configCanary: undefined,
    managedSource: noManaged,
    managedFilesPresent: false,
    upgradeDeps: {} as UpgradeDeps,
    targetSha: "NEWSHA",
    targetVersion: "5.3.1",
    apply: true,
    nowSec: NOW,
    leases: new LeaseTick({ store, state, notify }),
    // The production tick records ONE snapshot per run; the two-consecutive-tick
    // rules read exactly those rows, so the harness has to write them too.
    history: (line, hctx) => writeSnapshot(store, { tick: hctx.tick, line, observed: hctx.observed }),
    ...over,
  };
  return { deps, store, state, notes };
}

describe("L3 — the tick DEFERS a leased box's writes", () => {
  test("MUTANT (l2): `rollout` defers, `mint` does NOT — the set is exactly rollout", () => {
    expect([...LEASE_DEFERRED_ACTIONS]).toEqual(["rollout"]);
    for (const a of ["mint", "rotate", "delete-then-rename"]) {
      expect(LEASE_DEFERRED_ACTIONS.has(a)).toBe(false);
    }
  });

  test("a leased DRIFTED box gets ZERO rollout lines and ONE deferred line", async () => {
    const h = harness();
    lease(h.store, "grok-box-008");
    await runReconcile(h.deps);
    expect(logs.some((l) => l.includes("rollout: grok-box-008 deferred — leased by ci:runner-3 (gate)"))).toBe(true);
    expect(logs.some((l) => l.includes("WOULD rollout"))).toBe(false);
    expect(logs.some((l) => l.startsWith("reconcile: rollout "))).toBe(false);
  });

  test("without a lease the same fixture DOES roll (the control)", async () => {
    const h = harness();
    await runReconcile(h.deps);
    // The rollout pass RAN (auto=false ⇒ it logs the WOULD line for the set).
    expect(logs.some((l) => l.includes("WOULD rollout grok-box-008 5.3.0→5.3.1"))).toBe(true);
    expect(logs.some((l) => l.includes("deferred — leased"))).toBe(false);
  });

  test("mint is NOT deferred: an expiring key does not wait for a CI job", async () => {
    // A box the API says is OFFLINE with the tunnel up is row a (mint). We only
    // assert the lease gate does not swallow it.
    const h = harness({}, ["grok-box-008"]);
    lease(h.store, "grok-box-008");
    await runReconcile(h.deps);
    expect(logs.some((l) => l.includes("mint-key: grok-box-008 deferred — leased"))).toBe(false);
  });

  test("the config pass DEFERS a leased non-canary box", async () => {
    // The canary's tunnel is DOWN, so the pass falls through to the non-canary
    // loop without canary protection — which is where the lease gate lives.
    const src: ManagedSource = { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined };
    const h = harness(
      {
        managedSource: src,
        managedFilesPresent: true,
        configCanary: "grok-box-005",
        runner: new FakeRunner((argv) => {
          if (isSs(argv)) {
            return result({ stdout: 'LISTEN 0 128 127.0.0.1:20008 0.0.0.0:* users:(("sshd",pid=41,fd=7))\n' });
          }
          return result({ code: 0, stdout: "check=OK v=5.3.0/OLDSHA tunnel=up" });
        }),
      },
      ["grok-box-005", "grok-box-008"],
    );
    lease(h.store, "grok-box-008", "svc:proxy", "long-lived proxy");
    await runReconcile(h.deps);
    expect(logs.some((l) => l.includes("config-push: grok-box-008 deferred — leased by svc:proxy (long-lived proxy)"))).toBe(
      true,
    );
    // …and the pass really did complete without pushing to it.
    expect(logs.some((l) => l.includes("config: pass done (apply) ok=0 skipped=2 failed=0"))).toBe(true);
  });
});

describe("L3 — the canary rules, one per engine (r1-B4/r2-B4)", () => {
  test("MUTANT (l6): a LEASED rollout canary SKIPS the pass, never runs it canary-less", async () => {
    const h = harness({}, ["grok-box-005", "grok-box-008"]);
    lease(h.store, "grok-box-008", "ci:runner-3", "gate");
    await runReconcile(h.deps);
    expect(logs.some((l) => l.includes("rollout: canary grok-box-008 leased by ci:runner-3 — pass skipped"))).toBe(true);
    // …and the OTHER drifted box got no rollout at all.
    expect(logs.some((l) => l.includes("WOULD rollout grok-box-005"))).toBe(false);
  });

  test("three CONSECUTIVE skipped rollout passes fire the alert once", async () => {
    const h = harness({}, ["grok-box-005", "grok-box-008"]);
    lease(h.store, "grok-box-008");
    for (let i = 0; i < CANARY_SKIP_THRESHOLD; i++) await runReconcile(h.deps);
    const alerts = h.notes.filter((n) => n.msg.includes("rollout-canary-leased"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.level).toBe("warn");
    // A fourth skip inside 24h does NOT re-alert.
    await runReconcile(h.deps);
    expect(h.notes.filter((n) => n.msg.includes("rollout-canary-leased"))).toHaveLength(1);
  });

  test("a FIXED config canary that is leased skips the config pass and alerts after 3", async () => {
    const src: ManagedSource = { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined };
    const h = harness(
      { managedSource: src, managedFilesPresent: true, configCanary: "grok-box-005", rollout: testRollout({ canary: "grok-box-009" }) },
      ["grok-box-005", "grok-box-008"],
    );
    lease(h.store, "grok-box-005");
    for (let i = 0; i < CANARY_SKIP_THRESHOLD; i++) await runReconcile(h.deps);
    expect(logs.some((l) => l.includes("config: canary grok-box-005 leased — pass skipped"))).toBe(true);
    // The pass really did not push anywhere.
    expect(logs.some((l) => l.includes("config: pass done"))).toBe(false);
    expect(h.notes.filter((n) => n.msg.includes("config-canary-leased"))).toHaveLength(1);
  });

  test("the DYNAMIC config canary steps OVER a leased box to the next index", async () => {
    const src: ManagedSource = { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined };
    const h = harness(
      { managedSource: src, managedFilesPresent: true, configCanary: undefined, rollout: testRollout({ canary: "grok-box-009" }) },
      ["grok-box-005", "grok-box-008"],
    );
    lease(h.store, "grok-box-005");
    await runReconcile(h.deps);
    expect(logs.some((l) => l.includes("config: pass start (apply) — canary-first over tunnels (canary=grok-box-008)"))).toBe(
      true,
    );
  });
});

/** Tunnel UP, `boxup check` FAILING — the tuple `observe()` names `unhealthy`
 *  (a DOWN tunnel with the API saying online is `incoherent`, a different arm). */
function unhealthyRunner(): FakeRunner {
  return new FakeRunner((argv) => {
    if (isSs(argv)) {
      return result({ stdout: 'LISTEN 0 128 127.0.0.1:20008 0.0.0.0:* users:(("sshd",pid=41,fd=7))\n' });
    }
    return result({ code: 1, stdout: "" });
  });
}

describe("L3 — mid-run box loss", () => {
  test("MUTANT (l5): `asleep` this tick loses the lease immediately, with a warn alert", async () => {
    // Both paths dead: the API says the box is gone AND the tunnel is down.
    const { keys, ctx } = fakeKeys('{"devices":[]}');
    const h = harness({
      keys,
      ctx,
      runner: new FakeRunner(() => result({ stdout: "" })), // no listener ⇒ tunnel down
    });
    lease(h.store, "grok-box-008");
    await runReconcile(h.deps);
    const row = listLeases(h.store)[0]!;
    expect(row.state).toBe("lost");
    expect(row.lost_reason).toBe("asleep");
    expect(h.notes.some((n) => n.level === "warn" && n.msg.includes("LOST"))).toBe(true);
  });

  test("MUTANT (l8): ONE unhealthy tick does not lose; TWO CONSECUTIVE ones do", async () => {
    const h = harness({ runner: unhealthyRunner() });
    lease(h.store, "grok-box-008");
    // The tick's ordinal starts at 1 and there is no row at tick 0.
    await runReconcile(h.deps);
    expect(listLeases(h.store)[0]!.state).toBe("active");
    expect(logs.some((l) => l.includes("no snapshot at tick 0 — lease kept (conservative)"))).toBe(true);

    // The second tick's previous row (tick 1) IS unhealthy ⇒ lost.
    await runReconcile(h.deps);
    const row = listLeases(h.store)[0]!;
    expect(row.state).toBe("lost");
    expect(row.lost_reason).toBe("unhealthy");
  });

  test("MUTANT (l11): a GAP before this tick keeps the lease (the conservative branch)", async () => {
    const h = harness({ runner: unhealthyRunner() });
    lease(h.store, "grok-box-008");
    // A row at tick 40 — the tick ordinal here will be 1, so `tick - 1` is 0 and
    // there is no row for it. Reading "the newest row" instead of "the row at
    // tick - 1" is the mutant, and it would lose the lease.
    snapshotAt(h.store, 40, { "grok-box-008": "unhealthy" });
    await runReconcile(h.deps);
    expect(listLeases(h.store)[0]!.state).toBe("active");
  });

  test("a HEALTHY tick under an active lease changes nothing", async () => {
    const h = harness();
    lease(h.store, "grok-box-008");
    await runReconcile(h.deps);
    expect(listLeases(h.store)[0]!.state).toBe("active");
    expect(h.notes.some((n) => n.msg.includes("LOST"))).toBe(false);
  });
});

describe("L3 — the sweeps run at the START of the tick", () => {
  test("an expired lease's grace lapses and the box is written to again", async () => {
    const h = harness();
    const l = lease(h.store, "grok-box-008");
    h.store.db.query("UPDATE leases SET expires_at = ? WHERE lease_id = ?").run(NOW - 10, l.lease_id);

    // Tick 1: the lease expires, and the row still DEFERS through its grace.
    await runReconcile(h.deps);
    expect(listLeases(h.store)[0]!.state).toBe("expired");
    expect(logs.some((l2) => l2.includes("rollout: grok-box-008 deferred — leased by"))).toBe(true);

    // Tick 2, past the grace: swept, and the deferral is gone.
    logs.length = 0;
    h.deps.nowSec = NOW + 10_000;
    h.deps.leases = new LeaseTick({ store: h.store, state: h.state, notify: h.deps.notify });
    await runReconcile(h.deps);
    expect(listLeases(h.store)).toHaveLength(0);
    expect(logs.some((l2) => l2.includes("deferred — leased"))).toBe(false);
  });
});
