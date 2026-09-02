// counters.test.ts — the eight per-box markers, table-driven, OLD file
// implementation vs NEW store on the SAME script, plus the box_keys constraints
// (blueprint fleet2-state-store D9 (c), (d)).
//
// The point of running both implementations over one script is that the store is
// a STORAGE swap, not a semantics change: every reset rule in survey §2a is
// preserved column by column. Where the two deliberately differ, the difference
// is asserted explicitly rather than papered over.

import { describe, expect, test } from "bun:test";
import { ReconcileState, type ReconcileStateApi, type StateFs } from "../../src/reconcile/state.ts";
import { StoreState } from "../../src/store/state.ts";
import { memStore, T0 } from "./helpers.ts";

/** An in-memory StateFs so the OLD implementation needs no disk. */
function fakeFs(): StateFs {
  const files = new Map<string, string>();
  return {
    read: (p) => files.get(p),
    write: (p, d) => void files.set(p, d),
    remove: (p) => void files.delete(p),
    mkdirp: () => {},
    chmod: () => {},
    rename: (a, b) => {
      const v = files.get(a);
      files.delete(a);
      if (v !== undefined) files.set(b, v);
    },
    exists: (p) => files.has(p),
    tmpname: (dir, prefix) => `${dir}/${prefix}tmp`,
  };
}

const BOX = "grok-box-003";

function bothImplementations(): Array<{ label: string; state: ReconcileStateApi; close(): void }> {
  const old = new ReconcileState("/state", fakeFs());
  const store = memStore();
  store.db.run(
    `INSERT INTO boxes(name,idx,port,phase,created_at,updated_at) VALUES('${BOX}',3,20003,'enrolled',${T0},${T0})`,
  );
  return [
    { label: "5.7.1 files", state: old, close: () => {} },
    { label: "5.8.0 store", state: new StoreState(store), close: () => store.close() },
  ];
}

describe("(c) counter semantics are identical in both implementations", () => {
  const script: Array<{ name: string; run: (s: ReconcileStateApi) => unknown; want: unknown }> = [
    { name: "checkfail starts at 0", run: (s) => s.checkfailCount(BOX), want: 0 },
    { name: "checkfail bump 1", run: (s) => s.bumpCheckfail(BOX), want: 1 },
    { name: "checkfail bump 2", run: (s) => s.bumpCheckfail(BOX), want: 2 },
    { name: "checkfail reads back", run: (s) => s.checkfailCount(BOX), want: 2 },
    // reset is `echo 0 >` for checkfail (survey §2a): the value goes to 0.
    { name: "checkfail reset", run: (s) => (s.resetCheckfail(BOX), s.checkfailCount(BOX)), want: 0 },
    { name: "seedfail bump", run: (s) => s.bumpSeedfail(BOX), want: 1 },
    { name: "seedfail reset then bump", run: (s) => (s.resetSeedfail(BOX), s.bumpSeedfail(BOX)), want: 1 },
    // cfgfail's reset is `rm -f`, which READS as 0 — the store's 0 column is the
    // same observable state.
    { name: "cfgfail bump 1", run: (s) => s.bumpCfgfail(BOX), want: 1 },
    { name: "cfgfail bump 2", run: (s) => s.bumpCfgfail(BOX), want: 2 },
    { name: "cfgfail reset then bump restarts at 1", run: (s) => (s.resetCfgfail(BOX), s.bumpCfgfail(BOX)), want: 1 },
    { name: "incoherent bump", run: (s) => s.bumpIncoherent(BOX), want: 1 },
    {
      name: "incoherent reset then bump restarts at 1",
      run: (s) => (s.resetIncoherent(BOX), s.bumpIncoherent(BOX)),
      want: 1,
    },
    // asleep's reset is `rm -f` and ABSENT is distinguishable from zero: the 2h
    // first-alert gate keys off the marker's absence.
    { name: "asleep absent", run: (s) => s.readAsleep(BOX), want: undefined },
    { name: "asleep write", run: (s) => (s.writeAsleep(BOX, 111, 222), s.readAsleep(BOX)), want: { since: 111, last: 222 } },
    { name: "asleep reset is ABSENT, not zero", run: (s) => (s.resetAsleep(BOX), s.readAsleep(BOX)), want: undefined },
    { name: "repair_pending absent", run: (s) => s.readRepairPending(BOX), want: undefined },
    { name: "repair_pending bump stamps the tick", run: (s) => (s.bumpRepairPending(BOX, 7), s.readRepairPending(BOX)), want: { runs: 1, tick: 7 } },
    { name: "repair_pending bumps again on the next tick", run: (s) => (s.bumpRepairPending(BOX, 8), s.readRepairPending(BOX)), want: { runs: 2, tick: 8 } },
    // reset writes `0 <tick>`, NOT a removal: both consumers read the stamp.
    { name: "repair_pending reset keeps the stamp", run: (s) => (s.resetRepairPending(BOX, 9), s.readRepairPending(BOX)), want: { runs: 0, tick: 9 } },
    { name: "hostkey_mismatch absent", run: (s) => s.readHostkeyMismatch(BOX), want: false },
    { name: "hostkey_mismatch set", run: (s) => (s.setHostkeyMismatch(BOX), s.readHostkeyMismatch(BOX)), want: true },
    { name: "hostkey_mismatch clear", run: (s) => (s.clearHostkeyMismatch(BOX), s.readHostkeyMismatch(BOX)), want: false },
    { name: "tick starts at 0", run: (s) => s.currentTick(), want: 0 },
    { name: "tick bump 1", run: (s) => s.bumpTick(), want: 1 },
    { name: "tick bump 2", run: (s) => s.bumpTick(), want: 2 },
    { name: "tick reads back", run: (s) => s.currentTick(), want: 2 },
    { name: "api fails start at 0", run: (s) => s.apiFails(), want: 0 },
    // The 5/10/20-minute ladder (reconcile/state.ts:208) is preserved exactly.
    { name: "api failure 1 ⇒ 5m", run: (s) => s.recordApiFailure(1000), want: { n: 1, mins: 5 } },
    { name: "api failure 2 ⇒ 10m", run: (s) => s.recordApiFailure(1000), want: { n: 2, mins: 10 } },
    { name: "api failure 3 ⇒ 20m", run: (s) => s.recordApiFailure(1000), want: { n: 3, mins: 20 } },
    { name: "next_retry follows the ladder", run: (s) => s.nextRetry(), want: 1000 + 20 * 60 },
    { name: "api reset zeroes fails", run: (s) => (s.resetApiFailure(), s.apiFails()), want: 0 },
    { name: "api reset clears next_retry", run: (s) => s.nextRetry(), want: undefined },
  ];

  for (const step of script) {
    test(step.name, () => {
      for (const impl of bothImplementations()) {
        // Replay the WHOLE prefix on a fresh pair so each step is independent.
        for (const prior of script.slice(0, script.indexOf(step))) prior.run(impl.state);
        expect(step.run(impl.state)).toEqual(step.want as never);
        impl.close();
      }
    });
  }

  test("the discover ledger round-trips through both", () => {
    for (const impl of bothImplementations()) {
      const records = [
        { name: "grok-box-009", last_attempt: 500, failures: 2, reason: "enroll-rc1", last_tick: 40 },
        { name: "grok-box-010", last_attempt: 600, failures: 1, reason: "timeout-probe", last_tick: 41 },
      ];
      impl.state.writeDiscoverLedger(records);
      expect(impl.state.readDiscoverLedger()).toEqual(records);
      // A whole-ledger REPLACE, as 5.7.1's rewrite-the-file was.
      impl.state.writeDiscoverLedger([records[0]!]);
      expect(impl.state.readDiscoverLedger()).toEqual([records[0]!]);
      impl.close();
    }
  });
});

describe("counter writes for a name with no store row are dropped, not invented", () => {
  test("a bump on an unknown box neither creates a row nor throws", () => {
    const store = memStore();
    const st = new StoreState(store);
    expect(st.bumpCheckfail("grok-box-999")).toBe(0);
    expect(st.checkfailCount("grok-box-999")).toBe(0);
    // Inventing a `boxes` row here would publish a phantom into the export and
    // into membership; the store is authoritative about who is a member.
    expect((store.db.query("SELECT COUNT(*) AS n FROM boxes").get() as { n: number }).n).toBe(0);
    store.close();
  });
});

describe("(d) box_keys constraints", () => {
  function withBox(): { store: ReturnType<typeof memStore>; st: StoreState } {
    const store = memStore();
    store.db.run(
      `INSERT INTO boxes(name,idx,port,phase,created_at,updated_at) VALUES('${BOX}',3,20003,'enrolled',${T0},${T0})`,
    );
    return { store, st: new StoreState(store) };
  }

  test("a good record lands with the key id and BOTH expiry forms (D5, one write)", () => {
    const { store, st } = withBox();
    expect(st.recordKey(BOX, { keyId: "kABC", expiresRaw: "2027-01-31T12:00:00Z", expiresDate: "2027-01-31" })).toBe(true);
    const r = store.db.query("SELECT * FROM box_keys").get() as Record<string, unknown>;
    expect(r.key_id).toBe("kABC");
    expect(r.expires_raw).toBe("2027-01-31T12:00:00Z");
    expect(r.expires_date).toBe("2027-01-31");
    expect(st.readExpiresDate(BOX)).toBe("2027-01-31");
    expect(st.keyMetaId(3, BOX)).toBe("kABC");
    store.close();
  });

  test("a blank id is refused", () => {
    const { store, st } = withBox();
    expect(st.recordKey(BOX, { keyId: "", expiresRaw: "x", expiresDate: "2027-01-31" })).toBe(false);
    expect((store.db.query("SELECT COUNT(*) AS n FROM box_keys").get() as { n: number }).n).toBe(0);
    store.close();
  });

  test("an empty or short expiry is refused and the PREVIOUS row survives", () => {
    const { store, st } = withBox();
    st.recordKey(BOX, { keyId: "kGOOD", expiresRaw: "2027-01-31T12:00:00Z", expiresDate: "2027-01-31" });
    expect(st.recordKey(BOX, { keyId: "kBAD", expiresRaw: "raw", expiresDate: "" })).toBe(false);
    expect(st.recordKey(BOX, { keyId: "kBAD", expiresRaw: "raw", expiresDate: "2027-01" })).toBe(false);
    const r = store.db.query("SELECT key_id, expires_date FROM box_keys").get() as Record<string, unknown>;
    expect(r.key_id).toBe("kGOOD");
    expect(r.expires_date).toBe("2027-01-31");
    store.close();
  });

  test("the CHECK(length=10) is enforced by the SCHEMA, not only by the accessor", () => {
    const { store, st } = withBox();
    st.recordKey(BOX, { keyId: "kGOOD", expiresRaw: "raw", expiresDate: "2027-01-31" });
    const id = (store.db.query(`SELECT box_id FROM boxes WHERE name='${BOX}'`).get() as { box_id: number }).box_id;
    expect(() =>
      store.db.query("UPDATE box_keys SET expires_date = ? WHERE box_id = ?").run("2027-01", id),
    ).toThrow();
    store.close();
  });

  test("deleting the box cascades its counters and key row", () => {
    const { store, st } = withBox();
    st.recordKey(BOX, { keyId: "kGOOD", expiresRaw: "raw", expiresDate: "2027-01-31" });
    st.bumpCheckfail(BOX);
    st.deleteBox(BOX);
    expect((store.db.query("SELECT COUNT(*) AS n FROM box_keys").get() as { n: number }).n).toBe(0);
    expect((store.db.query("SELECT COUNT(*) AS n FROM box_counters").get() as { n: number }).n).toBe(0);
    store.close();
  });
});
