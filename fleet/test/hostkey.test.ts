// hostkey.test.ts — D11(a)/(b)/(c): the engine's own known_hosts, the listener
// ownership parse and the fail-closed forget.
//
// The `ss -tlnp` fixtures are the AUTHORITY for the ownership check: its refuse
// branch cannot be reached on live hardware (a healthy VPS never has a foreign
// listener on a member port to measure), so the parse is pinned here instead.
// The accepting form was recorded on the production VPS (OpenSSH 9.6p1), which
// shows `sshd`; OpenSSH >= 9.8 creates forwarded listeners from `sshd-session`.

import { test, expect, describe } from "bun:test";
import {
  KNOWN_HOSTS_OPTS,
  forgetHostKeys,
  isHostKeyMismatch,
  knownHostsFile,
  listenerOwner,
  ownerAccepted,
  ssArgv,
} from "../src/hostkey.ts";
import { FakeRunner, result } from "./fake-runner.ts";
import { testEnv } from "./helpers.ts";

const PORT = 20003;
const FILE = "/var/lib/grok-fleet/known_hosts";

const HEADER = "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process\n";

/** The eight committed `ss -tlnp` cases D11(b)/(c) enumerate. */
const SS = {
  sshd: HEADER + `LISTEN 0 128 127.0.0.1:${PORT} 0.0.0.0:* users:(("sshd",pid=41,fd=7))\n`,
  sshdSession: HEADER + `LISTEN 0 128 127.0.0.1:${PORT} 0.0.0.0:* users:(("sshd-session",pid=42,fd=7))\n`,
  sshdDisplay: HEADER + `LISTEN 0 128 127.0.0.1:${PORT} 0.0.0.0:* users:(("sshd: fleet",pid=43,fd=7))\n`,
  python3: HEADER + `LISTEN 0 128 127.0.0.1:${PORT} 0.0.0.0:* users:(("python3",pid=9001,fd=3))\n`,
  emptyColumn: HEADER + `LISTEN 0 128 127.0.0.1:${PORT} 0.0.0.0:*\n`,
  otherPort: HEADER + `LISTEN 0 128 127.0.0.1:20009 0.0.0.0:* users:(("sshd",pid=41,fd=7))\n`,
} as const;

describe("D11(a) the engine's own known_hosts", () => {
  test("knownHostsFile is $FLEET_STATE/known_hosts", () => {
    expect(knownHostsFile(testEnv({ FLEET_STATE: "/var/lib/grok-fleet" }))).toBe(FILE);
  });

  test("KNOWN_HOSTS_OPTS names the file and disarms the three ways a pin escapes it", () => {
    expect(KNOWN_HOSTS_OPTS(FILE)).toEqual([
      "-o",
      `UserKnownHostsFile=${FILE}`,
      // the global file is otherwise still consulted and never touched by -R
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      // hashed entries defeat -F and an operator reading the file
      "-o",
      "HashKnownHosts=no",
      // an IP-keyed entry would survive `-R <name>`
      "-o",
      "CheckHostIP=no",
    ]);
  });
});

describe("D11(c) isHostKeyMismatch", () => {
  const BANNER = "@@@@@@\nWARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n@@@@@@\n";

  test("255 + the banner ⇒ true", () => {
    expect(isHostKeyMismatch({ code: 255, stderr: BANNER })).toBe(true);
  });

  test("255 WITHOUT the banner ⇒ false", () => {
    expect(isHostKeyMismatch({ code: 255, stderr: "ssh: connect to host port 22: Connection refused" })).toBe(false);
  });

  test("rc 0 with the banner text in the output ⇒ false", () => {
    expect(isHostKeyMismatch({ code: 0, stderr: BANNER })).toBe(false);
  });

  test("the bare 'Host key verification failed' text is NOT a mismatch", () => {
    // Under accept-new an UNKNOWN key is accepted, so that text means an
    // unwritable/unparsable file, a revoked key or a DNS-spoof warning — none
    // of which a forget cures.
    expect(isHostKeyMismatch({ code: 255, stderr: "Host key verification failed.\n" })).toBe(false);
  });
});

describe("D11(b) listenerOwner (fixture-pinned)", () => {
  test("sshd-owned", () => {
    expect(listenerOwner({ code: 0, stdout: SS.sshd }, PORT)).toEqual({ state: "owned", comm: "sshd", pid: 41 });
  });
  test("sshd-session-owned", () => {
    expect(listenerOwner({ code: 0, stdout: SS.sshdSession }, PORT)).toEqual({
      state: "owned",
      comm: "sshd-session",
      pid: 42,
    });
  });
  test("the `sshd: fleet` display form", () => {
    expect(listenerOwner({ code: 0, stdout: SS.sshdDisplay }, PORT)).toEqual({
      state: "owned",
      comm: "sshd: fleet",
      pid: 43,
    });
  });
  test("python3-owned", () => {
    expect(listenerOwner({ code: 0, stdout: SS.python3 }, PORT)).toEqual({
      state: "owned",
      comm: "python3",
      pid: 9001,
    });
  });
  test("the row exists with an EMPTY process column ⇒ unknown", () => {
    expect(listenerOwner({ code: 0, stdout: SS.emptyColumn }, PORT)).toEqual({ state: "unknown" });
  });
  test("ss rc != 0 ⇒ unknown", () => {
    expect(listenerOwner({ code: 1, stdout: "" }, PORT)).toEqual({ state: "unknown" });
  });
  test("no matching row ⇒ absent", () => {
    expect(listenerOwner({ code: 0, stdout: SS.otherPort }, PORT)).toEqual({ state: "absent" });
  });

  test("the accepted set is the three sshd display forms and nothing else", () => {
    expect(ownerAccepted("sshd")).toBe(true);
    expect(ownerAccepted("sshd-session")).toBe(true);
    expect(ownerAccepted("sshd: fleet")).toBe(true);
    expect(ownerAccepted("python3")).toBe(false);
    expect(ownerAccepted("nginx")).toBe(false);
  });
});

describe("D11(b) forgetHostKeys", () => {
  const both = { file: FILE, box: "grok-box-003", port: PORT, why: "enrol" as const };

  test("an ABSENT file spawns no process at all", async () => {
    const lines: string[] = [];
    const runner = new FakeRunner();
    await forgetHostKeys(runner, { ...both, access: () => "absent", log: (l) => lines.push(l) });
    expect(runner.calls).toHaveLength(0);
    expect(lines.some((l) => l.includes("absent"))).toBe(true);
  });

  test("an UNWRITABLE file spawns no process and says so", async () => {
    const lines: string[] = [];
    const runner = new FakeRunner();
    await forgetHostKeys(runner, { ...both, access: () => "unwritable", log: (l) => lines.push(l) });
    expect(runner.calls).toHaveLength(0);
    expect(lines.some((l) => l.includes("not writable — pins not forgotten"))).toBe(true);
  });

  test("sshd-owned ⇒ BOTH specs forgotten, exact argv", async () => {
    const lines: string[] = [];
    const runner = new FakeRunner((argv) => (argv[0] === "ss" ? result({ stdout: SS.sshd }) : result({})));
    await forgetHostKeys(runner, { ...both, access: () => "ok", log: (l) => lines.push(l) });
    expect(runner.argvs()).toEqual([
      ssArgv(),
      ["ssh-keygen", "-R", `[127.0.0.1]:${PORT}`, "-f", FILE],
      ["ssh-keygen", "-R", "grok-box-003", "-f", FILE],
    ]);
    expect(lines.some((l) => l === "hostkey: forgot pins for grok-box-003 (enrol)")).toBe(true);
  });

  test("an ABSENT listener ⇒ both specs forgotten (nothing can be fooled yet)", async () => {
    const runner = new FakeRunner((argv) => (argv[0] === "ss" ? result({ stdout: SS.otherPort }) : result({})));
    await forgetHostKeys(runner, { ...both, access: () => "ok", log: () => {} });
    expect(runner.argvs()).toEqual([
      ssArgv(),
      ["ssh-keygen", "-R", `[127.0.0.1]:${PORT}`, "-f", FILE],
      ["ssh-keygen", "-R", "grok-box-003", "-f", FILE],
    ]);
  });

  test("python3-owned ⇒ the TUNNEL pin is KEPT with an ERROR, the tailnet pin is forgotten (kills mutant m)", async () => {
    const lines: string[] = [];
    const runner = new FakeRunner((argv) => (argv[0] === "ss" ? result({ stdout: SS.python3 }) : result({})));
    await forgetHostKeys(runner, { ...both, access: () => "ok", log: (l) => lines.push(l) });
    expect(runner.argvs()).toEqual([ssArgv(), ["ssh-keygen", "-R", "grok-box-003", "-f", FILE]]);
    expect(
      lines.some((l) => l.includes("owner python3[9001] not accepted — pin kept, refusing to re-pin")),
    ).toBe(true);
  });

  test("an UNVERIFIABLE owner ⇒ the tunnel pin is kept too (fail-closed)", async () => {
    const lines: string[] = [];
    const runner = new FakeRunner((argv) => (argv[0] === "ss" ? result({ stdout: SS.emptyColumn }) : result({})));
    await forgetHostKeys(runner, { ...both, access: () => "ok", log: (l) => lines.push(l) });
    expect(runner.argvs()).toEqual([ssArgv(), ["ssh-keygen", "-R", "grok-box-003", "-f", FILE]]);
    expect(lines.some((l) => l.includes("owner unknown not accepted"))).toBe(true);
  });

  test("scope 'tailnet' forgets ONLY <box> and never probes the listener", async () => {
    const runner = new FakeRunner(() => result({}));
    await forgetHostKeys(runner, {
      file: FILE,
      box: "grok-box-003",
      port: PORT,
      scope: "tailnet",
      why: "probe",
      access: () => "ok",
      log: () => {},
    });
    expect(runner.argvs()).toEqual([["ssh-keygen", "-R", "grok-box-003", "-f", FILE]]);
  });
});
