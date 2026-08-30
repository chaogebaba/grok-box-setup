// T2 — tunnel argv (D3, F6) and index/port parsing.

import { test, expect, describe } from "bun:test";
import { sshArgv, scpArgv, ssArgv, tunnelUp } from "../src/tunnel.ts";
import { boxIndex, portFor } from "../src/boxes.ts";
import { FakeRunner, result } from "./fake-runner.ts";

const KEY = "/etc/grok-fleet/box_access_ed25519";

describe("T2 tunnel argv", () => {
  test("ssh argv is exact (D3 order, no --)", () => {
    const argv = sshArgv("grok-box-008", KEY, "sudo /workspace/box-setup/boxup check");
    expect(argv).toEqual([
      "ssh",
      "-p",
      "20008",
      "-i",
      KEY,
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=8",
      "box@127.0.0.1",
      "sudo /workspace/box-setup/boxup check",
    ]);
    // F6/SHOULD-4: the remote command is the LAST element, appended verbatim.
    expect(argv[argv.length - 1]).toBe("sudo /workspace/box-setup/boxup check");
    expect(argv).not.toContain("--");
  });

  test("scp argv uses -P and the box@127.0.0.1:dst target", () => {
    const argv = scpArgv("grok-box-008", KEY, "/tmp/local.tar", "/tmp/grok-box-setup-brain.tar");
    expect(argv).toEqual([
      "scp",
      "-P",
      "20008",
      "-i",
      KEY,
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=8",
      "/tmp/local.tar",
      "box@127.0.0.1:/tmp/grok-box-setup-brain.tar",
    ]);
  });

  test("index parsing is decimal (grok-box-008/009/011)", () => {
    expect(boxIndex("grok-box-008")).toBe(8);
    expect(boxIndex("grok-box-009")).toBe(9);
    expect(boxIndex("grok-box-011")).toBe(11);
    expect(portFor("grok-box-008")).toBe(20008);
    expect(portFor("grok-box-011")).toBe(20011);
    // a bare index is accepted
    expect(boxIndex("8")).toBe(8);
    // unparseable
    expect(boxIndex("grok-box-x")).toBeUndefined();
  });

  test("ss argv", () => {
    expect(ssArgv()).toEqual(["ss", "-tln"]);
  });
});

describe("tunnelUp probe", () => {
  test("true when 127.0.0.1:<port> is listening", async () => {
    const r = new FakeRunner(() =>
      result({ stdout: "LISTEN 0 128 127.0.0.1:20008 0.0.0.0:*\n" }),
    );
    expect(await tunnelUp(r, "grok-box-008")).toBe(true);
  });
  test("false when the port is not listening", async () => {
    const r = new FakeRunner(() =>
      result({ stdout: "LISTEN 0 128 127.0.0.1:20009 0.0.0.0:*\n" }),
    );
    expect(await tunnelUp(r, "grok-box-008")).toBe(false);
  });
  test("false when ss fails", async () => {
    const r = new FakeRunner(() => result({ code: 1 }));
    expect(await tunnelUp(r, "grok-box-008")).toBe(false);
  });
});
