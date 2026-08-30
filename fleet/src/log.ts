// log.ts — journal logging (D9). Every line is `<ISO8601>Z fleet2: <msg>` to
// stderr, so it lands in the systemd journal under the unit exactly like
// fleetctl's log() (fleetctl:52).
//
// A single indirection (`sink`) lets tests capture output without monkey-
// patching console. Default sink writes to stderr.

export type LogSink = (line: string) => void;

let sink: LogSink = (line) => {
  process.stderr.write(line + "\n");
};

/** Replace the log sink (tests). Returns the previous sink. */
export function setLogSink(next: LogSink): LogSink {
  const prev = sink;
  sink = next;
  return prev;
}

/** Timestamp in the fleetctl shape: 2026-08-30T12:34:56Z. */
function nowIso(): string {
  // toISOString() → 2026-08-30T12:34:56.789Z; drop millis to match the bash
  // `date -u +%Y-%m-%dT%H:%M:%SZ` shape.
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function log(msg: string): void {
  sink(`${nowIso()} fleet2: ${msg}`);
}
