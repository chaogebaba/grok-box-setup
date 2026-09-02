// reconcile-resume.test.ts — D9 (s): the RESUME pass inside repairPass
// (blueprint fleet2-state-store D5, Phase B).
//
// The resume pass has no code of its own for the mutation — it calls the same
// `deps.adopt` the adopt path calls, and `beginEnrol` resumes from the row's
// stage. What is genuinely new, and what this file is about, is the SCHEDULING:
// who gets the tick's single mutation slot, when adopt yields, and what counts
// as a failure.
//
// Four mutants live here:
//   (m10) the resume drops the backoff test           ⇒ the starvation ladder
//   (m13) a budget deferral is counted as a failure   ⇒ the deferral cases
//   (m14) adopt yields for a row that IS in backoff   ⇒ the starvation ladder
//   (m16) the adopt yield drops the repair disjunct   ⇒ flapping + three-way

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  DiscoverRun,
  DISCOVER_PROBE_CEILING_MS,
  DISCOVER_REPAIR_BUDGET_MS,
  type AdoptOutcome,
  type DiscoverDeps,
  type EnrolSurface,
  type ProbeOutcome,
  type RepairFindings,
} from "../src/reconcile/discover.ts";
import { ReconcileState, type StateFs } from "../src/reconcile/state.ts";
import type { DiscoverRow } from "../src/commands/list.ts";
import { setLogSink } from "../src/log.ts";

let logs: string[] = [];
let prevSink: (l: string) => void;
beforeEach(() => {
  logs = [];
  prevSink = setLogSink((l) => logs.push(l));
});
afterEach(() => setLogSink(prevSink));

function memState(): ReconcileState {
  const store = new Map<string, string>();
  const fs: StateFs = {
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
  return new ReconcileState("/s", fs);
}

function peer(name: string): DiscoverRow {
  const m = /([0-9]+)$/.exec(name);
  return { index: m ? Number.parseInt(m[1]!, 10) : 0, name, ip: "100.64.0.1", online: "yes" };
}

interface Calls {
  probes: string[];
  adopts: string[];
  inspects: string[];
  stuck: string[];
}

/**
 * An in-memory `EnrolSurface`: the `enrolling` rows a tick would read from the
 * store, oldest `created_at` first.
 */
function enrolSurface(
  rows: Array<{ name: string; stage?: number; streak?: number; created_at?: number }>,
  calls?: Calls,
): EnrolSurface {
  const full = rows.map((r, i) => ({
    name: r.name,
    stage: r.stage ?? 0,
    streak: r.streak ?? 0,
    created_at: r.created_at ?? 1000 + i,
  }));
  return {
    rows: () => [...full].sort((a, b) => a.created_at - b.created_at || (a.name < b.name ? -1 : 1)),
    async stuck(box) {
      calls?.stuck.push(box);
    },
  };
}

function stubDeps(over: Partial<DiscoverDeps> = {}): { deps: DiscoverDeps; calls: Calls } {
  const calls: Calls = { probes: [], adopts: [], inspects: [], stuck: [] };
  const base: DiscoverDeps = {
    apiToken: true,
    boxPassword: "pw",
    async listPeers() {
      return [];
    },
    async probe(box): Promise<ProbeOutcome> {
      calls.probes.push(box);
      return { reachable: true, hostname: "", boxup: "5.3.0" };
    },
    async adopt(box): Promise<AdoptOutcome> {
      calls.adopts.push(box);
      return { rc: 0 };
    },
    async inspect(box): Promise<RepairFindings> {
      calls.inspects.push(box);
      return { ok: true, coherent: false, reason: "[fleet] block missing" };
    },
    async forgetHostKeys() {},
  };
  return { deps: { ...base, ...over }, calls };
}

interface TickOver {
  tick?: number;
  apply?: boolean;
  readonly?: boolean;
  membership?: string[];
  enrol?: EnrolSurface;
  clock?: () => number;
}

function tickOpts(state: ReconcileState, over: TickOver = {}) {
  return {
    state,
    tick: over.tick ?? 5,
    readonly: over.readonly ?? false,
    apply: over.apply ?? true,
    membership: over.membership ?? [],
    enrol: over.enrol,
    nowSec: 1_000_000,
    nowMs: over.clock ?? (() => 0),
  };
}

/** The `discover_ledger` records a run persisted (its backoff bookkeeping). */
function ledger(state: ReconcileState): Array<{ name: string; failures: number; last_tick: number }> {
  return state.readDiscoverLedger().map((r) => ({ name: r.name, failures: r.failures, last_tick: r.last_tick }));
}

describe("(s) the resume pass runs inside repairPass", () => {
  test("an enrolling row takes the slot and a completed resume counts as adopted", async () => {
    const state = memState();
    const { deps, calls } = stubDeps();
    const run = new DiscoverRun(deps, tickOpts(state, { enrol: enrolSurface([{ name: "grok-box-003", stage: 2 }]) }));
    await run.repairPass();
    expect(calls.adopts).toEqual(["grok-box-003"]);
    expect(run.summary.adopted).toBe(1);
    run.finish();
    expect(ledger(state)).toEqual([]); // success clears the record
  });

  test("dry-run names the stage it WOULD resume from and spends no slot", async () => {
    const state = memState();
    const { deps, calls } = stubDeps();
    const run = new DiscoverRun(
      deps,
      tickOpts(state, { apply: false, enrol: enrolSurface([{ name: "grok-box-003", stage: 3 }]) }),
    );
    await run.repairPass();
    expect(calls.adopts).toEqual([]);
    expect(logs.some((l) => l.includes("resume: would resume grok-box-003 from enrol stage 3"))).toBe(true);
  });

  test("the read-only latch stops the resume pass exactly as it stops repair", async () => {
    const state = memState();
    const { deps, calls } = stubDeps();
    const run = new DiscoverRun(
      deps,
      tickOpts(state, { readonly: true, enrol: enrolSurface([{ name: "grok-box-003" }]) }),
    );
    await run.repairPass();
    expect(calls.adopts).toEqual([]);
  });

  test("oldest `created_at` first among enrolling rows", async () => {
    const state = memState();
    const { deps, calls } = stubDeps();
    const run = new DiscoverRun(
      deps,
      tickOpts(state, {
        enrol: enrolSurface([
          { name: "grok-box-005", created_at: 2000 },
          { name: "grok-box-003", created_at: 1000 },
        ]),
      }),
    );
    await run.repairPass();
    expect(calls.adopts).toEqual(["grok-box-003"]); // one slot, oldest row
  });
});

describe("(s) only an ATTEMPTED stage that failed is a failure", () => {
  test("(m13) a BUDGET deferral records no ledger failure and no streak", async () => {
    const state = memState();
    const { deps, calls } = stubDeps();
    // Burn the repair reserve before the pass starts: a clock that jumps by the
    // whole reserve on the first charge leaves no room for a 20 s ceiling.
    let t = 0;
    const run = new DiscoverRun(
      deps,
      tickOpts(state, {
        // an EVEN tick, so the parity tie-break runs the repair-marker box FIRST
        // and the enrolling row meets an already-spent reserve.
        tick: 6,
        membership: ["grok-box-008"],
        enrol: enrolSurface([{ name: "grok-box-003" }]),
        clock: () => t,
      }),
    );
    // A repair-marker box due this tick spends the reserve on its inspect...
    state.bumpRepairPending("grok-box-008", 6);
    state.bumpRepairPending("grok-box-008", 6);
    deps.inspect = async (box) => {
      calls.inspects.push(box);
      t += DISCOVER_REPAIR_BUDGET_MS - DISCOVER_PROBE_CEILING_MS + 1;
      return { ok: true, coherent: true, reason: "coherent" };
    };
    await run.repairPass();
    // ...so the enrolling row is DEFERRED, never attempted.
    expect(calls.adopts).toEqual([]);
    expect(logs.some((l) => l.includes("repair budget spent"))).toBe(true);
    run.finish();
    // (m13): counting the deferral as a failure would put a row here.
    expect(ledger(state)).toEqual([]);
  });

  test("a PREFLIGHT skip records no ledger failure", async () => {
    const state = memState();
    const { deps, calls } = stubDeps({ boxPassword: undefined });
    const run = new DiscoverRun(deps, tickOpts(state, { enrol: enrolSurface([{ name: "grok-box-003" }]) }));
    await run.repairPass();
    expect(calls.adopts).toEqual([]);
    expect(run.summary.skipped.map((s) => s.reason)).toEqual(["no-box-password"]);
    run.finish();
    expect(ledger(state)).toEqual([]);
  });

  test("a slot already SPENT by the adopt pass records no ledger failure", async () => {
    const state = memState();
    const { deps, calls } = stubDeps({ async listPeers() { return [peer("grok-box-004")]; } });
    const run = new DiscoverRun(deps, tickOpts(state, { enrol: enrolSurface([{ name: "grok-box-003" }]) }));
    // The enrolling row is not in backoff, so adopt YIELDS and the slot is free
    // for the resume — which is the point of the yield. Prove the resume, not
    // the adopt, spent it.
    await run.adoptPass();
    expect(calls.adopts).toEqual([]);
    await run.repairPass();
    expect(calls.adopts).toEqual(["grok-box-003"]);
    run.finish();
    expect(ledger(state)).toEqual([]);
  });

  // (m10): the resume pass stops consulting the backoff ledger. This is the ONE
  // place where that is observable on its own — a tick with nothing to adopt, so
  // the slot is free and only the backoff stands between the row and a retry.
  // (The adopt YIELD's own backoff check is a different consultation, and mutant
  // (m14) covers it.)
  test("(m10) a row INSIDE its backoff window is skipped, not retried, even with the slot free", async () => {
    const state = memState();
    // 2 failures at tick 5 ⇒ wait 2 ticks; at tick 6 elapsed is 1, so the row is
    // still inside the window.
    state.writeDiscoverLedger([
      { name: "grok-box-003", last_attempt: 1_000_000, failures: 2, reason: "enroll-rc1", last_tick: 5 },
    ]);
    const { deps, calls } = stubDeps({ async adopt(box) { calls.adopts.push(box); return { rc: 1 }; } });
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 6, enrol: enrolSurface([{ name: "grok-box-003" }]) }));
    await run.repairPass();
    expect(calls.adopts).toEqual([]);
    run.finish();
    // the ledger is untouched: no third failure, and the ladder is not restarted
    expect(ledger(state)).toEqual([{ name: "grok-box-003", failures: 2, last_tick: 5 }]);
  });

  test("an ATTEMPTED stage that FAILED records a ledger failure and asks about enrol-stuck", async () => {
    const state = memState();
    const { deps, calls } = stubDeps({ async adopt(box) { calls.adopts.push(box); return { rc: 1 }; } });
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 5, enrol: enrolSurface([{ name: "grok-box-003" }], calls) }));
    await run.repairPass();
    expect(calls.adopts).toEqual(["grok-box-003"]);
    expect(calls.stuck).toEqual(["grok-box-003"]);
    run.finish();
    expect(ledger(state)).toEqual([{ name: "grok-box-003", failures: 1, last_tick: 5 }]);
  });
});

describe("(s) parity tie-break INSIDE repairPass", () => {
  /** A tick with BOTH a due repair-marker box and a due enrolling row. */
  function bothDue(tick: number): { run: DiscoverRun; calls: Calls; state: ReconcileState } {
    const state = memState();
    state.bumpRepairPending("grok-box-008", tick);
    state.bumpRepairPending("grok-box-008", tick); // runs 2, stamped THIS tick
    const { deps, calls } = stubDeps();
    const run = new DiscoverRun(
      deps,
      tickOpts(state, { tick, membership: ["grok-box-008"], enrol: enrolSurface([{ name: "grok-box-003" }]) }),
    );
    return { run, calls, state };
  }

  test("an EVEN tick_seq gives the slot to the repair-marker box", async () => {
    const { run, calls } = bothDue(6);
    await run.repairPass();
    expect(calls.inspects).toEqual(["grok-box-008"]);
    expect(calls.adopts).toEqual(["grok-box-008"]);
    expect(run.summary.repaired).toBe(1);
    expect(run.summary.adopted).toBe(0);
  });

  test("an ODD tick_seq gives it to the enrolling row", async () => {
    const { run, calls } = bothDue(7);
    await run.repairPass();
    expect(calls.adopts).toEqual(["grok-box-003"]);
    expect(calls.inspects).toEqual([]); // the repair never got the slot
    expect(run.summary.adopted).toBe(1);
    expect(run.summary.repaired).toBe(0);
  });

  test("with only ONE kind due, parity changes nothing", async () => {
    for (const tick of [6, 7]) {
      const state = memState();
      const { deps, calls } = stubDeps();
      const run = new DiscoverRun(deps, tickOpts(state, { tick, enrol: enrolSurface([{ name: "grok-box-003" }]) }));
      await run.repairPass();
      expect(calls.adopts).toEqual(["grok-box-003"]);
    }
  });
});

describe("(s) the adopt yield is a DISJUNCTION", () => {
  test("(m16) a tick-1 repair probe still parks adopt when there is NO enrolling row", async () => {
    const state = memState();
    state.bumpRepairPending("grok-box-008", 5); // runs 1, stamped tick-1
    const { deps, calls } = stubDeps({ async listPeers() { return [peer("grok-box-003")]; } });
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 6, membership: ["grok-box-008"] }));
    await run.adoptPass();
    expect(calls.adopts).toEqual([]);
    expect(logs.some((l) => l.includes("adopt deferred (repair/resume pending on grok-box-008)"))).toBe(true);
  });

  test("an enrolling row NOT in backoff parks adopt even with no repair marker", async () => {
    const state = memState();
    const { deps, calls } = stubDeps({ async listPeers() { return [peer("grok-box-004")]; } });
    const run = new DiscoverRun(
      deps,
      tickOpts(state, { tick: 6, enrol: enrolSurface([{ name: "grok-box-003" }]) }),
    );
    await run.adoptPass();
    expect(calls.adopts).toEqual([]);
    expect(calls.probes).toEqual([]); // yielded BEFORE spending a probe
    expect(logs.some((l) => l.includes("adopt deferred (repair/resume pending on grok-box-003)"))).toBe(true);
  });

  test("(m14) an enrolling row that IS in backoff does NOT park adopt", async () => {
    const state = memState();
    // one failure at tick 5 ⇒ a 1-tick wait ⇒ still inside it at tick 5
    state.writeDiscoverLedger([
      { name: "grok-box-003", last_attempt: 1_000_000, failures: 2, reason: "enroll-rc1", last_tick: 5 },
    ]);
    const { deps, calls } = stubDeps({ async listPeers() { return [peer("grok-box-004")]; } });
    const run = new DiscoverRun(
      deps,
      tickOpts(state, { tick: 6, enrol: enrolSurface([{ name: "grok-box-003" }]) }),
    );
    await run.adoptPass();
    // 2 failures ⇒ wait 2 ticks; elapsed = 6 - 5 = 1 < 2 ⇒ in backoff ⇒ no yield
    expect(calls.adopts).toEqual(["grok-box-004"]);
  });
});

// The ladders. Every tick number and every wait below is written out, because
// the invariant IS the arithmetic: `inBackoff` treats `elapsed >= wait` as
// EXPIRED (discover.ts), and the ladder is 1, 2, 4, ... ticks.
describe("(s) the STARVATION ladder: an unreachable enrolling box must not park a candidate forever", () => {
  test("tick 1 fails (wait 1) · tick 2 fails (wait 2) · tick 3 the row is in backoff ⇒ the candidate is adopted", async () => {
    const state = memState();
    const enrol = enrolSurface([{ name: "grok-box-003" }]);
    const adopted: string[] = [];
    let ledgerRows = state.readDiscoverLedger();

    for (const tick of [1, 2, 3]) {
      state.writeDiscoverLedger(ledgerRows);
      const { deps, calls } = stubDeps({
        async listPeers() {
          return [peer("grok-box-004")];
        },
        async adopt(box) {
          calls.adopts.push(box);
          // 003 is unreachable; 004 (the candidate) enrols fine.
          return box === "grok-box-003" ? { rc: 1 } : { rc: 0 };
        },
      });
      const run = new DiscoverRun(deps, tickOpts(state, { tick, enrol }));
      await run.adoptPass();
      await run.repairPass();
      run.finish();
      ledgerRows = state.readDiscoverLedger();
      adopted.push(calls.adopts.join(",") || "-");
    }

    // tick 1: the row is due (no ledger record), so adopt yields and the resume
    //   is attempted — and fails. failures=1 ⇒ wait 1 tick, last_tick=1.
    // tick 2: elapsed = 2 - 1 = 1 >= wait 1 ⇒ the backoff has ALREADY expired,
    //   so adopt yields again and the resume fails again. failures=2 ⇒ wait 2,
    //   last_tick=2. This is the two-tick window (r6-n2/r7-B1).
    // tick 3: elapsed = 3 - 2 = 1 < wait 2 ⇒ the row is in backoff, adopt does
    //   NOT yield, and the candidate is adopted.
    expect(adopted).toEqual(["grok-box-003", "grok-box-003", "grok-box-004"]);
    // (m10)/(m14): without the backoff test the third entry stays grok-box-003
    // and the candidate never lands.
    expect(ledgerRows.find((r) => r.name === "grok-box-003")!.failures).toBe(2);
  });
});

describe("(s) the THREE-WAY ladder: a broken repair-marker box, an unreachable enrolling row and a candidate", () => {
  test("adopt yields every tick while the repair marker lives; the candidate lands the tick AFTER it clears", async () => {
    const state = memState();
    const enrol = enrolSurface([{ name: "grok-box-003" }]);
    const adopted: string[] = [];
    let ledgerRows = state.readDiscoverLedger();

    for (let tick = 1; tick <= 6; tick++) {
      state.writeDiscoverLedger(ledgerRows);
      const broken = tick <= 4; // the operator fixes grok-box-008 before tick 5
      const { deps, calls } = stubDeps({
        async listPeers() {
          return [peer("grok-box-004")];
        },
        async adopt(box) {
          calls.adopts.push(box);
          // 003 is an unreachable half-enrolment; 008's repair rewrites its
          // artefacts fine (the box itself stays broken, which is why the marker
          // keeps coming back); 004 is a healthy candidate.
          return box === "grok-box-003" ? { rc: 1 } : { rc: 0 };
        },
      });
      const run = new DiscoverRun(deps, tickOpts(state, { tick, membership: ["grok-box-008"], enrol }));

      // Faithful ORDER: adopt runs first and sees the marker the PRECEDING
      // tick's loop stamped; the loop then stamps this tick's; repair runs last.
      await run.adoptPass();
      if (broken) state.bumpRepairPending("grok-box-008", tick);
      else state.resetRepairPending("grok-box-008", tick);
      await run.repairPass();
      run.finish();
      ledgerRows = state.readDiscoverLedger();
      adopted.push(calls.adopts.join(",") || "-");
    }

    // The arithmetic, tick by tick:
    //  1  no marker yet, but 003 has no ledger record ⇒ adopt yields on the
    //     ENROLLING disjunct. The loop stamps runs 1 (too few for repair), so
    //     the resume takes the slot and fails ⇒ failures 1, last_tick 1, wait 1.
    //  2  the tick-1 probe fires ⇒ adopt yields. Even tick ⇒ repair first.
    //  3  probe fires ⇒ yield. Odd tick ⇒ resume first; elapsed 3-1=2 >= 1 so
    //     003 is due, and fails ⇒ failures 2, last_tick 3, wait 2.
    //  4  probe fires ⇒ yield. Even ⇒ repair.
    //  5  the marker is CLEARED, but adopt still meets tick 4's stamp and yields
    //     — repair's priority working as intended. elapsed 5-3=2 >= 2 ⇒ 003 is
    //     due and fails ⇒ failures 3, last_tick 5, wait 4.
    //  6  no marker (runs 0) and 003 is in backoff (elapsed 1 < 4) ⇒ adopt runs
    //     and the candidate lands. Not one tick earlier.
    expect(adopted).toEqual([
      "grok-box-003",
      "grok-box-008",
      "grok-box-003",
      "grok-box-008",
      "grok-box-003",
      "grok-box-004",
    ]);
  });
});

describe("(s) the FLAPPING case: a box at runs == 1 parks adopt for one wasted tick", () => {
  test("the probe fires, repairPass finds nothing due, and the candidate lands next tick", async () => {
    const state = memState();
    state.bumpRepairPending("grok-box-008", 5); // runs 1, stamped tick-1
    const { deps, calls } = stubDeps({ async listPeers() { return [peer("grok-box-004")]; } });
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 6, membership: ["grok-box-008"] }));
    await run.adoptPass();
    await run.repairPass();
    // adopt yielded; repairPass found no marker with runs >= 2 stamped at tick 6
    expect(calls.adopts).toEqual([]);
    expect(calls.inspects).toEqual([]);
    run.finish();
    // ...and no failure was recorded for anyone: an unused slot is not a failure.
    expect(ledger(state)).toEqual([]);

    // Next tick, with the marker stale, the candidate is adopted.
    const { deps: d2, calls: c2 } = stubDeps({ async listPeers() { return [peer("grok-box-004")]; } });
    const run2 = new DiscoverRun(d2, tickOpts(state, { tick: 7, membership: ["grok-box-008"] }));
    await run2.adoptPass();
    expect(c2.adopts).toEqual(["grok-box-004"]);
  });
});
