// rename.test.ts — D9 (l): the rename matrix against the store
// (blueprint fleet2-state-store D5, Phase B).
//
// Rename is copy-first / delete-last on purpose: the new-name row is INSERTED
// before any external step and the old row is DELETED after the last one, so
// every abort path leaves BOTH names valid and re-running resumes. This file
// pins the three things that makes true — the two-row window, the resume probe
// and the inheritance rule — plus the export that follows each write.
//
// Mutant (m2) skips the export after the old row is deleted, and the "the export
// no longer lists the old name" assertions are what kill it.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { openStore, storePath } from "../../src/store/db.ts";
import { StoreState } from "../../src/store/state.ts";
import { parseEnrolled } from "../../src/boxes.ts";
import { setLogSink } from "../../src/log.ts";
import { cleanup, suiteScratch, T0 } from "./helpers.ts";

// This file's own scratch bucket; dropped whole when the file finishes.
const SCRATCH = suiteScratch("rename");
afterAll(() => SCRATCH.clean());

const OLD = "grok-box-11";
const NEW = "grok-box-011";
const PORT = 20011;

function fixture(): {
  dir: string;
  state: string;
  etc: string;
  open: () => { store: ReturnType<typeof openStore>; st: StoreState };
} {
  const dir = SCRATCH.dir("rename");
  const state = `${dir}/state`;
  const etc = `${dir}/etc`;
  const open = (): { store: ReturnType<typeof openStore>; st: StoreState } => {
    const store = openStore({ path: storePath(state), dir: state, now: () => T0 });
    return { store, st: new StoreState(store, { paths: { fleetState: state, etc, version: "5.9.0" } }) };
  };
  return { dir, state, etc, open };
}

function quiet<T>(fn: () => T): T {
  const prev = setLogSink(() => {});
  try {
    return fn();
  } finally {
    setLogSink(prev);
  }
}

/** The exported membership, as `parseEnrolled` (i.e. 5.7.1) reads it. */
function exported(state: string): string[] {
  return parseEnrolled(readFileSync(`${state}/enrolled.tsv`, "utf8"));
}

describe("(l) the rename matrix", () => {
  test("the two-row window: both names are enrolled between the insert and the delete", () => {
    const f = fixture();
    try {
      quiet(() => {
        const { store, st } = f.open();
        st.recordEnrolled(OLD, PORT, "AAAAKEY");
        st.recordKey(OLD, { keyId: "kOLD", expiresRaw: "2027-01-31T12:00:00Z", expiresDate: "2027-01-31" });
        st.bumpCheckfail(OLD);
        st.bumpCheckfail(OLD);
        st.bumpCfgfail(OLD);
        st.bumpSeedfail(OLD); // NOT inherited
        st.bumpIncoherent(OLD); // NOT inherited

        // --- step 1: the new-name row goes in FIRST, same port ---
        const oldRow = st.boxRow(OLD)!;
        st.recordEnrolled(NEW, oldRow.port!, oldRow.pubkey ?? undefined);
        st.copyRenameState(OLD, NEW);

        // BOTH names are members and BOTH are exported — this is the window the
        // resume probe reads, and it is why an abort here is recoverable.
        expect(st.membership().sort()).toEqual([NEW, OLD]);
        expect(exported(f.state).sort()).toEqual([NEW, OLD]);
        // Two enrolled rows on ONE port: legitimate here, which is why the
        // schema has no UNIQUE on `port` and `state check` only WARNS.
        const onPort = store.db
          .query("SELECT COUNT(*) AS n FROM boxes WHERE port = ? AND phase = 'enrolled'")
          .get(PORT) as { n: number };
        expect(onPort.n).toBe(2);

        // --- inheritance: EXACTLY checkfail, cfgfail and the key row ---
        const id = st.boxRow(NEW)!.box_id;
        const c = store.db
          .query("SELECT checkfail, cfgfail, seedfail, incoherent FROM box_counters WHERE box_id = ?")
          .get(id) as { checkfail: number; cfgfail: number; seedfail: number; incoherent: number };
        expect(c).toEqual({ checkfail: 2, cfgfail: 1, seedfail: 0, incoherent: 0 });
        expect(st.keyMetaId(11, NEW)).toBe("kOLD");

        // --- step 2: the old row goes LAST ---
        st.deleteBox(OLD);
        expect(st.membership()).toEqual([NEW]);
        // (m2): without the export after the delete this still says both names.
        expect(exported(f.state)).toEqual([NEW]);
        expect(st.boxRow(OLD)).toBeUndefined();
        store.close();
      });
    } finally {
      cleanup(f.dir);
    }
  });

  test("a box with NO counter row yet renames cleanly (nothing inherits a count never recorded)", () => {
    const f = fixture();
    try {
      quiet(() => {
        const { store, st } = f.open();
        // Freshly enrolled: `box_counters` is created lazily on the first bump,
        // so this box has none. The inheritance UPDATE used to read NULL into
        // two NOT NULL columns and throw, which rename reported as "failed to
        // copy brain state" — i.e. a box could not be renamed until it had
        // failed a check at least once.
        st.recordEnrolled(OLD, PORT, "AAAAKEY");
        st.recordEnrolled(NEW, PORT, "AAAAKEY");
        st.copyRenameState(OLD, NEW);
        const id = st.boxRow(NEW)!.box_id;
        const c = store.db.query("SELECT checkfail, cfgfail FROM box_counters WHERE box_id = ?").get(id) as {
          checkfail: number;
          cfgfail: number;
        };
        expect(c).toEqual({ checkfail: 0, cfgfail: 0 });
        store.close();
      });
    } finally {
      cleanup(f.dir);
    }
  });

  test("the resume probe: `hasEnrolledRow(new)` is what tells a re-run the copy already happened", () => {
    const f = fixture();
    try {
      quiet(() => {
        const { store, st } = f.open();
        st.recordEnrolled(OLD, PORT, "AAAAKEY");
        // before the copy: no new-name row, so a re-run starts from the copy
        expect(st.boxRow(NEW)?.phase).toBeUndefined();
        st.recordEnrolled(NEW, PORT, "AAAAKEY");
        // after it: the probe reads `enrolled` and the re-run continues from the
        // box step instead of copying again.
        expect(st.boxRow(NEW)?.phase).toBe("enrolled");
        store.close();
      });
    } finally {
      cleanup(f.dir);
    }
  });

  test("the old row's delete removes `<old>.expires` and LEAVES `keys/<idx>.json`", () => {
    const f = fixture();
    try {
      quiet(() => {
        const { store, st } = f.open();
        st.recordEnrolled(OLD, PORT, "AAAAKEY");
        st.recordKey(OLD, { keyId: "kOLD", expiresRaw: "2027-01-31T12:00:00Z", expiresDate: "2027-01-31" });
        expect(existsSync(`${f.state}/${OLD}.expires`)).toBe(true);
        expect(existsSync(`${f.state}/keys/11.json`)).toBe(true);

        st.recordEnrolled(NEW, PORT, "AAAAKEY");
        st.copyRenameState(OLD, NEW);
        st.deleteBox(OLD);
        // The rename-wiring removes `<old>.expires` explicitly; the point here is
        // that `keys/11.json` SURVIVES — old and new share the index in the
        // canonical 1-2-digit to 3-digit rename, so that file belongs to the
        // surviving row (r2-B6).
        expect(existsSync(`${f.state}/keys/11.json`)).toBe(true);
        expect(readFileSync(`${f.state}/keys/11.json`, "utf8")).toContain("kOLD");
        expect(existsSync(`${f.state}/${NEW}.expires`)).toBe(true);
        store.close();
      });
    } finally {
      cleanup(f.dir);
    }
  });

  test("a rename leaves an audit trail of both halves", () => {
    const f = fixture();
    try {
      quiet(() => {
        const { store, st } = f.open();
        st.recordEnrolled(OLD, PORT, "AAAAKEY");
        st.recordEnrolled(NEW, PORT, "AAAAKEY");
        st.copyRenameState(OLD, NEW);
        st.deleteBox(OLD);
        const actions = (
          store.db.query("SELECT action, box FROM audit ORDER BY id").all() as Array<{ action: string; box: string }>
        ).map((a) => `${a.action}:${a.box}`);
        expect(actions).toContain(`enrolled:${NEW}`);
        expect(actions).toContain(`rename-copy:${NEW}`);
        expect(actions).toContain(`row-deleted:${OLD}`);
        store.close();
      });
    } finally {
      cleanup(f.dir);
    }
  });

  test("a RETIRED old row is not exported during the window, and the new name still lands", () => {
    const f = fixture();
    try {
      quiet(() => {
        const { store, st } = f.open();
        st.recordEnrolled(OLD, PORT, "AAAAKEY");
        st.transition(OLD, "enrolled", "retired", "operator");
        // A retired row is not a member, so the "two-row window" does not apply
        // to it: only the new name is exported.
        st.recordEnrolled(NEW, PORT, "AAAAKEY");
        expect(exported(f.state)).toEqual([NEW]);
        expect(st.membership()).toEqual([NEW]);
        store.close();
      });
    } finally {
      cleanup(f.dir);
    }
  });
});
