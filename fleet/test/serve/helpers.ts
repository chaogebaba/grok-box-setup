// helpers.ts — shared fixtures for the serve/* box-free tests.

import type { ServerContext, TickRunner } from "../../src/serve/context.ts";
import { TokenStore, type TokenFs } from "../../src/serve/tokens.ts";
import { JobRegistry } from "../../src/serve/jobs.ts";
import type { AuditSink } from "../../src/serve/audit.ts";
import type { FlockSyscalls, WithLockDeps } from "../../src/serve/lock.ts";
import { AsyncMutex } from "../../src/serve/lock.ts";
import { FakeRunner } from "../fake-runner.ts";
import { testEnv, testRollout } from "../helpers.ts";
import { loadConfig, parseConfig } from "../../src/config.ts";
import { openStore, storePath } from "../../src/store/db.ts";
import { writeSnapshot } from "../../src/store/snapshots.ts";
import type { SnapshotLine } from "../../src/history/schema.ts";
import type { Observed } from "../../src/reconcile/observe.ts";

/** A TokenFs backed by an in-memory record; mode/uid default to a valid 600/self. */
export function memTokenFs(
  body: string,
  over: { mode?: number; uid?: number; mtimeMs?: number; missing?: boolean } = {},
): { fs: TokenFs; setBody: (b: string, mtimeMs?: number) => void } {
  let cur = body;
  let mtime = over.mtimeMs ?? 1000;
  const fs: TokenFs = {
    stat(_p) {
      if (over.missing) return undefined;
      return { mtimeMs: mtime, mode: over.mode ?? 0o600, uid: over.uid ?? 4242 };
    },
    read(_p) {
      return cur;
    },
    selfUid() {
      return over.uid ?? 4242; // matches the file owner by default
    },
  };
  return {
    fs,
    setBody(b, m) {
      cur = b;
      mtime = m ?? mtime + 1;
    },
  };
}

/** A canonical two-token toml (one admin, one readonly). */
export const TWO_TOKENS = `
[tokens.admin-one]
token = "ADMINSECRET"
scope = "admin"

[tokens.read-one]
token = "READSECRET"
scope = "readonly"
`;

/** An in-memory audit sink capturing lines. */
export function memAudit(): { sink: AuditSink; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      append(_fleetState, line) {
        lines.push(line.replace(/\n$/, ""));
      },
    },
  };
}

/** A FlockSyscalls fake: a shared "held" flag so a test can simulate contention. */
export function fakeSyscalls(opts: { heldBy?: { held: boolean } } = {}): {
  sys: FlockSyscalls;
  held: { held: boolean };
} {
  const held = opts.heldBy ?? { held: false };
  let myFd = 0;
  const owned = new Set<number>();
  const sys: FlockSyscalls = {
    open(_p) {
      return ++myFd;
    },
    flockNB(fd) {
      if (held.held && !owned.has(fd)) return false;
      held.held = true;
      owned.add(fd);
      return true;
    },
    close(fd) {
      if (owned.has(fd)) {
        owned.delete(fd);
        if (owned.size === 0) held.held = false;
      }
    },
  };
  return { sys, held };
}

/** Lock deps that never sleep for real and use the fake syscalls. Each call gets
 *  a FRESH mutex so tests never couple through the module singleton. */
export function fakeLockDeps(sys: FlockSyscalls, timeoutMs = 30_000): WithLockDeps {
  let t = 0;
  return {
    syscalls: sys,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    timeoutMs,
    retryMs: 250,
    mutex: new AsyncMutex(),
  };
}

export interface FakeCtxOpts {
  tokenBody?: string;
  tokenFs?: TokenFs;
  enrolled?: string[];
  runner?: FakeRunner;
  tick?: TickRunner;
  auditSink?: AuditSink;
  lockDeps?: WithLockDeps;
  whichJournalctl?: (bin: string) => boolean;
  now?: () => Date;
  jobs?: JobRegistry;
  /** lease-api: a REAL $FLEET_STATE, for tests whose endpoint reads the store. */
  fleetState?: string;
  /** override the rollout config (the lease canary rules read `canary`). */
  rollout?: ReturnType<typeof testRollout>;
  /** raw config text, parsed as $FLEET_CONFIG (the `[leases]` knobs). */
  configText?: string;
}

/** Build a ServerContext with all-fake seams for handler/route tests. */
export async function fakeContext(opts: FakeCtxOpts = {}): Promise<ServerContext> {
  const env = testEnv({ FLEET_STATE: opts.fleetState ?? "/tmp/does-not-exist-serve-test" });
  const cfg =
    opts.configText === undefined
      ? await loadConfig("/nonexistent-config.toml")
      : parseConfig(opts.configText, "/fake/config.toml");
  const rollout = opts.rollout ?? testRollout();
  const { fs } = opts.tokenFs ? { fs: opts.tokenFs } : memTokenFs(opts.tokenBody ?? TWO_TOKENS);
  const tokens = TokenStore.load(`${env.FLEET_ETC}/serve-tokens.toml`, fs);
  const jobs = opts.jobs ?? new JobRegistry(() => "job-fixed-1");
  const { sink } = opts.auditSink ? { sink: opts.auditSink } : memAudit();
  const tick: TickRunner = opts.tick ?? { async run() { return 0; } };
  return {
    env,
    cfg,
    rollout,
    runner: opts.runner ?? new FakeRunner(() => ({ stdout: "" })),
    tokens,
    jobs,
    auditSink: sink,
    lockPath: `${env.FLEET_STATE}/reconcile.lock`,
    lockDeps: opts.lockDeps,
    tick,
    enrolledBoxes: () => opts.enrolled ?? ["grok-box-1", "grok-box-8"],
    whichJournalctl: opts.whichJournalctl,
    now: opts.now,
  };
}

/**
 * Seed a `$FLEET_STATE` with snapshots, the way the tick records them.
 *
 * state-store D3 (Phase B): `history/*.jsonl` is gone, so a test that used to
 * write a daily file writes STORE rows instead. Lines are written in the order
 * given, one tick each starting at `firstTick`, so "the newest line" is the last
 * one — the same thing the last line of the newest daily file used to be.
 *
 * `observed` defaults to `healthy` for every box: these fixtures are about the
 * `SnapshotLine` round-trip, and the label has its own tests.
 */
export function seedSnapshots(
  fleetState: string,
  lines: SnapshotLine[],
  opts: { firstTick?: number; observed?: Map<string, Observed> } = {},
): void {
  const store = openStore({ path: storePath(fleetState), dir: fleetState });
  try {
    let tick = opts.firstTick ?? 1;
    for (const line of lines) {
      const observed = opts.observed ?? new Map(line.boxes.map((b) => [b.name, "healthy" as Observed]));
      writeSnapshot(store, { tick: tick++, line, observed });
    }
  } finally {
    store.close();
  }
}

/**
 * Seed one `boxes` row (and optionally its live markers) so the API has a phase
 * to report and a marker mirror to override the snapshot with.
 *
 * From 5.8.0 the "live markers" the fleet response merges over a snapshot are
 * STORE COLUMNS, not `<box>.checkfail` files — so a test that used to drop
 * marker files beside a daily jsonl seeds them here instead.
 */
export function seedBoxRow(
  fleetState: string,
  name: string,
  opts: {
    phase?: string;
    port?: number;
    checkfail?: number;
    asleep?: { since: number; last: number };
    expires?: { keyId: string; raw: string; date: string };
  } = {},
): void {
  const store = openStore({ path: storePath(fleetState), dir: fleetState });
  try {
    const at = 1_780_000_000;
    const idx = Number.parseInt(name.replace(/^\D+/, ""), 10);
    store.db
      .query(
        `INSERT OR REPLACE INTO boxes(name,idx,port,phase,created_at,enrolled_at,updated_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(name, Number.isNaN(idx) ? null : idx, opts.port ?? 20000 + (Number.isNaN(idx) ? 0 : idx), opts.phase ?? "enrolled", at, at, at);
    const id = (store.db.query("SELECT box_id FROM boxes WHERE name = ?").get(name) as { box_id: number }).box_id;
    store.db.query("INSERT OR IGNORE INTO box_counters(box_id) VALUES(?)").run(id);
    if (opts.checkfail !== undefined) {
      store.db.query("UPDATE box_counters SET checkfail = ? WHERE box_id = ?").run(opts.checkfail, id);
    }
    if (opts.asleep !== undefined) {
      store.db
        .query("UPDATE box_counters SET asleep_since = ?, asleep_last_alert = ? WHERE box_id = ?")
        .run(opts.asleep.since, opts.asleep.last, id);
    }
    if (opts.expires !== undefined) {
      store.db
        .query("INSERT OR REPLACE INTO box_keys(box_id,key_id,expires_raw,expires_date,minted_at) VALUES(?,?,?,?,?)")
        .run(id, opts.expires.keyId, opts.expires.raw, opts.expires.date, at);
    }
  } finally {
    store.close();
  }
}

/** Build a GET request with an optional bearer token. */
export function getReq(path: string, token?: string): Request {
  const h: Record<string, string> = {};
  if (token !== undefined) h["Authorization"] = `Bearer ${token}`;
  return new Request(`http://t${path}`, { method: "GET", headers: h });
}

/** Build a POST request with an optional bearer token + JSON body. */
export function postReq(path: string, token?: string, body?: unknown): Request {
  const h: Record<string, string> = {};
  if (token !== undefined) h["Authorization"] = `Bearer ${token}`;
  const init: RequestInit = { method: "POST", headers: h };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://t${path}`, init);
}
