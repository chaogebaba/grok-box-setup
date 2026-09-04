// api-client.ts — the TUI's HTTP client over the `grokfleet serve` API (TUI-D7).
//
// The TUI's 5s poll hits ONLY GET /v1/fleet (cheap per TUI-D4). Actions and the
// detail-pane history/journal are on-demand. HTTP 5xx or malformed JSON is
// treated the SAME as an unreachable server: the LINK DOWN path (A14) — every
// call returns a discriminated result, never throws, so the loop can grey the
// last-good data and keep retrying. `fetch` is injected so tests use a fake.

import type { SnapshotBox, SnapshotDiscover, SnapshotLine } from "../history/schema.ts";
import type { Scope } from "../serve/tokens.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * lease-api L5/r11-n1: the fleet view's per-box entry is the history
 * `SnapshotBox` PLUS the additive `lease` field the `/v1/fleet` handler attaches
 * at serve time. It is its OWN type on purpose — `SnapshotBox` and
 * `SnapshotLine` in history/schema.ts stay untouched, so the store round-trip
 * and `GET /v1/history` are unaffected.
 */
export interface FleetBox extends SnapshotBox {
  lease?: BoxLease | null;
  /** jobs J12: the open job on this box, attached at serve time like `lease`. */
  job?: BoxJob | null;
}

/** The compact per-box job field on `/v1/fleet` and `/v1/boxes/:name`. */
export interface BoxJob {
  job_id: string;
  kind: "run" | "service";
  state: string;
  holder: string;
  purpose: string;
  started_at: string | null;
}

/** The compact per-box lease field on `/v1/fleet` and `/v1/boxes/:name`. */
export interface BoxLease {
  lease_id: string;
  state: "active" | "released" | "expired" | "lost";
  holder: string;
  purpose: string;
  kind: "ephemeral" | "service";
  expires_at: string | null;
  grace_ends_at: string | null;
}

/** A lease as `GET /v1/leases[/:id]` serves it. */
export interface Lease {
  lease_id: string;
  box: string;
  kind: "ephemeral" | "service";
  holder: string;
  purpose: string;
  state: "active" | "released" | "expired" | "lost";
  created_at: string;
  expires_at: string | null;
  renewed_at: string | null;
  released_at: string | null;
  expired_at: string | null;
  lost_at: string | null;
  lost_reason: string | null;
  grace_ends_at: string | null;
}

/** The 201 body of `POST /v1/leases`: a lease plus how to reach the box. */
export interface AcquiredLease extends Lease {
  observed: string | null;
  drift: string | null;
  connect: Record<string, unknown>;
  chosen_because: string;
}

/** The GET /v1/fleet body (handleFleet). */
export interface FleetView {
  snapshot_ts: string | null;
  apply: boolean | null;
  /** where `apply` came from: "config" = read live this request; "snapshot" =
   *  the config read failed and the (possibly stale) snapshot value stands. */
  apply_source: "config" | "snapshot";
  canary: string | null;
  scope: Scope;
  boxes: FleetBox[];
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
  /** state-store D4: membership phase and the liveness label the last tick
   *  recorded. A 5.8.0 engine omits both; the pane renders `—`. */
  phase?: string | null;
  observed?: string | null;
  /** lease-api L3: the deferring lease on this box, or null. Absent on a
   *  pre-5.11.0 engine. */
  lease?: BoxLease | null;
}

/** A discriminated result: ok payload, or a link-down/auth/other failure. */
export type ClientResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      kind: "link_down" | "unauthorized" | "forbidden" | "error";
      status?: number;
      message: string;
      /** lease-api L2: the 409 `no_eligible_box` per-box reason map. */
      reasons?: Record<string, string>;
      /** the error body's `code` (e.g. `no_eligible_box`, `lifetime_cap`). */
      code?: string;
      /** `lifetime_cap` only: when the ephemeral lifetime bound is reached. */
      cap_at?: string;
    };

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
  // --- lease-api L4/r5-B1: the lease surface, on the SAME typed client -------
  acquireLease(body: {
    purpose: string;
    kind?: "ephemeral" | "service";
    ttl_s?: number;
    box?: string;
    require?: Record<string, unknown>;
  }): Promise<ClientResult<AcquiredLease>>;
  renewLease(id: string, ttlS?: number): Promise<ClientResult<Lease>>;
  releaseLease(id: string): Promise<ClientResult<Lease>>;
  getLease(id: string): Promise<ClientResult<Lease>>;
  listLeases(opts?: { all?: boolean; state?: string }): Promise<ClientResult<Lease[]>>;
  // --- jobs J7/J8: the job surface, on the SAME typed client ------------------
  startJob(body: {
    cmd: string;
    purpose: string;
    kind?: "run" | "service";
    box?: string;
    cwd?: string;
    wall_cap_s?: number;
    lease_id?: string;
  }): Promise<ClientResult<StartedJob>>;
  /** `refresh` polls the box inline, so a waiting CLI is not tied to the tick. */
  getJob(id: string, refresh?: boolean): Promise<ClientResult<Job>>;
  listJobs(opts?: { state?: string; box?: string }): Promise<ClientResult<Job[]>>;
  stopJob(id: string): Promise<ClientResult<Job>>;
  /** RAW log bytes from `offset`; the reply carries the next offset. */
  jobLog(id: string, offset: number): Promise<ClientResult<{ text: string; next: number; truncated: boolean }>>;
}

/** The `POST /v1/jobs` reply (J7). */
export interface StartedJob {
  job_id: string;
  box: string;
  lease_id: string | null;
  state: string;
}

/** One job row as every JSON surface renders it (J7). */
export interface Job {
  job_id: string;
  box: string;
  kind: "run" | "service";
  state: string;
  rc: number | null;
  holder: string;
  purpose: string;
  cmd: string;
  cwd: string;
  wall_cap_s: number | null;
  keep_alive: boolean;
  lease_id: string | null;
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  last_poll_at: string | null;
  log_bytes: number;
  log_truncated: boolean;
  lost_reason: string | null;
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

  /**
   * The two outcomes of one request. `down` is the A14 LINK DOWN path: a
   * transport failure, or a 2xx whose body would not parse. It is a DISCRIMINATED
   * union on `ok` — keying it on `status === 0` (as it was) narrows nothing,
   * because the reachable arm's `status: number` already includes 0, so every
   * `r.json` after the guard was a type error.
   */
  type Reply = { ok: true; status: number; json: unknown } | { ok: false; status: 0 };

  async function req(method: string, path: string, body?: unknown): Promise<Reply> {
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
        return { ok: false, status: 0 };
      }
      return { ok: true, status: res.status, json };
    } catch {
      return { ok: false, status: 0 }; // transport failure ⇒ link down
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
    if (!r.ok) return { ok: false, kind: "link_down", message: "link down" };
    if (r.status < 200 || r.status >= 300) {
      return failFor(r.status, errMessage(r.json, `HTTP ${r.status}`));
    }
    const v = shape(r.json);
    if (v === undefined) return { ok: false, kind: "link_down", message: "malformed response" };
    return { ok: true, value: v };
  }

  async function postOp(path: string, body?: unknown): Promise<ClientResult<OpResult>> {
    const r = await req("POST", path, body);
    if (!r.ok) return { ok: false, kind: "link_down", message: "link down" };
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
          boxes: o.boxes as FleetBox[],
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
          phase: typeof o.phase === "string" ? o.phase : null,
          observed: typeof o.observed === "string" ? o.observed : null,
          lease: (o.lease as BoxLease | null | undefined) ?? null,
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
    acquireLease(body) {
      return leaseCall<AcquiredLease>("POST", "/v1/leases", body);
    },
    renewLease(id, ttlS) {
      return leaseCall<Lease>(
        "POST",
        `/v1/leases/${encodeURIComponent(id)}/renew`,
        ttlS === undefined ? {} : { ttl_s: ttlS },
      );
    },
    releaseLease(id) {
      return leaseCall<Lease>("DELETE", `/v1/leases/${encodeURIComponent(id)}`);
    },
    getLease(id) {
      return leaseCall<Lease>("GET", `/v1/leases/${encodeURIComponent(id)}`);
    },
    listLeases(opts) {
      const q = new URLSearchParams();
      if (opts?.all === true) q.set("all", "1");
      if (opts?.state !== undefined) q.set("state", opts.state);
      const qs = q.toString();
      return (async (): Promise<ClientResult<Lease[]>> => {
        const r = await leaseCall<{ leases?: unknown }>("GET", `/v1/leases${qs === "" ? "" : `?${qs}`}`);
        if (!r.ok) return r;
        return Array.isArray(r.value.leases)
          ? { ok: true, value: r.value.leases as Lease[] }
          : { ok: false, kind: "link_down", message: "malformed response" };
      })();
    },
    // --- jobs J8: the same `leaseCall` envelope, so the 409 `code`/`reasons` a
    // job start comes back with reach the CLI exactly as a lease's do.
    startJob(body) {
      return leaseCall<StartedJob>("POST", "/v1/jobs", body);
    },
    getJob(id, refresh) {
      const q = refresh === true ? "?refresh=1" : "";
      return leaseCall<Job>("GET", `/v1/jobs/${encodeURIComponent(id)}${q}`);
    },
    stopJob(id) {
      return leaseCall<Job>("POST", `/v1/jobs/${encodeURIComponent(id)}/stop`, {});
    },
    listJobs(opts) {
      const q = new URLSearchParams();
      if (opts?.state !== undefined) q.set("state", opts.state);
      if (opts?.box !== undefined) q.set("box", opts.box);
      const qs = q.toString();
      return (async (): Promise<ClientResult<Job[]>> => {
        const r = await leaseCall<{ jobs?: unknown }>("GET", `/v1/jobs${qs === "" ? "" : `?${qs}`}`);
        if (!r.ok) return r;
        return Array.isArray(r.value.jobs)
          ? { ok: true, value: r.value.jobs as Job[] }
          : { ok: false, kind: "link_down", message: "malformed response" };
      })();
    },
    jobLog(id, offset) {
      // NOT `leaseCall`: this endpoint answers with raw bytes, not JSON, and the
      // next offset rides in a header. Parsing it as JSON would fail on the
      // first log line that is not a JSON document, which is all of them.
      return (async (): Promise<ClientResult<{ text: string; next: number; truncated: boolean }>> => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
        try {
          const res = await fetchImpl(`${base}/v1/jobs/${encodeURIComponent(id)}/log?offset=${offset}`, {
            method: "GET",
            headers: { ...authHeaders },
            signal: ctrl.signal,
          });
          if (res.status < 200 || res.status >= 300) {
            return failFor(res.status, `HTTP ${res.status}`);
          }
          const text = await res.text();
          const nextRaw = res.headers.get("x-job-log-offset");
          const next = nextRaw !== null && /^[0-9]+$/.test(nextRaw) ? Number.parseInt(nextRaw, 10) : offset + text.length;
          return { ok: true, value: { text, next, truncated: res.headers.get("x-job-log-truncated") === "1" } };
        } catch {
          return { ok: false, kind: "link_down", message: "link down" };
        } finally {
          clearTimeout(timer);
        }
      })();
    },
    reconcile() {
      return (async (): Promise<ClientResult<{ job_id: string }>> => {
        const r = await req("POST", "/v1/reconcile", { confirm: "fleet" });
        if (!r.ok) return { ok: false, kind: "link_down", message: "link down" };
        if (r.status < 200 || r.status >= 300) return failFor(r.status, errMessage(r.json, `HTTP ${r.status}`));
        const j = r.json as { job_id?: unknown };
        if (typeof j.job_id !== "string") return { ok: false, kind: "link_down", message: "malformed response" };
        return { ok: true, value: { job_id: j.job_id } };
      })();
    },
  };

  /**
   * The lease calls share one adapter because they share one failure contract:
   * a 409 carries a `code` and, for `no_eligible_box`, the per-box `reasons`
   * map the CLI prints on stderr (L4). Everything else maps exactly as the rest
   * of the client does — 5xx and transport are LINK DOWN.
   */
  async function leaseCall<T>(method: string, path: string, body?: unknown): Promise<ClientResult<T>> {
    const r = await req(method, path, body);
    if (!r.ok) return { ok: false, kind: "link_down", message: "link down" };
    if (r.status < 200 || r.status >= 300) {
      const fail = failFor(r.status, errMessage(r.json, `HTTP ${r.status}`));
      const j = r.json as { error?: { code?: unknown }; reasons?: unknown; cap_at?: unknown } | undefined;
      const code = typeof j?.error?.code === "string" ? (j.error.code as string) : undefined;
      const reasons =
        j?.reasons !== null && typeof j?.reasons === "object" && !Array.isArray(j?.reasons)
          ? (j.reasons as Record<string, string>)
          : undefined;
      const capAt = typeof j?.cap_at === "string" ? (j.cap_at as string) : undefined;
      return { ...(fail as Extract<ClientResult<T>, { ok: false }>), code, reasons, cap_at: capAt };
    }
    return { ok: true, value: r.json as T };
  }

  // journal is a GET but shares the OpResult shape.
  async function postOpGet(path: string): Promise<ClientResult<OpResult>> {
    const r = await req("GET", path);
    if (!r.ok) return { ok: false, kind: "link_down", message: "link down" };
    if (r.status < 200 || r.status >= 300) return failFor(r.status, errMessage(r.json, `HTTP ${r.status}`));
    const j = r.json as { rc?: unknown; log?: unknown };
    return { ok: true, value: { rc: typeof j.rc === "number" ? j.rc : 0, log: Array.isArray(j.log) ? (j.log as string[]) : [] } };
  }
}
