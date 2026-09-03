// dispatch-serve.test.ts — §7.2: serve/tui are in dispatch + USAGE; serve is
// VPS-only (rc 6) via the locality guard; parseServeArgs + resolveBind refusal.

import { test, expect, describe } from "bun:test";
import { KNOWN_COMMANDS, decide } from "../../src/commands/dispatch.ts";
import { USAGE } from "../../src/commands/usage.ts";
import { parseServeArgs, resolveBind, DEFAULT_PORT } from "../../src/serve/server.ts";
import { refuseVpsOnly } from "../../src/commands/locality.ts";
import { FakeRunner, result } from "../fake-runner.ts";

describe("§7.2 registration", () => {
  test("serve + tui are KNOWN_COMMANDS and route", () => {
    expect(KNOWN_COMMANDS).toContain("serve");
    expect(KNOWN_COMMANDS).toContain("tui");
    expect(decide("serve")).toEqual({ kind: "route", command: "serve" });
    expect(decide("tui")).toEqual({ kind: "route", command: "tui" });
  });
  test("USAGE documents serve + tui", () => {
    expect(USAGE).toContain("grokfleet serve");
    expect(USAGE).toContain("grokfleet tui");
  });
});

describe("§7.2 serve locality (VPS-only rc 6)", () => {
  test("refuseVpsOnly refuses when the box key is absent", () => {
    // serve routes through refuseIfNoKey ⇒ refuseVpsOnly (rc 6) off the VPS.
    expect(refuseVpsOnly("serve", /*keyExists*/ false)).toBe(true);
    expect(refuseVpsOnly("serve", /*keyExists*/ true)).toBe(false);
  });
});

describe("parseServeArgs", () => {
  test("defaults, --bind, --port, bad port, unknown flag", () => {
    expect(parseServeArgs([])).toEqual({});
    expect(parseServeArgs(["--bind", "100.64.0.1"])).toEqual({ bind: "100.64.0.1" });
    expect(parseServeArgs(["--port", "9999"])).toEqual({ port: 9999 });
    expect(parseServeArgs(["--port", "0"])).toHaveProperty("err");
    expect(parseServeArgs(["--port", "70000"])).toHaveProperty("err");
    expect(parseServeArgs(["--bogus"])).toHaveProperty("err");
  });
  test("DEFAULT_PORT is 9891 (TUI-D2)", () => {
    expect(DEFAULT_PORT).toBe(9891);
  });
});

describe("resolveBind (TUI-D2)", () => {
  test("--bind override wins without calling tailscale", async () => {
    const runner = new FakeRunner(() => result({}));
    expect(await resolveBind(runner, "10.0.0.5")).toBe("10.0.0.5");
    expect(runner.calls.length).toBe(0);
  });
  test("tailscale ip -4 first line is used", async () => {
    const runner = new FakeRunner((argv) =>
      argv.join(" ") === "tailscale ip -4" ? result({ stdout: "100.64.0.9\nfd7a::1\n", code: 0 }) : result({}),
    );
    expect(await resolveBind(runner, undefined)).toBe("100.64.0.9");
  });
  test("tailscale absent/empty/error ⇒ undefined (caller refuses rc 6)", async () => {
    const errRunner = new FakeRunner(() => result({ code: 1 }));
    expect(await resolveBind(errRunner, undefined)).toBeUndefined();
    const emptyRunner = new FakeRunner(() => result({ stdout: "\n", code: 0 }));
    expect(await resolveBind(emptyRunner, undefined)).toBeUndefined();
  });
});
