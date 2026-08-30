// journal.test.ts — the journal filter (mutant: filter-before-truncate) + the
// word-boundary box match + journalctl-absent stub + admin scope.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readJournal, boxLineFilter, clampLines, JOURNAL_MAX_N, JOURNAL_DEFAULT_N } from "../../src/serve/journal.ts";
import { FakeRunner, result } from "../fake-runner.ts";
import { setLogSink } from "../../src/log.ts";

let restore: (l: string) => void;
beforeEach(() => {
  restore = setLogSink(() => {});
});
afterEach(() => setLogSink(restore));

describe("word-boundary box filter (grok-box-1 ∌ grok-box-12)", () => {
  test("matches the exact box, not a numeric-suffix superstring", () => {
    const f = boxLineFilter("grok-box-1");
    expect(f("... grok-box-1 tunnel up")).toBe(true);
    expect(f("... grok-box-12 tunnel up")).toBe(false);
    expect(f("... grok-box-1: check OK")).toBe(true);
    expect(f("nothing here")).toBe(false);
  });
});

describe("filter-before-truncate (mutant: truncate the raw lines first)", () => {
  test("N counts MATCHING lines, not raw lines", async () => {
    // Build 4000 lines: only every 100th mentions grok-box-1 (40 matches),
    // interleaved with grok-box-2 noise. If truncation happened BEFORE the
    // filter, tail(2) of the raw 4000 would rarely include a grok-box-1 line.
    const lines: string[] = [];
    for (let i = 0; i < 4000; i++) {
      lines.push(i % 100 === 0 ? `2026-01-01 grok-box-1 event ${i}` : `2026-01-01 grok-box-2 noise ${i}`);
    }
    const runner = new FakeRunner(() => result({ stdout: lines.join("\n"), code: 0 }));
    const r = await readJournal("grok-box-1", 2, { runner, which: () => true });
    expect(r.rc).toBe(0);
    // exactly the LAST 2 matching grok-box-1 lines, in order.
    expect(r.log.length).toBe(2);
    for (const l of r.log) expect(l).toContain("grok-box-1");
    expect(r.log[1]).toContain("event 3900"); // the last grok-box-1 line
  });
});

describe("clampLines (default 50, max 500)", () => {
  test("absent/invalid ⇒ default; over-max ⇒ max; in-range preserved", () => {
    expect(clampLines(undefined)).toBe(JOURNAL_DEFAULT_N);
    expect(clampLines(0)).toBe(JOURNAL_DEFAULT_N);
    expect(clampLines(-5)).toBe(JOURNAL_DEFAULT_N);
    expect(clampLines(9999)).toBe(JOURNAL_MAX_N);
    expect(clampLines(123)).toBe(123);
  });
});

describe("journalctl absent", () => {
  test("⇒ 200-shaped {rc:1, log:['journalctl unavailable']} (never a 500)", async () => {
    const runner = new FakeRunner(() => result({}));
    const r = await readJournal("grok-box-1", 50, { runner, which: () => false });
    expect(r).toEqual({ rc: 1, log: ["journalctl unavailable"] });
    // the runner was never invoked.
    expect(runner.calls.length).toBe(0);
  });
});

describe("journal argv", () => {
  test("queries BOTH units, short-iso, last 4000", async () => {
    const runner = new FakeRunner(() => result({ stdout: "grok-box-1 line", code: 0 }));
    await readJournal("grok-box-1", 50, { runner, which: () => true });
    const argv = runner.calls[0]!.argv;
    expect(argv).toContain("journalctl");
    expect(argv.join(" ")).toContain("-u fleet-reconcile.service");
    expect(argv.join(" ")).toContain("-u fleet-api.service");
    expect(argv.join(" ")).toContain("-o short-iso");
    expect(argv.join(" ")).toContain("-n 4000");
  });
});
