// fleet-status.ts — `fleet2 fleet-status` (D14), the brain status table.
//
// Ports cmd_fleet_status (main:3410-3437) VERBATIM in shape: ONE devices GET;
// header `%-14s %-7s %-7s %-7s %-12s %-10s` NAME API TUNNEL CHECK AUTHKEY VERSION
// (main:3414); rows in reconcile_target_boxes order. Per row:
//   API     online/offline via the devices body; `?` when the API is unavailable
//   TUNNEL  up/down via tunnelUp
//   CHECK   OK/FAIL via `boxup check` over the tunnel ONLY when tunnel up (m13);
//           `-` when the tunnel is down (never probed — m13 killer)
//   VERSION status_line_sha(boxup status) — the SHA, only when tunnel up
//   AUTHKEY <box>.expires field 2, else `-`
// rc 0 always (main:3437).

import type { Runner } from "../runner.ts";
import type { Env } from "../env.ts";
import { tunnelUp, tunnelSsh } from "../tunnel.ts";
import { knownHostsFile } from "../hostkey.ts";
import { parseEnrolled } from "../boxes.ts";
import { parseDevices } from "../tailscale.ts";
import { splitVersion } from "../status.ts";
import { CHECK_COMMAND, STATUS_COMMAND } from "../remote.ts";

const CHECK_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 20_000;

export interface FleetStatusRow {
  box: string;
  api: "online" | "offline" | "?";
  tunnel: "up" | "down";
  check: "OK" | "FAIL" | "-";
  authkey: string; // date or "-"
  version: string; // sha, or "-"
}

/** A devices-body source: returns the raw body, or undefined when unavailable. */
export interface DevicesBodySource {
  body(): Promise<string | undefined>;
}

export interface FleetStatusDeps {
  runner: Runner;
  env: Env;
  devices: DevicesBodySource;
  /** reconcile_target_boxes list override (tests). */
  boxes?: string[];
  /** read <box>.expires field 2 (tests). */
  readExpires?: (box: string) => string | undefined;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/** Header + row formatter (byte-identical to bash's printf). */
export function formatFleetStatus(rows: FleetStatusRow[]): string {
  const fmt = (c: string[]): string =>
    `${pad(c[0]!, 14)} ${pad(c[1]!, 7)} ${pad(c[2]!, 7)} ${pad(c[3]!, 7)} ${pad(c[4]!, 12)} ${pad(c[5]!, 10)}`;
  const out: string[] = [fmt(["NAME", "API", "TUNNEL", "CHECK", "AUTHKEY", "VERSION"])];
  for (const r of rows) out.push(fmt([r.box, r.api, r.tunnel, r.check, r.authkey, r.version]));
  return out.join("\n");
}

function enrolledBoxes(env: Env): string[] {
  try {
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const f = `${env.FLEET_STATE}/enrolled.tsv`;
    if (!existsSync(f)) return [];
    return parseEnrolled(readFileSync(f, "utf8"));
  } catch {
    return [];
  }
}

function fsReadExpiresField2(env: Env, box: string): string | undefined {
  try {
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const f = `${env.FLEET_STATE}/${box}.expires`;
    if (!existsSync(f)) return undefined;
    const first = readFileSync(f, "utf8").split("\n").find((l) => l.trim() !== "");
    if (first === undefined) return undefined;
    const d = first.split("\t")[1]?.replace(/\s+/g, "");
    return d && d !== "" ? d : undefined;
  } catch {
    return undefined;
  }
}

/** Build the rows (probes each box). */
export async function fleetStatusRows(deps: FleetStatusDeps): Promise<FleetStatusRow[]> {
  const boxes = deps.boxes ?? enrolledBoxes(deps.env);
  const body = await deps.devices.body();
  const devMap = body !== undefined ? parseDevices(body, boxes) : undefined;
  const readExp = deps.readExpires ?? ((b: string) => fsReadExpiresField2(deps.env, b));

  const rows: FleetStatusRow[] = [];
  for (const box of boxes) {
    let api: FleetStatusRow["api"] = "?";
    if (devMap !== undefined) api = devMap.get(box)?.online ? "online" : "offline";

    const up = await tunnelUp(deps.runner, box);
    let check: FleetStatusRow["check"] = "-";
    let version = "-";
    if (up) {
      const chk = await tunnelSsh(deps.runner, box, deps.env.FLEET_BOX_KEY, CHECK_COMMAND, {
        timeoutMs: CHECK_TIMEOUT_MS,
        knownHosts: knownHostsFile(deps.env),
      });
      check = chk.code === 0 ? "OK" : "FAIL";
      const st = await tunnelSsh(deps.runner, box, deps.env.FLEET_BOX_KEY, STATUS_COMMAND, {
        timeoutMs: STATUS_TIMEOUT_MS,
        knownHosts: knownHostsFile(deps.env),
      });
      const line = st.code === 0 ? st.stdout : "";
      const v = line.trim().split(/\s+/).find((t) => t.startsWith("v="));
      version = splitVersion(v?.slice(2)).sha;
    }

    rows.push({
      box,
      api,
      tunnel: up ? "up" : "down",
      check,
      authkey: readExp(box) ?? "-",
      version,
    });
  }
  return rows;
}

/** cmd_fleet_status: print the table, rc 0 always. */
export async function cmdFleetStatus(deps: FleetStatusDeps, write: (s: string) => void): Promise<number> {
  const rows = await fleetStatusRows(deps);
  write(formatFleetStatus(rows) + "\n");
  return 0;
}
