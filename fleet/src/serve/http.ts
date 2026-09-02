// http.ts — shared HTTP contract helpers (TUI-D9).
//
// All endpoints live under /v1/. Status mapping (A10): 200 = operation ran
// (body {rc, log:[lines]} — a nonzero DOMAIN rc is still HTTP 200; clients read
// rc); 400 bad body; 401/403 auth; 404 unknown route or box not in
// enrolled.tsv; 423 lock_busy; 500 unexpected. Errors: {error:{code,message}}.
// Error bodies NEVER echo tokens or fleet data.

import type { Scope } from "./tokens.ts";

// N1: every response names the product. `server` is the one header a client
// (or a curl by hand) sees without parsing a body.
export const SERVER_HEADER = "grokfleet";
const JSON_HEADERS = { "content-type": "application/json", server: SERVER_HEADER };

/** A JSON 200/2xx response with an arbitrary body. */
export function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** An {error:{code,message}} response at `status`. */
export function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: JSON_HEADERS,
  });
}

// The canonical error shapes.
export const err = {
  badBody: (msg = "invalid request body") => jsonError(400, "bad_body", msg),
  confirmMismatch: (msg = "confirm does not match") => jsonError(400, "confirm_mismatch", msg),
  unauthorized: (msg = "invalid or missing token") => jsonError(401, "unauthorized", msg),
  forbidden: (msg = "admin scope required") => jsonError(403, "forbidden", msg),
  notFound: (msg = "not found") => jsonError(404, "not_found", msg),
  lockBusy: (msg = "reconcile lock held — tick in progress") => jsonError(423, "lock_busy", msg),
  jobRunning: (msg = "a reconcile job is already running") => jsonError(409, "job_running", msg),
  internal: (msg = "internal error") => jsonError(500, "internal", msg),
  /**
   * state-store D8: the store failed `quick_check` and the flag is set. MUTATION
   * endpoints refuse — they share the reconcile lock and would otherwise write
   * to a database that has declared itself corrupt. READONLY endpoints keep
   * serving the last data, so the TUI stays useful while an operator runs
   * `grokfleet state check` or `grokfleet state restore`.
   */
  integrityFailed: (msg = "state store failed quick_check — run 'grokfleet state check'") =>
    jsonError(503, "integrity_failed", msg),
};

/** An operation-ran 200 body: {rc, log}. */
export function opResult(rc: number, log: string[], extra: Record<string, unknown> = {}): Response {
  return jsonOk({ rc, log, ...extra });
}

/** The authenticated identity attached to a request by the auth layer. */
export interface RequestAuth {
  name: string;
  scope: Scope;
}
