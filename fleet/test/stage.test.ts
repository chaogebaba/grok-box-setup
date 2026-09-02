// stage.test.ts — D1/D4: the rollout target is resolved against the REMOTE.
//
// `[rollout].target` is `main`, and `main` inside `[rollout].src` is a LOCAL
// branch that a `git fetch` never advances — fetch moves
// `refs/remotes/origin/main` and leaves the local branch where the last
// checkout put it. fleet2 never checks the source tree out, so the VPS's local
// `main` sat 77 commits behind origin and the resolved target sha had not moved
// since 30 Aug. Every box read as "at target" and no boxup release could reach
// the fleet, with auto-rollout on or off.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { resolveTarget } from "../src/stage.ts";
import { FakeRunner, result } from "./fake-runner.ts";
import { setLogSink } from "../src/log.ts";

const SRC = "/opt/grok-fleet/src";
const REF = "main";
const LOCAL_SHA = "f42c967"; // the frozen local branch
const REMOTE_SHA = "9c31ab4"; // where origin/main actually is

let logs: string[] = [];
let prevSink: (l: string) => void;
beforeEach(() => {
  logs = [];
  prevSink = setLogSink((l) => logs.push(l));
});
afterEach(() => setLogSink(prevSink));

/** Is this argv the D1 existence probe for the remote-tracking ref? */
function isRemoteProbe(argv: string[]): boolean {
  return argv.includes("--verify") && argv.includes(`refs/remotes/origin/${REF}`);
}

interface Opts {
  /** does refs/remotes/origin/<ref> exist? */
  remoteExists: boolean;
  /** does the best-effort fetch succeed? */
  fetchOk?: boolean;
  version?: string;
}

function runnerFor(o: Opts): FakeRunner {
  return new FakeRunner((argv) => {
    const j = argv.join(" ");
    if (j.includes("rev-parse --git-dir")) return result({ code: 0, stdout: ".git" });
    if (j.includes("fetch")) return result({ code: (o.fetchOk ?? true) ? 0 : 1 });
    // The probe prints NOTHING and only signals through its exit code.
    if (isRemoteProbe(argv)) return result({ code: o.remoteExists ? 0 : 1, stdout: "" });
    if (j.includes(`rev-parse --short origin/${REF}`)) return result({ code: 0, stdout: `${REMOTE_SHA}\n` });
    if (j.includes(`rev-parse --short ${REF}`)) return result({ code: 0, stdout: `${LOCAL_SHA}\n` });
    if (j.includes("show")) return result({ code: 0, stdout: `${o.version ?? "5.3.1"}\n` });
    return result({ code: 1 });
  });
}

describe("D1 resolveTarget prefers the remote-tracking ref", () => {
  test("(a) refs/remotes/origin/<ref> exists ⇒ the sha is origin's, and one log line says so", async () => {
    const r = runnerFor({ remoteExists: true });
    const t = await resolveTarget(r, SRC, REF);
    expect(t.sha).toBe(REMOTE_SHA);
    expect(t.sha).not.toBe(LOCAL_SHA); // kills mutant (u)
    expect(t.ref).toBe(REF); // the CONFIGURED ref is what we report back
    expect(t.version).toBe("5.3.1");
    expect(logs.filter((l) => l.includes(`stage: target ${REF} → origin/${REF} ${REMOTE_SHA} (v5.3.1)`))).toHaveLength(1);
  });

  test("(b) no remote-tracking ref (a tag, a raw sha, a local-only branch) ⇒ the bare ref, exactly as before", async () => {
    const r = runnerFor({ remoteExists: false });
    const t = await resolveTarget(r, SRC, REF);
    expect(t.sha).toBe(LOCAL_SHA); // kills mutant (v)
    // origin/<ref> is never even asked about once the probe says it is absent.
    expect(r.joined().some((c) => c.includes(`rev-parse --short origin/${REF}`))).toBe(false);
    // and the remote-ref log line is NOT emitted for a bare-ref resolution.
    expect(logs.some((l) => l.includes("→ origin/"))).toBe(false);
  });

  test("(c) the fetch FAILS but the remote ref exists ⇒ still resolved against origin, with the offline warning", async () => {
    // The intended offline behaviour: refs/remotes/origin/<ref> still resolves,
    // to the last value this VPS actually fetched. An unreachable origin means
    // converging on the newest target we have seen, not falling back to a stale
    // local branch and not failing the tick.
    const r = runnerFor({ remoteExists: true, fetchOk: false });
    const t = await resolveTarget(r, SRC, REF);
    expect(t.sha).toBe(REMOTE_SHA);
    expect(logs.some((l) => l.includes("git fetch failed (offline?)"))).toBe(true);
    expect(logs.some((l) => l.includes(`→ origin/${REF} ${REMOTE_SHA}`))).toBe(true);
  });

  test("(d) argv fixtures: the probe, then the resolution, both exact", async () => {
    const r = runnerFor({ remoteExists: true });
    await resolveTarget(r, SRC, REF);
    const argvs = r.argvs();
    const probeAt = argvs.findIndex(isRemoteProbe);
    expect(probeAt).toBeGreaterThan(-1);
    expect(argvs[probeAt]).toEqual([
      "git",
      "-C",
      SRC,
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${REF}`,
    ]);
    const resolveAt = argvs.findIndex((a) => a.join(" ") === `git -C ${SRC} rev-parse --short origin/${REF}`);
    expect(argvs[resolveAt]).toEqual(["git", "-C", SRC, "rev-parse", "--short", `origin/${REF}`]);
    // the probe comes FIRST — it is what decides which ref the next call names,
    // and it runs after the best-effort fetch so a fresh origin/<ref> is seen.
    expect(probeAt).toBeLessThan(resolveAt);
    expect(argvs.findIndex((a) => a.includes("fetch"))).toBeLessThan(probeAt);
  });

  test("the staged sha is the one VERSION is read at, so version and sha never disagree", async () => {
    const r = runnerFor({ remoteExists: true });
    await resolveTarget(r, SRC, REF);
    expect(r.joined().some((c) => c === `git -C ${SRC} show ${REMOTE_SHA}:VERSION`)).toBe(true);
  });
});
