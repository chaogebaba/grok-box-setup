// fleet-status.test.ts — T5 golden table + m13 (CHECK not probed when tunnel
// down) + API '?' on failure (D14).

import { describe, test, expect } from "bun:test";
import { fleetStatusRows, formatFleetStatus, cmdFleetStatus } from "../../src/commands/fleet-status.ts";
import { testEnv } from "../helpers.ts";
import { FakeRunner, isSs } from "../fake-runner.ts";

const env = testEnv();

const DEVICES = JSON.stringify({
  devices: [
    { hostname: "grok-box-3", online: true, lastSeen: "2026-08-30T00:00:00Z" },
    { hostname: "grok-box-5", online: false, lastSeen: "2026-08-29T00:00:00Z" },
  ],
});

// ss listener up ONLY for grok-box-3 (port 20003); grok-box-5 (20005) down.
function runnerFor(): FakeRunner {
  return new FakeRunner((argv) => {
    if (isSs(argv)) return { code: 0, stdout: "LISTEN 0 0 127.0.0.1:20003 0.0.0.0:*\n" };
    // any tunnel ssh: check OK, status line with a sha for the up box.
    const cmd = argv[argv.length - 1] ?? "";
    if (cmd.includes("boxup check")) return { code: 0 };
    if (cmd.includes("boxup status")) return { code: 0, stdout: "name=grok-box-3 v=5.3.0/abc1234 tunnel=up\n" };
    return { code: 0 };
  });
}

describe("T5 fleet-status (main:3410-3437, m13)", () => {
  test("rows: API from devices, CHECK/VERSION only when tunnel up (m13)", async () => {
    const runner = runnerFor();
    const rows = await fleetStatusRows({
      runner,
      env,
      devices: { async body() { return DEVICES; } },
      boxes: ["grok-box-3", "grok-box-5"],
      readExpires: (b) => (b === "grok-box-3" ? "2026-12-01" : undefined),
    });
    // grok-box-3: tunnel up ⇒ CHECK OK, VERSION=sha abc1234.
    expect(rows[0]).toEqual({ box: "grok-box-3", api: "online", tunnel: "up", check: "OK", authkey: "2026-12-01", version: "abc1234" });
    // grok-box-5: tunnel down ⇒ CHECK '-' (NOT probed, m13), VERSION '-'.
    expect(rows[1]).toEqual({ box: "grok-box-5", api: "offline", tunnel: "down", check: "-", authkey: "-", version: "-" });
    // m13: no boxup check/status ssh was ever issued for grok-box-5 (port 20005).
    const box5calls = runner.joined().filter((c) => c.includes("20005") || c.includes("grok-box-5"));
    expect(box5calls.filter((c) => c.includes("boxup"))).toEqual([]);
  });

  test("API '?' when the devices body is unavailable", async () => {
    const rows = await fleetStatusRows({
      runner: runnerFor(),
      env,
      devices: { async body() { return undefined; } },
      boxes: ["grok-box-3"],
      readExpires: () => undefined,
    });
    expect(rows[0]!.api).toBe("?");
  });

  test("golden header + row format", async () => {
    const out = formatFleetStatus([
      { box: "grok-box-3", api: "online", tunnel: "up", check: "OK", authkey: "2026-12-01", version: "abc1234" },
    ]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("NAME           API     TUNNEL  CHECK   AUTHKEY      VERSION   ");
    expect(lines[1]).toBe("grok-box-3     online  up      OK      2026-12-01   abc1234   ");
  });

  test("cmdFleetStatus writes the table, rc 0", async () => {
    let out = "";
    const rc = await cmdFleetStatus(
      { runner: runnerFor(), env, devices: { async body() { return DEVICES; } }, boxes: ["grok-box-3"], readExpires: () => undefined },
      (s) => (out += s),
    );
    expect(rc).toBe(0);
    expect(out).toContain("NAME");
    expect(out).toContain("grok-box-3");
  });
});
