// box-detail.test.ts — D1: the per-box detail facts on GET /v1/boxes/:name, and
// the READ-ONLY rule behind them (gate r1 B3). The facts come from existing
// state readers; the request must leave the api.* backoff files byte-identical,
// because the only OTHER public path that yields the failure count is
// `recordApiFailure`, which bumps it and writes a next-retry stamp — a read that
// called it would push the engine into a fabricated backoff.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFetch } from "../../src/serve/server.ts";
import { fakeContext, getReq } from "./helpers.ts";
import { ReconcileState, nodeStateFs } from "../../src/reconcile/state.ts";
import type { SnapshotLine } from "../../src/history/schema.ts";
import { setLogSink } from "../../src/log.ts";

let dirs: string[] = [];
let restore: (l: string) => void;
beforeEach(() => {
  restore = setLogSink(() => {});
});
afterEach(() => {
  setLogSink(restore);
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const LINE: SnapshotLine = {
  v: 1,
  ts: "2026-04-01T00:00:00Z",
  apply: false,
  canary: null,
  boxes: [
    {
      name: "grok-box-1",
      tunnel: "up",
      check: "OK",
      ver: "5.6.0",
      drift: "no",
      config: "in-sync",
      checkfail: false,
      asleep: false,
      expiry_days: 40,
    },
  ],
};

function stateWith(markers: Record<string, string> = {}): string {
  const s = mkdtempSync(join(tmpdir(), "fleet2-boxdetail-"));
  dirs.push(s);
  const hist = join(s, "history");
  mkdirSync(hist, { recursive: true });
  writeFileSync(join(hist, `${LINE.ts.slice(0, 10)}.jsonl`), JSON.stringify(LINE) + "\n");
  for (const [name, content] of Object.entries(markers)) writeFileSync(join(s, name), content);
  return s;
}

async function boxBody(stateDir: string): Promise<Record<string, unknown>> {
  const c = await fakeContext({ enrolled: ["grok-box-1"] });
  (c as { env: { FLEET_STATE: string } }).env.FLEET_STATE = stateDir;
  (c as { env: { FLEET_CONFIG: string } }).env.FLEET_CONFIG = join(stateDir, "no-such-config.toml");
  const res = await makeFetch(c)(getReq("/v1/boxes/grok-box-1", "READSECRET"));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("D1: the detail facts on GET /v1/boxes/:name", () => {
  test("all five facts are reported from the state markers", async () => {
    const dir = stateWith({
      "grok-box-1.checkfail": "3\n",
      // "<since> <last_alert>" epoch seconds.
      "grok-box-1.asleep": "1774000000 1774003600\n",
      "grok-box-1.expires": "grok-box-1\t2026-06-01\n",
      "api.fails": "2\n",
      "api.next_retry": "1774010000\n",
      "api.backoff_min": "10\n",
    });
    const b = await boxBody(dir);
    expect(b.checkfail_count).toBe(3);
    expect(b.asleep_since).toBe("2026-03-20T09:46:40Z");
    expect(b.asleep_last).toBe("2026-03-20T10:46:40Z");
    expect(b.expires_at).toBe("2026-06-01");
    expect(b.api_backoff).toEqual({ fails: 2, next_retry: "2026-03-20T12:33:20Z" });
  });

  test("a fleet with no markers at all reports zero/null, never absent keys", async () => {
    const b = await boxBody(stateWith());
    expect(b.checkfail_count).toBe(0);
    expect(b.asleep_since).toBeNull();
    expect(b.asleep_last).toBeNull();
    expect(b.expires_at).toBeNull();
    expect(b.api_backoff).toBeNull();
  });

  // gate note 9: readAsleep returns NaN fields for a malformed marker file,
  // and `new Date(NaN)` renders "Invalid Date" in the pane.
  test("a malformed asleep marker maps to null, not Invalid Date", async () => {
    const b = await boxBody(stateWith({ "grok-box-1.asleep": "not-a-number junk\n" }));
    expect(b.asleep_since).toBeNull();
    expect(b.asleep_last).toBeNull();
    expect(String(JSON.stringify(b))).not.toContain("Invalid Date");
  });

  test("checkfail_count sits beside markers.checkfail, the boolean it backs", async () => {
    const b = await boxBody(stateWith({ "grok-box-1.checkfail": "5\n" }));
    expect(b.checkfail_count).toBe(5);
    expect((b.markers as { checkfail: boolean }).checkfail).toBe(true);
  });

  // B3 — the mutant this kills: `apiFails()` replaced by `recordApiFailure()`.
  test("the request leaves api.fails / api.next_retry / api.backoff_min BYTE-IDENTICAL", async () => {
    const dir = stateWith({ "api.fails": "2\n", "api.next_retry": "1774010000\n", "api.backoff_min": "10\n" });
    const files = ["api.fails", "api.next_retry", "api.backoff_min"];
    const before = files.map((f) => readFileSync(join(dir, f), "utf8"));
    await boxBody(dir);
    const after = files.map((f) => readFileSync(join(dir, f), "utf8"));
    expect(after).toEqual(before);
  });

  test("a read on a fleet with NO backoff state writes no backoff files at all", async () => {
    const dir = stateWith();
    await boxBody(dir);
    for (const f of ["api.fails", "api.next_retry", "api.backoff_min"]) {
      expect(existsSync(join(dir, f))).toBe(false);
    }
  });
});

describe("apiFails() is the read-only accessor (B3)", () => {
  test("it reads the counter in the readCounter idiom and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet2-apifails-"));
    dirs.push(dir);
    const st = new ReconcileState(dir, nodeStateFs);
    expect(st.apiFails()).toBe(0); // absent file ⇒ 0
    writeFileSync(join(dir, "api.fails"), " 7 \n"); // whitespace stripped
    expect(st.apiFails()).toBe(7);
    writeFileSync(join(dir, "api.fails"), "seven\n"); // non-numeric ⇒ 0
    expect(st.apiFails()).toBe(0);
    // and no call of it ever created a next-retry stamp.
    expect(existsSync(join(dir, "api.next_retry"))).toBe(false);
  });
  test("recordApiFailure, by contrast, BUMPS and stamps — which is why reads use apiFails", () => {
    const dir = mkdtempSync(join(tmpdir(), "fleet2-apifails2-"));
    dirs.push(dir);
    const st = new ReconcileState(dir, nodeStateFs);
    st.recordApiFailure(1_000_000);
    expect(st.apiFails()).toBe(1);
    expect(existsSync(join(dir, "api.next_retry"))).toBe(true);
  });
});
