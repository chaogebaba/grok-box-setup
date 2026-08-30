// tailscale-keys.ts — the Tailscale API mutation surface for the tick (D7).
//
// Extends phase-1's read-only DevicesApi with createKey / deleteKey /
// deleteDevice / renameDevice / getDevices, all mirroring the bash endpoints
// and bodies VERBATIM:
//   createKey  POST /tailnet/<t>/keys   body main:1520-1526 (tags ["tag:grok-box"],
//              expirySeconds clamped [1, FLEET_KEY_EXPIRY_MAX=7776000], main:1533-1540)
//   deleteKey  DELETE /tailnet/<t>/keys/<id>   2xx OR 404 ⇒ ok (main:2946-2953)
//   deleteDevice DELETE /device/<id>   (main:3161)
//   renameDevice POST /device/<id>/name  {"name":<box>}  (main:3165)
//   getDevices GET /tailnet/<t>/devices?fields=all  (phase-1 devices_json)
//
// Every call: Authorization: Bearer <token> + Accept: application/json (BUG-D),
// 30 s timeout, code 0 on transport failure (bash TS_API_CODE=0). The token is
// read ONCE per run into a single module-local binding, never interpolated into
// a URL, log line, or Error message (F13/Q1). A RunContext carries the run-wide
// READ-ONLY latch (D7/B-1): ANY failed API interaction sets it; the tick
// consults it before every mutation.

import type { Env } from "../env.ts";

const API_TIMEOUT_MS = 30_000;
const KEY_EXPIRY_MAX = 7776000; // 90d, the Tailscale hard maximum (main:1533)

/** Run-wide READ-ONLY latch (main:964-968). */
export class RunContext {
  private _readonly = false;
  get readonly(): boolean {
    return this._readonly;
  }
  /** Latch read-only; irreversible for the rest of the run. */
  latch(): void {
    this._readonly = true;
  }
}

/** clamp_expiry_secs (main:1533-1540): non-numeric/<=0 ⇒ max; > max ⇒ max. */
export function clampExpirySecs(secs: number | string | undefined): number {
  const max = KEY_EXPIRY_MAX;
  const n = typeof secs === "number" ? secs : Number.parseInt(String(secs ?? ""), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return max;
  if (n < 1) return max;
  if (n > max) return max;
  return n;
}

/** mint_payload (main:1520-1526) — the EXACT capabilities shape. */
export function mintPayload(secs: number): string {
  return JSON.stringify({
    capabilities: { devices: { create: { reusable: true, ephemeral: false, preauthorized: true, tags: ["tag:grok-box"] } } },
    expirySeconds: secs,
  });
}

/** Normalise a create response `expires` to YYYY-MM-DD (main:1684-1686). */
export function normalizeExpires(expires: unknown, plus90: () => string): string {
  if (typeof expires === "string" && expires.length >= 10) {
    const first10 = expires.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(first10)) return first10;
  }
  return plus90(); // date -u -d "+90 days" +%Y-%m-%d fallback
}

/** Today+90d as YYYY-MM-DD (UTC), the bash fallback. */
export function plus90Days(nowMs = Date.now()): string {
  return new Date(nowMs + 90 * 86400_000).toISOString().slice(0, 10);
}

export interface CreateKeyResult {
  code: number;
  key: string | undefined;
  id: string | undefined;
  expires: string | undefined; // normalized YYYY-MM-DD (when a 2xx body parsed)
  /** the RAW `.expires` from the response (bash records this in keys/<N>.json). */
  expiresRaw: string | undefined;
}

// A minimal transport shape we depend on (subset of tailscale.ts TailscaleTransport).
export interface KeyTransport {
  request(
    method: string,
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    body?: string,
  ): Promise<{ code: number; body: string }>;
}

function is2xx(code: number): boolean {
  return code >= 200 && code < 300;
}

/**
 * The tick's Tailscale API client. Constructed once per run with the resolved
 * token + tailnet + base; carries the RunContext latch. The token lives only in
 * the `authHeader` binding, never in a URL/log/error.
 */
export class TailscaleKeys {
  private readonly authHeader: Record<string, string>;
  constructor(
    private readonly transport: KeyTransport,
    private readonly base: string, // e.g. https://api.tailscale.com/api/v2
    private readonly tailnet: string, // e.g. "-"
    token: string,
    readonly ctx: RunContext,
  ) {
    this.authHeader = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  }

  private headers(withBody: boolean): Record<string, string> {
    return withBody ? { ...this.authHeader, "Content-Type": "application/json" } : { ...this.authHeader };
  }

  /** GET the devices list (phase-1 devices_json). Latches on non-2xx. */
  async getDevices(): Promise<{ code: number; body: string }> {
    const r = await this.transport.request(
      "GET",
      `${this.base}/tailnet/${this.tailnet}/devices?fields=all`,
      this.headers(false),
      API_TIMEOUT_MS,
    );
    if (!is2xx(r.code)) this.ctx.latch();
    return r;
  }

  /**
   * createKey (main:1544-1546): POST the mint payload. Returns {code, key, id,
   * expires}. Non-2xx ⇒ latch + undefined fields (caller maps to rc 1). Missing
   * .key or .id are surfaced (undefined) so the caller applies the S3 arms.
   */
  async createKey(expirySecs: number, nowMs = Date.now()): Promise<CreateKeyResult> {
    const secs = clampExpirySecs(expirySecs);
    const r = await this.transport.request(
      "POST",
      `${this.base}/tailnet/${this.tailnet}/keys`,
      this.headers(true),
      API_TIMEOUT_MS,
      mintPayload(secs),
    );
    if (!is2xx(r.code)) {
      this.ctx.latch();
      return { code: r.code, key: undefined, id: undefined, expires: undefined, expiresRaw: undefined };
    }
    let parsed: { key?: unknown; id?: unknown; expires?: unknown } = {};
    try {
      parsed = JSON.parse(r.body);
    } catch {
      parsed = {};
    }
    const key = typeof parsed.key === "string" && parsed.key !== "" ? parsed.key : undefined;
    const id = typeof parsed.id === "string" && parsed.id !== "" ? parsed.id : undefined;
    const expiresRaw = typeof parsed.expires === "string" ? parsed.expires : undefined;
    const expires = normalizeExpires(parsed.expires, () => plus90Days(nowMs));
    return { code: r.code, key, id, expires, expiresRaw };
  }

  /**
   * deleteKey / revoke (main:1637-1647, 2946): DELETE /keys/<id>. 2xx OR 404 ⇒
   * ok (idempotent already-gone). Anything else ⇒ NOT ok (caller logs + latches
   * per its own contract).
   */
  async deleteKey(id: string): Promise<{ code: number; ok: boolean }> {
    const r = await this.transport.request(
      "DELETE",
      `${this.base}/tailnet/${this.tailnet}/keys/${id}`,
      this.headers(false),
      API_TIMEOUT_MS,
    );
    return { code: r.code, ok: is2xx(r.code) || r.code === 404 };
  }

  /** deleteDevice (main:3161): DELETE /device/<id>. Latches on non-2xx. */
  async deleteDevice(id: string): Promise<{ code: number; ok: boolean }> {
    const r = await this.transport.request(
      "DELETE",
      `${this.base}/device/${id}`,
      this.headers(false),
      API_TIMEOUT_MS,
    );
    const ok = is2xx(r.code);
    if (!ok) this.ctx.latch();
    return { code: r.code, ok };
  }

  /** renameDevice (main:3165): POST /device/<id>/name {"name":box}. Latches on non-2xx. */
  async renameDevice(id: string, name: string): Promise<{ code: number; ok: boolean }> {
    const r = await this.transport.request(
      "POST",
      `${this.base}/device/${id}/name`,
      this.headers(true),
      API_TIMEOUT_MS,
      JSON.stringify({ name }),
    );
    const ok = is2xx(r.code);
    if (!ok) this.ctx.latch();
    return { code: r.code, ok };
  }
}

/** Resolve base + tailnet from env (phase-1 defaults). */
export function apiBase(env: Env): { base: string; tailnet: string } {
  return { base: env.FLEET_TS_API, tailnet: env.FLEET_TS_TAILNET };
}
