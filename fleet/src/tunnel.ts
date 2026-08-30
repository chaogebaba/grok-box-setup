// tunnel.ts — the reverse-tunnel client (D3, F6). Builds the EXACT ssh/scp argv
// the bash brain uses (fleetctl:1806/:3054) and probes the listener via `ss`.
//
// Argv order follows the blueprint D3 spec verbatim (T2 asserts it):
//   ssh -p <port> -i <key> -o BatchMode=yes -o StrictHostKeyChecking=accept-new
//       -o ConnectTimeout=8 box@127.0.0.1 <remoteCommand>
// The remote command is appended VERBATIM as the LAST argv element (no `--`,
// F6/SHOULD-4); fleet2 performs no shell quoting anywhere.

import type { Runner, RunResult } from "./runner.ts";
import { portFor } from "./boxes.ts";

const SS_TIMEOUT_MS = 5_000;

export interface TunnelOpts {
  stdin?: string | Uint8Array;
  timeoutMs: number;
}

/** Build the ssh argv for a box + remote command (D3, F6). */
export function sshArgv(box: string, boxKey: string, remoteCommand: string): string[] {
  const port = portFor(box);
  if (port === undefined) throw new Error(`tunnel: cannot derive port for '${box}'`);
  return [
    "ssh",
    "-p",
    String(port),
    "-i",
    boxKey,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=8",
    "box@127.0.0.1",
    remoteCommand,
  ];
}

/** Build the scp argv for a box (D3 mirrors fleetctl:3054). */
export function scpArgv(box: string, boxKey: string, local: string, remote: string): string[] {
  const port = portFor(box);
  if (port === undefined) throw new Error(`tunnel: cannot derive port for '${box}'`);
  return [
    "scp",
    "-P",
    String(port),
    "-i",
    boxKey,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=8",
    local,
    `box@127.0.0.1:${remote}`,
  ];
}

/** Build the `ss -tln` argv (listener probe). */
export function ssArgv(): string[] {
  return ["ss", "-tln"];
}

/**
 * tunnelUp(box): true iff 127.0.0.1:<port> is LISTENING on the VPS (D3, ss -tln
 * contains the exact `127.0.0.1:<port>` at a word boundary — mirrors
 * fleetctl:1740 `grep -qE "127\.0\.0\.1:$port\$"` on the 4th column).
 */
export async function tunnelUp(runner: Runner, box: string): Promise<boolean> {
  const port = portFor(box);
  if (port === undefined) return false;
  const r = await runner.run(ssArgv(), { timeoutMs: SS_TIMEOUT_MS });
  if (r.code !== 0) return false;
  const needle = `127.0.0.1:${port}`;
  for (const line of r.stdout.split("\n")) {
    // The local-address column is field 4 in `ss -tln`; match the exact
    // host:port ending the field.
    const cols = line.trim().split(/\s+/);
    for (const c of cols) {
      if (c === needle) return true;
    }
  }
  return false;
}

/** Run a remote command over the tunnel (D3). */
export function tunnelSsh(
  runner: Runner,
  box: string,
  boxKey: string,
  remoteCommand: string,
  opts: TunnelOpts,
): Promise<RunResult> {
  return runner.run(sshArgv(box, boxKey, remoteCommand), {
    stdin: opts.stdin,
    timeoutMs: opts.timeoutMs,
  });
}

/** scp a local file to the box over the tunnel (D3). */
export function tunnelScp(
  runner: Runner,
  box: string,
  boxKey: string,
  local: string,
  remote: string,
  timeoutMs: number,
): Promise<RunResult> {
  return runner.run(scpArgv(box, boxKey, local, remote), { timeoutMs });
}
