// legacy-import.test.ts — the D6 import rule table, its values and its refusals
// (blueprint fleet2-state-store D9 (b), (p), (v)).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ConfigError } from "../../src/store/db.ts";
import { importLegacy } from "../../src/store/legacy.ts";
import { cleanup, memStore, put, scratchDir, T0, writeLegacyFixture } from "./helpers.ts";

function fixture(prefix: string): { dir: string; state: string; etc: string } {
  const dir = scratchDir(prefix);
  const state = `${dir}/state`;
  const etc = `${dir}/etc`;
  writeLegacyFixture(state, etc);
  return { dir, state, etc };
}

describe("(b) import replay from the survey §1a fixture", () => {
  test("every enrolled row, counter, key row and ledger record lands", () => {
    const { dir, state, etc } = fixture("import");
    try {
      const s = memStore();
      const out = importLegacy(s, { fleetState: state, etc });
      expect(out.kind).toBe("imported");

      const names = (s.db.query("SELECT name FROM boxes ORDER BY name").all() as Array<{ name: string }>).map(
        (r) => r.name,
      );
      // DUPLICATE INDEX: `grok-box-3` and `grok-box-003` are BOTH imported, as
      // two rows, exactly as they exist in the file today (D3/B1). The surrogate
      // `box_id` is what makes that representable at all.
      expect(names).toEqual(["grok-box-003", "grok-box-005", "grok-box-3", "grok-box-abc"]);

      const b3 = s.db.query("SELECT * FROM boxes WHERE name = 'grok-box-003'").get() as Record<string, unknown>;
      expect(b3.phase).toBe("enrolled");
      expect(b3.idx).toBe(3);
      expect(b3.port).toBe(20003);
      expect(b3.pubkey).toBe("AAAAKEY003");
      expect(b3.created_at).toBe(T0);
      // `enrolled_at` is NULL for every imported row and STAYS null: the files
      // never recorded when a box was enrolled, so a Phase B join must not
      // assume it (D6/r2-B4).
      expect(b3.enrolled_at).toBeNull();

      const dup = s.db.query("SELECT idx, port FROM boxes WHERE name = 'grok-box-3'").get() as Record<string, unknown>;
      expect(dup.idx).toBe(3);
      expect(dup.port).toBe(20003);

      const counters = s.db
        .query("SELECT * FROM box_counters WHERE box_id = (SELECT box_id FROM boxes WHERE name='grok-box-003')")
        .get() as Record<string, unknown>;
      expect(counters.checkfail).toBe(4);
      expect(counters.seedfail).toBe(2);
      expect(counters.cfgfail).toBe(1);
      expect(counters.incoherent).toBe(3);
      expect(counters.repair_pending_runs).toBe(2);
      expect(counters.repair_pending_tick).toBe(41);
      expect(counters.hostkey_mismatch).toBe(1);
      expect(counters.asleep_since).toBe(1770000000);
      expect(counters.asleep_last_alert).toBe(1770003600);

      const key = s.db
        .query("SELECT * FROM box_keys WHERE box_id = (SELECT box_id FROM boxes WHERE name='grok-box-003')")
        .get() as Record<string, unknown>;
      expect(key.key_id).toBe("kABC");
      expect(key.expires_raw).toBe("2027-01-31T12:00:00Z");
      expect(key.expires_date).toBe("2027-01-31");

      const engine = s.db.query("SELECT * FROM engine WHERE id=1").get() as Record<string, unknown>;
      expect(engine.tick_seq).toBe(42);
      expect(engine.api_fails).toBe(2);
      expect(engine.api_backoff_min).toBe(10);
      expect(engine.api_next_retry).toBe(1780000600);

      const led = s.db.query("SELECT * FROM discover_ledger").all() as Array<Record<string, unknown>>;
      expect(led).toHaveLength(1);
      expect(led[0]!.name).toBe("grok-box-009");
      expect(led[0]!.failures).toBe(2);

      expect(s.meta("legacy_imported_at")).toBe(String(T0));
      expect(s.meta("legacy_import_source")).toBe("files");
      s.close();
    } finally {
      cleanup(dir);
    }
  });

  test("the marker rule table: absent+file ⇒ import, absent+no file ⇒ fresh, present ⇒ never", () => {
    const { dir, state, etc } = fixture("rule-table");
    try {
      // marker absent + enrolled.tsv present ⇒ import.
      const a = memStore();
      expect(importLegacy(a, { fleetState: state, etc }).kind).toBe("imported");
      // marker present ⇒ NEVER import, whatever the files say.
      writeFileSync(`${state}/enrolled.tsv`, "grok-box-777\t20777\n");
      expect(importLegacy(a, { fleetState: state, etc }).kind).toBe("already");
      expect(
        (a.db.query("SELECT COUNT(*) AS n FROM boxes WHERE name='grok-box-777'").get() as { n: number }).n,
      ).toBe(0);
      a.close();

      // marker absent + NO enrolled.tsv ⇒ fresh store, source='fresh'.
      const empty = scratchDir("fresh");
      const b = memStore();
      expect(importLegacy(b, { fleetState: `${empty}/state`, etc: `${empty}/etc` }).kind).toBe("fresh");
      expect(b.meta("legacy_import_source")).toBe("fresh");
      expect(b.meta("legacy_imported_at")).toBe(String(T0));
      b.close();
      cleanup(empty);
    } finally {
      cleanup(dir);
    }
  });

  test("the gate is the MARKER, not the file — a crashed import leaves an empty file", () => {
    const { dir, state, etc } = fixture("empty-file");
    try {
      const s = memStore();
      importLegacy(s, { fleetState: state, etc });
      // A crash used to leave `enrolled.tsv` empty; the marker is what stops a
      // second import from reading that emptiness as the truth (D6).
      writeFileSync(`${state}/enrolled.tsv`, "");
      expect(importLegacy(s, { fleetState: state, etc }).kind).toBe("already");
      expect((s.db.query("SELECT COUNT(*) AS n FROM boxes").get() as { n: number }).n).toBe(4);
      s.close();
    } finally {
      cleanup(dir);
    }
  });

  test("a corrupt counter is rc 3 NAMING the file, nothing written, marker unwritten", () => {
    const { dir, state, etc } = fixture("corrupt-counter");
    try {
      put(`${state}/grok-box-005.checkfail`, "not-a-number\n");
      const s = memStore();
      let caught: unknown;
      try {
        importLegacy(s, { fleetState: state, etc });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).rc).toBe(3);
      expect((caught as ConfigError).message).toContain(`${state}/grok-box-005.checkfail`);
      // 5.7.1 read this as `0` and logged nothing (survey §4f). The whole point
      // of the store is that corrupt and zero are no longer the same thing.
      expect((s.db.query("SELECT COUNT(*) AS n FROM boxes").get() as { n: number }).n).toBe(0);
      expect(s.meta("legacy_imported_at")).toBeUndefined();
      s.close();
    } finally {
      cleanup(dir);
    }
  });

  test("an unparseable keys/<idx>.json is rc 3 naming the file", () => {
    const { dir, state, etc } = fixture("corrupt-key");
    try {
      put(`${state}/keys/3.json`, "{not json");
      const s = memStore();
      expect(() => importLegacy(s, { fleetState: state, etc })).toThrow(/keys\/3\.json/);
      expect(s.meta("legacy_imported_at")).toBeUndefined();
      s.close();
    } finally {
      cleanup(dir);
    }
  });

  test("a re-run after a crash is a clean REPLAY, not a merge", () => {
    const { dir, state, etc } = fixture("replay");
    try {
      const s = memStore();
      importLegacy(s, { fleetState: state, etc });
      const first = s.db.query("SELECT name, idx, port, phase FROM boxes ORDER BY name").all();
      // MUTANT (m8): drop the `DELETE FROM box_counters` (and the other truncates)
      // from the replay transaction ⇒ this test fails, because the second run
      // hits the UNIQUE(name) constraint or leaves doubled counter rows.
      importLegacy(s, { fleetState: state, etc, force: true });
      const second = s.db.query("SELECT name, idx, port, phase FROM boxes ORDER BY name").all();
      expect(second).toEqual(first);
      expect((s.db.query("SELECT COUNT(*) AS n FROM box_counters").get() as { n: number }).n).toBe(4);
      // THREE key rows for four boxes: `grok-box-3` and `grok-box-003` share
      // index 3, so both read `keys/3.json` and both get a row. Their key EXPORT
      // then collides on that same file, exactly as it does today (D6/r2-n6).
      expect((s.db.query("SELECT COUNT(*) AS n FROM box_keys").get() as { n: number }).n).toBe(3);
      s.close();
    } finally {
      cleanup(dir);
    }
  });

  test("the legacy marker files are RESET, tick.seq and discover.json are LEFT", () => {
    const { dir, state, etc } = fixture("reset");
    try {
      const s = memStore();
      importLegacy(s, { fleetState: state, etc });
      // zeroed where 5.7.1's reset is `echo 0 >`
      expect(readFileSync(`${state}/grok-box-003.checkfail`, "utf8")).toBe("0\n");
      expect(readFileSync(`${state}/grok-box-003.seedfail`, "utf8")).toBe("0\n");
      expect(readFileSync(`${state}/grok-box-003.repair_pending_runs`, "utf8")).toBe("0 42\n");
      // removed where its reset is `rm -f`
      for (const f of ["cfgfail", "incoherent", "asleep", "hostkey_mismatch"]) {
        expect(existsSync(`${state}/grok-box-003.${f}`)).toBe(false);
      }
      // the API backoff triple is REMOVED: a stale future next_retry would
      // suppress the devices GET for up to 20 minutes after a rollback.
      for (const f of ["api.fails", "api.backoff_min", "api.next_retry"]) {
        expect(existsSync(`${state}/${f}`)).toBe(false);
      }
      // LEFT: a freshness ordinal and a harmless backoff schedule.
      expect(existsSync(`${state}/tick.seq`)).toBe(true);
      expect(existsSync(`${state}/discover.json`)).toBe(true);
      s.close();
    } finally {
      cleanup(dir);
    }
  });
});

describe("(v) the awkward rows", () => {
  test("a non-numeric port column falls back to portFor() with a warning", () => {
    const { dir, state, etc } = fixture("bad-port");
    try {
      put(
        `${state}/enrolled.tsv`,
        ["grok-box-003\tnot-a-port", "grok-box-005\t20005", ""].join("\n"),
      );
      const s = memStore();
      importLegacy(s, { fleetState: state, etc });
      const r = s.db.query("SELECT port FROM boxes WHERE name='grok-box-003'").get() as { port: number };
      expect(r.port).toBe(20003); // portFor("grok-box-003")
      s.close();
    } finally {
      cleanup(dir);
    }
  });

  test("an unparseable index gives idx NULL and, with a bad port column, port NULL", () => {
    const { dir, state, etc } = fixture("unparseable");
    try {
      const s = memStore();
      importLegacy(s, { fleetState: state, etc });
      const r = s.db.query("SELECT idx, port FROM boxes WHERE name='grok-box-abc'").get() as {
        idx: number | null;
        port: number | null;
      };
      expect(r.idx).toBeNull();
      // Both the name's index and the column are unusable, so there is no port
      // to invent; the tick SKIPS such a row with one log line (D3/r3-n1) rather
      // than reaching sshArgv and throwing as 5.7.1 did.
      expect(r.port).toBeNull();
      s.close();
    } finally {
      cleanup(dir);
    }
  });

  test("a keys/<idx>.json with no <box>.expires still yields a key row (the mint crash window)", () => {
    const { dir, state, etc } = fixture("no-expires");
    try {
      const s = memStore();
      importLegacy(s, { fleetState: state, etc });
      const k = s.db
        .query("SELECT key_id, expires_date FROM box_keys WHERE box_id=(SELECT box_id FROM boxes WHERE name='grok-box-005')")
        .get() as { key_id: string; expires_date: string };
      // Derived from the key file's own ISO expiry, the same first-10-chars rule
      // `writeExpires` uses. Failing the guard open here would re-mint on the
      // first tick — exactly the bug the store closes.
      expect(k.key_id).toBe("kDEF");
      expect(k.expires_date).toBe("2027-03-02");
      s.close();
    } finally {
      cleanup(dir);
    }
  });

  test("a <box>.expires with NO key file yields NO key row", () => {
    const { dir, state, etc } = fixture("expires-only");
    try {
      // 005 gets a marker but its key file is removed.
      put(`${state}/grok-box-005.expires`, "grok-box-005\t2027-03-02\n");
      require("node:fs").rmSync(`${state}/keys/5.json`, { force: true });
      const s = memStore();
      importLegacy(s, { fleetState: state, etc });
      const k = s.db
        .query("SELECT COUNT(*) AS n FROM box_keys WHERE box_id=(SELECT box_id FROM boxes WHERE name='grok-box-005')")
        .get() as { n: number };
      // Without a key id there is nothing to revoke and nothing the mint-window
      // guard can check, so the row is not invented.
      expect(k.n).toBe(0);
      s.close();
    } finally {
      cleanup(dir);
    }
  });
});

describe("(p) state import --force", () => {
  test("--force replays even with the marker set, and re-reads the current files", () => {
    const { dir, state, etc } = fixture("force");
    try {
      const s = memStore();
      importLegacy(s, { fleetState: state, etc });
      writeFileSync(`${state}/enrolled.tsv`, "grok-box-011\t20011\n");
      expect(importLegacy(s, { fleetState: state, etc }).kind).toBe("already");
      const forced = importLegacy(s, { fleetState: state, etc, force: true });
      expect(forced.kind).toBe("imported");
      const names = (s.db.query("SELECT name FROM boxes ORDER BY name").all() as Array<{ name: string }>).map(
        (r) => r.name,
      );
      expect(names).toEqual(["grok-box-011"]);
      s.close();
    } finally {
      cleanup(dir);
    }
  });
});
