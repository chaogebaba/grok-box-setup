// retire.test.ts — D9 (r): `grokfleet retire` (blueprint fleet2-state-store D4).
//
// The command is driven end to end against a real store under the worker
// scratch, so the assertions cover what an operator actually gets: the row's
// phase, the VPS authorized_keys rewrite, the /etc mapping line, the revoke, the
// export and the exit code.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  cmdRetire,
  parseRetireArgs,
  removeAuthorizedKeysLines,
  type RetireDeps,
  type RetireOps,
} from "../../src/commands/retire.ts";
import { RC } from "../../src/upgrade.ts";
import { openStore, storePath } from "../../src/store/db.ts";
import { StoreState } from "../../src/store/state.ts";
import { selectCandidates } from "../../src/reconcile/discover.ts";
import type { DiscoverRow } from "../../src/commands/list.ts";
import { setLogSink } from "../../src/log.ts";
import { cleanup, put, suiteScratch, T0 } from "../store/helpers.ts";
import { testEnv } from "../helpers.ts";
import { FakeRunner } from "../fake-runner.ts";

// This file's own scratch bucket; dropped whole when the file finishes.
const SCRATCH = suiteScratch("retire");
afterAll(() => SCRATCH.clean());

const BOX = "grok-box-011";
const PORT = 20011;
const KEY = "AAAAKEY011";
const AK_LINE = `restrict,port-forwarding,permitlisten="127.0.0.1:${PORT}" ssh-ed25519 ${KEY} grok-tunnel`;

interface Ops extends RetireOps {
  removedLines: number;
  etcRemoved: string[];
  revoked: string[];
  lockTaken: number;
}

function fixture(over: { lock?: "ok" | "busy" | "open-fail"; akWritable?: boolean; revokeOk?: boolean } = {}): {
  dir: string;
  env: ReturnType<typeof testEnv>;
  deps: RetireDeps;
  ops: Ops;
  notifies: Array<{ level: string; msg: string }>;
  out: string[];
  st: () => StoreState;
} {
  const dir = SCRATCH.dir("retire");
  const state = `${dir}/state`;
  const etc = `${dir}/etc`;
  const env = testEnv({ FLEET_STATE: state, FLEET_ETC: etc });

  // A store with one ENROLLED box, its key row and its exported artefacts.
  const store = openStore({ path: storePath(state), dir: state, now: () => T0 });
  const st = new StoreState(store, { paths: { fleetState: state, etc, version: "5.9.0" } });
  st.recordEnrolled(BOX, PORT, KEY);
  st.recordKey(BOX, { keyId: "kRETIRE", expiresRaw: "2027-01-31T12:00:00Z", expiresDate: "2027-01-31" });
  store.close();
  put(`${etc}/authorized-keys.d/${BOX}.line`, AK_LINE + "\n");

  const notifies: Array<{ level: string; msg: string }> = [];
  const out: string[] = [];
  const ops: Ops = {
    removedLines: 0,
    etcRemoved: [],
    revoked: [],
    lockTaken: 0,
    removeVpsAuthorizedKey(port, pubkey) {
      if (over.akWritable === false) return undefined;
      const r = removeAuthorizedKeysLines(`${AK_LINE}\nsome-other-line\n`, port, pubkey);
      this.removedLines = r.removed;
      return r.removed;
    },
    removeEtcLine(box) {
      this.etcRemoved.push(box);
      try {
        (require("node:fs") as typeof import("node:fs")).rmSync(`${etc}/authorized-keys.d/${box}.line`, { force: true });
      } catch {
        return false;
      }
      return true;
    },
    async revokeKey(id) {
      this.revoked.push(id);
      return over.revokeOk === false ? { ok: false, code: 500 } : { ok: true, code: 200 };
    },
    async acquireLock() {
      this.lockTaken += 1;
      return over.lock ?? "ok";
    },
  };

  const deps: RetireDeps = {
    env,
    runner: new FakeRunner(() => ({ stdout: "" })),
    ops,
    async notify(level, msg) {
      notifies.push({ level, msg });
    },
    open: () => {
      const s = openStore({ path: storePath(state), dir: state, now: () => T0 });
      return {
        store: s,
        state: new StoreState(s, { paths: { fleetState: state, etc, version: "5.9.0" } }),
        close: () => s.close(),
      };
    },
    out: (s) => out.push(s),
  };

  return {
    dir,
    env,
    deps,
    ops,
    notifies,
    out,
    st: () => {
      const s = openStore({ path: storePath(state), dir: state, readonly: true });
      return new StoreState(s);
    },
  };
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const prev = setLogSink(() => {});
  try {
    return await fn();
  } finally {
    setLogSink(prev);
  }
}

describe("retire: argument parsing", () => {
  test("the flags are order-independent and the positional is mandatory", () => {
    expect(parseRetireArgs(["grok-box-011"])).toEqual({ box: "grok-box-011", forget: false, dryRun: false });
    expect(parseRetireArgs(["--forget", "grok-box-011"])).toEqual({ box: "grok-box-011", forget: true, dryRun: false });
    expect(parseRetireArgs(["grok-box-011", "--dry-run"])).toEqual({ box: "grok-box-011", forget: false, dryRun: true });
    expect(parseRetireArgs([])).toEqual({ usage: true });
    expect(parseRetireArgs(["--wat", "grok-box-011"])).toEqual({ usage: true });
    // two positionals is a mistake, not a batch: retire is one box at a time.
    expect(parseRetireArgs(["grok-box-011", "grok-box-012"])).toEqual({ usage: true });
  });
});

describe("removeAuthorizedKeysLines (pure)", () => {
  test("drops the lines carrying the box's PORT or its key material, keeps the rest", () => {
    const content = [
      `restrict,permitlisten="127.0.0.1:20011" ssh-ed25519 AAAAOLD old`, // same port, stale key
      `restrict,permitlisten="127.0.0.1:20012" ssh-ed25519 ${KEY} moved`, // same key, other port
      `restrict,permitlisten="127.0.0.1:20013" ssh-ed25519 AAAAOTHER keep`,
      "",
    ].join("\n");
    const r = removeAuthorizedKeysLines(content, 20011, `ssh-ed25519 ${KEY}`);
    expect(r.removed).toBe(2);
    expect(r.text).toBe(`restrict,permitlisten="127.0.0.1:20013" ssh-ed25519 AAAAOTHER keep\n`);
  });

  test("an empty result is an EMPTY file, not a stray newline", () => {
    expect(removeAuthorizedKeysLines(`x permitlisten="127.0.0.1:20011" y\n`, 20011, null).text).toBe("");
  });

  test("a null pubkey matches on the port alone", () => {
    const r = removeAuthorizedKeysLines(`a permitlisten="127.0.0.1:20011" b\nkeep\n`, 20011, null);
    expect(r.removed).toBe(1);
    expect(r.text).toBe("keep\n");
  });
});

describe("(r) grokfleet retire", () => {
  test("the happy path: row retired, artefacts removed, key revoked, export rewritten", async () => {
    const f = fixture();
    try {
      const rc = await quiet(() => cmdRetire([BOX], f.deps));
      expect(rc).toBe(RC.OK);

      const st = f.st();
      const row = st.boxRow(BOX)!;
      expect(row.phase).toBe("retired");
      expect(row.retired_at).toBe(T0);
      // membership is `phase='enrolled'` ONLY
      expect(st.membership()).toEqual([]);
      // the key row is gone, so the export removed both key artefacts
      expect(st.keyMetaId(11, BOX)).toBeUndefined();
      st.store.close();

      expect(f.ops.removedLines).toBe(1);
      expect(f.ops.etcRemoved).toEqual([BOX]);
      expect(existsSync(`${f.env.FLEET_ETC}/authorized-keys.d/${BOX}.line`)).toBe(false);
      expect(f.ops.revoked).toEqual(["kRETIRE"]);
      expect(existsSync(`${f.env.FLEET_STATE}/${BOX}.expires`)).toBe(false);
      expect(existsSync(`${f.env.FLEET_STATE}/keys/11.json`)).toBe(false);

      // the export no longer lists the box
      const tsv = readFileSync(`${f.env.FLEET_STATE}/enrolled.tsv`, "utf8");
      expect(tsv).not.toContain(BOX);
      expect(f.notifies.some((n) => n.level === "info" && n.msg.includes(`retired ${BOX}`))).toBe(true);
      expect(f.out.join("")).toContain("NOT adoptable");
    } finally {
      cleanup(f.dir);
    }
  });

  test("the retired name is not adoptable, three ticks later", async () => {
    const f = fixture();
    try {
      await quiet(() => cmdRetire([BOX], f.deps));
      const st = f.st();
      const peers: DiscoverRow[] = [{ index: 11, name: BOX, ip: "100.64.0.1", online: "yes" } as DiscoverRow];
      for (let tick = 0; tick < 3; tick++) {
        const sel = selectCandidates(peers, st.membership(), st.excludedNames());
        expect(sel.candidates).toEqual([]);
        expect(sel.skipped).toEqual([]);
      }
      st.store.close();
    } finally {
      cleanup(f.dir);
    }
  });

  test("--forget deletes the row and frees the name", async () => {
    const f = fixture();
    try {
      expect(await quiet(() => cmdRetire(["--forget", BOX], f.deps))).toBe(RC.OK);
      const st = f.st();
      expect(st.boxRow(BOX)).toBeUndefined();
      expect(st.excludedNames().size).toBe(0);
      // the audit history SURVIVES the row (audit.box is plain TEXT)
      const audit = st.store.db.query("SELECT action FROM audit WHERE box = ? ORDER BY id").all(BOX) as Array<{
        action: string;
      }>;
      expect(audit.map((a) => a.action)).toContain("retire-forget");
      st.store.close();
      expect(f.out.join("")).toContain("FORGOTTEN");
    } finally {
      cleanup(f.dir);
    }
  });

  test("--dry-run changes NOTHING and takes no lock", async () => {
    const f = fixture();
    try {
      expect(await quiet(() => cmdRetire([BOX, "--dry-run"], f.deps))).toBe(RC.OK);
      const st = f.st();
      expect(st.boxRow(BOX)!.phase).toBe("enrolled");
      expect(st.membership()).toEqual([BOX]);
      st.store.close();
      expect(f.ops.lockTaken).toBe(0);
      expect(f.ops.revoked).toEqual([]);
      expect(existsSync(`${f.env.FLEET_ETC}/authorized-keys.d/${BOX}.line`)).toBe(true);
      expect(f.out.join("")).toContain("DRY-RUN");
      // it names the known_hosts decision explicitly — the pin is LEFT
      expect(f.out.join("")).toContain("known_hosts pin LEFT");
    } finally {
      cleanup(f.dir);
    }
  });

  test("a busy reconcile lock is rc 6, with nothing written", async () => {
    const f = fixture({ lock: "busy" });
    try {
      expect(await quiet(() => cmdRetire([BOX], f.deps))).toBe(RC.LOCK_BUSY);
      const st = f.st();
      expect(st.boxRow(BOX)!.phase).toBe("enrolled");
      st.store.close();
      expect(f.ops.revoked).toEqual([]);
    } finally {
      cleanup(f.dir);
    }
  });

  test("an unwritable VPS authorized_keys ABORTS before the store write", async () => {
    const f = fixture({ akWritable: false });
    try {
      expect(await quiet(() => cmdRetire([BOX], f.deps))).toBe(RC.FAILURE);
      const st = f.st();
      // The one state this command must never produce: a `retired` row beside a
      // live authorized_keys line.
      expect(st.boxRow(BOX)!.phase).toBe("enrolled");
      st.store.close();
      expect(f.ops.revoked).toEqual([]);
    } finally {
      cleanup(f.dir);
    }
  });

  test("a FAILED revoke is logged and the retirement still completes", async () => {
    const f = fixture({ revokeOk: false });
    try {
      expect(await quiet(() => cmdRetire([BOX], f.deps))).toBe(RC.OK);
      const st = f.st();
      expect(st.boxRow(BOX)!.phase).toBe("retired");
      st.store.close();
      expect(f.ops.revoked).toEqual(["kRETIRE"]);
    } finally {
      cleanup(f.dir);
    }
  });

  test("retire works on an ENROLLING row — the operator's abort of a stuck saga", async () => {
    const f = fixture();
    try {
      // put the row into the middle of a saga
      const h = f.deps.open()!;
      h.state.transition(BOX, "enrolled", "retired", "operator");
      h.state.transition(BOX, "retired", "enrolling", "operator");
      h.close();

      expect(await quiet(() => cmdRetire([BOX], f.deps))).toBe(RC.OK);
      const st = f.st();
      expect(st.boxRow(BOX)!.phase).toBe("retired");
      st.store.close();
    } finally {
      cleanup(f.dir);
    }
  });

  test("a name with no row is a usage error, not a silent success", async () => {
    const f = fixture();
    try {
      expect(await quiet(() => cmdRetire(["grok-box-404"], f.deps))).toBe(RC.USAGE);
      expect(f.ops.lockTaken).toBe(0);
    } finally {
      cleanup(f.dir);
    }
  });

  test("retiring an ALREADY retired box is a no-op rc 0", async () => {
    const f = fixture();
    try {
      await quiet(() => cmdRetire([BOX], f.deps));
      const before = f.ops.revoked.length;
      expect(await quiet(() => cmdRetire([BOX], f.deps))).toBe(RC.OK);
      expect(f.ops.revoked.length).toBe(before); // nothing revoked twice
      expect(f.out.join("")).toContain("already retired");
    } finally {
      cleanup(f.dir);
    }
  });
});
