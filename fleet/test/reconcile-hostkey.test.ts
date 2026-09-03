// reconcile-hostkey.test.ts — D11(c) inside the tick: the one-tick mismatch
// marker, the D5 predicate it feeds, the tunnel-write gate on every writing row,
// the config-pass deferral and the squatter's "tunnel down on every path".
//
// The failure this file pins is empirical r2: a box whose identity changed under
// a reused port made every tunnel call rc 255, so mint seeded nothing and
// revoked the key it had just minted — every tick, forever.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  runReconcile,
  actionLabel,
  TUNNEL_WRITING_ACTIONS,
  type ReconcileDeps,
} from "../src/reconcile/run.ts";
import { ReconcileState, type StateFs } from "../src/reconcile/state.ts";
import { RunContext, TailscaleKeys, type KeyTransport } from "../src/reconcile/tailscale-keys.ts";
import type { DiscoverDeps } from "../src/reconcile/discover.ts";
import { FakeRunner, result, isSs, isScp } from "./fake-runner.ts";
import { testEnv, testRollout } from "./helpers.ts";
import { setLogSink } from "../src/log.ts";
import { CHECK_COMMAND, STATUS_COMMAND } from "../src/remote.ts";
import type { ManagedSource } from "../src/actions/config-push.ts";
import type { UpgradeDeps } from "../src/upgrade.ts";

const BOX = "grok-box-008";
const PORT = 20008;
const BANNER = "@@@@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n@@@@@@\n";

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
    rename: () => {},
    exists: (p) => store.has(p),
    tmpname: (d, p) => `${d}/${p}x`,
  };
  return { state: new ReconcileState("/s", fs), store };
}

const noManaged: ManagedSource & { present: false } = {
  present: false,
  fleetToml: () => undefined,
  boxToml: () => undefined,
};

function ssRow(port: number, owner = 'users:(("sshd",pid=41,fd=7))'): string {
  return `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:* ${owner}\n`;
}

/** The devices body that makes a box ONLINE and FRESH (no row a, no row e). */
function devsOnline(box: string, nowSec: number): string {
  return JSON.stringify({
    devices: [{ hostname: box, online: true, lastSeen: new Date(nowSec * 1000).toISOString() }],
  });
}

/** The devices body that makes a box OFFLINE (row a with the tunnel up). */
function devsOffline(box: string): string {
  return JSON.stringify({ devices: [{ hostname: box, online: false, lastSeen: "2000-01-01T00:00:00Z" }] });
}

const NOW = Date.parse("2099-01-01T00:00:00Z") / 1000;

interface Opts {
  devs: string;
  /** true ⇒ the check ssh answers with the banner (rc 255). */
  banner: boolean;
  state?: ReconcileState;
  apply?: boolean;
  targetSha?: string;
  checkSha?: string;
  managed?: boolean;
  listener?: string;
  over?: Partial<ReconcileDeps>;
}

function tickDeps(o: Opts): { deps: ReconcileDeps; runner: FakeRunner; state: ReconcileState } {
  const state = o.state ?? memState().state;
  const transport: KeyTransport = { async request() { return { code: 200, body: o.devs }; } };
  const ctx = new RunContext();
  const runner = new FakeRunner((argv) => {
    if (isSs(argv)) return result({ stdout: ssRow(PORT, o.listener) });
    const cmd = argv[argv.length - 1] ?? "";
    if (o.banner && argv[0] === "ssh") return result({ code: 255, stderr: BANNER });
    if (cmd === CHECK_COMMAND) {
      return result({ code: 0, stdout: `check=OK v=5.3.0/${o.checkSha ?? "abc1234"} tunnel=up` });
    }
    if (cmd === STATUS_COMMAND) return result({ code: 0, stdout: `v=5.3.0/${o.checkSha ?? "abc1234"} tunnel=up` });
    return result({ code: 0, stdout: "cur=X want=X support=yes enabled=true" });
  });
  const managedSource: ManagedSource = o.managed
    ? { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined }
    : noManaged;
  const deps: ReconcileDeps = {
    runner,
    env: testEnv(),
    rollout: testRollout(),
    state,
    keys: new TailscaleKeys(transport, "https://api", "-", "PAT", ctx),
    ctx,
    notify: () => {},
    targetBoxes: [BOX],
    configCanary: undefined,
    managedSource,
    managedFilesPresent: o.managed === true,
    upgradeDeps: {} as UpgradeDeps,
    targetSha: o.targetSha,
    targetVersion: undefined,
    apply: o.apply ?? true,
    nowSec: NOW,
    ...o.over,
  };
  return { deps, runner, state };
}

// --- the marker ---------------------------------------------------------------

describe("D11(c) the mismatch marker has ONE-TICK memory", () => {
  test("set on a mismatch tick, with the refusal line carrying the run count", async () => {
    const { deps, state } = tickDeps({ devs: devsOnline(BOX, NOW), banner: true });
    await runReconcile(deps);
    expect(state.readHostkeyMismatch(BOX)).toBe(true);
    expect(
      logs.some((l) => l.includes(`hostkey: ${BOX} host key changed on [127.0.0.1]:${PORT} — refusing until repair re-binds (n=1)`)),
    ).toBe(true);
  });

  test("cleared on the next CLEAN tick (kills mutant q)", async () => {
    const { state } = memState();
    await runReconcile(tickDeps({ devs: devsOnline(BOX, NOW), banner: true, state }).deps);
    expect(state.readHostkeyMismatch(BOX)).toBe(true);
    await runReconcile(tickDeps({ devs: devsOnline(BOX, NOW), banner: false, state }).deps);
    expect(state.readHostkeyMismatch(BOX)).toBe(false);
  });

  test("cleared on a TUNNEL-DOWN tick, which makes no tunnel call at all", async () => {
    const { state } = memState();
    await runReconcile(tickDeps({ devs: devsOnline(BOX, NOW), banner: true, state }).deps);
    expect(state.readHostkeyMismatch(BOX)).toBe(true);
    const down = tickDeps({ devs: devsOnline(BOX, NOW), banner: false, state });
    down.runner.setResponder((argv) => (isSs(argv) ? result({ stdout: "" }) : result({ code: 0 })));
    await runReconcile(down.deps);
    expect(state.readHostkeyMismatch(BOX)).toBe(false);
  });

  test("a bare rc-255 without the banner is NOT a mismatch", async () => {
    const { deps, runner, state } = tickDeps({ devs: devsOnline(BOX, NOW), banner: false });
    runner.setResponder((argv) =>
      isSs(argv) ? result({ stdout: ssRow(PORT) }) : result({ code: 255, stderr: "Connection refused" }),
    );
    await runReconcile(deps);
    expect(state.readHostkeyMismatch(BOX)).toBe(false);
  });
});

// --- the D5 predicate ---------------------------------------------------------

describe("D5 hysteresis is driven by row e OR the mismatch (kills mutant n)", () => {
  test("two consecutive MISMATCH ticks reach 2 with the tunnel UP throughout", async () => {
    const { state } = memState();
    await runReconcile(tickDeps({ devs: devsOnline(BOX, NOW), banner: true, state }).deps);
    expect(state.readRepairPending(BOX)!.runs).toBe(1);
    await runReconcile(tickDeps({ devs: devsOnline(BOX, NOW), banner: true, state }).deps);
    const m = state.readRepairPending(BOX)!;
    expect(m.runs).toBe(2);
    expect(m.tick).toBe(2);
    // The tunnel really was up on both ticks — this is not row e in disguise.
    expect(logs.some((l) => l.includes("incoherent-both-dead"))).toBe(false);
  });

  test("ONE mismatch tick then a clean tick ⇒ the counter resets to 0", async () => {
    const { state } = memState();
    await runReconcile(tickDeps({ devs: devsOnline(BOX, NOW), banner: true, state }).deps);
    await runReconcile(tickDeps({ devs: devsOnline(BOX, NOW), banner: false, state }).deps);
    expect(state.readRepairPending(BOX)!.runs).toBe(0);
  });

  test("row e ALONE still bumps the counter exactly as before", async () => {
    const { state } = memState();
    const t = tickDeps({ devs: devsOnline(BOX, NOW), banner: false, state });
    t.runner.setResponder((argv) => (isSs(argv) ? result({ stdout: "" }) : result({ code: 0 })));
    await runReconcile(t.deps);
    expect(state.readRepairPending(BOX)!.runs).toBe(1);
    expect(logs.some((l) => l.includes("hostkey:"))).toBe(false);
  });

  test("a mismatch tick fires NO alert — the journal line is the operator's signal", async () => {
    const notes: string[] = [];
    const { deps } = tickDeps({
      devs: devsOnline(BOX, NOW),
      banner: true,
      over: { notify: (_l, m) => { notes.push(m); } },
    });
    await runReconcile(deps);
    expect(notes).toHaveLength(0);
  });
});

// --- the tunnel-write gate ----------------------------------------------------

describe("D11(c) tunnel-write gate (kills mutant s, one row at a time)", () => {
  /** Every remote command grokfleet sent over the tunnel this tick. */
  function remoteCmds(runner: FakeRunner): string[] {
    return runner.argvs().filter((a) => a[0] === "ssh").map((a) => a[a.length - 1] ?? "");
  }

  test("row a: NO mint argv, the deferral line, and check/status STILL spawned", async () => {
    const { deps, runner } = tickDeps({ devs: devsOffline(BOX), banner: true });
    await runReconcile(deps);
    expect(logs.some((l) => l.endsWith(`mint-key: ${BOX} deferred — host key mismatch`))).toBe(true);
    const cmds = remoteCmds(runner);
    // the READ-ONLY calls still run — the observation that feeds the marker is
    // made by them, so gating them would make the heal impossible.
    expect(cmds).toContain(CHECK_COMMAND);
    // and EXACTLY once: no member tunnel call is ever retried after a banner
    // (kills mutant p) — a retry would double every rc-255 the tick already has.
    expect(cmds.filter((c) => c === CHECK_COMMAND)).toHaveLength(1);
    // and nothing that seeds a key was sent.
    expect(cmds.some((c) => c.includes("authorized_keys") || c.includes("boxup once"))).toBe(false);
    expect(logs.some((l) => l.includes("seeded"))).toBe(false);
    expect(logs.some((l) => l.includes("REVOKING"))).toBe(false);
  });

  test("row c: a rotate INSIDE the expiry window is deferred, no mint argv", async () => {
    const { state } = memState();
    // .expires 3 days out ⇒ row c; the box is online+fresh so row a does not fire.
    state.writeExpires(BOX, new Date((NOW + 3 * 86400) * 1000).toISOString().slice(0, 10));
    const { deps, runner } = tickDeps({ devs: devsOnline(BOX, NOW), banner: true, state });
    await runReconcile(deps);
    expect(logs.some((l) => l.endsWith(`rotate: ${BOX} deferred — host key mismatch`))).toBe(true);
    expect(remoteCmds(runner).some((c) => c.includes("authorized_keys"))).toBe(false);
  });

  test("row d: the gate names `rollout`, and a mismatch tick spawns no scp", async () => {
    // Row d cannot be reached WITH a live banner through the real pipeline: the
    // banner makes the check and status calls fail, so the box sha is unknown
    // and `drift` is unknown, which is what row d needs. The gate is therefore
    // asserted on the SET the loop consults — removing `rollout` from it (mutant
    // s, row d) fails right here — plus the end-to-end "no scp" property.
    expect(TUNNEL_WRITING_ACTIONS.has("rollout")).toBe(true);
    expect(actionLabel("rollout")).toBe("rollout");
    const { deps, runner } = tickDeps({
      devs: devsOnline(BOX, NOW),
      banner: true,
      targetSha: "targetsha",
      checkSha: "boxsha",
    });
    await runReconcile(deps);
    expect(runner.argvs().some(isScp)).toBe(false);
  });

  test("the gate names every writing row and NO read-only one (kills mutant s)", () => {
    expect([...TUNNEL_WRITING_ACTIONS].sort()).toEqual([
      "delete-then-rename",
      "mint",
      "rollout",
      "rotate",
    ]);
    // the seed path logs under its own name, which the canary greps for
    expect(actionLabel("mint")).toBe("mint-key");
    expect(actionLabel("rotate")).toBe("rotate");
    // read-only observations are not actions and must never appear here
    expect(TUNNEL_WRITING_ACTIONS.has("noop")).toBe(false);
    expect(TUNNEL_WRITING_ACTIONS.has("alert-asleep")).toBe(false);
  });

  test("row b: delete-then-rename is deferred and touches neither the API nor the tunnel", async () => {
    // Two devices with the SAME hostname, one offline ⇒ dupcount 2, not both
    // online ⇒ row b.
    const devs = JSON.stringify({
      devices: [
        { hostname: BOX, online: true, lastSeen: new Date(NOW * 1000).toISOString(), nodeId: "live" },
        { hostname: BOX, online: false, lastSeen: "2000-01-01T00:00:00Z", nodeId: "stale" },
      ],
    });
    const apiCalls: string[] = [];
    const state = memState().state;
    const ctx = new RunContext();
    const transport: KeyTransport = {
      async request(method, url) {
        apiCalls.push(`${method} ${url}`);
        return { code: 200, body: devs };
      },
    };
    const { deps, runner } = tickDeps({ devs, banner: true, state });
    deps.keys = new TailscaleKeys(transport, "https://api", "-", "PAT", ctx);
    deps.ctx = ctx;
    await runReconcile(deps);
    expect(logs.some((l) => l.endsWith(`delete-then-rename: ${BOX} deferred — host key mismatch`))).toBe(true);
    // the devices GET is the only API call: no DELETE, no rename.
    expect(apiCalls.filter((c) => !c.startsWith("GET "))).toHaveLength(0);
    expect(remoteCmds(runner).some((c) => c.includes("hostname"))).toBe(false);
  });

  test("the config push is deferred in its own pass, with its own line", async () => {
    const { deps, runner } = tickDeps({ devs: devsOnline(BOX, NOW), banner: true, managed: true });
    await runReconcile(deps);
    expect(logs.some((l) => l.endsWith(`config: ${BOX} deferred — host key mismatch`))).toBe(true);
    expect(remoteCmds(runner).some((c) => c.includes("dry=") || c.includes("managed"))).toBe(false);
  });

  test("with NO mismatch the same row-a tick really does mint (the gate is the difference)", async () => {
    const { deps } = tickDeps({ devs: devsOffline(BOX), banner: false });
    await runReconcile(deps);
    expect(logs.some((l) => l.includes("deferred — host key mismatch"))).toBe(false);
    // the mint action was attempted (it fails on the fake API, which is fine —
    // what matters is that it was NOT deferred).
    expect(logs.some((l) => l.includes(`${BOX} action 'mint' FAILED`) || l.includes("mint-key:"))).toBe(true);
  });
});

// --- the squatter -------------------------------------------------------------

describe("D11(c) a foreign listener reads as tunnel-down on every path", () => {
  test("python3 holds the port ⇒ classified down and NO ssh argv of any kind", async () => {
    const { deps, runner } = tickDeps({
      devs: devsOnline(BOX, NOW),
      banner: false,
      managed: true,
      listener: 'users:(("python3",pid=9001,fd=3))',
    });
    await runReconcile(deps);
    expect(logs.some((l) => l.includes(`tunnel: 127.0.0.1:${PORT} held by python3[9001] — treating as down`))).toBe(true);
    expect(runner.argvs().some((a) => a[0] === "ssh" || a[0] === "scp")).toBe(false);
    // With the box online this is row e, which is the pre-existing behaviour for
    // any incoherent box: the counter accumulates and the alert eventually fires.
    expect(deps.state.readRepairPending(BOX)!.runs).toBe(1);
  });
});

// --- the flapping no-op and the adopt starvation ------------------------------

describe("D11(c) interaction with adopt and repair", () => {
  function discoverStub(trace: string[]): DiscoverDeps {
    return {
      apiToken: true,
      boxPassword: "pw",
      async listPeers() {
        return [{ index: 3, name: "grok-box-003", ip: "100.64.0.1", online: "yes" }];
      },
      async probe() {
        return { reachable: true, hostname: "", boxup: "5.3.0" };
      },
      async adopt(box) {
        trace.push(`adopt:${box}`);
        return { rc: 0 };
      },
      async inspect(box) {
        trace.push(`inspect:${box}`);
        // The artefacts of a merely ROTATED box are coherent — nothing here to
        // repair.
        return { ok: true, coherent: true, reason: "coherent" };
      },
      async forgetHostKeys(box, scope) {
        trace.push(`forget:${box}:${scope}`);
      },
    };
  }

  test("flapping: a counter that reached 2 with the marker CLEAR is a deliberate NO-OP", async () => {
    // The counter is at 1 from a previous mismatch tick; THIS tick is row e
    // (tunnel down), so it reaches 2 while the marker is clear. Repair must NOT
    // forget — the cure lands on the next mismatch tick — and the coherent
    // verdict must not spend the mutation slot.
    const trace: string[] = [];
    const { state, store } = memState();
    await runReconcile(tickDeps({ devs: devsOnline(BOX, NOW), banner: true, state }).deps);
    expect(state.readHostkeyMismatch(BOX)).toBe(true);

    const t = tickDeps({ devs: devsOnline(BOX, NOW), banner: false, state });
    t.runner.setResponder((argv) => (isSs(argv) ? result({ stdout: "" }) : result({ code: 0 })));
    t.deps.discover = discoverStub(trace);
    await runReconcile(t.deps);

    expect(state.readRepairPending(BOX)!.runs).toBe(2);
    expect(state.readHostkeyMismatch(BOX)).toBe(false);
    expect(trace).toContain(`inspect:${BOX}`);
    expect(trace.some((t2) => t2.startsWith("forget:"))).toBe(false);
    expect(logs.some((l) => l.includes("coherent — nothing to repair"))).toBe(true);
    void store;
  });

  test("adopt starvation: one rotated box + one candidate, three CLEAN ticks ⇒ adopt happens (kills mutant q)", async () => {
    // If the marker ever stuck, the box would carry a live repair_pending marker
    // on every tick and adopt would yield the slot forever.
    const trace: string[] = [];
    const { state } = memState();
    await runReconcile(tickDeps({ devs: devsOnline(BOX, NOW), banner: true, state }).deps);
    for (let i = 0; i < 3; i++) {
      const t = tickDeps({ devs: devsOnline(BOX, NOW), banner: false, state });
      t.deps.discover = discoverStub(trace);
      await runReconcile(t.deps);
    }
    expect(trace).toContain("adopt:grok-box-003");
  });
});
