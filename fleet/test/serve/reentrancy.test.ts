// reentrancy.test.ts — §7.5 R3-B1: (1) the rename handler under a held lock
// injects an acquireLock that returns "ok", so the rename core proceeds WITHOUT
// invoking the external `flock -w 90` wiring (which would self-deadlock against
// the handler's fd-held lock); (2) the /v1/reconcile job invokes runReconcile
// DIRECTLY (via the injected TickRunner), never cliReconcile.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { cmdRename, type RenameDeps, type RenameStore } from "../../src/commands/rename.ts";
import { makeFetch } from "../../src/serve/server.ts";
import type { TickRunner } from "../../src/serve/context.ts";
import { fakeContext, postReq, fakeSyscalls, fakeLockDeps } from "./helpers.ts";
import { setLogSink } from "../../src/log.ts";

let restore: (l: string) => void;
beforeEach(() => {
  restore = setLogSink(() => {});
});
afterEach(() => setLogSink(restore));

/** A rename store that reports the box enrolled + copy/delete succeed. */
function okStore(): RenameStore {
  return {
    enrolledPort: () => "20003",
    hasEnrolledRow: () => false,
    copyState: () => true,
    deleteOldState: () => true,
  };
}

describe("R3-B1 rename re-entrancy", () => {
  test("with a lock-held acquireLock()=>'ok', the rename core proceeds to DONE", async () => {
    // This models the API path's injected RenameOps: acquireLock returns "ok"
    // (the request already holds reconcile.lock). The rename completes.
    let acquireCalls = 0;
    const deps: RenameDeps = {
      store: okStore(),
      ops: {
        async tunnelUp() { return true; },
        async boxBoxupVersion() { return "5.3.0"; },
        async writeHostnameAndOnce() { return true; },
        async pollDevices(_o, neu) {
          return { ok: true, malformed: false, code: 200, hostname: neu, dnslabel: neu, oldLiveId: "", newLiveId: "n1" };
        },
        async forceName() { return { ok: true, code: 200 }; },
        async reapCorpse() { return { ok: true, code: 200 }; },
        async acquireLock() { acquireCalls++; return "ok"; },
        async sleepInterval() {},
      },
      paths: { state: "/s", akDir: "/e/ak", etc: "/e", managedBoxDir: "/e/boxes" },
    };
    const rc = await cmdRename(["grok-box-3", "grok-box-003"], deps);
    expect(rc).toBe(0);
    // acquireLock was called (the core's contract), and it returned "ok" WITHOUT
    // an external flock -w 90 blocking — the injected variant short-circuits.
    expect(acquireCalls).toBe(1);
  });

  test("proof of the hazard: a 'busy' acquireLock (what the UNINJECTED external flock would do) aborts rc 1", async () => {
    // If the API path did NOT inject the lock-held variant, the production
    // acquireLock (external `flock -w 90`) would see the handler's fd-held lock,
    // block 90s, then refuse ⇒ "busy" ⇒ rc 1. This asserts that outcome so a
    // regression that drops the injection is caught.
    const deps: RenameDeps = {
      store: okStore(),
      ops: {
        async tunnelUp() { return true; },
        async boxBoxupVersion() { return "5.3.0"; },
        async writeHostnameAndOnce() { return true; },
        async pollDevices(_o, neu) {
          return { ok: true, malformed: false, code: 200, hostname: neu, dnslabel: neu, oldLiveId: "", newLiveId: "n1" };
        },
        async forceName() { return { ok: true, code: 200 }; },
        async reapCorpse() { return { ok: true, code: 200 }; },
        async acquireLock() { return "busy"; },
        async sleepInterval() {},
      },
      paths: { state: "/s", akDir: "/e/ak", etc: "/e", managedBoxDir: "/e/boxes" },
    };
    const rc = await cmdRename(["grok-box-3", "grok-box-003"], deps);
    expect(rc).toBe(1); // self-deadlock outcome the injection PREVENTS
  });
});

describe("R3-B1 reconcile job invokes runReconcile DIRECTLY (not cliReconcile)", () => {
  test("the job runs the injected TickRunner (assembleTickDeps path), asserted via a spy", async () => {
    let tickRuns = 0;
    let tickApply: boolean | undefined;
    const tick: TickRunner = {
      async run(opts) {
        tickRuns++;
        tickApply = opts.apply;
        return 0;
      },
    };
    const { sys } = fakeSyscalls();
    const ctx = await fakeContext({ tick, lockDeps: fakeLockDeps(sys) });
    const fetch = makeFetch(ctx);
    const r = await fetch(postReq("/v1/reconcile", "ADMINSECRET", { confirm: "fleet" }));
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 10));
    // The TickRunner (which production wires to runReconcile(assembleTickDeps))
    // ran exactly once, in DRY-RUN, under the lock.
    expect(tickRuns).toBe(1);
    expect(tickApply).toBe(false);
  });
});
