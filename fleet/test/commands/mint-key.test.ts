// mint-key.test.ts — T2 the THIN CLI WRAPPER over actions/mint.ts (F1, m15).
// The mint arms themselves are covered by actions-mint.test.ts / reconcile-
// tailscale-keys.test.ts (see the coverage map); here we assert the wrapper's
// argument handling + rc + the usage split that fixes actions/mint.ts:50-53.

import { describe, test, expect } from "bun:test";
import { cmdMintKey } from "../../src/commands/mint-key.ts";
import { testEnv } from "../helpers.ts";
import { FakeRunner } from "../fake-runner.ts";
import { ReconcileState, type StateFs } from "../../src/reconcile/state.ts";
import type { TailscaleTransport } from "../../src/tailscale.ts";
import { setLogSink } from "../../src/log.ts";

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  return { lines, restore: () => setLogSink(prev) };
}

/** An in-memory StateFs for a box-free ReconcileState. */
function memFs(): StateFs {
  const store = new Map<string, string>();
  return {
    read: (p) => store.get(p),
    write: (p, d) => void store.set(p, d),
    remove: (p) => void store.delete(p),
    mkdirp: () => {},
    chmod: () => {},
    rename: (from, to) => {
      store.set(to, store.get(from) ?? "");
      store.delete(from);
    },
    exists: (p) => store.has(p),
    tmpname: (dir, prefix) => `${dir}/${prefix}tmp`,
  };
}

const env = testEnv();

/** A transport with no token file ⇒ createKey non-2xx (code 0) path. */
const noTokenTransport: TailscaleTransport = {
  async readToken() {
    return undefined;
  },
  async get() {
    return { code: 0, body: "" };
  },
  async request() {
    return { code: 0, body: "" };
  },
};

describe("T2 mint-key wrapper usage split (F1, m15)", () => {
  test("empty arg ⇒ 'usage: grokfleet mint-key <grok-box-N>' rc 2 (NOT the non-grok line)", async () => {
    const cap = captureLog();
    const rc = await cmdMintKey("", { env, cfg: parseEmptyCfg(), runner: new FakeRunner(), transport: noTokenTransport });
    cap.restore();
    expect(rc).toBe(2);
    expect(cap.lines.some((l) => l.includes("usage: grokfleet mint-key <grok-box-N>"))).toBe(true);
    expect(cap.lines.some((l) => l.includes("refusing non-grok box ''"))).toBe(false);
  });

  test("non-grok name ⇒ 'mint-key: refusing non-grok box '<box>'' rc 2", async () => {
    const cap = captureLog();
    const rc = await cmdMintKey("laptop-1", { env, cfg: parseEmptyCfg(), runner: new FakeRunner(), transport: noTokenTransport });
    cap.restore();
    expect(rc).toBe(2);
    expect(cap.lines.some((l) => l.includes("mint-key: refusing non-grok box 'laptop-1'"))).toBe(true);
  });

  test("grok box with a failing create ⇒ rc 1 (delegates to mintKey arms)", async () => {
    const cap = captureLog();
    const rc = await cmdMintKey("grok-box-8", {
      env,
      cfg: parseEmptyCfg(),
      runner: new FakeRunner(),
      transport: {
        async readToken() { return "tok"; },
        async get() { return { code: 500, body: "" }; },
        async request() { return { code: 500, body: "" }; }, // create non-2xx ⇒ rc 1 + latch
      },
      state: new ReconcileState("/s", memFs()),
    });
    cap.restore();
    expect(rc).toBe(1);
    expect(cap.lines.some((l) => l.includes("key-create FAILED (HTTP 500)"))).toBe(true);
  });
});

import { parseConfig } from "../../src/config.ts";
function parseEmptyCfg() {
  return parseConfig(undefined, "/x");
}
