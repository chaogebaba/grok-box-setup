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
  // ---- A8 (5.12.1): [keepawake] -------------------------------------------
  //
  // The keep-awake experiment was ABANDONED, and the way to switch it off on
  // every box at once is one line in /etc/grok-fleet/fleet.toml. D4 used to
  // refuse that line, and a D4 refusal is rc 4 for EVERY box — so the line meant
  // to disable one feature would have stopped config pushes fleet-wide.
  //
  // The mutant these kill: drop "keepawake" from ALLOWED_TABLES, or drop the
  // KEEPAWAKE_KEYS check.
  test("A8: the fleet-wide abandon line is ACCEPTED", () => {
    const r = validateManaged("[keepawake]\ninterval_min = 0\n");
    expect(r).toEqual({ ok: true, reasons: [] });
  });

  test("A8: a non-zero cadence is accepted too (the table is not a kill switch)", () => {
    expect(validateManaged("[keepawake]\ninterval_min = 20\n").ok).toBe(true);
  });

  test("A8: any OTHER key under [keepawake] is REFUSED, not forward-compat", () => {
    // `interval` parses, would log as "unknown but allowed", leave interval_min
    // unset, and boxup would fall back to its 20-minute default — the feature
    // stays on, at a model turn per fire, while the operator reads a clean push.
    const r = validateManaged("[keepawake]\ninterval = 0\n");
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual([
      "refuse: [keepawake].interval is not a boxup keep-awake key (only interval_min)",
    ]);
    expect(validateManaged("[keepawake]\nfoo = 1\n").ok).toBe(false);
  });

  test("A8: the closed key set is scoped to [keepawake] alone", () => {
    // Every other table keeps the forward-compat rule.
    expect(validateManaged("[update]\ninterval = 0\n").ok).toBe(true);
    // ...and a key named interval_min elsewhere is not special either way.
    expect(validateManaged("[update]\ninterval_min = 0\n").ok).toBe(true);
  });

  test("A8: keepawake.interval_min is a KNOWN key, so it logs no forward-compat noise", () => {
    // Otherwise every config pass on the abandoned fleet would print
    // `unknown-but-well-formed keys ... keepawake.interval_min` every tick.
    expect(unknownManagedKeys("[keepawake]\ninterval_min = 0\n")).toEqual([]);
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
  // A8: the same real entry point, with the fleet-wide abandon line. Before
  // 5.12.1 this returned 4 and never reached the tunnel — for EVERY box, on
  // every tick, for as long as the line was in fleet.toml.
  test("A8: the abandon line reaches the tunnel instead of being refused", async () => {
    const runner = new FakeRunner(() => result({ code: 0, stdout: "sha=S cur=S support=yes enabled=true" }));
    const src: ManagedSource = {
      fleetToml: () => "[ssh]\npassword = x\n\n[keepawake]\ninterval_min = 0\n",
      boxToml: () => undefined,
    };
    const r = await pushManaged("grok-box-8", true, { runner, env: testEnv(), source: src });
    expect(r.rc).not.toBe(4);
    expect(runner.calls.length).toBeGreaterThan(0); // it DID reach the tunnel
    // ...and the rendered bytes the box would hash carry the line.
    const stdin = runner.calls[0]!.opts.stdin as string;
    expect(stdin).toContain("[keepawake]");
    expect(stdin).toContain("interval_min = 0");
  });

  test("A8: a bad keepawake key is still a D4 refusal, with no ssh call", async () => {
    const runner = new FakeRunner(() => result({ code: 0 }));
    const src: ManagedSource = {
      fleetToml: () => "[keepawake]\ninterval = 0\n",
      boxToml: () => undefined,
    };
    const r = await pushManaged("grok-box-8", true, { runner, env: testEnv(), source: src });
    expect(r.rc).toBe(4);
    expect(runner.calls.length).toBe(0);
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
    // 5.14.3 F3-fold: FIXED mode is byte-identical to bash — the pass-start line
    // carries NO `policy=` suffix (the fold is dynamic-only). A mutant that
    // appended the suffix in fixed mode would break bash parity here.
    const fixedStart = lines.find((l) => l.includes("config: pass start (dry-run)"));
    expect(fixedStart).toContain("config: pass start (dry-run) — canary-first over tunnels (canary=grok-box-002)");
    expect(fixedStart!.endsWith("(canary=grok-box-002)")).toBe(true);
    expect(fixedStart).not.toContain("policy=");
  });

  test("F3: dynamic policy FOLDS policy=dynamic into the pass-start line, NO separate canary line", async () => {
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
    // 5.14.3 F3-fold: exactly ONE pass-start line, and it carries policy=dynamic
    // inside the canary group. The standalone `config: canary policy=` line is
    // gone (M7 keeps it ⇒ this assertion fails).
    const starts = lines.filter((l) => l.includes("config: pass start (dry-run)"));
    expect(starts.length).toBe(1);
    expect(starts[0]).toContain("policy=dynamic");
    expect(starts[0]).toContain("(canary=grok-box-004, policy=dynamic)");
    // NO separate `config: canary policy=` line anywhere (M6 drops policy=dynamic
    // from the fold; M7 re-adds the separate line — both caught here + above).
    expect(lines.some((l) => l.includes("config: canary policy="))).toBe(false);
    // exactly one line mentions policy=dynamic at all (the folded pass-start)
    expect(lines.filter((l) => l.includes("policy=dynamic")).length).toBe(1);
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

// ---- A3 (5.12.1): the in-sync summary line -----------------------------------
//
// `config: <box> in sync` fired once per box per tick — eleven boxes across 288
// ticks is 3168 journal lines a day that say nothing happened, and they bury the
// drift/push/skip lines the journal is read for. The pass collects the quiet
// boxes and prints ONE line.
//
// The mutant these kill: restore the per-box `log(...)` in `pushManaged`. Then
// the summary is missing and the per-box lines are back, and every assertion
// below fails.
describe("A3 in-sync log spam", () => {
  const FLEET_TOML = "[ssh]\npassword = x\n";

  /** A runner where every listed box's tunnel is up and every push is in sync. */
  async function syncRunner(ports: number[], ann?: string): Promise<FakeRunner> {
    const want = await textSha256(renderManaged(FLEET_TOML, undefined));
    const extra = ann ?? "support=yes enabled=true";
    return new FakeRunner((argv) => {
      if (isSs(argv)) {
        const lines = ports.map((p) => `LISTEN 0 128 127.0.0.1:${p} 0.0.0.0:* users:(("sshd",pid=41,fd=7))`);
        return result({ stdout: lines.join("\n") + "\n" });
      }
      return result({ code: 0, stdout: `sha=${want} cur=${want} ${extra}` });
    });
  }

  /** The log sink sees `<ts> grokfleet: <line>`; assertions want the line. */
  const bare = (lines: string[]): string[] => lines.map((l) => l.replace(/^\S+ grokfleet: /, ""));

  async function passLogs(runner: FakeRunner, boxes: string[]): Promise<string[]> {
    const { fs } = memState();
    return bare(await withLogs(async () => {
      await configPass({
        runner,
        env: testEnv(),
        source: { fleetToml: () => FLEET_TOML, boxToml: () => undefined },
        state: new ReconcileState("/s", fs),
        notify: () => {},
        targetBoxes: boxes,
        configCanary: undefined,
        managedFilesPresent: true,
        apply: false,
      });
    }));
  }

  test("a quiet fleet costs ONE line, not one per box", async () => {
    const boxes = ["grok-box-002", "grok-box-004", "grok-box-011"];
    const logs = await passLogs(await syncRunner([20002, 20004, 20011]), boxes);
    const summary = logs.filter((l) => l.startsWith("config: in sync "));
    expect(summary).toEqual(["config: in sync grok-box-002,grok-box-004,grok-box-011 (3)"]);
    // Not one of the three per-box lines survives.
    for (const b of boxes) expect(logs).not.toContain(`config: ${b} in sync`);
  });

  test("the summary is greppable for a single box, and lands before `pass done`", async () => {
    const logs = await passLogs(await syncRunner([20002, 20004]), ["grok-box-002", "grok-box-004"]);
    const summary = logs.findIndex((l) => l.startsWith("config: in sync "));
    const done = logs.findIndex((l) => l.startsWith("config: pass done"));
    expect(summary).toBeGreaterThanOrEqual(0);
    expect(summary).toBeLessThan(done);
    expect(logs[summary]).toContain("grok-box-004");
  });

  test("no in-sync box ⇒ NO summary line (an empty one is its own noise)", async () => {
    const runner = new FakeRunner((argv) => {
      if (isSs(argv)) return result({ stdout: "LISTEN 0 128 127.0.0.1:20002 0.0.0.0:* users:((\"sshd\",pid=41,fd=7))\n" });
      return result({ code: 0, stdout: "sha=WANT cur=OTHER support=yes enabled=true" });
    });
    const logs = await passLogs(runner, ["grok-box-002"]);
    expect(logs.some((l) => l.startsWith("config: in sync "))).toBe(false);
    // The drift line is untouched.
    expect(logs.some((l) => l.startsWith("config: grok-box-002 WOULD push"))).toBe(true);
  });

  test("an ANNOTATED in-sync line keeps its own line — it is a warning", async () => {
    // enabled=false: the file matches but the box ignores it. Folding that into
    // a count called "in sync" would hide the one thing an operator must see.
    const runner = await syncRunner([20002], "support=yes enabled=false");
    const logs = await passLogs(runner, ["grok-box-002"]);
    expect(logs.some((l) => l.startsWith("config: in sync "))).toBe(false);
    expect(
      logs.some((l) => l.startsWith("config: grok-box-002 in sync") && l.includes("IGNORED locally")),
    ).toBe(true);
  });

  test("a standalone pushManaged (no pass) still logs per box", async () => {
    // `grokfleet config push <box>` has no pass to summarise into; it must keep
    // printing the answer for the one box the operator asked about.
    const runner = await syncRunner([20002]);
    const logs = bare(await withLogs(async () => {
      await pushManaged("grok-box-002", true, {
        runner,
        env: testEnv(),
        source: { fleetToml: () => FLEET_TOML, boxToml: () => undefined },
      });
    }));
    expect(logs).toContain("config: grok-box-002 in sync");
  });
});
