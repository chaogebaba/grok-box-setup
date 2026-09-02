// inventory.ts — `fleet2 inventory [--json] [box…]` (D6, F7, G4).
//
// Per box, concurrently (limit FLEET_MAX_CONCURRENCY, default 2 — S3):
//  - TUNNEL: the VPS-side `ss -tln` probe (F7.1); the box's own tunnel= token is
//    stored only as boxTunnel.
//  - tunnel down ⇒ CHECK/VERSION/SHA/DRIFT render `-` (F7.3, "not probed").
//  - tunnel up ⇒ `boxup check` (S2/G4): rc 0 gives status from one call; rc 1
//    (unhealthy) triggers a SECOND `boxup status` ssh to fill VERSION/SHA (G4).
//  - API: online/offline from the Tailscale devices endpoint; `?` when down.
//  - AUTHKEY from `<box>.expires` field 2.
// inventory NEVER fails on target resolution (F7.2): unresolvable ⇒ TARGET/DRIFT
// `?`, one warn, exit 0. inventory.json rewritten after every pass (F7.6).

import type { Runner } from "./runner.ts";
import type { Env } from "./env.ts";
import type { RolloutConfig } from "./config.ts";
import type { FsSeam, Inventory, BoxEntry } from "./state.ts";
import { tunnelUp, tunnelSsh } from "./tunnel.ts";
import { knownHostsFile } from "./hostkey.ts";
import { CHECK_COMMAND, STATUS_COMMAND } from "./remote.ts";
import { parseCheck, parseStatusLine, type BoxStatus } from "./status.ts";
import { resolveTarget, type Target } from "./stage.ts";
import { inventoryPath, writeInventory } from "./state.ts";
import { log } from "./log.ts";

const CHECK_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 20_000;

export interface DevicesApi {
  /** Return per-box {online, lastSeen} or undefined when the API is unavailable. */
  probe(boxes: string[]): Promise<Map<string, { online: boolean; lastSeen: string | null }> | undefined>;
}

/** A DevicesApi that always reports "unavailable" (phase-1 default/tests). */
export const noApi: DevicesApi = {
  async probe() {
    return undefined;
  },
};

export interface ProbeResult {
  box: string;
  api: "online" | "offline" | "?";
  /** ISO8601 lastSeen from the API, or null (also null when API unavailable). */
  lastSeen: string | null;
  tunnel: "up" | "down";
  check: "OK" | "FAIL" | "-";
  version: string; // "-" not probed, "?" unknown, else dotted
  sha: string; // "-" / "?" / short sha
  status: BoxStatus | undefined;
  checkReason: string | undefined;
  expires: string | undefined;
}

/** Probe a single box (tunnel → check → maybe status). */
export async function probeBox(
  runner: Runner,
  env: Env,
  box: string,
  api: Map<string, { online: boolean; lastSeen: string | null }> | undefined,
  expires: string | undefined,
): Promise<ProbeResult> {
  const entry = api?.get(box);
  const apiState: ProbeResult["api"] = api === undefined ? "?" : entry?.online ? "online" : "offline";
  const lastSeen: string | null = entry?.lastSeen ?? null;

  const up = await tunnelUp(runner, box);
  if (!up) {
    return {
      box,
      api: apiState,
      lastSeen,
      tunnel: "down",
      check: "-",
      version: "-",
      sha: "-",
      status: undefined,
      checkReason: undefined,
      expires,
    };
  }

  const checkRes = await tunnelSsh(runner, box, env.FLEET_BOX_KEY, CHECK_COMMAND, {
    timeoutMs: CHECK_TIMEOUT_MS,
    knownHosts: knownHostsFile(env),
  }).then(
    (r) => parseCheck(r.code, r.stdout + (r.stdout && r.stderr ? "\n" : "") + r.stderr),
    () => parseCheck(1, ""),
  );

  if (checkRes.ok && checkRes.status) {
    return {
      box,
      api: apiState,
      lastSeen,
      tunnel: "up",
      check: "OK",
      version: checkRes.status.version,
      sha: checkRes.status.sha,
      status: checkRes.status,
      checkReason: undefined,
      expires,
    };
  }

  // Unhealthy: second ssh for the status line to fill VERSION/SHA (G4/S-C).
  const statusLine = await tunnelSsh(runner, box, env.FLEET_BOX_KEY, STATUS_COMMAND, {
    timeoutMs: STATUS_TIMEOUT_MS,
    knownHosts: knownHostsFile(env),
  }).then(
    (r) => r.stdout,
    () => "",
  );
  const st = parseStatusLine(statusLine);
  return {
    box,
    api: apiState,
    lastSeen,
    tunnel: "up",
    check: "FAIL",
    version: st.version,
    sha: st.sha,
    status: st,
    checkReason: checkRes.reason,
    expires,
  };
}

/** Bounded-concurrency map (limit N). Preserves input order in the output. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const n = Math.max(1, limit);
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

export interface InventoryDeps {
  runner: Runner;
  env: Env;
  rollout: RolloutConfig;
  fs: FsSeam;
  api?: DevicesApi;
  /** Read `<box>.expires` field-2 date; undefined when absent. */
  readExpires?: (fleetState: string, box: string) => Promise<string | undefined>;
  /** For --json vs table: caller controls stdout via the returned object. */
}

/** Read `<box>.expires` (TSV, date is field 2 — F7.7). */
export const fsReadExpires = async (
  fleetState: string,
  box: string,
): Promise<string | undefined> => {
  const file = Bun.file(`${fleetState}/${box}.expires`);
  if (!(await file.exists())) return undefined;
  const text = await file.text();
  const first = text.split("\n").find((l) => l.trim() !== "");
  if (first === undefined) return undefined;
  const field2 = first.split("\t")[1]?.trim();
  return field2 && field2 !== "" ? field2 : undefined;
};

export interface InventoryResult {
  inventory: Inventory;
  rows: ProbeResult[];
  target: Target | null;
  /** the ISO timestamp of a PREVIOUS inventory.json, for the staleness header. */
  previousGeneratedAt: string | null;
}

/**
 * Run an inventory pass over `boxes`. Resolves the target best-effort (F7.2):
 * on failure TARGET/DRIFT are null and one warn is logged; the pass still
 * succeeds. Writes inventory.json atomically (F7.6).
 */
export async function runInventory(boxes: string[], deps: InventoryDeps): Promise<InventoryResult> {
  const { runner, env, rollout, fs } = deps;
  const api = deps.api ?? noApi;
  const readExpires = deps.readExpires ?? fsReadExpires;

  // Previous inventory's generatedAt for the staleness header (F9/S-F).
  const prev = await fs.readFile(inventoryPath(env.FLEET_STATE));
  let previousGeneratedAt: string | null = null;
  if (prev) {
    try {
      previousGeneratedAt = (JSON.parse(prev) as Inventory).generatedAt ?? null;
    } catch {
      previousGeneratedAt = null;
    }
  }

  // Best-effort target resolution — never fails inventory (F7.2).
  let target: Target | null = null;
  try {
    target = await resolveTarget(runner, rollout.src, rollout.target);
  } catch {
    log(`inventory: target unresolved ([rollout].src='${rollout.src}') — TARGET/DRIFT '?'`);
    target = null;
  }

  const apiMap = await api.probe(boxes);

  const rows = await mapLimit(boxes, env.FLEET_MAX_CONCURRENCY, async (box) => {
    const expires = await readExpires(env.FLEET_STATE, box);
    return probeBox(runner, env, box, apiMap, expires);
  });

  const generatedAt = new Date().toISOString();
  const boxesObj: Record<string, BoxEntry> = {};
  for (const r of rows) {
    boxesObj[r.box] = {
      api: r.api === "?" ? null : r.api,
      lastSeen: r.lastSeen,
      tunnel: r.tunnel,
      check: r.check === "-" ? null : r.check,
      version: r.version === "-" || r.version === "?" ? null : r.version,
      sha: r.sha === "-" || r.sha === "?" ? null : r.sha,
      boxTunnel: r.status?.boxTunnel ?? null,
      checkReason: r.checkReason ?? null,
      expires: r.expires ?? null,
      checkedAt: generatedAt,
      reason: r.tunnel === "down" ? "tunnel-down" : r.api === "?" ? "api-unavailable" : null,
    };
  }

  const inventory: Inventory = {
    generatedAt,
    target: target
      ? { ref: target.ref, sha: target.sha, version: target.version }
      : { ref: rollout.target, sha: null, version: null },
    boxes: boxesObj,
  };

  await writeInventory(fs, inventoryPath(env.FLEET_STATE), inventory);
  return { inventory, rows, target, previousGeneratedAt };
}

/** Compute the DRIFT cell for a row given the resolved target. */
export function driftCell(row: ProbeResult, target: Target | null): string {
  if (row.tunnel === "down") return "-";
  if (target === null) return "?";
  if (row.sha === "?" || row.sha === "-" || row.sha === "unknown") return "?";
  return row.sha === target.sha ? "no" : "yes";
}

/** Render the human table (F9: NAME API TUNNEL CHECK VERSION SHA TARGET DRIFT AUTHKEY). */
export function renderTable(res: InventoryResult): string {
  const t = res.target;
  const targetCell = t ? t.version : "?";
  const targetSha = t ? t.sha : "?";
  const lines: string[] = [];
  lines.push(`generatedAt=${res.inventory.generatedAt}`);
  const header = [
    pad("NAME", 14),
    pad("API", 8),
    pad("TUNNEL", 7),
    pad("CHECK", 6),
    pad("VERSION", 9),
    pad("SHA", 10),
    pad("TARGET", 10),
    pad("DRIFT", 6),
    "AUTHKEY",
  ].join(" ");
  lines.push(header);
  for (const r of res.rows) {
    const drift = driftCell(r, t);
    const targetDisplay = t ? `${targetCell}/${targetSha}` : "?";
    lines.push(
      [
        pad(r.box, 14),
        pad(r.api, 8),
        pad(r.tunnel, 7),
        pad(r.check, 6),
        pad(r.version, 9),
        pad(r.sha, 10),
        pad(targetDisplay, 10),
        pad(drift, 6),
        r.expires ?? "-",
      ].join(" "),
    );
  }
  return lines.join("\n");
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
