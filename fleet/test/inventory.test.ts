// T1b / T8-integration / inventory decision wall (D6, F7, G4).
//  - unhealthy box (check rc 1) triggers a SECOND `boxup status` ssh that fills
//    VERSION/SHA (G4/S-C); m19 = second call dropped ⇒ VERSION `?`.
//  - tunnel-down ⇒ CHECK/VERSION/SHA render `-` (F7.3), no ssh issued.
//  - API unavailable ⇒ API `?` and still writes inventory.json (T8).

import { test, expect, describe } from "bun:test";
import { probeBox, runInventory, driftCell, type DevicesApi } from "../src/inventory.ts";
import { CHECK_COMMAND, STATUS_COMMAND } from "../src/remote.ts";
import { FakeRunner, result, isSs } from "./fake-runner.ts";
import { testEnv, testRollout, FULL_STATUS_LINE } from "./helpers.ts";
import type { FsSeam, Inventory } from "../src/state.ts";
import type { Target } from "../src/stage.ts";

function memFs(): { fs: FsSeam; store: Map<string, string> } {
  const store = new Map<string, string>();
  const fs: FsSeam = {
    async writeFile(p, d) {
      store.set(p, d);
    },
    async chmod() {},
    async rename(from, to) {
      const v = store.get(from);
      if (v !== undefined) {
        store.set(to, v);
        store.delete(from);
      }
    },
    async readFile(p) {
      return store.get(p);
    },
  };
  return { fs, store };
}

// A responder that maps ssh calls to scripted outputs based on the remote cmd.
function sshResponder(map: {
  ssListens?: number[];
  onCheck?: (box: string) => { code: number; stdout: string };
  onStatus?: (box: string) => { code: number; stdout: string };
}) {
  return (argv: string[]) => {
    if (isSs(argv)) {
      const lines = (map.ssListens ?? []).map((p) => `LISTEN 0 128 127.0.0.1:${p} 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))`);
      return result({ stdout: lines.join("\n") + "\n" });
    }
    if (argv[0] === "ssh") {
      const cmd = argv[argv.length - 1] ?? "";
      // derive box from -p port
      const port = argv[argv.indexOf("-p") + 1];
      const box = `grok-box-${String(Number(port) - 20000).padStart(3, "0")}`;
      if (cmd === CHECK_COMMAND && map.onCheck) return result(map.onCheck(box));
      if (cmd === STATUS_COMMAND && map.onStatus) return result(map.onStatus(box));
    }
    return result({ code: 1 });
  };
}

describe("probeBox", () => {
  test("tunnel down → CHECK/VERSION/SHA are '-', no ssh issued", async () => {
    const r = new FakeRunner(sshResponder({ ssListens: [] }));
    const p = await probeBox(r, testEnv(), "grok-box-008", undefined, undefined);
    expect(p.tunnel).toBe("down");
    expect(p.check).toBe("-");
    expect(p.version).toBe("-");
    expect(p.sha).toBe("-");
    // only the ss probe ran; no ssh
    expect(r.calls.every((c) => c.argv[0] === "ss")).toBe(true);
  });

  test("healthy box → one ssh (check) fills version/sha (S2)", async () => {
    const r = new FakeRunner(
      sshResponder({
        ssListens: [20008],
        onCheck: () => ({ code: 0, stdout: "check=OK " + FULL_STATUS_LINE }),
      }),
    );
    const p = await probeBox(r, testEnv(), "grok-box-008", undefined, undefined);
    expect(p.check).toBe("OK");
    expect(p.version).toBe("5.3.0");
    expect(p.sha).toBe("abc1234");
    // ss + exactly one ssh (no second status call on a healthy box)
    const sshCalls = r.calls.filter((c) => c.argv[0] === "ssh");
    expect(sshCalls.length).toBe(1);
  });

  test("T1b/m19: unhealthy box → second status ssh fills version/sha", async () => {
    const r = new FakeRunner(
      sshResponder({
        ssListens: [20008],
        onCheck: () => ({ code: 1, stdout: "check=FAIL reason=tailscaled-down" }),
        onStatus: () => ({ code: 0, stdout: "name=grok-box-008 v=5.3.0/dead123 tunnel=up" }),
      }),
    );
    const p = await probeBox(r, testEnv(), "grok-box-008", undefined, undefined);
    expect(p.check).toBe("FAIL");
    expect(p.checkReason).toBe("tailscaled-down");
    // m19: the second status call must fill version/sha (not '?')
    expect(p.version).toBe("5.3.0");
    expect(p.sha).toBe("dead123");
    const sshCalls = r.calls.filter((c) => c.argv[0] === "ssh");
    expect(sshCalls.length).toBe(2);
    expect(sshCalls[1]!.argv[sshCalls[1]!.argv.length - 1]).toBe(STATUS_COMMAND);
  });
});

describe("runInventory", () => {
  test("API unavailable → API '?' and inventory.json still written (T8)", async () => {
    const r = new FakeRunner(
      sshResponder({
        ssListens: [20008],
        onCheck: () => ({ code: 0, stdout: "check=OK " + FULL_STATUS_LINE }),
      }),
    );
    const { fs, store } = memFs();
    const target: Target = { ref: "main", sha: "abc1234", version: "5.3.0" };
    const res = await runInventory(["grok-box-008"], {
      runner: r,
      env: testEnv(),
      rollout: testRollout(),
      fs,
      api: { async probe() { return undefined; } } as DevicesApi,
      readExpires: async () => undefined,
      // inject target via a stub resolve by pre-writing? runInventory calls
      // resolveTarget internally; here git will fail → target null. Assert '?'
    });
    // git fetch/rev-parse fail against a fake runner → target null (F7.2)
    expect(res.rows[0]!.api).toBe("?");
    const written = store.get("/var/lib/grok-fleet/inventory.json");
    expect(written).toBeDefined();
    const parsed = JSON.parse(written!) as Inventory;
    expect(parsed.boxes["grok-box-008"]!.api).toBeNull();
    void target;
  });

  test("API lastSeen threads into inventory.json for a probed box", async () => {
    const r = new FakeRunner(
      sshResponder({
        ssListens: [20008],
        onCheck: () => ({ code: 0, stdout: "check=OK " + FULL_STATUS_LINE }),
      }),
    );
    const { fs, store } = memFs();
    const api: DevicesApi = {
      async probe() {
        return new Map([["grok-box-008", { online: true, lastSeen: "2026-08-30T00:40:00Z" }]]);
      },
    };
    const res = await runInventory(["grok-box-008"], {
      runner: r,
      env: testEnv(),
      rollout: testRollout(),
      fs,
      api,
      readExpires: async () => undefined,
    });
    expect(res.rows[0]!.api).toBe("online");
    expect(res.rows[0]!.lastSeen).toBe("2026-08-30T00:40:00Z");
    const parsed = JSON.parse(store.get("/var/lib/grok-fleet/inventory.json")!) as Inventory;
    expect(parsed.boxes["grok-box-008"]!.lastSeen).toBe("2026-08-30T00:40:00Z");
  });
});

describe("driftCell", () => {
  const target: Target = { ref: "main", sha: "abc1234", version: "5.3.0" };
  test("down → '-', no target → '?', match → no, mismatch → yes", () => {
    expect(driftCell({ tunnel: "down", version: "-", sha: "-" } as never, target)).toBe("-");
    expect(driftCell({ tunnel: "up", version: "5.3.0", sha: "abc1234" } as never, null)).toBe("?");
    expect(driftCell({ tunnel: "up", version: "5.3.0", sha: "abc1234" } as never, target)).toBe("no");
    expect(driftCell({ tunnel: "up", version: "5.2.0", sha: "ffffff" } as never, target)).toBe("yes");
    expect(driftCell({ tunnel: "up", version: "unknown", sha: "unknown" } as never, target)).toBe("?");
  });

  test("D5: the cell is the VERSION verdict, not the sha verdict", () => {
    // The empirical r1 case: same boxup VERSION, sha moved by a fleet2-only
    // commit. `fleet2 status` must agree with the reconciler and say `no`.
    expect(driftCell({ tunnel: "up", version: "5.3.0", sha: "f42c967" } as never, target)).toBe("no");
    // And the converse: the sha happens to match but the payload version does
    // not, so the box IS drifted (a hand-installed build, direction irrelevant).
    expect(driftCell({ tunnel: "up", version: "5.4.0", sha: "abc1234" } as never, target)).toBe("yes");
    // An unreadable box version, or a target ref with no VERSION file, is `?` —
    // the same tri-state row d uses, and `?` never counts as drift.
    expect(driftCell({ tunnel: "up", version: "?", sha: "abc1234" } as never, target)).toBe("?");
    expect(
      driftCell({ tunnel: "up", version: "5.3.0", sha: "abc1234" } as never, {
        ref: "main",
        sha: "abc1234",
        version: "unknown",
      }),
    ).toBe("?");
  });
});
