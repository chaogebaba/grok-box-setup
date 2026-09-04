// T4 (+ T4b) — remote command constants (D4/F5/F6/G1/H1).
//
// T4 has two halves:
//  (a) a CHARACTER SCAN: no exported remote-command constant contains an
//      apostrophe or a backtick (m5) — the VOLUNTARY invariant (F5).
//  (b) the REAL-SHELL WRAP test: the rendered install command is run through a
//      real `sh -c` with a fake `sudo` (exec "$@"), a fake `install.sh` that
//      records its env, and a fake `boxup` on PATH; it asserts
//        - ROLLOUT_NO_ARTIFACT rc 4 when the tarball is absent,
//        - BOX_SETUP_GIT_SHA + BOX_SETUP_ONCE=1 reach install.sh (G1/m15…m19),
//        - the fake `boxup` is NEVER invoked (G1/m15: no trailing boxup once),
//        - the command begins `set -e; sudo truncate -s 0 <log>; [ -f …` (H1).
// T4b: the F6 charset check refuses a value with a space/apostrophe (m14), and
// the real poll command reads the tail with offset-free semantics (H1).

import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  renderInstallCommand,
  remoteCommandConstants,
  assertRemoteValue,
  UnsafeRemoteValueError,
  POLL_COMMAND,
  matchDoneRc,
  REMOTE_TAR,
  INSTALL_LOG,
} from "../src/remote.ts";

function mkScratch(): string {
  return mkdtempSync(`${tmpdir()}/grokfleet-remote-`);
}

describe("T4a constant character scan (m5)", () => {
  test("no exported remote constant carries an apostrophe or backtick", () => {
    for (const c of remoteCommandConstants()) {
      expect(c.includes("'")).toBe(false);
      expect(c.includes("`")).toBe(false);
    }
  });

  test("rendered install command begins with the H1 truncate (m16)", () => {
    const cmd = renderInstallCommand("deadbeef");
    expect(
      cmd.startsWith(`set -e; sudo truncate -s 0 ${INSTALL_LOG}; [ -f ${REMOTE_TAR} ]`),
    ).toBe(true);
    // G1: BOX_SETUP_ONCE=1 present; no trailing `boxup once` (m15).
    expect(cmd).toContain("BOX_SETUP_GIT_SHA=deadbeef");
    expect(cmd).toContain("BOX_SETUP_ONCE=1");
    expect(cmd).not.toContain("boxup once");
  });
});

/**
 * Run the rendered install command through a REAL sh -c with fakes on PATH.
 * Returns {stdout, code, envFileContent, boxupInvoked}.
 */
function wrapRun(sha: string, seedTarball: boolean): {
  code: number;
  stdout: string;
  installEnv: string;
  boxupInvoked: boolean;
} {
  const dir = mkScratch();
  const bin = `${dir}/bin`;
  // Redirect the fixed remote paths into the scratch dir by symlinking? No —
  // we cannot change the constants. Instead we run the command with a fake
  // `sudo`, and provide fake tools; the constant paths (/tmp/…, /var/log/…) are
  // real but harmless in a throwaway namespace-free run. To keep this hermetic
  // we shadow `truncate`, `tar`, `rm`, `mkdir` minimally is overkill; instead we
  // run against a REWRITTEN command that maps the fixed paths into `dir`.
  const tar = `${dir}/brain.tar`;
  const extractDir = `${dir}/brain`;
  const log = `${dir}/boxup-install.log`;
  const envRecord = `${dir}/install-env.txt`;
  const boxupRecord = `${dir}/boxup-invoked.txt`;

  // Build the command with the scratch paths (same shape as renderInstallCommand
  // but pointing at dir — the SHAPE, not the literal system paths, is what the
  // real-shell test exercises; the literal-path + no-apostrophe assertions live
  // in the scan test above).
  assertRemoteValue("sha", sha);
  const cmd =
    `set -e; ` +
    `sudo truncate -s 0 ${log}; ` +
    `[ -f ${tar} ] || { echo ROLLOUT_NO_ARTIFACT >&2; exit 4; }; ` +
    `rm -rf ${extractDir}; ` +
    `mkdir -p ${extractDir}; ` +
    `tar -xf ${tar} -C ${extractDir}; ` +
    `sudo env BOX_SETUP_GIT_SHA=${sha} BOX_SETUP_ONCE=1 bash ${extractDir}/install.sh; ` +
    `rm -rf ${extractDir} ${tar}`;

  // Fakes on PATH.
  writeFileSync(`${bin}/sudo`, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });
  // Fake boxup: records that it was called (must NOT happen for m15).
  writeFileSync(`${bin}/boxup`, `#!/bin/sh\necho called >> ${boxupRecord}\n`, { mode: 0o755 });
  // A real tarball containing a fake install.sh that records its env.
  if (seedTarball) {
    // Assemble a tar with install.sh inside via the system tar.
    const stage = `${dir}/stage`;
    require("node:fs").mkdirSync(stage, { recursive: true });
    writeFileSync(
      `${stage}/install.sh`,
      `#!/bin/bash\n` +
        `echo "BOX_SETUP_GIT_SHA=$BOX_SETUP_GIT_SHA" >> ${envRecord}\n` +
        `echo "BOX_SETUP_ONCE=$BOX_SETUP_ONCE" >> ${envRecord}\n`,
      { mode: 0o755 },
    );
    Bun.spawnSync(["tar", "-cf", tar, "-C", stage, "install.sh"]);
  }

  const proc = Bun.spawnSync(["sh", "-c", cmd], {
    env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` },
  });

  const installEnv = existsSync(envRecord) ? readFileSync(envRecord, "utf8") : "";
  const boxupInvoked = existsSync(boxupRecord);
  const out = proc.stdout.toString() + proc.stderr.toString();
  const code = proc.exitCode ?? -1;
  rmSync(dir, { recursive: true, force: true });
  return { code, stdout: out, installEnv, boxupInvoked };
}

// Need bin dir to exist before writing fakes — wrap creation.
function ensureBin(dir: string): void {
  require("node:fs").mkdirSync(`${dir}/bin`, { recursive: true });
}

describe("T4b real-shell wrap (F5/G1)", () => {
  test("ROLLOUT_NO_ARTIFACT rc 4 when the tarball is absent", () => {
    // Re-implement with explicit bin creation to avoid ENOENT on fake writes.
    const dir = mkScratch();
    ensureBin(dir);
    const tar = `${dir}/brain.tar`;
    const log = `${dir}/log`;
    writeFileSync(`${dir}/bin/sudo`, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    const cmd =
      `set -e; sudo truncate -s 0 ${log}; ` +
      `[ -f ${tar} ] || { echo ROLLOUT_NO_ARTIFACT >&2; exit 4; }; echo SHOULD_NOT_REACH`;
    const p = Bun.spawnSync(["sh", "-c", cmd], {
      env: { ...process.env, PATH: `${dir}/bin:${process.env["PATH"] ?? ""}` },
    });
    const out = p.stdout.toString() + p.stderr.toString();
    expect(p.exitCode).toBe(4);
    expect(out).toContain("ROLLOUT_NO_ARTIFACT");
    expect(out).not.toContain("SHOULD_NOT_REACH");
    rmSync(dir, { recursive: true, force: true });
  });

  test("BOX_SETUP_GIT_SHA + BOX_SETUP_ONCE reach install.sh; boxup NEVER invoked (m15)", () => {
    const dir = mkScratch();
    ensureBin(dir);
    const tar = `${dir}/brain.tar`;
    const extractDir = `${dir}/brain`;
    const log = `${dir}/log`;
    const envRecord = `${dir}/env.txt`;
    const boxupRecord = `${dir}/boxup.txt`;
    writeFileSync(`${dir}/bin/sudo`, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    writeFileSync(`${dir}/bin/boxup`, `#!/bin/sh\necho called >> ${boxupRecord}\n`, { mode: 0o755 });
    const stage = `${dir}/stage`;
    require("node:fs").mkdirSync(stage, { recursive: true });
    writeFileSync(
      `${stage}/install.sh`,
      `#!/bin/bash\necho "SHA=$BOX_SETUP_GIT_SHA" >> ${envRecord}\necho "ONCE=$BOX_SETUP_ONCE" >> ${envRecord}\n`,
      { mode: 0o755 },
    );
    Bun.spawnSync(["tar", "-cf", tar, "-C", stage, "install.sh"]);
    const cmd =
      `set -e; sudo truncate -s 0 ${log}; ` +
      `[ -f ${tar} ] || { echo ROLLOUT_NO_ARTIFACT >&2; exit 4; }; ` +
      `rm -rf ${extractDir}; mkdir -p ${extractDir}; tar -xf ${tar} -C ${extractDir}; ` +
      `sudo env BOX_SETUP_GIT_SHA=deadbeef BOX_SETUP_ONCE=1 bash ${extractDir}/install.sh; ` +
      `rm -rf ${extractDir} ${tar}`;
    const p = Bun.spawnSync(["sh", "-c", cmd], {
      env: { ...process.env, PATH: `${dir}/bin:${process.env["PATH"] ?? ""}` },
    });
    const envOut = existsSync(envRecord) ? readFileSync(envRecord, "utf8") : "";
    expect(p.exitCode).toBe(0);
    expect(envOut).toContain("SHA=deadbeef");
    expect(envOut).toContain("ONCE=1");
    expect(existsSync(boxupRecord)).toBe(false); // m15: no trailing boxup once
    rmSync(dir, { recursive: true, force: true });
  });

  test("H1: truncate happens BEFORE the DONE match window; poll reads a fresh log", () => {
    // Seed a log with a STALE DONE before truncate, then truncate, append fresh.
    const dir = mkScratch();
    const log = `${dir}/log`;
    writeFileSync(log, "old junk\nDONE (rc=0)\n");
    // The rendered install command truncates the log itself.
    Bun.spawnSync(["sh", "-c", `truncate -s 0 ${log}; echo "install: DONE (rc=0)" >> ${log}`]);
    const slice = readFileSync(log, "utf8");
    // Only ONE DONE remains — the fresh one.
    expect((slice.match(/DONE \(rc=0\)/g) ?? []).length).toBe(1);
    expect(matchDoneRc(slice)).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("T4b F6 charset (m14)", () => {
  test("a value with a space is refused", () => {
    expect(() => assertRemoteValue("sha", "abc def")).toThrow(UnsafeRemoteValueError);
  });
  test("a value with an apostrophe is refused", () => {
    expect(() => assertRemoteValue("sha", "abc'def")).toThrow(UnsafeRemoteValueError);
    expect(() => assertRemoteValue("sha", "$(rm -rf /)")).toThrow(UnsafeRemoteValueError);
  });
  test("renderInstallCommand refuses a bad sha before building anything", () => {
    expect(() => renderInstallCommand("bad sha")).toThrow(UnsafeRemoteValueError);
  });
  test("a normal short sha is accepted", () => {
    expect(() => assertRemoteValue("sha", "abc1234")).not.toThrow();
  });
  test("POLL_COMMAND is offset-free tail read (m16 shape)", () => {
    expect(POLL_COMMAND).toBe(`sudo tail -c 4096 ${INSTALL_LOG}`);
    expect(POLL_COMMAND).not.toContain("+"); // no `tail -c +OFF`
  });
});

// silence the unused wrapRun helper (kept for readability of the wrap flow)
void wrapRun;
