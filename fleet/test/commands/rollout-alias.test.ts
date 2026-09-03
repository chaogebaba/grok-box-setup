// rollout-alias.test.ts — T6 rollout re-based on the phase-1 engine (D3/F9/M4).

import { describe, test, expect } from "bun:test";
import { rolloutRefusal, rolloutCanaryLine, ROLLOUT_DIRTY_COMPAT_LINE } from "../../src/commands/aliases.ts";
import { setLogSink } from "../../src/log.ts";

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const prev = setLogSink((l) => lines.push(l));
  return { lines, restore: () => setLogSink(prev) };
}

describe("T6 rollout alias (F9/M4)", () => {
  test("bare rollout ⇒ 3-line refusal rc 2 (grokfleet spelling)", () => {
    const cap = captureLog();
    const rc = rolloutRefusal();
    cap.restore();
    expect(rc).toBe(2);
    expect(cap.lines[0]).toContain("rollout: refusing to guess targets. Use:");
    expect(cap.lines[1]).toContain("grokfleet rollout <box...>      deploy to explicit boxes");
    expect(cap.lines[2]).toContain("grokfleet rollout --all         deploy to the whole fleet (canary first)");
  });

  test("canary line: policy=config vs dynamic (F9), NOT hardcoded 005", () => {
    expect(rolloutCanaryLine("grok-box-008", "config")).toBe("rollout: canary=grok-box-008 (policy=config)");
    expect(rolloutCanaryLine("grok-box-3", "dynamic")).toBe("rollout: canary=grok-box-3 (policy=dynamic)");
  });

  test("--dirty accepted for compatibility, no refusal (M4)", () => {
    expect(ROLLOUT_DIRTY_COMPAT_LINE).toBe(
      "rollout: --dirty is accepted for compatibility; grokfleet deploys the resolved ref, never the working tree",
    );
    // The compat line is a WARNING-style log, never a refusal — no rc here.
    expect(ROLLOUT_DIRTY_COMPAT_LINE).not.toContain("refus");
  });
});
