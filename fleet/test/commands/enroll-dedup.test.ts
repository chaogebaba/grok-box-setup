// enroll-dedup.test.ts — the D5 idempotency CHANGE (zero-touch join).
//
// installVpsAuthorizedKey used to dedup by key material alone, so a box that
// regenerated tunnel_ed25519 left a stale line behind carrying the SAME
// permitlisten="127.0.0.1:<port>". The port then authorised a key the box no
// longer held, and repair could never converge. These tests drive the REAL
// wiring against a tmp root.

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  makeEnrollSideEffects,
  supersededAuthorizedKeysLine,
  vpsAuthorizedKeysPath,
} from "../../src/commands/enroll-wiring.ts";
import { authorizedKeysLine } from "../../src/commands/enroll.ts";
import { FakeRunner, result } from "../fake-runner.ts";
import { testEnv } from "../helpers.ts";
import { parseConfig } from "../../src/config.ts";

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function scratch(): { env: ReturnType<typeof testEnv>; ak: string; map: string } {
  const root = mkdtempSync(`${tmpdir()}/grokfleet-dedup-`);
  roots.push(root);
  const etc = `${root}/etc`;
  mkdirSync(etc, { recursive: true });
  mkdirSync(`${root}/home/.ssh`, { recursive: true });
  savedEnv.FLEET_VPS_AUTHKEYS = process.env.FLEET_VPS_AUTHKEYS;
  savedEnv.FLEET_ETC_AK_DIR = process.env.FLEET_ETC_AK_DIR;
  process.env.FLEET_VPS_AUTHKEYS = `${root}/home/.ssh/authorized_keys`;
  process.env.FLEET_ETC_AK_DIR = `${etc}/authorized-keys.d`;
  return { env: testEnv({ FLEET_ETC: etc }), ak: `${root}/home/.ssh/authorized_keys`, map: `${etc}/authorized-keys.map` };
}

afterEach(() => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const OLD_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAIold";
const NEW_KEY = "AAAAC3NzaC1lZDI1NTE5AAAAInew";

describe("D5 dedup by permitlisten port OR key material", () => {
  test("supersededAuthorizedKeysLine matches on the port and on the key", () => {
    const fresh = authorizedKeysLine(20003, `ssh-ed25519 ${NEW_KEY} c`);
    const stalePort = authorizedKeysLine(20003, `ssh-ed25519 ${OLD_KEY} c`);
    const sameKeyOtherPort = authorizedKeysLine(20009, `ssh-ed25519 ${NEW_KEY} c`);
    const unrelated = authorizedKeysLine(20009, `ssh-ed25519 ${OLD_KEY} c`);
    expect(supersededAuthorizedKeysLine(stalePort, fresh)).toBe(true); // same port
    expect(supersededAuthorizedKeysLine(sameKeyOtherPort, fresh)).toBe(true); // same key
    expect(supersededAuthorizedKeysLine(unrelated, fresh)).toBe(false);
  });

  test("re-adopting after a ROTATED box pubkey leaves exactly ONE line for that port", async () => {
    const { env, ak, map } = scratch();
    const se = makeEnrollSideEffects(env, parseConfig(""), new FakeRunner(() => result({})), { password: "pw" });
    expect(vpsAuthorizedKeysPath()).toBe(ak);

    const oldLine = authorizedKeysLine(20003, `ssh-ed25519 ${OLD_KEY} grok-tunnel`);
    expect(await se.installVpsAuthorizedKey(oldLine)).toBe(true);
    expect(await se.recordEtcMapping("grok-box-003", 20003, oldLine)).toBe(true);

    // The box regenerates its tunnel key and is adopted again.
    const newLine = authorizedKeysLine(20003, `ssh-ed25519 ${NEW_KEY} grok-tunnel`);
    expect(await se.installVpsAuthorizedKey(newLine)).toBe(true);
    expect(await se.recordEtcMapping("grok-box-003", 20003, newLine)).toBe(true);

    const lines = readFileSync(ak, "utf8").split("\n").filter((l) => l !== "");
    expect(lines.filter((l) => l.includes('permitlisten="127.0.0.1:20003"'))).toHaveLength(1);
    expect(lines[0]).toBe(newLine);
    expect(lines.some((l) => l.includes(OLD_KEY))).toBe(false);

    const mapRows = readFileSync(map, "utf8").split("\n").filter((l) => l !== "");
    expect(mapRows).toEqual([`grok-box-003\t20003\t${NEW_KEY}`]);
  });

  test("an unrelated box's line for a DIFFERENT port survives untouched", async () => {
    const { env, ak } = scratch();
    const se = makeEnrollSideEffects(env, parseConfig(""), new FakeRunner(() => result({})), { password: "pw" });
    const other = authorizedKeysLine(20009, "ssh-ed25519 AAAAother grok-tunnel");
    writeFileSync(ak, other + "\n");
    await se.installVpsAuthorizedKey(authorizedKeysLine(20003, `ssh-ed25519 ${NEW_KEY} grok-tunnel`));
    const lines = readFileSync(ak, "utf8").split("\n").filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    expect(lines).toContain(other);
  });

  test("the /etc map keeps ONE entry per port even if a port changed hands", async () => {
    const { env, map } = scratch();
    const se = makeEnrollSideEffects(env, parseConfig(""), new FakeRunner(() => result({})), { password: "pw" });
    await se.recordEtcMapping("grok-box-3", 20003, authorizedKeysLine(20003, `ssh-ed25519 ${OLD_KEY} c`));
    await se.recordEtcMapping("grok-box-003", 20003, authorizedKeysLine(20003, `ssh-ed25519 ${NEW_KEY} c`));
    const rows = readFileSync(map, "utf8").split("\n").filter((l) => l !== "");
    expect(rows).toEqual([`grok-box-003\t20003\t${NEW_KEY}`]);
  });
});
