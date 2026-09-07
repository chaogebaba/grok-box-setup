// fleet-status.test.ts — T5 golden table + m13 (CHECK not probed when tunnel
// down) + API '?' on failure (D14).

import { describe, test, expect } from "bun:test";
import { fleetStatusRows, formatFleetStatus, cmdFleetStatus } from "../../src/commands/fleet-status.ts";
import { testEnv } from "../helpers.ts";
import { FakeRunner, isSs } from "../fake-runner.ts";
import type { Runner, RunOpts, RunResult } from "../../src/runner.ts";
import { keyStale, storeKeyStale, STALE_AUTHKEY, storeTickwedgeSeen } from "../../src/keystale.ts";
import { openStore, storePath } from "../../src/store/db.ts";
import { StoreState } from "../../src/store/state.ts";
import { suiteScratch, cleanup } from "../store/helpers.ts";
import { openReadHandle } from "../../src/store/membership.ts";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { afterAll } from "bun:test";

const env = testEnv();

// A2 (5.12.1): `connectedToControl`, not `online`. The devices API has never
// returned an `online` field (tailscale/tailscale#7004), so this fixture used to
// assert a table column that read `offline` for every box in production while
// the test said `online`.
const DEVICES = JSON.stringify({
  devices: [
    { hostname: "grok-box-3", connectedToControl: true, lastSeen: "2026-08-30T00:00:00Z" },
    { hostname: "grok-box-5", connectedToControl: false, lastSeen: "2026-08-29T00:00:00Z" },
  ],
});

// ss listener up ONLY for grok-box-3 (port 20003); grok-box-5 (20005) down.
function runnerFor(): FakeRunner {
  return new FakeRunner((argv) => {
    if (isSs(argv)) return { code: 0, stdout: "LISTEN 0 0 127.0.0.1:20003 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" };
    // any tunnel ssh: check OK, status line with a sha for the up box.
    const cmd = argv[argv.length - 1] ?? "";
    if (cmd.includes("boxup check")) return { code: 0 };
    if (cmd.includes("boxup status")) return { code: 0, stdout: "name=grok-box-3 v=5.3.0/abc1234 tunnel=up\n" };
    return { code: 0 };
  });
}

describe("T5 fleet-status (main:3410-3437, m13)", () => {
  test("rows: API from devices, CHECK/VERSION only when tunnel up (m13)", async () => {
    const runner = runnerFor();
    const rows = await fleetStatusRows({
      runner,
      env,
      devices: { async body() { return DEVICES; } },
      boxes: ["grok-box-3", "grok-box-5"],
      readExpires: (b) => (b === "grok-box-3" ? "2026-12-01" : undefined),
    });
    // grok-box-3: tunnel up ⇒ CHECK OK, VERSION=sha abc1234, COND `-` (a clean
    // status line carries no condition tokens).
    expect(rows[0]).toEqual({ box: "grok-box-3", api: "online", tunnel: "up", check: "OK", authkey: "2026-12-01", version: "abc1234", cond: "-" });
    // grok-box-5: tunnel down ⇒ CHECK '-' (NOT probed, m13), VERSION '-', COND '-'.
    expect(rows[1]).toEqual({ box: "grok-box-5", api: "offline", tunnel: "down", check: "-", authkey: "-", version: "-", cond: "-" });
    // m13: no boxup check/status ssh was ever issued for grok-box-5 (port 20005).
    const box5calls = runner.joined().filter((c) => c.includes("20005") || c.includes("grok-box-5"));
    expect(box5calls.filter((c) => c.includes("boxup"))).toEqual([]);
  });

  test("API '?' when the devices body is unavailable", async () => {
    const rows = await fleetStatusRows({
      runner: runnerFor(),
      env,
      devices: { async body() { return undefined; } },
      boxes: ["grok-box-3"],
      readExpires: () => undefined,
    });
    expect(rows[0]!.api).toBe("?");
  });

  test("golden header + row format", async () => {
    const out = formatFleetStatus([
      { box: "grok-box-3", api: "online", tunnel: "up", check: "OK", authkey: "2026-12-01", version: "abc1234", cond: "-" },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("NAME           API     TUNNEL  CHECK   AUTHKEY      VERSION    COND            ");
    expect(lines[1]).toBe("grok-box-3     online  up      OK      2026-12-01   abc1234    -               ");
  });

  test("golden row with populated COND (stateless names joined; stateful get ?)", async () => {
    const out = formatFleetStatus([
      { box: "grok-box-4", api: "online", tunnel: "up", check: "FAIL", authkey: "-", version: "abc1234", cond: "disk-warn,tick-wedged?" },
    ]);
    const lines = out.split("\n");
    // `disk-warn,tick-wedged?` is 22 chars — wider than the 16-col field, so it
    // overflows rather than truncating (pad only pads, never cuts).
    expect(lines[1]).toContain("disk-warn,tick-wedged?");
    expect(lines[1]).toStartWith("grok-box-4     online  up      FAIL");
  });

  test("COND: a disk=93%/fail status line yields disk-fail in the column", async () => {
    const runner = new FakeRunner((argv) => {
      if (isSs(argv)) return { code: 0, stdout: "LISTEN 0 0 127.0.0.1:20003 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" };
      const cmd = argv[argv.length - 1] ?? "";
      if (cmd.includes("boxup check")) return { code: 1 }; // disk=/fail flips check to FAIL
      if (cmd.includes("boxup status")) return { code: 0, stdout: "name=grok-box-3 v=5.3.0/abc1234 tunnel=up disk=93%/fail\n" };
      return { code: 0 };
    });
    const rows = await fleetStatusRows({
      runner,
      env,
      devices: { async body() { return DEVICES; } },
      boxes: ["grok-box-3"],
      readExpires: () => undefined,
    });
    expect(rows[0]!.cond).toBe("disk-fail");
  });

  test("cmdFleetStatus writes the table, rc 0", async () => {
    let out = "";
    const rc = await cmdFleetStatus(
      { runner: runnerFor(), env, devices: { async body() { return DEVICES; } }, boxes: ["grok-box-3"], readExpires: () => undefined },
      (s) => (out += s),
    );
    expect(rc).toBe(0);
    expect(out).toContain("NAME");
    expect(out).toContain("grok-box-3");
  });
});

// ---- A5 (5.12.1): the probes run in parallel ---------------------------------
//
// Each row costs a listener probe plus up to two 20 s ssh round trips, and the
// loop was SERIAL: eleven boxes with a couple unreachable left an operator
// staring at a blank terminal for minutes. The mutant these kill is the `for`
// loop coming back — it makes the first test's max-in-flight 1, and the wall
// clock in the second grows with the box count instead of the batch count.

/** A Runner whose every call takes one tick, recording peak concurrency. */
class ConcurrentRunner implements Runner {
  inFlight = 0;
  peak = 0;
  readonly order: string[] = [];
  constructor(private readonly delayMs = 5) {}
  async run(argv: string[], opts: RunOpts): Promise<RunResult> {
    void opts;
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    this.order.push(argv.join(" "));
    await new Promise((r) => setTimeout(r, this.delayMs));
    this.inFlight -= 1;
    if (isSs(argv)) {
      // every box's tunnel is up, so every row costs its two ssh probes
      const ports = [20002, 20003, 20005, 20008, 20011];
      return {
        code: 0,
        signal: null,
        timedOut: false,
        stderr: "",
        stdout: ports.map((p) => `LISTEN 0 0 127.0.0.1:${p} 0.0.0.0:* users:(("sshd",pid=41,fd=7))`).join("\n") + "\n",
      };
    }
    const cmd = argv[argv.length - 1] ?? "";
    const stdout = cmd.includes("boxup status") ? "name=x v=5.3.0/abc1234 tunnel=up\n" : "";
    return { code: 0, signal: null, timedOut: false, stderr: "", stdout };
  }
}

describe("A5 fleet-status probes concurrently", () => {
  const BOXES = ["grok-box-3", "grok-box-5", "grok-box-2", "grok-box-8", "grok-box-11"];

  test("more than one box is in flight at a time, and never more than four", async () => {
    const runner = new ConcurrentRunner();
    await fleetStatusRows({
      runner,
      env,
      devices: { async body() { return undefined; } },
      boxes: BOXES,
      readExpires: () => undefined,
    });
    expect(runner.peak).toBeGreaterThan(1); // the serial loop scores exactly 1
    expect(runner.peak).toBeLessThanOrEqual(4); // PROBE_CONCURRENCY
  });

  test("rows keep reconcile-target order, NOT a name sort", async () => {
    // `grok-box-11` sorts BEFORE `grok-box-3` lexicographically and AFTER it by
    // index. The table has always been in target order, so a re-sort by name
    // would silently reorder every operator's fleet.
    const rows = await fleetStatusRows({
      runner: new ConcurrentRunner(1),
      env,
      devices: { async body() { return undefined; } },
      boxes: BOXES,
      readExpires: () => undefined,
    });
    expect(rows.map((r) => r.box)).toEqual(BOXES);
  });

  test("five boxes cost far less wall time than five serial probes", async () => {
    const runner = new ConcurrentRunner(20);
    const t0 = Date.now();
    await fleetStatusRows({
      runner,
      env,
      devices: { async body() { return undefined; } },
      boxes: BOXES,
      readExpires: () => undefined,
    });
    const elapsed = Date.now() - t0;
    // Serial: 1 ss + 5 x 2 ssh x 20 ms = 220 ms. Four at a time: ~2 batches of
    // ssh pairs behind one ss probe, ~100 ms. The bound is loose on purpose —
    // this asserts the shape, not a stopwatch.
    expect(elapsed).toBeLessThan(200);
  });
});

// ---- r2/R2(a): the AUTHKEY column has THREE states, and they are distinct ----
//
// The r1 gate, on the production VPS:
//
//   grok-box-011   offline up      OK      2026-11-28   ed2834e
//
// The key behind that date was minted seven days before the box's binding, the
// box had no secrets/ts-authkey at all, and mintWindowValid would refuse it the
// moment it were asked. A column that reads as reassurance while the thing it
// describes is dead is worse than a blank one.
//
// The column already printed `-` for an absent expiry, and the production reader
// (`fsReadExpiresField2`) collapses EVERY failure to undefined — file missing,
// file unreadable, field 2 unparsable — so `-` already carries three different
// meanings. `stale` must therefore be distinguishable from `-` as well as from a
// date, or it just joins the pile of things `-` might mean. These cases assert
// the three states SEPARATELY, and assert the distinctness itself.
//
// Mutants: drop the `isStale(box) ?` branch in the row builder, or make
// keyStale() return false unconditionally. Both put the date back.
describe("A1/r2 — the AUTHKEY column's three states", () => {
  /** date / stale / absent, in one call, so the three cannot be confused. */
  function threeStateRows() {
    return fleetStatusRows({
      runner: runnerFor(),
      env,
      devices: { async body() { return DEVICES; } },
      boxes: ["grok-box-3", "grok-box-5", "grok-box-2"],
      // 3 has a date, 5 has a date the engine refuses, 2 has nothing recorded.
      readExpires: (b) => (b === "grok-box-2" ? undefined : "2026-11-28"),
      keyStale: (b) => b === "grok-box-5",
    });
  }

  test("all three states in ONE table, asserted separately", async () => {
    const rows = await threeStateRows();
    expect(rows.map((r) => r.authkey)).toEqual(["2026-11-28", "stale", "-"]);
  });

  test("the three states are three DISTINCT strings", async () => {
    const rows = await threeStateRows();
    const [date, stale, none] = rows.map((r) => r.authkey);
    expect(new Set([date, stale, none]).size).toBe(3);
    // `stale` is neither the empty marker nor anything a date parser accepts —
    // a reader scanning the column can tell the three apart without context.
    expect(stale).toBe(STALE_AUTHKEY);
    expect(stale).not.toBe("-");
    expect(stale).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(stale!))).toBe(true);
  });

  test("all three survive into the rendered table, one per row", async () => {
    const lines = formatFleetStatus(await threeStateRows()).split("\n");
    expect(lines[1]).toContain("2026-11-28");
    expect(lines[2]).toContain("stale");
    expect(lines[2]).not.toContain("2026-11-28");
    // The absent row carries neither a date nor the stale marker.
    expect(lines[3]).not.toContain("2026-11-28");
    expect(lines[3]).not.toContain("stale");
  });

  test("a PROBE FAILURE reads `-`, never `stale`", async () => {
    // `fsReadExpiresField2` catches everything and returns undefined, so an
    // unreadable or unparsable `<box>.expires` is indistinguishable from an
    // absent one at this seam — all three render `-`. What must never happen is
    // a failed read being reported as `stale`: staleness is a claim about a key
    // the store KNOWS about, and "I could not read the file" is not that claim.
    const rows = await fleetStatusRows({
      runner: runnerFor(),
      env,
      devices: { async body() { return DEVICES; } },
      boxes: ["grok-box-3"],
      readExpires: () => undefined, // the reader's only failure signal
      keyStale: () => false,
    });
    expect(rows[0]!.authkey).toBe("-");
    expect(rows[0]!.authkey).not.toBe(STALE_AUTHKEY);
  });

  test("a STALE box with no recorded expiry still reads `stale`, not `-`", async () => {
    // The two conditions coincide in exactly the case that matters: a re-imaged
    // box whose export was already cleared. `stale` has to outrank the empty
    // marker as well as the date, or the most informative state is the one that
    // disappears.
    const rows = await fleetStatusRows({
      runner: runnerFor(),
      env,
      devices: { async body() { return DEVICES; } },
      boxes: ["grok-box-3"],
      readExpires: () => undefined,
      keyStale: () => true,
    });
    expect(rows[0]!.authkey).toBe("stale");
  });

  test("no staleness reader ⇒ the pre-r2 rendering, never a crash", async () => {
    // The production reader fails open when there is no store: a read-only
    // surface must not be the thing that breaks when the database is absent.
    const rows = await fleetStatusRows({
      runner: runnerFor(),
      env,
      devices: { async body() { return DEVICES; } },
      boxes: ["grok-box-3", "grok-box-2"],
      readExpires: (b) => (b === "grok-box-2" ? undefined : "2026-11-28"),
    });
    expect(rows.map((r) => r.authkey)).toEqual(["2026-11-28", "-"]);
  });
});

// The column and the engine ask ONE function, so they cannot drift apart.
describe("r2 — keyStale is the same predicate mintWindowValid uses", () => {
  const times = (minted: number | undefined, bound: number | undefined) => ({
    keyMintedAt: () => minted,
    bindingAt: () => bound,
  });

  test("minted before the binding ⇒ stale", () => {
    expect(keyStale(times(100, 200), "grok-box-3")).toBe(true);
  });
  test("minted at or after the binding ⇒ not stale", () => {
    expect(keyStale(times(200, 200), "grok-box-3")).toBe(false);
    expect(keyStale(times(300, 200), "grok-box-3")).toBe(false);
  });
  test("either instant unknown ⇒ NOT stale (a legacy-imported row must not light up)", () => {
    expect(keyStale(times(undefined, 200), "grok-box-3")).toBe(false);
    expect(keyStale(times(100, undefined), "grok-box-3")).toBe(false);
    expect(keyStale(times(undefined, undefined), "grok-box-3")).toBe(false);
  });
});

// ---- r2: the PRODUCTION wiring, store row to boolean -------------------------
//
// Every rendering case above injects `keyStale`, which is right for testing the
// column but leaves the seam that connects the two untested — and a seam that
// silently answers "false for everything" would put the dates back with every
// rendering test still green. This drives `storeKeyStale` against a REAL store.
const WSCRATCH = suiteScratch("fleet-status-store");
afterAll(() => WSCRATCH.clean());

describe("r2 — storeKeyStale reads the real store", () => {
  const DAY = 86_400;
  const T = 1_780_000_000;

  function seed(prefix: string, rows: Array<{ box: string; idx: number; minted: number; bound: number }>) {
    const dir = WSCRATCH.dir(prefix);
    const state = `${dir}/state`;
    const store = openStore({ path: storePath(state), dir: state, now: () => T });
    const st = new StoreState(store);
    for (const r of rows) {
      st.recordEnrolled(r.box, 20000 + r.idx, `AAAAKEY${r.idx}`);
      st.recordKey(r.box, { keyId: `k${r.idx}`, expiresRaw: "2026-11-28T00:00:00Z", expiresDate: "2026-11-28" });
      store.db.query("UPDATE boxes SET enrolled_at=? WHERE name=?").run(r.bound, r.box);
      store.db
        .query("UPDATE box_keys SET minted_at=? WHERE box_id=(SELECT box_id FROM boxes WHERE name=?)")
        .run(r.minted, r.box);
    }
    store.close();
    return { dir, state };
  }

  test("a key minted before the binding is stale; one minted after is not", () => {
    const f = seed("mixed", [
      { box: "grok-box-011", idx: 11, minted: T, bound: T + 7 * DAY }, // re-imaged
      { box: "grok-box-008", idx: 8, minted: T + 7 * DAY, bound: T }, // healthy
    ]);
    try {
      const isStale = storeKeyStale(testEnv({ FLEET_STATE: f.state }), ["grok-box-011", "grok-box-008"]);
      expect(isStale("grok-box-011")).toBe(true);
      expect(isStale("grok-box-008")).toBe(false);
      // A box that was never asked about is not claimed either way.
      expect(isStale("grok-box-099")).toBe(false);
    } finally {
      cleanup(f.dir);
    }
  });

  // r4/N4 — the fail-open catch, and the ONLY input that reaches it.
  //
  // The r3 gate found that replacing storeKeyStale's `catch` with a rethrow
  // passed the whole suite. The hypothesis was that the catch guards a store
  // file that exists but cannot be OPENED. It does not: `openStore` wraps every
  // open-time failure — a directory where the file should be, a non-database
  // file, unwritable pragmas — in `ConfigError`, and `openReadHandle` swallows
  // exactly that class and returns a file-backed handle with `store` undefined.
  // I verified all three of those inputs; none throws, and the "no store" case
  // below already covers where they land.
  //
  // What DOES escape is a store that OPENS cleanly, reports a schema version
  // this binary knows, and then throws on the first QUERY — `no such table:
  // box_keys` from a truncated file, an interrupted `state restore`, or a
  // hand-made database. That throw happens inside the per-box loop, and without
  // the catch it propagates out of `grokfleet fleet-status` and takes the whole
  // table with it. This is the surface an operator reaches for WHEN something is
  // wrong, so it has to render what it can (F7.2).
  function corruptStore(prefix: string): { dir: string; state: string } {
    const dir = WSCRATCH.dir(prefix);
    const state = `${dir}/state`;
    mkdirSync(state, { recursive: true });
    // Opens fine, claims schema v4, and `box_keys` is simply not there.
    const db = new Database(`${state}/fleet.db`, { create: true });
    db.run("PRAGMA user_version = 4");
    db.run("CREATE TABLE boxes(box_id INTEGER PRIMARY KEY, name TEXT, idx INTEGER, port INTEGER, enrolled_at INTEGER)");
    db.run("INSERT INTO boxes VALUES(1,'grok-box-011',11,20011,200)");
    db.close();
    return { dir, state };
  }

  test("N4: a store that opens but cannot be QUERIED throws — and is caught", () => {
    const f = corruptStore("corrupt-probe");
    try {
      // First prove the premise rather than assume it: the read really does
      // throw, so the catch below is not guarding a path that cannot happen.
      const h = openReadHandle(testEnv({ FLEET_STATE: f.state }));
      expect(h.store).toBeDefined();
      expect(() => keyStale(h.state, "grok-box-011")).toThrow();
      h.close();

      // ...and storeKeyStale absorbs it into "no staleness claim".
      const isStale = storeKeyStale(testEnv({ FLEET_STATE: f.state }), ["grok-box-011"]);
      expect(isStale("grok-box-011")).toBe(false);
    } finally {
      cleanup(f.dir);
    }
  });

  test("N4: the table still renders, AUTHKEY `-`, rc 0", async () => {
    const f = corruptStore("corrupt-render");
    try {
      const e = testEnv({ FLEET_STATE: f.state });
      const rows = await fleetStatusRows({
        runner: runnerFor(),
        env: e,
        devices: { async body() { return undefined; } },
        boxes: ["grok-box-011"],
        readExpires: () => undefined,
      });
      expect(rows[0]!.authkey).toBe("-");

      // The whole command, not just the row builder: rc 0 and a real table.
      let out = "";
      const rc = await cmdFleetStatus(
        {
          runner: runnerFor(),
          env: e,
          devices: { async body() { return undefined; } },
          boxes: ["grok-box-011"],
          readExpires: () => undefined,
        },
        (x) => (out += x),
      );
      expect(rc).toBe(0);
      expect(out).toContain("NAME");
      expect(out).toContain("grok-box-011");
    } finally {
      cleanup(f.dir);
    }
  });

  test("no store at all ⇒ nothing is stale, and nothing throws", () => {
    // The read-only surface must render rather than fail when the database is
    // absent — the window before the first tick creates it (F7.2).
    const isStale = storeKeyStale(testEnv({ FLEET_STATE: "/nonexistent/fleet-state" }), ["grok-box-011"]);
    expect(isStale("grok-box-011")).toBe(false);
  });

  test("end to end: the store row alone turns the column to `stale`", async () => {
    // No injected keyStale anywhere — the seam, the predicate and the renderer
    // together, which is the combination production runs.
    const f = seed("e2e", [{ box: "grok-box-011", idx: 11, minted: T, bound: T + 7 * DAY }]);
    try {
      const e = testEnv({ FLEET_STATE: f.state });
      const rows = await fleetStatusRows({
        runner: runnerFor(),
        env: e,
        devices: { async body() { return undefined; } },
        boxes: ["grok-box-011"],
        readExpires: () => "2026-11-28",
      });
      expect(rows[0]!.authkey).toBe("stale");
    } finally {
      cleanup(f.dir);
    }
  });
});


// ---- 5.14.2: the COND column stops printing a stale latched `tick-wedged?` ---
//
// The incident: `$RUN_DIR/tickwedge` is never reset by boxup, so grok-box-007
// has carried `tickwedge=1` since one genuine wedge on 2026-09-04. The
// reconciler's stateful delta (alerts.ts §3) correctly treats it as seen-and-
// stale, but the COND column read the RAW token and printed `tick-wedged?`
// forever — a live-looking warning about a healthy box. fleet-status now
// consults the store's recorded high-water (`tickwedge_seen`) the same read-
// only, fail-open way AUTHKEY consults staleness, and applies §3's rule.
//
// Cases mirror the brief: (a) seen=1,raw=1 ⇒ no entry; (b) seen=1,raw=2 ⇒
// `tick-wedged`; (c) seen=null ⇒ `tick-wedged?`; (d) no store ⇒ `tick-wedged?`;
// (e) the store throws ⇒ `tick-wedged?` AND the table still renders.

/** A runner whose up box (grok-box-3) reports `tickwedge=N` in its status line. */
function runnerWithWedge(n: number): FakeRunner {
  return new FakeRunner((argv) => {
    if (isSs(argv)) return { code: 0, stdout: "LISTEN 0 0 127.0.0.1:20003 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" };
    const cmd = argv[argv.length - 1] ?? "";
    if (cmd.includes("boxup check")) return { code: 0 };
    if (cmd.includes("boxup status")) return { code: 0, stdout: `name=grok-box-3 v=5.3.0/abc1234 tunnel=up tickwedge=${n}\n` };
    return { code: 0 };
  });
}

describe("5.14.2 — COND tick-wedged consults tickwedge_seen (injected reader)", () => {
  async function condFor(raw: number, seen: number | null | undefined, injectReader = true): Promise<string> {
    const rows = await fleetStatusRows({
      runner: runnerWithWedge(raw),
      env,
      devices: { async body() { return DEVICES; } },
      boxes: ["grok-box-3"],
      readExpires: () => undefined,
      // when injectReader is false we DON'T pass tickwedgeSeen: exercises the
      // production default against `env` (which has no store) ⇒ undefined ⇒ `?`.
      ...(injectReader ? { tickwedgeSeen: () => seen } : {}),
    });
    return rows[0]!.cond;
  }

  test("(a) seen=1, raw=1 ⇒ COND has NO tick-wedged entry (seen-and-stale)", async () => {
    const cond = await condFor(1, 1);
    expect(cond).not.toContain("tick-wedged");
    expect(cond).not.toContain("tick-wedged?");
    // A clean line but for the stale counter ⇒ nothing else ⇒ `-`.
    expect(cond).toBe("-");
  });

  test("(b) seen=1, raw=2 ⇒ `tick-wedged` (a real increase, no `?`)", async () => {
    const cond = await condFor(2, 1);
    expect(cond).toContain("tick-wedged");
    expect(cond).not.toContain("tick-wedged?");
  });

  test("(c) seen=null (never recorded) ⇒ `tick-wedged?` (fail-open)", async () => {
    const cond = await condFor(1, null);
    expect(cond).toContain("tick-wedged?");
    expect(cond).not.toBe("tick-wedged"); // must keep the `?`
  });

  test("(d) no store (production default, empty env) ⇒ `tick-wedged?`", async () => {
    const cond = await condFor(1, undefined, /* injectReader */ false);
    expect(cond).toContain("tick-wedged?");
  });
});

const WEDGE_SCRATCH = suiteScratch("fleet-status-tickwedge");
afterAll(() => WEDGE_SCRATCH.clean());

describe("5.14.2 — storeTickwedgeSeen reads the real store (the seam)", () => {
  function seedWedge(prefix: string, rows: Array<{ box: string; idx: number; seen?: number }>): { dir: string; state: string } {
    const dir = WEDGE_SCRATCH.dir(prefix);
    const state = `${dir}/state`;
    const store = openStore({ path: storePath(state), dir: state });
    const st = new StoreState(store);
    for (const r of rows) {
      st.recordEnrolled(r.box, 20000 + r.idx, `AAAAKEY${r.idx}`);
      if (r.seen !== undefined) st.setTickwedge(r.box, r.seen); // absent ⇒ null (never recorded)
    }
    store.close();
    return { dir, state };
  }

  test("a recorded high-water reads back as a number; an enrolled box never recorded reads null", () => {
    const f = seedWedge("mixed", [
      { box: "grok-box-007", idx: 7, seen: 1 }, // the incident box: recorded 1
      { box: "grok-box-008", idx: 8 }, // enrolled, tickwedge never recorded
    ]);
    try {
      const seen = storeTickwedgeSeen(testEnv({ FLEET_STATE: f.state }), ["grok-box-007", "grok-box-008", "grok-box-099"]);
      expect(seen("grok-box-007")).toBe(1);
      expect(seen("grok-box-008")).toBe(null);
      // A box the store has never heard of: also null (boxId undefined).
      expect(seen("grok-box-099")).toBe(null);
    } finally {
      cleanup(f.dir);
    }
  });

  test("no store at all ⇒ undefined (fail-open ⇒ `?`), nothing throws", () => {
    const seen = storeTickwedgeSeen(testEnv({ FLEET_STATE: "/nonexistent/fleet-state" }), ["grok-box-007"]);
    expect(seen("grok-box-007")).toBeUndefined();
  });

  // (e) — a store that opens but throws on the query: fail-open to undefined,
  // and the whole table still renders rc 0. Same corrupt-store construction as
  // the AUTHKEY N4 case: schema v4, no box_counters table ⇒ lastTickwedge's
  // SELECT throws `no such table: box_counters`.
  function corruptCountersStore(prefix: string): { dir: string; state: string } {
    const dir = WEDGE_SCRATCH.dir(prefix);
    const state = `${dir}/state`;
    mkdirSync(state, { recursive: true });
    const db = new Database(`${state}/fleet.db`, { create: true });
    db.run("PRAGMA user_version = 4");
    db.run("CREATE TABLE boxes(box_id INTEGER PRIMARY KEY, name TEXT, idx INTEGER, port INTEGER, enrolled_at INTEGER)");
    db.run("INSERT INTO boxes VALUES(1,'grok-box-007',7,20007,200)");
    // deliberately NO box_counters table ⇒ the tickwedge SELECT throws.
    db.close();
    return { dir, state };
  }

  test("(e) a store that throws on the query ⇒ undefined, and the premise holds", () => {
    const f = corruptCountersStore("throw-probe");
    try {
      const e = testEnv({ FLEET_STATE: f.state });
      // Premise: the read really throws (so the catch below is load-bearing).
      const h = openReadHandle(e);
      expect(h.store).toBeDefined();
      expect(() => h.state.lastTickwedge("grok-box-007")).toThrow();
      h.close();
      // storeTickwedgeSeen absorbs it: undefined for every box ⇒ fail-open `?`.
      const seen = storeTickwedgeSeen(e, ["grok-box-007"]);
      expect(seen("grok-box-007")).toBeUndefined();
    } finally {
      cleanup(f.dir);
    }
  });

  test("(e) the table still renders `tick-wedged?` and rc 0 when the store throws", async () => {
    const f = corruptCountersStore("throw-render");
    try {
      const e = testEnv({ FLEET_STATE: f.state });
      // Production default reader (no injected tickwedgeSeen) against the
      // throwing store. raw=1 from the status line, undefined seen ⇒ `?`.
      const rows = await fleetStatusRows({
        runner: runnerWithWedge(1),
        env: e,
        devices: { async body() { return DEVICES; } },
        boxes: ["grok-box-3"],
        readExpires: () => undefined,
      });
      expect(rows[0]!.cond).toContain("tick-wedged?");

      let out = "";
      const rc = await cmdFleetStatus(
        { runner: runnerWithWedge(1), env: e, devices: { async body() { return DEVICES; } }, boxes: ["grok-box-3"], readExpires: () => undefined },
        (x) => (out += x),
      );
      expect(rc).toBe(0);
      expect(out).toContain("NAME");
      expect(out).toContain("tick-wedged?");
    } finally {
      cleanup(f.dir);
    }
  });

  // end-to-end: the store row alone (no injected reader) turns 007's stale
  // counter into a blank COND — the whole point of the change.
  test("end to end: seen=1 + raw=1 renders COND `-`, no injected reader", async () => {
    const f = seedWedge("e2e", [{ box: "grok-box-3", idx: 3, seen: 1 }]);
    try {
      const e = testEnv({ FLEET_STATE: f.state });
      const rows = await fleetStatusRows({
        runner: runnerWithWedge(1),
        env: e,
        devices: { async body() { return DEVICES; } },
        boxes: ["grok-box-3"],
        readExpires: () => undefined,
      });
      expect(rows[0]!.cond).toBe("-");
    } finally {
      cleanup(f.dir);
    }
  });
});
