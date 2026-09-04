// jobs.ts — the wire contract between the brain and `boxup job` (blueprint
// grokfleet-jobs J2/J5/J9).
//
// The box is AUTHORITATIVE about a job. The brain never infers a job's state
// from its own bookkeeping: it asks `boxup job status <id>`, which answers with
// ONE key=value line, and everything below is the parsing and translation of
// that line. Two of those fields exist purely because inference is banned:
//
//   truncations      the box's monotonic count of log truncations. The brain
//                    detects a truncation ONLY from this rising (J6/r6-B1). A
//                    size comparison misses a fast writer whose new generation
//                    has already grown past the old offset, and would splice a
//                    stale byte range into the mirror.
//   truncated_total  cumulative bytes discarded, so the mirror can state how
//                    much was never fetched rather than going quiet about it.
//
// The box's state vocabulary is NOT the brain's. `lost:died` and
// `lost:image-swap` are one brain state (`lost`) plus a reason, because the
// difference matters to a person reading an alert, not to the state machine.

/** The two kinds. `kind` changes the watchdog and the restart policy, nothing else. */
export type JobKind = "run" | "service";

/** The brain's state set (J4). The box's is different — see `stateFromBox`. */
export type JobState =
  | "starting"
  | "running"
  | "done"
  | "failed"
  | "timeout"
  | "stopped"
  | "lost"
  | "crashloop";

/** Terminal states: the poller stops, the lease is released, an alert may fire. */
export const TERMINAL_STATES: readonly JobState[] = [
  "done",
  "failed",
  "timeout",
  "stopped",
  "lost",
  "crashloop",
];

export function isTerminal(s: JobState): boolean {
  return TERMINAL_STATES.includes(s);
}

/** J11: the terminal states that raise an alert. `done`/`stopped` are silent. */
export const ALERTING_STATES: readonly JobState[] = ["failed", "timeout", "lost", "crashloop"];

/** J2: the `box-run.sh` default, and the cap a `run` gets when none is named. */
export const JOB_DEFAULT_CAP_S = 2400;
/** J2: the largest cap, equal to the lease max TTL. */
export const JOB_MAX_CAP_S = 86400;
/** J5: at most this many log bytes per poll, matching the box's own per-call bound. */
export const JOB_LOG_FETCH_MAX = 1024 * 1024;
/** J6: the brain stops mirroring at the same bound the box truncates at. */
export const JOB_LOG_MIRROR_MAX = 64 * 1024 * 1024;
/** J5: the cumulative ssh budget one tick may spend polling jobs. */
export const JOB_POLL_BUDGET_S = 60;
/** J5/J7: every box ssh in this feature is bounded by the same deadline. */
export const JOB_SSH_TIMEOUT_MS = 20_000;
/** boxup 5.5.0 is the first version with the runner (J3). */
export const JOB_RUNNER_MIN_BOXUP = "5.5.0";

/** The parsed `boxup job status <id>` line. Absent fields are `undefined`. */
export interface BoxJobStatus {
  /** the box's own vocabulary, verbatim — e.g. `running`, `lost:image-swap`. */
  boxState: string;
  pid: number | undefined;
  pgid: number | undefined;
  rc: number | undefined;
  started: string | undefined;
  ended: string | undefined;
  logBytes: number;
  truncations: number;
  truncatedTotal: number;
}

/** `-` is the box's "no value"; so is an empty field. */
function field(v: string | undefined): string | undefined {
  if (v === undefined || v === "" || v === "-") return undefined;
  return v;
}
function num(v: string | undefined): number | undefined {
  const s = field(v);
  if (s === undefined || !/^[0-9]+$/.test(s)) return undefined;
  return Number.parseInt(s, 10);
}

/**
 * Parse the ONE status line. Returns undefined when the line carries no
 * `state=` — which is how a truncated pipe, an ssh banner or a boxup too old to
 * know `job` all look. The caller treats that as "no reading", never as a
 * state: a job whose status we could not read has not changed.
 */
export function parseJobStatus(stdout: string): BoxJobStatus | undefined {
  // The line may arrive with other output around it (a login banner, a warning
  // boxup wrote to stdout), so find the one that carries `state=` rather than
  // assuming it is the only line.
  const line = stdout.split("\n").find((l) => /(^|\s)state=/.test(l));
  if (line === undefined) return undefined;
  const kv = new Map<string, string>();
  for (const tok of line.trim().split(/\s+/)) {
    const eq = tok.indexOf("=");
    if (eq > 0) kv.set(tok.slice(0, eq), tok.slice(eq + 1));
  }
  const boxState = field(kv.get("state"));
  if (boxState === undefined) return undefined;
  return {
    boxState,
    pid: num(kv.get("pid")),
    pgid: num(kv.get("pgid")),
    rc: num(kv.get("rc")),
    started: field(kv.get("started")),
    ended: field(kv.get("ended")),
    logBytes: num(kv.get("log_bytes")) ?? 0,
    truncations: num(kv.get("truncations")) ?? 0,
    truncatedTotal: num(kv.get("truncated_total")) ?? 0,
  };
}

export interface MappedState {
  state: JobState;
  lostReason: string | null;
}

/**
 * Translate the box's vocabulary into the brain's (J4).
 *
 * `unknown` — the box has no record at all — is `lost:no-record`, not an error:
 * a record can legitimately disappear (the box-side 7-day prune, a `--forget`
 * retire, an operator clearing `/workspace/jobs`), and the row must reach a
 * terminal state rather than being polled forever.
 *
 * A box state this function does not recognise is ALSO `lost`, carrying the raw
 * string as its reason. Guessing `running` for an unknown token would keep a
 * job polling forever against a box that is telling us something we do not
 * understand; guessing `failed` would invent an rc. `lost:<raw>` is the honest
 * answer and it names what the box actually said.
 */
export function stateFromBox(boxState: string): MappedState {
  switch (boxState) {
    case "running":
      return { state: "running", lostReason: null };
    case "done":
      return { state: "done", lostReason: null };
    case "failed":
      return { state: "failed", lostReason: null };
    case "timeout":
      return { state: "timeout", lostReason: null };
    case "stopped":
      return { state: "stopped", lostReason: null };
    case "crashloop":
      return { state: "crashloop", lostReason: null };
    case "unknown":
      return { state: "lost", lostReason: "no-record" };
    default:
      if (boxState.startsWith("lost:")) {
        return { state: "lost", lostReason: boxState.slice("lost:".length) };
      }
      return { state: "lost", lostReason: boxState };
  }
}

/**
 * Build the argv tail for `boxup job start`. The command itself goes LAST after
 * `--`, so a command containing something that looks like an option cannot be
 * read as one.
 */
export function startArgs(a: {
  id: string;
  kind: JobKind;
  capS: number | null;
  cwd: string;
  keepAlive: boolean;
  cmd: string;
}): string[] {
  const argv = ["job", "start", a.id, "--kind", a.kind];
  // A service has no cap; passing one would hand the watchdog a deadline the
  // whole point of `service` is not to have.
  if (a.kind === "run" && a.capS !== null) argv.push("--cap", String(a.capS));
  argv.push("--cwd", a.cwd);
  if (a.keepAlive) argv.push("--keep-alive");
  argv.push("--", a.cmd);
  return argv;
}

/**
 * Single-quote a string for a remote POSIX shell.
 *
 * Every job command reaches the box as one `ssh <host> <string>` argument, so
 * the REMOTE shell parses it — a job command is arbitrary operator text and the
 * only thing standing between it and the rest of the `boxup job start` argv is
 * this function. `'\''` is the standard close-escape-reopen; nothing else is
 * special inside single quotes, not even a backslash.
 */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** `sudo boxup job …` over the tunnel, with every interpolated field quoted. */
export function boxupJobCommand(args: string[]): string {
  return `sudo /workspace/box-setup/boxup ${args.map(shQuote).join(" ")}`;
}
