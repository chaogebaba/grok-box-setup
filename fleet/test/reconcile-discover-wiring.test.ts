// reconcile-discover-wiring.test.ts — zero-touch join D8, the TRANSPORT half.
//
// The P2 password precedence, the D2 ssh argv (an explicit ConnectTimeout that
// actually takes effect), the probe read parser, the D6d named abort points
// with their partial-state contract and converging retry, the D3 tunnel-wait-0
// adoption driven through the REAL cmdEnroll, and the D6d worst-case timing
// measurement on a virtual clock.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  ABORT_POINTS,
  MUTATION_BUDGET_MS,
  makeDiscoverDeps,
  parseProbeRead,
  resolveDiscoverPassword,
  withAbortPoints,
} from "../src/reconcile/discover-wiring.ts";
import {
  DISCOVER_BUDGET_MS,
  DISCOVER_LIST_CEILING_MS,
  DISCOVER_PROBE_CEILING_MS,
  DiscoverRun,
} from "../src/reconcile/discover.ts";
import { cmdEnroll, type EnrollSideEffects } from "../src/commands/enroll.ts";
import { sshCmdArgv } from "../src/commands/ssh.ts";
import { ReconcileState, type StateFs } from "../src/reconcile/state.ts";
import { FakeRunner, result } from "./fake-runner.ts";
import { testEnv } from "./helpers.ts";
import { parseConfig } from "../src/config.ts";
import { setLogSink } from "../src/log.ts";

let logs: string[] = [];
let prevSink: (l: string) => void;
beforeEach(() => {
  logs = [];
  prevSink = setLogSink((l) => logs.push(l));
});
afterEach(() => setLogSink(prevSink));

const EMPTY_CFG = parseConfig("");

function memState(): ReconcileState {
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
  return new ReconcileState("/s", fs);
}

// --- P2 password precedence ---------------------------------------------------

describe("P2 discover password precedence", () => {
  const env = testEnv({ FLEET_ETC: "/etc/grok-fleet" });

  test("FLEET_SSH_PASSWORD > $FLEET_ETC/box_passwd > [ssh].password > REFUSE", () => {
    const file = (p: string) => (p === "/etc/grok-fleet/box_passwd" ? "filepw\n" : undefined);
    const cfg = parseConfig('[ssh]\npassword = "cfgpw"\n');
    expect(resolveDiscoverPassword(env, cfg, file, { FLEET_SSH_PASSWORD: "envpw" })).toBe("envpw");
    expect(resolveDiscoverPassword(env, cfg, file, {})).toBe("filepw");
    expect(resolveDiscoverPassword(env, cfg, () => undefined, {})).toBe("cfgpw");
    expect(resolveDiscoverPassword(env, EMPTY_CFG, () => undefined, {})).toBeUndefined();
  });

  test("the BAKED default never counts for adoption — no source ⇒ undefined, not '12345678'", () => {
    // resolveSshPassword (the CLI resolver) would answer "12345678" here.
    expect(resolveDiscoverPassword(env, EMPTY_CFG, () => undefined, {})).toBeUndefined();
  });

  test("with no password the tick performs ZERO ssh; with a file password the transport gets THAT value", async () => {
    const runner = new FakeRunner(() => result({ stdout: "" }));
    const noPw = makeDiscoverDeps({
      env,
      cfg: EMPTY_CFG,
      runner,
      apiToken: true,
      readFile: () => undefined,
    });
    expect(noPw.boxPassword).toBeUndefined();
    const run = new DiscoverRun(noPw, {
      state: memState(),
      tick: 5,
      readonly: false,
      apply: true,
      membership: [],
      nowSec: 1,
      nowMs: () => 0,
    });
    // listPeers is the only call it may make (a local `tailscale status`).
    await run.adoptPass();
    expect(runner.calls.filter((c) => c.argv[0] === "sshpass")).toHaveLength(0);

    const runner2 = new FakeRunner(() => result({ code: 0, stdout: "" }));
    const withPw = makeDiscoverDeps({
      env,
      cfg: EMPTY_CFG,
      runner: runner2,
      apiToken: true,
      readFile: (p) => (p.endsWith("box_passwd") ? "file-secret\n" : undefined),
    });
    await withPw.probe("grok-box-003");
    const ssh = runner2.calls.filter((c) => c.argv[0] === "sshpass");
    expect(ssh.length).toBeGreaterThan(0);
    for (const c of ssh) expect(c.opts.env?.SSHPASS).toBe("file-secret");
  });
});

// --- D2 transport -------------------------------------------------------------

describe("D2 discover transport", () => {
  test("the explicit ConnectTimeout precedes SSH_OPTS, so ssh's first-wins rule takes it", async () => {
    const runner = new FakeRunner(() => result({ code: 0, stdout: "" }));
    const deps = makeDiscoverDeps({
      env: testEnv(),
      cfg: EMPTY_CFG,
      runner,
      apiToken: true,
      readFile: (p) => (p.endsWith("box_passwd") ? "pw" : undefined),
    });
    await deps.probe("grok-box-003");
    const argv = runner.calls.find((c) => c.argv[0] === "sshpass")!.argv;
    const first = argv.indexOf("ConnectTimeout=20");
    const shared = argv.indexOf("ConnectTimeout=6");
    expect(first).toBeGreaterThan(-1);
    expect(shared).toBeGreaterThan(-1);
    expect(first).toBeLessThan(shared); // ssh uses the FIRST value it obtains
  });

  test("SSH_OPTS itself is unchanged — `fleet2 ssh` still gets ConnectTimeout 6 and nothing else", () => {
    expect(sshCmdArgv("grok-box-003", "uptime")).toEqual([
      "sshpass",
      "-e",
      "ssh",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=6",
      "-o",
      "BatchMode=no",
      "box@grok-box-003",
      "uptime",
    ]);
  });

  test("the probe read splits hostname from boxup version; an EMPTY hostname file reads ''", () => {
    expect(parseProbeRead("grok-box-003\n---fleet2-probe---\nboxup 5.3.0\n")).toEqual({
      hostname: "grok-box-003",
      boxup: "5.3.0",
    });
    expect(parseProbeRead("\n---fleet2-probe---\nboxup 5.3.0\n")).toEqual({ hostname: "", boxup: "5.3.0" });
    expect(parseProbeRead("\n---fleet2-probe---\n")).toEqual({ hostname: "", boxup: undefined });
  });
});

// --- D3 / D6d orchestration ---------------------------------------------------

interface Rec {
  enrolled: Array<{ box: string; port: number }>;
  wroteConfig: boolean;
  installedVpsKey: boolean;
  installedBoxKey: boolean;
  waited: boolean;
}

function happySE(over: Partial<EnrollSideEffects> = {}, rec?: Rec): EnrollSideEffects {
  const base: EnrollSideEffects = {
    async vpsUserExists() { return true; },
    async haveSshd() { return false; },
    async sshdEffective() { return undefined; },
    fleetVpsAddr() { return "1.2.3.4"; },
    fleetVpsPort() { return "22"; },
    async aclHasFleetBrainTagowner() { return 0; },
    lastApiCode() { return 200; },
    async readBoxPubkey() { return "ssh-ed25519 AAAAkey grok-tunnel"; },
    async tunnelUp() { return false; },
    async installVpsAuthorizedKey() { if (rec) rec.installedVpsKey = true; return true; },
    async recordEtcMapping() { return true; },
    async vpsBoxAccessPubkey() { return "ssh-ed25519 AAAAvps vps"; },
    async installBoxAuthorizedKey() { if (rec) rec.installedBoxKey = true; return true; },
    async writeBoxConfig() { if (rec) rec.wroteConfig = true; return 0; },
    async recordEnrolled(box, port) { rec?.enrolled.push({ box, port }); },
    async notify() {},
    tunnelWaitBudget() { return "0"; },
    async sleep5() { if (rec) rec.waited = true; },
  };
  return { ...base, ...over };
}

function newRec(): Rec {
  return { enrolled: [], wroteConfig: false, installedVpsKey: false, installedBoxKey: false, waited: false };
}

describe("D3 adoption through the real cmdEnroll", () => {
  test("happy path with tunnel wait 0: enrolment RECORDED, never waited on", async () => {
    const rec = newRec();
    const rc = await cmdEnroll(["grok-box-003"], happySE({}, rec));
    expect(rc).toBe(0);
    expect(rec.enrolled).toEqual([{ box: "grok-box-003", port: 20003 }]);
    expect(rec.installedVpsKey).toBe(true);
    expect(rec.installedBoxKey).toBe(true);
    expect(rec.wroteConfig).toBe(true);
    expect(rec.waited).toBe(false); // tunnel proof is tick N+1's job
  });

  test("enroll's rc map is preserved — a refusal comes back non-zero and adopts nothing", async () => {
    const rec = newRec();
    const rc = await cmdEnroll(["grok-box-003"], happySE({ async aclHasFleetBrainTagowner() { return 1; } }, rec));
    expect(rc).toBe(1);
    expect(rec.enrolled).toEqual([]);
  });
});

describe("D6d named abort points", () => {
  test("the six-point list is the real cmdEnroll order and sums to the mutation budget", () => {
    expect(Object.keys(ABORT_POINTS)).toEqual(["acl", "read-pubkey", "install-box-key", "write-box-config"]);
    expect(MUTATION_BUDGET_MS).toBe(30_000 + 20_000 + 20_000 + 20_000);
  });

  test("a timeout at read-pubkey aborts BEFORE any VPS write", async () => {
    let now = 0;
    const rec = newRec();
    const se = happySE(
      {
        async readBoxPubkey() {
          now += ABORT_POINTS["read-pubkey"]; // hangs to its ceiling
          return "ssh-ed25519 AAAAkey grok-tunnel";
        },
      },
      rec,
    );
    const { se: wrapped, timedOutPoint } = withAbortPoints(se, () => now);
    const rc = await cmdEnroll(["grok-box-003"], wrapped);
    expect(rc).toBe(1);
    expect(timedOutPoint()).toBe("read-pubkey");
    expect(rec.installedVpsKey).toBe(false);
    expect(rec.enrolled).toEqual([]);
  });

  test("a timeout at write-box-config leaves the STATED partial state, and the retry converges", async () => {
    let now = 0;
    let hang = true;
    const rec = newRec();
    const se = happySE(
      {
        async writeBoxConfig() {
          if (hang) {
            now += ABORT_POINTS["write-box-config"];
            return 0; // the box did the work but too late to be believed
          }
          rec.wroteConfig = true;
          return 0;
        },
      },
      rec,
    );
    const first = withAbortPoints(se, () => now);
    const rc1 = await cmdEnroll(["grok-box-003"], first.se);
    expect(rc1).toBe(1);
    expect(first.timedOutPoint()).toBe("write-box-config");
    // Exactly the state enroll's own log text calls harmless: the VPS line and
    // the /etc mapping are in place, enrolled.tsv has NO entry.
    expect(rec.installedVpsKey).toBe(true);
    expect(rec.installedBoxKey).toBe(true);
    expect(rec.enrolled).toEqual([]);

    // The retry converges — and because of the D5 dedup change, re-installing
    // the VPS line replaces it rather than adding a second one for the port.
    hang = false;
    now = 0;
    const second = withAbortPoints(se, () => now);
    const rc2 = await cmdEnroll(["grok-box-003"], second.se);
    expect(rc2).toBe(0);
    expect(second.timedOutPoint()).toBeUndefined();
    expect(rec.enrolled).toEqual([{ box: "grok-box-003", port: 20003 }]);
  });

  test("a point whose ceiling no longer fits the mutation budget is not even STARTED", async () => {
    let now = 0;
    const se = happySE({
      async aclHasFleetBrainTagowner() {
        now += ABORT_POINTS.acl - 1; // just inside its ceiling
        return 0;
      },
      async readBoxPubkey() {
        now += ABORT_POINTS["read-pubkey"] - 1;
        return "ssh-ed25519 AAAAkey grok-tunnel";
      },
      async installBoxAuthorizedKey() {
        now += ABORT_POINTS["install-box-key"] - 1;
        return true;
      },
      async writeBoxConfig() {
        now = MUTATION_BUDGET_MS; // the budget is already gone
        return 0;
      },
    });
    // Push the clock so write-box-config cannot fit before it is reached.
    const { se: wrapped, timedOutPoint } = withAbortPoints(se, () => now);
    now = MUTATION_BUDGET_MS - 1_000;
    const rc = await cmdEnroll(["grok-box-003"], wrapped);
    expect(rc).toBe(1);
    expect(timedOutPoint()).toBe("acl");
  });
});

// --- D5 repair content checks, end to end through the transport --------------

describe("D5 repair content checks (wired)", () => {
  const KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIcurrent";
  const PUB = `ssh-ed25519 ${KEY} grok-tunnel`;
  const AK = `restrict,port-forwarding,permitlisten="127.0.0.1:20003" ssh-ed25519 ${KEY} c`;
  const MAP = `grok-box-003\t20003\t${KEY}\n`;
  const CONF = '[fleet]\nvps = "1.2.3.4"\nbox_index = 3\n';

  function wire(files: Record<string, string>, remote: Record<string, string>) {
    const runner = new FakeRunner((argv) => {
      const cmd = argv[argv.length - 1] ?? "";
      for (const [needle, out] of Object.entries(remote)) {
        if (cmd.includes(needle)) return { code: 0, stdout: out };
      }
      return { code: 1, stdout: "" };
    });
    return makeDiscoverDeps({
      env: testEnv({ FLEET_ETC: "/etc/grok-fleet" }),
      cfg: EMPTY_CFG,
      runner,
      apiToken: true,
      readFile: (p) => (p.endsWith("box_passwd") ? "pw" : files[p]),
    });
  }

  const authkeysPath = () => process.env.FLEET_VPS_AUTHKEYS ?? "/home/fleet/.ssh/authorized_keys";

  test("everything in place ⇒ coherent, no repair", async () => {
    process.env.FLEET_VPS_ADDR = "1.2.3.4";
    const deps = wire(
      { [authkeysPath()]: AK + "\n", "/etc/grok-fleet/authorized-keys.map": MAP },
      { "tunnel_ed25519.pub": PUB, "config.toml": CONF },
    );
    const f = await deps.inspect("grok-box-003");
    delete process.env.FLEET_VPS_ADDR;
    expect(f).toEqual({ ok: true, coherent: true, reason: "coherent" });
  });

  test("a MISSING authorized_keys line ⇒ repair (content check, not presence)", async () => {
    process.env.FLEET_VPS_ADDR = "1.2.3.4";
    const deps = wire(
      { [authkeysPath()]: "", "/etc/grok-fleet/authorized-keys.map": MAP },
      { "tunnel_ed25519.pub": PUB, "config.toml": CONF },
    );
    const f = await deps.inspect("grok-box-003");
    delete process.env.FLEET_VPS_ADDR;
    expect(f.ok).toBe(true);
    expect(f.coherent).toBe(false);
    expect(f.reason).toContain("authorized_keys");
  });

  test("a STALE authorized_keys line for the port ⇒ repair (the box rotated its key)", async () => {
    process.env.FLEET_VPS_ADDR = "1.2.3.4";
    const stale = `restrict,port-forwarding,permitlisten="127.0.0.1:20003" ssh-ed25519 AAAAold c`;
    const deps = wire(
      { [authkeysPath()]: stale + "\n", "/etc/grok-fleet/authorized-keys.map": MAP },
      { "tunnel_ed25519.pub": PUB, "config.toml": CONF },
    );
    const f = await deps.inspect("grok-box-003");
    delete process.env.FLEET_VPS_ADDR;
    expect(f.coherent).toBe(false);
  });

  test("a MISSING [fleet] block ⇒ repair", async () => {
    process.env.FLEET_VPS_ADDR = "1.2.3.4";
    const deps = wire(
      { [authkeysPath()]: AK + "\n", "/etc/grok-fleet/authorized-keys.map": MAP },
      { "tunnel_ed25519.pub": PUB, "config.toml": "[box]\nname = \"x\"\n" },
    );
    const f = await deps.inspect("grok-box-003");
    delete process.env.FLEET_VPS_ADDR;
    expect(f.ok).toBe(true);
    expect(f.coherent).toBe(false);
    expect(f.reason).toContain("[fleet]");
  });

  test("an unreachable box ⇒ ok:false, so the caller records a backoff and does NOT mutate", async () => {
    const deps = wire({}, {});
    const f = await deps.inspect("grok-box-003");
    expect(f.ok).toBe(false);
  });
});

// --- D6d worst-case timing ----------------------------------------------------

describe("D6d worst-case timing (virtual clock, stubs at their ceilings)", () => {
  test("discover work + one mutation stays inside 2.5 minutes", async () => {
    let now = 0;
    const clock = () => now;
    const rec = newRec();

    // Every enrol step answers at its ceiling minus a millisecond: the slowest
    // a mutation can be while still SUCCEEDING at every point.
    const slowSE = happySE(
      {
        async aclHasFleetBrainTagowner() { now += ABORT_POINTS.acl - 1; return 0; },
        async readBoxPubkey() { now += ABORT_POINTS["read-pubkey"] - 1; return "ssh-ed25519 AAAAkey c"; },
        async installBoxAuthorizedKey() { now += ABORT_POINTS["install-box-key"] - 1; return true; },
        async writeBoxConfig() { now += ABORT_POINTS["write-box-config"] - 1; return 0; },
      },
      rec,
    );

    const run = new DiscoverRun(
      {
        apiToken: true,
        boxPassword: "pw",
        async listPeers() {
          now += DISCOVER_LIST_CEILING_MS; // `tailscale status` at its ceiling
          return [{ index: 3, name: "grok-box-003", ip: "100.64.0.1", online: "yes" }];
        },
        async probe() {
          now += DISCOVER_PROBE_CEILING_MS - 1; // the ssh probe at its ceiling
          return { reachable: true, hostname: "", boxup: "5.3.0" };
        },
        async adopt() {
          const { se, timedOutPoint } = withAbortPoints(slowSE, clock);
          const rc = await cmdEnroll(["grok-box-003"], se);
          const p = timedOutPoint();
          return p === undefined ? { rc } : { rc, timeoutPoint: p };
        },
        async inspect() { return { ok: true, coherent: true, reason: "coherent" }; },
      },
      {
        state: memState(),
        tick: 5,
        readonly: false,
        apply: true,
        membership: [],
        nowSec: 1,
        nowMs: clock,
      },
    );

    const t0 = now;
    await run.adoptPass();
    await run.repairPass();
    run.finish();
    const elapsed = now - t0;

    expect(run.summary.adopted).toBe(1);
    expect(rec.enrolled).toHaveLength(1);
    // The MEASURED worst case. The structural bound is the discover budget plus
    // the mutation budget (60 s + 90 s = 150 s); D6d's ceiling is 2.5 min and
    // the gate rejects anything over 3.
    expect(elapsed).toBeLessThanOrEqual(DISCOVER_BUDGET_MS + MUTATION_BUDGET_MS);
    expect(elapsed).toBeLessThanOrEqual(150_000);
    // Pinned so a future change that widens a ceiling shows up as a failure
    // here rather than as a silently longer tick: 15 s status + 20 s probe +
    // 90 s mutation.
    expect(elapsed).toBe(124_995);
  });
});
