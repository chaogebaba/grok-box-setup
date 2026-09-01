// box-transport.ts — the ONE tailnet `sshpass -e ssh box@<box>` helper (D2).
//
// enroll and discover both talk to a box over the TAILNET (not the reverse
// tunnel — enroll runs before the tunnel is trusted, and discover runs before
// the box is enrolled at all). This module holds that transport once so the two
// callers cannot drift apart.
//
// F15/M11 SECRET CONTRACT is preserved: the password reaches sshpass ONLY
// through the spawned child's env (SSHPASS) — never process.env of the parent,
// never argv, never a log line.
//
// D2 knob: `connectTimeoutS` prepends an explicit `-o ConnectTimeout=<n>` for
// discover-initiated calls. It is spliced BEFORE the shared SSH_OPTS because
// ssh takes the FIRST value it obtains for an option; SSH_OPTS (ConnectTimeout
// 6, also used by `fleet2 ssh`) is NOT changed.

import type { Runner } from "../runner.ts";
import { sshCmdArgv } from "./ssh.ts";
import { KNOWN_HOSTS_OPTS } from "../hostkey.ts";

/** Default fleet2 deadline for a box ssh call (enroll's SSH_TIMEOUT_MS). */
export const BOX_SSH_TIMEOUT_MS = 20_000;

export interface BoxSshOpts {
  /** the ssh password; goes to the child env only. */
  password: string;
  /** explicit -o ConnectTimeout=<n> (discover only). */
  connectTimeoutS?: number;
  /** fleet2's own deadline (default BOX_SSH_TIMEOUT_MS). */
  timeoutMs?: number;
  /** bytes for the remote command's stdin. */
  stdin?: string;
  /**
   * D11(a): the engine's own known_hosts file (knownHostsFile(env)). REQUIRED —
   * this is the tailnet path used by enroll, the discover probes and the repair
   * inspect, i.e. every fleet-driven `<box>` contact. The interactive
   * `fleet2 ssh` does NOT come through here and keeps ssh's defaults.
   */
  knownHosts: string;
}

export interface BoxSshResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run one command on a box over the tailnet. */
export async function boxSsh(
  runner: Runner,
  box: string,
  remoteCommand: string,
  opts: BoxSshOpts,
): Promise<BoxSshResult> {
  // Both go through `extraOpts`, which is spliced BEFORE SSH_OPTS — ssh takes
  // the FIRST value it obtains for an option, so this ordering is what lets the
  // known-hosts options and the discover connect timeout win without changing
  // SSH_OPTS (which `fleet2 ssh` shares).
  const extra = [
    ...KNOWN_HOSTS_OPTS(opts.knownHosts),
    ...(opts.connectTimeoutS === undefined ? [] : ["-o", `ConnectTimeout=${opts.connectTimeoutS}`]),
  ];
  const r = await runner.run(sshCmdArgv(box, remoteCommand, extra), {
    timeoutMs: opts.timeoutMs ?? BOX_SSH_TIMEOUT_MS,
    env: { SSHPASS: opts.password },
    stdin: opts.stdin,
  });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}
