// snapshot-hook.test.ts — the runReconcile TUI-D4 snapshot hook: an early-return
// tick still appends (R2-A4), the per-box `config` field is populated from the
// extended PushResult/config-pass, and the config-pass canary is recorded.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { runReconcile, type ReconcileDeps } from "../../src/reconcile/run.ts";
import { ReconcileState, type StateFs } from "../../src/reconcile/state.ts";
import { RunContext, TailscaleKeys, type KeyTransport } from "../../src/reconcile/tailscale-keys.ts";
import type { SnapshotLine } from "../../src/history/schema.ts";
import type { ManagedSource } from "../../src/actions/config-push.ts";
import type { UpgradeDeps } from "../../src/upgrade.ts";
import { FakeRunner, result } from "../fake-runner.ts";
import { testEnv, testRollout } from "../helpers.ts";
import { setLogSink } from "../../src/log.ts";

let restore: (l: string) => void;
beforeEach(() => {
  restore = setLogSink(() => {});
});
afterEach(() => setLogSink(restore));

function memState(): StateFs {
  const store = new Map<string, string>();
  return {
    read: (p) => store.get(p),
    write: (p, d) => store.set(p, d),
    remove: (p) => store.delete(p),
    mkdirp: () => {},
    chmod: () => {},
    rename: (f, t) => {
      const v = store.get(f);
      if (v !== undefined) {
        store.set(t, v);
        store.delete(f);
      }
    },
    exists: (p) => store.has(p),
    tmpname: (d, p) => `${d}/${p}x`,
  };
}

function fakeKeys(): TailscaleKeys {
  const transport: KeyTransport = { async request() { return { code: 200, body: '{"devices":[]}' }; } };
  return new TailscaleKeys(transport, "https://api", "-", "PAT", new RunContext());
}

function baseDeps(over: Partial<ReconcileDeps>, captured: SnapshotLine[]): ReconcileDeps {
  return {
    runner: new FakeRunner(() => result({ stdout: "" })),
    env: testEnv(),
    rollout: testRollout(),
    state: new ReconcileState("/s", memState()),
    keys: fakeKeys(),
    ctx: new RunContext(),
    notify: () => {},
    targetBoxes: ["grok-box-8"],
    configCanary: undefined,
    managedSource: { present: false, fleetToml: () => undefined, boxToml: () => undefined } as ManagedSource,
    managedFilesPresent: false,
    upgradeDeps: {} as UpgradeDeps,
    targetSha: undefined,
    targetVersion: undefined,
    apply: false,
    nowSec: 1_700_000_000,
    history: (l) => captured.push(l),
    ...over,
  };
}

describe("TUI-D4 snapshot hook", () => {
  test("an early-return (empty targetBoxes) tick STILL appends a snapshot (R2-A4)", async () => {
    const captured: SnapshotLine[] = [];
    await runReconcile(baseDeps({ targetBoxes: [] }, captured));
    expect(captured.length).toBe(1);
    expect(captured[0]!.v).toBe(1);
    expect(captured[0]!.boxes).toEqual([]);
    expect(captured[0]!.canary).toBeNull();
  });

  test("a normal tick records per-box fields; config is null when no managed files", async () => {
    const captured: SnapshotLine[] = [];
    // FakeRunner: ss returns nothing ⇒ tunnel down ⇒ check "-".
    await runReconcile(baseDeps({}, captured));
    expect(captured.length).toBe(1);
    const sb = captured[0]!.boxes.find((b) => b.name === "grok-box-8");
    expect(sb).toBeDefined();
    expect(sb!.tunnel).toBe("down");
    expect(sb!.check).toBe("-"); // never probed (tunnel down)
    expect(sb!.config).toBeNull(); // no managed files
  });

  test("config field is populated from the config pass when managed files present", async () => {
    const captured: SnapshotLine[] = [];
    // A runner where `ss` shows grok-box-8's listener up (tunnel up) so the
    // config pass reaches pushManaged; pushManaged's remote returns in-sync.
    const port = 20008;
    const runner = new FakeRunner((argv) => {
      if (argv[0] === "ss") return result({ stdout: `LISTEN 0 0 127.0.0.1:${port} 0.0.0.0:*`, code: 0 });
      // boxup check ⇒ healthy; managed remote ⇒ cur==want (in sync).
      const joined = argv.join(" ");
      if (joined.includes("boxup check")) return result({ stdout: "check=OK v=5.3.0/abc tunnel=up", code: 0 });
      if (joined.includes("sha256sum") || joined.includes("cur=")) {
        return result({ stdout: "cur=SAME want=SAME support=yes enabled=true\nsha=SAME", code: 0 });
      }
      return result({ stdout: "", code: 0 });
    });
    const managed: ManagedSource & { present: true } = {
      present: true,
      fleetToml: () => "[managed]\nenabled=true\n",
      boxToml: () => undefined,
    };
    await runReconcile(
      baseDeps(
        { runner, managedSource: managed, managedFilesPresent: true, targetBoxes: ["grok-box-8"], configCanary: "grok-box-8" },
        captured,
      ),
    );
    const sb = captured[0]!.boxes.find((b) => b.name === "grok-box-8");
    expect(sb).toBeDefined();
    // config is one of the verdict strings (not null, since managed files present
    // and the box was visited by the pass).
    expect(["in-sync", "drift", "skip"]).toContain(sb!.config);
    // the config-pass canary is recorded (fixed to grok-box-8 here).
    expect(captured[0]!.canary).toBe("grok-box-8");
  });

  test("no history hook ⇒ no snapshot (default keeps other tests hermetic)", async () => {
    const captured: SnapshotLine[] = [];
    await runReconcile(baseDeps({ history: undefined, targetBoxes: [] }, captured));
    expect(captured.length).toBe(0);
  });
});
