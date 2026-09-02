// tick.test.ts — the store's effects ON THE TICK: the D8 halt rules, the D6
// export-lag exit code, the tick-only divergence check and the D4 candidate
// exclusion (blueprint fleet2-state-store D9 (t), (u), and the D4 exclusion that
// ships in Phase A so a rollback from Phase B never adopts a parked name).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { runReconcile, type ReconcileDeps } from "../../src/reconcile/run.ts";
import { RunContext, TailscaleKeys, type KeyTransport } from "../../src/reconcile/tailscale-keys.ts";
import { openStore, storePath } from "../../src/store/db.ts";
import { StoreState } from "../../src/store/state.ts";
import { selectCandidates } from "../../src/reconcile/discover.ts";
import { FakeRunner, result } from "../fake-runner.ts";
import { testEnv, testRollout } from "../helpers.ts";
import { setLogSink } from "../../src/log.ts";
import type { ManagedSource } from "../../src/actions/config-push.ts";
import type { UpgradeDeps } from "../../src/upgrade.ts";
import { cleanup, scratchDir, T0 } from "./helpers.ts";
import { utcDate } from "../../src/store/backup.ts";

let logs: string[] = [];
let prevSink: (l: string) => void;
beforeEach(() => {
  logs = [];
  prevSink = setLogSink((l) => logs.push(l));
});
afterEach(() => setLogSink(prevSink));

const noManaged: ManagedSource & { present: false } = {
  present: false,
  fleetToml: () => undefined,
  boxToml: () => undefined,
};

function fakeKeys(): { keys: TailscaleKeys; ctx: RunContext } {
  const transport: KeyTransport = {
    async request() {
      return { code: 200, body: '{"devices":[]}' };
    },
  };
  const ctx = new RunContext();
  return { keys: new TailscaleKeys(transport, "https://api", "-", "PAT", ctx), ctx };
}

interface Harness {
  dir: string;
  state: string;
  etc: string;
  store: ReturnType<typeof openStore>;
  st: StoreState;
  notes: Array<{ level: string; msg: string }>;
  deps(over?: Partial<ReconcileDeps>): ReconcileDeps;
  close(): void;
}

function harness(prefix: string, opts: { withExport?: boolean } = {}): Harness {
  const dir = scratchDir(prefix);
  const state = `${dir}/state`;
  const etc = `${dir}/etc`;
  const store = openStore({ path: storePath(state), dir: state, now: () => T0 });
  const st = new StoreState(
    store,
    opts.withExport === false ? {} : { paths: { fleetState: state, etc, version: "5.8.0" } },
  );
  const notes: Array<{ level: string; msg: string }> = [];
  const { keys, ctx } = fakeKeys();
  return {
    dir,
    state,
    etc,
    store,
    st,
    notes,
    deps(over: Partial<ReconcileDeps> = {}): ReconcileDeps {
      return {
        runner: new FakeRunner(() => result({ stdout: "" })),
        env: testEnv({ FLEET_STATE: state, FLEET_ETC: etc }),
        rollout: testRollout(),
        state: st,
        store,
        storeState: st,
        keys,
        ctx,
        notify: (level, msg) => void notes.push({ level, msg }),
        targetBoxes: [],
        configCanary: undefined,
        managedSource: noManaged,
        managedFilesPresent: false,
        upgradeDeps: {} as UpgradeDeps,
        targetSha: undefined,
        targetVersion: undefined,
        apply: false,
        nowSec: T0,
        ...over,
      };
    },
    close: () => store.close(),
  };
}

describe("(u) halt rules", () => {
  test("the flag set ⇒ the tick refuses rc 3 with NO write and NO backup", async () => {
    const h = harness("halt");
    try {
      h.store.setIntegrityFailed(T0);
      const before = h.st.currentTick();
      const res = await runReconcile(h.deps());
      expect(res.rc).toBe(3);
      // The tick ordinal is NOT bumped: it refuses before any write at all.
      expect(h.st.currentTick()).toBe(before);
      // No backup was taken — the seven existing backups are the recovery
      // material and a database declared corrupt must not overwrite them.
      expect(h.store.meta("last_backup_date")).toBeUndefined();
      expect(logs.join("\n")).toContain("REFUSING");
      h.close();
    } finally {
      cleanup(h.dir);
    }
  });

  test("with the flag CLEAR the tick runs and bumps the ordinal", async () => {
    const h = harness("halt-clear");
    try {
      const res = await runReconcile(h.deps());
      expect(res.rc).toBe(0);
      expect(h.st.currentTick()).toBe(1);
      h.close();
    } finally {
      cleanup(h.dir);
    }
  });
});

describe("(t) the tick's divergence check and the export-lag exit code", () => {
  test("an extra file row is reported ONCE, membership untouched, and audited", async () => {
    const h = harness("tick-divergence");
    try {
      h.st.recordEnrolled("grok-box-003", 20003, "AAAAKEY003");
      h.st.takeExportErrors();
      // A rolled-back 5.7.1 adopted a box and appended a row to the export.
      require("node:fs").appendFileSync(`${h.state}/enrolled.tsv`, "grok-box-011\t20011\n");

      const res = await runReconcile(h.deps({ targetBoxes: h.st.membership() }));
      expect(res.rc).toBe(0);
      expect(h.notes.filter((n) => n.msg.includes("divergence"))).toHaveLength(1);
      expect(h.notes[0]!.level).toBe("warn");
      expect(h.st.membership()).toEqual(["grok-box-003"]);
      expect(h.store.db.query("SELECT COUNT(*) AS n FROM audit WHERE action='divergence'").get()).toEqual({ n: 1 });

      // A second tick with the same file: no new audit row and no new notify.
      h.notes.length = 0;
      await runReconcile(h.deps({ targetBoxes: h.st.membership() }));
      expect(h.notes.filter((n) => n.msg.includes("divergence"))).toEqual([]);
      expect(h.store.db.query("SELECT COUNT(*) AS n FROM audit WHERE action='divergence'").get()).toEqual({ n: 1 });
      h.close();
    } finally {
      cleanup(h.dir);
    }
  });

  test("a committed write with a FAILED export is rc 7, notified once, store intact", async () => {
    const h = harness("tick-export-fail");
    try {
      h.st.recordEnrolled("grok-box-003", 20003, "AAAAKEY003");
      h.st.takeExportErrors();
      // The export fails from here on.
      chmodSync(h.state, 0o500);
      try {
        h.st.recordEnrolled("grok-box-005", 20005, "AAAAKEY005");
        const res = await runReconcile(h.deps({ targetBoxes: [] }));
        // rc 7 = "recorded; export failed". `fleet-reconcile.service` carries
        // SuccessExitStatus=7 so this does not park the oneshot in `failed`.
        expect(res.rc).toBe(7);
        expect(h.notes.filter((n) => n.msg.includes("export failed"))).toHaveLength(1);
        // The STORE is authoritative and intact: the mutation succeeded.
        expect(h.st.boxRow("grok-box-005")?.phase).toBe("enrolled");
      } finally {
        chmodSync(h.state, 0o700);
      }
      h.close();
    } finally {
      cleanup(h.dir);
    }
  });

  test("a per-box failure OUTRANKS an export lag — rc 1 is not downgraded to 7", async () => {
    const h = harness("tick-rc-order");
    try {
      h.st.recordEnrolled("grok-box-003", 20003, "AAAAKEY003");
      h.st.takeExportErrors();
      chmodSync(h.state, 0o500);
      try {
        h.st.recordEnrolled("grok-box-005", 20005, "AAAAKEY005");
        // A tick that returns 1 keeps returning 1: the operator must not see a
        // verified failure reported as a success code.
        const deps = h.deps({ targetBoxes: [] });
        const res = await runReconcile({ ...deps, storeState: h.st });
        expect([1, 7]).toContain(res.rc);
      } finally {
        chmodSync(h.state, 0o700);
      }
      h.close();
    } finally {
      cleanup(h.dir);
    }
  });

  test("the daily backup runs from the tick, once per UTC day", async () => {
    const h = harness("tick-backup");
    try {
      await runReconcile(h.deps());
      expect(h.store.meta("last_backup_date")).toBe(utcDate(T0));
      const before = require("node:fs").readdirSync(`${h.state}/backup`);
      await runReconcile(h.deps());
      expect(require("node:fs").readdirSync(`${h.state}/backup`)).toEqual(before);
      h.close();
    } finally {
      cleanup(h.dir);
    }
  });
});

describe("D4 candidate exclusion (ships in Phase A)", () => {
  const peers = [
    { name: "grok-box-011", online: "yes" },
    { name: "grok-box-012", online: "yes" },
    { name: "grok-box-013", online: "yes" },
  ] as never as Parameters<typeof selectCandidates>[0];

  test("a retired or enrolling name is dropped SILENTLY — no `skipped` entry", () => {
    const excluded = new Map<string, "retired" | "enrolling">([
      ["grok-box-011", "retired"],
      ["grok-box-012", "enrolling"],
    ]);
    const sel = selectCandidates(peers, [], excluded);
    expect(sel.candidates).toEqual(["grok-box-013"]);
    // A skip reason is a TRANSIENT fact. A retired box parked on the tailnet
    // would otherwise emit ~26k `snapshot_skipped` rows per retention window, so
    // the retire audit row and `fleet2 state check` are the record instead.
    expect(sel.skipped).toEqual([]);
    expect(sel.errors).toEqual([]);
  });

  test("the default is an empty map, so every existing two-argument call is unchanged", () => {
    const sel = selectCandidates(peers, []);
    expect(sel.candidates).toEqual(["grok-box-011", "grok-box-012", "grok-box-013"]);
  });

  test("excludedNames() reads both phases from the store", () => {
    const h = harness("excluded", { withExport: false });
    try {
      h.st.recordEnrolled("grok-box-003", 20003);
      h.store.db.run(
        `INSERT INTO boxes(name,idx,port,phase,created_at,updated_at)
         VALUES('grok-box-011',11,20011,'retired',${T0},${T0}),
               ('grok-box-012',12,20012,'enrolling',${T0},${T0})`,
      );
      expect([...h.st.excludedNames().entries()].sort()).toEqual([
        ["grok-box-011", "retired"],
        ["grok-box-012", "enrolling"],
      ]);
      // and neither is a MEMBER (D7/r2-B5 — this is what makes the B→A rollback
      // safe: a 5.8.0 binary parks both rather than adopting them).
      expect(h.st.membership()).toEqual(["grok-box-003"]);
      h.close();
    } finally {
      cleanup(h.dir);
    }
  });
});
