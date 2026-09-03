// fleet-apply-live.test.ts — R2: GET /v1/fleet reads `apply` LIVE from
// $FLEET_CONFIG, not from the tick-written snapshot.
//
// Why: `apply` is a CONFIG fact, but the snapshot only records what the last
// tick did. A 34h-old snapshot line reported `apply=off` while production had
// been applying all day — a stale reading an operator could act on. The live
// read is one local file read: no ssh, no reconcile. Every OTHER field still
// comes from the snapshot, and tick_age_s / staleness are unchanged.
//
// The authority is the reconcile drop-in's own test, which is what decides
// whether the timer passes --apply:
//   grep -Eq "^[[:space:]]*apply[[:space:]]*=[[:space:]]*true" config.toml
// so the live read runs THAT regex over the raw text. Parity is exact by
// construction, not by imitation — a TOML parse that only inspects the tables it
// knows about reports `apply=false` for `apply = true` under `[rollout]` (or any
// section added later) while the UNIT applies, i.e. a WRONG reading labelled
// authoritative. Same failure class as the stale reading, just moved.
//
// Every expectation below was checked against real GNU grep with that exact
// pattern; all 11 probes agreed with the regex:
//   `apply = true`  TRUE | `[rollout]`+`apply = true` TRUE | `#apply = true` false
//   `# apply = true` false | `apply=true` TRUE | `   apply   =   true` TRUE
//   `apply = "true"` false | `apply = True` false | `apply = false` false
//   `xapply = true` false | `apply = truex` TRUE
//
// Mutants these kill: read `apply` from the snapshot again; parse TOML and check
// only known tables (the section-blindness cases); throw (500) on an unreadable
// config instead of falling back; drop `apply_source` so a fallen-back (possibly
// stale) value is indistinguishable from a live one.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFetch } from "../../src/serve/server.ts";
import { fakeContext, getReq, seedSnapshots } from "./helpers.ts";
import { suiteScratch } from "../store/helpers.ts";
import type { SnapshotLine } from "../../src/history/schema.ts";
import { setLogSink } from "../../src/log.ts";

// This file's own scratch bucket; dropped whole when the file finishes.
const SCRATCH = suiteScratch("fleet-apply-live");
afterAll(() => SCRATCH.clean());

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

/** A tree with a stored snapshot and (optionally) a config.toml. */
function treeWith(line: SnapshotLine, configText?: string): { state: string; config: string } {
  const root = SCRATCH.dir("grokfleet-applylive");
  dirs.push(root);
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  seedSnapshots(state, [line]);
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

  test("a commented-out apply does not count as true (both #apply and # apply)", async () => {
    for (const text of ['[fleet-brain]\n#apply = true\n', '[fleet-brain]\n# apply = true\n']) {
      const { body } = await fleetBody(treeWith(LINE(false), text));
      expect(body.apply).toBe(false);
      expect(body.apply_source).toBe("config");
    }
  });

  // --- PARITY with the drop-in's grep (the divergence a TOML parse would open) -
  test("apply=true under a NON-fleet-brain table counts — the unit applies, so must we", async () => {
    // A TOML parse that inspects only top level + [fleet-brain] reports false
    // here while the timer is applying: a WRONG reading sold as authoritative.
    const { body } = await fleetBody(treeWith(LINE(false), '[rollout]\napply = true\n'));
    expect(body.apply).toBe(true);
    expect(body.apply_source).toBe("config");
  });

  test("a section added LATER counts too (the grep is section-blind)", async () => {
    const { body } = await fleetBody(
      treeWith(LINE(false), '[fleet-brain]\nvps = "1.2.3.4"\n\n[some-future-table]\napply = true\n'),
    );
    expect(body.apply).toBe(true);
  });

  test("no spaces (apply=true) and leading whitespace both count", async () => {
    for (const text of ['apply=true\n', '   apply   =   true\n', '\tapply\t=\ttrue\n']) {
      const { body } = await fleetBody(treeWith(LINE(false), text));
      expect(body.apply).toBe(true);
      expect(body.apply_source).toBe("config");
    }
  });

  test('apply = "true" as a TOML STRING is FALSE — matching the unit, not TOML', async () => {
    // Verified against real grep: a quote sits where `true` must be, so the
    // pattern does not match and the timer DRY-RUNS. We report what the unit
    // does, even though a TOML reader would call this a truthy-looking value.
    const { body } = await fleetBody(treeWith(LINE(true), '[fleet-brain]\napply = "true"\n'));
    expect(body.apply).toBe(false);
    expect(body.apply_source).toBe("config");
  });

  test("apply = True (capitalised) is FALSE — the pattern is case-sensitive", async () => {
    const { body } = await fleetBody(treeWith(LINE(true), '[fleet-brain]\napply = True\n'));
    expect(body.apply).toBe(false);
  });

  test("a key that merely ENDS in apply does not count", async () => {
    const { body } = await fleetBody(treeWith(LINE(false), '[fleet-brain]\nxapply = true\n'));
    expect(body.apply).toBe(false);
  });

  test("MISSING config ⇒ 200 with the snapshot value, marked apply_source=snapshot", async () => {
    const t = treeWith(LINE(true)); // no config written
    const { status, body } = await fleetBody(t);
    expect(status).toBe(200);
    expect(body.apply).toBe(true);
    expect(body.apply_source).toBe("snapshot");
  });

  test("MALFORMED TOML is irrelevant — grep does not parse, and neither do we", async () => {
    // The unit would apply here (the line matches); a TOML-parsing read would
    // have thrown and fallen back to a possibly stale snapshot value instead.
    const { status, body } = await fleetBody(treeWith(LINE(false), '[fleet-brain\napply = true\n'));
    expect(status).toBe(200);
    expect(body.apply).toBe(true);
    expect(body.apply_source).toBe("config");
  });

  test("UNREADABLE config (a directory at the path) ⇒ falls back, never 500s", async () => {
    const root = SCRATCH.dir("grokfleet-applylive-dir");
    dirs.push(root);
    const state = join(root, "state");
    mkdirSync(state, { recursive: true });
    seedSnapshots(state, [LINE(true)]);
    const config = join(root, "config.toml");
    mkdirSync(config); // readFileSync ⇒ EISDIR
    const { status, body } = await fleetBody({ state, config });
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
    const root = SCRATCH.dir("grokfleet-applylive-empty");
    dirs.push(root);
    const { status, body } = await fleetBody({ state: root, config: join(root, "nope.toml") });
    expect(status).toBe(200);
    expect(body.apply).toBeNull();
    expect(body.apply_source).toBe("snapshot");
  });
});
