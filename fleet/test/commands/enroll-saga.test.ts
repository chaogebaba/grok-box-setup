// enroll-saga.test.ts — D9 (f): the five-stage enrol SAGA and its resume
// (blueprint fleet2-state-store D5, Phase B).
//
// The saga is driven through the REAL `cmdEnrollResult` with a store-backed set
// of side effects, so the stage numbering under test is the one production uses
// and not a parallel model of it.
//
// Mutant (m3) resumes from stage 0 instead of `enrol_stage`; the "exactly once
// more" call counts below are what kill it.

import { describe, expect, test } from "bun:test";
import { cmdEnrollResult, type EnrollSideEffects } from "../../src/commands/enroll.ts";
import { StoreState, ENROL_STAGES, ENROL_STUCK_STREAK } from "../../src/store/state.ts";
import { setLogSink } from "../../src/log.ts";
import { memStore } from "../store/helpers.ts";

const BOX = "grok-box-008";
const PORT = 20008;

interface Calls {
  vpsKey: number;
  etcMap: number;
  boxKey: number;
  boxConfig: number;
  recorded: number;
}

/**
 * A store-backed EnrollSideEffects: every stage hook writes the real store, and
 * every external step is a counter plus an overridable outcome.
 */
function sagaSE(
  st: StoreState,
  over: Partial<EnrollSideEffects> = {},
): { se: EnrollSideEffects; calls: Calls } {
  const calls: Calls = { vpsKey: 0, etcMap: 0, boxKey: 0, boxConfig: 0, recorded: 0 };
  const base: EnrollSideEffects = {
    async vpsUserExists() { return true; },
    async haveSshd() { return false; },
    async sshdEffective() { return undefined; },
    fleetVpsAddr() { return "1.2.3.4"; },
    fleetVpsPort() { return "22"; },
    async aclHasFleetBrainTagowner() { return 0; },
    lastApiCode() { return 200; },
    async readBoxPubkey() { return "ssh-ed25519 AAAAC3xyz grok-tunnel"; },
    async tunnelUp() { return false; },
    async forgetHostKeys() {},
    async installVpsAuthorizedKey() { calls.vpsKey += 1; return true; },
    async recordEtcMapping() { calls.etcMap += 1; return true; },
    async vpsBoxAccessPubkey() { return "ssh-ed25519 AAAAvpskey vps"; },
    async installBoxAuthorizedKey() { calls.boxKey += 1; return true; },
    async writeBoxConfig() { calls.boxConfig += 1; return 0; },
    async recordEnrolled(box, port, pubkey) {
      calls.recorded += 1;
      st.recordEnrolled(box, port, pubkey);
      return undefined;
    },
    async notify() {},
    tunnelWaitBudget() { return "0"; },
    async sleep5() {},
    async beginEnrol(box, port, pubkey) { return st.beginEnrol(box, port, pubkey); },
    async stageOk(box, stage, warn) { st.advanceStage(box, stage, warn); },
    async stageFailed(box, stage, warn) { st.failStage(box, stage, warn); },
  };
  return { se: { ...base, ...over }, calls };
}

function quiet<T>(fn: () => T): T {
  const prev = setLogSink(() => {});
  try {
    return fn();
  } finally {
    setLogSink(prev);
  }
}

async function quietAsync<T>(fn: () => Promise<T>): Promise<T> {
  const prev = setLogSink(() => {});
  try {
    return await fn();
  } finally {
    setLogSink(prev);
  }
}

describe("(f) the enrol saga: the happy path", () => {
  test("a fresh box runs all five stages and ends `enrolled` at stage 5", async () => {
    const s = memStore();
    const st = new StoreState(s);
    const { se, calls } = sagaSE(st);
    const r = await quietAsync(() => cmdEnrollResult([BOX], se));
    expect(r.rc).toBe(0);
    expect(calls).toEqual({ vpsKey: 1, etcMap: 1, boxKey: 1, boxConfig: 1, recorded: 1 });
    const row = st.boxRow(BOX)!;
    expect(row.phase).toBe("enrolled");
    expect(row.enrol_stage).toBe(ENROL_STAGES);
    expect(row.enrol_fail_streak).toBe(0);
    expect(row.enrol_warn).toBeNull();
    expect(st.membership()).toEqual([BOX]);
    s.close();
  });

  test("the row exists as `enrolling` BEFORE stage 1, so a crash leaves a record", async () => {
    const s = memStore();
    const st = new StoreState(s);
    let phaseAtStage1: string | undefined;
    const { se } = sagaSE(st, {
      async installVpsAuthorizedKey() {
        phaseAtStage1 = st.boxRow(BOX)?.phase;
        return true;
      },
    });
    await quietAsync(() => cmdEnrollResult([BOX], se));
    expect(phaseAtStage1).toBe("enrolling");
    s.close();
  });

  test("a precheck failure BEFORE stage 1 leaves NO row at all", async () => {
    const s = memStore();
    const st = new StoreState(s);
    // The ACL read fails ⇒ rc 1 before the pubkey read and before beginEnrol.
    const { se, calls } = sagaSE(st, { async aclHasFleetBrainTagowner() { return 2; } });
    const r = await quietAsync(() => cmdEnrollResult([BOX], se));
    expect(r.rc).toBe(1);
    expect(st.boxRow(BOX)).toBeUndefined();
    expect(calls.vpsKey).toBe(0);
    s.close();
  });
});

describe("(f) hard failures at stages 1, 3 and 4", () => {
  const cases: Array<{ stage: number; label: string; over: Partial<EnrollSideEffects> }> = [
    { stage: 1, label: "installVpsAuthorizedKey", over: { async installVpsAuthorizedKey() { return false; } } },
    { stage: 3, label: "installBoxAuthorizedKey", over: { async installBoxAuthorizedKey() { return false; } } },
    { stage: 4, label: "writeBoxConfig rc 1", over: { async writeBoxConfig() { return 1; } } },
  ];

  for (const c of cases) {
    test(`stage ${c.stage} (${c.label}) ⇒ rc 1, stage stays ${c.stage - 1}, streak 1, warn set`, async () => {
      const s = memStore();
      const st = new StoreState(s);
      const { se } = sagaSE(st, c.over);
      const r = await quietAsync(() => cmdEnrollResult([BOX], se));
      expect(r.rc).toBe(1);
      const row = st.boxRow(BOX)!;
      expect(row.phase).toBe("enrolling"); // never recorded as a member
      expect(row.enrol_stage).toBe(c.stage - 1); // did NOT advance
      expect(row.enrol_fail_streak).toBe(1);
      expect(row.enrol_warn).toContain(`stage ${c.stage}`);
      expect(st.membership()).toEqual([]);
      s.close();
    });
  }

  test("stage 3 with NO VPS box-access key is the same failure, at the same stage", async () => {
    const s = memStore();
    const st = new StoreState(s);
    const { se, calls } = sagaSE(st, { async vpsBoxAccessPubkey() { return undefined; } });
    expect((await quietAsync(() => cmdEnrollResult([BOX], se))).rc).toBe(1);
    expect(calls.boxKey).toBe(0); // the install was never attempted
    const row = st.boxRow(BOX)!;
    expect(row.enrol_stage).toBe(2);
    expect(row.enrol_fail_streak).toBe(1);
    s.close();
  });
});

// Named SEPARATELY from the hard failures (r2-n9): rc 4 is a DIFFERENT case —
// the box has no config.toml at all — and it must not advance or record.
describe("(f) stage 4 rc 4: the box config is ABSENT", () => {
  test("does NOT advance, does NOT record, and still counts as an attempted failure", async () => {
    const s = memStore();
    const st = new StoreState(s);
    const { se, calls } = sagaSE(st, { async writeBoxConfig() { return 4; } });
    const r = await quietAsync(() => cmdEnrollResult([BOX], se));
    expect(r.rc).toBe(1);
    expect(calls.recorded).toBe(0);
    const row = st.boxRow(BOX)!;
    expect(row.enrol_stage).toBe(3);
    expect(row.phase).toBe("enrolling");
    expect(row.enrol_fail_streak).toBe(1);
    expect(row.enrol_warn).toContain("absent on the box");
    s.close();
  });
});

// The stage-2 WARNING path: `recordEtcMapping` failing is a warning today and
// stays one. The stage ADVANCES, with the warning recorded on the row.
describe("(f) stage 2: a warning, not a failure", () => {
  test("recordEtcMapping failing advances to stage 2 with `enrol_warn` set and the enrolment completes", async () => {
    const s = memStore();
    const st = new StoreState(s);
    let warnAtStage3: string | null | undefined;
    const { se, calls } = sagaSE(st, {
      async recordEtcMapping() { return false; },
      async installBoxAuthorizedKey() {
        const row = st.boxRow(BOX)!;
        warnAtStage3 = row.enrol_warn;
        expect(row.enrol_stage).toBe(2); // ADVANCED despite the warning
        return true;
      },
    });
    const r = await quietAsync(() => cmdEnrollResult([BOX], se));
    expect(r.rc).toBe(0);
    expect(warnAtStage3).toContain("recordEtcMapping failed");
    expect(calls.recorded).toBe(1);
    // A stage that ADVANCED resets the streak, warning or not.
    const row = st.boxRow(BOX)!;
    expect(row.phase).toBe("enrolled");
    expect(row.enrol_fail_streak).toBe(0);
    s.close();
  });
});

describe("(f) RESUME re-runs stages enrol_stage+1 .. 5, each external step exactly once more", () => {
  test("(m3) a saga that died at stage 2 resumes at stage 3 — stages 1 and 2 are NOT re-run", async () => {
    const s = memStore();
    const st = new StoreState(s);

    // Attempt 1: stage 3 fails. The override still COUNTS, so the resume's
    // "exactly once more" is measured against a real first attempt.
    const first = sagaSE(st);
    first.se.installBoxAuthorizedKey = async () => { first.calls.boxKey += 1; return false; };
    expect((await quietAsync(() => cmdEnrollResult([BOX], first.se))).rc).toBe(1);
    expect(first.calls).toEqual({ vpsKey: 1, etcMap: 1, boxKey: 1, boxConfig: 0, recorded: 0 });
    expect(st.boxRow(BOX)!.enrol_stage).toBe(2);

    // Attempt 2 (the resume): the SAME orchestration, a fresh call counter.
    const second = sagaSE(st);
    expect((await quietAsync(() => cmdEnrollResult([BOX], second.se))).rc).toBe(0);
    // (m3) resuming from 0 would make these 1, 1, 1, 1, 1.
    expect(second.calls).toEqual({ vpsKey: 0, etcMap: 0, boxKey: 1, boxConfig: 1, recorded: 1 });
    const row = st.boxRow(BOX)!;
    expect(row.phase).toBe("enrolled");
    expect(row.enrol_stage).toBe(ENROL_STAGES);
    s.close();
  });

  test("a saga that died at stage 4 resumes with ONLY writeBoxConfig and the record", async () => {
    const s = memStore();
    const st = new StoreState(s);
    const first = sagaSE(st);
    first.se.writeBoxConfig = async () => { first.calls.boxConfig += 1; return 1; };
    await quietAsync(() => cmdEnrollResult([BOX], first.se));
    expect(first.calls).toEqual({ vpsKey: 1, etcMap: 1, boxKey: 1, boxConfig: 1, recorded: 0 });
    expect(st.boxRow(BOX)!.enrol_stage).toBe(3);

    const second = sagaSE(st);
    expect((await quietAsync(() => cmdEnrollResult([BOX], second.se))).rc).toBe(0);
    expect(second.calls).toEqual({ vpsKey: 0, etcMap: 0, boxKey: 0, boxConfig: 1, recorded: 1 });
    s.close();
  });

  test("a re-run against an ENROLLED box runs every stage again (this is the repair path)", async () => {
    const s = memStore();
    const st = new StoreState(s);
    await quietAsync(() => cmdEnrollResult([BOX], sagaSE(st).se));
    expect(st.boxRow(BOX)!.phase).toBe("enrolled");

    // `discover`'s repair calls the same entry point to REWRITE the artefacts of
    // a box that is already a member. It must not drop to `enrolling` (which
    // would take a healthy box out of membership mid-tick) and must not skip
    // stages, because rewriting them is the whole point.
    const again = sagaSE(st);
    expect((await quietAsync(() => cmdEnrollResult([BOX], again.se))).rc).toBe(0);
    expect(again.calls).toEqual({ vpsKey: 1, etcMap: 1, boxKey: 1, boxConfig: 1, recorded: 1 });
    expect(st.boxRow(BOX)!.phase).toBe("enrolled");
    s.close();
  });
});

describe("(f) enrol-stuck fires at streak 3, and only there", () => {
  test("three ATTEMPTED-and-failed stages reach the threshold; the first two do not", async () => {
    const s = memStore();
    const st = new StoreState(s);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { se } = sagaSE(st, { async writeBoxConfig() { return 1; } });
      await quietAsync(() => cmdEnrollResult([BOX], se));
      const streak = st.boxRow(BOX)!.enrol_fail_streak;
      expect(streak).toBe(attempt);
      expect(streak >= ENROL_STUCK_STREAK).toBe(attempt >= 3);
    }
    s.close();
  });

  test("the alert is due ONCE, then throttled for 24 h", () => {
    const s = memStore();
    const st = new StoreState(s);
    quiet(() => st.recordEnrolled(BOX, PORT));
    const day = 86400;
    // first occurrence fires
    expect(st.alertDue(BOX, "enrol-stuck", day, 1000)).toBe(true);
    // ...and nothing inside the window does
    expect(st.alertDue(BOX, "enrol-stuck", day, 1000 + day - 1)).toBe(false);
    // ...until the window passes
    expect(st.alertDue(BOX, "enrol-stuck", day, 1000 + day)).toBe(true);
    const row = s.db.query("SELECT count, first_seen FROM alerts WHERE kind='enrol-stuck'").get() as {
      count: number;
      first_seen: number;
    };
    expect(row.count).toBe(2);
    expect(row.first_seen).toBe(1000); // first_seen never moves
    s.close();
  });

  test("a cleared alert re-fires immediately (the condition came back)", () => {
    const s = memStore();
    const st = new StoreState(s);
    quiet(() => st.recordEnrolled(BOX, PORT));
    expect(st.alertDue(BOX, "enrol-stuck", 86400, 1000)).toBe(true);
    st.alertClear(BOX, "enrol-stuck");
    expect(st.alertDue(BOX, "enrol-stuck", 86400, 1001)).toBe(true);
    s.close();
  });
});
