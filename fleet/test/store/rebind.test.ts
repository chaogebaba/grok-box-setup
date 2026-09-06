// rebind.test.ts — A1 (5.12.1): a re-imaged box must lose its recorded key, so
// the next tick MINTS instead of skipping on a mint window that no longer has a
// key behind it.
//
// The incident: grok-box-011 was re-imaged on 2026-09-06. Its `box_keys` row
// from 2026-08-30 survived, because `enroll` (manual and the zero-touch
// adopt/repair path alike) never touched `box_keys`. `mintWindowValid` read the
// row's 90-day expiry, answered "a valid key was already seeded this window",
// and `reconcile/run.ts` skipped the mint on every one of the 288 ticks a day.
// The box had no `secrets/ts-authkey` at all, unattended recovery could not
// work, and `grokfleet fleet-status` printed the dead key's expiry as if it
// meant something.
//
// Both halves of the fix are exercised here, each with its own mutant:
//   (a) enrol FORGETS the key when the box presents a new tunnel pubkey;
//   (b) `mintWindowValid` rejects a key minted BEFORE the current binding, so a
//       key row that survives by some other route is still not a valid window.
//
// The enrol path is driven through the REAL `cmdEnrollResult` with store-backed
// side effects — the same two store calls production makes — rather than a
// model of it, so a fix that only holds in the test's own re-creation of the
// event cannot pass here.

import { describe, expect, test } from "bun:test";
import { cmdEnrollResult, type EnrollSideEffects } from "../../src/commands/enroll.ts";
import { StoreState } from "../../src/store/state.ts";
import { openStore, type Store } from "../../src/store/db.ts";
import { mintWindowValid } from "../../src/actions/mint.ts";
import { setLogSink } from "../../src/log.ts";

const BOX = "grok-box-011";
const PORT = 20011;
const DAY = 86_400;
const T0 = 1_780_000_000;

/** The tunnel keypair boxup generates ON the box — a re-image makes a new one. */
const OLD_PUBKEY = "ssh-ed25519 AAAAC3OLDKEYMATERIAL grok-tunnel";
const NEW_PUBKEY = "ssh-ed25519 AAAAC3NEWKEYMATERIAL grok-tunnel";
/** A store with a clock the test can move. */
function clockStore(): { store: Store; set(t: number): void } {
  let t = T0;
  return { store: openStore({ path: ":memory:", now: () => t }), set: (n) => void (t = n) };
}

function sideEffects(st: StoreState, pubkey: () => string): EnrollSideEffects {
  return {
    async vpsUserExists() { return true; },
    async haveSshd() { return false; },
    async sshdEffective() { return undefined; },
    fleetVpsAddr() { return "1.2.3.4"; },
    fleetVpsPort() { return "22"; },
    async aclHasFleetBrainTagowner() { return 0; },
    lastApiCode() { return 200; },
    async readBoxPubkey() { return pubkey(); },
    async tunnelUp() { return false; },
    async forgetHostKeys() {},
    async installVpsAuthorizedKey() { return true; },
    async recordEtcMapping() { return true; },
    async vpsBoxAccessPubkey() { return "ssh-ed25519 AAAAvpskey vps"; },
    async installBoxAuthorizedKey() { return true; },
    async writeBoxConfig() { return 0; },
    async recordEnrolled(box, port, pk) {
      st.recordEnrolled(box, port, pk);
      return undefined;
    },
    async notify() {},
    tunnelWaitBudget() { return "0"; },
    async sleep5() {},
    async beginEnrol(box, port, pk) { return st.beginEnrol(box, port, pk); },
    async stageOk(box, stage, warn) { st.advanceStage(box, stage, warn); },
    async stageFailed(box, stage, warn) { st.failStage(box, stage, warn); },
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

/** A healthy, freshly minted 90-day key, exactly as `mintKey` records one. */
function seedKey(st: StoreState, mintedAtIso: string): void {
  expect(
    st.recordKey(BOX, {
      keyId: "k56iJtXxsJ11CNTRL",
      expiresRaw: mintedAtIso,
      expiresDate: mintedAtIso.slice(0, 10),
    }),
  ).toBe(true);
}

describe("A1 — a re-imaged box loses its recorded key", () => {
  test("(a) enrol with a NEW tunnel pubkey forgets the key; the next tick MINTS", async () => {
    const { store, set } = clockStore();
    const st = new StoreState(store);
    const se = sideEffects(st, () => OLD_PUBKEY);

    // Day 0: the box enrols and gets a 90-day key.
    await quiet(() => cmdEnrollResult([BOX], se));
    seedKey(st, "2026-11-28T00:00:00Z");
    expect(st.keyMetaId(11, BOX)).toBe("k56iJtXxsJ11CNTRL");
    // The tick would skip the mint, correctly: the key is real and 83 days out.
    expect(mintWindowValid(BOX, { state: st, nowSec: T0 + DAY })).toBe(true);

    // Day 7: the box is RE-IMAGED. boxup generates a fresh tunnel keypair, and
    // `secrets/ts-authkey` is gone with the old filesystem.
    set(T0 + 7 * DAY);
    const reimaged = sideEffects(st, () => NEW_PUBKEY);
    const r = await quiet(() => cmdEnrollResult([BOX], reimaged));
    expect(r.rc).toBe(0);

    // The key row is GONE — nothing claims a key the box does not have.
    expect(st.keyMetaId(11, BOX)).toBeUndefined();
    expect(st.readExpiresDate(BOX)).toBeUndefined();
    expect(st.keyMintedAt(BOX)).toBeUndefined();
    // What the store keeps is field 2 of the pubkey line (enroll.ts:377).
    expect(store.db.query("SELECT pubkey AS p FROM boxes WHERE name=?").get(BOX)).toEqual({
      p: NEW_PUBKEY.split(/\s+/)[1]!,
    });
    // ...so the mint-window guard says "no window" and the tick MINTS.
    // MUTANT (a): drop the forget in `rebindIfNewKeypair` and this is `true`,
    // which is the 011 bug exactly.
    expect(mintWindowValid(BOX, { state: st, nowSec: T0 + 7 * DAY })).toBe(false);

    // The binding was re-dated to the re-image, which is what (b) stands on.
    expect(st.bindingAt(BOX)).toBe(T0 + 7 * DAY);
    store.close();
  });

  test("(b) a key minted BEFORE the current binding is not a valid window", async () => {
    const { store, set } = clockStore();
    const st = new StoreState(store);

    await quiet(() => cmdEnrollResult([BOX], sideEffects(st, () => OLD_PUBKEY)));
    seedKey(st, "2026-11-28T00:00:00Z");

    // The re-image happens, and the key row SURVIVES it — simulating any route
    // that leaves one behind: a mint that lands between the forget and the seed,
    // an operator's `mint-key` against the old incarnation, a partial restore.
    set(T0 + 7 * DAY);
    await quiet(() => cmdEnrollResult([BOX], sideEffects(st, () => NEW_PUBKEY)));
    store.db
      .query("INSERT INTO box_keys(box_id,key_id,expires_raw,expires_date,minted_at) VALUES(1,?,?,?,?)")
      .run("k56iJtXxsJ11CNTRL", "2026-11-28T00:00:00Z", "2026-11-28", T0);

    // The row is fully valid by every pre-5.12.1 test: an id, and 80-odd days of
    // life left. It is still not a window, because it predates the binding.
    expect(st.keyMetaId(11, BOX)).toBe("k56iJtXxsJ11CNTRL");
    expect(st.readExpiresDate(BOX)).toBe("2026-11-28");
    expect(st.keyMintedAt(BOX)!).toBeLessThan(st.bindingAt(BOX)!);
    // MUTANT (b): remove the minted_at/bindingAt clause from `mintWindowValid`
    // and this is `true`.
    expect(mintWindowValid(BOX, { state: st, nowSec: T0 + 7 * DAY })).toBe(false);
    store.close();
  });

  test("(b) a key minted AFTER the binding IS a valid window", async () => {
    const { store, set } = clockStore();
    const st = new StoreState(store);
    await quiet(() => cmdEnrollResult([BOX], sideEffects(st, () => OLD_PUBKEY)));

    set(T0 + 7 * DAY);
    await quiet(() => cmdEnrollResult([BOX], sideEffects(st, () => NEW_PUBKEY)));
    set(T0 + 7 * DAY + 60); // the next tick mints
    seedKey(st, "2026-12-05T00:00:00Z");

    // The guard must not become a permanent "always mint": a key minted after
    // the current binding is exactly the key the tick just seeded.
    expect(mintWindowValid(BOX, { state: st, nowSec: T0 + 8 * DAY })).toBe(true);
    store.close();
  });

  test("re-running enrol with the SAME pubkey keeps the key (no repair-path churn)", async () => {
    const { store, set } = clockStore();
    const st = new StoreState(store);
    const se = sideEffects(st, () => OLD_PUBKEY);

    await quiet(() => cmdEnrollResult([BOX], se));
    seedKey(st, "2026-11-28T00:00:00Z");
    const mintedAt = st.keyMintedAt(BOX);

    // `discover` re-runs the whole enrol against an ENROLLED box to rewrite its
    // artefacts (store/state.ts `beginEnrol`, the repair path). That happens on
    // an ordinary tick, and it must not cost a Tailscale key each time.
    set(T0 + 2 * DAY);
    await quiet(() => cmdEnrollResult([BOX], se));
    expect(st.keyMetaId(11, BOX)).toBe("k56iJtXxsJ11CNTRL");
    expect(st.keyMintedAt(BOX)).toBe(mintedAt!);
    expect(st.bindingAt(BOX)).toBe(T0); // the binding did not move
    expect(mintWindowValid(BOX, { state: st, nowSec: T0 + 2 * DAY })).toBe(true);
    store.close();
  });

  test("a legacy-imported row (no enrolled_at) leaves the guard's old answer alone", () => {
    const { store } = clockStore();
    const st = new StoreState(store);
    // What `store/legacy.ts` produces: a row with NULL enrolled_at and no pubkey.
    store.db
      .query(
        `INSERT INTO boxes(name,idx,port,phase,created_at,enrolled_at,updated_at,pubkey)
         VALUES(?,?,?,'enrolled',?,NULL,?,NULL)`,
      )
      .run(BOX, 11, PORT, T0, T0);
    seedKey(st, "2026-11-28T00:00:00Z");

    expect(st.bindingAt(BOX)).toBeUndefined();
    // Unknowable binding ⇒ the clause does not fire. A whole imported fleet must
    // not re-mint on the first tick after an upgrade.
    expect(mintWindowValid(BOX, { state: st, nowSec: T0 + DAY })).toBe(true);
    store.close();
  });
});
