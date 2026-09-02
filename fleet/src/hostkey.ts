// hostkey.ts — grokfleet owns its known_hosts (zero-touch join D11).
//
// The engine used to let ssh resolve `~/.ssh/known_hosts` from the passwd entry,
// so both units read /root/.ssh/known_hosts — a file grokfleet neither owns nor can
// reason about. When a port or a name is REUSED across identities (a retired
// record, a box that lost /workspace and so its persisted host keys), OpenSSH's
// `REMOTE HOST IDENTIFICATION HAS CHANGED` banner made every tunnel call rc 255
// forever: `StrictHostKeyChecking=accept-new` accepts an UNKNOWN key but refuses
// a CHANGED one. Empirical r2 minted a key, failed to seed it over the banner
// and revoked it again, every tick.
//
// D11's shape:
//   (a) one engine-owned file, `$FLEET_STATE/known_hosts`, on the two
//       fleet-driven argv builders only (the tunnel and the tailnet box ssh).
//       Interactive `grokfleet ssh` is UNCHANGED — a human on a laptop keeps their
//       own host verification.
//   (b) pins are forgotten ONLY at identity-binding moments (an enrol, a repair,
//       a candidate re-probe), never on a banner, and the tunnel spec's forget
//       is FAIL-CLOSED behind an ownership check on the listener.
//   (c) a banner is an OBSERVATION with one-tick memory that defers every write
//       over that box's tunnel — never a trigger.
//
// known_hosts is engine-local bookkeeping in the class of discover.json and the
// ReconcileState markers: NOT on the Acceptance-1 mutation surface, written on
// every tick including dry-run, and a forget never consumes a mutation slot.

import type { Runner, RunResult } from "./runner.ts";
import { log as defaultLog } from "./log.ts";

/** The `ss -tlnp` argv. `-p` only APPENDS a Process column to the same row, so
 *  the exact local-address token test and the owner parse share one call. */
export function ssArgv(): string[] {
  return ["ss", "-tlnp"];
}

/** Deadline for the listener probe. */
export const SS_TIMEOUT_MS = 5_000;

/** D11(a): the ONE known_hosts file the engine owns. */
export function knownHostsFile(env: { FLEET_STATE: string }): string {
  return `${env.FLEET_STATE}/known_hosts`;
}

/**
 * D11(a): the four options that make that file the ONLY one consulted, and its
 * entries readable and `-R`-removable.
 *
 *  - UserKnownHostsFile  — the engine's file instead of ~/.ssh/known_hosts.
 *  - GlobalKnownHostsFile=/dev/null — /etc/ssh/ssh_known_hosts is otherwise
 *    still consulted and is never touched by `ssh-keygen -R`.
 *  - HashKnownHosts=no   — hashed entries defeat `-F` and an operator's eyes.
 *  - CheckHostIP=no      — an IP-keyed entry would survive `-R <name>`.
 *
 * They are spliced immediately BEFORE StrictHostKeyChecking=accept-new.
 */
export function KNOWN_HOSTS_OPTS(file: string): string[] {
  return [
    "-o",
    `UserKnownHostsFile=${file}`,
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "HashKnownHosts=no",
    "-o",
    "CheckHostIP=no",
  ];
}

/**
 * D11(c): the banner, exactly. This covers the whole rotation class including a
 * key-TYPE change.
 *
 * The bare `Host key verification failed` text is NOT enough: under accept-new
 * an unknown key is ACCEPTED, so that text means an unwritable or unparsable
 * file, a revoked key, or a DNS-spoof warning — none of which a forget cures.
 */
export function isHostKeyMismatch(r: Pick<RunResult, "code" | "stderr">): boolean {
  return r.code === 255 && r.stderr.includes("REMOTE HOST IDENTIFICATION HAS CHANGED");
}

/** Who holds a local listener (D11(b)). */
export type ListenerOwner =
  | { state: "absent" }
  | { state: "owned"; comm: string; pid: number }
  | { state: "unknown" };

/**
 * The display forms OpenSSH uses for the process that owns a forwarded
 * listener. Production (OpenSSH 9.6p1) shows `sshd`; >= 9.8 creates forwarded
 * listeners from `sshd-session`. Any `sshd:`-prefixed comm is the "sshd: <user>"
 * display form of the same thing.
 */
export const ACCEPTED_OWNERS = ["sshd", "sshd-session"] as const;

/** Is this `comm` one of the accepted sshd display forms? */
export function ownerAccepted(comm: string): boolean {
  return (ACCEPTED_OWNERS as readonly string[]).includes(comm) || comm.startsWith("sshd:");
}

/**
 * Parse `ss -tlnp` for who owns 127.0.0.1:<port>.
 *
 *   absent  — no row carries the exact `127.0.0.1:<port>` local-address token;
 *   owned   — the row carries a `users:(("<comm>",pid=<n>,fd=…))` process column;
 *   unknown — the row exists with an EMPTY process column (the caller is not
 *             root, so ss cannot attribute it), or ss failed / is missing.
 *
 * `unknown` is deliberately distinct from `absent`: it means "the premise of the
 * ownership check is unavailable", which the two consumers answer differently.
 */
export function listenerOwner(ss: Pick<RunResult, "code" | "stdout">, port: number): ListenerOwner {
  if (ss.code !== 0) return { state: "unknown" };
  const needle = `127.0.0.1:${port}`;
  for (const line of ss.stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (!cols.includes(needle)) continue;
    // `users:(("sshd",pid=123,fd=7),("sshd",pid=124,fd=8))` — the FIRST holder
    // decides; a second fd on the same listener is the same process family.
    const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    if (m === null) return { state: "unknown" };
    return { state: "owned", comm: m[1]!, pid: Number.parseInt(m[2]!, 10) };
  }
  return { state: "absent" };
}

/** Whether the engine may write to its own known_hosts file. */
export type KnownHostsAccess = "ok" | "absent" | "unwritable";

/** Default access probe: the file must exist AND be writable by this process. */
export function fileAccess(path: string): KnownHostsAccess {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    if (!fs.existsSync(path)) return "absent";
    try {
      fs.accessSync(path, fs.constants.W_OK);
      return "ok";
    } catch {
      return "unwritable";
    }
  } catch {
    return "absent";
  }
}

export interface ForgetOpts {
  /** the engine's known_hosts file. */
  file: string;
  /** the tailnet name (`<box>` spec). */
  box: string;
  /** the tunnel port; required for scope "both". */
  port?: number;
  /**
   * "both"   — the tunnel spec `[127.0.0.1]:<port>` (behind the ownership
   *            check) AND the tailnet spec `<box>`;
   * "tailnet"— the tailnet spec only (the D11(c) candidate re-probe: an
   *            unenrolled box has no tunnel of ours to reason about).
   */
  scope?: "both" | "tailnet";
  /** why this binding moment happened — "enrol" | "repair" | "probe". */
  why: string;
  /** access probe seam (tests inject). */
  access?: (path: string) => KnownHostsAccess;
  /** log seam (tests inject). */
  log?: (msg: string) => void;
}

/**
 * D11(b): forget a box's pins at an identity-binding moment.
 *
 * FAIL-CLOSED on the tunnel spec. The port is a local one, so before dropping
 * its pin the engine checks WHO holds the listener: absent (nothing to be
 * fooled by yet) or an accepted sshd display form ⇒ forget; anything else, or an
 * unverifiable owner ⇒ KEEP the pin and log an ERROR. The cost of a wrong keep
 * is one more unhealthy tick; the cost of a wrong forget is re-pinning a
 * squatter and handing it the next secret. The enrol continues either way: its
 * artefacts are harmless, the tunnel stays refused and the existing unhealthy
 * paths report it.
 *
 * The tailnet spec is forgotten unconditionally — D2 already concedes tailnet
 * membership plus the password as the identity boundary there.
 *
 * Never fatal, never a history line, never a Telegram notice.
 */
export async function forgetHostKeys(runner: Runner, opts: ForgetOpts): Promise<void> {
  const say = opts.log ?? defaultLog;
  const access = (opts.access ?? fileAccess)(opts.file);
  if (access !== "ok") {
    // ssh creates the file 0600 root-owned because both units run as root, so a
    // hand-run `grokfleet enroll` as a non-root operator lands here.
    say(
      access === "absent"
        ? `hostkey: ${opts.file} absent — no pins to forget`
        : `hostkey: ${opts.file} not writable — pins not forgotten`,
    );
    return;
  }

  const scope = opts.scope ?? "both";
  if (scope === "both" && opts.port !== undefined) {
    const ss = await runner.run(ssArgv(), { timeoutMs: SS_TIMEOUT_MS });
    const owner = listenerOwner(ss, opts.port);
    const ok =
      owner.state === "absent" || (owner.state === "owned" && ownerAccepted(owner.comm));
    if (!ok) {
      const who =
        owner.state === "owned" ? `${owner.comm}[${owner.pid}]` : "unknown";
      say(
        `hostkey: ERROR 127.0.0.1:${opts.port} owner ${who} not accepted — pin kept, refusing to re-pin`,
      );
    } else {
      await runner.run(["ssh-keygen", "-R", `[127.0.0.1]:${opts.port}`, "-f", opts.file], {
        timeoutMs: SS_TIMEOUT_MS,
      });
    }
  }

  await runner.run(["ssh-keygen", "-R", opts.box, "-f", opts.file], { timeoutMs: SS_TIMEOUT_MS });
  say(`hostkey: forgot pins for ${opts.box} (${opts.why})`);
}
