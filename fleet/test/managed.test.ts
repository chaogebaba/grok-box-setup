// T11 — config pass: render/validate/managed_remote_script/push_managed rc
// classifier + config-pass canary routing. Parity blocks named in F10/S5.

import { test, expect, describe } from "bun:test";
import { renderManaged, mergeManaged, unknownManagedKeys, MANAGED_HEADER } from "../src/managed/render.ts";
import { validateManaged } from "../src/managed/validate.ts";
import {
  managedRemoteScript,
  parseStatusTokens,
  hadStatus,
  textSha256,
} from "../src/managed/remote-script.ts";
import { pushManaged, type ManagedSource } from "../src/actions/config-push.ts";
import { configPass } from "../src/actions/config-pass.ts";
import { ReconcileState, type StateFs } from "../src/reconcile/state.ts";
import { FakeRunner, result, isSs } from "./fake-runner.ts";
import { testEnv } from "./helpers.ts";
import { setLogSink } from "../src/log.ts";

/** Capture log lines emitted during `fn`. */
async function withLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  try {
    await fn();
  } finally {
    setLogSink(prev);
  }
  return lines;
}

// ---- render_test / render_present_test (tests:2321-2430) ----
describe("T11 render_managed (tests:2321-2430)", () => {
  test("no inputs ⇒ header only (trailing \\n)", () => {
    expect(renderManaged(undefined, undefined)).toBe(MANAGED_HEADER + "\n");
  });
  test("fleet.toml then box.toml, LAST-WINS per (table,key), first-seen order", () => {
    const fleet = "[ssh]\npassword = fleetpw\n[update]\nrepo = main\n";
    const box = "[ssh]\npassword = boxpw\n"; // overrides ssh.password in place
    const body = mergeManaged([fleet, box]);
    expect(body).toBe("[ssh]\npassword = boxpw\n[update]\nrepo = main");
  });
  test("comments/blank lines dropped; table header once", () => {
    const t = "# c\n\n[ssh]\npassword = x\n# more\npassword = y\n";
    expect(mergeManaged([t])).toBe("[ssh]\npassword = y");
  });
  test("header is byte-verbatim (4 lines)", () => {
    expect(MANAGED_HEADER.split("\n").length).toBe(4);
    expect(MANAGED_HEADER.startsWith("# managed.toml — WRITTEN BY THE VPS BRAIN")).toBe(true);
  });
});

// ---- validate_test (tests:2456-2483) ----
describe("T11 validate_managed (D4 refusals, tests:2456-2483)", () => {
  test("[fleet] table refused", () => {
    expect(validateManaged("[fleet]\nvps = x\n").ok).toBe(false);
  });
  test("table outside subset refused", () => {
    expect(validateManaged("[bogus]\nk = v\n").ok).toBe(false);
  });
  test("[tailscale].tags refused", () => {
    expect(validateManaged("[tailscale]\ntags = a\n").ok).toBe(false);
  });
  test("unparsable line refused", () => {
    expect(validateManaged("[ssh]\nnokvhere\n").ok).toBe(false);
  });
  test("empty key refused", () => {
    expect(validateManaged("[ssh]\n = v\n").ok).toBe(false);
  });
  test("known + unknown-but-well-formed keys allowed", () => {
    expect(validateManaged("[ssh]\npassword = x\n[update]\nnewkey = y\n").ok).toBe(true);
  });
  test("unknownManagedKeys lists forward-compat keys (known excluded)", () => {
    const keys = unknownManagedKeys("[ssh]\npassword = x\n[update]\nnewkey = y\nrepo = m\n");
    expect(keys).toEqual(["update.newkey"]);
  });
});

// ---- mrs_scan_test (E1 char scan, tests:3182-3203) ----
describe("T11 managed_remote_script (mrs_scan E1)", () => {
  test("no apostrophe / backtick / comment lines for dry 0 and 1", () => {
    for (const dry of [0, 1] as const) {
      const s = managedRemoteScript("deadbeef", dry);
      expect(s.includes("'")).toBe(false);
      expect(s.includes("`")).toBe(false);
      for (const line of s.split("\n")) expect(line.trimStart().startsWith("#")).toBe(false);
      expect(s).toContain(`dry=${dry}`);
      expect(s).toContain("want=deadbeef");
    }
  });
  test("parseStatusTokens picks the first cur=/sha= line, order-independent", () => {
    const out = "noise\nsha=NOW cur=CUR support=yes enabled=true\n---FILE---\nfoo";
    expect(parseStatusTokens(out)).toEqual({ cur: "CUR", sha: "NOW", support: "yes", enabled: "true" });
    expect(hadStatus(out)).toBe(true);
    expect(hadStatus("no status here")).toBe(false);
  });
});

// ---- wrap_test (E1 AUTHORITATIVE real sh -c, tests:3204-3239) ----
describe("T11 wrap_test — managed_remote_script through a REAL sh -c", () => {
  test("gate-r1 fix: want_sha pins to bash's byte-for-byte sha (single trailing \\n) and == the sha the remote hashes from the SAME stdin", async () => {
    // The exact VPS fleet.toml from the r1 gate. Bash computed
    // dd15bf79…d83ff4 = printf '%s\n' "$(render)" | sha256sum (render body + ONE
    // trailing \n). renderManaged already ends in one \n, so textSha256 must
    // hash it AS-IS (no extra \n) to match — and that must equal what the box
    // hashes from the STDIN bytes grokfleet sends (also `text` as-is).
    const fleetToml =
      "# fleet-wide managed config (config-truth Phase 2). Behaviour-neutral seed:\n" +
      "# [update].repo = boxup DEFAULT_REPO_URL. Created 2026-08-29 by supervisor.\n" +
      "[update]\n" +
      'repo = "https://github.com/chaogebaba/grok-box-setup.git"\n';
    const text = renderManaged(fleetToml, undefined);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false); // exactly ONE trailing newline
    const want = await textSha256(text);
    // pin to bash's value
    expect(want).toBe("dd15bf797cb949f6edf07287d45c0c13da4eca669b05e0a59ef20b0c5cd83ff4");
    // want_sha == sha256 of the STDIN bytes the box receives (text as-is)
    const onBox = new Bun.CryptoHasher("sha256");
    onBox.update(text); // production sends `stdin: text` (config-push.ts)
    expect(want).toBe(onBox.digest("hex"));
  });

  test("matching sha writes the file; status line printed", async () => {
    const { mkdtempSync, writeFileSync, rmSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/grokfleet-mrs-`);
    const mf = `${dir}/managed.toml`;
    const bx = `${dir}/boxup`;
    // fake boxup with a MANAGED_FILE= line + config-get managed enabled ⇒ true
    writeFileSync(bx, "MANAGED_FILE=/x\n", { mode: 0o644 });
    const text = "[ssh]\npassword = x\n";
    const want = await textSha256(text);
    // Emit the script but point mf/bx at the scratch dir (same SHAPE as the port).
    const script = managedRemoteScript(want, 0)
      .replace("mf=/workspace/box-setup/managed.toml", `mf=${mf}`)
      .replace("bx=/workspace/box-setup/boxup", `bx=${bx}`);
    // config-get would need bash boxup; our fake boxup lacks it ⇒ prc!=0/1 ⇒
    // support=yes but enabled=unknown. That's fine — we assert the WRITE.
    const proc = Bun.spawnSync(["sh", "-c", script], {
      // send the rendered text AS-IS (matches production: text already ends in
      // one \n and want_sha hashes those exact bytes — gate-r1 fix).
      stdin: Buffer.from(text),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString();
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(mf, "utf8")).toBe(text); // stdin sent AS-IS (one trailing \n)
    expect(out).toContain(`sha=${want}`);
    rmSync(dir, { recursive: true, force: true });
  });

  test("sha mismatch ⇒ exit 3, MANAGED_SHA_MISMATCH, nothing written", async () => {
    const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/grokfleet-mrs2-`);
    const mf = `${dir}/managed.toml`;
    const script = managedRemoteScript("WRONGSHA", 0).replace(
      "mf=/workspace/box-setup/managed.toml",
      `mf=${mf}`,
    );
    const proc = Bun.spawnSync(["sh", "-c", script], {
      stdin: Buffer.from("[ssh]\npassword = x\n\n"),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(3);
    expect(proc.stderr.toString()).toContain("MANAGED_SHA_MISMATCH");
    expect(existsSync(mf)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---- rc_test (E2 classifier, tests:3240-3277) ----
function pushSource(): ManagedSource {
  return { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined };
}
async function pushWith(code: number, stdout: string, dry = false): Promise<number> {
  const runner = new FakeRunner(() => result({ code, stdout }));
  const r = await pushManaged("grok-box-8", dry, { runner, env: testEnv(), source: pushSource() });
  return r.rc;
}

describe("T11 push_managed rc classifier (E2, tests:3240-3277)", () => {
  test("ssh rc 255 ⇒ 6 (transport)", async () => {
    expect(await pushWith(255, "")).toBe(6);
  });
  test("non-3 rc with NO status line ⇒ 5 (content)", async () => {
    expect(await pushWith(2, "")).toBe(5);
  });
  test("rc 3 (sha mismatch) ⇒ returned verbatim (3)", async () => {
    expect(await pushWith(3, "")).toBe(3);
  });
  test("non-3 rc WITH a status line ⇒ returned verbatim (S2)", async () => {
    expect(await pushWith(7, "sha=NOW cur=CUR support=yes enabled=true")).toBe(7);
  });
  test("D4 refusal ⇒ 4 (no ssh call)", async () => {
    const runner = new FakeRunner(() => result({ code: 0 }));
    const src: ManagedSource = { fleetToml: () => "[fleet]\nvps = x\n", boxToml: () => undefined };
    const r = await pushManaged("grok-box-8", true, { runner, env: testEnv(), source: src });
    expect(r.rc).toBe(4);
    expect(runner.calls.length).toBe(0); // never reached the tunnel
  });
  test("dry-run in-sync ⇒ 0", async () => {
    const text = "[ssh]\npassword = x\n";
    const want = await textSha256(renderManaged("[ssh]\npassword = x\n", undefined));
    expect(await pushWith(0, `sha=${want} cur=${want} support=yes enabled=true`, true)).toBe(0);
    void text;
  });
  test("apply read-back mismatch ⇒ 5", async () => {
    expect(await pushWith(0, "sha=OTHER cur=none support=yes enabled=true", false)).toBe(5);
  });
});

// ---- config-pass canary routing (cfgpass* blocks) ----
function memState(): { fs: StateFs; store: Map<string, string> } {
  const store = new Map<string, string>();
  const fs: StateFs = {
    read: (p) => store.get(p),
    write: (p, d) => store.set(p, d),
    remove: (p) => store.delete(p),
    mkdirp: () => {},
    chmod: () => {},
    rename: () => {},
    exists: (p) => store.has(p),
    tmpname: (d, p) => `${d}/${p}x`,
  };
  return { fs, store };
}

// A runner where ss reports the given boxes' tunnels up, and every push (ssh
// with the sudo sh -c script) returns a healthy in-sync status.
function passRunner(upPorts: number[]): FakeRunner {
  return new FakeRunner((argv) => {
    if (isSs(argv)) {
      const lines = upPorts.map((p) => `LISTEN 0 128 127.0.0.1:${p} 0.0.0.0:* users:(("sshd",pid=41,fd=7))`);
      return result({ stdout: lines.join("\n") + "\n" });
    }
    // config push: emit an in-sync status line (cur==sha) so it reports rc 0.
    // We can't know want_sha here, so echo a generic line and rely on dry-run:
    // in dry-run push_managed only needs cur==want to say "in sync"; but want is
    // computed. Simplest: return support=yes enabled=true with matching sha by
    // echoing back nothing forces a mismatch. Instead use apply=false and a
    // status where cur==sha==<the want>. We approximate by returning a line the
    // test does not assert exact sync on — it asserts the routing/log counts.
    return result({ code: 0, stdout: "sha=X cur=X support=yes enabled=true" });
  });
}

describe("T11 config pass canary routing (F1/F2)", () => {
  test("managed files absent ⇒ silent no-op rc 0", async () => {
    const { fs } = memState();
    const r = await configPass({
      runner: new FakeRunner(),
      env: testEnv(),
      source: { fleetToml: () => undefined, boxToml: () => undefined },
      state: new ReconcileState("/s", fs),
      notify: () => {},
      targetBoxes: ["grok-box-8"],
      configCanary: undefined,
      managedFilesPresent: false,
      apply: false,
    });
    expect(r).toMatchObject({ rc: 0, ok: 0, skipped: 0, failed: 0 });
  });

  test("dynamic canary = lowest-index box with a tunnel up", async () => {
    const { fs } = memState();
    // 002 down, 004 up ⇒ canary = grok-box-004 (lowest reachable)
    const r = await configPass({
      runner: passRunner([20004, 20011]),
      env: testEnv(),
      source: { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined },
      state: new ReconcileState("/s", fs),
      notify: () => {},
      targetBoxes: ["grok-box-002", "grok-box-004", "grok-box-011"],
      configCanary: undefined,
      managedFilesPresent: true,
      apply: false,
    });
    expect(r.policy).toBe("dynamic");
    expect(r.canary).toBe("grok-box-004");
  });

  test("fixed canary from configCanary", async () => {
    const { fs } = memState();
    const r = await configPass({
      runner: passRunner([20002]),
      env: testEnv(),
      source: { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined },
      state: new ReconcileState("/s", fs),
      notify: () => {},
      targetBoxes: ["grok-box-002"],
      configCanary: "grok-box-002",
      managedFilesPresent: true,
      apply: false,
    });
    expect(r.policy).toBe("fixed");
    expect(r.canary).toBe("grok-box-002");
  });

  test("F3 parity: fixed policy emits NO 'config: canary policy=' line (bash parity)", async () => {
    const { fs } = memState();
    const lines = await withLogs(async () => {
      await configPass({
        runner: passRunner([20002]),
        env: testEnv(),
        source: { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined },
        state: new ReconcileState("/s", fs),
        notify: () => {},
        targetBoxes: ["grok-box-002"],
        configCanary: "grok-box-002", // fixed policy
        managedFilesPresent: true,
        apply: false,
      });
    });
    // bash emits the pass-start line but NEVER a `config: canary policy=` line.
    expect(lines.some((l) => l.includes("config: pass start (dry-run)"))).toBe(true);
    expect(lines.some((l) => l.includes("config: canary policy="))).toBe(false);
  });

  test("F3: dynamic policy KEEPS the 'config: canary policy=dynamic' line (grokfleet-only mode)", async () => {
    const { fs } = memState();
    const lines = await withLogs(async () => {
      await configPass({
        runner: passRunner([20004]),
        env: testEnv(),
        source: { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined },
        state: new ReconcileState("/s", fs),
        notify: () => {},
        targetBoxes: ["grok-box-004"],
        configCanary: undefined, // dynamic policy
        managedFilesPresent: true,
        apply: false,
      });
    });
    expect(lines.some((l) => l.includes("config: canary policy=dynamic"))).toBe(true);
  });

  test("no reachable box ⇒ no canary, one skip, non-canary loop still runs", async () => {
    const { fs } = memState();
    const notes: string[] = [];
    const r = await configPass({
      runner: passRunner([]), // nothing up
      env: testEnv(),
      source: { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined },
      state: new ReconcileState("/s", fs),
      notify: (_l, m) => void notes.push(m),
      targetBoxes: ["grok-box-002", "grok-box-004"],
      configCanary: undefined,
      managedFilesPresent: true,
      apply: false,
    });
    expect(r.canary).toBeUndefined();
    // one skip for "no canary" + 2 skips for the two tunnel-down boxes
    expect(r.skipped).toBe(3);
    expect(r.rc).toBe(0);
  });

  // A runner where every push returns a chosen ssh code (for rc classification).
  function pushRunner(upPorts: number[], pushCode: number, pushOut: string): FakeRunner {
    return new FakeRunner((argv) => {
      if (isSs(argv)) {
        const lines = upPorts.map((p) => `LISTEN 0 128 127.0.0.1:${p} 0.0.0.0:* users:(("sshd",pid=41,fd=7))`);
        return result({ stdout: lines.join("\n") + "\n" });
      }
      return result({ code: pushCode, stdout: pushOut });
    });
  }

  test("m6: non-canary checkfail>3 ⇒ skipped, no push", async () => {
    const { fs, store } = memState();
    store.set("/s/grok-box-004.checkfail", "5\n"); // unhealthy
    const runner = pushRunner([20002, 20004], 0, "sha=X cur=X support=yes enabled=true");
    const r = await configPass({
      runner,
      env: testEnv(),
      source: { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined },
      state: new ReconcileState("/s", fs),
      notify: () => {},
      targetBoxes: ["grok-box-002", "grok-box-004"],
      configCanary: "grok-box-002", // fixed canary so 004 goes through the non-canary arm
      managedFilesPresent: true,
      apply: false,
    });
    // 004 skipped for checkfail>3 (m6: a presence-gate would push it)
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    // exactly one push (the canary 002); 004 skipped
    const pushes = runner.calls.filter((c) => (c.argv[c.argv.length - 1] ?? "").startsWith("sudo sh -c"));
    expect(pushes.length).toBe(1);
  });

  test("m7: canary rc 6 (transport) ⇒ skip canary + fall through (not content-abort)", async () => {
    const { fs } = memState();
    // canary push returns ssh rc 255 ⇒ push rc 6; a non-canary box then pushes ok.
    const runner = new FakeRunner((argv) => {
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20002 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\nLISTEN 0 128 127.0.0.1:20004 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" });
      // canary 002 (port 20002) ⇒ transport rc 255; others push ok.
      if (argv.includes("20002")) return result({ code: 255, stdout: "" });
      return result({ code: 0, stdout: "sha=X cur=X support=yes enabled=true" });
    });
    const r = await configPass({
      runner,
      env: testEnv(),
      source: { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined },
      state: new ReconcileState("/s", fs),
      notify: () => {},
      targetBoxes: ["grok-box-002", "grok-box-004"],
      configCanary: "grok-box-002",
      managedFilesPresent: true,
      apply: false,
    });
    // rc6 canary ⇒ NOT a content abort: the pass continues (004 attempted).
    expect(r.rc).toBe(0);
    expect(r.failed).toBe(0);
    // 004 was pushed (fall-through happened)
    const pushed004 = runner.calls.some(
      (c) => c.argv.includes("20004") && (c.argv[c.argv.length - 1] ?? "").startsWith("sudo sh -c"),
    );
    expect(pushed004).toBe(true);
  });

  test("m8: canary content-fail cn<=3 ⇒ NO notify (log only); cn>3 ⇒ notify", async () => {
    // canary push returns rc 2 no status ⇒ push rc 5 (content) ⇒ bump cfgfail.
    const runner = new FakeRunner((argv) => {
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20002 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" });
      return result({ code: 2, stdout: "" });
    });
    // cn=1 (first failure) ⇒ NO notify
    {
      const { fs } = memState();
      const notes: string[] = [];
      const r = await configPass({
        runner,
        env: testEnv(),
        source: { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined },
        state: new ReconcileState("/s", fs),
        notify: (_l, m) => void notes.push(m),
        targetBoxes: ["grok-box-002"],
        configCanary: "grok-box-002",
        managedFilesPresent: true,
        apply: true,
      });
      expect(r.rc).toBe(1);
      expect(notes.length).toBe(0); // m8: >0 would notify here
    }
    // cn already 3 ⇒ this failure makes 4 (>3) ⇒ notify
    {
      const { fs, store } = memState();
      store.set("/s/grok-box-002.cfgfail", "3\n");
      const notes: string[] = [];
      await configPass({
        runner,
        env: testEnv(),
        source: { fleetToml: () => "[ssh]\npassword = x\n", boxToml: () => undefined },
        state: new ReconcileState("/s", fs),
        notify: (_l, m) => void notes.push(m),
        targetBoxes: ["grok-box-002"],
        configCanary: "grok-box-002",
        managedFilesPresent: true,
        apply: true,
      });
      expect(notes.some((m) => m.includes("config push failing for grok-box-002") && m.includes("config pass aborted"))).toBe(true);
    }
  });
});
