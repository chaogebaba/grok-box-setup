// backup.test.ts — the once-a-day backup step and restore (blueprint D9 (o)).

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { openStore, storePath } from "../../src/store/db.ts";
import { BACKUP_KEEP, backupDir, dailyMaintenance, restoreFile, utcDate } from "../../src/store/backup.ts";
import { cleanup, scratchDir, T0 } from "./helpers.ts";

const DAY = 86400;

describe("(o) backup and restore", () => {
  test("a same-day rerun REFRESHES the file rather than duplicating it", () => {
    const dir = scratchDir("backup-refresh");
    try {
      const s = openStore({ path: storePath(dir), dir, now: () => T0 });
      s.db.run(`INSERT INTO boxes(name,phase,created_at,updated_at) VALUES('grok-box-001','enrolled',${T0},${T0})`);

      const first = dailyMaintenance(s, { fleetState: dir, at: T0 });
      expect(first.ran).toBe(true);
      expect(first.quickCheck).toBe("ok");
      expect(first.file).toBe(`${backupDir(dir)}/fleet-${utcDate(T0)}.db`);
      expect(statSync(first.file!).mode & 0o777).toBe(0o600);
      expect(s.meta("last_backup_date")).toBe(utcDate(T0));

      // The SECOND call on the same date is a no-op: the tick's backup step runs
      // every tick and must cost nothing 287 times out of 288.
      const second = dailyMaintenance(s, { fleetState: dir, at: T0 + 60 });
      expect(second.ran).toBe(false);

      // `state backup` forces it, and the same-day file is refreshed in place.
      s.db.run(`INSERT INTO boxes(name,phase,created_at,updated_at) VALUES('grok-box-002','enrolled',${T0},${T0})`);
      const forced = dailyMaintenance(s, { fleetState: dir, at: T0 + 120, force: true });
      expect(forced.file).toBe(first.file);
      expect(readdirSync(backupDir(dir)).filter((f) => f.endsWith(".db"))).toHaveLength(1);
      s.close();
    } finally {
      cleanup(dir);
    }
  });

  test("the 8th backup prunes the oldest — 7 are kept", () => {
    const dir = scratchDir("backup-prune");
    try {
      const s = openStore({ path: storePath(dir), dir, now: () => T0 });
      s.db.run(`INSERT INTO boxes(name,phase,created_at,updated_at) VALUES('grok-box-001','enrolled',${T0},${T0})`);
      const dates: string[] = [];
      for (let d = 0; d < BACKUP_KEEP + 1; d++) {
        const at = T0 + d * DAY;
        dates.push(utcDate(at));
        expect(dailyMaintenance(s, { fleetState: dir, at }).ran).toBe(true);
      }
      const kept = readdirSync(backupDir(dir)).filter((f) => f.endsWith(".db")).sort();
      expect(kept).toHaveLength(BACKUP_KEEP);
      // The names are ISO dates, so name order IS date order and the oldest went.
      expect(kept).toEqual(dates.slice(1).map((d) => `fleet-${d}.db`));
      s.close();
    } finally {
      cleanup(dir);
    }
  });

  test("restore reopens with the same row count and clears the integrity flag", () => {
    const dir = scratchDir("restore");
    try {
      const path = storePath(dir);
      const s = openStore({ path, dir, now: () => T0 });
      for (let i = 0; i < 5; i++) {
        s.db.run(`INSERT INTO boxes(name,phase,created_at,updated_at) VALUES('grok-box-00${i}','enrolled',${T0},${T0})`);
      }
      const b = dailyMaintenance(s, { fleetState: dir, at: T0 });
      // Now damage the live file's CONTENT (rows, not bytes) and flag it.
      s.db.run("DELETE FROM boxes");
      s.setIntegrityFailed(T0);
      s.close();

      const r = restoreFile({ fleetState: dir, from: b.file!, dbPath: path });
      expect(r.rc).toBe(0);
      // The stale sidecars describe the file that was replaced, not its
      // replacement, so they are removed.
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(`${path}-shm`)).toBe(false);

      const back = openStore({ path, dir, now: () => T0 });
      expect(back.quickCheck()).toBe("ok");
      expect((back.db.query("SELECT COUNT(*) AS n FROM boxes").get() as { n: number }).n).toBe(5);
      // The flag lived in the damaged file; the restored one never had it.
      expect(back.integrityFailedAt()).toBeUndefined();
      back.close();
    } finally {
      cleanup(dir);
    }
  });

  test("restore refuses a file that does not exist", () => {
    const dir = scratchDir("restore-missing");
    try {
      const r = restoreFile({ fleetState: dir, from: `${dir}/nope.db`, dbPath: storePath(dir) });
      expect(r.rc).toBe(3);
      expect(r.message).toContain("nope.db");
    } finally {
      cleanup(dir);
    }
  });

  test("a FAILING quick_check sets the flag and takes NO backup", () => {
    const dir = scratchDir("backup-corrupt");
    try {
      const path = storePath(dir);
      const s = openStore({ path, dir, now: () => T0 });
      for (let i = 0; i < 200; i++) {
        s.db.run(`INSERT INTO boxes(name,phase,created_at,updated_at) VALUES('grok-box-${100 + i}','enrolled',1,1)`);
      }
      s.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      s.close();
      const bytes = new Uint8Array(require("node:fs").readFileSync(path));
      bytes.fill(0x41, 4096, 8192);
      writeFileSync(path, bytes);

      const c = openStore({ path, dir, now: () => T0 });
      const r = dailyMaintenance(c, { fleetState: dir, at: T0 });
      // MUTANT (m4): ignore the quick_check result here ⇒ this test fails, and a
      // database that has just declared itself corrupt is copied over the last
      // good recovery material.
      expect(r.integrityFailed).toBeDefined();
      expect(r.file).toBeUndefined();
      expect(existsSync(backupDir(dir))).toBe(false);
      // The flag is a WRITE, and a file this damaged can reject it. That must
      // never take the tick down with an uncaught SQLite error: the VERDICT is
      // what `finishStore` acts on (rc 3 for the tick that discovered it), and
      // the flag is only the memory for the next one.
      let flag: number | undefined;
      try {
        flag = c.integrityFailedAt();
      } catch {
        flag = undefined;
      }
      expect(flag === T0 || flag === undefined).toBe(true);
      c.close();
    } finally {
      cleanup(dir);
    }
  });
});
