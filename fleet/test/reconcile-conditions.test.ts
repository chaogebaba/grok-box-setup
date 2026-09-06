// reconcile-conditions.test.ts — 5.13.0 box-conditions inside the tick (D1b/D2/
// D3a). Drives the REAL runReconcile so the statusSeen guard, the post-verdict
// pass placement and the snapshot carry are exercised together, not in isolation.
//
// The mutant this file exists to kill is "set report on the unhealthy branch
// without checking st.code": a defaulted report from a failed re-probe would
// CLEAR every condition on a box the brain could not read (the fail-open
// violation D1b prevents). The not-status-seen tests assert that silence.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { runReconcile, type ReconcileDeps } from "../src/reconcile/run.ts";
import { ReconcileState, type StateFs } from "../src/reconcile/state.ts";
import { RunContext, TailscaleKeys, type KeyTransport } from "../src/reconcile/tailscale-keys.ts";
import { FakeRunner, result, isSs } from "./fake-runner.ts";
import { testEnv, testRollout } from "./helpers.ts";
import { setLogSink } from "../src/log.ts";
import { CHECK_COMMAND, STATUS_COMMAND } from "../src/remote.ts";
import type { ManagedSource } from "../src/actions/config-push.ts";
import type { UpgradeDeps } from "../src/upgrade.ts";
import type { SnapshotLine } from "../src/history/schema.ts";

const BOX = "grok-box-008";
const PORT = 20008;
const NOW = Date.parse("2099-01-01T00:00:00Z") / 1000;

let logs: string[] = [];
let prevSink: (l: string) => void;
beforeEach(() => {
  logs = [];
  prevSink = setLogSink((l) => logs.push(l));
});
afterEach(() => setLogSink(prevSink));

function memState(): ReconcileState {
  const store = new Map<string, string>();
  const fs: StateFs = {
    read: (p) => store.get(p),
    write: (p, d) => void store.set(p, d),
    remove: (p) => void store.delete(p),
    mkdirp: () => {},
    chmod: () => {},
    rename: () => {},
    exists: (p) => store.has(p),
    tmpname: (d, p) => `${d}/${p}x`,
  };
  return new ReconcileState("/s", fs);
}

const noManaged: ManagedSource & { present: false } = {
  present: false,
  fleetToml: () => undefined,
  boxToml: () => undefined,
};

function devsOnline(box: string, nowSec: number): string {
  return JSON.stringify({ devices: [{ hostname: box, online: true, lastSeen: new Date(nowSec * 1000).toISOString() }] });
}

interface Opts {
  /** tunnel listener present? default true. */
  tunnelUp?: boolean;
  /** the `boxup check` rc (0 healthy, 1 unhealthy ⇒ re-probe). default 0. */
  checkCode?: number;
  /** the status line the healthy check or the re-probe returns. */
  statusLine?: string;
  /** the re-probe (STATUS_COMMAND) rc, for the unhealthy branch. default 0. */
  reprobeCode?: number;
  state?: ReconcileState;
  notes?: Array<[string, string]>;
  lines?: SnapshotLine[];
}

function tickDeps(o: Opts): { deps: ReconcileDeps; state: ReconcileState } {
  const state = o.state ?? memState();
  const transport: KeyTransport = { async request() { return { code: 200, body: devsOnline(BOX, NOW) }; } };
  const ctx = new RunContext();
  const line = o.statusLine ?? `v=5.3.0/abc1234 tunnel=up`;
  const runner = new FakeRunner((argv) => {
    if (isSs(argv)) {
      if (o.tunnelUp === false) return result({ stdout: "" }); // no listener ⇒ tunnel down
      return result({ stdout: `LISTEN 0 128 127.0.0.1:${PORT} 0.0.0.0:* users:(("sshd",pid=41,fd=7))\n` });
    }
    const cmd = argv[argv.length - 1] ?? "";
    if (cmd === CHECK_COMMAND) {
      if ((o.checkCode ?? 0) === 0) return result({ code: 0, stdout: `check=OK ${line}` });
      return result({ code: 1, stdout: "check=FAIL reason=disk" });
    }
    if (cmd === STATUS_COMMAND) {
      // the unhealthy re-probe
      return result({ code: o.reprobeCode ?? 0, stdout: (o.reprobeCode ?? 0) === 0 ? line : "" });
    }
    return result({ code: 0, stdout: "cur=X want=X support=yes enabled=true" });
  });
  const deps: ReconcileDeps = {
    runner,
    env: testEnv(),
    rollout: testRollout(),
    state,
    keys: new TailscaleKeys(transport, "https://api", "-", "PAT", ctx),
    ctx,
    notify: (lvl, msg) => void o.notes?.push([lvl, msg]),
    targetBoxes: [BOX],
    configCanary: undefined,
    managedSource: noManaged,
    managedFilesPresent: false,
    upgradeDeps: {} as UpgradeDeps,
    targetSha: undefined,
    targetVersion: undefined,
    apply: true,
    nowSec: NOW,
    history: (l) => void o.lines?.push(l),
  };
  return { deps, state };
}

/** the one box's snapshot row from the last recorded line. */
function boxRow(lines: SnapshotLine[]) {
  return lines.at(-1)!.boxes.find((b) => b.name === BOX)!;
}

describe("D3a — a status-seen box carries report + conditions into the snapshot", () => {
  test("a healthy box with disk=93%/fail raises condition:disk-fail and records it", async () => {
    const notes: Array<[string, string]> = [];
    const lines: SnapshotLine[] = [];
    const { deps } = tickDeps({
      statusLine: "v=5.3.0/abc1234 tunnel=up disk=93%/fail",
      notes,
      lines,
    });
    await runReconcile(deps);
    const b = boxRow(lines);
    expect(b.report).toBeDefined();
    expect(b.report!.disk).toEqual({ pct: 93, level: "fail" });
    expect(b.conditions).toContain("disk-fail");
    expect(notes.some(([l, m]) => l === "warn" && m.includes("condition:disk-fail"))).toBe(true);
  });

  test("a clean healthy box carries an empty conditions array and a report", async () => {
    const lines: SnapshotLine[] = [];
    const { deps } = tickDeps({ statusLine: "v=5.3.0/abc1234 tunnel=up disk=5% keepawake=off", lines });
    await runReconcile(deps);
    const b = boxRow(lines);
    expect(b.report).toBeDefined();
    expect(b.conditions).toEqual([]);
  });
});

describe("D1b — statusSeen: a box the brain could not READ raises/clears nothing", () => {
  test("an unhealthy box whose re-probe returns rc≠0 is NOT status-seen (the mutant killer)", async () => {
    const notes: Array<[string, string]> = [];
    const lines: SnapshotLine[] = [];
    // check FAILs, and the status re-probe times out (rc 1, empty stdout). A
    // defaulted report would read all-clear and CLEAR conditions — it must not.
    const { deps, state } = tickDeps({ checkCode: 1, reprobeCode: 1, notes, lines });
    await runReconcile(deps);
    const b = boxRow(lines);
    // no report, no conditions on the row
    expect("report" in b).toBe(false);
    expect("conditions" in b).toBe(false);
    // no condition alert fired, and no tickwedge record was written (no counter moved)
    expect(notes.some(([, m]) => m.includes("condition:"))).toBe(false);
    expect(state.lastTickwedge(BOX)).toBeNull();
  });

  test("an unhealthy box with a GOOD re-probe (rc 0, v= present) IS status-seen", async () => {
    const lines: SnapshotLine[] = [];
    // check FAILs (disk fail flips it), but the re-probe returns the real line.
    const { deps } = tickDeps({
      checkCode: 1,
      reprobeCode: 0,
      statusLine: "v=5.3.0/abc1234 tunnel=up disk=93%/fail",
      lines,
    });
    await runReconcile(deps);
    const b = boxRow(lines);
    expect(b.report).toBeDefined();
    expect(b.conditions).toContain("disk-fail");
  });

  test("a tunnel-DOWN box omits report and conditions and moves no counter", async () => {
    const lines: SnapshotLine[] = [];
    const { deps, state } = tickDeps({ tunnelUp: false, lines });
    await runReconcile(deps);
    const b = boxRow(lines);
    expect(b.tunnel).toBe("down");
    expect("report" in b).toBe(false);
    expect("conditions" in b).toBe(false);
    expect(state.lastTickwedge(BOX)).toBeNull();
  });

  test("a not-status-seen tick does not CLEAR a condition raised on a prior seen tick", async () => {
    const state = memState();
    const notes: Array<[string, string]> = [];
    // Tick 1: seen, disk fail ⇒ raise + record the alert row.
    await runReconcile(
      tickDeps({ statusLine: "v=5.3.0/abc1234 tunnel=up disk=93%/fail", state, notes }).deps,
    );
    expect(notes.some(([, m]) => m.includes("condition:disk-fail"))).toBe(true);
    // Tick 2: the box is unreachable (tunnel down) ⇒ the pass does not run, so
    // the alert row is NOT cleared. If it cleared, tick 3 would re-page.
    await runReconcile(tickDeps({ tunnelUp: false, state, notes }).deps);
    // Tick 3: seen again, still failing, inside the 24h window ⇒ NO new page
    // (the row was never cleared). One page total across the three ticks.
    await runReconcile(
      tickDeps({ statusLine: "v=5.3.0/abc1234 tunnel=up disk=93%/fail", state, notes }).deps,
    );
    expect(notes.filter(([, m]) => m.includes("condition:disk-fail")).length).toBe(1);
  });
});
