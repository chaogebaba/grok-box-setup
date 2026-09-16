// cli-list.test.ts — SHOULD-5 (gate r1): `grokfleet list` and a wrong-mode
// tui.toml. cli.ts's TuiConfigError catch has no fs-injection seam (it calls
// `resolveTuiConfig()` with the real `nodeConfigFs`), so this spawns the real
// CLI entrypoint the way lifecycle.test.ts does for cli.ts's other
// process-only behaviour.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
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

function scratchHome(mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), "grokfleet-cli-list-"));
  dirs.push(dir);
  const cfgDir = join(dir, ".config", "grok-fleet");
  mkdirSync(cfgDir, { recursive: true });
  const cfgFile = join(cfgDir, "tui.toml");
  writeFileSync(cfgFile, 'url = "http://127.0.0.1:1"\ntoken = "x"\n');
  chmodSync(cfgFile, mode);
  return dir;
}

describe("SHOULD-5 — list warns on a wrong-mode tui.toml, rc/column unchanged", () => {
  test("mode 644 ⇒ one stderr line, rc 0, table still prints", async () => {
    const home = scratchHome(0o644);
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const proc = Bun.spawn(["bun", "run", cli, "list"], {
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        GROKFLEET_ADMIN_URL: "",
        GROKFLEET_ADMIN_TOKEN: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("mode 644");
    expect(stderr).toContain("OBSERVED will show '-'");
    // list still ran — the table header printed, not an error page.
    expect(stdout).toContain("NAME");
    expect(stdout).toContain("OBSERVED");
  }, 20_000);
});
