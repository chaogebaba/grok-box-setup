// help-greppable.test.ts — agent-ux U5/U6: `grokfleet help` is one line per
// command, names the flags, and carries no pager/colour escapes.

import { describe, test, expect } from "bun:test";
import { USAGE } from "../../src/commands/usage.ts";
import { KNOWN_COMMANDS } from "../../src/commands/dispatch.ts";

/** Command lines are `  grokfleet <cmd> …  — <purpose>`. */
const COMMAND_LINES = USAGE.split("\n").filter((l) => /^ {2}grokfleet /.test(l));

describe("U5 greppable usage", () => {
  test("every routed command appears on a line of its own", () => {
    for (const cmd of KNOWN_COMMANDS) {
      if (cmd === "install-timer") continue; // retired, deliberately undocumented (M5/D6)
      const hit = COMMAND_LINES.some((l) => l.startsWith(`  grokfleet ${cmd}`));
      expect(hit).toBe(true);
    }
    // version and help are documented too even though they are not routed.
    expect(COMMAND_LINES.some((l) => l.startsWith("  grokfleet version"))).toBe(true);
    expect(COMMAND_LINES.some((l) => l.startsWith("  grokfleet help"))).toBe(true);
  });

  test("each command line is ONE line carrying a purpose after an em dash", () => {
    for (const l of COMMAND_LINES) {
      expect(l).toContain(" — ");
      const purpose = l.split(" — ")[1] ?? "";
      expect(purpose.trim().length).toBeGreaterThan(0);
    }
  });

  test("the flags block names every agent-facing flag", () => {
    const flags = USAGE.slice(USAGE.indexOf("\nflags:"));
    for (const f of ["--json", "--tty", "--timeout", "--no-stdin", "--apply", "--dry-run"]) {
      expect(flags).toContain(f);
    }
    expect(flags).toContain("GROKFLEET_JSON");
  });

  test("no colour, no pager escapes, no tabs", () => {
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(USAGE)).toBe(false);
    expect(USAGE).not.toContain("\t");
  });

  test("the phase-3 invariants survive the reshape (F2/M5/D16)", () => {
    expect(USAGE.split("\n")[0]).toBe("grokfleet — grok-fleet brain (VPS-side; list/ssh also run from the laptop)");
    expect(USAGE).toContain("grokfleet remove-timer");
    expect(USAGE).not.toContain("grokfleet install-timer");
    expect(USAGE).not.toContain("fleetctl");
    expect(USAGE).toContain("FLEET_CONFIG         config path (default /opt/grok-fleet/config.toml)");
    expect(USAGE).toContain("grokfleet serve");
    expect(USAGE).toContain("grokfleet tui");
  });

  test("it tells an agent the two rules it needs", () => {
    expect(USAGE).toContain("stdout is DATA, stderr is diagnostics");
    expect(USAGE).toContain("ONE quoted command string");
  });
});
