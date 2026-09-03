// export.test.ts — the D6 legacy export round-trip (blueprint D9 (g)).
//
// A rollback to 5.7.1 is the Phase A rollback, so the four exported files must be
// correct at every instant: `parseEnrolled(exported)` has to equal the store's
// enrolled set, and `<box>.expires` / `keys/<idx>.json` have to be
// BYTE-IDENTICAL to what the 5.7.1 writers produce for the same inputs.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, chmodSync, statSync } from "node:fs";
import { parseEnrolled } from "../../src/boxes.ts";
import { openStore, storePath } from "../../src/store/db.ts";
import { StoreState } from "../../src/store/state.ts";
import { exportHeader, parseAuthorizedKeysMap } from "../../src/store/legacy.ts";
import { ReconcileState, nodeStateFs } from "../../src/reconcile/state.ts";
import { cleanup, suiteScratch, T0 } from "./helpers.ts";

// This file's own scratch bucket; dropped whole when the file finishes.
const SCRATCH = suiteScratch("export");
afterAll(() => SCRATCH.clean());

const VERSION = "5.8.0";

function fixture(prefix: string) {
  const dir = SCRATCH.dir(prefix);
  const state = `${dir}/state`;
  const etc = `${dir}/etc`;
  const store = openStore({ path: storePath(state), dir: state, now: () => T0 });
  const st = new StoreState(store, { paths: { fleetState: state, etc, version: VERSION } });
  return { dir, state, etc, store, st };
}

describe("(g) export round-trip", () => {
  test("enrolled.tsv parses back to exactly the enrolled rows, sorted by name", () => {
    const f = fixture("export-tsv");
    try {
      f.st.recordEnrolled("grok-box-005", 20005, "AAAAKEY005");
      f.st.recordEnrolled("grok-box-003", 20003, "AAAAKEY003");
      f.st.recordEnrolled("grok-box-011", 20011, "AAAAKEY011");
      expect(f.st.hasExportError()).toBe(false);

      const raw = readFileSync(`${f.state}/enrolled.tsv`, "utf8");
      // The header names the writer and says the file is an export. 5.7.1's own
      // `#` comment lines are deliberately NOT preserved — they were operator
      // annotations on a file the engine now owns (D6, note 5).
      expect(raw.startsWith(exportHeader(VERSION))).toBe(true);
      const body = raw.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
      // ordering is by NAME.
      expect(body).toEqual(["grok-box-003\t20003", "grok-box-005\t20005", "grok-box-011\t20011"]);
      // and it parses back to the store's own membership order.
      expect(parseEnrolled(raw)).toEqual(f.st.membership());
      // no tmp file left behind by the atomic write.
      expect(readdirSync(f.state).filter((n) => n.startsWith(".grokfleet-export."))).toEqual([]);
      store_close(f);
    } finally {
      cleanup(f.dir);
    }
  });

  test("retired and enrolling rows are ABSENT from both exports", () => {
    const f = fixture("export-phases");
    try {
      f.st.recordEnrolled("grok-box-003", 20003, "AAAAKEY003");
      f.store.db.run(
        `INSERT INTO boxes(name,idx,port,phase,created_at,updated_at,pubkey)
         VALUES('grok-box-004',4,20004,'retired',${T0},${T0},'AAAAKEY004'),
               ('grok-box-006',6,20006,'enrolling',${T0},${T0},'AAAAKEY006')`,
      );
      f.st.recordEnrolled("grok-box-005", 20005, "AAAAKEY005"); // re-export

      const tsv = readFileSync(`${f.state}/enrolled.tsv`, "utf8");
      // MUTANT (m7): make `enrolledForExport` select every row instead of
      // `WHERE phase='enrolled'` ⇒ this test fails.
      expect(parseEnrolled(tsv)).toEqual(["grok-box-003", "grok-box-005"]);
      const map = parseAuthorizedKeysMap(readFileSync(`${f.etc}/authorized-keys.map`, "utf8"));
      expect([...map.keys()].sort()).toEqual(["grok-box-003", "grok-box-005"]);
      store_close(f);
    } finally {
      cleanup(f.dir);
    }
  });

  test("<box>.expires and keys/<idx>.json are byte-identical to the 5.7.1 writers", () => {
    const f = fixture("export-keys");
    const ref = SCRATCH.dir("export-ref");
    try {
      f.st.recordEnrolled("grok-box-003", 20003, "AAAAKEY003");
      f.st.recordKey("grok-box-003", {
        keyId: "kABC",
        expiresRaw: "2027-01-31T12:00:00Z",
        expiresDate: "2027-01-31",
      });

      // The 5.7.1 writers, given the same inputs.
      const old = new ReconcileState(ref, nodeStateFs);
      old.mkdirState();
      old.recordKeyMeta(3, "kABC", "2027-01-31T12:00:00Z");
      old.writeExpires("grok-box-003", "2027-01-31");

      expect(readFileSync(`${f.state}/grok-box-003.expires`, "utf8")).toBe(
        readFileSync(`${ref}/grok-box-003.expires`, "utf8"),
      );
      expect(readFileSync(`${f.state}/keys/3.json`, "utf8")).toBe(readFileSync(`${ref}/keys/3.json`, "utf8"));
      // 0600, like every other exported artefact.
      expect(statSync(`${f.state}/keys/3.json`).mode & 0o777).toBe(0o600);
      expect(statSync(`${f.state}/grok-box-003.expires`).mode & 0o777).toBe(0o600);
      store_close(f);
    } finally {
      cleanup(f.dir);
      cleanup(ref);
    }
  });

  test("a NULL-port row keeps its membership across a rollback (empty port field)", () => {
    const f = fixture("export-nullport");
    try {
      f.store.db.run(
        `INSERT INTO boxes(name,idx,port,phase,created_at,updated_at) VALUES('grok-box-abc',NULL,NULL,'enrolled',${T0},${T0})`,
      );
      f.st.recordEnrolled("grok-box-003", 20003, "AAAAKEY003");
      const tsv = readFileSync(`${f.state}/enrolled.tsv`, "utf8");
      // `parseEnrolled` reads field 1 only (boxes.ts:51), so the row survives a
      // rollback even though there is no port to render for it.
      expect(parseEnrolled(tsv)).toContain("grok-box-abc");
      // But it is NOT in the map, which is a port→key binding.
      expect(parseAuthorizedKeysMap(readFileSync(`${f.etc}/authorized-keys.map`, "utf8")).has("grok-box-abc")).toBe(
        false,
      );
      // and the TICK skips it (D3/r3-n1).
      expect(f.st.membership()).toEqual(["grok-box-003"]);
      store_close(f);
    } finally {
      cleanup(f.dir);
    }
  });

  test("deleting the key row REMOVES both key files (the retire path)", () => {
    const f = fixture("export-remove");
    try {
      f.st.recordEnrolled("grok-box-003", 20003, "AAAAKEY003");
      f.st.recordKey("grok-box-003", { keyId: "kABC", expiresRaw: "raw", expiresDate: "2027-01-31" });
      expect(existsSync(`${f.state}/grok-box-003.expires`)).toBe(true);
      f.store.db.run("DELETE FROM box_keys");
      f.st.exportAll();
      expect(existsSync(`${f.state}/grok-box-003.expires`)).toBe(false);
      expect(existsSync(`${f.state}/keys/3.json`)).toBe(false);
      store_close(f);
    } finally {
      cleanup(f.dir);
    }
  });

  test("an export failure is RECORDED, never swallowed and never thrown", () => {
    const f = fixture("export-fail");
    try {
      f.st.recordEnrolled("grok-box-003", 20003, "AAAAKEY003");
      f.st.takeExportErrors();
      // Make $FLEET_STATE unwritable underneath the store.
      chmodSync(f.state, 0o500);
      try {
        f.st.recordEnrolled("grok-box-005", 20005, "AAAAKEY005");
        // The STORE write committed — that is the mutation, and it succeeded.
        expect(f.st.boxRow("grok-box-005")?.phase).toBe("enrolled");
        const errs = f.st.takeExportErrors();
        expect(errs).toHaveLength(1);
        expect(errs[0]).toContain("enrolled.tsv");
      } finally {
        chmodSync(f.state, 0o700);
      }
      store_close(f);
    } finally {
      cleanup(f.dir);
    }
  });
});

describe("rename inheritance through the store (D5)", () => {
  test("the new row copies exactly checkfail, cfgfail and the key row", () => {
    const f = fixture("rename");
    try {
      f.st.recordEnrolled("grok-box-3", 20003, "AAAAKEY3");
      f.st.recordKey("grok-box-3", { keyId: "kABC", expiresRaw: "raw", expiresDate: "2027-01-31" });
      for (let i = 0; i < 4; i++) f.st.bumpCheckfail("grok-box-3");
      for (let i = 0; i < 2; i++) f.st.bumpCfgfail("grok-box-3");
      f.st.bumpSeedfail("grok-box-3");
      f.st.bumpIncoherent("grok-box-3");

      // INSERT the new-name row FIRST, then copy — the two-row window is the
      // resume probe, and every abort path leaves both names valid.
      f.st.recordEnrolled("grok-box-003", 20003, "AAAAKEY3");
      f.st.copyRenameState("grok-box-3", "grok-box-003");
      expect(f.st.boxRow("grok-box-3")?.phase).toBe("enrolled");
      expect(f.st.boxRow("grok-box-003")?.phase).toBe("enrolled");

      expect(f.st.checkfailCount("grok-box-003")).toBe(4);
      const counters = f.store.db
        .query("SELECT * FROM box_counters WHERE box_id=(SELECT box_id FROM boxes WHERE name='grok-box-003')")
        .get() as Record<string, number>;
      expect(counters.cfgfail).toBe(2);
      // The other six start at their DEFAULTS — 5.7.1's copyState copied exactly
      // `expires`, `checkfail` and `cfgfail` and nothing else.
      expect(counters.seedfail).toBe(0);
      expect(counters.incoherent).toBe(0);
      expect(f.st.keyMetaId(3, "grok-box-003")).toBe("kABC");

      // The old row goes LAST.
      f.st.deleteBox("grok-box-3");
      expect(f.st.boxRow("grok-box-3")).toBeUndefined();
      expect(parseEnrolled(readFileSync(`${f.state}/enrolled.tsv`, "utf8"))).toEqual(["grok-box-003"]);
      store_close(f);
    } finally {
      cleanup(f.dir);
    }
  });
});

function store_close(f: { store: { close(): void } }): void {
  f.store.close();
}
