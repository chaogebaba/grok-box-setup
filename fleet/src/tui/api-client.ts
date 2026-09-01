// api-client.ts — the TUI's HTTP client over the `fleet2 serve` API (TUI-D7).
//
// The TUI's 5s poll hits ONLY GET /v1/fleet (cheap per TUI-D4). Actions and the
// detail-pane history/journal are on-demand. HTTP 5xx or malformed JSON is
// treated the SAME as an unreachable server: the LINK DOWN path (A14) — every
// call returns a discriminated result, never throws, so the loop can grey the
// last-good data and keep retrying. `fetch` is injected so tests use a fake.

import type { SnapshotBox, SnapshotDiscover, SnapshotLine } from "../history/schema.ts";
import type { Scope } from "../serve/tokens.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The GET /v1/fleet body (handleFleet). */
export interface FleetView {
  snapshot_ts: string | null;
  apply: boolean | null;
  /** where `apply` came from: "config" = read live this request; "snapshot" =
   *  the config read failed and the (possibly stale) snapshot value stands. */
  apply_source: "config" | "snapshot";
  canary: string | null;
  scope: Scope;
  boxes: SnapshotBox[];
  /** zero-touch join summary (D7); null on a server or tick without one. */
  discover: SnapshotDiscover | null;
}

/**
 * The GET /v1/boxes/:name body, as far as the TUI cares (D1, 5.7.0).
 *
 * EVERY field except `name` is optional, and the shape validator keys on `name`
 * ONLY. A 5.6.0 engine omits all five detail facts; that response must still
 * validate and render as `—`, not trip the malformed-body path into LINK DOWN
 * (Acceptance 1).
 */
export interface BoxDetail {
  name: string;
  checkfail_count?: number | null;
  asleep_since?: string | null;
  asleep_last?: string | null;
  expires_at?: string | null;
  api_backoff?: { fails: number; next_retry: string | null } | null;
}

/** A discriminated result: ok payload, or a link-down/auth/other failure. */
export type ClientResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: "link_down" | "unauthorized" | "forbidden" | "error"; status?: number; message: string };

/** An operation-ran result body ({rc, log}). */
export interface OpResult {
  rc: number;
  log: string[];
}

export interface ApiClient {
  fleet(): Promise<ClientResult<FleetView>>;
  /** GET /v1/boxes/:name — the D1 detail facts (readonly scope). */
  box(name: string): Promise<ClientResult<BoxDetail>>;
  /** GET /v1/boxes/:name/diff — a {rc, log} body, readonly scope (D2). */
  diff(name: string): Promise<ClientResult<OpResult>>;
  history(box: string, hours: number): Promise<ClientResult<SnapshotLine[]>>;
  journal(box: string, lines: number): Promise<ClientResult<OpResult>>;
  check(box: string): Promise<ClientResult<OpResult>>;
  configPush(box: string): Promise<ClientResult<OpResult>>;
  rotateKey(box: string): Promise<ClientResult<OpResult>>;
  rename(box: string, to: string): Promise<ClientResult<OpResult>>;
  reconcile(): Promise<ClientResult<{ job_id: string }>>;
}

const REQ_TIMEOUT_MS = 8_000;

/** Map an HTTP status + parse outcome to a failure kind. */
function failFor(status: number, message: string): ClientResult<never> {
  if (status === 401) return { ok: false, kind: "unauthorized", status, message };
  if (status === 403) return { ok: false, kind: "forbidden", status, message };
  // 5xx (and 0 transport) ⇒ LINK DOWN (A14). Other 4xx ⇒ error (shown inline).
  if (status >= 500 || status === 0) return { ok: false, kind: "link_down", status, message };
  return { ok: false, kind: "error", status, message };
}

/**
 * Build a client. `fetchImpl` defaults to the global fetch. Every method
 * catches transport errors and returns a link_down result; a malformed 2xx body
 * is ALSO link_down (a healthy server always returns JSON).
 */
export function makeApiClient(base: string, token: string, fetchImpl: FetchLike = globalThis.fetch): ApiClient {
  const authHeaders = { Authorization: `Bearer ${token}`, Accept: "application/json" };

  async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown } | { status: 0 }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
    try {
      const init: RequestInit = { method, headers: { ...authHeaders }, signal: ctrl.signal };
      if (body !== undefined) {
        (init.headers as Record<string, string>)["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      const res = await fetchImpl(`${base}${path}`, init);
      const text = await res.text();
      let json: unknown = undefined;
      try {
        json = text === "" ? {} : JSON.parse(text);
      } catch {
        // malformed body from a 2xx ⇒ treat as transport failure (link down).
        return { status: 0 };
      }
      return { status: res.status, json };
    } catch {
      return { status: 0 }; // transport failure ⇒ link down
    } finally {
      clearTimeout(timer);
    }
  }

  function errMessage(json: unknown, fallback: string): string {
    const e = (json as { error?: { message?: unknown } } | undefined)?.error;
    return typeof e?.message === "string" ? e.message : fallback;
  }

  async function getJson<T>(path: string, shape: (j: unknown) => T | undefined): Promise<ClientResult<T>> {
    const r = await req("GET", path);
    if (r.status === 0) return { ok: false, kind: "link_down", message: "link down" };
    if (r.status < 200 || r.status >= 300) {
      return failFor(r.status, errMessage(r.json, `HTTP ${r.status}`));
    }
    const v = shape(r.json);
    if (v === undefined) return { ok: false, kind: "link_down", message: "malformed response" };
    return { ok: true, value: v };
  }

  async function postOp(path: string, body?: unknown): Promise<ClientResult<OpResult>> {
    const r = await req("POST", path, body);
    if (r.status === 0) return { ok: false, kind: "link_down", message: "link down" };
    if (r.status < 200 || r.status >= 300) {
      return failFor(r.status, errMessage(r.json, `HTTP ${r.status}`));
    }
    const j = r.json as { rc?: unknown; log?: unknown };
    const rc = typeof j.rc === "number" ? j.rc : 0;
    const log = Array.isArray(j.log) ? (j.log as string[]) : [];
    return { ok: true, value: { rc, log } };
  }

  return {
    fleet() {
      return getJson<FleetView>("/v1/fleet", (j) => {
        const o = j as Partial<FleetView>;
        if (!Array.isArray(o.boxes)) return undefined;
        return {
          snapshot_ts: o.snapshot_ts ?? null,
          apply: o.apply ?? null,
          // an older server omits the field; assume the stale-capable source.
          apply_source: o.apply_source === "config" ? "config" : "snapshot",
          canary: o.canary ?? null,
          scope: (o.scope as Scope) ?? "readonly",
          boxes: o.boxes as SnapshotBox[],
          // D7: absent on a pre-5.6.0 server; the renderer tolerates null.
          discover: (o.discover as SnapshotDiscover | undefined) ?? null,
        };
      });
    },
    box(name) {
      return getJson<BoxDetail>(`/v1/boxes/${encodeURIComponent(name)}`, (j) => {
        const o = j as Partial<BoxDetail>;
        // key on `name` ONLY: an engine without the D1 fields still validates.
        if (typeof o.name !== "string" || o.name === "") return undefined;
        const ab = o.api_backoff;
        return {
          name: o.name,
          checkfail_count: typeof o.checkfail_count === "number" ? o.checkfail_count : null,
          asleep_since: typeof o.asleep_since === "string" ? o.asleep_since : null,
          asleep_last: typeof o.asleep_last === "string" ? o.asleep_last : null,
          expires_at: typeof o.expires_at === "string" ? o.expires_at : null,
          api_backoff:
            ab !== null && ab !== undefined && typeof ab.fails === "number"
              ? { fails: ab.fails, next_retry: typeof ab.next_retry === "string" ? ab.next_retry : null }
              : null,
        };
      });
    },
    diff(name) {
      // D2: the diff body is the SAME {rc, log} shape as journal's — there is
      // no `name` field in a diff response — so it reuses the GET/op reader.
      return postOpGet(`/v1/boxes/${encodeURIComponent(name)}/diff`);
    },
    history(box, hours) {
      const q = `/v1/history?box=${encodeURIComponent(box)}&hours=${hours}`;
      return getJson<SnapshotLine[]>(q, (j) => {
        const o = j as { lines?: unknown };
        return Array.isArray(o.lines) ? (o.lines as SnapshotLine[]) : undefined;
      });
    },
    journal(box, lines) {
      return postOpGet(`/v1/boxes/${encodeURIComponent(box)}/journal?lines=${lines}`);
    },
    check(box) {
      return postOp(`/v1/boxes/${encodeURIComponent(box)}/check`);
    },
    configPush(box) {
      return postOp(`/v1/boxes/${encodeURIComponent(box)}/config-push`, { confirm: box });
    },
    rotateKey(box) {
      return postOp(`/v1/boxes/${encodeURIComponent(box)}/rotate-key`, { confirm: box });
    },
    rename(box, to) {
      return postOp(`/v1/boxes/${encodeURIComponent(box)}/rename`, { to, confirm: box });
    },
    reconcile() {
      return (async (): Promise<ClientResult<{ job_id: string }>> => {
        const r = await req("POST", "/v1/reconcile", { confirm: "fleet" });
        if (r.status === 0) return { ok: false, kind: "link_down", message: "link down" };
        if (r.status < 200 || r.status >= 300) return failFor(r.status, errMessage(r.json, `HTTP ${r.status}`));
        const j = r.json as { job_id?: unknown };
        if (typeof j.job_id !== "string") return { ok: false, kind: "link_down", message: "malformed response" };
        return { ok: true, value: { job_id: j.job_id } };
      })();
    },
  };

  // journal is a GET but shares the OpResult shape.
  async function postOpGet(path: string): Promise<ClientResult<OpResult>> {
    const r = await req("GET", path);
    if (r.status === 0) return { ok: false, kind: "link_down", message: "link down" };
    if (r.status < 200 || r.status >= 300) return failFor(r.status, errMessage(r.json, `HTTP ${r.status}`));
    const j = r.json as { rc?: unknown; log?: unknown };
    return { ok: true, value: { rc: typeof j.rc === "number" ? j.rc : 0, log: Array.isArray(j.log) ? (j.log as string[]) : [] } };
  }
}
