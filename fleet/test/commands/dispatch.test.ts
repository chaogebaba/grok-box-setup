// dispatch.test.ts — T6 dispatch/usage/version/unknown (F10, m11).

import { describe, test, expect } from "bun:test";
import { decide, emit, versionString, KNOWN_COMMANDS } from "../../src/commands/dispatch.ts";
import { USAGE } from "../../src/commands/usage.ts";

describe("T6 dispatch (main:3850-3874, F10)", () => {
  test("bare / -h / --help / help ⇒ usage on STDOUT rc 0", () => {
    for (const cmd of [undefined, "-h", "--help", "help"]) {
      const d = decide(cmd);
      expect(d.kind).toBe("help");
      let out = "";
      let err = "";
      const rc = emit(d, "", (s) => (out += s), (s) => (err += s));
      expect(rc).toBe(0);
      expect(out).toBe(USAGE);
      expect(err).toBe("");
    }
  });

  test("version ⇒ version string on stdout rc 0", () => {
    const d = decide("version");
    expect(d.kind).toBe("version");
    let out = "";
    const rc = emit(d, versionString("5.4.0", "abc1234", "1.4.0"), (s) => (out += s), () => {});
    expect(rc).toBe(0);
    expect(out).toBe("grokfleet 5.4.0 (abc1234) (bun 1.4.0)\n");
  });

  test("version string shape 5.4.0 (D17)", () => {
    expect(versionString("5.4.0", "deadbee", "1.4.0")).toBe("grokfleet 5.4.0 (deadbee) (bun 1.4.0)");
  });

  test("unknown ⇒ 'grokfleet: unknown command: X' + usage BOTH on STDERR, rc 2 (m11)", () => {
    const d = decide("frobnicate");
    expect(d.kind).toBe("unknown");
    let out = "";
    let err = "";
    const rc = emit(d, "", (s) => (out += s), (s) => (err += s));
    expect(rc).toBe(2);
    expect(out).toBe(""); // nothing on stdout
    expect(err).toBe(`grokfleet: unknown command: frobnicate\n${USAGE}`);
  });

  test("every documented subcommand is routed", () => {
    for (const cmd of KNOWN_COMMANDS) {
      const d = decide(cmd);
      expect(d.kind).toBe("route");
      expect(d.command).toBe(cmd);
    }
  });
});

describe("T6 usage text (F2/M5)", () => {
  test("VPS-side line 1; remove-timer present; NO install-timer line (M5)", () => {
    expect(USAGE.split("\n")[0]).toBe("grokfleet — grok-fleet brain (VPS-side; list/ssh also run from the laptop)");
    expect(USAGE).toContain("grokfleet remove-timer");
    expect(USAGE).not.toContain("grokfleet install-timer");
  });
  test("grokfleet wording, no fleetctl", () => {
    expect(USAGE).not.toContain("fleetctl");
    expect(USAGE).toContain("FLEET_CONFIG         config path (default /opt/grok-fleet/config.toml)");
  });
});
