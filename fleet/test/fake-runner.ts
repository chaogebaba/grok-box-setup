// fake-runner.ts — a scripted Runner for the box-free test suite.
//
// Every test injects a FakeRunner that records the argv of each call and
// returns a scripted result chosen by a matcher. This is the sole seam between
// the fleet2 logic and a real process, so every path is exercised without a box.

import type { Runner, RunOpts, RunResult } from "../src/runner.ts";

export interface RecordedCall {
  argv: string[];
  opts: RunOpts;
}

export type Responder = (argv: string[], opts: RunOpts, callIndex: number) => Partial<RunResult>;

const OK: RunResult = { code: 0, signal: null, stdout: "", stderr: "", timedOut: false };

/** Merge a partial result over the ok default. */
export function result(p: Partial<RunResult>): RunResult {
  return { ...OK, ...p };
}

export class FakeRunner implements Runner {
  readonly calls: RecordedCall[] = [];
  private responder: Responder;

  constructor(responder?: Responder) {
    this.responder = responder ?? (() => ({}));
  }

  /** Replace the responder mid-test. */
  setResponder(r: Responder): void {
    this.responder = r;
  }

  async run(argv: string[], opts: RunOpts): Promise<RunResult> {
    const idx = this.calls.length;
    this.calls.push({ argv, opts });
    return result(this.responder(argv, opts, idx));
  }

  /** All recorded argv arrays, for order assertions. */
  argvs(): string[][] {
    return this.calls.map((c) => c.argv);
  }

  /** The joined command string of each call (helpful for matching). */
  joined(): string[] {
    return this.calls.map((c) => c.argv.join(" "));
  }
}

/** Convenience: does an argv look like an ssh call carrying `needle` in its cmd? */
export function isSshWith(argv: string[], needle: string): boolean {
  return argv[0] === "ssh" && argv.some((a) => a.includes(needle));
}

/** Convenience: is this a scp call? */
export function isScp(argv: string[]): boolean {
  return argv[0] === "scp";
}

/** Convenience: is this the ss listener probe? */
export function isSs(argv: string[]): boolean {
  return argv[0] === "ss";
}
