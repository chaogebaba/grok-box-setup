// Tailscale DevicesApi — parser (recorded fixture) + request wiring + failure
// fail-open. The parser mirrors fleetctl:3206 `dev_field` (online = any matching
// device online; `-1` split-brain suffix folded; lastSeen = most recent).
//
// Mutant target (this file's guard): the parser drops `lastSeen` — the fixture's
// 011 pair (corpse older + live newer) and the 008 row assert lastSeen survives.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseDevices,
  baseName,
  resolveTokenFile,
  tailscaleDevicesApi,
  type TailscaleTransport,
} from "../src/tailscale.ts";
import { parseConfig } from "../src/config.ts";
import { setLogSink } from "../src/log.ts";
import { testEnv } from "./helpers.ts";

const FIXTURE = readFileSync(`${import.meta.dir}/fixtures/tailscale-devices.json`, "utf8");
const BOXES = ["grok-box-008", "grok-box-009", "grok-box-011"];

let prevSink: (l: string) => void;
beforeEach(() => {
  prevSink = setLogSink(() => {});
});
afterEach(() => {
  setLogSink(prevSink);
});

describe("baseName fold", () => {
  test("strips a trailing -1 split-brain suffix", () => {
    expect(baseName("grok-box-011-1")).toBe("grok-box-011");
    expect(baseName("grok-box-011")).toBe("grok-box-011");
    expect(baseName("grok-box-8")).toBe("grok-box-8");
  });
});

describe("parseDevices (recorded fixture)", () => {
  test("online + lastSeen per box; -1 corpse folds into the live node", () => {
    const m = parseDevices(FIXTURE, BOXES);
    expect(m.get("grok-box-008")).toEqual({ online: true, lastSeen: "2026-08-30T00:40:00Z" });
    expect(m.get("grok-box-009")).toEqual({ online: false, lastSeen: "2026-08-29T10:00:00Z" });
    // 011: corpse (grok-box-011-1, offline, older) + live (online, newer) →
    // online=true AND the NEWER lastSeen wins.
    expect(m.get("grok-box-011")).toEqual({ online: true, lastSeen: "2026-08-30T00:39:00Z" });
  });

  test("mutant guard: lastSeen must be present and correct (not null)", () => {
    const m = parseDevices(FIXTURE, BOXES);
    // A parser that drops lastSeen would return null here — this kills that mutant.
    expect(m.get("grok-box-008")?.lastSeen).toBe("2026-08-30T00:40:00Z");
    expect(m.get("grok-box-011")?.lastSeen).toBe("2026-08-30T00:39:00Z");
  });

  test("a box absent from the fixture is left out of the map", () => {
    const m = parseDevices(FIXTURE, ["grok-box-099"]);
    expect(m.has("grok-box-099")).toBe(false);
  });

  test("malformed / non-array body → empty map, never throws", () => {
    expect(parseDevices("{not json", BOXES).size).toBe(0);
    expect(parseDevices('{"nope":true}', BOXES).size).toBe(0);
    expect(parseDevices("", BOXES).size).toBe(0);
  });
});

describe("resolveTokenFile (fleetctl:938 precedence)", () => {
  test("env > config > default", () => {
    const cfg = parseConfig(`[fleet-brain]\napi_token_file = "/cfg/token"\n`, "/x");
    expect(resolveTokenFile(testEnv({ FLEET_API_TOKEN_FILE: "/env/token" }), cfg)).toBe("/env/token");
    expect(resolveTokenFile(testEnv(), cfg)).toBe("/cfg/token");
    const noCfg = parseConfig("", "/x");
    expect(resolveTokenFile(testEnv({ FLEET_ETC: "/etc/grok-fleet" }), noCfg)).toBe(
      "/etc/grok-fleet/api-token",
    );
  });
});

function transport(over: Partial<TailscaleTransport>): TailscaleTransport {
  return {
    async readToken() {
      return "SECRET-PAT";
    },
    async get() {
      return { code: 200, body: FIXTURE };
    },
    ...over,
  };
}

describe("tailscaleDevicesApi request wiring", () => {
  test("GET hits the devices endpoint with Bearer + Accept; returns {online} per box", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const api = tailscaleDevicesApi(
      testEnv(),
      parseConfig("", "/x"),
      transport({
        async get(url, headers) {
          seenUrl = url;
          seenHeaders = headers;
          return { code: 200, body: FIXTURE };
        },
      }),
    );
    const m = await api.probe(BOXES);
    expect(seenUrl).toBe("https://api.tailscale.com/api/v2/tailnet/-/devices?fields=all");
    expect(seenHeaders["Authorization"]).toBe("Bearer SECRET-PAT");
    expect(seenHeaders["Accept"]).toBe("application/json");
    expect(m?.get("grok-box-008")).toEqual({ online: true, lastSeen: "2026-08-30T00:40:00Z" });
  });

  test("missing token → undefined (API '?'), never throws", async () => {
    const api = tailscaleDevicesApi(
      testEnv(),
      parseConfig("", "/x"),
      transport({ async readToken() { return undefined; } }),
    );
    expect(await api.probe(BOXES)).toBeUndefined();
  });

  test("non-2xx → undefined (F7.2/F7.3: inventory still writes)", async () => {
    const api = tailscaleDevicesApi(
      testEnv(),
      parseConfig("", "/x"),
      transport({ async get() { return { code: 500, body: "" }; } }),
    );
    expect(await api.probe(BOXES)).toBeUndefined();
  });

  test("timeout/transport failure (code 0) → undefined", async () => {
    const api = tailscaleDevicesApi(
      testEnv(),
      parseConfig("", "/x"),
      transport({ async get() { return { code: 0, body: "" }; } }),
    );
    expect(await api.probe(BOXES)).toBeUndefined();
  });

  test("token never appears in any log line", async () => {
    const logs: string[] = [];
    setLogSink((l) => logs.push(l));
    const api = tailscaleDevicesApi(
      testEnv(),
      parseConfig("", "/x"),
      transport({ async get() { return { code: 403, body: "" }; } }),
    );
    await api.probe(BOXES);
    expect(logs.some((l) => l.includes("SECRET-PAT"))).toBe(false);
  });

  test("custom tailnet is honoured in the URL", async () => {
    let seenUrl = "";
    const api = tailscaleDevicesApi(
      testEnv({ FLEET_TS_TAILNET: "example.com" }),
      parseConfig("", "/x"),
      transport({
        async get(url) {
          seenUrl = url;
          return { code: 200, body: FIXTURE };
        },
      }),
    );
    await api.probe(BOXES);
    expect(seenUrl).toBe("https://api.tailscale.com/api/v2/tailnet/example.com/devices?fields=all");
  });
});
