// T6 (srs authoritative) — run SEED_REMOTE_SCRIPT through a REAL `sh -c` with a
// fake env (like phase-1 T4's wrap test): on a matching sha it installs the key
// to SEED_DST and writes SEED_EXP to SEED_EXP_FILE; on a mismatch it exits 3
// with SEED_SHA_MISMATCH and installs nothing.

import { test, expect, describe } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SEED_REMOTE_SCRIPT, keySha256 } from "../src/reconcile/seed-remote.ts";

function runSeed(key: string, sha: string): { code: number; dst: string; expFile: string; dir: string } {
  const dir = mkdtempSync(`${tmpdir()}/grokfleet-seed-`);
  const tmp = `${dir}/.ts-authkey.tmp`;
  const dst = `${dir}/ts-authkey`;
  const expFile = `${dir}/ts-authkey.expires`;
  const proc = Bun.spawnSync(["sh", "-c", SEED_REMOTE_SCRIPT], {
    stdin: Buffer.from(`${key}\n`),
    env: {
      ...process.env,
      SEED_TMP: tmp,
      SEED_DST: dst,
      SEED_EXP_FILE: expFile,
      SEED_EXP: "2026-11-27",
      SEED_SHA: sha,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode ?? -1, dst, expFile, dir };
}

describe("T6 seed remote script (REAL sh -c wrap)", () => {
  test("matching sha ⇒ installs key + expires, rc 0", async () => {
    const key = "tskey-REALSEED";
    const sha = await keySha256(key);
    const r = runSeed(key, sha);
    expect(r.code).toBe(0);
    expect(readFileSync(r.dst, "utf8")).toBe(`${key}\n`);
    expect(readFileSync(r.expFile, "utf8")).toBe("2026-11-27\n");
    rmSync(r.dir, { recursive: true, force: true });
  });

  test("sha mismatch ⇒ exit 3, SEED_SHA_MISMATCH, nothing installed", () => {
    const r = runSeed("tskey-REALSEED", "deadbeef");
    expect(r.code).toBe(3);
    expect(existsSync(r.dst)).toBe(false);
    rmSync(r.dir, { recursive: true, force: true });
  });
});
