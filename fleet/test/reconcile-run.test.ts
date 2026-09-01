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
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:*\n" }); // 008 tunnel up
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
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:*\n" });
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
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:*\n" });
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
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:*\n" });
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
    // 008 drifted: target sha != box sha, tunnel up, healthy check.
    const devs = JSON.stringify({ devices: [{ hostname: "grok-box-008", online: true, lastSeen: "2999-01-01T00:00:00Z", tags: ["t"], keyExpiryDisabled: true }] });
    const { keys } = fakeKeys(() => ({ code: 200, body: devs }));
    const runner = new FakeRunner((argv) => {
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:*\n" });
      if ((argv[argv.length - 1] ?? "") === CHECK_COMMAND) return result({ code: 0, stdout: "check=OK v=5.3.0/OLDSHA tunnel=up" });
      return result({ code: 1 });
    });
    const deps = baseDeps({
      keys,
      runner,
      apply: true,
      targetBoxes: ["grok-box-008"],
      targetSha: "NEWSHA",
      targetVersion: "5.3.0",
      rollout: testRollout({ auto: false }),
    });
    await runReconcile(deps);
    expect(logs.some((l) => l.includes("WOULD rollout grok-box-008 OLDSHA→NEWSHA"))).toBe(true);
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
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:*\n" });
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
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:*\n" });
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
