// list.test.ts — T5 list golden table + empty fleet (D15/F8).

import { describe, test, expect } from "bun:test";
import { parseDiscover, renderList, renderListJson, cmdList } from "../../src/commands/list.ts";
import { FakeRunner, result } from "../fake-runner.ts";
import type { ApiClient, ClientResult, FleetView } from "../../src/tui/api-client.ts";

const STATUS_JSON = JSON.stringify({
  Peer: {
    a: { HostName: "grok-box-3", TailscaleIPs: ["100.64.0.3", "fd7a::3"], Online: true },
    b: { HostName: "grok-box-008", TailscaleIPs: ["fd7a::8", "100.64.0.8"], Online: false },
    c: { HostName: "some-laptop", TailscaleIPs: ["100.64.0.9"], Online: true },
  },
});

describe("T5 list (main:218-229, fleet_discover main:122-146)", () => {
  test("parseDiscover keeps grok-box-N only, IPv4 first, sorted by index", () => {
    const rows = parseDiscover(STATUS_JSON);
    expect(rows.map((r) => r.name)).toEqual(["grok-box-3", "grok-box-008"]);
    expect(rows[0]).toEqual({ index: 3, name: "grok-box-3", ip: "100.64.0.3", online: "yes" });
    // grok-box-008 has IPv6 first in the array — parser picks the IPv4.
    expect(rows[1]).toEqual({ index: 8, name: "grok-box-008", ip: "100.64.0.8", online: "no" });
  });

  test("golden table format (header %-14s %-16s %-6s, S4 OBSERVED trailing)", () => {
    const out = renderList(parseDiscover(STATUS_JSON));
    const lines = out.split("\n");
    expect(lines[0]).toBe("NAME           TAILSCALE IP     ONLINE OBSERVED");
    expect(lines[1]).toBe("grok-box-3     100.64.0.3       yes    -");
    expect(lines[2]).toBe("grok-box-008   100.64.0.8       no     -");
  });

  test("empty fleet ⇒ the (no grok-box-N peers…) line", () => {
    const out = renderList([]);
    expect(out.split("\n")[1]).toBe("(no grok-box-N peers found on the tailnet)");
  });

  test("malformed json / no Peer ⇒ empty (never throws)", () => {
    expect(parseDiscover("not json")).toEqual([]);
    expect(parseDiscover("{}")).toEqual([]);
  });

  test("cmdList: tailscale rc!=0 ⇒ empty-fleet line, rc 0", async () => {
    const runner = new FakeRunner(() => result({ code: 1 }));
    let out = "";
    const rc = await cmdList(runner, (s) => (out += s));
    expect(rc).toBe(0);
    expect(out).toContain("(no grok-box-N peers found on the tailnet)");
    expect(runner.calls[0]!.argv).toEqual(["tailscale", "status", "--json"]);
  });
});

// --- S4 (memo B4): the OBSERVED column, via the typed ApiClient -------------

const OBSERVED_NAMES = [
  "hostkey_mismatch",
  "incoherent",
  "asleep",
  "api_unknown",
  "unhealthy",
  "drifted",
  "healthy",
] as const;

function fakeClient(boxes: Array<{ name: string; observed?: string }>): ApiClient {
  const value: FleetView = {
    snapshot_ts: "2026-09-16T00:00:00Z",
    apply: true,
    apply_source: "config",
    canary: null,
    scope: "admin",
    boxes: boxes.map((b) => ({
      name: b.name,
      tunnel: "up",
      check: "OK",
      ver: "5.3.0",
      drift: "no",
      config: "in-sync",
      checkfail: false,
      asleep: false,
      expiry_days: 40,
      ...(b.observed === undefined ? {} : { observed: b.observed }),
    })),
    discover: null,
  };
  const ok: ClientResult<FleetView> = { ok: true, value };
  return { fleet: async () => ok } as unknown as ApiClient;
}

function unreachableClient(): ApiClient {
  const err: ClientResult<FleetView> = { ok: false, kind: "link_down", message: "connect failed" };
  return { fleet: async () => err } as unknown as ApiClient;
}

const TWO_BOXES_JSON = JSON.stringify({
  Peer: {
    a: { HostName: "grok-box-3", TailscaleIPs: ["100.64.0.3"], Online: true },
    b: { HostName: "grok-box-008", TailscaleIPs: ["100.64.0.8"], Online: false },
  },
});

describe("S4 — grokfleet list OBSERVED column", () => {
  for (const name of OBSERVED_NAMES) {
    test(`observed=${name} rides through verbatim`, async () => {
      const runner = new FakeRunner(() => result({ stdout: TWO_BOXES_JSON }));
      const client = fakeClient([
        { name: "grok-box-3", observed: name },
        { name: "grok-box-008", observed: "healthy" },
      ]);
      let out = "";
      const rc = await cmdList(runner, (s) => (out += s), false, client);
      expect(rc).toBe(0);
      expect(out.split("\n")[1]).toContain(name);
    });
  }

  test("no API configured (no client) ⇒ '-' for every row", async () => {
    const runner = new FakeRunner(() => result({ stdout: TWO_BOXES_JSON }));
    let out = "";
    await cmdList(runner, (s) => (out += s), false, undefined);
    const lines = out.split("\n");
    expect(lines[1]!.trim().endsWith("-")).toBe(true);
    expect(lines[2]!.trim().endsWith("-")).toBe(true);
  });

  test("unreachable/link-down API ⇒ '-' for every row, list still works", async () => {
    const runner = new FakeRunner(() => result({ stdout: TWO_BOXES_JSON }));
    let out = "";
    const rc = await cmdList(runner, (s) => (out += s), false, unreachableClient());
    expect(rc).toBe(0);
    const lines = out.split("\n");
    expect(lines[1]!.trim().endsWith("-")).toBe(true);
    expect(lines[2]!.trim().endsWith("-")).toBe(true);
  });

  test("a peer with no snapshot row (fleet view omits it) ⇒ '-'", async () => {
    const runner = new FakeRunner(() => result({ stdout: TWO_BOXES_JSON }));
    // Only grok-box-3 has a row; grok-box-008 is a peer the fleet view does
    // not carry at all.
    const client = fakeClient([{ name: "grok-box-3", observed: "healthy" }]);
    let out = "";
    await cmdList(runner, (s) => (out += s), false, client);
    const lines = out.split("\n");
    expect(lines[1]).toContain("healthy");
    expect(lines[2]!.trim().endsWith("-")).toBe(true);
  });

  test("the JSON document carries the same value as the table", async () => {
    const runner = new FakeRunner(() => result({ stdout: TWO_BOXES_JSON }));
    const client = fakeClient([
      { name: "grok-box-3", observed: "drifted" },
      { name: "grok-box-008" },
    ]);
    let out = "";
    await cmdList(runner, (s) => (out += s), true, client);
    const body = JSON.parse(out) as { boxes: Array<{ name: string; observed: string }> };
    expect(body.boxes.find((b) => b.name === "grok-box-3")!.observed).toBe("drifted");
    expect(body.boxes.find((b) => b.name === "grok-box-008")!.observed).toBe("-");

    let tableOut = "";
    await cmdList(runner, (s) => (tableOut += s), false, client);
    expect(tableOut.split("\n")[1]).toContain("drifted");
    expect(tableOut.split("\n")[2]!.trim().endsWith("-")).toBe(true);
  });

  test("renderListJson defaults an absent observed to '-'", () => {
    const rows = parseDiscover(STATUS_JSON);
    const doc = JSON.parse(renderListJson(rows)) as { boxes: Array<{ observed: string }> };
    expect(doc.boxes.every((b) => b.observed === "-")).toBe(true);
  });
});
