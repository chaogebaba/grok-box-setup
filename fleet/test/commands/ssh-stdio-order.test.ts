// ssh-stdio-order.test.ts — agent-ux U1, gate-r1 finding 3.
//
// The gate saw `fleet2 ssh box 'for i in 1 2 3; do echo o$i; echo e$i 1>&2;
// done' 2>&1` print `o1 o2 o3 e1 e2 e3` and read it as fleet2 buffering the
// streams. It is not. The same probe run with PLAIN ssh and no fleet2 anywhere
// groups identically, and the same probe with ~300 ms between writes interleaves
// correctly through fleet2. The grouping is sshd packetising two separate pipes:
// writes that land in one read window arrive as one block per stream, and no
// client-side change can recover an order that was already lost on the far side.
//
// What IS fleet2's to guarantee is that it adds no buffering, no copying and no
// reordering of its own — that the child writes to fleet2's OWN file
// descriptors. That is what this file proves, end to end through the real CLI
// with a fake `sshpass` on PATH, so there is no ssh and no network in the way:
// whatever ordering the "remote" side produces is exactly what a caller sees.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bunExecSpawner } from "../../src/commands/ssh.ts";
import { suiteScratch } from "../store/helpers.ts";

const SCRATCH = suiteScratch("ssh-stdio-order");
afterAll(() => SCRATCH.clean());

const CLI = resolve(import.meta.dir, "..", "..", "src", "cli.ts");

/**
 * A directory holding a fake `sshpass` that drops the ssh wrapper and runs the
 * command locally. It refuses unless SSHPASS is in its environment, so this
 * exercises the F15 secret contract on the way through as well.
 */
function fakeSshpassDir(): string {
  const dir = SCRATCH.dir("fakebin");
  const p = `${dir}/sshpass`;
  writeFileSync(
    p,
    [
      "#!/bin/sh",
      'shift            # -e',
      'shift            # ssh',
      'while [ "$1" = "-o" ] || [ "$1" = "-t" ] || [ "$1" = "-tt" ]; do',
      '  if [ "$1" = "-o" ]; then shift 2; else shift; fi',
      "done",
      'shift            # box@host',
      '[ -n "$SSHPASS" ] || { echo "fake sshpass: SSHPASS not in env" >&2; exit 99; }',
      'exec /bin/sh -c "$1"',
      "",
    ].join("\n"),
  );
  chmodSync(p, 0o755);
  return dir;
}

/** Run the real CLI with both streams merged into ONE pipe, as a shell does. */
async function runCli(args: string[]): Promise<{ rc: number; merged: string }> {
  const dir = SCRATCH.dir("run");
  mkdirSync(dir, { recursive: true });
  const out = `${dir}/merged`;
  // `sh -c` with 2>&1 gives both fds the SAME open file description, so the
  // bytes land in true write order — the ordering question, isolated.
  const proc = Bun.spawn(
    ["/bin/sh", "-c", `exec "$0" "$@" > "${out}" 2>&1`, process.execPath, "run", CLI, "ssh", ...args],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, PATH: `${fakeSshpassDir()}:${process.env.PATH}`, FLEET_SSH_PASSWORD: "sekret" },
    },
  );
  const rc = (await proc.exited) ?? 1;
  return { rc, merged: await Bun.file(out).text() };
}

describe("U1 fleet2 adds no buffering and no reordering of its own", () => {
  test("interleaved writes come out in WRITE order, not grouped by stream", async () => {
    // Spaced so the two streams cannot collapse into one read window even if
    // something downstream batched: if fleet2 buffered a stream, this fails.
    const remote = "for i in 1 2 3; do echo o$i; sleep 0.2; echo e$i 1>&2; sleep 0.2; done";
    const { rc, merged } = await runCli(["grok-box-001", remote]);
    expect(rc).toBe(0);
    expect(merged.trim().split("\n").map((l) => l.trim())).toEqual(["o1", "e1", "o2", "e2", "o3", "e3"]);
  }, 20_000);

  test("a large stdout burst arrives whole and in order (nothing is truncated or held)", async () => {
    const { rc, merged } = await runCli(["grok-box-001", "seq 1 5000"]);
    expect(rc).toBe(0);
    const lines = merged.trim().split("\n");
    expect(lines.length).toBe(5000);
    expect(lines[0]).toBe("1");
    expect(lines[4999]).toBe("5000");
  }, 20_000);

  test("output written before a non-zero exit is NOT lost, and the rc is the remote one", async () => {
    // The bug U1 fixed: the Runner captured this and threw it away.
    const { rc, merged } = await runCli(["grok-box-001", "echo out; echo err 1>&2; exit 3"]);
    expect(rc).toBe(3);
    expect(merged).toContain("out");
    expect(merged).toContain("err");
  }, 20_000);

  test("the production exec spawner INHERITS both output streams (never pipes them)", () => {
    // The unit-level guard behind the three end-to-end cases above: a switch to
    // "pipe" would reintroduce exactly the buffering U1 removed.
    const src = Bun.file(resolve(import.meta.dir, "..", "..", "src", "commands", "ssh.ts"));
    const text = require("node:fs").readFileSync(src.name!, "utf8") as string;
    const body = text.slice(text.indexOf("export const bunExecSpawner"));
    const decl = body.slice(0, body.indexOf("\n};"));
    expect(decl).toContain('stdout: "inherit"');
    expect(decl).toContain('stderr: "inherit"');
    expect(decl).not.toContain('stdout: "pipe"');
    expect(decl).not.toContain('stderr: "pipe"');
    expect(typeof bunExecSpawner.spawn).toBe("function");
  });
});
