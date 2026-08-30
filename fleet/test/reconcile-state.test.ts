// T4 / T4b — state-file BYTES identical to bash (F9/G4 table) + counter reads.

import { test, expect, describe } from "bun:test";
import { ReconcileState, type StateFs } from "../src/reconcile/state.ts";

/** An in-memory StateFs so tests assert exact bytes without touching disk. */
function memState(): { fs: StateFs; store: Map<string, string>; ops: string[] } {
  const store = new Map<string, string>();
  const ops: string[] = [];
  let ctr = 0;
  const fs: StateFs = {
    read: (p) => store.get(p),
    write: (p, d) => {
      ops.push(`write:${p}`);
      store.set(p, d);
    },
    remove: (p) => {
      ops.push(`remove:${p}`);
      store.delete(p);
    },
    mkdirp: (p) => ops.push(`mkdirp:${p}`),
    chmod: (p, m) => ops.push(`chmod:${p}:${m.toString(8)}`),
    rename: (f, t) => {
      ops.push(`rename:${f}->${t}`);
      const v = store.get(f);
      if (v !== undefined) {
        store.set(t, v);
        store.delete(f);
      }
    },
    exists: (p) => store.has(p),
    tmpname: (dir, prefix) => `${dir}/${prefix}${++ctr}`,
  };
  return { fs, store, ops };
}

const SD = "/var/lib/grok-fleet";

describe("T4 state-file byte formats", () => {
  test("checkfail: bump writes N\\n, reset writes 0\\n (not rm)", () => {
    const { fs, store } = memState();
    const s = new ReconcileState(SD, fs);
    expect(s.bumpCheckfail("grok-box-1")).toBe(1);
    expect(store.get(`${SD}/grok-box-1.checkfail`)).toBe("1\n");
    expect(s.bumpCheckfail("grok-box-1")).toBe(2);
    expect(store.get(`${SD}/grok-box-1.checkfail`)).toBe("2\n");
    s.resetCheckfail("grok-box-1");
    expect(store.get(`${SD}/grok-box-1.checkfail`)).toBe("0\n"); // healthy = literal 0
  });

  test("seedfail reset writes 0\\n; cfgfail/incoherent/asleep reset = rm -f (absent)", () => {
    const { fs, store } = memState();
    const s = new ReconcileState(SD, fs);
    s.bumpSeedfail("b");
    s.resetSeedfail("b");
    expect(store.get(`${SD}/b.seedfail`)).toBe("0\n");

    s.bumpCfgfail("b");
    expect(store.get(`${SD}/b.cfgfail`)).toBe("1\n");
    s.resetCfgfail("b");
    expect(store.has(`${SD}/b.cfgfail`)).toBe(false); // rm -f

    s.bumpIncoherent("b");
    s.resetIncoherent("b");
    expect(store.has(`${SD}/b.incoherent`)).toBe(false); // rm -f

    s.writeAsleep("b", 100, 0);
    s.resetAsleep("b");
    expect(store.has(`${SD}/b.asleep`)).toBe(false); // rm -f
  });

  test("<box>.expires = 'box\\tYYYY-MM-DD\\n'; read col2 whitespace-stripped", () => {
    const { fs, store } = memState();
    const s = new ReconcileState(SD, fs);
    s.writeExpires("grok-box-8", "2026-11-27");
    expect(store.get(`${SD}/grok-box-8.expires`)).toBe("grok-box-8\t2026-11-27\n");
    expect(s.readExpiresDate("grok-box-8")).toBe("2026-11-27");
    expect(s.readExpiresDate("grok-box-9")).toBeUndefined();
  });

  test("keys/<N>.json: {id,expires}, mode 600, atomic tmp->rename, read-back", () => {
    const { fs, store, ops } = memState();
    const s = new ReconcileState(SD, fs);
    expect(s.recordKeyMeta(8, "kABC123", "2026-11-27")).toBe(true);
    expect(store.get(`${SD}/keys/8.json`)).toBe('{"id":"kABC123","expires":"2026-11-27"}');
    expect(s.keyMetaId(8)).toBe("kABC123");
    // atomic: a tmp write + chmod 600 + rename onto the final path
    expect(ops.some((o) => o.startsWith(`write:${SD}/keys/.keymeta.`))).toBe(true);
    expect(ops.some((o) => o === `chmod:${SD}/keys/.keymeta.1:600`)).toBe(true);
    expect(ops.some((o) => o.startsWith("rename:") && o.endsWith(`->${SD}/keys/8.json`))).toBe(true);
  });

  test("record_key_meta refuses a blank id (P1-D)", () => {
    const { fs } = memState();
    const s = new ReconcileState(SD, fs);
    expect(s.recordKeyMeta(8, "", "2026-11-27")).toBe(false);
  });

  test("api backoff: fails N\\n, backoff_min 5/10/20, next_retry epoch; reset clears", () => {
    const { fs, store } = memState();
    const s = new ReconcileState(SD, fs);
    const now = 1_000_000;
    expect(s.recordApiFailure(now)).toEqual({ n: 1, mins: 5 });
    expect(store.get(`${SD}/api.fails`)).toBe("1\n");
    expect(store.get(`${SD}/api.backoff_min`)).toBe("5\n");
    expect(store.get(`${SD}/api.next_retry`)).toBe(`${now + 300}\n`);
    expect(s.recordApiFailure(now)).toEqual({ n: 2, mins: 10 });
    expect(s.recordApiFailure(now)).toEqual({ n: 3, mins: 20 });
    expect(store.get(`${SD}/api.next_retry`)).toBe(`${now + 1200}\n`);
    s.resetApiFailure();
    expect(store.get(`${SD}/api.fails`)).toBe("0\n");
    expect(store.has(`${SD}/api.next_retry`)).toBe(false);
    expect(store.has(`${SD}/api.backoff_min`)).toBe(false);
  });
});

describe("T4b counter reads (fixtures ⇒ normalised value)", () => {
  test("'0','3','','  ','abc','3x' ⇒ 0,3,0,0,0,0", () => {
    const cases: Array<[string, number]> = [
      ["0\n", 0],
      ["3\n", 3],
      ["", 0],
      ["  \n", 0],
      ["abc", 0],
      ["3x", 0],
    ];
    for (const [bytes, want] of cases) {
      const { fs, store } = memState();
      const s = new ReconcileState(SD, fs);
      store.set(`${SD}/b.checkfail`, bytes);
      expect(s.checkfailCount("b")).toBe(want);
    }
  });

  test("nextRetry parses epoch, undefined on absent/garbage", () => {
    const { fs, store } = memState();
    const s = new ReconcileState(SD, fs);
    expect(s.nextRetry()).toBeUndefined();
    store.set(`${SD}/api.next_retry`, "1700000000\n");
    expect(s.nextRetry()).toBe(1700000000);
    store.set(`${SD}/api.next_retry`, "junk");
    expect(s.nextRetry()).toBeUndefined();
  });
});
