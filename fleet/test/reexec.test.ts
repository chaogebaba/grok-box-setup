// Gate-r1 fix 3 — the flock re-exec must INHERIT stdio (F2) so the locked
// child's output reaches the operator/journal. Two levels:
//  (a) unit: spawnReexec passes stdin/stdout/stderr:"inherit" + argv + env to
//      the injected spawner;
//  (b) REAL PROCESS: run a child through bunInheritSpawner and prove its stderr
//      actually reaches THIS process's stderr — captured by running the whole
//      thing inside an outer subprocess whose stderr we read.

import { test, expect, describe } from "bun:test";
import { spawnReexec, bunInheritSpawner, type ReexecOptions } from "../src/reexec.ts";

describe("spawnReexec (unit)", () => {
  test("passes inherited stdio + argv + env to the spawner", async () => {
    let seenArgv: string[] = [];
    let seenOpts: ReexecOptions | undefined;
    const res = await spawnReexec(
      ["flock", "-n", "-E", "6", "/lock", "/opt/grok-fleet/fleet2", "upgrade", "--apply"],
      { FLEET2_LOCKED: "1" },
      async (argv, opts) => {
        seenArgv = argv;
        seenOpts = opts;
        return { code: 0, launched: true };
      },
    );
    expect(res).toEqual({ code: 0, launched: true });
    expect(seenArgv[0]).toBe("flock");
    expect(seenOpts!.stdin).toBe("inherit");
    expect(seenOpts!.stdout).toBe("inherit");
    expect(seenOpts!.stderr).toBe("inherit");
    expect(seenOpts!.env["FLEET2_LOCKED"]).toBe("1");
  });

  test("bunInheritSpawner returns launched:false when the executable is missing", async () => {
    const res = await bunInheritSpawner(
      ["this-binary-does-not-exist-fleet2-xyz", "arg"],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: {} },
    );
    expect(res.launched).toBe(false);
    expect(res.code).toBeNull();
  });

  test("bunInheritSpawner surfaces the child's real exit code", async () => {
    const res = await bunInheritSpawner(
      ["sh", "-c", "exit 6"],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: {} },
    );
    expect(res.launched).toBe(true);
    expect(res.code).toBe(6);
  });
});

describe("spawnReexec (real process): child stderr reaches the parent", () => {
  test("a child writing to stderr under inherited stdio is visible to the parent", () => {
    // Outer subprocess: its stderr is PIPED so we can read it. Inside, it calls
    // bunInheritSpawner on a child that writes a marker to stderr — with inherit,
    // that marker flows to the outer process's stderr, which we then observe.
    const marker = "CANARY_ABORT_MARKER_9f3a";
    const inner = `
import { bunInheritSpawner } from "${import.meta.dir}/../src/reexec.ts";
const res = await bunInheritSpawner(
  ["sh", "-c", "echo ${marker} 1>&2; exit 1"],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: {} },
);
process.exit(res.code ?? 0);
`;
    const proc = Bun.spawnSync(["bun", "-e", inner], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const parentStderr = proc.stderr.toString();
    // fix 3: the child's stderr reached the (outer) parent's stderr, NOT swallowed.
    expect(parentStderr).toContain(marker);
    // and the child's rc propagated
    expect(proc.exitCode).toBe(1);
  });
});
