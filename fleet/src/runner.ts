// runner.ts — the ONE process-execution seam (D2, F4).
//
// Every external process (ssh, scp, ss, flock, git, truncate-via-ssh) goes
// through Runner.run. No `Bun.$` anywhere for remote work — `Bun.$` has no
// timeout (research §5). Tests inject a FakeRunner that records argv and returns
// scripted results, so the whole surface is box-free under `bun test`.

export interface RunOpts {
  /** Bytes to write to the child's stdin. When absent, stdin is "ignore". */
  stdin?: string | Uint8Array;
  /** grokfleet's own deadline; on elapse the child gets SIGKILL. */
  timeoutMs: number;
  /** Extra environment for the child (merged over process.env). */
  env?: Record<string, string>;
}

export interface RunResult {
  /** Exit code, or null iff the child was killed (signal/timeout). */
  code: number | null;
  /** Terminating signal name, or null. */
  signal: string | null;
  stdout: string;
  stderr: string;
  /** True iff grokfleet's deadline elapsed and it sent SIGKILL. */
  timedOut: boolean;
}

/** Classification of a RunResult for the F4 rules. */
export type RunClass = "ok" | "transport" | "killed" | "remote";

/**
 * Classify a result (F4): transport = code 255; killed = code null; remote =
 * any other non-zero; ok = code 0.
 */
export function classify(r: RunResult): RunClass {
  if (r.code === 0) return "ok";
  if (r.code === null) return "killed";
  if (r.code === 255) return "transport";
  return "remote";
}

export interface Runner {
  run(argv: string[], opts: RunOpts): Promise<RunResult>;
}

/** Production Runner backed by Bun.spawn. */
export class BunRunner implements Runner {
  async run(argv: string[], opts: RunOpts): Promise<RunResult> {
    const decoder = new TextDecoder();
    const proc = Bun.spawn(argv, {
      stdin: opts.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: opts.timeoutMs,
      killSignal: "SIGKILL",
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });

    if (opts.stdin !== undefined && proc.stdin) {
      const w = proc.stdin as unknown as {
        write: (c: string | Uint8Array) => void;
        end: () => void;
      };
      w.write(opts.stdin);
      w.end();
    }

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    // Bun exposes .killed and .signalCode after exit; timedOut is inferred from
    // the killSignal we set combined with a kill from the timeout path.
    const signal = (proc as unknown as { signalCode: string | null }).signalCode ?? null;
    const killedByUs = (proc as unknown as { killed: boolean }).killed === true;
    void decoder;
    return {
      code: signal ? null : code,
      signal,
      stdout,
      stderr,
      timedOut: killedByUs && signal === "SIGKILL",
    };
  }
}
