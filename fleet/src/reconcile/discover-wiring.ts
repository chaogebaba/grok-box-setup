// discover-wiring.ts — the production DiscoverDeps (zero-touch join D2/D3/D5/D6d).
//
// discover.ts holds the policy (candidate rule, rails, budget, backoff, cap);
// this file holds the only things that touch the world: the tailnet ssh
// transport, the in-process enrol orchestration behind EnrollSideEffects, and
// the VPS-local artefact reads the repair content checks need.

import type { Runner } from "../runner.ts";
import type { Env } from "../env.ts";
import type { ParsedConfig } from "../config.ts";
import { boxIndex, portFor } from "../boxes.ts";
import { forgetHostKeys, isHostKeyMismatch, knownHostsFile } from "../hostkey.ts";
import type { ReconcileState } from "./state.ts";
import { discover as listTailnet } from "../commands/list.ts";
import { boxSsh } from "../commands/box-transport.ts";
import { cmdEnroll, type EnrollSideEffects } from "../commands/enroll.ts";
import { makeEnrollSideEffects, vpsAuthorizedKeysPath } from "../commands/enroll-wiring.ts";
import {
  DISCOVER_CONNECT_TIMEOUT_S,
  DISCOVER_PROBE_CEILING_MS,
  authorizedKeysCoherent,
  fleetBlockCoherent,
  mapCoherent,
  parseBoxupVersion,
  type AdoptOutcome,
  type DiscoverDeps,
  type ProbeOutcome,
  type RepairFindings,
} from "./discover.ts";

const BOX_ROOT = "/workspace/box-setup";
const BOX_TUNNEL_PUB = `${BOX_ROOT}/secrets/tunnel_ed25519.pub`;
const BOX_CONFIG = `${BOX_ROOT}/config.toml`;
const BOX_HOSTNAME = `${BOX_ROOT}/hostname`;

/**
 * D6d abort points, in the real cmdEnroll order, with their ceilings. Six
 * points, four remote; the two local ones (`install-vps-key`, `record-enrolled`)
 * have no timeout and so no entry here.
 */
export const ABORT_POINTS = {
  acl: 30_000,
  "read-pubkey": 20_000,
  "install-box-key": 20_000,
  "write-box-config": 20_000,
} as const;

export type AbortPoint = keyof typeof ABORT_POINTS;

/** The whole mutation's bound: the sum of its remote ceilings (90 s). */
export const MUTATION_BUDGET_MS = Object.values(ABORT_POINTS).reduce((a, b) => a + b, 0);

/**
 * P2 password precedence for the DISCOVER transport:
 *   FLEET_SSH_PASSWORD env > $FLEET_ETC/box_passwd > [ssh].password > REFUSE.
 *
 * The baked DEFAULT_SSH_PASSWORD that `resolveSshPassword` ends in does NOT
 * count for adoption. Trying a baked credential against a box the engine has
 * never met is exactly the thing that must fail closed, so this resolver
 * returns undefined instead and discover performs no ssh at all.
 *
 * `readFile` is injected so the precedence is testable without a real
 * $FLEET_ETC; it returns the file's contents or undefined.
 */
export function resolveDiscoverPassword(
  env: Env,
  cfg: ParsedConfig,
  readFile: (path: string) => string | undefined,
  source: Record<string, string | undefined> = process.env,
): string | undefined {
  const fromEnv = source["FLEET_SSH_PASSWORD"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  // Read at tick start, never cached across ticks (the caller builds these deps
  // once per tick).
  const raw = readFile(`${env.FLEET_ETC}/box_passwd`);
  if (raw !== undefined) {
    const first = raw.split("\n")[0]?.trim() ?? "";
    if (first !== "") return first;
  }
  const sshTable = cfg.raw["ssh"];
  if (sshTable !== null && typeof sshTable === "object" && !Array.isArray(sshTable)) {
    const p = (sshTable as Record<string, unknown>)["password"];
    if (typeof p === "string" && p !== "") return p;
  }
  return undefined;
}

/**
 * Wrap an EnrollSideEffects so every REMOTE step is a named D6d abort point.
 *
 * Two guards per point. Before starting, the point's ceiling must still fit in
 * the mutation's own budget, so a mutation cannot creep past 90 s by starting a
 * step it has no time for. After returning, a call whose elapsed time reached
 * its ceiling is classified as a timeout AT THAT POINT — the underlying
 * transports (Bun.spawn's SIGKILL deadline, fetch's AbortSignal) enforce the
 * ceiling themselves, so reaching it means the step failed, and the wrapper's
 * job is only to name where.
 *
 * A timed-out point returns that step's FAILURE value, which makes cmdEnroll
 * return non-zero at exactly that step — no later remote call is made. The
 * partial state that leaves is real and stated: a timeout at `write-box-config`
 * leaves a VPS authorized_keys line and an /etc mapping with no enrolled.tsv
 * entry, i.e. a restricted permitlisten-scoped line for a port nobody dials.
 * The retry converges because the D5 dedup replaces the line for that port.
 */
export function withAbortPoints(
  se: EnrollSideEffects,
  clock: () => number = () => Date.now(),
): { se: EnrollSideEffects; timedOutPoint: () => AbortPoint | undefined } {
  const t0 = clock();
  let aborted: AbortPoint | undefined;

  async function guard<T>(point: AbortPoint, fail: T, fn: () => Promise<T>): Promise<T> {
    if (aborted !== undefined) return fail;
    const ceiling = ABORT_POINTS[point];
    if (clock() - t0 + ceiling > MUTATION_BUDGET_MS) {
      aborted = point;
      return fail;
    }
    const started = clock();
    const r = await fn();
    if (clock() - started >= ceiling) {
      aborted = point;
      return fail;
    }
    return r;
  }

  const wrapped: EnrollSideEffects = {
    ...se,
    aclHasFleetBrainTagowner: () => guard("acl", 2 as 0 | 1 | 2, () => se.aclHasFleetBrainTagowner()),
    readBoxPubkey: (box) => guard("read-pubkey", undefined as string | undefined, () => se.readBoxPubkey(box)),
    installBoxAuthorizedKey: (box, key) => guard("install-box-key", false, () => se.installBoxAuthorizedKey(box, key)),
    writeBoxConfig: (box, vps, idx, port) =>
      guard("write-box-config", 1 as 0 | 1 | 4, () => se.writeBoxConfig(box, vps, idx, port)),
  };
  return { se: wrapped, timedOutPoint: () => aborted };
}

/** The single remote read a candidate probe performs after `ssh … true`. */
const PROBE_READ = [
  `cat '${BOX_HOSTNAME}' 2>/dev/null || true`,
  "echo '---fleet2-probe---'",
  `'${BOX_ROOT}/boxup' version 2>/dev/null || true`,
].join("; ");

/** Split the probe read's stdout into (hostname, boxup version). */
export function parseProbeRead(stdout: string): { hostname: string; boxup: string | undefined } {
  const [head = "", tail = ""] = stdout.split("---fleet2-probe---");
  return { hostname: head.replace(/\s+/g, ""), boxup: parseBoxupVersion(tail) };
}

export interface DiscoverWiringOpts {
  env: Env;
  cfg: ParsedConfig;
  runner: Runner;
  /** P1: whether the tick's ONE token read found a readable token. Passed in so
   *  discover does not duplicate the read assembleTickDeps already performs. */
  apiToken: boolean;
  /** local file reads (injected for tests). */
  readFile?: (path: string) => string | undefined;
  /** monotonic clock for the mutation's abort points. */
  clock?: () => number;
  /**
   * D11(c): the tick's ReconcileState. `inspect` reads `hostkey_mismatch` from
   * it so a mismatched box short-circuits to the repair branch instead of
   * spending two remote reads on checks whose verdict is already known.
   */
  state?: ReconcileState;
}

/** Build the production DiscoverDeps for one tick. */
export function makeDiscoverDeps(opts: DiscoverWiringOpts): DiscoverDeps {
  const readFile =
    opts.readFile ??
    ((path: string): string | undefined => {
      try {
        const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
        return existsSync(path) ? readFileSync(path, "utf8") : undefined;
      } catch {
        return undefined;
      }
    });
  const password = resolveDiscoverPassword(opts.env, opts.cfg, readFile);
  const clock = opts.clock ?? (() => Date.now());

  const sshOpts = (pw: string) => ({
    password: pw,
    connectTimeoutS: DISCOVER_CONNECT_TIMEOUT_S,
    timeoutMs: DISCOVER_PROBE_CEILING_MS,
    // D11(a): the discover transport is fleet-driven, so it reads the engine's
    // own known_hosts too.
    knownHosts: knownHostsFile(opts.env),
  });

  /** Side effects for a discover-initiated enrol: threaded password, discover
   *  connect timeout, tunnel wait 0 (D3). */
  const enrollSe = (pw: string): EnrollSideEffects =>
    makeEnrollSideEffects(opts.env, opts.cfg, opts.runner, {
      password: pw,
      connectTimeoutS: DISCOVER_CONNECT_TIMEOUT_S,
      tunnelWaitBudget: "0",
    });

  return {
    apiToken: opts.apiToken,
    boxPassword: password,

    async listPeers() {
      return listTailnet(opts.runner);
    },

    async probe(box): Promise<ProbeOutcome> {
      const pw = password;
      if (pw === undefined) return { reachable: false, hostname: "", boxup: undefined };
      const alive = await boxSsh(opts.runner, box, "true", sshOpts(pw));
      if (alive.code !== 0) {
        return {
          reachable: false,
          hostname: "",
          boxup: undefined,
          hostkeyMismatch: isHostKeyMismatch({ code: alive.code, stderr: alive.stderr }),
        };
      }
      const read = await boxSsh(opts.runner, box, PROBE_READ, sshOpts(pw));
      if (read.code !== 0) return { reachable: true, hostname: "", boxup: undefined };
      const parsed = parseProbeRead(read.stdout);
      return { reachable: true, hostname: parsed.hostname, boxup: parsed.boxup };
    },

    async adopt(box): Promise<AdoptOutcome> {
      const pw = password;
      if (pw === undefined) return { rc: 1 };
      const { se, timedOutPoint } = withAbortPoints(enrollSe(pw), clock);
      const rc = await cmdEnroll([box], se);
      const point = timedOutPoint();
      return point === undefined ? { rc } : { rc, timeoutPoint: point };
    },

    async forgetHostKeys(box, scope): Promise<void> {
      await forgetHostKeys(opts.runner, {
        file: knownHostsFile(opts.env),
        box,
        port: portFor(box),
        scope,
        why: scope === "tailnet" ? "probe" : "repair",
      });
    },

    async inspect(box): Promise<RepairFindings> {
      // D11(c): while the marker is set the verdict is already known — the
      // artefacts are coherent and the pin was the whole problem. Returning
      // ok:true takes the REPAIR branch rather than the unreachable/backoff
      // branch, and spends no remote call.
      if (opts.state?.readHostkeyMismatch(box) === true) {
        return { ok: true, coherent: false, reason: "hostkey-mismatch" };
      }
      const pw = password;
      if (pw === undefined) return { ok: false, coherent: false, reason: "no-box-password" };
      const port = portFor(box);
      const idx = boxIndex(box);
      if (port === undefined || idx === undefined) {
        return { ok: true, coherent: true, reason: "unparseable-name" };
      }
      // Both remote reads share ONE probe ceiling so the repair side's reserve
      // cannot be overrun by a box that answers slowly twice.
      const deadline = clock() + DISCOVER_PROBE_CEILING_MS;
      const pub = await boxSsh(opts.runner, box, `sudo cat '${BOX_TUNNEL_PUB}'`, sshOpts(pw));
      if (pub.code !== 0) return { ok: false, coherent: false, reason: "pubkey-unreadable" };
      const pubkey = pub.stdout.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
      if (pubkey === "") return { ok: false, coherent: false, reason: "pubkey-empty" };
      if (clock() >= deadline) return { ok: false, coherent: false, reason: "content-check-timeout" };
      const cfgOut = await boxSsh(opts.runner, box, `sudo cat '${BOX_CONFIG}'`, sshOpts(pw));
      if (cfgOut.code !== 0) return { ok: false, coherent: false, reason: "box-config-unreadable" };

      const ak = readFile(vpsAuthorizedKeysPath()) ?? "";
      if (!authorizedKeysCoherent(ak, port, pubkey)) {
        return { ok: true, coherent: false, reason: "authorized_keys line missing or stale for this port" };
      }
      const map = readFile(`${opts.env.FLEET_ETC}/authorized-keys.map`) ?? "";
      if (!mapCoherent(map, box, port, pubkey)) {
        return { ok: true, coherent: false, reason: "authorized-keys.map entry missing or stale" };
      }
      const vps = enrollSe(pw).fleetVpsAddr();
      if (vps === undefined) {
        // Without a VPS address the [fleet] block cannot be judged OR rewritten;
        // enroll itself refuses in that state, so there is nothing to repair.
        return { ok: true, coherent: true, reason: "no-vps-address" };
      }
      if (!fleetBlockCoherent(cfgOut.stdout, vps, idx)) {
        return { ok: true, coherent: false, reason: "[fleet] block missing or naming another VPS/index" };
      }
      return { ok: true, coherent: true, reason: "coherent" };
    },
  };
}
