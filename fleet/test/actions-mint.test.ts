// T5/T6/T7 — mint rc map + revoke arms + window guard; seed (srs scan, key never
// in argv/log, converged parser); rotate ordering + revoke-miss semantics.

import { test, expect, describe } from "bun:test";
import { mintKey, mintWindowValid, type MintDeps } from "../src/actions/mint.ts";
import { rotate } from "../src/actions/rotate.ts";
import {
  SEED_REMOTE_SCRIPT,
  renderSeedCommand,
  seedStatusConverged,
  keySha256,
} from "../src/reconcile/seed-remote.ts";
import { TailscaleKeys, RunContext, type KeyTransport } from "../src/reconcile/tailscale-keys.ts";
import { ReconcileState, type StateFs } from "../src/reconcile/state.ts";
import { FakeRunner, result } from "./fake-runner.ts";
import { testEnv } from "./helpers.ts";
import { setLogSink } from "../src/log.ts";

const BASE = "https://api.tailscale.com/api/v2";

function memState(): { fs: StateFs; store: Map<string, string> } {
  const store = new Map<string, string>();
  let n = 0;
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
    tmpname: (dir, pre) => `${dir}/${pre}${++n}`,
  };
  return { fs, store };
}

interface ApiCall {
  method: string;
  url: string;
  body?: string;
}
function fakeKeys(responder: (c: ApiCall) => { code: number; body: string }): {
  keys: TailscaleKeys;
  ctx: RunContext;
  calls: ApiCall[];
} {
  const calls: ApiCall[] = [];
  const transport: KeyTransport = {
    async request(method, url, _h, _t, body) {
      calls.push({ method, url, body });
      return responder({ method, url, body });
    },
  };
  const ctx = new RunContext();
  return { keys: new TailscaleKeys(transport, BASE, "-", "PAT", ctx), ctx, calls };
}

// A runner that seeds OK and reports a converged status + matching expires.
function seedOkRunner(expires: string): FakeRunner {
  return new FakeRunner((argv) => {
    const cmd = argv[argv.length - 1] ?? "";
    if (cmd.startsWith("sudo env SEED_TMP=")) return result({ code: 0 });
    if (cmd.endsWith("boxup status")) return result({ code: 0, stdout: "name=grok-box-8 v=5.3.0/abc tunnel=up" });
    if (cmd.includes("cat ")) return result({ code: 0, stdout: `${expires}\n` });
    return result({ code: 1 });
  });
}

function mintDeps(over: Partial<MintDeps> & { keys: TailscaleKeys; runner: FakeRunner; state: ReconcileState }): MintDeps {
  return {
    env: testEnv(),
    keyExpirySecs: 7776000,
    nowMs: Date.parse("2026-08-30T00:00:00Z"),
    ...over,
  };
}

describe("T6 seed remote script + converged parser", () => {
  test("srs scan: SEED_REMOTE_SCRIPT has NO apostrophe/backtick/# comment", () => {
    expect(SEED_REMOTE_SCRIPT.includes("'")).toBe(false);
    expect(SEED_REMOTE_SCRIPT.includes("`")).toBe(false);
    // no comment lines
    for (const line of SEED_REMOTE_SCRIPT.split("\n")) {
      expect(line.trimStart().startsWith("#")).toBe(false);
    }
  });
  test("renderSeedCommand wraps in sudo env … sh -c '<script>' (main:1576 shape)", () => {
    const cmd = renderSeedCommand("2026-11-27", "deadbeef");
    expect(cmd.startsWith("sudo env SEED_TMP=")).toBe(true);
    expect(cmd).toContain("SEED_EXP='2026-11-27'");
    expect(cmd).toContain("SEED_SHA='deadbeef'");
    expect(cmd).toContain("sh -c '");
  });
  test("renderSeedCommand refuses an apostrophe-bearing expires/sha (F6)", () => {
    expect(() => renderSeedCommand("2026-11-27'; rm", "deadbeef")).toThrow();
  });
  test("seedStatusConverged: EXPIRED/unknown-expiry ⇒ false; absent/expiring ⇒ true", () => {
    expect(seedStatusConverged("name=x authkey=EXPIRED:2026-01-01 tunnel=up")).toBe(false);
    expect(seedStatusConverged("name=x authkey=expired tunnel=up")).toBe(false); // case-insensitive
    expect(seedStatusConverged("name=x authkey=unknown-expiry tunnel=up")).toBe(false);
    expect(seedStatusConverged("name=x tunnel=up")).toBe(true); // silent = converged
    expect(seedStatusConverged("name=x authkey=expiring:2026-12-01 tunnel=up")).toBe(true);
  });
  test("keySha256 hashes '<key>\\n' locally", async () => {
    // sha256 of "K\n"
    const h = await keySha256("K");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // deterministic
    expect(await keySha256("K")).toBe(h);
  });
});

describe("T6 key never in argv or log", () => {
  test("M11: the minted key value never appears in any recorded ssh argv or log line", async () => {
    const logs: string[] = [];
    const prev = setLogSink((l) => logs.push(l));
    try {
      const { keys } = fakeKeys(() => ({
        code: 200,
        body: JSON.stringify({ key: "tskey-SUPERSECRET", id: "kID", expires: "2026-11-27T00:00:00Z" }),
      }));
      const runner = seedOkRunner("2026-11-27");
      const { fs } = memState();
      const r = await mintKey("grok-box-8", mintDeps({ keys, runner, state: new ReconcileState("/s", fs) }));
      expect(r.rc).toBe(0);
      // the key travels on STDIN, never argv
      for (const c of runner.calls) {
        for (const a of c.argv) expect(a.includes("tskey-SUPERSECRET")).toBe(false);
      }
      // the seed call DID carry the key on stdin (that is allowed)
      const seedCall = runner.calls.find((c) =>
        (c.argv[c.argv.length - 1] ?? "").startsWith("sudo env SEED_TMP="),
      );
      expect(seedCall).toBeDefined();
      expect(String(seedCall!.opts.stdin ?? "").includes("tskey-SUPERSECRET")).toBe(true);
      // logs never carry the key
      expect(logs.some((l) => l.includes("tskey-SUPERSECRET"))).toBe(false);
    } finally {
      setLogSink(prev);
    }
  });
});

describe("T5 mint rc map + revoke arms", () => {
  test("rc 2: non-grok box name", async () => {
    const { keys } = fakeKeys(() => ({ code: 200, body: "{}" }));
    const { fs } = memState();
    const r = await mintKey("not-a-box", mintDeps({ keys, runner: new FakeRunner(), state: new ReconcileState("/s", fs) }));
    expect(r.rc).toBe(2);
  });

  test("rc 1 + LATCH: create non-2xx", async () => {
    const { keys, ctx } = fakeKeys(() => ({ code: 500, body: "" }));
    const { fs } = memState();
    const r = await mintKey("grok-box-8", mintDeps({ keys, runner: new FakeRunner(), state: new ReconcileState("/s", fs) }));
    expect(r.rc).toBe(1);
    expect(ctx.readonly).toBe(true);
  });

  test("rc 1, NO latch: response without .key", async () => {
    const { keys, ctx } = fakeKeys(() => ({ code: 200, body: JSON.stringify({ id: "kID" }) }));
    const { fs } = memState();
    const r = await mintKey("grok-box-8", mintDeps({ keys, runner: new FakeRunner(), state: new ReconcileState("/s", fs) }));
    expect(r.rc).toBe(1);
    expect(ctx.readonly).toBe(false);
  });

  test("rc 1, NO latch, NO seed: response without .id", async () => {
    const { keys, ctx, calls } = fakeKeys(() => ({ code: 200, body: JSON.stringify({ key: "tskey-x" }) }));
    const runner = seedOkRunner("2026-11-27");
    const { fs } = memState();
    const r = await mintKey("grok-box-8", mintDeps({ keys, runner, state: new ReconcileState("/s", fs) }));
    expect(r.rc).toBe(1);
    expect(ctx.readonly).toBe(false);
    // NO seed attempted (no ssh call), only the create POST
    expect(runner.calls.length).toBe(0);
    expect(calls.length).toBe(1);
  });

  test("rc 1 + REVOKE: seed/verify failure", async () => {
    const { keys, calls } = fakeKeys((c) => {
      if (c.method === "POST" && c.url.endsWith("/keys"))
        return { code: 200, body: JSON.stringify({ key: "tskey-x", id: "kID", expires: "2026-11-27T00:00:00Z" }) };
      if (c.method === "DELETE") return { code: 200, body: "" }; // revoke ok
      return { code: 500, body: "" };
    });
    // seed fails (ssh rc 1)
    const runner = new FakeRunner(() => result({ code: 1, stderr: "SEED_SHA_MISMATCH" }));
    const { fs, store } = memState();
    const r = await mintKey("grok-box-8", mintDeps({ keys, runner, state: new ReconcileState("/s", fs) }));
    expect(r.rc).toBe(1);
    // revoke DELETE was issued for the just-minted key
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/keys/kID"))).toBe(true);
    // m5: .expires must NOT be written and meta NOT recorded on a seed failure
    expect(store.has("/s/grok-box-8.expires")).toBe(false);
    expect(store.has("/s/keys/8.json")).toBe(false);
  });

  test("rc 0: verified seed + meta persisted + expires written", async () => {
    const { keys } = fakeKeys(() => ({
      code: 200,
      body: JSON.stringify({ key: "tskey-x", id: "kID", expires: "2026-11-27T00:00:00Z" }),
    }));
    const runner = seedOkRunner("2026-11-27");
    const { fs, store } = memState();
    const state = new ReconcileState("/s", fs);
    const r = await mintKey("grok-box-8", mintDeps({ keys, runner, state }));
    expect(r.rc).toBe(0);
    expect(store.get("/s/keys/8.json")).toBe('{"id":"kID","expires":"2026-11-27T00:00:00Z"}');
    expect(store.get("/s/grok-box-8.expires")).toBe("grok-box-8\t2026-11-27\n");
  });

  test("m4: rc 1 + REVOKE on meta-persist failure (verified seed, recordKeyMeta fails)", async () => {
    // Seed + verify succeed, but persisting the key meta fails (the atomic
    // tmp→rename throws). fleet2 MUST revoke the just-minted key (an unrecorded
    // live key on the tailnet is the exact hazard) and NOT write <box>.expires.
    // m4 (skip revoke on persist failure) leaves the key live ⇒ no DELETE.
    const { keys, calls } = fakeKeys((c) => {
      if (c.method === "POST" && c.url.endsWith("/keys"))
        return { code: 200, body: JSON.stringify({ key: "tskey-x", id: "kID", expires: "2026-11-27T00:00:00Z" }) };
      if (c.method === "DELETE") return { code: 200, body: "" }; // revoke ok
      return { code: 500, body: "" };
    });
    const runner = seedOkRunner("2026-11-27");
    // A StateFs whose rename ALWAYS throws ⇒ recordKeyMeta returns false.
    const { fs, store } = memState();
    const failFs: StateFs = {
      ...fs,
      rename: () => {
        throw new Error("simulated ENOSPC on the keys/<n>.json rename");
      },
    };
    const state = new ReconcileState("/s", failFs);
    const r = await mintKey("grok-box-8", mintDeps({ keys, runner, state }));
    expect(r.rc).toBe(1);
    // revoke DELETE was issued for the just-minted key id (the m4 kill).
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/keys/kID"))).toBe(true);
    // and the mint-window marker was NEVER advanced (no <box>.expires).
    expect(store.has("/s/grok-box-8.expires")).toBe(false);
  });
});

describe("T5 mint_window_valid (main:1724-1736)", () => {
  test("valid window (fresh key >7d + recorded id) ⇒ true", () => {
    const { fs, store } = memState();
    const state = new ReconcileState("/s", fs);
    store.set("/s/grok-box-8.expires", "grok-box-8\t2026-11-27\n");
    store.set("/s/keys/8.json", '{"id":"kID","expires":"2026-11-27"}');
    expect(mintWindowValid("grok-box-8", { state, nowSec: Date.parse("2026-08-30T00:00:00Z") / 1000 })).toBe(true);
  });
  test("no recorded id ⇒ false (P1-3)", () => {
    const { fs, store } = memState();
    const state = new ReconcileState("/s", fs);
    store.set("/s/grok-box-8.expires", "grok-box-8\t2026-11-27\n");
    expect(mintWindowValid("grok-box-8", { state, nowSec: Date.parse("2026-08-30T00:00:00Z") / 1000 })).toBe(false);
  });
  test("< 7d out ⇒ false (rotation territory)", () => {
    const { fs, store } = memState();
    const state = new ReconcileState("/s", fs);
    store.set("/s/grok-box-8.expires", "grok-box-8\t2026-09-02\n"); // 3d out
    store.set("/s/keys/8.json", '{"id":"kID","expires":"2026-09-02"}');
    expect(mintWindowValid("grok-box-8", { state, nowSec: Date.parse("2026-08-30T00:00:00Z") / 1000 })).toBe(false);
  });
});

describe("T7 rotate ordering + revoke-miss (tests:623-685)", () => {
  // Build deps where mintKey succeeds/fails via a controllable seed, and record
  // the API call order.
  function rotateHarness(opts: { mintOk: boolean; oldId: string | undefined; delCode: number }) {
    const calls: ApiCall[] = [];
    const transport: KeyTransport = {
      async request(method, url, _h, _t, body) {
        calls.push({ method, url, body });
        if (method === "POST" && url.endsWith("/keys"))
          return { code: 200, body: JSON.stringify({ key: "tskey-n", id: "kNEW", expires: "2026-11-27T00:00:00Z" }) };
        if (method === "DELETE") return { code: opts.delCode, body: "" };
        return { code: 200, body: "" };
      },
    };
    const ctx = new RunContext();
    const keys = new TailscaleKeys(transport, BASE, "-", "PAT", ctx);
    const { fs, store } = memState();
    const state = new ReconcileState("/s", fs);
    if (opts.oldId !== undefined) store.set("/s/keys/8.json", `{"id":"${opts.oldId}","expires":"2026-01-01"}`);
    // seed runner: ok when mintOk, else fail
    const runner = opts.mintOk
      ? seedOkRunner("2026-11-27")
      : new FakeRunner(() => result({ code: 1, stderr: "fail" }));
    return { keys, calls, runner, state, deps: mintDeps({ keys, runner, state }) };
  }

  test("(1) happy path: MINT then DELETE old id, rc 0", async () => {
    const h = rotateHarness({ mintOk: true, oldId: "K-OLD-123", delCode: 200 });
    const r = await rotate("grok-box-8", h.deps);
    expect(r.rc).toBe(0);
    // create POST then DELETE of the OLD key
    const seq = h.calls.map((c) => `${c.method} ${c.url.replace(BASE, "")}`);
    const createIdx = seq.findIndex((s) => s === "POST /tailnet/-/keys");
    const delIdx = seq.findIndex((s) => s === "DELETE /tailnet/-/keys/K-OLD-123");
    expect(createIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(createIdx);
  });

  test("(2) missing old id ⇒ skip revoke, rc 0, no DELETE", async () => {
    const h = rotateHarness({ mintOk: true, oldId: undefined, delCode: 200 });
    const r = await rotate("grok-box-8", h.deps);
    expect(r.rc).toBe(0);
    expect(h.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  test("(3) mint/seed failure ⇒ NO DELETE of old, rc 1", async () => {
    const h = rotateHarness({ mintOk: false, oldId: "K-OLD-123", delCode: 200 });
    const r = await rotate("grok-box-8", h.deps);
    expect(r.rc).toBe(1);
    // the only DELETE allowed is the mint's OWN revoke of the just-minted key
    // (kNEW), never the OLD key.
    expect(h.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/keys/K-OLD-123"))).toBe(false);
  });

  test("(4) revoke miss (DELETE 500) ⇒ rotation still rc 0", async () => {
    const h = rotateHarness({ mintOk: true, oldId: "K-OLD-123", delCode: 500 });
    const r = await rotate("grok-box-8", h.deps);
    expect(r.rc).toBe(0);
    expect(h.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/keys/K-OLD-123"))).toBe(true);
  });
});
