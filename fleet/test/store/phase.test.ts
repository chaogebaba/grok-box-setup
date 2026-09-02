// phase.test.ts — D9 (e) the transition matrix and (r) retire / re-adoption
// (blueprint fleet2-state-store D4, Phase B).
//
// Two mutants live here:
//   (m1) the `from` assertion is dropped ⇒ the illegal-edge cases below pass an
//        update through and the "nothing written" assertions fail;
//   (m11) `selectCandidates` ignores the `excluded` map ⇒ a retired or enrolling
//        name is adopted again on the next tick.

import { describe, expect, test } from "bun:test";
import { StoreState, type Phase } from "../../src/store/state.ts";
import { selectCandidates } from "../../src/reconcile/discover.ts";
import type { DiscoverRow } from "../../src/commands/list.ts";
import { memStore, T0 } from "./helpers.ts";

function seeded(phase: Phase, name = "grok-box-008"): { st: StoreState; s: ReturnType<typeof memStore> } {
  const s = memStore();
  const st = new StoreState(s);
  s.db
    .query(
      `INSERT INTO boxes(name,idx,port,phase,created_at,enrolled_at,updated_at,pubkey)
       VALUES(?,8,20008,?,?,?,?,'AAAAKEY')`,
    )
    .run(name, phase, T0, T0, T0);
  const id = (s.db.query("SELECT box_id FROM boxes WHERE name = ?").get(name) as { box_id: number }).box_id;
  s.db.query("INSERT INTO box_counters(box_id,checkfail,cfgfail) VALUES(?,4,2)").run(id);
  s.db
    .query("INSERT INTO box_keys(box_id,key_id,expires_raw,expires_date,minted_at) VALUES(?,?,?,?,?)")
    .run(id, "kABC", "2027-01-31T12:00:00Z", "2027-01-31", T0);
  return { st, s };
}

function auditRows(s: ReturnType<typeof memStore>): Array<{ action: string; box: string | null; detail: string | null }> {
  return s.db.query("SELECT action, box, detail FROM audit ORDER BY id").all() as Array<{
    action: string;
    box: string | null;
    detail: string | null;
  }>;
}

describe("(e) the transition matrix", () => {
  const legal: Array<[Phase, Phase]> = [
    ["enrolling", "enrolled"],
    ["enrolled", "retired"],
    ["retired", "enrolling"],
    // the operator's abort of a saga that will not finish
    ["enrolling", "retired"],
  ];

  for (const [from, to] of legal) {
    test(`${from} -> ${to} succeeds and writes ONE audit row`, () => {
      const { st, s } = seeded(from);
      const r = st.transition("grok-box-008", from, to, "operator", "under test");
      expect(r.rc).toBe(0);
      expect(st.boxRow("grok-box-008")!.phase).toBe(to);
      const rows = auditRows(s).filter((a) => a.action === "phase");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.box).toBe("grok-box-008");
      expect(rows[0]!.detail).toBe(`${from} -> ${to}: under test`);
      s.close();
    });
  }

  // (m1): with the assertion dropped, each of these updates the row.
  const illegal: Array<{ have: Phase; claim: Phase; to: Phase }> = [
    { have: "enrolled", claim: "enrolling", to: "enrolled" },
    { have: "retired", claim: "enrolled", to: "retired" },
    { have: "enrolling", claim: "retired", to: "enrolling" },
  ];

  for (const c of illegal) {
    test(`(m1) a row that is '${c.have}' refuses a '${c.claim} -> ${c.to}' transition, rc 1, nothing written`, () => {
      const { st, s } = seeded(c.have);
      const before = st.boxRow("grok-box-008")!;
      const r = st.transition("grok-box-008", c.claim, c.to, "operator");
      expect(r.rc).toBe(1);
      // the message names the phase the row ACTUALLY holds
      expect(r.actual).toBe(c.have);
      expect(r.message).toContain(`is '${c.have}'`);
      // nothing written: neither the row nor an audit line
      expect(st.boxRow("grok-box-008")).toEqual(before);
      expect(auditRows(s)).toHaveLength(0);
      s.close();
    });
  }

  test("a transition on a name with NO row is rc 1 and writes nothing", () => {
    const s = memStore();
    const st = new StoreState(s);
    const r = st.transition("grok-box-404", "enrolled", "retired", "operator");
    expect(r.rc).toBe(1);
    expect(r.message).toContain("no store row");
    expect(auditRows(s)).toHaveLength(0);
    s.close();
  });

  test("retired -> enrolling is RE-ADOPTION on the same row: counters reset, key row gone", () => {
    const { st, s } = seeded("retired");
    const before = st.boxRow("grok-box-008")!;
    expect(st.transition("grok-box-008", "retired", "enrolling", "operator").rc).toBe(0);
    const after = st.boxRow("grok-box-008")!;
    // the SAME row — not a second INSERT, which would break every child table's
    // foreign key and duplicate the name.
    expect(after.box_id).toBe(before.box_id);
    expect((s.db.query("SELECT COUNT(*) AS n FROM boxes").get() as { n: number }).n).toBe(1);
    expect(after.phase).toBe("enrolling");
    expect(after.enrol_stage).toBe(0);
    expect(after.retired_at).toBeNull();
    const c = s.db.query("SELECT checkfail, cfgfail FROM box_counters WHERE box_id = ?").get(after.box_id) as {
      checkfail: number;
      cfgfail: number;
    };
    expect(c).toEqual({ checkfail: 0, cfgfail: 0 });
    // the key row goes: the box will mint a new one on its first healthy tick
    expect(st.keyMetaId(8, "grok-box-008")).toBeUndefined();
    s.close();
  });

  test("enrolled -> retired keeps the row and stamps retired_at", () => {
    const { st, s } = seeded("enrolled");
    expect(st.transition("grok-box-008", "enrolled", "retired", "operator").rc).toBe(0);
    const row = st.boxRow("grok-box-008")!;
    expect(row.phase).toBe("retired");
    expect(row.retired_at).toBe(T0);
    // membership is `phase='enrolled'` ONLY, so the box leaves it at once
    expect(st.membership()).toEqual([]);
    s.close();
  });
});

describe("(r) a retired or enrolling name is NOT adoptable", () => {
  const peers = (names: string[]): DiscoverRow[] =>
    names.map((name) => ({ name, ip: "100.64.0.1", online: "yes" }) as DiscoverRow);

  // (m11): ignoring the map re-adopts the name on the very next tick.
  test("(m11) selectCandidates DROPS a retired name for three ticks, with ZERO skipped entries", () => {
    const { st, s } = seeded("retired", "grok-box-011");
    for (let tick = 1; tick <= 3; tick++) {
      const sel = selectCandidates(peers(["grok-box-011", "grok-box-012"]), st.membership(), st.excludedNames());
      expect(sel.candidates).toEqual(["grok-box-012"]);
      // SILENTLY dropped: a skip reason is a transient fact, and a retired box
      // parked on the tailnet would otherwise emit ~26k snapshot_skipped rows
      // per retention window (r3-B3).
      expect(sel.skipped).toEqual([]);
      expect(sel.errors).toEqual([]);
    }
    s.close();
  });

  test("an ENROLLING name is dropped the same way — the resume pass owns it", () => {
    const { st, s } = seeded("enrolling", "grok-box-011");
    const sel = selectCandidates(peers(["grok-box-011"]), st.membership(), st.excludedNames());
    expect(sel.candidates).toEqual([]);
    expect(sel.skipped).toEqual([]);
    s.close();
  });

  test("excludedNames reports both kinds, and nothing else", () => {
    const s = memStore();
    const st = new StoreState(s);
    const ins = s.db.query(
      "INSERT INTO boxes(name,idx,port,phase,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    );
    ins.run("grok-box-008", 8, 20008, "enrolled", T0, T0);
    ins.run("grok-box-009", 9, 20009, "enrolling", T0, T0);
    ins.run("grok-box-010", 10, 20010, "retired", T0, T0);
    expect([...st.excludedNames().entries()].sort()).toEqual([
      ["grok-box-009", "enrolling"],
      ["grok-box-010", "retired"],
    ]);
    s.close();
  });

  test("`enroll` on a retired name REVIVES the row; `retire --forget` frees the name", () => {
    const { st, s } = seeded("retired", "grok-box-011");
    // enroll = beginEnrol, which transitions retired -> enrolling on the row
    expect(st.beginEnrol("grok-box-011", 20011, "AAAANEW").stage).toBe(0);
    expect(st.boxRow("grok-box-011")!.phase).toBe("enrolling");
    expect((s.db.query("SELECT COUNT(*) AS n FROM boxes").get() as { n: number }).n).toBe(1);
    // still not adoptable while enrolling
    expect(selectCandidates(peers(["grok-box-011"]), [], st.excludedNames()).candidates).toEqual([]);

    // --forget deletes the row entirely; the name becomes an ordinary candidate
    st.deleteBox("grok-box-011");
    expect(st.boxRow("grok-box-011")).toBeUndefined();
    expect(st.excludedNames().size).toBe(0);
    expect(selectCandidates(peers(["grok-box-011"]), [], st.excludedNames()).candidates).toEqual(["grok-box-011"]);
    // the cascade took the children with it
    expect((s.db.query("SELECT COUNT(*) AS n FROM box_counters").get() as { n: number }).n).toBe(0);
    expect((s.db.query("SELECT COUNT(*) AS n FROM box_keys").get() as { n: number }).n).toBe(0);
    // ...but NOT the audit history: `audit.box` is plain TEXT, by design.
    expect(auditRows(s).some((a) => a.box === "grok-box-011")).toBe(true);
    s.close();
  });
});
