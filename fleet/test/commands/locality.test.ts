// locality.test.ts — T-locality VPS-only refusal rc 6 for all five spellings
// (F2/M2). The guard is a single helper (refuseVpsOnly); cli.ts calls it for
// status/check/rollout/inventory/upgrade, never for list/ssh.

import { describe, test, expect } from "bun:test";
import { refuseVpsOnly } from "../../src/commands/locality.ts";
import { setLogSink } from "../../src/log.ts";

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  return { lines, restore: () => setLogSink(prev) };
}

describe("T-locality (F2/M2)", () => {
  test("key present ⇒ no refusal", () => {
    const cap = captureLog();
    expect(refuseVpsOnly("status", true)).toBe(false);
    cap.restore();
    expect(cap.lines.length).toBe(0);
  });

  test("no key ⇒ rc 6 line for all five spellings (M2)", () => {
    for (const cmd of ["status", "check", "rollout", "inventory", "upgrade"]) {
      const cap = captureLog();
      const refused = refuseVpsOnly(cmd, false);
      cap.restore();
      expect(refused).toBe(true);
      expect(cap.lines[0]).toContain(
        `${cmd}: VPS-only in fleet2 — this command now runs over the reverse tunnels (docs/FLEET-BRAIN.md §retirement)`,
      );
    }
  });
});
