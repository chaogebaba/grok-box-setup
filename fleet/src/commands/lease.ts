// lease.ts — `grokfleet lease <sub>` (blueprint fleet2-lease-api L4), the
// AGENT-FIRST face of the lease API.
//
// Every subcommand goes through the SAME typed `ApiClient` the TUI uses (r5-B1)
// and resolves its base/token through `tui/config.ts` — `$XDG_CONFIG_HOME/
// grok-fleet/tui.toml` (mode 600) with the `GROKFLEET_ADMIN_URL` /
// `GROKFLEET_ADMIN_TOKEN` overrides. NOTHING new is added and no `FLEET_*` name
// is introduced (r6-n1: that prefix is reserved for the Tailscale credentials).
// The CLI never reads the store, even on the VPS, so ONE code path serves both
// machines.
//
// EXIT CODES, the part a machine caller keys on (r5-B2):
//
//   * `lease run` passes the REMOTE command's rc through, any value 0–254,
//     whenever a command RAN;
//   * when NO command ran — no eligible box, the acquire was refused, the API
//     was unreachable at acquire — it exits 255. That is the one code a remote
//     command can never produce, which is why "no capacity" and "build failed"
//     are finally distinguishable (rc 1 and rc 6 are ordinary command codes);
//   * `lease acquire` on its own keeps rc 1 for the 409 case — there are no
//     command semantics there to confuse it with.
//
// A caller tells "nothing ran" from "ran and failed" by the ABSENCE of
// `lease_id` in the `--json` envelope, never by the number alone: 255 is also
// ssh's own transport failure. The docs recipe says exactly this.

import { RC } from "../upgrade.ts";
import { log } from "../log.ts";
import { RC_POINTER_LINE } from "./rc.ts";
import { isValidBoxName } from "../boxes.ts";
import type { ApiClient, ClientResult, Lease, AcquiredLease } from "../tui/api-client.ts";
import type { SshVia } from "./ssh.ts";

/** L4: the wrapper polls the lease every 30 s while the command runs. */
export const POLL_INTERVAL_MS = 30_000;
/** r7-n3: a FAILED renew has its OWN retry cadence, separate from the poll. */
export const RENEW_RETRY_MS = 300_000;
/** r7-n3 / L4: three consecutive poll failures of any kind ⇒ `unknown`. */
export const POLL_FAIL_THRESHOLD = 3;

export type LeaseState = "active" | "released" | "expired" | "lost" | "unknown";

/**
 * The `--json` envelope, field set stated ONCE (L4). `lease_lost` does not
 * exist as a separate field: it is subsumed by `lease_state`.
 */
export interface RunEnvelope {
  rc: number;
  lease_id: string | null;
  box: string | null;
  lease_state: LeaseState;
  lost_reason?: string;
  poll_error?: string;
  reasons?: Record<string, string>;
}

export const LEASE_HELP = [
  "grokfleet lease <sub>  — reserve a box, then hand it back",
  "",
  "  acquire [--purpose <p>] [--kind ephemeral|service] [--ttl 2h] [--box NNN]",
  "          [--no-drift] [--boxup-version <v>] [--allow-canary] [--max-disk <pct>] [--json]",
  "  renew <id> [--ttl 2h] [--json]",
  "  release <id> [--json]",
  "  ls [--all] [--state <s>] [--json]",
  "  show <id> [--json]",
  "  run [--purpose <p>] [--ttl 2h] [--box NNN] [--via tailnet|tunnel] [--json] -- <cmd...>",
  "",
  "`run` acquires, runs the command on the leased box, and releases in a finally",
  "(including on SIGINT/SIGTERM). Its rc is the REMOTE command's rc when a command",
  "ran, and 255 when nothing ran at all. Key on the --json envelope's lease_id,",
  "not on the number: 255 is also ssh's own transport failure.",
  "",
  "A run that may exceed 24h must use --kind service: an ephemeral lease has a",
  "hard 24h lifetime cap measured from creation and cannot be renewed past it.",
  "",
  RC_POINTER_LINE,
  "",
].join("\n");

// --- small parsers -----------------------------------------------------------

/** `2h` / `30m` / `90s` / a bare number of seconds. undefined when unparseable. */
export function parseDuration(v: string): number | undefined {
  const m = v.match(/^([0-9]+)\s*([smhd]?)$/);
  if (m === null) return undefined;
  const n = Number.parseInt(m[1]!, 10);
  if (n <= 0) return undefined;
  switch (m[2]) {
    case "m":
      return n * 60;
    case "h":
      return n * 3600;
    case "d":
      return n * 86400;
    default:
      return n;
  }
}

/** `007` / `grok-box-007` → `grok-box-007`. undefined when neither. */
export function parseBoxArg(v: string): string | undefined {
  if (isValidBoxName(v)) return v;
  if (/^[0-9]{1,3}$/.test(v)) return `grok-box-${v.padStart(3, "0")}`;
  return undefined;
}

export interface AcquireFlags {
  purpose: string;
  kind: "ephemeral" | "service";
  ttlS?: number;
  box?: string;
  require: Record<string, unknown>;
  json: boolean;
  via?: SshVia;
  /** `run` only: the command words after `--`. */
  command?: string;
  all?: boolean;
  state?: string;
}

export type FlagParse = { flags: AcquireFlags } | { err: string } | { help: true };

/** One parser for every subcommand; unknown flags are a usage error (U4). */
export function parseLeaseFlags(args: string[], opts: { commandTail: boolean }): FlagParse {
  const flags: AcquireFlags = { purpose: "", kind: "ephemeral", require: {}, json: false };
  const tail: string[] = [];
  let afterDashDash = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (afterDashDash) {
      tail.push(a);
      continue;
    }
    if (a === "--") {
      if (!opts.commandTail) return { err: "-- is only meaningful for `lease run`" };
      afterDashDash = true;
      continue;
    }
    if (a === "--help" || a === "-h") return { help: true };
    if (a === "--json") {
      flags.json = true;
      continue;
    }
    if (a === "--all") {
      flags.all = true;
      continue;
    }
    if (a === "--no-drift") {
      flags.require["no_drift"] = true;
      continue;
    }
    if (a === "--allow-canary") {
      flags.require["allow_canary"] = true;
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const inlineValue = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : undefined;
    const take = (): string | undefined => inlineValue ?? args[++i];
    switch (name) {
      case "--purpose": {
        const v = take();
        if (v === undefined || v === "") return { err: "--purpose needs a value" };
        flags.purpose = v;
        continue;
      }
      case "--kind": {
        const v = take();
        if (v !== "ephemeral" && v !== "service") return { err: "--kind must be 'ephemeral' or 'service'" };
        flags.kind = v;
        continue;
      }
      case "--ttl": {
        const v = take();
        const secs = v === undefined ? undefined : parseDuration(v);
        if (secs === undefined) return { err: `--ttl '${v ?? ""}' is not a duration (2h, 30m, 90s)` };
        flags.ttlS = secs;
        continue;
      }
      case "--box": {
        const v = take();
        const b = v === undefined ? undefined : parseBoxArg(v);
        if (b === undefined) return { err: `--box '${v ?? ""}' is not a box (NNN or grok-box-NNN)` };
        flags.box = b;
        continue;
      }
      case "--boxup-version": {
        const v = take();
        if (v === undefined || v === "") return { err: "--boxup-version needs a value" };
        flags.require["boxup_version"] = v;
        continue;
      }
      case "--max-disk": {
        const v = take();
        const n = v === undefined ? NaN : Number(v);
        if (!Number.isFinite(n)) return { err: `--max-disk '${v ?? ""}' is not a percentage` };
        // r1-B3: RESERVED. Forwarded so the API refuses it by name (400) rather
        // than the CLI silently dropping a predicate the caller relied on.
        flags.require["max_disk_pct"] = n;
        continue;
      }
      case "--state": {
        const v = take();
        if (v === undefined || v === "") return { err: "--state needs a value" };
        flags.state = v;
        continue;
      }
      case "--via": {
        const v = take();
        if (v !== "tailnet" && v !== "tunnel") return { err: "--via must be 'tailnet' or 'tunnel'" };
        flags.via = v;
        continue;
      }
      default:
        if (a.startsWith("-")) return { err: `unknown flag ${a}` };
        tail.push(a);
    }
  }
  if (tail.length > 0) flags.command = tail.join(" ");
  return { flags };
}

// --- deps --------------------------------------------------------------------

export interface LeaseDeps {
  api: ApiClient;
  /** stdout sink (DATA). */
  write: (s: string) => void;
  /** stderr sink (diagnostics); defaults to `log`. */
  errWrite?: (s: string) => void;
}

export interface LeaseRunDeps extends LeaseDeps {
  /** run `<cmd>` on `box` with inherited stdio; resolves with the remote rc. */
  exec: (box: string, command: string, via: SshVia | undefined) => Promise<number>;
  /** epoch MILLISECONDS. */
  now: () => number;
  /** repeating timer seam; returns a cancel function. */
  interval: (fn: () => void | Promise<void>, ms: number) => () => void;
  /** signal seam: register a handler, get an unregister back. */
  onSignal?: (fn: () => void) => () => void;
}

function stderrOf(deps: LeaseDeps): (s: string) => void {
  return deps.errWrite ?? ((s: string) => log(s));
}

/** Render a client failure as ONE stderr line, U4-style. */
function failLine(sub: string, r: Extract<ClientResult<unknown>, { ok: false }>): string {
  return `lease ${sub}: ${r.message}${r.status === undefined ? "" : ` (HTTP ${r.status})`}`;
}

// --- subcommands -------------------------------------------------------------

export async function cmdLease(args: string[], deps: LeaseRunDeps): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  const errW = stderrOf(deps);
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    deps.write(LEASE_HELP);
    return RC.OK;
  }
  const parsed = parseLeaseFlags(rest, { commandTail: sub === "run" });
  if ("help" in parsed) {
    deps.write(LEASE_HELP);
    return RC.OK;
  }
  if ("err" in parsed) {
    errW(`lease ${sub}: ${parsed.err}`);
    return RC.USAGE;
  }
  const f = parsed.flags;

  switch (sub) {
    case "acquire":
      return acquireCmd(f, deps);
    case "renew":
      return renewCmd(f, deps);
    case "release":
      return releaseCmd(f, deps);
    case "ls":
      return lsCmd(f, deps);
    case "show":
      return showCmd(f, deps);
    case "run":
      return runCmd(f, deps);
    default:
      errW(`lease: unknown subcommand '${sub}' — see \`grokfleet lease --help\``);
      return RC.USAGE;
  }
}

async function acquireCmd(f: AcquireFlags, deps: LeaseDeps): Promise<number> {
  const errW = stderrOf(deps);
  if (f.purpose === "") {
    errW("lease acquire: --purpose is required");
    return RC.USAGE;
  }
  const r = await deps.api.acquireLease({
    purpose: f.purpose,
    kind: f.kind,
    ...(f.ttlS === undefined ? {} : { ttl_s: f.ttlS }),
    ...(f.box === undefined ? {} : { box: f.box }),
    ...(Object.keys(f.require).length === 0 ? {} : { require: f.require }),
  });
  if (!r.ok) {
    if (r.code === "no_eligible_box") {
      // L4: rc 1 for the 409, with the per-box reasons on STDERR so an agent
      // reading only stderr still learns why the fleet said no.
      errW("lease acquire: no eligible box");
      for (const [box, why] of Object.entries(r.reasons ?? {})) errW(`  ${box}: ${why}`);
      if (f.json) deps.write(JSON.stringify({ lease_id: null, reasons: r.reasons ?? {} }, null, 2) + "\n");
      return RC.FAILURE;
    }
    errW(failLine("acquire", r));
    return RC.FAILURE;
  }
  emitLease(r.value, f.json, deps);
  return RC.OK;
}

function emitLease(l: AcquiredLease | Lease, json: boolean, deps: LeaseDeps): void {
  if (json) {
    deps.write(JSON.stringify(l, null, 2) + "\n");
    return;
  }
  const ssh = `grokfleet ssh --lease ${l.lease_id}`;
  deps.write(`${l.lease_id}\t${l.box}\t${ssh}\n`);
}

async function renewCmd(f: AcquireFlags, deps: LeaseDeps): Promise<number> {
  const errW = stderrOf(deps);
  const id = f.command;
  if (id === undefined) {
    errW("lease renew: needs a lease id");
    return RC.USAGE;
  }
  const r = await deps.api.renewLease(id, f.ttlS);
  if (!r.ok) {
    errW(failLine("renew", r));
    return RC.FAILURE;
  }
  emitLease(r.value, f.json, deps);
  return RC.OK;
}

async function releaseCmd(f: AcquireFlags, deps: LeaseDeps): Promise<number> {
  const errW = stderrOf(deps);
  const id = f.command;
  if (id === undefined) {
    errW("lease release: needs a lease id");
    return RC.USAGE;
  }
  const r = await deps.api.releaseLease(id);
  if (!r.ok) {
    errW(failLine("release", r));
    return RC.FAILURE;
  }
  emitLease(r.value, f.json, deps);
  return RC.OK;
}

async function lsCmd(f: AcquireFlags, deps: LeaseDeps): Promise<number> {
  const errW = stderrOf(deps);
  const r = await deps.api.listLeases({ all: f.all === true, ...(f.state === undefined ? {} : { state: f.state }) });
  if (!r.ok) {
    errW(failLine("ls", r));
    return RC.FAILURE;
  }
  if (f.json) {
    deps.write(JSON.stringify({ leases: r.value }, null, 2) + "\n");
    return RC.OK;
  }
  for (const l of r.value) {
    deps.write(`${l.lease_id}\t${l.box}\t${l.state}\t${l.kind}\t${l.holder}\t${l.purpose}\t${l.expires_at ?? "-"}\n`);
  }
  return RC.OK;
}

async function showCmd(f: AcquireFlags, deps: LeaseDeps): Promise<number> {
  const errW = stderrOf(deps);
  const id = f.command;
  if (id === undefined) {
    errW("lease show: needs a lease id");
    return RC.USAGE;
  }
  const r = await deps.api.getLease(id);
  if (!r.ok) {
    errW(failLine("show", r));
    return RC.FAILURE;
  }
  emitLease(r.value, f.json, deps);
  return RC.OK;
}

// --- `lease run` -------------------------------------------------------------

/**
 * acquire → run → release, with the lease kept alive underneath.
 *
 * The release is in a `finally` AND on SIGINT/SIGTERM (mutant l3 drops it and
 * the SIGTERM test fails). While the command runs the wrapper:
 *
 *   * RENEWS at half the TTL, up to the ephemeral lifetime cap. A `lifetime_cap`
 *     409 prints ONE line and stops renewing (mutant l16 never renews and the
 *     long-run test fails);
 *   * retries a FAILED renew every 5 min on its OWN counter, separate from the
 *     poll counter (r7-n3) — only a renew still failing when `expires_at`
 *     arrives lets the lease expire;
 *   * POLLS the lease every 30 s. `lost` prints a line and sets
 *     `lease_state: "lost"`; `expired` prints a line, sets
 *     `lease_state: "expired"` and KEEPS THE COMMAND RUNNING (killing it would
 *     be worse than a config push); three consecutive poll failures of any kind
 *     set `lease_state: "unknown"` and keep polling (mutant l14 treats
 *     `link_down` as healthy and the poll-fails test fails).
 */
async function runCmd(f: AcquireFlags, deps: LeaseRunDeps): Promise<number> {
  const errW = stderrOf(deps);
  const command = f.command;
  if (command === undefined || command === "") {
    errW("lease run: needs a command after `--`");
    return RC.USAGE;
  }
  const purpose = f.purpose === "" ? "lease run" : f.purpose;

  const acq = await deps.api.acquireLease({
    purpose,
    kind: f.kind,
    ...(f.ttlS === undefined ? {} : { ttl_s: f.ttlS }),
    ...(f.box === undefined ? {} : { box: f.box }),
    ...(Object.keys(f.require).length === 0 ? {} : { require: f.require }),
  });

  if (!acq.ok) {
    // NOTHING RAN. 255 — the one code a remote command can never produce
    // (mutant l15 exits 1 here and the nothing-ran test fails).
    const reasons = acq.reasons;
    const summary =
      reasons === undefined
        ? acq.message
        : Object.entries(reasons)
            .map(([b, why]) => `${b}: ${why}`)
            .join("; ");
    errW(`grokfleet: lease: no box — ${summary}`);
    const env: RunEnvelope = { rc: RC.TRANSPORT, lease_id: null, box: null, lease_state: "unknown" };
    if (reasons !== undefined) env.reasons = reasons;
    if (f.json) deps.write(JSON.stringify(env, null, 2) + "\n");
    return RC.TRANSPORT;
  }

  const lease = acq.value;
  const ttlS = f.ttlS ?? ttlOf(lease, deps.now());
  let state: LeaseState = "active";
  let lostReason: string | undefined;
  let pollError: string | undefined;
  let pollFails = 0;
  let renewing = lease.kind === "ephemeral";
  let nextRenewAt = deps.now() + Math.max(1, Math.floor(ttlS / 2)) * 1000;
  let saidLost = false;
  let saidExpired = false;
  let saidCapped = false;
  let saidUnknown = false;

  const tick = async (): Promise<void> => {
    if (renewing && deps.now() >= nextRenewAt) {
      const r = await deps.api.renewLease(lease.lease_id, f.ttlS);
      if (r.ok) {
        nextRenewAt = deps.now() + Math.max(1, Math.floor(ttlS / 2)) * 1000;
      } else if (r.code === "lifetime_cap") {
        renewing = false;
        if (!saidCapped) {
          saidCapped = true;
          errW(
            `grokfleet: lease: lifetime cap at ${r.cap_at ?? "the 24h bound"} — use --kind service for runs over 24 h`,
          );
        }
      } else {
        // r7-n3: the renew's OWN retry cadence, not the poll's.
        nextRenewAt = deps.now() + RENEW_RETRY_MS;
      }
    }
    const p = await deps.api.getLease(lease.lease_id);
    if (!p.ok) {
      // A failed poll is NOT evidence of health.
      pollFails++;
      if (pollFails >= POLL_FAIL_THRESHOLD) {
        state = "unknown";
        pollError = p.kind;
        if (!saidUnknown) {
          saidUnknown = true;
          errW(`grokfleet: lease: state unknown (${p.kind}) — command outcome unverified`);
        }
      }
      return;
    }
    pollFails = 0;
    if (p.value.state === "lost") {
      state = "lost";
      lostReason = p.value.lost_reason ?? undefined;
      if (!saidLost) {
        saidLost = true;
        errW(`grokfleet: lease: lost (${lostReason ?? "unknown"}) — command outcome unknown`);
      }
    } else if (p.value.state === "expired") {
      state = "expired";
      if (!saidExpired) {
        saidExpired = true;
        errW(
          "grokfleet: lease: expired — command outcome unverified, box deferred for 10 more minutes — release when done",
        );
      }
    }
  };

  const stopTimer = deps.interval(() => void tick(), POLL_INTERVAL_MS);
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await deps.api.releaseLease(lease.lease_id);
  };
  const unregister = deps.onSignal?.(() => {
    void release();
  });

  let rc: number;
  try {
    rc = await deps.exec(lease.box, command, f.via);
  } finally {
    stopTimer();
    unregister?.();
    await release();
  }

  // L4 poll rule: on a LOST lease the rc is the command's own when the remote
  // returned one, else 255 (the connection dropped under the command).
  if (state === "lost" && rc === RC.TRANSPORT) rc = RC.TRANSPORT;

  const env: RunEnvelope = {
    rc,
    lease_id: lease.lease_id,
    box: lease.box,
    lease_state: state === "active" ? "released" : state,
  };
  if (lostReason !== undefined) env.lost_reason = lostReason;
  if (pollError !== undefined) env.poll_error = pollError;
  if (f.json) deps.write(JSON.stringify(env, null, 2) + "\n");
  return rc;
}

/** The TTL the server actually granted, in seconds (falls back to 2 h). */
function ttlOf(l: AcquiredLease, nowMs: number): number {
  if (l.expires_at === null) return 7200;
  const ms = Date.parse(l.expires_at);
  if (Number.isNaN(ms)) return 7200;
  return Math.max(1, Math.floor((ms - nowMs) / 1000));
}
