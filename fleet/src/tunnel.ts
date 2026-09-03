// tunnel.ts — the reverse-tunnel client (D3, F6). Builds the EXACT ssh/scp argv
// the bash brain uses (fleetctl:1806/:3054) and probes the listener via `ss`.
//
// Argv order follows the blueprint D3 spec verbatim (T2 asserts it):
//   ssh -p <port> -i <key> -o BatchMode=yes <KNOWN_HOSTS_OPTS>
//       -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8
//       box@127.0.0.1 <remoteCommand>
// The remote command is appended VERBATIM as the LAST argv element (no `--`,
// F6/SHOULD-4); grokfleet performs no shell quoting anywhere.
//
// D11(a): the four KNOWN_HOSTS_OPTS sit immediately BEFORE
// StrictHostKeyChecking and point ssh at `$FLEET_STATE/known_hosts`, the file
// the engine owns. `knownHosts` is a REQUIRED parameter everywhere so no caller
// can silently fall back to /root/.ssh/known_hosts.

import type { Runner, RunResult } from "./runner.ts";
import { portFor } from "./boxes.ts";
import {
  KNOWN_HOSTS_OPTS,
  listenerOwner,
  ownerAccepted,
  ssArgv,
  SS_TIMEOUT_MS,
} from "./hostkey.ts";
import { log } from "./log.ts";

// D11(a): `ssArgv` lives in hostkey.ts (one parser for the listener probe and
// the ownership check) and is re-exported here, where its callers have always
// found it.
export { ssArgv };

export interface TunnelOpts {
  stdin?: string | Uint8Array;
  timeoutMs: number;
  /**
   * D11(a): the engine's OWN known_hosts file (knownHostsFile(env)). REQUIRED
   * and compile-enforced — a tunnel call that fell back to ssh's default would
   * read /root/.ssh/known_hosts, the file that caused the empirical r2 failure.
   */
  knownHosts: string;
}

/** scp's knobs (no stdin). */
export interface TunnelScpOpts {
  timeoutMs: number;
  /** D11(a), as TunnelOpts.knownHosts. */
  knownHosts: string;
}

/** Seams tunnelUp needs but must not own: tunnel.ts holds NO module state. */
export interface TunnelDeps {
  /** real uid; defaults to process.getuid (0 when unavailable ⇒ fail closed). */
  getuid?: () => number;
  /** log sink that may dedup within one tick; defaults to a plain log. */
  warnOnce?: (msg: string) => void;
}

/**
 * A per-tick `warnOnce` sink. Built by the CALLER (a tick, a command) so the
 * dedup lives for exactly that scope — tunnel.ts keeps no module-level state.
 */
export function makeWarnOnce(sink: (msg: string) => void = log): (msg: string) => void {
  const seen = new Set<string>();
  return (msg: string) => {
    if (seen.has(msg)) return;
    seen.add(msg);
    sink(msg);
  };
}

/** Build the ssh argv for a box + remote command (D3, F6, D11a). */
export function sshArgv(box: string, boxKey: string, remoteCommand: string, knownHosts: string): string[] {
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
    ...KNOWN_HOSTS_OPTS(knownHosts),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=8",
    "box@127.0.0.1",
    remoteCommand,
  ];
}

/** Build the scp argv for a box (D3 mirrors fleetctl:3054, D11a). */
export function scpArgv(box: string, boxKey: string, local: string, remote: string, knownHosts: string): string[] {
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
    ...KNOWN_HOSTS_OPTS(knownHosts),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=8",
    local,
    `box@127.0.0.1:${remote}`,
  ];
}

/**
 * tunnelUp(box): is 127.0.0.1:<port> a listener WE may talk to (D3 + D11c)?
 *
 * The probe used to answer "is anything listening". It now also answers "is the
 * thing listening an sshd", because every consumer that hands over a secret
 * (mint, config push, rollout) reads this as its permission to dial:
 *
 *   absent                       ⇒ down (as before);
 *   owned by an accepted sshd    ⇒ up;
 *   owned by anything else       ⇒ DOWN + a log line (a squatter is never dialled);
 *   owner unverifiable, non-root ⇒ up  (a non-root `grokfleet fleet-status` must not
 *                                       read every tunnel as down);
 *   owner unverifiable, as root  ⇒ DOWN + a log line — the exception is bound to
 *                                 its PREMISE, not to the symptom, so an ss
 *                                 output-format drift under root fails closed
 *                                 instead of reopening the squatter hole;
 *   ss rc != 0                   ⇒ down (today's behaviour).
 */
export async function tunnelUp(runner: Runner, box: string, deps: TunnelDeps = {}): Promise<boolean> {
  const port = portFor(box);
  if (port === undefined) return false;
  const r = await runner.run(ssArgv(), { timeoutMs: SS_TIMEOUT_MS });
  if (r.code !== 0) return false;
  const owner = listenerOwner(r, port);
  if (owner.state === "absent") return false;
  if (owner.state === "owned") {
    if (ownerAccepted(owner.comm)) return true;
    log(`tunnel: 127.0.0.1:${port} held by ${owner.comm}[${owner.pid}] — treating as down`);
    return false;
  }
  const uid = (deps.getuid ?? (() => process.getuid?.() ?? 0))();
  if (uid !== 0) {
    (deps.warnOnce ?? log)("tunnel: listener owner unverifiable (not root)");
    return true;
  }
  log(`tunnel: 127.0.0.1:${port} listener owner unverifiable as root — treating as down`);
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
  return runner.run(sshArgv(box, boxKey, remoteCommand, opts.knownHosts), {
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
  opts: TunnelScpOpts,
): Promise<RunResult> {
  return runner.run(scpArgv(box, boxKey, local, remote, opts.knownHosts), { timeoutMs: opts.timeoutMs });
}
