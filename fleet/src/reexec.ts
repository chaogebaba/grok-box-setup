// reexec.ts — the flock re-exec spawn, OUTSIDE the Runner seam (gate-r1 fix 3).
//
// F2 requires the flock child to INHERIT stdio: the child IS the whole locked
// `upgrade --apply` pass, and its plan / per-box results / summary / notify
// lines must reach the operator's terminal and the journal. The Runner seam
// always PIPES stdout/stderr (so tests can assert them), which swallowed the
// child's output — the r1 gate observed the canary-down negative emit rc 1 with
// no message and successful passes emit nothing. So the re-exec must NOT go
// through the Runner; it uses `Bun.spawn({stdin/stdout/stderr:"inherit"})`.
//
// The spawner is injectable so a test can assert the inherit options + argv
// without launching a process, and a separate real-process test proves the
// child's stderr actually reaches the parent's stderr.

/** The stdio inherit options F2 mandates for the flock child. */
export interface ReexecOptions {
  stdin: "inherit";
  stdout: "inherit";
  stderr: "inherit";
  env: Record<string, string>;
}

export interface ReexecResult {
  /** child exit code, or null if it was killed by a signal */
  code: number | null;
  /** false iff the process failed to launch (ENOENT — flock not on PATH) */
  launched: boolean;
}

/** A spawner: launch `argv` with `opts`, resolve to the child's exit outcome. */
export type Spawner = (argv: string[], opts: ReexecOptions) => Promise<ReexecResult>;

/**
 * Production spawner: `Bun.spawn` with INHERITED stdio (F2). Merges `env` over
 * process.env. A launch failure (ENOENT) resolves to `{code:null, launched:false}`
 * rather than throwing, so the caller maps it to the rc-6 refusal.
 */
export const bunInheritSpawner: Spawner = async (argv, opts) => {
  try {
    const proc = Bun.spawn(argv, {
      stdin: opts.stdin,
      stdout: opts.stdout,
      stderr: opts.stderr,
      env: { ...process.env, ...opts.env },
    });
    const code = await proc.exited;
    const signal = (proc as unknown as { signalCode: string | null }).signalCode ?? null;
    return { code: signal ? null : code, launched: true };
  } catch {
    // Bun.spawn throws synchronously (rejects) when the executable is missing.
    return { code: null, launched: false };
  }
};

/**
 * Run the flock re-exec child with inherited stdio. `env` is merged over
 * process.env (the caller passes GROKFLEET_LOCKED=1). Returns the child outcome.
 */
export function spawnReexec(
  argv: string[],
  env: Record<string, string>,
  spawner: Spawner = bunInheritSpawner,
): Promise<ReexecResult> {
  return spawner(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
}
