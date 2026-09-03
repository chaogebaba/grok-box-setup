// lease-handlers.ts — the /v1/leases endpoints (blueprint fleet2-lease-api L2).
//
// LOCKING, stated once: NO lease endpoint takes the reconcile lock, and there is
// no 423 on any of them. The one-deferring-lease-per-box invariant is the
// schema's partial unique index (a racing second INSERT loses with a constraint
// error ⇒ 409), eligibility is snapshot-based, and a lease is honoured by the
// first tick that STARTS after the INSERT commits. There is therefore nothing to
// serialise against the tick, and the CLI has no retry loop.

import type { ServerContext } from "./context.ts";
import type { RequestAuth } from "./http.ts";
import { err, jsonError, jsonOk } from "./http.ts";
import { writeAudit } from "./audit.ts";
import { isValidBoxName, boxIndex, portFor } from "../boxes.ts";
import { openLeaseStore, openLeaseStoreRo } from "../store/membership.ts";
import { readLatestBoxFacts } from "../store/snapshots.ts";
import {
  acquireLease,
  deferringLeases,
  graceEndsAt,
  leaseById,
  leasesAvailable,
  listLeases,
  releaseLease,
  renewLease,
  DEFAULT_LEASE_LIMITS,
  LEASE_MAX_TTL_S,
  type LeaseKind,
  type LeaseLimits,
  type LeaseRow,
  type LeaseState,
} from "../store/leases.ts";
import { chooseBox, isoSec, leaseReason, type BoxFacts, type LeaseRequire } from "./lease-eligibility.ts";
import { resolveLeaseLimits } from "../config.ts";

/** Wire shape of a lease, the one shape every endpoint serves. */
export interface LeaseView {
  lease_id: string;
  box: string;
  kind: LeaseKind;
  holder: string;
  purpose: string;
  state: LeaseState;
  created_at: string;
  expires_at: string | null;
  renewed_at: string | null;
  released_at: string | null;
  expired_at: string | null;
  lost_at: string | null;
  lost_reason: string | null;
  /**
   * When the deferral ends, for a row in a grace. EXACT for `expired`; an UPPER
   * BOUND for `lost`, whose grace may end earlier once the box has been back in
   * {healthy, drifted} for two consecutive ticks (r10-n1).
   */
  grace_ends_at: string | null;
}

export function leaseView(l: LeaseRow, limits: LeaseLimits = DEFAULT_LEASE_LIMITS): LeaseView {
  const g = graceEndsAt(l, limits);
  return {
    lease_id: l.lease_id,
    box: l.box,
    kind: l.kind,
    holder: l.holder,
    purpose: l.purpose,
    state: l.state,
    created_at: isoSec(l.created_at),
    expires_at: l.expires_at === null ? null : isoSec(l.expires_at),
    renewed_at: l.renewed_at === null ? null : isoSec(l.renewed_at),
    released_at: l.released_at === null ? null : isoSec(l.released_at),
    expired_at: l.expired_at === null ? null : isoSec(l.expired_at),
    lost_at: l.lost_at === null ? null : isoSec(l.lost_at),
    lost_reason: l.lost_reason,
    grace_ends_at: g === null ? null : isoSec(g),
  };
}

/**
 * The compact per-box lease field `GET /v1/fleet` and `GET /v1/boxes/:name`
 * carry (L2/L3/r10-B1). Same rule on both: the row with `released_at IS NULL`,
 * whatever its `state`, or null.
 */
export interface BoxLeaseField {
  lease_id: string;
  state: LeaseState;
  holder: string;
  purpose: string;
  kind: LeaseKind;
  expires_at: string | null;
  grace_ends_at: string | null;
}

export function boxLeaseField(l: LeaseRow, limits: LeaseLimits = DEFAULT_LEASE_LIMITS): BoxLeaseField {
  const g = graceEndsAt(l, limits);
  return {
    lease_id: l.lease_id,
    state: l.state,
    holder: l.holder,
    purpose: l.purpose,
    kind: l.kind,
    expires_at: l.expires_at === null ? null : isoSec(l.expires_at),
    grace_ends_at: g === null ? null : isoSec(g),
  };
}

function nowSec(ctx: ServerContext): number {
  return Math.floor((ctx.now ? ctx.now() : new Date()).getTime() / 1000);
}

function limitsOf(ctx: ServerContext): LeaseLimits {
  return resolveLeaseLimits(ctx.cfg);
}

/**
 * `GET /v1/fleet`'s per-box lease map — ONE query per request, never one per box
 * (r10-B1). Returns an empty map when there is no store or it predates v3.
 */
export function fleetLeaseMap(ctx: ServerContext): Map<string, BoxLeaseField> {
  const out = new Map<string, BoxLeaseField>();
  const h = openLeaseStoreRead(ctx);
  if (h === undefined) return out;
  try {
    const limits = limitsOf(ctx);
    for (const [box, row] of deferringLeases(h.store)) out.set(box, boxLeaseField(row, limits));
  } finally {
    h.close();
  }
  return out;
}

type Handle = { store: import("../store/db.ts").Store; close(): void };

/**
 * A READ handle that tolerates a missing store and one that predates schema v3
 * (both ⇒ undefined, and every read path then serves `null` / an empty list).
 * READ-ONLY on purpose: a GET must never migrate the file.
 */
function openLeaseStoreRead(ctx: ServerContext): Handle | undefined {
  return guard(() => openLeaseStoreRo(ctx.env));
}

/** The WRITE handle for acquire/renew/release. Opening read-write migrates a
 *  pre-v3 file forward, which is exactly what a first lease needs. */
function openLeaseStoreWrite(ctx: ServerContext): Handle | undefined {
  return guard(() => openLeaseStore(ctx.env));
}

function guard(open: () => Handle | undefined): Handle | undefined {
  let h: Handle | undefined;
  try {
    h = open();
  } catch {
    return undefined;
  }
  if (h === undefined) return undefined;
  if (!leasesAvailable(h.store)) {
    h.close();
    return undefined;
  }
  return h;
}

// --- POST /v1/leases (admin) -------------------------------------------------

const RESERVED_REQUIRE = new Set(["max_disk_pct"]);
const KNOWN_REQUIRE = new Set(["no_drift", "boxup_version", "allow_canary"]);

export function handleLeaseAcquire(ctx: ServerContext, auth: RequestAuth, body: Record<string, unknown>): Response {
  const purpose = typeof body["purpose"] === "string" ? (body["purpose"] as string).trim() : "";
  if (purpose === "") return err.badBody("leases: 'purpose' is required and must be a non-empty string");

  const kindRaw = body["kind"] === undefined ? "ephemeral" : body["kind"];
  if (kindRaw !== "ephemeral" && kindRaw !== "service") {
    return err.badBody("leases: 'kind' must be 'ephemeral' or 'service'");
  }
  const kind = kindRaw as LeaseKind;

  let ttlS: number | undefined;
  if (body["ttl_s"] !== undefined) {
    const n = Number(body["ttl_s"]);
    if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
      return err.badBody("leases: 'ttl_s' must be a positive integer number of seconds");
    }
    if (n > LEASE_MAX_TTL_S) {
      return err.badBody(`leases: 'ttl_s' exceeds the ${LEASE_MAX_TTL_S}s maximum`);
    }
    ttlS = n;
  }

  let named: string | undefined;
  if (body["box"] !== undefined) {
    if (typeof body["box"] !== "string" || !isValidBoxName(body["box"] as string)) {
      return err.badBody("leases: 'box' must be a grok-box-NNN name");
    }
    named = body["box"] as string;
  }

  const reqRaw = body["require"];
  const reqSpec: LeaseRequire = {};
  if (reqRaw !== undefined) {
    if (reqRaw === null || typeof reqRaw !== "object" || Array.isArray(reqRaw)) {
      return err.badBody("leases: 'require' must be an object");
    }
    const r = reqRaw as Record<string, unknown>;
    for (const k of Object.keys(r)) {
      // L2/r1-B3: the disk predicate is RESERVED until the boxup-disk-guard
      // chain lands a snapshot field for it. Rejected, never silently ignored.
      if (RESERVED_REQUIRE.has(k)) {
        return err.badBody(`leases: require.${k} is reserved and not implemented yet (no snapshot field for it)`);
      }
      if (!KNOWN_REQUIRE.has(k)) return err.badBody(`leases: unknown require.${k}`);
    }
    if (r["no_drift"] !== undefined) {
      if (typeof r["no_drift"] !== "boolean") return err.badBody("leases: require.no_drift must be a boolean");
      reqSpec.no_drift = r["no_drift"] as boolean;
    }
    if (r["allow_canary"] !== undefined) {
      if (typeof r["allow_canary"] !== "boolean") return err.badBody("leases: require.allow_canary must be a boolean");
      reqSpec.allow_canary = r["allow_canary"] as boolean;
    }
    if (r["boxup_version"] !== undefined) {
      if (typeof r["boxup_version"] !== "string" || r["boxup_version"] === "") {
        return err.badBody("leases: require.boxup_version must be a non-empty string");
      }
      reqSpec.boxup_version = r["boxup_version"] as string;
    }
  }

  const h = openLeaseStoreWrite(ctx);
  if (h === undefined) {
    return jsonError(409, "no_eligible_box", "no state store with leases yet — run a reconcile tick first");
  }
  try {
    const now = nowSec(ctx);
    const limits = limitsOf(ctx);
    const rows = h.store.db.query("SELECT box_id, name, phase FROM boxes").all() as Array<{
      box_id: number;
      name: string;
      phase: "enrolling" | "enrolled" | "retired";
    }>;
    const snap = readLatestBoxFacts(h.store);
    const leased = deferringLeases(h.store);
    const facts: BoxFacts[] = rows.map((r) => {
      const s = snap?.boxes.get(r.name);
      return {
        name: r.name,
        index: boxIndex(r.name) ?? -1,
        phase: r.phase,
        observed: s?.observed,
        ver: s?.ver,
        lease: leased.get(r.name),
      };
    });

    const choice = chooseBox({
      boxes: facts,
      snapshotTs: snap?.ts ?? null,
      now,
      rolloutCanary: ctx.rollout.canary,
      named,
      kind,
      require: reqSpec,
    });

    if (choice.chosen === undefined) {
      return new Response(
        JSON.stringify({
          error: { code: "no_eligible_box", message: "no box satisfies the request" },
          reasons: choice.reasons,
        }),
        { status: 409, headers: { "content-type": "application/json", server: "grokfleet" } },
      );
    }

    const box = choice.chosen;
    const boxId = rows.find((r) => r.name === box.name)!.box_id;
    const res = acquireLease(h.store, {
      boxId,
      box: box.name,
      kind,
      holder: auth.name,
      purpose,
      ttlS,
      now,
    });
    if (!res.ok) {
      // The partial unique index rejected us: another acquire won the race
      // between our eligibility read and our INSERT. Re-read and say by whom.
      const winner = deferringLeases(h.store).get(box.name);
      return new Response(
        JSON.stringify({
          error: { code: "no_eligible_box", message: "no box satisfies the request" },
          reasons: {
            [box.name]: winner === undefined ? "leased by another caller" : leaseReason(winner),
          },
        }),
        { status: 409, headers: { "content-type": "application/json", server: "grokfleet" } },
      );
    }

    writeAudit(
      ctx.env.FLEET_STATE,
      { token: auth.name, action: "lease-acquire", box: box.name, rc: 0 },
      ctx.auditSink,
      ctx.now,
    );

    const l = res.lease;
    const snapBox = snap?.boxes.get(box.name);
    return jsonOk(
      {
        ...leaseView(l, limits),
        observed: snapBox?.observed ?? null,
        drift: snapBox?.drift ?? null,
        connect: connectBlock(ctx, box.name, l.lease_id),
        chosen_because: choice.chosen_because,
      },
      201,
    );
  } finally {
    h.close();
  }
}

/**
 * r1-B1: the response says HOW to connect FROM EACH SIDE, in raw facts, and
 * names `grokfleet ssh --lease <id>` as the supported path on both machines.
 *
 * DEVIATION from the blueprint's literal `tailnet.auth` string: it lists
 * `$FLEET_ETC/box_passwd (VPS only)` as a precedence step, and no such step
 * exists in `resolveSshPassword` (commands/ssh.ts). The field states the
 * precedence the code ACTUALLY implements rather than one it does not.
 */
function connectBlock(ctx: ServerContext, box: string, leaseId: string): Record<string, unknown> {
  return {
    cli: `grokfleet ssh --lease ${leaseId} [--via tailnet|tunnel] '<cmd>'`,
    tunnel: {
      host: "127.0.0.1",
      port: portFor(box) ?? null,
      user: "box",
      identity: ctx.env.FLEET_BOX_KEY,
      note:
        "VPS-only raw facts: the reverse-tunnel listener is loopback-bound by permitlisten; " +
        "the identity file is root/fleet-owned",
    },
    tailnet: {
      host: box,
      user: "box",
      auth: "password, resolved by grokfleet ssh: FLEET_SSH_PASSWORD > [ssh].password > the compiled-in default",
    },
  };
}

// --- POST /v1/leases/:id/renew (admin) ---------------------------------------

export function handleLeaseRenew(
  ctx: ServerContext,
  auth: RequestAuth,
  id: string,
  body: Record<string, unknown>,
): Response {
  let ttlS: number | undefined;
  if (body["ttl_s"] !== undefined) {
    const n = Number(body["ttl_s"]);
    if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
      return err.badBody("leases: 'ttl_s' must be a positive integer number of seconds");
    }
    if (n > LEASE_MAX_TTL_S) return err.badBody(`leases: 'ttl_s' exceeds the ${LEASE_MAX_TTL_S}s maximum`);
    ttlS = n;
  }
  const h = openLeaseStoreWrite(ctx);
  if (h === undefined) return err.notFound(`unknown lease '${id}'`);
  try {
    const limits = limitsOf(ctx);
    const r = renewLease(h.store, id, ttlS, nowSec(ctx), limits);
    if (!r.ok && r.code === "not_active") {
      const existing = leaseById(h.store, id);
      if (existing === undefined) return err.notFound(`unknown lease '${id}'`);
      return jsonError(409, "not_active", `lease ${id} is '${existing.state}', not active`);
    }
    if (!r.ok) {
      return new Response(
        JSON.stringify({
          error: { code: "lifetime_cap", message: "the ephemeral lifetime cap has been reached" },
          created_at: isoSec(r.created_at),
          cap_at: isoSec(r.cap_at),
        }),
        { status: 409, headers: { "content-type": "application/json", server: "grokfleet" } },
      );
    }
    writeAudit(
      ctx.env.FLEET_STATE,
      { token: auth.name, action: "lease-renew", box: r.lease.box, rc: 0 },
      ctx.auditSink,
      ctx.now,
    );
    return jsonOk(leaseView(r.lease, limits));
  } finally {
    h.close();
  }
}

// --- DELETE /v1/leases/:id (admin) -------------------------------------------

export function handleLeaseRelease(ctx: ServerContext, auth: RequestAuth, id: string): Response {
  const h = openLeaseStoreWrite(ctx);
  if (h === undefined) return err.notFound(`unknown lease '${id}'`);
  try {
    const limits = limitsOf(ctx);
    const r = releaseLease(h.store, id, nowSec(ctx));
    if (!r.ok) return err.notFound(`unknown lease '${id}'`);
    writeAudit(
      ctx.env.FLEET_STATE,
      { token: auth.name, action: "lease-release", box: r.lease.box, rc: 0 },
      ctx.auditSink,
      ctx.now,
    );
    // L2: the response says `released` for every terminal outcome — the DELETE
    // ended the deferral, which is what the caller asked for. `state` in the
    // body keeps the row's own truth (`expired` / `lost` keep their reason).
    return jsonOk({ state: "released", ...leaseView(r.lease, limits) });
  } finally {
    h.close();
  }
}

// --- GET /v1/leases and GET /v1/leases/:id (readonly) ------------------------

const LEASE_STATES = new Set(["active", "released", "expired", "lost"]);

export function handleLeaseList(ctx: ServerContext, all: boolean, state: string | null): Response {
  if (state !== null && !LEASE_STATES.has(state)) return err.badBody(`leases: unknown state '${state}'`);
  const h = openLeaseStoreRead(ctx);
  if (h === undefined) return jsonOk({ leases: [] });
  try {
    const limits = limitsOf(ctx);
    const rows = listLeases(h.store, { all, state: (state as LeaseState | null) ?? undefined });
    return jsonOk({ leases: rows.map((r) => leaseView(r, limits)) });
  } finally {
    h.close();
  }
}

export function handleLeaseGet(ctx: ServerContext, id: string): Response {
  const h = openLeaseStoreRead(ctx);
  if (h === undefined) return err.notFound(`unknown lease '${id}'`);
  try {
    const row = leaseById(h.store, id);
    if (row === undefined) return err.notFound(`unknown lease '${id}'`);
    return jsonOk(leaseView(row, limitsOf(ctx)));
  } finally {
    h.close();
  }
}
