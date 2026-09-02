// lifecycle.test.ts — the r1-gate blocker regression test.
//
// The bug: `grokfleet serve` logged "listening" then EXITED immediately, because
// cli.ts does `process.exit(rc)` after main() resolves and cmdServe used to
// resolve right after Bun.serve — so the socket died with the process and curl
// got connection refused on the VPS. An in-process handler test CANNOT catch
// this class (it never exercises the real CLI entrypoint + Bun.serve + the
// event loop). So this test SPAWNS the real binary: it must still be alive and
// answering /v1/health after ~2s, and a SIGTERM must produce a CLEAN exit 0.
//
// Uses the COMPILED binary (dist/grokfleet) when present AND current, else falls
// back to `bun run src/cli.ts` (same code path through main() → process.exit).
// `dist/` is gitignored and nothing rebuilds it on checkout, so any dev who ran
// `make ts-build` at an older release keeps a binary that answers /v1/health
// with the OLD version and fails the SERVE_VERSION assertion below. The binary
// is therefore used only when `dist/grokfleet version` reports SERVE_VERSION;
// GROKFLEET_TEST_BIN overrides the whole choice for a caller that knows better.

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { SERVE_VERSION } from "../../src/serve/handlers.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** `grokfleet version` prints `grokfleet <ver> (<sha>) (bun <v>)`; pull out <ver>.
 *  Returns undefined when the binary will not run or prints something else. */
export function binaryVersion(bin: string): string | undefined {
  try {
    const r = Bun.spawnSync([bin, "version"], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return undefined;
    const m = /^grokfleet (\S+)/.exec(new TextDecoder().decode(r.stdout).trim());
    return m?.[1];
  } catch {
    return undefined;
  }
}

/** The bun-from-source launch, used whenever the compiled binary is not usable. */
function sourceCommand(): string[] {
  const entry = join(import.meta.dir, "..", "..", "src", "cli.ts");
  return [process.execPath, "run", entry, "serve"];
}

/**
 * Resolve how to launch `grokfleet serve`. The compiled binary is preferred, but
 * ONLY when it reports SERVE_VERSION — a stale `dist/grokfleet` left over from an
 * older release would answer /v1/health with its own version and fail the test
 * for a reason that has nothing to do with the lifecycle bug under test.
 * `forced` (GROKFLEET_TEST_BIN) skips the check entirely.
 */
export function resolveServeCommand(compiled: string, forced?: string): string[] {
  if (forced !== undefined && forced !== "") {
    console.log(`lifecycle: GROKFLEET_TEST_BIN forces ${forced}`);
    return [forced, "serve"];
  }
  if (existsSync(compiled)) {
    const v = binaryVersion(compiled);
    if (v === SERVE_VERSION) {
      console.log(`lifecycle: using compiled ${compiled} (${v})`);
      return [compiled, "serve"];
    }
    console.log(
      `lifecycle: ignoring STALE ${compiled} (reports ${v ?? "no version"}, need ${SERVE_VERSION}) — running from source`,
    );
  }
  console.log("lifecycle: running grokfleet serve from source via bun");
  return sourceCommand();
}

function serveCommand(): string[] {
  return resolveServeCommand(join(import.meta.dir, "..", "..", "dist", "grokfleet"), process.env.GROKFLEET_TEST_BIN);
}

/** Poll GET /v1/health until it answers or the deadline passes. */
async function waitHealthy(port: number, deadlineMs: number): Promise<Response | undefined> {
  while (Date.now() < deadlineMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return r;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return undefined;
}

function scratchEnv(): { dir: string; etc: string; state: string } {
  const dir = mkdtempSync(join(tmpdir(), "grokfleet-serve-life-"));
  dirs.push(dir);
  const etc = join(dir, "etc");
  const state = join(dir, "state");
  require("node:fs").mkdirSync(etc, { recursive: true });
  require("node:fs").mkdirSync(state, { recursive: true });
  const tokenFile = join(etc, "serve-tokens.toml");
  writeFileSync(
    tokenFile,
    `[tokens.admin-one]\ntoken = "ADMINSECRET"\nscope = "admin"\n[tokens.read-one]\ntoken = "READSECRET"\nscope = "readonly"\n`,
  );
  chmodSync(tokenFile, 0o600);
  return { dir, etc, state };
}

describe("serve process lifecycle (r1 gate regression)", () => {
  test(
    "the REAL binary stays alive answering /v1/health, and SIGTERM ⇒ clean exit 0",
    async () => {
      const { etc, state } = scratchEnv();
      const port = 19700 + Math.floor(Math.random() * 500);
      const [cmd, ...args] = serveCommand();
      const proc = Bun.spawn([cmd!, ...args, "--bind", "127.0.0.1", "--port", String(port)], {
        env: {
          ...process.env,
          FLEET_ETC: etc,
          FLEET_STATE: state,
          // serve is VPS-only-gated by a box key existing; point it at a file
          // that exists so the locality guard (in cli.ts) passes for the test.
          FLEET_BOX_KEY: "/etc/hostname",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        // 1) it must be alive + answering /v1/health within ~4s (the bug made it
        //    exit at ~0s, so a 2s liveness window is the discriminator).
        const health = await waitHealthy(port, Date.now() + 4000);
        expect(health).toBeDefined();
        const body = (await health!.json()) as { ok: boolean; version: string };
        expect(body.ok).toBe(true);
        expect(body.version).toBe(SERVE_VERSION);

        // 2) it is STILL alive after a further ~1.5s (proves it did not exit
        //    right after logging "listening").
        await new Promise((r) => setTimeout(r, 1500));
        const again = await fetch(`http://127.0.0.1:${port}/v1/health`, { signal: AbortSignal.timeout(1000) });
        expect(again.ok).toBe(true);

        // 3) SIGTERM ⇒ graceful stop, clean exit 0.
        proc.kill("SIGTERM");
        const rc = await proc.exited;
        expect(rc).toBe(0);
      } finally {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }
    },
    15_000,
  );

  test(
    "401 without a token proves the listener is REALLY serving the API (not a stub)",
    async () => {
      const { etc, state } = scratchEnv();
      const port = 19200 + Math.floor(Math.random() * 400);
      const [cmd, ...args] = serveCommand();
      const proc = Bun.spawn([cmd!, ...args, "--bind", "127.0.0.1", "--port", String(port)], {
        env: { ...process.env, FLEET_ETC: etc, FLEET_STATE: state, FLEET_BOX_KEY: "/etc/hostname" },
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const health = await waitHealthy(port, Date.now() + 4000);
        expect(health).toBeDefined();
        // /v1/fleet requires auth ⇒ 401 without a bearer token.
        const noauth = await fetch(`http://127.0.0.1:${port}/v1/fleet`, { signal: AbortSignal.timeout(1000) });
        expect(noauth.status).toBe(401);
        // a valid admin token ⇒ 200.
        const ok = await fetch(`http://127.0.0.1:${port}/v1/fleet`, {
          headers: { Authorization: "Bearer ADMINSECRET" },
          signal: AbortSignal.timeout(1000),
        });
        expect(ok.status).toBe(200);
        proc.kill("SIGTERM");
        expect(await proc.exited).toBe(0);
      } finally {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    },
    15_000,
  );
});


describe("cmdServe graceful-shutdown seam (in-process unit)", () => {
  test("cmdServe stays PENDING until shutdown fires, then stops the server + rc 0", async () => {
    const { cmdServe } = await import("../../src/serve/server.ts");
    const { setLogSink } = await import("../../src/log.ts");
    const { resolveEnv } = await import("../../src/env.ts");
    const { loadConfig } = await import("../../src/config.ts");
    const restore = setLogSink(() => {});
    // A real scratch FLEET_ETC with a 600 token file so buildContext succeeds.
    const { etc, state } = scratchEnv();
    try {
      const env = resolveEnv({ FLEET_ETC: etc, FLEET_STATE: state, FLEET_BOX_KEY: "/etc/hostname" });
      const cfg = await loadConfig("/nonexistent-config.toml");
      let stopped = false;
      let resolveShutdown!: () => void;
      const shutdown = { done: new Promise<void>((r) => (resolveShutdown = r)), unregister: () => {} };
      const p = cmdServe(["--bind", "127.0.0.1", "--port", "1"], {
        env,
        cfg,
        serve: () => ({ stop: () => { stopped = true; } }),
        onShutdown: () => shutdown,
      });
      // It must NOT resolve while the server is "running".
      const raced = await Promise.race([
        p.then(() => "resolved"),
        new Promise((r) => setTimeout(() => r("pending"), 100)),
      ]);
      expect(raced).toBe("pending");
      expect(stopped).toBe(false);
      // Fire shutdown ⇒ server.stop() is called and rc 0 is returned.
      resolveShutdown();
      const rc = await p;
      expect(rc).toBe(0);
      expect(stopped).toBe(true);
    } finally {
      setLogSink(restore);
    }
  });
});

describe("serve launcher picks a CURRENT binary or falls back to source", () => {
  /** A stand-in `grokfleet` whose `version` output the test controls. */
  function fakeBinary(line: string): string {
    const dir = mkdtempSync(join(tmpdir(), "grokfleet-fakebin-"));
    dirs.push(dir);
    const bin = join(dir, "grokfleet");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(line)}\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  const fromSource = (cmd: string[]): boolean => cmd[0] === process.execPath && cmd[1] === "run";

  test("a STALE binary is ignored and the launcher runs from source", () => {
    const stale = fakeBinary("grokfleet 0.0.1 (deadbee) (bun 1.0.0)");
    expect(binaryVersion(stale)).toBe("0.0.1");
    const cmd = resolveServeCommand(stale);
    expect(fromSource(cmd)).toBe(true);
    expect(cmd).not.toContain(stale);
    expect(cmd[cmd.length - 1]).toBe("serve");
  });

  test("a CURRENT binary is used", () => {
    const current = fakeBinary(`grokfleet ${SERVE_VERSION} (abc1234) (bun 1.4.0)`);
    expect(resolveServeCommand(current)).toEqual([current, "serve"]);
  });

  test("a binary that does not run, or prints nothing usable, falls back to source", () => {
    const mute = fakeBinary("");
    expect(binaryVersion(mute)).toBeUndefined();
    expect(fromSource(resolveServeCommand(mute))).toBe(true);
    // and a path that does not exist at all
    expect(fromSource(resolveServeCommand(join(tmpdir(), "definitely-not-here", "grokfleet")))).toBe(true);
  });

  test("GROKFLEET_TEST_BIN wins over the staleness check", () => {
    const stale = fakeBinary("grokfleet 0.0.1 (deadbee) (bun 1.0.0)");
    expect(resolveServeCommand(stale, stale)).toEqual([stale, "serve"]);
  });
});
