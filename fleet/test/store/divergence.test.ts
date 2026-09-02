// divergence.test.ts — the ADVISORY file-vs-store check and its finding state
// machine (blueprint fleet2-state-store D9 (t)).

import { describe, expect, test } from "bun:test";
import { checkDivergence, currentFindings, DIVERGENCE_RENOTIFY_SECS } from "../../src/store/divergence.ts";
import { StoreState } from "../../src/store/state.ts";
import { memStore, T0 } from "./helpers.ts";

const PATH = "/state/enrolled.tsv";

function setup(): { store: ReturnType<typeof memStore>; st: StoreState } {
  const store = memStore();
  const st = new StoreState(store); // no export paths: this test is about the CHECK
  st.recordEnrolled("grok-box-003", 20003);
  st.recordEnrolled("grok-box-005", 20005);
  return { store, st };
}

/** A file reader seam so no test needs a real enrolled.tsv. */
function file(content: string | undefined): (p: string) => string | undefined {
  return () => content;
}

const BOTH = "grok-box-003\t20003\ngrok-box-005\t20005\n";

describe("(t) divergence is advisory and never writes membership", () => {
  test("no divergence ⇒ no findings, no notifications", () => {
    const { store } = setup();
    const r = checkDivergence(store, { enrolledPath: PATH, now: T0, readFile: file(BOTH) });
    expect(r.new_).toEqual([]);
    expect(r.notifications).toEqual([]);
    expect(currentFindings(store)).toEqual([]);
    store.close();
  });

  test("an EXTRA row in the file ⇒ one finding, one audit row, one notify — not per tick", () => {
    const { store, st } = setup();
    const content = BOTH + "grok-box-011\t20011\n";
    const r1 = checkDivergence(store, { enrolledPath: PATH, now: T0, readFile: file(content) });
    expect(r1.new_.map((f) => f.name)).toEqual(["grok-box-011"]);
    expect(r1.new_[0]!.kind).toBe("file-only");
    expect(r1.notifications).toHaveLength(1);
    expect(r1.notifications[0]!.level).toBe("warn");
    expect(r1.notifications[0]!.msg).toContain(PATH);
    // MEMBERSHIP IS UNTOUCHED. The check reports; the operator resolves.
    expect(st.membership()).toEqual(["grok-box-003", "grok-box-005"]);

    // Ten more ticks inside the 24 h window: `last_seen` advances, and there is
    // exactly ONE audit row and NO further notify.
    for (let i = 1; i <= 10; i++) {
      const r = checkDivergence(store, { enrolledPath: PATH, now: T0 + i * 300, readFile: file(content) });
      expect(r.notifications).toEqual([]);
      expect(r.unchanged).toHaveLength(1);
    }
    const audits = store.db.query("SELECT action FROM audit WHERE action LIKE 'divergence%'").all();
    expect(audits).toHaveLength(1);
    expect(currentFindings(store)[0]!.last_seen).toBe(T0 + 10 * 300);
    store.close();
  });

  test("an unchanged finding RE-notifies at most once every 24 h", () => {
    const { store } = setup();
    const content = BOTH + "grok-box-011\t20011\n";
    checkDivergence(store, { enrolledPath: PATH, now: T0, readFile: file(content) });
    const justUnder = checkDivergence(store, {
      enrolledPath: PATH,
      now: T0 + DIVERGENCE_RENOTIFY_SECS - 1,
      readFile: file(content),
    });
    expect(justUnder.notifications).toEqual([]);
    const atWindow = checkDivergence(store, {
      enrolledPath: PATH,
      now: T0 + 2 * DIVERGENCE_RENOTIFY_SECS,
      readFile: file(content),
    });
    expect(atWindow.notifications).toHaveLength(1);
    store.close();
  });

  test("a MISSING row in the file ⇒ a store-only finding, and only that", () => {
    const { store, st } = setup();
    const r = checkDivergence(store, {
      enrolledPath: PATH,
      now: T0,
      readFile: file("grok-box-003\t20003\n"),
    });
    expect(r.new_.map((f) => [f.name, f.kind])).toEqual([["grok-box-005", "store-only"]]);
    expect(st.membership()).toEqual(["grok-box-003", "grok-box-005"]);
    store.close();
  });

  test("a CHANGED kind updates the row, audits and notifies again", () => {
    const { store, st } = setup();
    // grok-box-011 is file-only.
    checkDivergence(store, { enrolledPath: PATH, now: T0, readFile: file(BOTH + "grok-box-011\t20011\n") });
    // now it is in the store but NOT in the file: the same name, the other kind.
    st.recordEnrolled("grok-box-011", 20011);
    const r = checkDivergence(store, { enrolledPath: PATH, now: T0 + 300, readFile: file(BOTH) });
    expect(r.changed.map((f) => [f.name, f.kind])).toEqual([["grok-box-011", "store-only"]]);
    expect(r.notifications).toHaveLength(1);
    expect(store.db.query("SELECT COUNT(*) AS n FROM audit WHERE action='divergence'").get()).toEqual({ n: 2 });
    store.close();
  });

  test("a CLEARED finding deletes the row and audits divergence-cleared", () => {
    const { store } = setup();
    const content = BOTH + "grok-box-011\t20011\n";
    checkDivergence(store, { enrolledPath: PATH, now: T0, readFile: file(content) });
    const r = checkDivergence(store, { enrolledPath: PATH, now: T0 + 300, readFile: file(BOTH) });
    expect(r.cleared.map((f) => f.name)).toEqual(["grok-box-011"]);
    expect(r.notifications[0]!.level).toBe("info");
    expect(currentFindings(store)).toEqual([]);
    expect(store.db.query("SELECT COUNT(*) AS n FROM audit WHERE action='divergence-cleared'").get()).toEqual({ n: 1 });
    store.close();
  });

  test("a MISSING file is 'cannot compare' and is INERT for the whole machine", () => {
    const { store } = setup();
    // No prior findings: absence must not manufacture store-only findings for
    // every enrolled row.
    const r = checkDivergence(store, { enrolledPath: PATH, now: T0, readFile: file(undefined) });
    expect(r.cannotCompare).toContain("cannot compare");
    expect(r.cannotCompare).toContain(PATH);
    expect(r.new_).toEqual([]);
    expect(currentFindings(store)).toEqual([]);
    store.close();
  });

  test("finding exists, file removed for 3 ticks, file restored ⇒ ONE finding throughout, zero extra audits/notifies", () => {
    const { store } = setup();
    const content = BOTH + "grok-box-011\t20011\n";
    checkDivergence(store, { enrolledPath: PATH, now: T0, readFile: file(content) });
    const seenAfterFirst = currentFindings(store)[0]!.last_seen;

    for (let i = 1; i <= 3; i++) {
      const r = checkDivergence(store, { enrolledPath: PATH, now: T0 + i * 300, readFile: file(undefined) });
      expect(r.cannotCompare).toBeDefined();
      expect(r.notifications).toEqual([]);
      expect(r.cleared).toEqual([]);
    }
    // The finding persists with a FROZEN last_seen: absence is never read as
    // emptiness in either direction (r5-B3/r6-n6).
    const findings = currentFindings(store);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.last_seen).toBe(seenAfterFirst);
    expect(store.db.query("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'divergence%'").get()).toEqual({ n: 1 });

    // The file comes back unchanged: still one finding, still no new audit row.
    const back = checkDivergence(store, { enrolledPath: PATH, now: T0 + 1200, readFile: file(content) });
    expect(back.unchanged).toHaveLength(1);
    expect(back.notifications).toEqual([]);
    expect(store.db.query("SELECT COUNT(*) AS n FROM audit WHERE action LIKE 'divergence%'").get()).toEqual({ n: 1 });
    store.close();
  });

  test("an UNREADABLE file is 'cannot compare' too, with the reason", () => {
    const { store } = setup();
    const r = checkDivergence(store, {
      enrolledPath: PATH,
      now: T0,
      readFile: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    expect(r.cannotCompare).toContain("EACCES");
    expect(currentFindings(store)).toEqual([]);
    store.close();
  });

  test("the check NEVER retires a store-only row", () => {
    const { store, st } = setup();
    // MUTANT (m12): make the check retire (or delete) store-only rows ⇒ this
    // test fails. Automatic retirement is deliberately out of scope: the file is
    // the ROLLBACK artefact and a rolled-back 5.7.1 rewriting it must not be able
    // to de-enrol a box behind the operator's back.
    for (let i = 0; i < 5; i++) {
      checkDivergence(store, { enrolledPath: PATH, now: T0 + i * 300, readFile: file("grok-box-003\t20003\n") });
    }
    expect(st.membership()).toEqual(["grok-box-003", "grok-box-005"]);
    expect(st.boxRow("grok-box-005")?.phase).toBe("enrolled");
    store.close();
  });

  test("an empty-but-PRESENT file is emptiness, not absence", () => {
    const { store } = setup();
    const r = checkDivergence(store, { enrolledPath: PATH, now: T0, readFile: file("") });
    expect(r.cannotCompare).toBeUndefined();
    expect(r.new_.map((f) => [f.name, f.kind])).toEqual([
      ["grok-box-003", "store-only"],
      ["grok-box-005", "store-only"],
    ]);
    store.close();
  });
});
