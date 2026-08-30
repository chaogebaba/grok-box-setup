// http.ts — shared HTTP contract helpers (TUI-D9).
//
// All endpoints live under /v1/. Status mapping (A10): 200 = operation ran
// (body {rc, log:[lines]} — a nonzero DOMAIN rc is still HTTP 200; clients read
// rc); 400 bad body; 401/403 auth; 404 unknown route or box not in
// enrolled.tsv; 423 lock_busy; 500 unexpected. Errors: {error:{code,message}}.
// Error bodies NEVER echo tokens or fleet data.

import type { Scope } from "./tokens.ts";

const JSON_HEADERS = { "content-type": "application/json" };

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
