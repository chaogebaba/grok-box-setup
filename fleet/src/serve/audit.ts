// audit.ts — the mutation audit log (TUI-D3).
//
// Every mutation endpoint appends ONE line to `${FLEET_STATE}/audit.log`:
//   <ISO8601Z> token=<name> action=<x> box=<y> rc=<n>
// mode 0600, unbounded (operator logrotate is noted in the docs, R2-A10). The
// same line is also emitted to journald via log() so the two agree. For the
// async reconcile job the audit line is written ONCE at job completion with the
// job id (never at 202-time — no missing/double rc, R3-A8).

import { appendFileSync, existsSync, chmodSync } from "node:fs";
import { log } from "../log.ts";

export interface AuditRecord {
  token: string;
  action: string;
  box: string;
  rc: number;
  /** optional job id (reconcile job completion, R3-A8). */
  job?: string;
}

/** Injectable sink so tests capture without disk. */
export interface AuditSink {
  append(fleetState: string, line: string): void;
}

export const nodeAuditSink: AuditSink = {
  append(fleetState, line) {
    const file = `${fleetState}/audit.log`;
    const fresh = !existsSync(file);
    appendFileSync(file, line);
    if (fresh) {
      try {
        chmodSync(file, 0o600);
      } catch {
        /* best-effort */
      }
    }
  },
};

/** Format an audit line (no trailing newline). */
export function formatAudit(rec: AuditRecord, nowIso: string): string {
  const jobPart = rec.job !== undefined ? ` job=${rec.job}` : "";
  return `${nowIso} token=${rec.token} action=${rec.action} box=${rec.box} rc=${rec.rc}${jobPart}`;
}

/**
 * Append an audit record to `${FLEET_STATE}/audit.log` (0600) AND journald.
 * Best-effort on the file (a write failure logs a warning but never throws into
 * the request path). The token NAME is recorded; the token VALUE never is.
 */
export function writeAudit(
  fleetState: string,
  rec: AuditRecord,
  sink: AuditSink = nodeAuditSink,
  now: () => Date = () => new Date(),
): void {
  const nowIso = now().toISOString().replace(/\.\d{3}Z$/, "Z");
  const line = formatAudit(rec, nowIso);
  // journald mirror (D3).
  log(`audit: ${line}`);
  try {
    sink.append(fleetState, line + "\n");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`serve: audit.log append failed (${msg}) — journald line still recorded`);
  }
}
