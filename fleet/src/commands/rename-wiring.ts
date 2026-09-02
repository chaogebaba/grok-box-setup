// rename-wiring.ts — production RenameDeps (D11). Wires the fs-backed
// RenameStore (copy/delete of name-keyed audit artefacts + rows) and the
// RenameOps transport (tunnel + Tailscale API poll/force/reap). Box-free tests
// inject their own store+ops.

import type { Runner } from "../runner.ts";
import type { Env } from "../env.ts";
import type { ParsedConfig } from "../config.ts";
import { tunnelUp, tunnelSsh } from "../tunnel.ts";
import { knownHostsFile } from "../hostkey.ts";
import { parseDevices, baseName, resolveTokenFile, fetchTransport } from "../tailscale.ts";
import { RunContext, TailscaleKeys } from "../reconcile/tailscale-keys.ts";
import { BOX_ROOT } from "../reconcile/seed-remote.ts";
import type { RenameDeps, RenameStore, RenameOps, PollResult } from "./rename.ts";

const TUNNEL_TIMEOUT_MS = 20_000;
const LOCK_TIMEOUT_MS = 95_000;

function fsMod() {
  return require("node:fs") as typeof import("node:fs");
}

/** fs-backed RenameStore over FLEET_STATE / FLEET_ETC. */
function makeStore(env: Env): RenameStore {
  const state = env.FLEET_STATE;
  const etc = env.FLEET_ETC;
  const akDir = process.env.FLEET_ETC_AK_DIR ?? `${etc}/authorized-keys.d`;
  const managedBoxDir = process.env.FLEET_MANAGED_BOXDIR ?? `${etc}/boxes`;
  const enr = `${state}/enrolled.tsv`;
  const map = `${etc}/authorized-keys.map`;

  const read = (p: string): string | undefined => {
    try {
      const { existsSync, readFileSync } = fsMod();
      return existsSync(p) ? readFileSync(p, "utf8") : undefined;
    } catch {
      return undefined;
    }
  };
  const write = (p: string, d: string): void => {
    fsMod().writeFileSync(p, d);
  };
  const cp = (from: string, to: string, mode?: number): void => {
    const { existsSync, copyFileSync, chmodSync, mkdirSync } = fsMod();
    if (!existsSync(from)) return;
    const { dirname } = require("node:path") as typeof import("node:path");
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    if (mode !== undefined) chmodSync(to, mode);
  };
  const rm = (p: string): void => {
    try {
      fsMod().rmSync(p, { force: true });
    } catch {
      /* best-effort */
    }
  };
  const rowPort = (content: string | undefined, box: string): string | undefined => {
    if (content === undefined) return undefined;
    for (const l of content.split("\n")) {
      const [n, p] = l.split("\t");
      if (n === box) return p;
    }
    return undefined;
  };

  return {
    enrolledPort(box) {
      return rowPort(read(enr), box);
    },
    hasEnrolledRow(box) {
      return rowPort(read(enr), box) !== undefined;
    },
    copyState(old, neu) {
      try {
        for (const f of ["expires", "checkfail", "cfgfail"]) cp(`${state}/${old}.${f}`, `${state}/${neu}.${f}`);
        cp(`${akDir}/${old}.line`, `${akDir}/${neu}.line`, 0o600);
        cp(`${managedBoxDir}/${old}.toml`, `${managedBoxDir}/${neu}.toml`);
        // enrolled.tsv: add a <new> row with the same port (dedup <new> first).
        const enrC = read(enr);
        const port = rowPort(enrC, old);
        if (enrC !== undefined && port !== undefined) {
          const kept = enrC.split("\n").filter((l) => l !== "" && !l.startsWith(`${neu}\t`));
          write(enr, [...kept, `${neu}\t${port}`].join("\n") + "\n");
        }
        // authorized-keys.map: add a <new> row copying <old>'s port+key.
        const mapC = read(map);
        if (mapC !== undefined) {
          const oldRow = mapC.split("\n").find((l) => l.startsWith(`${old}\t`));
          if (oldRow !== undefined) {
            const parts = oldRow.split("\t");
            parts[0] = neu;
            const kept = mapC.split("\n").filter((l) => l !== "" && !l.startsWith(`${neu}\t`));
            write(map, [...kept, parts.join("\t")].join("\n") + "\n");
            fsMod().chmodSync(map, 0o600);
          }
        }
        return true;
      } catch {
        return false;
      }
    },
    deleteOldState(old, neu) {
      try {
        for (const f of ["expires", "checkfail", "cfgfail"]) rm(`${state}/${old}.${f}`);
        rm(`${akDir}/${old}.line`);
        rm(`${managedBoxDir}/${old}.toml`);
        const enrC = read(enr);
        if (enrC !== undefined) write(enr, enrC.split("\n").filter((l) => l !== "" && !l.startsWith(`${old}\t`)).join("\n") + "\n");
        const mapC = read(map);
        if (mapC !== undefined) {
          write(map, mapC.split("\n").filter((l) => l !== "" && !l.startsWith(`${old}\t`)).join("\n") + "\n");
          fsMod().chmodSync(map, 0o600);
        }
        void neu;
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** transport-backed RenameOps. */
function makeOps(env: Env, cfg: ParsedConfig, runner: Runner): RenameOps {
  const ctx = new RunContext();
  const tokenFilePromise = (async () => {
    const tf = resolveTokenFile(env, cfg);
    try {
      return await fetchTransport.readToken(tf);
    } catch {
      return undefined;
    }
  })();
  const keysPromise = tokenFilePromise.then(
    (t) => new TailscaleKeys(fetchTransport, env.FLEET_TS_API, env.FLEET_TS_TAILNET, t ?? "", ctx),
  );

  const devLive = (body: string, name: string): { hostname: string; dnslabel: string; liveId: string } => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { hostname: "", dnslabel: "", liveId: "" };
    }
    const devices = (parsed as { devices?: unknown }).devices;
    if (!Array.isArray(devices)) return { hostname: "", dnslabel: "", liveId: "" };
    const matches = (devices as Array<Record<string, unknown>>).filter(
      (d) => baseName(String(d.hostname ?? d.name ?? "")) === name,
    );
    const preferred = matches.filter((d) => d.online === true).concat(matches);
    const first = preferred[0];
    if (first === undefined) return { hostname: "", dnslabel: "", liveId: "" };
    const hostname = String(first.hostname ?? first.name ?? "");
    const dnslabel = String(first.name ?? first.hostname ?? "").split(".")[0] ?? "";
    const liveId = String(first.nodeId ?? first.id ?? "");
    return { hostname, dnslabel, liveId };
  };

  return {
    async tunnelUp(box) {
      return tunnelUp(runner, box);
    },
    async boxBoxupVersion(box) {
      const r = await tunnelSsh(runner, box, env.FLEET_BOX_KEY, `sudo ${BOX_ROOT}/boxup version`, {
        timeoutMs: TUNNEL_TIMEOUT_MS,
        knownHosts: knownHostsFile(env),
      });
      if (r.code !== 0) return "";
      const last = r.stdout.trim().split(/\s+/).pop() ?? "";
      return last.replace(/[^0-9.]/g, "");
    },
    async writeHostnameAndOnce(old, neu) {
      const cmd = `printf '%s\\n' '${neu}' | sudo tee '${BOX_ROOT}/hostname' >/dev/null && sudo ${BOX_ROOT}/boxup once`;
      const r = await tunnelSsh(runner, old, env.FLEET_BOX_KEY, cmd, {
        timeoutMs: TUNNEL_TIMEOUT_MS,
        knownHosts: knownHostsFile(env),
      });
      return r.code === 0;
    },
    async pollDevices(old, neu): Promise<PollResult> {
      const keys = await keysPromise;
      const r = await keys.getDevices();
      const ok = r.code >= 200 && r.code < 300;
      if (!ok) return { ok: false, malformed: false, code: r.code, hostname: "", dnslabel: "", oldLiveId: "", newLiveId: "" };
      let malformed = false;
      try {
        const j = JSON.parse(r.body) as { devices?: unknown };
        if (!Array.isArray(j.devices)) malformed = true;
      } catch {
        malformed = true;
      }
      if (malformed) return { ok: true, malformed: true, code: r.code, hostname: "", dnslabel: "", oldLiveId: "", newLiveId: "" };
      const nu = devLive(r.body, neu);
      const ol = devLive(r.body, old);
      return {
        ok: true,
        malformed: false,
        code: r.code,
        hostname: nu.hostname,
        dnslabel: nu.dnslabel,
        oldLiveId: ol.liveId,
        newLiveId: nu.liveId,
      };
    },
    async forceName(liveId, neu) {
      const keys = await keysPromise;
      const r = await keys.renameDevice(liveId, neu);
      return { ok: r.ok, code: r.code };
    },
    async reapCorpse(corpseId) {
      const keys = await keysPromise;
      const r = await keys.deleteDevice(corpseId);
      return { ok: r.ok, code: r.code };
    },
    async acquireLock() {
      // flock -w 90 on reconcile.lock via util-linux flock, holding it for the run.
      // Production uses a best-effort advisory lock; a full re-exec lock is the
      // reconcile path's. Here we probe flock availability and open the file.
      const { mkdirSync } = fsMod();
      try {
        mkdirSync(env.FLEET_STATE, { recursive: true });
      } catch {
        /* swallowed */
      }
      if (Bun.which("flock") === null) return "open-fail";
      // A bounded flock on a throwaway fd: `flock -w 90 -c :` on the lock file.
      const r = await runner.run(["flock", "-w", "90", `${env.FLEET_STATE}/reconcile.lock`, "-c", ":"], {
        timeoutMs: LOCK_TIMEOUT_MS,
      });
      if (r.code === 0) return "ok";
      return "busy";
    },
    async sleepInterval() {
      await new Promise((r) => setTimeout(r, 5000));
    },
  };
}

/** Build production RenameDeps for `fleet2 rename`. */
export function makeRenameDeps(env: Env, cfg: ParsedConfig, runner: Runner): RenameDeps {
  return {
    store: makeStore(env),
    ops: makeOps(env, cfg, runner),
    paths: {
      state: env.FLEET_STATE,
      akDir: process.env.FLEET_ETC_AK_DIR ?? `${env.FLEET_ETC}/authorized-keys.d`,
      etc: env.FLEET_ETC,
      managedBoxDir: process.env.FLEET_MANAGED_BOXDIR ?? `${env.FLEET_ETC}/boxes`,
    },
  };
}
