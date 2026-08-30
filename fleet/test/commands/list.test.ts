// list.test.ts — T5 list golden table + empty fleet (D15/F8).

import { describe, test, expect } from "bun:test";
import { parseDiscover, renderList, cmdList } from "../../src/commands/list.ts";
import { FakeRunner, result } from "../fake-runner.ts";

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

  test("golden table format (header %-14s %-16s %-6s)", () => {
    const out = renderList(parseDiscover(STATUS_JSON));
    const lines = out.split("\n");
    expect(lines[0]).toBe("NAME           TAILSCALE IP     ONLINE");
    expect(lines[1]).toBe("grok-box-3     100.64.0.3       yes   ");
    expect(lines[2]).toBe("grok-box-008   100.64.0.8       no    ");
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
