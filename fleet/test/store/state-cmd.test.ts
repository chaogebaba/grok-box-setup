// state-cmd.test.ts — `grokfleet state <sub>` (blueprint fleet2-state-store D8/D6,
// D9 (u) read-write reopen, (t) reconcile-files, (p) import --force).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { cmdState, RECONCILE_BUSY_LINE } from "../../src/commands/state.ts";
import { openStore, storePath } from "../../src/store/db.ts";
import { StoreState } from "../../src/store/state.ts";
import { checkDivergence } from "../../src/store/divergence.ts";
import { parseEnrolled } from "../../src/boxes.ts";
import { RC } from "../../src/upgrade.ts";
import { testEnv } from "../helpers.ts";
import { FakeRunner, result } from "../fake-runner.ts";
import { cleanup, put, suiteScratch, T0 } from "./helpers.ts";
import { setLogSink } from "../../src/log.ts";

// This file's own scratch bucket; dropped whole when the file finishes.
const SCRATCH = suiteScratch("state-cmd");
afterAll(() => SCRATCH.clean());

function deps(state: string, etc: string, over: Partial<Parameters<typeof cmdState>[1]> = {}) {
  const out: string[] = [];
  const notes: Array<{ level: string; msg: string }> = [];
  return {
    out,
    notes,
    d: {
      env: testEnv({ FLEET_STATE: state, FLEET_ETC: etc }),
      runner: new FakeRunner(() => result({ stdout: "" })),
      version: "5.8.0",
      notify: async (level: "info" | "warn", msg: string) => void notes.push({ level, msg }),
      acquireLock: async () => "ok" as const,
      out: (s: string) => out.push(s),
      now: () => T0,
      ...over,
    },
  };
}

function fixture(prefix: string) {
  const dir = SCRATCH.dir(prefix);
  const state = `${dir}/state`;
  const etc = `${dir}/etc`;
  const store = openStore({ path: storePath(state), dir: state, now: () => T0 });
  const st = new StoreState(store, { paths: { fleetState: state, etc, version: "5.8.0" } });
  return { dir, state, etc, store, st };
}

describe("state check", () => {
  test("reports schema, integrity and rows, and is READ-ONLY when the flag is clear", async () => {
    const f = fixture("check-ok");
    try {
      f.st.recordEnrolled("grok-box-003", 20003, "AAAAKEY003");
      f.store.db.run(
        `INSERT INTO boxes(name,idx,port,phase,created_at,updated_at) VALUES('grok-box-011',11,20011,'retired',${T0},${T0})`,
      );
      const writesBefore = f.store.db.query("SELECT COUNT(*) AS n FROM audit").get() as { n: number };
      f.store.close();

      const { out, d } = deps(f.state, f.etc);
      expect(await cmdState(["check"], d)).toBe(RC.OK);
      const text = out.join("");
      expect(text).toContain("user_version=4 min_reader=1");
      expect(text).toContain("quick_check   ok");
      expect(text).toContain("integrity     ok");
      // `state check` LISTS the retired and enrolling rows, and says nothing
      // about their online-ness: that is a Tailscale fact this local check does
      // not have (r4-n2).
      expect(text).toContain("retired   grok-box-011");
      expect(text).not.toContain("online");

      // It wrote NOTHING (D8/r3-n3: no migrations, no divergence check, no writes).
      const back = openStore({ path: storePath(f.state), dir: f.state, now: () => T0 });
      expect(back.db.query("SELECT COUNT(*) AS n FROM audit").get()).toEqual(writesBefore);
      back.close();
    } finally {
      cleanup(f.dir);
    }
  });

  test("a passing check CLEARS a set flag through the read-write reopen", async () => {
    const f = fixture("check-clear");
    try {
      f.store.setIntegrityFailed(T0);
      f.store.close();
      const { out, d } = deps(f.state, f.etc);
      expect(await cmdState(["check"], d)).toBe(RC.OK);
      expect(out.join("")).toContain("integrity flag CLEARED");
      const back = openStore({ path: storePath(f.state), dir: f.state, now: () => T0 });
      expect(back.integrityFailedAt()).toBeUndefined();
      // exactly one audit row for the clear, and nothing else.
      const rows = back.db.query("SELECT action FROM audit").all() as Array<{ action: string }>;
      expect(rows.map((r) => r.action)).toEqual(["integrity-cleared"]);
      back.close();
    } finally {
      cleanup(f.dir);
    }
  });

  test("the reopen is refused when the reconcile lock is busy — rc 6, flag left SET", async () => {
    const f = fixture("check-busy");
    try {
      f.store.setIntegrityFailed(T0);
      f.store.close();
      const { out, d } = deps(f.state, f.etc, { acquireLock: async () => "busy" as const });
      const journal: string[] = [];
      const prevSink = setLogSink((l) => journal.push(l));
      // rc 6 is the documented lock-busy code (r7-B2).
      expect(await cmdState(["check"], d)).toBe(RC.LOCK_BUSY);
      setLogSink(prevSink);
      const text = out.join("");
      // The PASSING check result still stands; only the clear did not happen.
      expect(text).toContain("quick_check   ok");
      // agent-ux U4: the refusal is a DIAGNOSTIC, so it moved to stderr — stdout
      // carries only the report (which may be a JSON document).
      expect(text).not.toContain(RECONCILE_BUSY_LINE);
      const err = journal.join("\n");
      expect(err).toContain(RECONCILE_BUSY_LINE);
      expect(err).toContain("integrity flag left SET");
      const back = openStore({ path: storePath(f.state), dir: f.state, now: () => T0 });
      expect(back.integrityFailedAt()).toBe(T0);
      back.close();
    } finally {
      cleanup(f.dir);
    }
  });

  test("duplicate enrolled ports and NULL-port rows are WARNINGS, never schema errors", async () => {
    const f = fixture("check-warn");
    try {
      // The rename window legitimately holds two rows on one port (D3), so this
      // is reported, never enforced.
      f.store.db.run(
        `INSERT INTO boxes(name,idx,port,phase,created_at,updated_at)
         VALUES('grok-box-3',3,20003,'enrolled',${T0},${T0}),
               ('grok-box-003',3,20003,'enrolled',${T0},${T0}),
               ('grok-box-abc',NULL,NULL,'enrolled',${T0},${T0})`,
      );
      f.store.close();
      const { out, d } = deps(f.state, f.etc);
      expect(await cmdState(["check"], d)).toBe(RC.OK);
      const text = out.join("");
      expect(text).toContain("port 20003 is held by 2 enrolled rows");
      expect(text).toContain("grok-box-abc has no port");
    } finally {
      cleanup(f.dir);
    }
  });
});

describe("state reconcile-files", () => {
  function withFinding(prefix: string) {
    const f = fixture(prefix);
    f.st.recordEnrolled("grok-box-003", 20003, "AAAAKEY003");
    f.st.takeExportErrors();
    // A rolled-back 5.7.1 adopted grok-box-011 and wrote it into the export,
    // with its pubkey in the map.
    require("node:fs").appendFileSync(`${f.state}/enrolled.tsv`, "grok-box-011\t20011\n");
    put(`${f.etc}/authorized-keys.map`, "grok-box-011\t20011\tAAAAKEY011\n");
    checkDivergence(f.store, { enrolledPath: `${f.state}/enrolled.tsv`, now: T0 });
    f.store.close();
    return f;
  }

  test("dry-run PRINTS the file-only row and changes nothing", async () => {
    const f = withFinding("rf-dry");
    try {
      const { out, d } = deps(f.state, f.etc);
      expect(await cmdState(["reconcile-files"], d)).toBe(RC.OK);
      const text = out.join("");
      expect(text).toContain("file-only  grok-box-011");
      expect(text).toContain("would import");
      expect(text).toContain("dry-run");
      const back = openStore({ path: storePath(f.state), dir: f.state, now: () => T0 });
      expect((back.db.query("SELECT COUNT(*) AS n FROM boxes").get() as { n: number }).n).toBe(1);
      back.close();
    } finally {
      cleanup(f.dir);
    }
  });

  test("--apply imports the row with its pubkey from the map and clears the finding", async () => {
    const f = withFinding("rf-apply");
    try {
      const { out, d } = deps(f.state, f.etc);
      expect(await cmdState(["reconcile-files", "--apply"], d)).toBe(RC.OK);
      expect(out.join("")).toContain("pubkey=from map");
      const back = openStore({ path: storePath(f.state), dir: f.state, now: () => T0 });
      const row = back.db.query("SELECT phase, port, pubkey FROM boxes WHERE name='grok-box-011'").get() as Record<
        string,
        unknown
      >;
      expect(row.phase).toBe("enrolled");
      expect(row.port).toBe(20011);
      expect(row.pubkey).toBe("AAAAKEY011");
      expect((back.db.query("SELECT COUNT(*) AS n FROM divergence_findings").get() as { n: number }).n).toBe(0);
      expect(
        (back.db.query("SELECT COUNT(*) AS n FROM audit WHERE action='divergence-cleared'").get() as { n: number }).n,
      ).toBe(1);
      back.close();
      // and the export now contains it.
      expect(parseEnrolled(readFileSync(`${f.state}/enrolled.tsv`, "utf8"))).toEqual([
        "grok-box-003",
        "grok-box-011",
      ]);
    } finally {
      cleanup(f.dir);
    }
  });

  test("a name matching a RETIRED row is REVIVED on that row, never inserted twice", async () => {
    const f = withFinding("rf-revive");
    try {
      const s = openStore({ path: storePath(f.state), dir: f.state, now: () => T0 });
      s.db.run(
        `INSERT INTO boxes(name,idx,port,phase,created_at,updated_at,retired_at)
         VALUES('grok-box-011',11,20011,'retired',${T0},${T0},${T0})`,
      );
      s.close();
      const { d } = deps(f.state, f.etc);
      expect(await cmdState(["reconcile-files", "--apply"], d)).toBe(RC.OK);
      const back = openStore({ path: storePath(f.state), dir: f.state, now: () => T0 });
      const rows = back.db.query("SELECT phase, retired_at FROM boxes WHERE name='grok-box-011'").all() as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.phase).toBe("enrolled");
      expect(rows[0]!.retired_at).toBeNull();
      back.close();
    } finally {
      cleanup(f.dir);
    }
  });

  test("a store-only row is only PRINTED, with the retire command — never retired automatically", async () => {
    const f = fixture("rf-store-only");
    try {
      f.st.recordEnrolled("grok-box-003", 20003, "AAAAKEY003");
      f.st.recordEnrolled("grok-box-005", 20005, "AAAAKEY005");
      f.st.takeExportErrors();
      require("node:fs").writeFileSync(`${f.state}/enrolled.tsv`, "grok-box-003\t20003\n");
      checkDivergence(f.store, { enrolledPath: `${f.state}/enrolled.tsv`, now: T0 });
      f.store.close();

      const { out, d } = deps(f.state, f.etc);
      expect(await cmdState(["reconcile-files", "--apply"], d)).toBe(RC.OK);
      const text = out.join("");
      expect(text).toContain("store-only grok-box-005");
      expect(text).toContain("grokfleet retire grok-box-005");
      const back = openStore({ path: storePath(f.state), dir: f.state, now: () => T0 });
      expect(
        (back.db.query("SELECT phase FROM boxes WHERE name='grok-box-005'").get() as { phase: string }).phase,
      ).toBe("enrolled");
      back.close();
    } finally {
      cleanup(f.dir);
    }
  });

  test("--apply refuses with the existing busy message while the lock is held", async () => {
    const f = withFinding("rf-busy");
    try {
      const { d } = deps(f.state, f.etc, { acquireLock: async () => "busy" as const });
      expect(await cmdState(["reconcile-files", "--apply"], d)).toBe(RC.LOCK_BUSY);
      const back = openStore({ path: storePath(f.state), dir: f.state, now: () => T0 });
      expect((back.db.query("SELECT COUNT(*) AS n FROM boxes").get() as { n: number }).n).toBe(1);
      back.close();
    } finally {
      cleanup(f.dir);
    }
  });
});

describe("state import", () => {
  test("--force refuses while the reconcile lock is held", async () => {
    const f = fixture("import-busy");
    try {
      f.store.close();
      const { d } = deps(f.state, f.etc, { acquireLock: async () => "busy" as const });
      expect(await cmdState(["import", "--force"], d)).toBe(RC.LOCK_BUSY);
    } finally {
      cleanup(f.dir);
    }
  });

  test("an already-imported store says so rather than replaying", async () => {
    const f = fixture("import-already");
    try {
      f.store.setMeta("legacy_imported_at", String(T0));
      f.store.close();
      const { out, d } = deps(f.state, f.etc);
      expect(await cmdState(["import"], d)).toBe(RC.OK);
      expect(out.join("")).toContain("already imported");
    } finally {
      cleanup(f.dir);
    }
  });

  test("an unknown subcommand is rc 2", async () => {
    const f = fixture("usage");
    try {
      f.store.close();
      const { d } = deps(f.state, f.etc);
      expect(await cmdState(["nonsense"], d)).toBe(RC.USAGE);
      expect(await cmdState([], d)).toBe(RC.USAGE);
    } finally {
      cleanup(f.dir);
    }
  });
});

describe("state backup / restore", () => {
  test("backup writes a dated file and restore brings the rows back", async () => {
    const f = fixture("cmd-backup");
    try {
      f.st.recordEnrolled("grok-box-003", 20003, "AAAAKEY003");
      f.st.takeExportErrors();
      f.store.close();

      const { out, d } = deps(f.state, f.etc);
      expect(await cmdState(["backup"], d)).toBe(RC.OK);
      expect(out.join("")).toContain("quick_check ok");

      // Lose the row, then restore.
      const s = openStore({ path: storePath(f.state), dir: f.state, now: () => T0 });
      s.db.run("DELETE FROM boxes");
      s.close();

      const file = out.join("").match(/backup (\S+\.db)/)![1]!;
      const { out: out2, d: d2 } = deps(f.state, f.etc);
      expect(await cmdState(["restore", file], d2)).toBe(RC.OK);
      expect(out2.join("")).toContain("1 box row(s)");
    } finally {
      cleanup(f.dir);
    }
  });

  test("restore without a file is rc 2", async () => {
    const f = fixture("cmd-restore-usage");
    try {
      f.store.close();
      const { d } = deps(f.state, f.etc);
      expect(await cmdState(["restore"], d)).toBe(RC.USAGE);
    } finally {
      cleanup(f.dir);
    }
  });
});

// ---- r2/R2(b): state forget-key ---------------------------------------------
//
// A1's automatic forget fires on a NEW tunnel pubkey, which is the re-image
// signal. It cannot help a box that was already re-enrolled before 5.12.1
// shipped: the r1 gate found grok-box-011 on the production VPS with a key
// minted 2026-08-30 against a binding of 2026-09-06, no secrets/ts-authkey on
// the box, and the post-re-image pubkey already recorded. No tick repairs that.
// This command is the remediation half.

const DAY = 86_400;

/** A box enrolled at `bound` whose key was minted at `minted`. */
function staleFixture(prefix: string, minted: number, bound: number) {
  const f = fixture(prefix);
  f.st.recordEnrolled("grok-box-011", 20011, "AAAAKEY011");
  // recordKey EXPORTS, so `<box>.expires` and `keys/11.json` really exist on
  // disk before the forget — otherwise asserting their absence afterwards
  // proves nothing at all.
  f.st.recordKey("grok-box-011", {
    keyId: "k56iJtXxsJ11CNTRL",
    expiresRaw: "2026-11-28T00:00:00Z",
    expiresDate: "2026-11-28",
  });
  f.store.db.query("UPDATE boxes SET enrolled_at=? WHERE name='grok-box-011'").run(bound);
  f.store.db.query("UPDATE box_keys SET minted_at=?").run(minted);
  return f;
}

function quietLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  return { lines, restore: () => setLogSink(prev) };
}

describe("state forget-key (r2/R2(b))", () => {
  test("a STALE key is forgotten: rc 0, the row goes, and the log names both instants", async () => {
    // 011's real production numbers, seven days apart.
    const f = staleFixture("forget-stale", T0, T0 + 7 * DAY);
    const cap = quietLogs();
    try {
      f.store.close();
      const { out, d } = deps(f.state, f.etc);
      const rc = await cmdState(["forget-key", "grok-box-011"], d);
      expect(rc).toBe(RC.OK);

      const line = out.join("");
      expect(line).toContain("state: forgot key k56iJtXxsJ11CNTRL for grok-box-011");
      // Both instants, so the record says WHY it was safe to drop.
      expect(line).toContain("minted 2026-05-28T20:26:40Z < bound 2026-06-04T20:26:40Z");

      // The row is gone, and so is the exported artefact ON DISK. Asserting
      // `readExpiresDate` alone is not enough: that reads the ROW, so it answers
      // undefined even when the file survives. A forget that drops the row and
      // leaves `<box>.expires` behind is a file describing a key that no longer
      // exists — most of the lie this command exists to clear — and a mutant
      // that skipped the export survived until this assertion existed.
      expect(existsSync(`${f.state}/grok-box-011.expires`)).toBe(false);
      expect(existsSync(`${f.state}/keys/11.json`)).toBe(false);

      const store = openStore({ path: storePath(f.state), dir: f.state, now: () => T0 });
      const row = store.db.query("SELECT COUNT(*) AS n FROM box_keys").get() as { n: number };
      expect(row.n).toBe(0);
      const st = new StoreState(store);
      expect(st.readExpiresDate("grok-box-011")).toBeUndefined();
      // ...and the delete carries an audit row, committed with it.
      const audit = store.db
        .query("SELECT COUNT(*) AS n FROM audit WHERE action='forget-key' AND box='grok-box-011'")
        .get() as { n: number };
      expect(audit.n).toBe(1);
      store.close();
    } finally {
      cap.restore();
      cleanup(f.dir);
    }
  });

  test("a LIVE key is REFUSED rc 1, names --force, and is still there afterwards", async () => {
    // Minted AFTER the binding: exactly the key the tick just seeded.
    const f = staleFixture("forget-live", T0 + 7 * DAY, T0);
    const cap = quietLogs();
    try {
      f.store.close();
      const { d } = deps(f.state, f.etc);
      const rc = await cmdState(["forget-key", "grok-box-011"], d);
      expect(rc).toBe(RC.FAILURE);
      const msg = cap.lines.join("\n");
      expect(msg).toContain("is NOT stale");
      expect(msg).toContain("--force");
      // The refusal names the numbers it rests on, not just the verdict.
      expect(msg).toContain("minted 2026-06-04T20:26:40Z");
      expect(msg).toContain("bound 2026-05-28T20:26:40Z");

      const store = openStore({ path: storePath(f.state), dir: f.state, now: () => T0 });
      expect((store.db.query("SELECT COUNT(*) AS n FROM box_keys").get() as { n: number }).n).toBe(1);
      store.close();
    } finally {
      cap.restore();
      cleanup(f.dir);
    }
  });

  test("--force drops a live key, and says so in the reason", async () => {
    const f = staleFixture("forget-force", T0 + 7 * DAY, T0);
    const cap = quietLogs();
    try {
      f.store.close();
      const { out, d } = deps(f.state, f.etc);
      const rc = await cmdState(["forget-key", "grok-box-011", "--force"], d);
      expect(rc).toBe(RC.OK);
      expect(out.join("")).toContain("--force");

      const store = openStore({ path: storePath(f.state), dir: f.state, now: () => T0 });
      expect((store.db.query("SELECT COUNT(*) AS n FROM box_keys").get() as { n: number }).n).toBe(0);
      store.close();
    } finally {
      cap.restore();
      cleanup(f.dir);
    }
  });

  test("no box name ⇒ usage; a bad name ⇒ usage; both write nothing", async () => {
    const f = staleFixture("forget-usage", T0, T0 + 7 * DAY);
    const cap = quietLogs();
    try {
      f.store.close();
      const { d } = deps(f.state, f.etc);
      expect(await cmdState(["forget-key"], d)).toBe(RC.USAGE);
      expect(await cmdState(["forget-key", "not-a-box"], d)).toBe(RC.USAGE);
      expect(await cmdState(["forget-key", "--force"], d)).toBe(RC.USAGE);

      const store = openStore({ path: storePath(f.state), dir: f.state, now: () => T0 });
      expect((store.db.query("SELECT COUNT(*) AS n FROM box_keys").get() as { n: number }).n).toBe(1);
      store.close();
    } finally {
      cap.restore();
      cleanup(f.dir);
    }
  });

  test("a box with no key row, and a box with no store row, each fail rc 1", async () => {
    const f = fixture("forget-absent");
    const cap = quietLogs();
    try {
      f.st.recordEnrolled("grok-box-011", 20011, "AAAAKEY011");
      f.store.close();
      const { d } = deps(f.state, f.etc);
      expect(await cmdState(["forget-key", "grok-box-011"], d)).toBe(RC.FAILURE);
      expect(cap.lines.join("\n")).toContain("has no recorded key");
      expect(await cmdState(["forget-key", "grok-box-099"], d)).toBe(RC.FAILURE);
      expect(cap.lines.join("\n")).toContain("has no store row");
    } finally {
      cap.restore();
      cleanup(f.dir);
    }
  });

  test("the usage line for `state` with no subcommand advertises forget-key", async () => {
    const f = fixture("forget-usage-line");
    const cap = quietLogs();
    try {
      f.store.close();
      const { d } = deps(f.state, f.etc);
      expect(await cmdState([], d)).toBe(RC.USAGE);
      expect(cap.lines.join("\n")).toContain("forget-key <box> [--force]");
    } finally {
      cap.restore();
      cleanup(f.dir);
    }
  });
});
