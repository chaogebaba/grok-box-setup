// tailscale.ts — the real DevicesApi backed by the Tailscale devices endpoint.
//
// Mirrors the bash brain's device read EXACTLY:
//  - endpoint: GET <TS_API>/tailnet/<TS_TAILNET>/devices?fields=all
//    (fleetctl:1730 `devices_json`; TS_API default https://api.tailscale.com/api/v2,
//    TS_TAILNET default "-" = the token's default tailnet, fleetctl:780-781).
//  - auth: Authorization: Bearer <token> + Accept: application/json
//    (fleetctl:980-990 `ts_api`; BUG-D — Accept:application/json is mandatory so
//    the API returns strict JSON, not HuJSON).
//  - token: read from a 0600 file resolved FLEET_API_TOKEN_FILE env >
//    [fleet-brain].api_token_file > $FLEET_ETC/api-token (fleetctl:938-941
//    `api_token_file`). The token value is NEVER logged or placed on argv.
//  - per-box derivation mirrors fleetctl:3206 `dev_field`: a device matches a
//    box when its hostname (or name), with a trailing `-1` split-brain suffix
//    folded off, equals the box; `online` = ANY matching device online==true;
//    `lastSeen` = the most recent lastSeen across matching devices.
//
// Any failure (no token, non-2xx, malformed JSON, timeout) ⇒ the probe returns
// `undefined`, so inventory renders API `?` and still writes inventory.json
// (F7.2/F7.3). This is the fail-open-on-read behaviour the bash brain uses for
// the read-only status surface (it does NOT gate mutations here — inventory is
// read-only).

import type { DevicesApi } from "./inventory.ts";
import type { Env } from "./env.ts";
import type { ParsedConfig } from "./config.ts";
import { log } from "./log.ts";

const DEVICES_TIMEOUT_MS = 20_000;

export interface DeviceInfo {
  online: boolean;
  /** ISO8601 lastSeen (the most recent across a box's devices), or null. */
  lastSeen: string | null;
}

/** Fold the `-1` split-brain suffix off a hostname/name (fleetctl:3209 `base`). */
export function baseName(h: string): string {
  return h.replace(/-1$/, "");
}

interface RawDevice {
  hostname?: string;
  name?: string;
  online?: boolean;
  lastSeen?: string;
}

/**
 * Parse a Tailscale devices response body into a per-box {online, lastSeen}
 * map, matching `dev_field` semantics (fleetctl:3206). Pure — no I/O. Never
 * throws on shape surprises; a body without a `.devices` array yields an empty
 * map. Only the requested `boxes` are populated.
 */
export function parseDevices(body: string, boxes: string[]): Map<string, DeviceInfo> {
  const out = new Map<string, DeviceInfo>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return out;
  }
  const devices = (parsed as { devices?: unknown })?.devices;
  if (!Array.isArray(devices)) return out;

  // Index devices by their folded base hostname/name.
  const byBox = new Map<string, RawDevice[]>();
  for (const d of devices as RawDevice[]) {
    const h = d.hostname ?? d.name ?? "";
    if (h === "") continue;
    const key = baseName(h);
    const arr = byBox.get(key);
    if (arr) arr.push(d);
    else byBox.set(key, [d]);
  }

  for (const box of boxes) {
    const ds = byBox.get(box) ?? [];
    if (ds.length === 0) continue; // not present ⇒ leave out; caller renders offline
    const online = ds.some((d) => d.online === true);
    // most recent lastSeen across matching devices
    let lastSeen: string | null = null;
    for (const d of ds) {
      const ls = typeof d.lastSeen === "string" ? d.lastSeen : null;
      if (ls !== null && (lastSeen === null || ls > lastSeen)) lastSeen = ls;
    }
    out.set(box, { online, lastSeen });
  }
  return out;
}

/** Resolve the API token file path (fleetctl:938-941 precedence). */
export function resolveTokenFile(env: Env, cfg: ParsedConfig): string {
  if (env.FLEET_API_TOKEN_FILE) return env.FLEET_API_TOKEN_FILE;
  const fromCfg = cfg.fleetBrain["api_token_file"];
  if (typeof fromCfg === "string" && fromCfg !== "") return fromCfg;
  return `${env.FLEET_ETC}/api-token`;
}

/** Seam over token-file reads + the HTTP GET, so tests inject both. */
export interface TailscaleTransport {
  /** Return the trimmed token string, or undefined when the file is absent/empty. */
  readToken(path: string): Promise<string | undefined>;
  /** GET the URL with the given headers; return {code, body}. */
  get(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ code: number; body: string }>;
}

/** Production transport: Bun.file for the token, fetch for the request. */
export const fetchTransport: TailscaleTransport = {
  async readToken(path) {
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;
    const t = (await file.text()).trim();
    return t === "" ? undefined : t;
  },
  async get(url, headers, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: "GET", headers, signal: ctrl.signal });
      const body = await res.text();
      return { code: res.status, body };
    } catch {
      return { code: 0, body: "" };
    } finally {
      clearTimeout(timer);
    }
  },
};

/**
 * The real DevicesApi. Reads the token, GETs the devices endpoint (20 s), and
 * parses per-box state. Any failure ⇒ `undefined` (⇒ API `?`, inventory still
 * written). The token is never logged.
 */
export function tailscaleDevicesApi(
  env: Env,
  cfg: ParsedConfig,
  transport: TailscaleTransport = fetchTransport,
): DevicesApi {
  return {
    async probe(boxes: string[]): Promise<Map<string, DeviceInfo> | undefined> {
      const tokenFile = resolveTokenFile(env, cfg);
      let token: string | undefined;
      try {
        token = await transport.readToken(tokenFile);
      } catch {
        token = undefined;
      }
      if (token === undefined) {
        log(`inventory: API token file '${tokenFile}' missing/unreadable — API column '?'`);
        return undefined;
      }
      const url = `${env.FLEET_TS_API}/tailnet/${env.FLEET_TS_TAILNET}/devices?fields=all`;
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
      let res: { code: number; body: string };
      try {
        res = await transport.get(url, headers, DEVICES_TIMEOUT_MS);
      } catch {
        log("inventory: Tailscale devices request failed — API column '?'");
        return undefined;
      }
      if (res.code < 200 || res.code >= 300) {
        log(`inventory: Tailscale devices HTTP ${res.code} — API column '?'`);
        return undefined;
      }
      const parsed = parseDevices(res.body, boxes);
      if (parsed.size === 0 && res.body.trim() !== "" && !res.body.includes('"devices"')) {
        // malformed/partial 200 (no devices array) — fail-open to '?'
        log("inventory: Tailscale devices body malformed — API column '?'");
        return undefined;
      }
      // Return the full {online, lastSeen} shape the inventory seam consumes.
      return parsed;
    },
  };
}
