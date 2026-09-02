// db.test.ts — schema, migrations, min_reader, file modes, WAL, integrity and
// audit retention (blueprint fleet2-state-store D9 (a), (i), (j), (k), (n), (q)).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { statSync, existsSync, chmodSync, writeFileSync, mkdirSync } from "node:fs";
import { ConfigError, openStore, storePath } from "../../src/store/db.ts";
import { KNOWN_SCHEMA, AUDIT_RETENTION_DAYS, MIGRATIONS } from "../../src/store/schema.ts";
import { cleanup, memStore, scratchDir, T0 } from "./helpers.ts";

describe("(a) migrations, user_version and min_reader", () => {
  test("v0 -> v2 creates every table and stamps the contract", () => {
    const s = memStore();
    expect(s.userVersion()).toBe(KNOWN_SCHEMA);
    // Every migration is ADDITIVE, so `min_reader` never moves off 1 — that is
    // what lets a 5.8.0 binary open this file after a Phase B rollback (D2).
    expect(s.meta("min_reader")).toBe("1");
    expect(s.meta("schema_created_at")).toBe(String(T0));

    const tables = (
      s.db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of [
      "alerts",
      "audit",
      "box_counters",
      "box_keys",
      "boxes",
      "discover_ledger",
      "divergence_findings",
      "engine",
      "meta",
      // v2 (Phase B), additive:
      "snapshots",
      "snapshot_boxes",
      "snapshot_skipped",
    ]) {
      expect(tables).toContain(t);
    }
    // The engine row is created by migration 1, not lazily.
    expect((s.db.query("SELECT COUNT(*) AS n FROM engine").get() as { n: number }).n).toBe(1);
    // `audit(at)` is a v1 index (r5-B2), not a v2 one.
    const idx = (
      s.db.query("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(idx).toContain("audit_at");
    // v2 indexes (r3-n2): the retention scan and the per-box history slice.
    expect(idx).toContain("snapshots_ts");
    expect(idx).toContain("snapshot_boxes_name_tick");
    s.close();
  });

  test("(a) v1 -> v2 is ADDITIVE: the v1 rows survive and min_reader stays 1", () => {
    const dir = scratchDir("migrate-v2");
    try {
      const path = storePath(dir);
      // Build a file that stops at v1, the way a 5.8.0 binary left it.
      const v1 = new Database(path, { create: true });
      v1.run("PRAGMA foreign_keys = ON");
      for (const stmt of MIGRATIONS[0]!.statements) v1.run(stmt);
      v1.run("PRAGMA user_version = 1");
      v1.run("INSERT INTO meta(key,value) VALUES('min_reader','1')");
      v1.run(
        `INSERT INTO boxes(name,idx,port,phase,created_at,updated_at) VALUES('grok-box-008',8,20008,'enrolled',${T0},${T0})`,
      );
      v1.run(`INSERT INTO audit(at,actor,action) VALUES(${T0},'fleet2','legacy-import')`);
      v1.close();

      const s = openStore({ path, dir, now: () => T0 });
      expect(s.userVersion()).toBe(2);
      expect(s.meta("min_reader")).toBe("1");
      // Nothing v1 held was rewritten.
      expect((s.db.query("SELECT name FROM boxes").get() as { name: string }).name).toBe("grok-box-008");
      expect((s.db.query("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n).toBe(1);
      // ...and the three v2 tables are now there and empty.
      for (const t of ["snapshots", "snapshot_boxes", "snapshot_skipped"]) {
        expect((s.db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n).toBe(0);
      }
      s.close();
    } finally {
      cleanup(dir);
    }
  });

  test("re-opening an already-migrated file runs nothing and keeps the version", () => {
    const dir = scratchDir("migrate");
    try {
      const path = storePath(dir);
      const a = openStore({ path, dir });
      a.setMeta("canary", "kept");
      a.close();
      const b = openStore({ path, dir });
      expect(b.userVersion()).toBe(KNOWN_SCHEMA);
      expect(b.meta("canary")).toBe("kept");
      b.close();
    } finally {
      cleanup(dir);
    }
  });

  test("v1 tables are STRICT — a text value in an INTEGER column is rejected", () => {
    const s = memStore();
    s.db.run(
      "INSERT INTO boxes(name,idx,port,phase,created_at,updated_at) VALUES('grok-box-001',1,20001,'enrolled',1,1)",
    );
    expect(() =>
      s.db.query("UPDATE boxes SET port = ? WHERE name = 'grok-box-001'").run("twenty-thousand-and-one"),
    ).toThrow();
    s.close();
  });

  test("a NEWER user_version with min_reader <= known OPENS (the Phase B rollback)", () => {
    const dir = scratchDir("newer-ok");
    try {
      const path = storePath(dir);
      const a = openStore({ path, dir });
      a.close();
      // Simulate a Phase B (v2) file: additive only, so min_reader stays 1.
      const raw = new Database(path);
      raw.run("PRAGMA user_version = 2");
      raw.run("CREATE TABLE IF NOT EXISTS snapshots(tick INTEGER PRIMARY KEY) STRICT");
      raw.close();

      const b = openStore({ path, dir });
      expect(b.userVersion()).toBe(2);
      // It operates the file as a schema-1 reader and ignores what it does not
      // know — 5.8.0 keeps working against a v2 file (D2).
      expect(b.meta("min_reader")).toBe("1");
      b.db.run("INSERT INTO boxes(name,phase,created_at,updated_at) VALUES('grok-box-002','enrolled',1,1)");
      b.close();
    } finally {
      cleanup(dir);
    }
  });

  test("a NEWER user_version with min_reader > known REFUSES rc 3 naming both", () => {
    const dir = scratchDir("newer-refuse");
    try {
      const path = storePath(dir);
      const a = openStore({ path, dir });
      a.close();
      const raw = new Database(path);
      raw.run("PRAGMA user_version = 3");
      raw.run("UPDATE meta SET value = '3' WHERE key = 'min_reader'");
      raw.close();

      let caught: unknown;
      try {
        openStore({ path, dir });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      const msg = (caught as ConfigError).message;
      expect((caught as ConfigError).rc).toBe(3);
      // MUTANT (m6): drop the min_reader check in openStore ⇒ this case fails
      // (the store opens and the assertions below never run).
      expect(msg).toContain("user_version=3");
      expect(msg).toContain("min_reader=3");
      expect(msg).toContain(path);
    } finally {
      cleanup(dir);
    }
  });
});

describe("(n) file modes", () => {
  test("fleet.db, -wal and -shm are all 0600 after the first write", () => {
    const dir = scratchDir("modes");
    try {
      const path = storePath(dir);
      const s = openStore({ path, dir });
      s.db.run("INSERT INTO boxes(name,phase,created_at,updated_at) VALUES('grok-box-001','enrolled',1,1)");
      s.chmodAll();
      for (const p of [path, `${path}-wal`, `${path}-shm`]) {
        expect(existsSync(p)).toBe(true);
        expect(statSync(p).mode & 0o777).toBe(0o600);
      }
      s.close();
    } finally {
      cleanup(dir);
    }
  });
});

describe("(q) an unwritable $FLEET_STATE is rc 3 naming the directory", () => {
  test("openStore throws ConfigError with the path and the errno", () => {
    const parent = scratchDir("ro");
    const dir = `${parent}/state`;
    try {
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o500); // r-x: readable, NOT writable
      let caught: unknown;
      try {
        openStore({ path: storePath(dir), dir });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).rc).toBe(3);
      expect((caught as ConfigError).message).toContain(dir);
      expect((caught as ConfigError).message).toContain("EACCES");
    } finally {
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* best-effort */
      }
      cleanup(parent);
    }
  });
});

describe("(i) WAL concurrent reader", () => {
  test("a second read-only handle sees committed rows while the writer stays open", () => {
    const dir = scratchDir("wal");
    try {
      const path = storePath(dir);
      const w = openStore({ path, dir });
      w.db.run("INSERT INTO boxes(name,phase,created_at,updated_at) VALUES('grok-box-001','enrolled',1,1)");

      const r = openStore({ path, dir, readonly: true });
      expect((r.db.query("SELECT COUNT(*) AS n FROM boxes").get() as { n: number }).n).toBe(1);

      // The writer commits more while the reader is still open.
      w.db.run("INSERT INTO boxes(name,phase,created_at,updated_at) VALUES('grok-box-002','enrolled',1,1)");
      const r2 = openStore({ path, dir, readonly: true });
      expect((r2.db.query("SELECT COUNT(*) AS n FROM boxes").get() as { n: number }).n).toBe(2);
      expect((w.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      r.close();
      r2.close();
      w.close();
    } finally {
      cleanup(dir);
    }
  });
});

describe("(j) integrity", () => {
  test("quick_check reports ok on a healthy file and the flag round-trips", () => {
    const s = memStore();
    expect(s.quickCheck()).toBe("ok");
    expect(s.integrityFailedAt()).toBeUndefined();
    s.setIntegrityFailed(T0);
    expect(s.integrityFailedAt()).toBe(T0);
    s.clearIntegrityFailed();
    expect(s.integrityFailedAt()).toBeUndefined();
    s.close();
  });

  test("a truncated real file fails quick_check (or refuses to open) — never 'ok'", () => {
    const dir = scratchDir("corrupt");
    try {
      const path = storePath(dir);
      const s = openStore({ path, dir });
      for (let i = 0; i < 200; i++) {
        s.db.run(`INSERT INTO boxes(name,phase,created_at,updated_at) VALUES('grok-box-${100 + i}','enrolled',1,1)`);
      }
      s.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      s.close();

      // Scribble over the middle of the file: a real corruption, not a delete.
      const bytes = new Uint8Array(require("node:fs").readFileSync(path));
      bytes.fill(0x41, 4096, 8192);
      writeFileSync(path, bytes);

      let verdict = "";
      try {
        const c = openStore({ path, dir });
        verdict = c.quickCheck();
        c.close();
      } catch (e) {
        verdict = e instanceof ConfigError ? "refused-to-open" : String(e);
      }
      // MUTANT (m4): ignore the quick_check RESULT in dailyMaintenance /
      // startupIntegrityCheck ⇒ the halt tests in halt.test.ts fail; here we only
      // assert the primitive itself never lies.
      expect(verdict).not.toBe("ok");
    } finally {
      cleanup(dir);
    }
  });
});

describe("(k) audit retention at v1", () => {
  test("rows older than 92 days go; 91-day-old rows stay", () => {
    const s = memStore();
    const day = 86400;
    s.audit({ actor: "t", action: "old", at: T0 - 93 * day });
    s.audit({ actor: "t", action: "edge", at: T0 - 92 * day - 1 });
    s.audit({ actor: "t", action: "young", at: T0 - 91 * day });
    s.audit({ actor: "t", action: "now", at: T0 });
    expect(s.pruneAudit(AUDIT_RETENTION_DAYS, T0)).toBe(2);
    const left = (s.db.query("SELECT action FROM audit ORDER BY at").all() as Array<{ action: string }>).map(
      (r) => r.action,
    );
    expect(left).toEqual(["young", "now"]);
    s.close();
  });

  test("the audit table is v1, so Phase A's own rows have somewhere to go", () => {
    const s = memStore();
    s.audit({ actor: "reconcile", action: "divergence", box: "grok-box-003", detail: "file-only" });
    const row = s.db.query("SELECT actor, action, box, detail FROM audit").get() as Record<string, unknown>;
    expect(row).toEqual({ actor: "reconcile", action: "divergence", box: "grok-box-003", detail: "file-only" });
    s.close();
  });
});
