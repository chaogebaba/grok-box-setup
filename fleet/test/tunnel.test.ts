// T2 — tunnel argv (D3, F6, D11a) and index/port parsing, plus the D11(c)
// ownership-aware `tunnelUp`.

import { test, expect, describe } from "bun:test";
import { sshArgv, scpArgv, ssArgv, tunnelUp, makeWarnOnce } from "../src/tunnel.ts";
import { boxIndex, portFor } from "../src/boxes.ts";
import { FakeRunner, result } from "./fake-runner.ts";
import { setLogSink } from "../src/log.ts";

const KEY = "/etc/grok-fleet/box_access_ed25519";
const KH = "/var/lib/grok-fleet/known_hosts";

/** The four D11(a) options, in order, as they must appear on every argv. */
const KH_OPTS = [
  "-o",
  `UserKnownHostsFile=${KH}`,
  "-o",
  "GlobalKnownHostsFile=/dev/null",
  "-o",
  "HashKnownHosts=no",
  "-o",
  "CheckHostIP=no",
];

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  return { lines, restore: () => setLogSink(prev) };
}

/** One `ss -tlnp` row for 127.0.0.1:<port> with the given process column. */
function ssRow(port: number, process: string): string {
  return `LISTEN 0      128          127.0.0.1:${port}       0.0.0.0:*    ${process}\n`;
}

describe("T2 tunnel argv", () => {
  test("ssh argv is exact (D3 order, no --) and carries the D11a known-hosts options", () => {
    const argv = sshArgv("grok-box-008", KEY, "sudo /workspace/box-setup/boxup check", KH);
    expect(argv).toEqual([
      "ssh",
      "-p",
      "20008",
      "-i",
      KEY,
      "-o",
      "BatchMode=yes",
      ...KH_OPTS,
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=8",
      "box@127.0.0.1",
      "sudo /workspace/box-setup/boxup check",
    ]);
    // D11(a): the four options sit IMMEDIATELY BEFORE StrictHostKeyChecking.
    const strict = argv.indexOf("StrictHostKeyChecking=accept-new");
    expect(argv.slice(strict - 9, strict - 1)).toEqual(KH_OPTS);
    // F6/SHOULD-4: the remote command is the LAST element, appended verbatim.
    expect(argv[argv.length - 1]).toBe("sudo /workspace/box-setup/boxup check");
    expect(argv).not.toContain("--");
  });

  test("scp argv uses -P and the box@127.0.0.1:dst target, with the same options", () => {
    const argv = scpArgv("grok-box-008", KEY, "/tmp/local.tar", "/tmp/grok-box-setup-brain.tar", KH);
    expect(argv).toEqual([
      "scp",
      "-P",
      "20008",
      "-i",
      KEY,
      "-o",
      "BatchMode=yes",
      ...KH_OPTS,
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

  test("ss argv carries -p (D11b: the owner column shares this ONE call)", () => {
    expect(ssArgv()).toEqual(["ss", "-tlnp"]);
  });
});

describe("tunnelUp probe (D11c ownership)", () => {
  test("sshd-owned ⇒ up", async () => {
    const r = new FakeRunner(() => result({ stdout: ssRow(20008, 'users:(("sshd",pid=41,fd=7))') }));
    expect(await tunnelUp(r, "grok-box-008", { getuid: () => 0 })).toBe(true);
  });

  test("sshd-session-owned ⇒ up (OpenSSH >= 9.8)", async () => {
    const r = new FakeRunner(() => result({ stdout: ssRow(20008, 'users:(("sshd-session",pid=42,fd=7))') }));
    expect(await tunnelUp(r, "grok-box-008", { getuid: () => 0 })).toBe(true);
  });

  test("no matching row ⇒ down", async () => {
    const r = new FakeRunner(() => result({ stdout: ssRow(20009, 'users:(("sshd",pid=41,fd=7))') }));
    expect(await tunnelUp(r, "grok-box-008", { getuid: () => 0 })).toBe(false);
  });

  test("a FOREIGN owner ⇒ down + the squatter log line (kills mutant r)", async () => {
    const cap = capture();
    const r = new FakeRunner(() => result({ stdout: ssRow(20008, 'users:(("python3",pid=9001,fd=3))') }));
    const up = await tunnelUp(r, "grok-box-008", { getuid: () => 0 });
    cap.restore();
    expect(up).toBe(false);
    expect(cap.lines.some((l) => l.includes("held by python3[9001] — treating as down"))).toBe(true);
  });

  test("empty process column + NON-root ⇒ up, warned once per sink", async () => {
    const cap = capture();
    const warn = makeWarnOnce();
    const r = new FakeRunner(() => result({ stdout: ssRow(20008, "") }));
    const a = await tunnelUp(r, "grok-box-008", { getuid: () => 1000, warnOnce: warn });
    const b = await tunnelUp(r, "grok-box-008", { getuid: () => 1000, warnOnce: warn });
    cap.restore();
    expect(a).toBe(true);
    expect(b).toBe(true);
    // Two calls, ONE line: the dedup lives on the caller's warnOnce seam.
    expect(cap.lines.filter((l) => l.includes("listener owner unverifiable (not root)"))).toHaveLength(1);
  });

  test("empty process column AS ROOT ⇒ down (the exception is bound to its premise)", async () => {
    const cap = capture();
    const r = new FakeRunner(() => result({ stdout: ssRow(20008, "") }));
    const up = await tunnelUp(r, "grok-box-008", { getuid: () => 0 });
    cap.restore();
    expect(up).toBe(false);
    expect(cap.lines.some((l) => l.includes("owner unverifiable as root"))).toBe(true);
  });

  test("ss rc != 0 ⇒ down", async () => {
    const r = new FakeRunner(() => result({ code: 1 }));
    expect(await tunnelUp(r, "grok-box-008", { getuid: () => 0 })).toBe(false);
  });
});
