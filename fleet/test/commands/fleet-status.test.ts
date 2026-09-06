// fleet-status.test.ts — T5 golden table + m13 (CHECK not probed when tunnel
// down) + API '?' on failure (D14).

import { describe, test, expect } from "bun:test";
import { fleetStatusRows, formatFleetStatus, cmdFleetStatus } from "../../src/commands/fleet-status.ts";
import { testEnv } from "../helpers.ts";
import { FakeRunner, isSs } from "../fake-runner.ts";
import type { Runner, RunOpts, RunResult } from "../../src/runner.ts";
import { keyStale } from "../../src/keystale.ts";

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
    // grok-box-3: tunnel up ⇒ CHECK OK, VERSION=sha abc1234.
    expect(rows[0]).toEqual({ box: "grok-box-3", api: "online", tunnel: "up", check: "OK", authkey: "2026-12-01", version: "abc1234" });
    // grok-box-5: tunnel down ⇒ CHECK '-' (NOT probed, m13), VERSION '-'.
    expect(rows[1]).toEqual({ box: "grok-box-5", api: "offline", tunnel: "down", check: "-", authkey: "-", version: "-" });
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
      { box: "grok-box-3", api: "online", tunnel: "up", check: "OK", authkey: "2026-12-01", version: "abc1234" },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("NAME           API     TUNNEL  CHECK   AUTHKEY      VERSION   ");
    expect(lines[1]).toBe("grok-box-3     online  up      OK      2026-12-01   abc1234   ");
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

// ---- r2/R2(a): the AUTHKEY column must never print a date the engine refuses ---
//
// The r1 gate, on the production VPS:
//
//   grok-box-011   offline up      OK      2026-11-28   ed2834e
//
// The key behind that date was minted seven days before the box's binding, the
// box had no secrets/ts-authkey at all, and mintWindowValid would refuse it the
// moment it were asked. A column that reads as reassurance while the thing it
// describes is dead is worse than a blank.
//
// Mutant: drop the `isStale(box) ?` branch in the row builder, or make
// keyStale() return false unconditionally. Both put the date back and fail here.
describe("A1/r2 — AUTHKEY prints `stale` for a key from a previous incarnation", () => {
  const staleRows = (stale: string[]) =>
    fleetStatusRows({
      runner: runnerFor(),
      env,
      devices: { async body() { return DEVICES; } },
      boxes: ["grok-box-3", "grok-box-5"],
      readExpires: () => "2026-11-28",
      keyStale: (b) => stale.includes(b),
    });

  test("a stale box shows `stale`, a healthy one still shows its date", async () => {
    const rows = await staleRows(["grok-box-3"]);
    expect(rows[0]!.authkey).toBe("stale");
    expect(rows[1]!.authkey).toBe("2026-11-28");
  });

  test("`stale` outranks the recorded date, and reaches the rendered table", async () => {
    const rows = await staleRows(["grok-box-3", "grok-box-5"]);
    const out = formatFleetStatus(rows);
    expect(out).not.toContain("2026-11-28");
    expect(out.split("\n")[1]).toContain("stale");
  });

  test("no staleness reader ⇒ the pre-r2 rendering (a date), never a crash", async () => {
    // The production reader fails open when there is no store: a read-only
    // surface must not be the thing that breaks when the database is absent.
    const rows = await fleetStatusRows({
      runner: runnerFor(),
      env,
      devices: { async body() { return DEVICES; } },
      boxes: ["grok-box-3"],
      readExpires: () => "2026-11-28",
    });
    expect(rows[0]!.authkey).toBe("2026-11-28");
  });

  test("a box with no key at all is still `-`, not `stale`", async () => {
    const rows = await fleetStatusRows({
      runner: runnerFor(),
      env,
      devices: { async body() { return DEVICES; } },
      boxes: ["grok-box-3"],
      readExpires: () => undefined,
      keyStale: () => false,
    });
    expect(rows[0]!.authkey).toBe("-");
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
