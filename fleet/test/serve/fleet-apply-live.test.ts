// fleet-apply-live.test.ts — R2: GET /v1/fleet reads `apply` LIVE from
// $FLEET_CONFIG, not from the tick-written snapshot.
//
// Why: `apply` is a CONFIG fact, but the snapshot only records what the last
// tick did. A 34h-old snapshot line reported `apply=off` while production had
// been applying all day — a stale reading an operator could act on. The live
// read is one local file read: no ssh, no reconcile. Every OTHER field still
// comes from the snapshot, and tick_age_s / staleness are unchanged.
//
// Mutants these kill: read `apply` from the snapshot again; throw (500) when the
// config is missing/malformed instead of falling back; drop `apply_source` so a
// fallen-back (possibly stale) value is indistinguishable from a live one.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFetch } from "../../src/serve/server.ts";
import { fakeContext, getReq } from "./helpers.ts";
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

const LINE = (apply: boolean): SnapshotLine => ({
  v: 1,
  ts: "2026-04-01T00:00:00Z",
  apply,
  canary: "grok-box-1",
  boxes: [
    { name: "grok-box-1", tunnel: "up", check: "OK", ver: "5.3.0", drift: "no", config: "in-sync", checkfail: false, asleep: false, expiry_days: 40 },
  ],
});

/** A tmp tree with a history snapshot and (optionally) a config.toml. */
function treeWith(line: SnapshotLine, configText?: string): { state: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), "fleet2-applylive-"));
  dirs.push(root);
  const state = join(root, "state");
  const hist = join(state, "history");
  mkdirSync(hist, { recursive: true });
  writeFileSync(join(hist, `${line.ts.slice(0, 10)}.jsonl`), JSON.stringify(line) + "\n");
  // NEVER a real path: absent unless the case writes one.
  const config = join(root, "config.toml");
  if (configText !== undefined) writeFileSync(config, configText);
  return { state, config };
}

async function fleetBody(t: { state: string; config: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const c = await fakeContext({ enrolled: ["grok-box-1"] });
  (c as { env: { FLEET_STATE: string; FLEET_CONFIG: string } }).env.FLEET_STATE = t.state;
  (c as { env: { FLEET_STATE: string; FLEET_CONFIG: string } }).env.FLEET_CONFIG = t.config;
  // pin the clock into the snapshot's day so readLatest finds the daily file.
  (c as { now?: () => Date }).now = () => new Date("2026-04-01T00:05:00Z");
  const res = await makeFetch(c)(getReq("/v1/fleet", "ADMINSECRET"));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /v1/fleet reads apply LIVE from the config", () => {
  test("live apply=true WINS over a stale snapshot that says apply=false", async () => {
    // the exact production case: the snapshot is old and says off; the config
    // (which is what the reconcile drop-in greps) says the timer IS applying.
    const { status, body } = await fleetBody(
      treeWith(LINE(false), '[fleet-brain]\napply = true\n'),
    );
    expect(status).toBe(200);
    expect(body.apply).toBe(true);
    expect(body.apply_source).toBe("config");
  });

  test("live apply=false WINS over a snapshot that says apply=true", async () => {
    const { body } = await fleetBody(treeWith(LINE(true), '[fleet-brain]\napply = false\n'));
    expect(body.apply).toBe(false);
    expect(body.apply_source).toBe("config");
  });

  test("a top-level apply=true counts (mirrors the drop-in's grep)", async () => {
    const { body } = await fleetBody(treeWith(LINE(false), 'apply = true\n[fleet-brain]\n'));
    expect(body.apply).toBe(true);
    expect(body.apply_source).toBe("config");
  });

  test("apply absent from a readable config ⇒ dry-run, and that IS live", async () => {
    const { body } = await fleetBody(treeWith(LINE(true), '[fleet-brain]\nvps = "1.2.3.4"\n'));
    expect(body.apply).toBe(false);
    expect(body.apply_source).toBe("config");
  });

  test("a commented-out apply does not count as true", async () => {
    const { body } = await fleetBody(treeWith(LINE(false), '[fleet-brain]\n#apply = true\n'));
    expect(body.apply).toBe(false);
    expect(body.apply_source).toBe("config");
  });

  test("MISSING config ⇒ 200 with the snapshot value, marked apply_source=snapshot", async () => {
    const t = treeWith(LINE(true)); // no config written
    const { status, body } = await fleetBody(t);
    expect(status).toBe(200);
    expect(body.apply).toBe(true);
    expect(body.apply_source).toBe("snapshot");
  });

  test("MALFORMED config ⇒ falls back, never 500s", async () => {
    const { status, body } = await fleetBody(treeWith(LINE(true), '[fleet-brain\napply = = true\n'));
    expect(status).toBe(200);
    expect(body.apply).toBe(true);
    expect(body.apply_source).toBe("snapshot");
  });

  test("the live read changes NOTHING else: snapshot_ts, canary and boxes stand", async () => {
    const { body } = await fleetBody(treeWith(LINE(false), '[fleet-brain]\napply = true\n'));
    expect(body.snapshot_ts).toBe("2026-04-01T00:00:00Z");
    expect(body.canary).toBe("grok-box-1");
    expect((body.boxes as { name: string }[])[0]?.name).toBe("grok-box-1");
  });

  test("no snapshot at all + no config ⇒ apply null, not a crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "fleet2-applylive-empty-"));
    dirs.push(root);
    const { status, body } = await fleetBody({ state: root, config: join(root, "nope.toml") });
    expect(status).toBe(200);
    expect(body.apply).toBeNull();
    expect(body.apply_source).toBe("snapshot");
  });
});
