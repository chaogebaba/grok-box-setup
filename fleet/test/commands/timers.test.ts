// timers.test.ts — T6 install-timer retired + remove-timer kept (D6/F7/M5).

import { describe, test, expect } from "bun:test";
import { cmdInstallTimer, cmdRemoveTimer, INSTALL_TIMER_RETIRED_LINE } from "../../src/commands/timers.ts";
import { FakeRunner } from "../fake-runner.ts";
import { setLogSink } from "../../src/log.ts";

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  return { lines, restore: () => setLogSink(prev) };
}

describe("T6 install-timer (retired, D6)", () => {
  test("prints the retirement line, rc 2", () => {
    const cap = captureLog();
    const rc = cmdInstallTimer();
    cap.restore();
    expect(rc).toBe(2);
    expect(cap.lines.some((l) => l.includes(INSTALL_TIMER_RETIRED_LINE))).toBe(true);
    expect(INSTALL_TIMER_RETIRED_LINE).toContain("retired in 5.4.0");
  });
});

describe("T6 remove-timer (kept, F7/M5)", () => {
  test("no systemctl ⇒ rc 1 'systemctl not found'", async () => {
    const cap = captureLog();
    const rc = await cmdRemoveTimer({
      runner: new FakeRunner(),
      which: async () => undefined,
      unitDir: "/u",
      removeFile: async () => {},
    });
    cap.restore();
    expect(rc).toBe(1);
    expect(cap.lines.some((l) => l.includes("remove-timer: systemctl not found"))).toBe(true);
  });

  test("with systemctl ⇒ removes both units + daemon-reload + verbatim log rc 0", async () => {
    const cap = captureLog();
    const removed: string[] = [];
    const runner = new FakeRunner(() => ({ code: 0 }));
    const rc = await cmdRemoveTimer({
      runner,
      which: async () => "/usr/bin/systemctl",
      unitDir: "/u",
      removeFile: async (p) => {
        removed.push(p);
      },
    });
    cap.restore();
    expect(rc).toBe(0);
    expect(removed).toEqual(["/u/fleetctl-check.timer", "/u/fleetctl-check.service"]);
    // disable --now + daemon-reload ran.
    expect(runner.joined()).toContain("systemctl --user disable --now fleetctl-check.timer");
    expect(runner.joined()).toContain("systemctl --user daemon-reload");
    expect(cap.lines.some((l) => l.includes("remove-timer: removed fleetctl-check timer + service"))).toBe(true);
  });
});
