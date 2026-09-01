// enroll.test.ts — T1 enroll (D10). Drives cmdEnroll with a stubbed
// EnrollSideEffects (mirrors bash enroll_run) + the pure helpers.

import { describe, test, expect } from "bun:test";
import {
  cmdEnroll,
  authorizedKeysLine,
  permitlistenVerdict,
  waitTunnel,
  parseEnrollArgs,
  WRITE_BOX_CONFIG_REMOTE,
  type EnrollSideEffects,
} from "../../src/commands/enroll.ts";
import { setLogSink } from "../../src/log.ts";

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  return { lines, restore: () => setLogSink(prev) };
}

interface Recorder {
  enrolled: Array<{ box: string; port: number }>;
  wrote: boolean;
  installedVpsKey: boolean;
  installedBoxKey: boolean;
}

/** A default-happy EnrollSideEffects; tests override individual members. */
function happySE(over: Partial<EnrollSideEffects> = {}, rec?: Recorder): EnrollSideEffects {
  const base: EnrollSideEffects = {
    async vpsUserExists() { return true; },
    async haveSshd() { return false; }, // no sshd ⇒ policy precheck skipped by default
    async sshdEffective() { return undefined; },
    fleetVpsAddr() { return "1.2.3.4"; },
    fleetVpsPort() { return "22"; },
    async aclHasFleetBrainTagowner() { return 0; },
    lastApiCode() { return 200; },
    async readBoxPubkey() { return "ssh-ed25519 AAAAC3xyz grok-tunnel"; },
    async tunnelUp() { return false; },
    async installVpsAuthorizedKey() { if (rec) rec.installedVpsKey = true; return true; },
    async recordEtcMapping() { return true; },
    async vpsBoxAccessPubkey() { return "ssh-ed25519 AAAAvpskey vps"; },
    async installBoxAuthorizedKey() { if (rec) rec.installedBoxKey = true; return true; },
    async writeBoxConfig() { if (rec) rec.wrote = true; return 0; },
    async recordEnrolled(box, port) { rec?.enrolled.push({ box, port }); },
    async notify() {},
    tunnelWaitBudget() { return "0"; }, // skip the wait by default
    async sleep5() {},
  };
  return { ...base, ...over };
}

describe("T1 enroll pure helpers", () => {
  test("authorized_keys_line shape: restrict + permitlisten 127.0.0.1:<port> (main:1035)", () => {
    expect(authorizedKeysLine(20008, "ssh-ed25519 KEY c")).toBe(
      'restrict,port-forwarding,permitlisten="127.0.0.1:20008" ssh-ed25519 KEY c',
    );
  });

  test("permitlisten_verdict: allowed(0) / unknown(1) / denied(2), every token parsed (F2)", () => {
    expect(permitlistenVerdict("permitlisten 127.0.0.1:20008\n", 20008)).toBe(0);
    expect(permitlistenVerdict("permitlisten any\n", 20008)).toBe(0);
    expect(permitlistenVerdict("permitlisten 127.0.0.1:20001 127.0.0.1:20008\n", 20008)).toBe(0);
    expect(permitlistenVerdict("permitlisten 127.0.0.1:20001\n", 20008)).toBe(2);
    expect(permitlistenVerdict("compression no\n", 20008)).toBe(1); // no permitlisten token
    expect(permitlistenVerdict(undefined, 20008)).toBe(1); // sshd -T failed
  });

  test("write-box-config remote script wrapper is apostrophe-scannable (E1: no bare ' outside awk)", () => {
    // The awk body legitimately carries apostrophes-as-awk-quotes; the point of
    // E1 is that the OUTER `sudo sh -s` wrapper (built in enroll-wiring) has none.
    // Here we assert the script is a non-empty POSIX-sh literal beginning `set -e`.
    expect(WRITE_BOX_CONFIG_REMOTE.trim().startsWith("set -e")).toBe(true);
    expect(WRITE_BOX_CONFIG_REMOTE).toContain("mktemp");
  });

  test("parse args: --no-box-config order-independent; sole positional; empty ⇒ usage", () => {
    expect(parseEnrollArgs(["grok-box-8"])).toEqual({ box: "grok-box-8", writeBoxConfig: true });
    expect(parseEnrollArgs(["--no-box-config", "grok-box-8"])).toEqual({ box: "grok-box-8", writeBoxConfig: false });
    expect(parseEnrollArgs(["grok-box-8", "--no-box-config"])).toEqual({ box: "grok-box-8", writeBoxConfig: false });
    expect(parseEnrollArgs([])).toEqual({ usage: true });
  });
});

describe("T1 enroll_wait_tunnel (D3/F1/F5)", () => {
  test("WAIT=0 ⇒ rc 0, no probe/sleep", async () => {
    let sleeps = 0;
    let probes = 0;
    const rc = await waitTunnel("grok-box-8", happySE({ tunnelWaitBudget: () => "0", async tunnelUp() { probes++; return false; }, async sleep5() { sleeps++; } }));
    expect(rc).toBe(0);
    expect(probes).toBe(0);
    expect(sleeps).toBe(0);
  });
  test("immediate up ⇒ rc 0, logs the up line, no sleep", async () => {
    const cap = captureLog();
    let sleeps = 0;
    const rc = await waitTunnel("grok-box-8", happySE({ tunnelWaitBudget: () => "90", async tunnelUp() { return true; }, async sleep5() { sleeps++; } }));
    cap.restore();
    expect(rc).toBe(0);
    expect(sleeps).toBe(0);
    expect(cap.lines.some((l) => l.includes("grok-box-8 tunnel up on 127.0.0.1:20008"))).toBe(true);
  });
  test("up on the 3rd poll ⇒ rc 0 after 2 sleeps", async () => {
    let calls = 0;
    let sleeps = 0;
    const rc = await waitTunnel("grok-box-8", happySE({ tunnelWaitBudget: () => "90", async tunnelUp() { calls++; return calls >= 3; }, async sleep5() { sleeps++; } }));
    expect(rc).toBe(0);
    expect(sleeps).toBe(2);
  });
  test("never up, WAIT=1 ⇒ rc 4 WITHOUT sleeping (timeout-before-sleep, F5)", async () => {
    const cap = captureLog();
    let sleeps = 0;
    const rc = await waitTunnel("grok-box-8", happySE({ tunnelWaitBudget: () => "1", async tunnelUp() { return false; }, async sleep5() { sleeps++; } }));
    cap.restore();
    expect(rc).toBe(4);
    expect(sleeps).toBe(0);
    expect(cap.lines.some((l) => l.includes("tunnel NOT up after 1s"))).toBe(true);
  });
  test("non-numeric ⇒ warn + fall back to 90 (F5)", async () => {
    const cap = captureLog();
    const rc = await waitTunnel("grok-box-8", happySE({ tunnelWaitBudget: () => "abc", async tunnelUp() { return true; } }));
    cap.restore();
    expect(rc).toBe(0);
    expect(cap.lines.some((l) => l.includes("is not a non-negative integer — using 90"))).toBe(true);
  });
});

describe("T1 cmd_enroll integration (F4/D4/D3/F7/m1)", () => {
  test("usage: no box ⇒ rc 2", async () => {
    const cap = captureLog();
    const rc = await cmdEnroll([], happySE());
    cap.restore();
    expect(rc).toBe(2);
    expect(cap.lines.some((l) => l.includes("usage: fleet2 enroll [--no-box-config] <grok-box-N>"))).toBe(true);
  });

  test("non-grok box ⇒ rc 2", async () => {
    const cap = captureLog();
    const rc = await cmdEnroll(["laptop"], happySE());
    cap.restore();
    expect(rc).toBe(2);
    expect(cap.lines.some((l) => l.includes("enroll: refusing non-grok box 'laptop'"))).toBe(true);
  });

  test("F4 rc 6 locality (fleet user absent) ⇒ nothing written", async () => {
    const rec: Recorder = { enrolled: [], wrote: false, installedVpsKey: false, installedBoxKey: false };
    const cap = captureLog();
    const rc = await cmdEnroll(["grok-box-8"], happySE({ async vpsUserExists() { return false; } }, rec));
    cap.restore();
    expect(rc).toBe(6);
    expect(cap.lines.some((l) => l.includes("must run on the VPS"))).toBe(true);
    expect(rec.enrolled).toEqual([]);
    expect(rec.installedVpsKey).toBe(false);
  });

  test("D4 rc 5 permitlisten DENIED ⇒ nothing written", async () => {
    const rec: Recorder = { enrolled: [], wrote: false, installedVpsKey: false, installedBoxKey: false };
    const cap = captureLog();
    const rc = await cmdEnroll(
      ["grok-box-8"],
      happySE({ async haveSshd() { return true; }, async sshdEffective() { return "permitlisten 127.0.0.1:20001\n"; } }, rec),
    );
    cap.restore();
    expect(rc).toBe(5);
    expect(cap.lines.some((l) => l.includes("does not include 127.0.0.1:20008"))).toBe(true);
    expect(rec.enrolled).toEqual([]);
    expect(rec.installedVpsKey).toBe(false);
  });

  test("m1: box-config failure ⇒ rc 1, enrolled.tsv NOT written", async () => {
    const rec: Recorder = { enrolled: [], wrote: false, installedVpsKey: false, installedBoxKey: false };
    const cap = captureLog();
    const rc = await cmdEnroll(["grok-box-8"], happySE({ async writeBoxConfig() { return 1; } }, rec));
    cap.restore();
    expect(rc).toBe(1);
    expect(rec.enrolled).toEqual([]); // NOT recorded (m1)
    expect(cap.lines.some((l) => l.includes("NOT recording enrollment"))).toBe(true);
  });

  test("box-config ABSENT (rc 4) ⇒ rc 1 + install-first message, NOT recorded", async () => {
    const rec: Recorder = { enrolled: [], wrote: false, installedVpsKey: false, installedBoxKey: false };
    const cap = captureLog();
    const rc = await cmdEnroll(["grok-box-8"], happySE({ async writeBoxConfig() { return 4; } }, rec));
    cap.restore();
    expect(rc).toBe(1);
    expect(cap.lines.some((l) => l.includes("is ABSENT on grok-box-8; run install.sh on the box first"))).toBe(true);
    expect(rec.enrolled).toEqual([]);
  });

  test("no VPS address ⇒ 4-line refusal rc 1, nothing written (D1)", async () => {
    const rec: Recorder = { enrolled: [], wrote: false, installedVpsKey: false, installedBoxKey: false };
    const cap = captureLog();
    const rc = await cmdEnroll(["grok-box-8"], happySE({ fleetVpsAddr() { return undefined; } }, rec));
    cap.restore();
    expect(rc).toBe(1);
    expect(cap.lines.some((l) => l.includes("REFUSING — no VPS address resolved"))).toBe(true);
    expect(rec.installedVpsKey).toBe(false);
  });

  test("ACL absent ⇒ rc 1 refusal", async () => {
    const cap = captureLog();
    const rc = await cmdEnroll(["grok-box-8"], happySE({ async aclHasFleetBrainTagowner() { return 1; } }));
    cap.restore();
    expect(rc).toBe(1);
    expect(cap.lines.some((l) => l.includes("has no tagOwners entry in the ACL"))).toBe(true);
  });

  test("ACL API failure (2) ⇒ rc 1 fail-closed", async () => {
    const cap = captureLog();
    const rc = await cmdEnroll(["grok-box-8"], happySE({ async aclHasFleetBrainTagowner() { return 2; }, lastApiCode() { return 503; } }));
    cap.restore();
    expect(rc).toBe(1);
    expect(cap.lines.some((l) => l.includes("ACL read FAILED (HTTP 503)"))).toBe(true);
  });

  test("happy path (WAIT=0) ⇒ rc 0, row written with the port", async () => {
    const rec: Recorder = { enrolled: [], wrote: false, installedVpsKey: false, installedBoxKey: false };
    const rc = await cmdEnroll(["grok-box-8"], happySE({}, rec));
    expect(rc).toBe(0);
    expect(rec.enrolled).toEqual([{ box: "grok-box-8", port: 20008 }]);
    expect(rec.wrote).toBe(true);
  });

  test("F7 pre-existing listener ⇒ WARNING log-only, still rc 0", async () => {
    const cap = captureLog();
    const rc = await cmdEnroll(["grok-box-8"], happySE({ async tunnelUp() { return true; } }));
    cap.restore();
    expect(rc).toBe(0);
    expect(cap.lines.some((l) => l.includes("already has a listener before enrol"))).toBe(true);
  });

  test("D3 rc 4 tunnel timeout ⇒ row STILL written (resumable)", async () => {
    const rec: Recorder = { enrolled: [], wrote: false, installedVpsKey: false, installedBoxKey: false };
    const cap = captureLog();
    // WAIT=1, tunnel never up ⇒ waitTunnel rc 4, but recordEnrolled ran first.
    const rc = await cmdEnroll(["grok-box-8"], happySE({ tunnelWaitBudget: () => "1", async tunnelUp() { return false; } }, rec));
    cap.restore();
    expect(rc).toBe(4);
    expect(rec.enrolled).toEqual([{ box: "grok-box-8", port: 20008 }]); // written despite the timeout
  });

  test("--no-box-config ⇒ skips box write, rc 0, DONE line", async () => {
    const rec: Recorder = { enrolled: [], wrote: false, installedVpsKey: false, installedBoxKey: false };
    const cap = captureLog();
    const rc = await cmdEnroll(["--no-box-config", "grok-box-8"], happySE({}, rec));
    cap.restore();
    expect(rc).toBe(0);
    expect(rec.wrote).toBe(false);
    expect(cap.lines.some((l) => l.includes("box-side [fleet] not written (--no-box-config)"))).toBe(true);
  });
});
