// enroll-wiring.ts — production EnrollSideEffects (D10). Wires the real tailnet
// box_ssh transport, the VPS-local authorized_keys writes (BUG-E perms), the
// Tailscale ACL GET, and enroll_write_box_config over the tailnet. Box-free
// tests bypass this entirely (they inject their own EnrollSideEffects).

import type { Runner } from "../runner.ts";
import type { Env } from "../env.ts";
import { type ParsedConfig } from "../config.ts";
import { resolveSshPassword } from "./ssh.ts";
import { boxSsh as boxSshTransport } from "./box-transport.ts";
import { resolveTokenFile, fetchTransport } from "../tailscale.ts";
import { tunnelUp } from "../tunnel.ts";
import { knownHostsFile, forgetHostKeys } from "../hostkey.ts";
import type { EnrollSideEffects } from "./enroll.ts";
import { WRITE_BOX_CONFIG_REMOTE } from "./enroll.ts";

const SSH_TIMEOUT_MS = 20_000;
const API_TIMEOUT_MS = 30_000;

/**
 * Per-invocation transport knobs (P2/D2/D3, zero-touch join).
 *
 * `fleet2 enroll` on the CLI passes none of these and keeps its historical
 * behaviour. A DISCOVER-initiated enrol passes all three:
 *
 *  - `password` — P2 threading. The resolved discover password is handed IN and
 *    every ssh this wiring makes uses THAT value. The wiring's own
 *    `resolveSshPassword` fallback (which ends in the baked DEFAULT_SSH_PASSWORD)
 *    is deliberately NOT reachable on the discover path: adoption must fail
 *    closed rather than try a baked credential against an unknown box.
 *  - `connectTimeoutS` — D2's DISCOVER_CONNECT_TIMEOUT_S, an explicit
 *    `-o ConnectTimeout=` for discover calls only. SSH_OPTS is unchanged.
 *  - `tunnelWaitBudget` — D3's tunnel wait 0: the adoption is RECORDED and tick
 *    N+1 proves the tunnel through the normal decision table.
 */
export interface EnrollWiringOpts {
  password?: string;
  connectTimeoutS?: number;
  tunnelWaitBudget?: string;
  /** PKG_VERSION, stamped into the legacy export header (state-store D6). */
  version?: string;
}

function boxSsh(
  runner: Runner,
  cfg: ParsedConfig,
  opts: EnrollWiringOpts,
  env: Env,
  box: string,
  remoteCommand: string,
  stdin?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // P2: an explicitly threaded password wins and the baked-default resolver is
  // never consulted.
  const pw = opts.password ?? resolveSshPassword(cfg);
  return boxSshTransport(runner, box, remoteCommand, {
    password: pw,
    connectTimeoutS: opts.connectTimeoutS,
    timeoutMs: SSH_TIMEOUT_MS,
    stdin,
    // D11(a): the tailnet path is fleet-driven, so it reads the engine's own
    // known_hosts, never /root/.ssh/known_hosts.
    knownHosts: knownHostsFile(env),
  });
}

/**
 * True when an EXISTING authorized_keys line is superseded by `line` (D5).
 *
 * Superseded means: the same `permitlisten="127.0.0.1:<port>"` restriction, OR
 * the same key material. Both classes are dropped before the new line is
 * appended, which is what makes a re-adopt after a rotated box pubkey leave
 * exactly one line for the port.
 */
export function supersededAuthorizedKeysLine(existing: string, line: string): boolean {
  const key = line.split(/\s+/)[2] ?? "";
  if (key !== "" && existing.includes(key)) return true;
  const m = /permitlisten="([^"]+)"/.exec(line);
  const permit = m?.[1];
  if (permit !== undefined && existing.includes(`permitlisten="${permit}"`)) return true;
  return false;
}

/**
 * Run `fn` against a read-write `StoreState`, closing the handle afterwards.
 *
 * Every saga hook opens its own handle rather than sharing one across the
 * enrolment: an enrol takes up to 90 s of remote calls, and holding a write
 * handle open across them would keep a WAL writer alive while the tick's
 * readers and the API want the file.
 */
function withStore<T>(
  env: Env,
  wiringOpts: EnrollWiringOpts,
  fn: (st: import("../store/state.ts").StoreState) => T,
): T {
  const { openStore, storePath } = require("../store/db.ts") as typeof import("../store/db.ts");
  const { StoreState } = require("../store/state.ts") as typeof import("../store/state.ts");
  const store = openStore({ path: storePath(env.FLEET_STATE), dir: env.FLEET_STATE });
  try {
    return fn(
      new StoreState(store, {
        paths: { fleetState: env.FLEET_STATE, etc: env.FLEET_ETC, version: wiringOpts.version ?? "5.9.0" },
      }),
    );
  } finally {
    store.close();
  }
}

/** Build the production EnrollSideEffects for `fleet2 enroll`. */
export function fleetVpsUser(): string {
  return process.env.FLEET_VPS_USER ?? process.env.FLEET_USER ?? "fleet";
}

/** The fleet user's authorized_keys path — the file enroll writes and the D5
 *  repair content check reads. */
export function vpsAuthorizedKeysPath(): string {
  return process.env.FLEET_VPS_AUTHKEYS ?? `/home/${fleetVpsUser()}/.ssh/authorized_keys`;
}

export function makeEnrollSideEffects(
  env: Env,
  cfg: ParsedConfig,
  runner: Runner,
  wiringOpts: EnrollWiringOpts = {},
): EnrollSideEffects {
  const vpsUser = fleetVpsUser();
  const vpsAuthkeys = vpsAuthorizedKeysPath();
  const etcAkDir = process.env.FLEET_ETC_AK_DIR ?? `${env.FLEET_ETC}/authorized-keys.d`;
  let lastApiCode = 0;

  const fs = () => require("node:fs") as typeof import("node:fs");
  const cp = () => require("node:child_process") as typeof import("node:child_process");

  return {
    async vpsUserExists() {
      try {
        cp().execFileSync("id", ["-u", vpsUser], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    async haveSshd() {
      return Bun.which("sshd") !== null;
    },
    async sshdEffective() {
      const r = await runner.run(["sshd", "-T", "-C", `user=${vpsUser}`], { timeoutMs: SSH_TIMEOUT_MS });
      return r.code === 0 ? r.stdout : undefined;
    },
    fleetVpsAddr() {
      const fromEnv = process.env.FLEET_VPS_ADDR;
      if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
      const fb = cfg.fleetBrain["vps"];
      if (typeof fb === "string" && fb !== "") return fb;
      // config [fleet].vps as a last resort (bash fleet_vps_addr).
      const fleetTable = cfg.raw["fleet"];
      if (fleetTable && typeof fleetTable === "object") {
        const v = (fleetTable as Record<string, unknown>)["vps"];
        if (typeof v === "string" && v !== "") return v;
      }
      return undefined;
    },
    fleetVpsPort() {
      const fromEnv = process.env.FLEET_VPS_PORT;
      if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
      const fb = cfg.fleetBrain["vps_port"];
      if (typeof fb === "number") return String(fb);
      if (typeof fb === "string" && fb !== "") return fb;
      return "22";
    },
    async aclHasFleetBrainTagowner() {
      const tokenFile = resolveTokenFile(env, cfg);
      let token: string | undefined;
      try {
        token = await fetchTransport.readToken(tokenFile);
      } catch {
        token = undefined;
      }
      if (token === undefined) {
        lastApiCode = 0;
        return 2;
      }
      const url = `${env.FLEET_TS_API}/tailnet/${env.FLEET_TS_TAILNET}/acl`;
      const r = await fetchTransport.request("GET", url, { Authorization: `Bearer ${token}`, Accept: "application/json" }, API_TIMEOUT_MS);
      lastApiCode = r.code;
      if (r.code < 200 || r.code >= 300) return 2;
      try {
        const j = JSON.parse(r.body) as { tagOwners?: Record<string, unknown> };
        return j.tagOwners && Object.prototype.hasOwnProperty.call(j.tagOwners, "tag:fleet-brain") ? 0 : 1;
      } catch {
        return 1;
      }
    },
    lastApiCode() {
      return lastApiCode;
    },
    async readBoxPubkey(box) {
      const r = await boxSsh(runner, cfg, wiringOpts, env, box, `sudo cat '/workspace/box-setup/secrets/tunnel_ed25519.pub'`);
      if (r.code !== 0) return undefined;
      const first = r.stdout.split("\n").find((l) => l.trim() !== "");
      return first?.trim();
    },
    async tunnelUp(box) {
      // D11(c): this wiring used to keep a PRIVATE copy of the listener probe,
      // which knew nothing about who owns the listener. One parser now — the
      // enrol's pre-listener warning and the tick agree by construction.
      return tunnelUp(runner, box);
    },
    async forgetHostKeys(box, port) {
      await forgetHostKeys(runner, { file: knownHostsFile(env), box, port, why: "enrol" });
    },
    async installVpsAuthorizedKey(line) {
      try {
        const { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } = fs();
        const { dirname } = require("node:path") as typeof import("node:path");
        const akdir = dirname(vpsAuthkeys);
        mkdirSync(akdir, { recursive: true });
        const prior = existsSync(vpsAuthkeys) ? readFileSync(vpsAuthkeys, "utf8") : "";
        // D5 idempotency CHANGE: dedup by permitlisten PORT **or** key material,
        // not key material alone. A box that regenerated tunnel_ed25519 used to
        // leave its stale line behind with the same
        // permitlisten="127.0.0.1:<port>", so the port kept a key the box no
        // longer holds. Dropping both classes makes a re-adopt after a rotated
        // pubkey converge to exactly ONE line for that port.
        const kept = prior
          .split("\n")
          .filter((l) => l !== "" && !supersededAuthorizedKeysLine(l, line));
        writeFileSync(vpsAuthkeys, [...kept, line].join("\n") + "\n");
        // BUG-E perms: dir 700, file 600, chown fleet (best-effort).
        chmodSync(akdir, 0o700);
        chmodSync(vpsAuthkeys, 0o600);
        try {
          cp().execFileSync("chown", ["-R", `${vpsUser}:${vpsUser}`, akdir], { stdio: "ignore" });
        } catch {
          /* best-effort */
        }
        return true;
      } catch {
        return false;
      }
    },
    async recordEtcMapping(box, port, line) {
      try {
        const { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } = fs();
        mkdirSync(etcAkDir, { recursive: true });
        chmodSync(env.FLEET_ETC, 0o700);
        chmodSync(etcAkDir, 0o700);
        const f = `${etcAkDir}/${box}.line`;
        writeFileSync(f, line + "\n");
        chmodSync(f, 0o600);
        const key = line.split(/\s+/)[2] ?? "";
        const idx = `${env.FLEET_ETC}/authorized-keys.map`;
        const prior = existsSync(idx) ? readFileSync(idx, "utf8") : "";
        // D5: ONE entry per PORT as well as per box, so the map cannot keep a
        // stale key for a port whose authorized_keys line was just replaced.
        const kept = prior
          .split("\n")
          .filter((l) => l !== "" && !l.startsWith(`${box}\t`) && (l.split("\t")[1] ?? "") !== String(port));
        writeFileSync(idx, [...kept, `${box}\t${port}\t${key}`].join("\n") + "\n");
        chmodSync(idx, 0o600);
        return true;
      } catch {
        return false;
      }
    },
    async vpsBoxAccessPubkey() {
      try {
        const { existsSync, readFileSync } = fs();
        const pub = `${env.FLEET_BOX_KEY}.pub`;
        if (!existsSync(pub)) return undefined;
        const first = readFileSync(pub, "utf8").split("\n").find((l) => l.trim() !== "");
        return first?.trim();
      } catch {
        return undefined;
      }
    },
    async installBoxAuthorizedKey(box, pubkey) {
      const remote = [
        "set -e",
        "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
        "touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
        `key='${pubkey}'`,
        'kmat=$(printf "%s" "$key" | awk \'{print $2}\')',
        "tmp=$(mktemp)",
        'grep -vF "$kmat" ~/.ssh/authorized_keys > "$tmp" 2>/dev/null || true',
        'printf "%s\\n" "$key" >> "$tmp"',
        'mv -f "$tmp" ~/.ssh/authorized_keys',
        "chmod 600 ~/.ssh/authorized_keys",
      ].join("\n");
      const r = await boxSsh(runner, cfg, wiringOpts, env, box, remote);
      return r.code === 0;
    },
    async writeBoxConfig(box, vps, idx, port) {
      const cmd = `sudo sh -s -- '${vps}' '${idx}' '/workspace/box-setup/config.toml' '${port}'`;
      const r = await boxSsh(runner, cfg, wiringOpts, env, box, cmd, WRITE_BOX_CONFIG_REMOTE);
      if (r.code === 4) return 4;
      if (r.code !== 0) return 1;
      return 0;
    },
    async recordEnrolled(box, port, pubkey) {
      // state-store D4/D6: membership is a STORE row (`phase='enrolled'`), and
      // `enrolled.tsv` + `authorized-keys.map` are EXPORTED from it afterwards.
      // 5.7.1's read-modify-rewrite of the whole file with no temp file and no
      // lock (survey §4a) is gone: a crash between truncate and write can no
      // longer lose the fleet's membership. From 5.9.0 this is the saga's stage
      // 5, i.e. the `enrolling -> enrolled` transition (state-store D5).
      return withStore(env, wiringOpts, (st) => {
        st.recordEnrolled(box, port, pubkey);
        return st.takeExportErrors()[0];
      });
    },

    // --- the enrol saga (state-store D5, Phase B) -----------------------------
    async beginEnrol(box, port, pubkey) {
      return withStore(env, wiringOpts, (st) => st.beginEnrol(box, port, pubkey));
    },
    async stageOk(box, stage, warn) {
      withStore(env, wiringOpts, (st) => st.advanceStage(box, stage, warn));
    },
    async stageFailed(box, stage, warn) {
      withStore(env, wiringOpts, (st) => st.failStage(box, stage, warn));
    },
    async notify(level, msg) {
      const { notify: n } = await import("../notify.ts");
      await n(level, msg, {
        telegramEnvPath: env.FLEET_TELEGRAM_ENV,
        source: (await import("../notify.ts")).fsTelegramSource,
        poster: (await import("../notify.ts")).fetchPoster,
      });
    },
    tunnelWaitBudget() {
      // D3: a discover-initiated enrol passes "0" — the enrolment is RECORDED
      // and tick N+1 proves the tunnel through the decision table.
      return wiringOpts.tunnelWaitBudget ?? process.env.ENROLL_TUNNEL_WAIT ?? "90";
    },
    async sleep5() {
      await new Promise((r) => setTimeout(r, 5000));
    },
  };
}
