// reconcile-discover.test.ts — zero-touch join D8, the POLICY half.
//
// Everything here drives DiscoverRun with stubbed transports: the candidate
// rule and its rails, the P1/P2 preflights, the backoff schedule and its ledger
// prune, the shared one-mutation cap and its repair-outranks-adopt yield, the
// split time budget, the read-only latch, and the D5 hysteresis + content-check
// repair.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  DiscoverBudget,
  DiscoverRun,
  DISCOVER_ADOPT_BUDGET_MS,
  DISCOVER_BUDGET_MS,
  DISCOVER_MAX_RECORDS,
  DISCOVER_PROBE_CEILING_MS,
  DISCOVER_PRUNE_TICKS,
  authorizedKeysCoherent,
  backoffTicks,
  fleetBlockCoherent,
  keyMaterial,
  mapCoherent,
  parseBoxupVersion,
  selectCandidates,
  type AdoptOutcome,
  type DiscoverDeps,
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

function memState(): { state: ReconcileState; store: Map<string, string> } {
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
  return { state: new ReconcileState("/s", fs), store };
}

function peer(name: string, online: "yes" | "no" = "yes"): DiscoverRow {
  const m = /([0-9]+)$/.exec(name);
  return { index: m ? Number.parseInt(m[1]!, 10) : 0, name, ip: "100.64.0.1", online };
}

interface Calls {
  probes: string[];
  adopts: string[];
  inspects: string[];
}

function stubDeps(over: Partial<DiscoverDeps> = {}): { deps: DiscoverDeps; calls: Calls } {
  const calls: Calls = { probes: [], adopts: [], inspects: [] };
  const base: DiscoverDeps = {
    apiToken: true,
    boxPassword: "pw",
    async listPeers() {
      return [peer("grok-box-003")];
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
  };
  return { deps: { ...base, ...over }, calls };
}

function tickOpts(
  state: ReconcileState,
  over: Partial<{ tick: number; readonly: boolean; apply: boolean; membership: string[]; clock: () => number }> = {},
) {
  let t = 0;
  return {
    state,
    tick: over.tick ?? 5,
    readonly: over.readonly ?? false,
    apply: over.apply ?? true,
    membership: over.membership ?? [],
    nowSec: 1_000_000,
    nowMs: over.clock ?? (() => (t += 0)),
  };
}

// --- D1 candidate rule + D6a index rail --------------------------------------

describe("D1 candidate rule + D6a index rail (pure)", () => {
  test("filter table: 3-digit name, online yes, not enrolled, index free", () => {
    const rows = [
      peer("grok-box-003"), // ✓ candidate
      peer("grok-box-004", "no"), // offline ⇒ not a candidate, not reported
      peer("grok-box-008"), // enrolled ⇒ not a candidate
      peer("grok-box-9"), // legacy 1-digit ⇒ needs-rename
      peer("grok-box-42"), // legacy 2-digit ⇒ needs-rename
      peer("grok-box-1003"), // 4 digits: not ours, silently ignored
      peer("laptop"), // not a grok box at all
    ];
    const r = selectCandidates(rows, ["grok-box-008"]);
    expect(r.candidates).toEqual(["grok-box-003"]);
    expect(r.skipped.map((s) => `${s.name}:${s.reason}`).sort()).toEqual([
      "grok-box-42:needs-rename",
      "grok-box-9:needs-rename",
    ]);
  });

  test("`online` is the STRING yes/no that parseDiscover emits, not a boolean", () => {
    expect(selectCandidates([peer("grok-box-003", "no")], []).candidates).toEqual([]);
    expect(selectCandidates([peer("grok-box-003", "yes")], []).candidates).toEqual(["grok-box-003"]);
  });

  test("D6a: an index already held by an enrolled box ⇒ index-collision, never adopted", () => {
    // grok-box-3 is enrolled; grok-box-003 parses to the SAME index 3.
    const r = selectCandidates([peer("grok-box-003")], ["grok-box-3"]);
    expect(r.candidates).toEqual([]);
    expect(r.skipped).toEqual([{ name: "grok-box-003", reason: "index-collision" }]);
    expect(r.errors[0]).toContain("already held by grok-box-3");
  });

  test("tags are NOT gated — an untagged URL-approved peer is still a candidate", () => {
    // parseDiscover carries no tag field at all; the rule must not invent one.
    expect(selectCandidates([peer("grok-box-003")], []).candidates).toEqual(["grok-box-003"]);
  });

  test("candidates come back sorted by name", () => {
    const r = selectCandidates([peer("grok-box-011"), peer("grok-box-003"), peer("grok-box-007")], []);
    expect(r.candidates).toEqual(["grok-box-003", "grok-box-007", "grok-box-011"]);
  });
});

// --- pure content-check helpers ----------------------------------------------

describe("D5 content checks (pure)", () => {
  const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAI_current";
  const OLD = "AAAAC3NzaC1lZDI1NTE5AAAAI_stale";
  const pub = `ssh-ed25519 ${KEY} grok-tunnel`;
  const line = (k: string) => `restrict,port-forwarding,permitlisten="127.0.0.1:20003" ssh-ed25519 ${k} c`;

  test("authorized_keys: exactly ONE line for the port AND the CURRENT key material", () => {
    expect(authorizedKeysCoherent(line(KEY) + "\n", 20003, pub)).toBe(true);
    // presence-only would pass this: the line is there but carries the OLD key.
    expect(authorizedKeysCoherent(line(OLD) + "\n", 20003, pub)).toBe(false);
    // a rotated box that left its stale line behind: two lines for one port.
    expect(authorizedKeysCoherent(`${line(OLD)}\n${line(KEY)}\n`, 20003, pub)).toBe(false);
    expect(authorizedKeysCoherent("", 20003, pub)).toBe(false);
  });

  test("authorized-keys.map: one entry naming this box, port and key", () => {
    expect(mapCoherent(`grok-box-003\t20003\t${KEY}\n`, "grok-box-003", 20003, pub)).toBe(true);
    expect(mapCoherent(`grok-box-003\t20003\t${OLD}\n`, "grok-box-003", 20003, pub)).toBe(false);
    expect(mapCoherent(`grok-box-003\t20009\t${KEY}\n`, "grok-box-003", 20003, pub)).toBe(false);
    expect(mapCoherent("", "grok-box-003", 20003, pub)).toBe(false);
  });

  test("[fleet] block: names THIS vps and the right box_index, section-scoped", () => {
    const ok = '[box]\nvps = "other"\n\n[fleet]\nvps = "1.2.3.4"\nbox_index = 3\n';
    expect(fleetBlockCoherent(ok, "1.2.3.4", 3)).toBe(true);
    expect(fleetBlockCoherent(ok, "9.9.9.9", 3)).toBe(false);
    expect(fleetBlockCoherent(ok, "1.2.3.4", 4)).toBe(false);
    // a commented-out key is not an active one.
    expect(fleetBlockCoherent('[fleet]\n#vps = "1.2.3.4"\nbox_index = 3\n', "1.2.3.4", 3)).toBe(false);
    expect(fleetBlockCoherent("[other]\nvps = \"1.2.3.4\"\nbox_index = 3\n", "1.2.3.4", 3)).toBe(false);
  });

  test("keyMaterial reads the base64 field of both a restricted line and a bare pubkey", () => {
    expect(keyMaterial(line(KEY))).toBe(KEY);
    expect(keyMaterial(pub)).toBe(KEY);
    expect(keyMaterial("garbage")).toBe("");
  });

  test("boxup version parses `boxup x.y.z` and nothing else (P3)", () => {
    expect(parseBoxupVersion("boxup 5.3.0\n")).toBe("5.3.0");
    expect(parseBoxupVersion("sh: boxup: not found\n")).toBeUndefined();
    expect(parseBoxupVersion("")).toBeUndefined();
  });
});

// --- D4 backoff ---------------------------------------------------------------

describe("D4 backoff schedule", () => {
  test("1,2,4,8 … capped at 12 ticks", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(backoffTicks)).toEqual([1, 2, 4, 8, 12, 12, 12]);
    expect(backoffTicks(0)).toBe(0);
  });

  test("a failed adopt records the box, and the next tick inside the window skips it", async () => {
    const { state } = memState();
    const { deps, calls } = stubDeps({ async adopt() { return { rc: 1 }; } });
    const r1 = new DiscoverRun(deps, tickOpts(state, { tick: 5 }));
    await r1.adoptPass();
    r1.finish();
    expect(r1.summary.skipped).toEqual([{ name: "grok-box-003", reason: "enroll-rc1" }]);
    const led = state.readDiscoverLedger();
    expect(led).toHaveLength(1);
    expect(led[0]!.failures).toBe(1);
    expect(led[0]!.reason).toBe("enroll-rc1");

    // failures=1 ⇒ wait 1 tick. The SAME tick is still inside the window.
    const r2 = new DiscoverRun(deps, tickOpts(state, { tick: 5 }));
    await r2.adoptPass();
    expect(r2.summary.skipped).toEqual([{ name: "grok-box-003", reason: "backoff" }]);
    expect(calls.probes).toHaveLength(1); // no second probe inside the window

    // Tick 6 - last_tick 5 = 1 ⇒ the window has elapsed and it is retried.
    const r3 = new DiscoverRun(deps, tickOpts(state, { tick: 6 }));
    await r3.adoptPass();
    expect(calls.probes).toHaveLength(2);
  });

  test("success clears the record", async () => {
    const { state } = memState();
    state.writeDiscoverLedger([
      { name: "grok-box-003", last_attempt: 1, failures: 1, reason: "unreachable", last_tick: 1 },
    ]);
    const { deps } = stubDeps();
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 5 }));
    await run.adoptPass();
    run.finish();
    expect(state.readDiscoverLedger()).toEqual([]);
  });

  test("the ledger is pruned by age and capped in size", async () => {
    const { state } = memState();
    const old = { name: "gone", last_attempt: 1, failures: 9, reason: "unreachable", last_tick: 1 };
    const many = Array.from({ length: DISCOVER_MAX_RECORDS + 10 }, (_, i) => ({
      name: `grok-box-${100 + i}`,
      last_attempt: 1,
      failures: 1,
      reason: "unreachable",
      last_tick: 900 + i,
    }));
    state.writeDiscoverLedger([old, ...many]);
    const { deps } = stubDeps({ async listPeers() { return []; } });
    const tick = 1 + DISCOVER_PRUNE_TICKS + 1000;
    const run = new DiscoverRun(deps, tickOpts(state, { tick }));
    await run.adoptPass();
    run.finish();
    const after = state.readDiscoverLedger();
    expect(after.find((r) => r.name === "gone")).toBeUndefined(); // pruned by age
    expect(after.length).toBeLessThanOrEqual(DISCOVER_MAX_RECORDS);
  });
});

// --- P1 / P2 preflights -------------------------------------------------------

describe("P1/P2 preflights fail CLOSED", () => {
  test("no API token ⇒ every candidate skipped, ZERO ssh, no backoff record", async () => {
    const { state } = memState();
    const { deps, calls } = stubDeps({ apiToken: false });
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 5 }));
    await run.adoptPass();
    run.finish();
    expect(run.summary.skipped).toEqual([{ name: "grok-box-003", reason: "no-api-token" }]);
    expect(calls.probes).toEqual([]);
    expect(calls.adopts).toEqual([]);
    expect(state.readDiscoverLedger()).toEqual([]);
  });

  test("no box password ⇒ every candidate skipped, ZERO ssh, no backoff record", async () => {
    const { state } = memState();
    const { deps, calls } = stubDeps({ boxPassword: undefined });
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 5 }));
    await run.adoptPass();
    run.finish();
    expect(run.summary.skipped).toEqual([{ name: "grok-box-003", reason: "no-box-password" }]);
    expect(calls.probes).toEqual([]);
    expect(state.readDiscoverLedger()).toEqual([]);
  });
});

// --- D6 rails -----------------------------------------------------------------

describe("D6 safety rails", () => {
  test("D6b: an EMPTY hostname file is NO OPINION — install.sh's default adopts fine", async () => {
    const { state } = memState();
    const { deps, calls } = stubDeps({
      async probe() { return { reachable: true, hostname: "", boxup: "5.3.0" }; },
    });
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 5 }));
    await run.adoptPass();
    expect(calls.adopts).toEqual(["grok-box-003"]);
    expect(run.summary.adopted).toBe(1);
  });

  test("D6b: a NON-EMPTY hostname that disagrees with the tailscale name ⇒ name-mismatch", async () => {
    const { state } = memState();
    const { deps, calls } = stubDeps({
      async probe() { return { reachable: true, hostname: "grok-box-777", boxup: "5.3.0" }; },
    });
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 5 }));
    await run.adoptPass();
    expect(run.summary.skipped).toEqual([{ name: "grok-box-003", reason: "name-mismatch" }]);
    expect(calls.adopts).toEqual([]);
  });

  test("P3: unreachable ⇒ skip + backoff record; boxup missing ⇒ skip, no install path", async () => {
    const { state } = memState();
    const un = stubDeps({ async probe() { return { reachable: false, hostname: "", boxup: undefined }; } });
    const r1 = new DiscoverRun(un.deps, tickOpts(state, { tick: 5 }));
    await r1.adoptPass();
    r1.finish();
    expect(r1.summary.skipped).toEqual([{ name: "grok-box-003", reason: "unreachable" }]);
    expect(state.readDiscoverLedger()[0]!.reason).toBe("unreachable");

    const { state: s2 } = memState();
    const nb = stubDeps({ async probe() { return { reachable: true, hostname: "", boxup: undefined }; } });
    const r2 = new DiscoverRun(nb.deps, tickOpts(s2, { tick: 5 }));
    await r2.adoptPass();
    expect(r2.summary.skipped).toEqual([{ name: "grok-box-003", reason: "boxup-missing" }]);
    expect(nb.calls.adopts).toEqual([]);
  });

  test("D6c: the cap is ONE mutation per tick even with several eligible candidates", async () => {
    const { state } = memState();
    const { deps, calls } = stubDeps({
      async listPeers() { return [peer("grok-box-003"), peer("grok-box-004"), peer("grok-box-005")]; },
    });
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 5 }));
    await run.adoptPass();
    expect(calls.adopts).toEqual(["grok-box-003"]);
    expect(run.summary.adopted).toBe(1);
  });
});

// --- D4 read-only latch -------------------------------------------------------

describe("D4 read-only latch", () => {
  test("a tick that reports itself read-only never adopts, never repairs, records nothing", async () => {
    const { state } = memState();
    state.bumpRepairPending("grok-box-008", 5);
    state.bumpRepairPending("grok-box-008", 5);
    const { deps, calls } = stubDeps();
    const run = new DiscoverRun(
      deps,
      tickOpts(state, { tick: 5, readonly: true, membership: ["grok-box-008"] }),
    );
    await run.adoptPass();
    await run.repairPass();
    run.finish();
    expect(calls.probes).toEqual([]);
    expect(calls.adopts).toEqual([]);
    expect(calls.inspects).toEqual([]);
    expect(state.readDiscoverLedger()).toEqual([]);
    expect(logs.some((l) => l.includes("discover: skipped (readonly latch)"))).toBe(true);
  });
});

// --- D4 dry-run ---------------------------------------------------------------

describe("D4 dry-run", () => {
  test("dry-run prints `would adopt` for every eligible candidate and calls enroll ZERO times", async () => {
    const { state } = memState();
    const { deps, calls } = stubDeps({
      async listPeers() { return [peer("grok-box-003"), peer("grok-box-004")]; },
    });
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 5, apply: false }));
    await run.adoptPass();
    expect(calls.adopts).toEqual([]);
    expect(run.summary.adopted).toBe(0);
    expect(logs.filter((l) => l.includes("would adopt"))).toHaveLength(2);
    expect(logs.some((l) => l.includes("would adopt grok-box-003 (online, unenrolled, boxup 5.3.0)"))).toBe(true);
  });

  test("dry-run repair reports but never mutates", async () => {
    const { state } = memState();
    state.bumpRepairPending("grok-box-008", 5);
    state.bumpRepairPending("grok-box-008", 5);
    const { deps, calls } = stubDeps({ async listPeers() { return []; } });
    const run = new DiscoverRun(
      deps,
      tickOpts(state, { tick: 5, apply: false, membership: ["grok-box-008"] }),
    );
    await run.repairPass();
    expect(calls.inspects).toEqual(["grok-box-008"]);
    expect(calls.adopts).toEqual([]);
    expect(logs.some((l) => l.includes("repair: would repair grok-box-008"))).toBe(true);
  });
});

// --- D5 hysteresis ------------------------------------------------------------

describe("D5 hysteresis + per-consumer freshness", () => {
  test("one incoherent tick ⇒ NO repair; two consecutive ⇒ repair", async () => {
    const { state } = memState();
    const { deps, calls } = stubDeps({ async listPeers() { return []; } });

    state.bumpRepairPending("grok-box-008", 5); // runs = 1, stamped tick 5
    const r1 = new DiscoverRun(deps, tickOpts(state, { tick: 5, membership: ["grok-box-008"] }));
    await r1.repairPass();
    expect(calls.inspects).toEqual([]);

    state.bumpRepairPending("grok-box-008", 6); // runs = 2, stamped tick 6
    const r2 = new DiscoverRun(deps, tickOpts(state, { tick: 6, membership: ["grok-box-008"] }));
    await r2.repairPass();
    expect(calls.inspects).toEqual(["grok-box-008"]);
    expect(calls.adopts).toEqual(["grok-box-008"]);
    expect(r2.summary.repaired).toBe(1);
  });

  test("repair fires ONLY on a CURRENT-tick marker — a stale one is ignored", async () => {
    const { state } = memState();
    state.bumpRepairPending("grok-box-008", 4);
    state.bumpRepairPending("grok-box-008", 4); // runs 2 but stamped two ticks ago
    const { deps, calls } = stubDeps({ async listPeers() { return []; } });
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 6, membership: ["grok-box-008"] }));
    await run.repairPass();
    expect(calls.inspects).toEqual([]);
  });

  test("the marker RESETS TO 0 on a non-incoherent observation, so adopt is not parked", async () => {
    const { state } = memState();
    state.bumpRepairPending("grok-box-008", 4); // incoherent once
    state.resetRepairPending("grok-box-008", 5); // then asleep / tunnel up / API outage
    const { deps, calls } = stubDeps();
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 6, membership: ["grok-box-008"] }));
    await run.adoptPass();
    expect(calls.adopts).toEqual(["grok-box-003"]); // adoption proceeded
  });

  test("D6c yield: adopt defers to a PRECEDING-tick marker, and repair takes the slot", async () => {
    const { state } = memState();
    state.bumpRepairPending("grok-box-008", 5); // runs 1, stamped the preceding tick
    const { deps, calls } = stubDeps();
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 6, membership: ["grok-box-008"] }));
    await run.adoptPass();
    expect(calls.adopts).toEqual([]);
    expect(calls.probes).toEqual([]);
    expect(logs.some((l) => l.includes("adopt deferred (repair pending on grok-box-008)"))).toBe(true);

    // the loop then stamps the CURRENT tick with runs 2 ⇒ repair takes the slot.
    state.bumpRepairPending("grok-box-008", 6);
    await run.repairPass();
    expect(calls.adopts).toEqual(["grok-box-008"]);
    expect(run.summary.repaired).toBe(1);
  });

  test("adopt ignores a marker OLDER than the preceding tick (a stale one cannot park it)", async () => {
    const { state } = memState();
    state.bumpRepairPending("grok-box-008", 3);
    const { deps, calls } = stubDeps();
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 6, membership: ["grok-box-008"] }));
    await run.adoptPass();
    expect(calls.adopts).toEqual(["grok-box-003"]);
  });

  test("a coherent box on a due marker is inspected but NOT mutated", async () => {
    const { state } = memState();
    state.bumpRepairPending("grok-box-008", 5);
    state.bumpRepairPending("grok-box-008", 5);
    const { deps, calls } = stubDeps({
      async listPeers() { return []; },
      async inspect() { return { ok: true, coherent: true, reason: "coherent" }; },
    });
    const run = new DiscoverRun(deps, tickOpts(state, { tick: 5, membership: ["grok-box-008"] }));
    await run.repairPass();
    expect(calls.adopts).toEqual([]);
    expect(run.summary.repaired).toBe(0);
  });
});

// --- D6d budget ---------------------------------------------------------------

describe("D6d split budget", () => {
  test("canStart: a side stops STARTING work once its ceiling no longer fits its share", async () => {
    let now = 0;
    const b = new DiscoverBudget(() => now);
    expect(b.canStart("adopt", DISCOVER_PROBE_CEILING_MS)).toBe(true);
    await b.spend("adopt", async () => {
      now += DISCOVER_PROBE_CEILING_MS;
    });
    // 20 s of a 30 s share spent: a second 20 s probe would overrun it.
    expect(b.canStart("adopt", DISCOVER_PROBE_CEILING_MS)).toBe(false);
    // …and the repair reserve is untouched by what adopt spent.
    expect(b.canStart("repair", DISCOVER_PROBE_CEILING_MS)).toBe(true);
    expect(b.spent()).toEqual({ total: DISCOVER_PROBE_CEILING_MS, adopt: DISCOVER_PROBE_CEILING_MS, repair: 0 });
  });

  test("adopt cannot spend the repair reserve: three hanging candidates, repair still checks", async () => {
    const { state } = memState();
    let now = 0;
    const advance = (ms: number) => {
      now += ms;
    };
    state.bumpRepairPending("grok-box-008", 5);
    state.bumpRepairPending("grok-box-008", 5);
    const { deps, calls } = stubDeps({
      async listPeers() {
        advance(0);
        return [peer("grok-box-003"), peer("grok-box-004"), peer("grok-box-005")];
      },
      async probe(box) {
        calls.probes.push(box);
        advance(DISCOVER_PROBE_CEILING_MS); // every ssh hangs to its ceiling
        return { reachable: false, hostname: "", boxup: undefined };
      },
      async inspect(box) {
        calls.inspects.push(box);
        advance(DISCOVER_PROBE_CEILING_MS);
        return { ok: true, coherent: true, reason: "coherent" };
      },
    });
    const run = new DiscoverRun(
      deps,
      tickOpts(state, { tick: 5, membership: ["grok-box-008"], clock: () => now }),
    );
    await run.adoptPass();
    // 30 s share / 20 s ceiling ⇒ ONE probe fits; the rest are deferred.
    expect(calls.probes).toHaveLength(1);
    expect(now).toBeLessThanOrEqual(DISCOVER_ADOPT_BUDGET_MS);
    await run.repairPass();
    expect(calls.inspects).toEqual(["grok-box-008"]); // the reserve was intact
    expect(now).toBeLessThanOrEqual(DISCOVER_BUDGET_MS);
  });

  test("the accumulator only counts discover work — a slow membership loop costs it nothing", async () => {
    const { state } = memState();
    let now = 0;
    state.bumpRepairPending("grok-box-008", 5);
    state.bumpRepairPending("grok-box-008", 5);
    const { deps, calls } = stubDeps({
      async listPeers() { return []; },
      async inspect(box) {
        calls.inspects.push(box);
        return { ok: true, coherent: true, reason: "coherent" };
      },
    });
    const run = new DiscoverRun(
      deps,
      tickOpts(state, { tick: 5, membership: ["grok-box-008"], clock: () => now }),
    );
    await run.adoptPass();
    now += 120_000; // the membership loop takes two minutes
    await run.repairPass();
    expect(calls.inspects).toEqual(["grok-box-008"]); // repair still ran
  });
});
