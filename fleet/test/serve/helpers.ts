// helpers.ts — shared fixtures for the serve/* box-free tests.

import type { ServerContext, TickRunner } from "../../src/serve/context.ts";
import { TokenStore, type TokenFs } from "../../src/serve/tokens.ts";
import { JobRegistry } from "../../src/serve/jobs.ts";
import type { AuditSink } from "../../src/serve/audit.ts";
import type { FlockSyscalls, WithLockDeps } from "../../src/serve/lock.ts";
import { AsyncMutex } from "../../src/serve/lock.ts";
import { FakeRunner } from "../fake-runner.ts";
import { testEnv, testRollout } from "../helpers.ts";
import { loadConfig } from "../../src/config.ts";

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
}

/** Build a ServerContext with all-fake seams for handler/route tests. */
export async function fakeContext(opts: FakeCtxOpts = {}): Promise<ServerContext> {
  const env = testEnv({ FLEET_STATE: "/tmp/does-not-exist-serve-test" });
  const cfg = await loadConfig("/nonexistent-config.toml");
  const rollout = testRollout();
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
