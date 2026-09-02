// T13 BUG-B (child process, G5/T1) + T14b (token never leaks) — these SPAWN the
// CLI so the flock re-exec's inherited stdio (F3) is exercised for real.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const CLI = `${import.meta.dir}/../src/cli.ts`;

function runCli(env: Record<string, string>): { stderr: string; stdout: string; code: number } {
  const proc = Bun.spawnSync(["bun", "run", CLI, "reconcile", "--dry-run"], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { stderr: proc.stderr.toString(), stdout: proc.stdout.toString(), code: proc.exitCode ?? -1 };
}

describe("T13 BUG-B: locked child's stderr reaches the parent (F3 inherit)", () => {
  test("reconcile --dry-run: stderr has lines and 'reconcile: start' is present", () => {
    const dir = mkdtempSync(`${tmpdir()}/grokfleet-bugb-`);
    const state = `${dir}/state`;
    const etc = `${dir}/etc`;
    const key = `${etc}/box_access_ed25519`;
    const token = `${etc}/api-token`;
    Bun.spawnSync(["mkdir", "-p", state, etc]);
    writeFileSync(key, "");
    writeFileSync(token, "FAKE-PAT-DO-NOT-LEAK"); // present so the API is attempted
    writeFileSync(`${state}/enrolled.tsv`, "grok-box-008\t20008\n");
    const { stderr, code } = runCli({
      FLEET_STATE: state,
      FLEET_ETC: etc,
      FLEET_BOX_KEY: key,
      FLEET_API_TOKEN_FILE: token,
      // API pointed at an unreachable local port ⇒ transport failure (code 0)
      FLEET_TS_API: "http://127.0.0.1:9",
    });
    // the locked child ran the tick and its stderr reached us (F3)
    expect(stderr.split("\n").filter((l) => l.trim() !== "").length).toBeGreaterThan(0);
    expect(stderr).toContain("reconcile: start (DRY-RUN)");
    expect(stderr).toContain("reconcile: done (DRY-RUN)");
    // dry-run reconcile is rc 0
    expect(code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("T14b: the API token bytes never appear in the child's stderr", () => {
    const dir = mkdtempSync(`${tmpdir()}/grokfleet-t14b-`);
    const state = `${dir}/state`;
    const etc = `${dir}/etc`;
    Bun.spawnSync(["mkdir", "-p", state, etc]);
    writeFileSync(`${etc}/box_access_ed25519`, "");
    writeFileSync(`${etc}/api-token`, "SECRET-TOKEN-XYZ-9f3a");
    writeFileSync(`${state}/enrolled.tsv`, "grok-box-008\t20008\n");
    const { stderr } = runCli({
      FLEET_STATE: state,
      FLEET_ETC: etc,
      FLEET_BOX_KEY: `${etc}/box_access_ed25519`,
      FLEET_API_TOKEN_FILE: `${etc}/api-token`,
      FLEET_TS_API: "http://127.0.0.1:9", // unreachable ⇒ forced transport failure
    });
    expect(stderr.includes("SECRET-TOKEN-XYZ-9f3a")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
