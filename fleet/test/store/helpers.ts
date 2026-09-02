// test/store/helpers.ts — shared fixtures for the state-store suite.
//
// Real-file tests need a writable directory. The default is REPO-LOCAL —
// `fleet/.test-scratch/`, gitignored, created on demand — so the suite runs on
// any checkout: a machine-specific absolute path used to be the default, and
// without FLEET_TEST_SCRATCH set every real-file test failed everywhere but the
// original author's laptop. It is deliberately not /tmp, which on some of our
// machines is a plain directory on a nearly-full root partition.
//
// FLEET_TEST_SCRATCH still overrides it — a grok box that would rather put the
// files on /workspace, or a run that wants them on a bigger volume, sets it.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { openStore, type Store } from "../../src/store/db.ts";

export const SCRATCH_ROOT =
  process.env.FLEET_TEST_SCRATCH ?? resolve(import.meta.dir, "..", "..", ".test-scratch");

/** One test FILE's bucket under SCRATCH_ROOT, so a file can drop everything it
 *  made in a single `afterAll` even when a test threw before its own cleanup. */
export interface SuiteScratch {
  /** A throwaway directory inside this file's bucket. */
  dir(prefix: string): string;
  /** Remove this file's whole bucket. */
  clean(): void;
}

export function suiteScratch(suite: string): SuiteScratch {
  const root = resolve(SCRATCH_ROOT, suite);
  return {
    dir(prefix: string): string {
      mkdirSync(root, { recursive: true });
      return mkdtempSync(`${root}/${prefix}-`);
    },
    clean(): void {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** A fixed clock so `at` values in assertions are stable. */
export const T0 = 1_780_000_000;

export function memStore(now: number = T0): Store {
  return openStore({ path: ":memory:", now: () => now });
}

/** Write a file, creating its directory. */
export function put(path: string, data: string): void {
  mkdirSync(path.replace(/\/[^/]*$/, ""), { recursive: true });
  writeFileSync(path, data);
}

/**
 * The survey §1a legacy layout, as a fixture: three enrolled boxes including the
 * duplicate-index pair `grok-box-3` + `grok-box-003` (both legal rows until one
 * is renamed, D3/B1) and one unparseable-index name, plus every counter file,
 * the key metadata, the API backoff triple, the tick ordinal and the ledger.
 */
export function writeLegacyFixture(state: string, etc: string): void {
  put(
    `${state}/enrolled.tsv`,
    [
      "# an operator annotation the export deliberately does NOT preserve",
      "grok-box-003\t20003",
      "grok-box-3\t20003",
      "grok-box-005\t20005",
      "grok-box-abc\tnot-a-port",
      "",
    ].join("\n"),
  );
  put(`${etc}/authorized-keys.map`, ["grok-box-003\t20003\tAAAAKEY003", "grok-box-005\t20005\tAAAAKEY005", ""].join("\n"));

  put(`${state}/grok-box-003.checkfail`, "4\n");
  put(`${state}/grok-box-003.seedfail`, "2\n");
  put(`${state}/grok-box-003.cfgfail`, "1\n");
  put(`${state}/grok-box-003.incoherent`, "3\n");
  put(`${state}/grok-box-003.asleep`, "1770000000 1770003600\n");
  put(`${state}/grok-box-003.repair_pending_runs`, "2 41\n");
  put(`${state}/grok-box-003.hostkey_mismatch`, "1\n");

  put(`${state}/keys/3.json`, JSON.stringify({ id: "kABC", expires: "2027-01-31T12:00:00Z" }));
  put(`${state}/grok-box-003.expires`, "grok-box-003\t2027-01-31\n");

  // 005 has a key file but NO `.expires` — the mint crash window this blueprint
  // closes. The row must still be created, with the date derived from the key
  // file's own ISO expiry (D6/r3-n5).
  put(`${state}/keys/5.json`, JSON.stringify({ id: "kDEF", expires: "2027-03-02T00:00:00Z" }));

  put(`${state}/tick.seq`, "42\n");
  put(`${state}/api.fails`, "2\n");
  put(`${state}/api.backoff_min`, "10\n");
  put(`${state}/api.next_retry`, "1780000600\n");
  put(
    `${state}/discover.json`,
    JSON.stringify({
      v: 1,
      boxes: [{ name: "grok-box-009", last_attempt: 1779999000, failures: 2, reason: "enroll-rc1", last_tick: 40 }],
    }) + "\n",
  );
}
