// T9/T9b/T10/T12/T13/T14/T15 + H1/H2 — the tick orchestration (runReconcile),
// driven with a FakeRunner + FakeApi (TailscaleKeys) + tmp ReconcileState.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { runReconcile, type ReconcileDeps } from "../src/reconcile/run.ts";
import { ReconcileState, type StateFs } from "../src/reconcile/state.ts";
import { RunContext, TailscaleKeys, type KeyTransport } from "../src/reconcile/tailscale-keys.ts";
import { FakeRunner, result, isSs } from "./fake-runner.ts";
import { testEnv, testRollout } from "./helpers.ts";
import { CHECK_COMMAND } from "../src/remote.ts";
import { setLogSink } from "../src/log.ts";
import type { ManagedSource } from "../src/actions/config-push.ts";
import type { UpgradeDeps } from "../src/upgrade.ts";

let logs: string[] = [];
let prev: (l: string) => void;
beforeEach(() => {
  logs = [];
  prev = setLogSink((l) => logs.push(l));
});
afterEach(() => setLogSink(prev));

function memState(): { fs: StateFs; store: Map<string, string> } {
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
  return { fs, store };
}

const noManaged: ManagedSource & { present: false } = {
  present: false,
  fleetToml: () => undefined,
  boxToml: () => undefined,
};

function fakeKeys(responder: (m: string, url: string) => { code: number; body: string }): {
  keys: TailscaleKeys;
  ctx: RunContext;
  apiCalls: string[];
} {
  const apiCalls: string[] = [];
  const transport: KeyTransport = {
    async request(method, url) {
      apiCalls.push(`${method} ${url}`);
      return responder(method, url);
    },
  };
  const ctx = new RunContext();
  return { keys: new TailscaleKeys(transport, "https://api", "-", "PAT", ctx), ctx, apiCalls };
}

function baseDeps(over: Partial<ReconcileDeps>): ReconcileDeps {
  const { fs } = memState();
  const { keys, ctx } = fakeKeys(() => ({ code: 200, body: '{"devices":[]}' }));
  const upgradeDeps = {} as UpgradeDeps; // only used when auto=true
  return {
    runner: new FakeRunner(() => result({ stdout: "" })), // ss returns nothing ⇒ tunnels down
    env: testEnv(),
    rollout: testRollout(),
    state: new ReconcileState("/s", fs),
    keys,
    ctx,
    notify: () => {},
    targetBoxes: ["grok-box-008"],
    configCanary: undefined,
    managedSource: noManaged,
    managedFilesPresent: false,
    upgradeDeps,
    targetSha: undefined,
    targetVersion: undefined,
    apply: false,
    nowSec: 1_000_000,
    ...over,
  };
}

describe("T13 run order + H1 UPPERCASE mode", () => {
  test("dry-run emits start/done with UPPERCASE DRY-RUN, no enrolled boxes ⇒ rc 0", async () => {
    const deps = baseDeps({ targetBoxes: [] });
    const r = await runReconcile(deps);
    expect(r.rc).toBe(0);
    expect(logs.some((l) => l.includes("reconcile: start (DRY-RUN)"))).toBe(true);
    expect(logs.some((l) => l.includes("reconcile: no enrolled boxes"))).toBe(true);
    // done not reached when no boxes (bash returns before done) — matches main:2592
    expect(logs.some((l) => l.includes("reconcile: done"))).toBe(false);
  });

  test("apply mode ⇒ UPPERCASE APPLY on start + done", async () => {
    const deps = baseDeps({ apply: true, targetBoxes: ["grok-box-008"] });
    await runReconcile(deps);
    expect(logs.some((l) => l.includes("reconcile: start (APPLY)"))).toBe(true);
    expect(logs.some((l) => l.includes("reconcile: done (APPLY)"))).toBe(true);
  });
});

describe("T2/latch: failed GET ⇒ READ-ONLY, devs empty", () => {
  test("non-2xx GET ⇒ latch + read-only log + api.fails bump", async () => {
    const { fs, store } = memState();
    const { keys, ctx } = fakeKeys(() => ({ code: 500, body: "" }));
    const deps = baseDeps({ state: new ReconcileState("/s", fs), keys, ctx });
    await runReconcile(deps);
    expect(ctx.readonly).toBe(true);
    expect(logs.some((l) => l.includes("device list HTTP 500 — READ-ONLY run"))).toBe(true);
    expect(store.get("/s/api.fails")).toBe("1\n");
  });

  test("malformed 200 ⇒ latch + malformed log", async () => {
    const { keys, ctx } = fakeKeys(() => ({ code: 200, body: "{not json" }));
    const deps = baseDeps({ keys, ctx });
    await runReconcile(deps);
    expect(ctx.readonly).toBe(true);
    expect(logs.some((l) => l.includes("HTTP 200 but body malformed/partial"))).toBe(true);
  });

  test("clean 200 ⇒ reset api.fails", async () => {
    const { fs, store } = memState();
    store.set("/s/api.fails", "2\n");
    const { keys } = fakeKeys(() => ({ code: 200, body: '{"devices":[]}' }));
    const deps = baseDeps({ state: new ReconcileState("/s", fs), keys });
    await runReconcile(deps);
    expect(store.get("/s/api.fails")).toBe("0\n");
  });
});

describe("T9/T9b backoff (D4/F5)", () => {
  test("active backoff ⇒ zero API calls, read-only log, config pass STILL runs", async () => {
    const { fs, store } = memState();
    store.set("/s/api.next_retry", `${1_000_000 + 200}\n`); // 200s ahead (< 1200 cap)
    const { keys, ctx, apiCalls } = fakeKeys(() => ({ code: 200, body: '{"devices":[]}' }));
    // managed present so we can see the config pass run despite backoff
    const src: ManagedSource = { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined };
    const runner = new FakeRunner((argv) => {
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" }); // 008 tunnel up
      return result({ code: 0, stdout: "sha=X cur=X support=yes enabled=true" });
    });
    const deps = baseDeps({
      state: new ReconcileState("/s", fs),
      keys,
      ctx,
      runner,
      managedSource: src,
      managedFilesPresent: true,
      targetBoxes: ["grok-box-008"],
    });
    await runReconcile(deps);
    expect(apiCalls.length).toBe(0); // ZERO API calls during backoff
    expect(ctx.readonly).toBe(true);
    expect(logs.some((l) => l.includes("api backoff active until"))).toBe(true);
    // config pass ran (it never consults readonly — F5)
    expect(logs.some((l) => l.includes("config: pass done"))).toBe(true);
  });

  test("T9b: implausible next_retry (> 1200s ahead) ⇒ ignored, GET proceeds", async () => {
    const { fs, store } = memState();
    store.set("/s/api.next_retry", `${1_000_000 + 99999}\n`); // way beyond cap
    const { keys, apiCalls } = fakeKeys(() => ({ code: 200, body: '{"devices":[]}' }));
    const deps = baseDeps({ state: new ReconcileState("/s", fs), keys });
    await runReconcile(deps);
    expect(logs.some((l) => l.includes("api.next_retry implausible"))).toBe(true);
    expect(apiCalls.length).toBe(1); // the GET happened
  });
});

describe("T7 D4: WOULD 'read-only ' prefix is CONDITIONAL on the latch (F3, m9)", () => {
  test("healthy dry-run mint-worthy box ⇒ 'WOULD mint (dry-run/no-apply)' (NO read-only)", async () => {
    // devices say 008 offline; tunnel up ⇒ row a mint. Dry-run, NOT latched.
    const devs = JSON.stringify({ devices: [{ hostname: "grok-box-008", online: false, lastSeen: "2000-01-01T00:00:00Z" }] });
    const { keys } = fakeKeys(() => ({ code: 200, body: devs }));
    const runner = new FakeRunner((argv) => {
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" });
      if ((argv[argv.length - 1] ?? "") === CHECK_COMMAND) return result({ code: 0, stdout: "check=OK v=5.3.0/abc tunnel=up" });
      return result({ code: 1 });
    });
    const deps = baseDeps({ keys, runner, apply: false, targetBoxes: ["grok-box-008"], nowSec: Date.parse("2099-01-01T00:00:00Z") / 1000 });
    await runReconcile(deps);
    const would = logs.find((l) => l.includes("grok-box-008 WOULD mint"));
    expect(would).toBeDefined();
    expect(would!).toContain("(dry-run/no-apply)");
    expect(would!).not.toContain("read-only "); // D4/F3: healthy dry-run has NO prefix
  });

  test("latched run (pre-latched ctx, apply) ⇒ 'WOULD mint (read-only dry-run/no-apply)'", async () => {
    // 008 offline + tunnel up ⇒ row a mint; apply mode but ctx PRE-LATCHED
    // (an earlier box's API failure). The gate WOULD-logs WITH the prefix.
    const devs = JSON.stringify({ devices: [{ hostname: "grok-box-008", online: false, lastSeen: "2000-01-01T00:00:00Z" }] });
    const { keys, ctx } = fakeKeys(() => ({ code: 200, body: devs }));
    ctx.latch(); // pre-latched ⇒ ctx.readonly true
    const runner = new FakeRunner((argv) => {
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" });
      if ((argv[argv.length - 1] ?? "") === CHECK_COMMAND) return result({ code: 0, stdout: "check=OK v=5.3.0/abc tunnel=up" });
      return result({ code: 1 });
    });
    const deps = baseDeps({ keys, ctx, runner, apply: true, targetBoxes: ["grok-box-008"], nowSec: Date.parse("2099-01-01T00:00:00Z") / 1000 });
    await runReconcile(deps);
    const would = logs.find((l) => l.includes("grok-box-008 WOULD mint"));
    expect(would).toBeDefined();
    expect(would!).toContain("(read-only dry-run/no-apply)"); // latched ⇒ prefix present
  });

  test("m16: a real config-pass WOULD push line (dry-run) carries NO 'read-only ' prefix", async () => {
    // Drive an ACTUAL config pass: dry-run, managed files present, a box whose
    // on-box managed sha DIFFERS from the render ⇒ pushManaged(dry) logs
    // `config: <box> WOULD push (<cur>-><want>)`. m16 (add the read-only prefix
    // to the config-pass WOULD line) is killed here — bash's config WOULD line
    // never carried a prefix.
    const devs = JSON.stringify({ devices: [{ hostname: "grok-box-008", online: true, lastSeen: "2999-01-01T00:00:00Z" }] });
    const { keys } = fakeKeys(() => ({ code: 200, body: devs }));
    const runner = new FakeRunner((argv) => {
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" });
      if ((argv[argv.length - 1] ?? "") === CHECK_COMMAND) return result({ code: 0, stdout: "check=OK v=5.3.0/abc tunnel=up" });
      // the config-pass dry-run remote: report a DIFFERENT cur sha ⇒ WOULD push.
      return result({ code: 0, stdout: "cur=OTHERSHA want=IGNORED support=yes enabled=true" });
    });
    const src: ManagedSource = { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined };
    const deps = baseDeps({
      keys,
      runner,
      apply: false, // DRY-RUN ⇒ pushManaged(dry=true) ⇒ WOULD push
      targetBoxes: ["grok-box-008"],
      managedSource: src,
      managedFilesPresent: true,
      nowSec: Date.parse("2999-01-01T00:00:00Z") / 1000,
    });
    await runReconcile(deps);
    const would = logs.find((l) => l.includes("grok-box-008 WOULD push"));
    expect(would).toBeDefined(); // the config-pass WOULD line was actually emitted
    expect(would!).not.toContain("read-only "); // m16 kill: no prefix on it
  });
});

describe("T15 identity pass log-only + empty-devs enrolled loop (G2)", () => {
  test("empty devs ⇒ NO summary line, but legacy-name still emitted", async () => {
    // read-only run (failed GET) ⇒ devs empty; grok-box-3 is legacy-named.
    const { keys } = fakeKeys(() => ({ code: 500, body: "" }));
    const deps = baseDeps({ keys, targetBoxes: ["grok-box-002", "grok-box-3"] });
    await runReconcile(deps);
    expect(logs.some((l) => l.includes("identity: grok-box-3 legacy-name"))).toBe(true);
    // summary absent on empty devs
    expect(logs.some((l) => l.includes("identity: ok="))).toBe(false);
  });

  test("non-empty devs ⇒ summary present", async () => {
    const devs = JSON.stringify({ devices: [{ hostname: "grok-box-002", tags: ["tag:box"], keyExpiryDisabled: true }] });
    const { keys } = fakeKeys(() => ({ code: 200, body: devs }));
    const deps = baseDeps({ keys, targetBoxes: ["grok-box-002"] });
    await runReconcile(deps);
    expect(logs.some((l) => l.includes("identity: ok="))).toBe(true);
  });
});

describe("T12 rollout gating (D10/F8)", () => {
  test("auto=false ⇒ WOULD rollout line, engine NOT called", async () => {
    // 008 drifted: target VERSION != box VERSION (D5), tunnel up, healthy check.
    const devs = JSON.stringify({ devices: [{ hostname: "grok-box-008", online: true, lastSeen: "2999-01-01T00:00:00Z", tags: ["t"], keyExpiryDisabled: true }] });
    const { keys } = fakeKeys(() => ({ code: 200, body: devs }));
    const runner = new FakeRunner((argv) => {
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" });
      if ((argv[argv.length - 1] ?? "") === CHECK_COMMAND) return result({ code: 0, stdout: "check=OK v=5.3.0/OLDSHA tunnel=up" });
      return result({ code: 1 });
    });
    const deps = baseDeps({
      keys,
      runner,
      apply: true,
      targetBoxes: ["grok-box-008"],
      targetSha: "NEWSHA",
      targetVersion: "5.3.1",
      rollout: testRollout({ auto: false }),
    });
    await runReconcile(deps);
    expect(logs.some((l) => l.includes("WOULD rollout grok-box-008 5.3.0→5.3.1 (NEWSHA)"))).toBe(true);
  });
});

// --- D5: drift is a boxup VERSION comparison, not a repo-sha comparison ------

describe("D5 row-d drift compares VERSION, not the stamped repo sha", () => {
  /** One enrolled box, online+fresh, tunnel up, `boxup check` healthy at v/sha. */
  function driftDeps(boxVersion: string, boxSha: string, over: Partial<ReconcileDeps> = {}) {
    const devs = JSON.stringify({
      devices: [
        {
          hostname: "grok-box-005",
          online: true,
          lastSeen: "2999-01-01T00:00:00Z",
          tags: ["t"],
          keyExpiryDisabled: true,
        },
      ],
    });
    const { keys } = fakeKeys(() => ({ code: 200, body: devs }));
    const runner = new FakeRunner((argv) => {
      if (isSs(argv))
        return result({ stdout: "LISTEN 0 128 127.0.0.1:20005 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" });
      if ((argv[argv.length - 1] ?? "") === CHECK_COMMAND)
        return result({ code: 0, stdout: `check=OK v=${boxVersion}/${boxSha} tunnel=up` });
      return result({ code: 1 });
    });
    return baseDeps({
      keys,
      runner,
      apply: true,
      targetBoxes: ["grok-box-005"],
      targetSha: "adfdc04",
      targetVersion: "5.3.1",
      rollout: testRollout({ auto: false }),
      ...over,
    });
  }

  /** The snapshot the tick wrote for grok-box-005. */
  function snapDrift(lines: unknown[]): string | undefined {
    const last = lines[lines.length - 1] as { boxes: { name: string; drift: string }[] } | undefined;
    return last?.boxes.find((b) => b.name === "grok-box-005")?.drift;
  }

  test("same VERSION, different sha ⇒ drift no, no rollout, ONE D5 debug line", async () => {
    // The empirical r1 FAIL, exactly: box 005 runs boxup 5.3.1 stamped f42c967
    // while the target sha has moved to adfdc04 on a grokfleet-only commit.
    const lines: unknown[] = [];
    const deps = driftDeps("5.3.1", "f42c967", { history: (l) => lines.push(l) });
    await runReconcile(deps);
    expect(logs.some((l) => l.includes("WOULD rollout"))).toBe(false);
    expect(snapDrift(lines)).toBe("no");
    const dbg = logs.filter((l) =>
      l.includes("drift: grok-box-005 same VERSION 5.3.1, sha f42c967≠adfdc04 — content drift ignored (D5)"),
    );
    expect(dbg.length).toBe(1); // exactly once per box per tick
  });

  test("older VERSION ⇒ drift yes, WOULD rollout names the versions and the target sha", async () => {
    const lines: unknown[] = [];
    const deps = driftDeps("5.3.0", "f42c967", { history: (l) => lines.push(l) });
    await runReconcile(deps);
    expect(snapDrift(lines)).toBe("yes");
    expect(
      logs.some((l) => l.includes("reconcile: WOULD rollout grok-box-005 5.3.0→5.3.1 (adfdc04)")),
    ).toBe(true);
    // the D5 debug line is for the versions-EQUAL case only.
    expect(logs.some((l) => l.includes("content drift ignored (D5)"))).toBe(false);
  });

  test("a box AHEAD of target (5.4.0) is drifted and converges — mutant (x) kill", async () => {
    // Direction is irrelevant: target is the authority. A `<` comparison would
    // call this in-sync.
    const lines: unknown[] = [];
    const deps = driftDeps("5.4.0", "adfdc04", { history: (l) => lines.push(l) });
    await runReconcile(deps);
    expect(snapDrift(lines)).toBe("yes");
    expect(logs.some((l) => l.includes("WOULD rollout grok-box-005 5.4.0→5.3.1 (adfdc04)"))).toBe(true);
  });

  test("box version unknown ⇒ drift unknown, no rollout", async () => {
    // `v=` absent from the status line ⇒ splitVersion yields "unknown".
    const lines: unknown[] = [];
    const devs = JSON.stringify({
      devices: [{ hostname: "grok-box-005", online: true, lastSeen: "2999-01-01T00:00:00Z", tags: ["t"], keyExpiryDisabled: true }],
    });
    const { keys } = fakeKeys(() => ({ code: 200, body: devs }));
    const runner = new FakeRunner((argv) => {
      if (isSs(argv))
        return result({ stdout: "LISTEN 0 128 127.0.0.1:20005 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" });
      if ((argv[argv.length - 1] ?? "") === CHECK_COMMAND)
        return result({ code: 0, stdout: "check=OK tunnel=up" });
      return result({ code: 1 });
    });
    const deps = baseDeps({
      keys,
      runner,
      apply: true,
      targetBoxes: ["grok-box-005"],
      targetSha: "adfdc04",
      targetVersion: "5.3.1",
      rollout: testRollout({ auto: false }),
      history: (l) => lines.push(l),
    });
    await runReconcile(deps);
    expect(snapDrift(lines)).toBe("unknown");
    expect(logs.some((l) => l.includes("WOULD rollout"))).toBe(false);
  });

  test("targetVersion undefined ⇒ drift unknown, no rollout even when the shas differ", async () => {
    const lines: unknown[] = [];
    const deps = driftDeps("5.3.0", "f42c967", {
      targetVersion: undefined,
      history: (l) => lines.push(l),
    });
    await runReconcile(deps);
    expect(snapDrift(lines)).toBe("unknown");
    expect(logs.some((l) => l.includes("WOULD rollout"))).toBe(false);
  });
});

describe("T13 D6c: config pass failure never changes run rc", () => {
  test("a failing config push leaves rc 0 (no per-box loop failure)", async () => {
    // 008 is healthy in the device list (online+fresh) so the per-box loop
    // decides noop; only the config push fails ⇒ config failed=1 but run rc 0.
    const devs = JSON.stringify({
      devices: [{ hostname: "grok-box-008", online: true, lastSeen: "2999-01-01T00:00:00Z" }],
    });
    const { keys } = fakeKeys(() => ({ code: 200, body: devs }));
    const runner = new FakeRunner((argv) => {
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" });
      if ((argv[argv.length - 1] ?? "") === CHECK_COMMAND) return result({ code: 0, stdout: "check=OK v=5.3.0/abc tunnel=up" });
      // config push (sudo sh -c) ⇒ rc 2 no status ⇒ push rc 5
      return result({ code: 2, stdout: "" });
    });
    const src: ManagedSource = { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined };
    const deps = baseDeps({
      keys,
      runner,
      apply: true,
      targetBoxes: ["grok-box-008"],
      managedSource: src,
      managedFilesPresent: true,
      nowSec: Date.parse("2999-01-01T00:00:00Z") / 1000,
    });
    const r = await runReconcile(deps);
    expect(r.rc).toBe(0); // config failure NOT folded (D6c)
    expect(logs.some((l) => l.includes("config: pass done") && l.includes("failed=1"))).toBe(true);
  });
});


describe("T2 latch suppresses a mint-worthy box even in apply mode (m2)", () => {
  test("apply + PRE-LATCHED ctx + offline box ⇒ WOULD mint, no createKey", async () => {
    // 008 offline in the device list, tunnel up ⇒ row a mint. Apply mode, but the
    // run-context is already latched (an earlier box's API failure) ⇒ the mutation
    // gate must WOULD-log, never call the API. m2 (latch not consulted) would mint.
    const devs = JSON.stringify({ devices: [{ hostname: "grok-box-008", online: false, lastSeen: "2000-01-01T00:00:00Z" }] });
    const { keys, ctx, apiCalls } = fakeKeys(() => ({ code: 200, body: devs }));
    ctx.latch(); // pre-latched
    const runner = new FakeRunner((argv) => {
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" });
      if ((argv[argv.length - 1] ?? "") === CHECK_COMMAND) return result({ code: 0, stdout: "check=OK v=5.3.0/abc tunnel=up" });
      return result({ code: 1 });
    });
    const deps = baseDeps({
      keys,
      ctx,
      runner,
      apply: true,
      targetBoxes: ["grok-box-008"],
      nowSec: Date.parse("2099-01-01T00:00:00Z") / 1000,
    });
    await runReconcile(deps);
    expect(logs.some((l) => l.includes("grok-box-008 WOULD mint"))).toBe(true);
    // m2 guard: the API createKey (POST /keys) was NEVER called (latch honoured).
    expect(apiCalls.some((c) => c.includes("POST") && c.includes("/keys"))).toBe(false);
  });
});

// --- D12: the row-e path is reachable at last --------------------------------

describe("D12 a connected box with the tunnel down is incoherent, not asleep", () => {
  /** The live devices shape: connectedToControl, no `online` field anywhere. */
  const connected = (box: string, ctc: boolean, nowSec: number) =>
    JSON.stringify({
      devices: [{ hostname: box, nodeId: "A", connectedToControl: ctc, lastSeen: new Date(nowSec * 1000).toISOString() }],
    });
  const NOWS = 1_000_000;

  test("two consecutive ticks ⇒ the incoherent alert AND repair_pending_runs = 2", async () => {
    const { fs, store } = memState();
    const state = new ReconcileState("/s", fs);
    const notes: string[] = [];
    const run = async () => {
      const { keys, ctx } = fakeKeys(() => ({ code: 200, body: connected("grok-box-008", true, NOWS) }));
      const deps = baseDeps({
        state,
        keys,
        ctx,
        notify: (_l, m) => { notes.push(m); },
        targetBoxes: ["grok-box-008"],
        nowSec: NOWS,
        // the default runner returns no ss row ⇒ the tunnel is down
      });
      await runReconcile(deps);
    };
    await run();
    // tick +1 is SILENT: alertIncoherent notifies only from the second run.
    expect(notes).toEqual([]);
    expect(state.readRepairPending("grok-box-008")!.runs).toBe(1);

    await run();
    expect(notes.some((m) => m.includes("incoherent-both-dead"))).toBe(true);
    expect(state.readRepairPending("grok-box-008")!.runs).toBe(2);
    void store;
  });

  test("a box that is NOT connected to control is asleep and never bumps the counter", async () => {
    const { fs } = memState();
    const state = new ReconcileState("/s", fs);
    const notes: string[] = [];
    const { keys, ctx } = fakeKeys(() => ({ code: 200, body: connected("grok-box-008", false, NOWS) }));
    const deps = baseDeps({
      state,
      keys,
      ctx,
      notify: (_l, m) => { notes.push(m); },
      targetBoxes: ["grok-box-008"],
      nowSec: NOWS,
    });
    await runReconcile(deps);
    expect(notes).toEqual([]); // asleep alerts only after 2h of continuous both-dead
    expect(state.readAsleep("grok-box-008")).toBeDefined();
    expect(state.readRepairPending("grok-box-008")!.runs).toBe(0);
  });
});

// --- asleep-marker hygiene: a box that wakes up must stop reading asleep -----

describe("a noop tick clears the row-e markers a past asleep tick left behind", () => {
  const dev = (box: string, ctc: boolean, nowSec: number) =>
    JSON.stringify({
      devices: [
        { hostname: box, nodeId: "A", connectedToControl: ctc, lastSeen: new Date(nowSec * 1000).toISOString() },
      ],
    });
  const NOWS = 1_000_000;

  /** The `asleep` the tick mirrored into grok-box-008's snapshot row. */
  const snapAsleep = (lines: unknown[]): boolean | undefined => {
    const last = lines[lines.length - 1] as { boxes: { name: string; asleep: boolean }[] } | undefined;
    return last?.boxes.find((b) => b.name === "grok-box-008")?.asleep;
  };

  test("asleep tick sets the marker; the next HEALTHY tick clears it and the row", async () => {
    const { fs } = memState();
    const state = new ReconcileState("/s", fs);
    const lines: unknown[] = [];

    // tick 1 — not connected to control, tunnel down ⇒ row e ⇒ alert-asleep.
    {
      const { keys, ctx } = fakeKeys(() => ({ code: 200, body: dev("grok-box-008", false, NOWS) }));
      await runReconcile(baseDeps({ state, keys, ctx, nowSec: NOWS, history: (l) => lines.push(l) }));
    }
    expect(state.readAsleep("grok-box-008")).toBeDefined();

    // tick 2 — the box is awake: connected, tunnel up, check OK ⇒ `noop`.
    {
      const { keys, ctx } = fakeKeys(() => ({ code: 200, body: dev("grok-box-008", true, NOWS) }));
      const runner = new FakeRunner((argv) => {
        if (isSs(argv))
          return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" });
        if ((argv[argv.length - 1] ?? "") === CHECK_COMMAND)
          return result({ code: 0, stdout: "check=OK v=5.3.0/abc tunnel=up" });
        return result({ code: 1 });
      });
      await runReconcile(baseDeps({ state, keys, ctx, runner, nowSec: NOWS, history: (l) => lines.push(l) }));
    }

    // The bug: `noop` used to `continue` past both reset sites, so the marker
    // leaked and every marker-mirroring display greyed a healthy box as ☾.
    expect(state.readAsleep("grok-box-008")).toBeUndefined();
    expect(snapAsleep(lines)).toBe(false);
  });
});

describe("an unresolved incident alerts once a day, and re-arms when it clears", () => {
  const NOWS = 2_000_000;
  const dev = (ctc: boolean) =>
    JSON.stringify({
      devices: [
        {
          hostname: "grok-box-008",
          nodeId: "A",
          connectedToControl: ctc,
          lastSeen: new Date(NOWS * 1000).toISOString(),
        },
      ],
    });
  const LISTEN = 'LISTEN 0 128 127.0.0.1:20008 0.0.0.0:* users:(("sshd",pid=41,fd=7))\n';

  /** tunnel UP, `boxup check` FAILING — the N-1 reachable-cannot-converge shape. */
  const cannotConverge = () =>
    new FakeRunner((argv) => {
      if (isSs(argv)) return result({ stdout: LISTEN });
      if ((argv[argv.length - 1] ?? "") === CHECK_COMMAND) return result({ code: 1, stdout: "check=FAIL" });
      return result({ code: 1 });
    });
  /** tunnel up and healthy again. */
  const healthy = () =>
    new FakeRunner((argv) => {
      if (isSs(argv)) return result({ stdout: LISTEN });
      if ((argv[argv.length - 1] ?? "") === CHECK_COMMAND)
        return result({ code: 0, stdout: "check=OK v=5.3.0/abc tunnel=up" });
      return result({ code: 1 });
    });

  const tick = async (state: ReconcileState, runner: FakeRunner, notes: string[], nowSec: number) => {
    const { keys, ctx } = fakeKeys(() => ({ code: 200, body: dev(true) }));
    await runReconcile(
      baseDeps({ state, keys, ctx, runner, nowSec, notify: (_l, m) => void notes.push(m) }),
    );
  };
  const converge = (notes: string[]) => notes.filter((m) => m.includes("reachable-cannot-converge"));

  test("twelve hours of an unfixed incident is ONE message, not one per tick", async () => {
    const { fs } = memState();
    const state = new ReconcileState("/s", fs);
    const notes: string[] = [];
    // The gate is checkfail > 3, so the first three ticks only accumulate.
    for (let i = 0; i < 24; i++) await tick(state, cannotConverge(), notes, NOWS + i * 300);
    // 24 ticks = two hours at the real 5-minute timer. Before dedup this was 20
    // identical messages; the operator learns nothing from 19 of them.
    expect(converge(notes).length).toBe(1);
  });

  test("a recovered box that breaks again alerts AGAIN, inside the renotify window", async () => {
    const { fs } = memState();
    const state = new ReconcileState("/s", fs);
    const notes: string[] = [];
    for (let i = 0; i < 8; i++) await tick(state, cannotConverge(), notes, NOWS + i * 300);
    expect(converge(notes).length).toBe(1);

    // It recovers. The healthy tick must re-arm the throttle — and it is a tick
    // whose verdict is `noop`, which the action loop skips, so the re-arm has to
    // live outside that loop or this is silence for a day.
    await tick(state, healthy(), notes, NOWS + 8 * 300);

    // It breaks again, minutes later and far inside the 24 h window.
    for (let i = 9; i < 17; i++) await tick(state, cannotConverge(), notes, NOWS + i * 300);
    expect(converge(notes).length).toBe(2);
  });
});
