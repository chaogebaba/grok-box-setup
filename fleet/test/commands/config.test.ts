// config.test.ts — T4 config render|diff|push (D12/F12). Drives cmdConfig with a
// FakeRunner + injected ManagedSource + enrolled list + whichDiff seam.

import { describe, test, expect } from "bun:test";
import { cmdConfig } from "../../src/commands/config.ts";
import { renderManaged } from "../../src/managed/render.ts";
import { textSha256 } from "../../src/managed/remote-script.ts";
import { testEnv } from "../helpers.ts";
import { FakeRunner, result } from "../fake-runner.ts";
import type { ManagedSource } from "../../src/actions/config-push.ts";
import { setLogSink } from "../../src/log.ts";

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  return { lines, restore: () => setLogSink(prev) };
}

const env = testEnv();
const FLEET_TOML = '[ssh]\npassword = "abc"\n';
const source: ManagedSource = { fleetToml: () => FLEET_TOML, boxToml: () => undefined };
const enrolled = ["grok-box-8"];
const whichDiff = async () => "/usr/bin/diff";

describe("T4 config usage/refusal (rc 2)", () => {
  test("bad sub ⇒ rc 2", async () => {
    const rc = await cmdConfig(["frob", "grok-box-8"], { runner: new FakeRunner(), env, source, enrolled });
    expect(rc).toBe(2);
  });
  test("missing box ⇒ rc 2", async () => {
    const rc = await cmdConfig(["render"], { runner: new FakeRunner(), env, source, enrolled });
    expect(rc).toBe(2);
  });
  test("not enrolled ⇒ rc 2 refusing", async () => {
    const cap = captureLog();
    let err = "";
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => { err += s; return true; };
    const rc = await cmdConfig(["render", "grok-box-9"], { runner: new FakeRunner(), env, source, enrolled });
    (process.stderr as any).write = origErr;
    cap.restore();
    expect(rc).toBe(2);
    expect(err).toContain("grok-box-9 is not enrolled");
  });
});

describe("T4 render", () => {
  test("render ⇒ stdout the rendered managed.toml, rc 0", async () => {
    let out = "";
    const rc = await cmdConfig(["render", "grok-box-8"], { runner: new FakeRunner(), env, source, enrolled, write: (s) => (out += s) });
    expect(rc).toBe(0);
    expect(out).toBe(renderManaged(FLEET_TOML, undefined));
  });
});

describe("T4 diff (F12)", () => {
  // D11(c): `grokfleet config diff` now gates on tunnelUp, so every runner in this
  // block must answer the `ss -tlnp` probe with a healthy sshd-owned listener on
  // grok-box-8's port. A squatter or an absent listener is its own test below.
  const SS_UP =
    'LISTEN 0 128 127.0.0.1:20008 0.0.0.0:* users:(("sshd",pid=41,fd=7))\n';
  const isSsArgv = (argv: string[]) => argv[0] === "ss";

  async function dryRunOutput(box: string, onbox: string, opts: { cur?: string; enabled?: string; support?: string }) {
    const text = renderManaged(FLEET_TOML, undefined);
    const want = await textSha256(text);
    const cur = opts.cur ?? want;
    const enabled = opts.enabled ?? "true";
    const support = opts.support ?? "yes";
    return `cur=${cur} want=${want} support=${support} enabled=${enabled}\n---FILE---\n${onbox}`;
  }

  // A runner that runs the REAL diff(1) on the temp files runDiff wrote (so the
  // trailing-newline handling is actually exercised), and returns the fixture
  // for the tunnel dry-run. Used by the F2 live-parity tests.
  function realDiffRunner(dryFixture: string): FakeRunner {
    return new FakeRunner((argv) => {
      if (isSsArgv(argv)) return result({ stdout: SS_UP });
      if (argv[0] === "/usr/bin/diff") {
        const r = Bun.spawnSync(argv);
        return result({ code: r.exitCode ?? 0, stdout: r.stdout.toString(), stderr: r.stderr.toString() });
      }
      return result({ code: 0, stdout: dryFixture }); // the tunnel dry-run
    });
  }

  test("F2: remote ---FILE--- body ALREADY ends in \\n ⇒ byte-EMPTY diff (bash parity)", async () => {
    // The LIVE remote `boxup config-get` body ends in a newline. Feed a fixture
    // whose on-box body == the rendered text AND ends in \n; with the r1 fix the
    // diff must be byte-empty (bash outputs nothing). The pre-fix code appended a
    // second \n and produced a spurious trailing-blank-line diff.
    const text = renderManaged(FLEET_TOML, undefined); // ends in exactly one \n
    const dry = await dryRunOutput("grok-box-8", text, {}); // on-box body ends in \n
    let out = "";
    const rc = await cmdConfig(["diff", "grok-box-8"], {
      runner: realDiffRunner(dry),
      env,
      source,
      enrolled,
      whichDiff,
      write: (s) => (out += s),
    });
    expect(rc).toBe(0);
    expect(out).toBe(""); // byte-empty, matching bash's empty stdout
  });

  test("F2: remote body ends in \\n but content DIFFERS ⇒ real diff still shown (no false-negative)", async () => {
    const text = renderManaged(FLEET_TOML, undefined);
    // on-box body differs (an extra key) AND ends in \n.
    const onbox = text.replace(/\n$/, "") + '\nextra = "1"\n';
    const dry = await dryRunOutput("grok-box-8", onbox, { cur: "differentsha" });
    let out = "";
    const rc = await cmdConfig(["diff", "grok-box-8"], {
      runner: realDiffRunner(dry),
      env,
      source,
      enrolled,
      whichDiff,
      write: (s) => (out += s),
    });
    expect(rc).toBe(1); // drift
    expect(out).toContain('extra = "1"'); // the genuine difference IS shown
    // and NOT a spurious lone trailing-blank-line hunk
    expect(out).not.toMatch(/@@ [^\n]*@@\n(?:[ +-]\S.*\n)* \S+\n-\n$/);
  });

  test("m8: config diff sends the remote script with the DRY-RUN flag (dry=1), never a push", async () => {
    // The diff MUST run the remote managed script in dry-run mode
    // (managedRemoteScript(want, 1) ⇒ `dry=1`), which reads the on-box file and
    // writes NOTHING. m8 (drop the dry-run flag ⇒ dry=0) would PUSH on a diff.
    const text = renderManaged(FLEET_TOML, undefined);
    const dry = await dryRunOutput("grok-box-8", text, {});
    let remoteCmd = "";
    const runner = new FakeRunner((argv) => {
      if (isSsArgv(argv)) return result({ stdout: SS_UP });
      if (argv[0] === "/usr/bin/diff") return result({ stdout: "", code: 0 });
      // the tunnel-ssh dry-run call — capture the remote command (last argv elt).
      remoteCmd = argv[argv.length - 1] ?? "";
      return result({ code: 0, stdout: dry });
    });
    await cmdConfig(["diff", "grok-box-8"], { runner, env, source, enrolled, whichDiff, write: () => {} });
    // the remote managed script must carry the dry-run flag and NOT the apply path.
    expect(remoteCmd).toContain("dry=1");
    expect(remoteCmd).not.toContain("dry=0");
  });

  test("in sync (cur==want, enabled true, support yes) ⇒ rc 0", async () => {
    const text = renderManaged(FLEET_TOML, undefined);
    const dry = await dryRunOutput("grok-box-8", text.replace(/\n$/, ""), {});
    const runner = new FakeRunner((argv) => {
      if (isSsArgv(argv)) return result({ stdout: SS_UP });
      if (argv[0] === "/usr/bin/diff") return result({ stdout: "", code: 0 });
      return result({ code: 0, stdout: dry }); // the tunnel dry-run
    });
    let out = "";
    const rc = await cmdConfig(["diff", "grok-box-8"], { runner, env, source, enrolled, whichDiff, write: (s) => (out += s) });
    expect(rc).toBe(0);
  });

  test("drift (cur != want) ⇒ rc 1", async () => {
    const dry = await dryRunOutput("grok-box-8", "old body", { cur: "differentsha" });
    const runner = new FakeRunner((argv) => {
      if (isSsArgv(argv)) return result({ stdout: SS_UP });
      if (argv[0] === "/usr/bin/diff") return result({ stdout: "@@ -1 +1 @@\n-old\n+new\n", code: 1 });
      return result({ code: 0, stdout: dry });
    });
    let out = "";
    const rc = await cmdConfig(["diff", "grok-box-8"], { runner, env, source, enrolled, whichDiff, write: (s) => (out += s) });
    expect(rc).toBe(1);
    expect(out).toContain("@@"); // the diff body was written
  });

  test("enabled=false ⇒ NOTE + never in-sync (rc 1)", async () => {
    const dry = await dryRunOutput("grok-box-8", "body", { enabled: "false" });
    const runner = new FakeRunner((argv) => {
      if (isSsArgv(argv)) return result({ stdout: SS_UP });
      if (argv[0] === "/usr/bin/diff") return result({ stdout: "", code: 0 });
      return result({ code: 0, stdout: dry });
    });
    let out = "";
    const rc = await cmdConfig(["diff", "grok-box-8"], { runner, env, source, enrolled, whichDiff, write: (s) => (out += s) });
    expect(rc).toBe(1);
    expect(out).toContain("NOTE: [managed] enabled=false on grok-box-8 — pushed values are IGNORED on this box");
  });

  test("support=no ⇒ NOTE + never in-sync (rc 1)", async () => {
    const dry = await dryRunOutput("grok-box-8", "body", { support: "no" });
    const runner = new FakeRunner((argv) => {
      if (isSsArgv(argv)) return result({ stdout: SS_UP });
      if (argv[0] === "/usr/bin/diff") return result({ stdout: "", code: 0 });
      return result({ code: 0, stdout: dry });
    });
    let out = "";
    const rc = await cmdConfig(["diff", "grok-box-8"], { runner, env, source, enrolled, whichDiff, write: (s) => (out += s) });
    expect(rc).toBe(1);
    expect(out).toContain("boxup on grok-box-8 lacks managed support");
  });

  test("diff(1) absent ⇒ rc 2 (F12)", async () => {
    let err = "";
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => { err += s; return true; };
    const rc = await cmdConfig(["diff", "grok-box-8"], { runner: new FakeRunner(), env, source, enrolled, whichDiff: async () => undefined });
    (process.stderr as any).write = origErr;
    expect(rc).toBe(2);
    expect(err).toContain("config diff: diff(1) not found");
  });

  test("tunnel unreachable ⇒ rc 2", async () => {
    let err = "";
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => { err += s; return true; };
    const runner = new FakeRunner((argv) =>
      isSsArgv(argv) ? result({ stdout: SS_UP }) : argv[0] === "/usr/bin/diff" ? result({}) : result({ code: 255 }),
    );
    const rc = await cmdConfig(["diff", "grok-box-8"], { runner, env, source, enrolled, whichDiff });
    (process.stderr as any).write = origErr;
    expect(rc).toBe(2);
    expect(err).toContain("unreachable/failed");
  });

  test("D11(c): a FOREIGN listener on the port ⇒ rc 2 and NO ssh of any kind", async () => {
    // A squatter must read as `tunnel: down` on every path, the CLI included —
    // otherwise this human-invoked diff hands it the rendered managed config on
    // stdin.
    let err = "";
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (s: string) => { err += s; return true; };
    const squatted =
      'LISTEN 0 128 127.0.0.1:20008 0.0.0.0:* users:(("python3",pid=9001,fd=3))\n';
    const runner = new FakeRunner((argv) => (isSsArgv(argv) ? result({ stdout: squatted }) : result({ code: 0 })));
    const rc = await cmdConfig(["diff", "grok-box-8"], { runner, env, source, enrolled, whichDiff });
    (process.stderr as any).write = origErr;
    expect(rc).toBe(2);
    expect(err).toContain("tunnel down");
    expect(runner.argvs().some((a) => a[0] === "ssh")).toBe(false);
  });
});

describe("T4 push (delegates to pushManaged E2)", () => {
  test("push transport unreachable (ssh 255) ⇒ rc 6", async () => {
    const runner = new FakeRunner(() => result({ code: 255 }));
    const rc = await cmdConfig(["push", "grok-box-8"], { runner, env, source, enrolled });
    expect(rc).toBe(6);
  });
});
