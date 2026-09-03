// lease-eligibility.ts — who may be leased, and WHY NOT (blueprint
// fleet2-lease-api L2).
//
// Pure: facts in, a choice and a reason map out. No store, no clock, no I/O — so
// every reason string and the whole precedence order are testable without a
// database, and the handler stays a thin adapter.
//
// The 409 body's `reasons` map is the AGENT-FACING answer to "why not". Every
// box with `phase IN ('enrolled','enrolling')` gets exactly one reason, plus any
// box the request NAMED (a `retired` row — kept forever by design — is excluded
// unless named; r4-n2, r5-n3).
//
// Eligibility is SNAPSHOT-BASED: no live probe, because the tick is the prober.

import type { LeaseKind, LeaseRow } from "../store/leases.ts";

/** The latest-snapshot age beyond which a box is not a safe lease target. */
export const LEASE_MAX_SNAPSHOT_AGE_S = 900; // 15 minutes (L2)

export interface BoxFacts {
  name: string;
  /** ordering key: the box's numeric index (the choice is HIGHEST index). */
  index: number;
  phase: "enrolling" | "enrolled" | "retired";
  /** `snapshot_boxes.observed` from the LATEST snapshot; undefined ⇒ no row. */
  observed?: string;
  /** the box's boxup version from the latest snapshot ("-"/"unknown" ⇒ unknown). */
  ver?: string;
  /** the deferring lease on this box (`released_at IS NULL`), if any. */
  lease?: LeaseRow;
}

export interface LeaseRequire {
  no_drift?: boolean;
  boxup_version?: string;
  allow_canary?: boolean;
}

export interface EligibilityInput {
  boxes: BoxFacts[];
  /** epoch seconds of the latest snapshot, or null when the store holds none. */
  snapshotTs: number | null;
  now: number;
  /** `[rollout].canary` — the FIXED rollout canary (L3). */
  rolloutCanary: string;
  /** the `box` the caller named, if any. */
  named?: string;
  kind: LeaseKind;
  require: LeaseRequire;
  maxSnapshotAgeS?: number;
}

export interface EligibilityResult {
  /** the box to lease, or undefined when none qualifies. */
  chosen?: BoxFacts;
  chosen_because?: "named box" | "highest eligible index";
  /** one reason per ineligible candidate, keyed by box name. */
  reasons: Record<string, string>;
}

/** A compact age: `45s`, `12m`, `3h`, `9d`. */
export function fmtAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** ISO8601Z (no milliseconds) for an epoch-seconds instant. */
export function isoSec(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The reason a DEFERRING lease makes its box ineligible, in precedence order. */
export function leaseReason(l: LeaseRow): string {
  if (l.state === "lost") return `lost lease in grace (${l.lost_reason ?? "unknown"})`;
  if (l.state === "expired") return `leased by ${l.holder} (expired, grace)`;
  return l.expires_at === null
    ? `leased by ${l.holder} (service)`
    : `leased by ${l.holder} until ${isoSec(l.expires_at)}`;
}

/**
 * Compare two boxup version strings numerically, tuple by tuple.
 * Returns <0, 0 or >0. A non-numeric segment compares as a string, so
 * `5.11.0-rc1` still orders sensibly against `5.11.0`.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = /^[0-9]+$/.test(x) ? Number.parseInt(x, 10) : undefined;
    const ny = /^[0-9]+$/.test(y) ? Number.parseInt(y, 10) : undefined;
    if (nx !== undefined && ny !== undefined) {
      if (nx !== ny) return nx - ny;
      continue;
    }
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Is this a version string we can compare at all? */
function versionKnown(v: string | undefined): v is string {
  return v !== undefined && v !== "" && v !== "-" && v !== "?" && v !== "unknown";
}

const OBSERVED_BAD = new Set(["asleep", "incoherent", "hostkey_mismatch", "unhealthy"]);

/**
 * The FIRST applicable reason this box cannot be leased, or undefined when it
 * is eligible. The order of the arms IS the r3-n5 precedence, stated once:
 *
 *   leased by … > lost lease in grace (…) > leased by … (expired, grace)
 *   > configured rollout canary
 *   > observed <asleep|incoherent|hostkey_mismatch|unhealthy>
 *   > observed api_unknown (read-only tick)
 *   > snapshot stale (<age>)
 *   > drifted (require.no_drift)
 *   > boxup <v> < required <v>
 *   > phase <p>
 *
 * DEVIATION, stated: a box the latest snapshot carries NO ROW for has no
 * `observed` to name, and the blueprint's precedence has no arm for it. It is
 * reported at the staleness arm as `snapshot stale (never probed)` — the same
 * position and the same meaning ("this box's observations are not current").
 */
export function ineligibleReason(b: BoxFacts, i: EligibilityInput): string | undefined {
  // --- the three lease arms (a deferring row is a deferring row, L3) ---
  if (b.lease !== undefined) return leaseReason(b.lease);

  // --- the configured ROLLOUT canary (r3-n4) ---
  // `allow_canary` opens it for EPHEMERAL leases only; a `service` lease on the
  // rollout canary is always refused (L3).
  if (b.name === i.rolloutCanary && !(i.require.allow_canary === true && i.kind === "ephemeral")) {
    return "configured rollout canary";
  }

  // --- observed ---
  if (b.observed !== undefined && OBSERVED_BAD.has(b.observed)) return `observed ${b.observed}`;
  if (b.observed === "api_unknown") return "observed api_unknown (read-only tick)";

  // --- snapshot freshness ---
  const maxAge = i.maxSnapshotAgeS ?? LEASE_MAX_SNAPSHOT_AGE_S;
  if (i.snapshotTs === null) return "snapshot stale (none)";
  if (b.observed === undefined) return "snapshot stale (never probed)";
  const age = Math.max(0, i.now - i.snapshotTs);
  if (age > maxAge) return `snapshot stale (${fmtAge(age)})`;

  // --- opt-in strictness ---
  if (i.require.no_drift === true && b.observed === "drifted") return "drifted (require.no_drift)";
  const want = i.require.boxup_version;
  if (want !== undefined && want !== "") {
    if (!versionKnown(b.ver)) return `boxup unknown < required ${want}`;
    if (compareVersions(b.ver, want) < 0) return `boxup ${b.ver} < required ${want}`;
  }

  // --- membership, last (L2 precedence) ---
  if (b.phase !== "enrolled") return `phase ${b.phase}`;
  return undefined;
}

/**
 * Choose a box, or explain every candidate.
 *
 * Choice (L2 + r3-n2): the NAMED box when it is eligible, otherwise the HIGHEST
 * eligible index. Picking from the TOP keeps leases away from the config pass's
 * dynamic canary, which is the LOWEST-index awake box. A named box may still BE
 * the config canary — the config pass then skips per L3.
 */
export function chooseBox(i: EligibilityInput): EligibilityResult {
  const reasons: Record<string, string> = {};
  const candidates = i.boxes.filter(
    (b) => b.phase === "enrolled" || b.phase === "enrolling" || b.name === i.named,
  );

  if (i.named !== undefined) {
    const b = i.boxes.find((x) => x.name === i.named);
    if (b === undefined) {
      reasons[i.named] = "unknown box";
      for (const c of candidates) {
        const r = ineligibleReason(c, i);
        if (r !== undefined) reasons[c.name] = r;
      }
      return { reasons };
    }
    const r = ineligibleReason(b, i);
    if (r === undefined) return { chosen: b, chosen_because: "named box", reasons: {} };
    // A named-but-ineligible box still gets the FULL map: the caller asked a
    // specific question and the answer is "not that one, and here is the fleet".
    for (const c of candidates) {
      const cr = ineligibleReason(c, i);
      if (cr !== undefined) reasons[c.name] = cr;
    }
    return { reasons };
  }

  let best: BoxFacts | undefined;
  for (const c of candidates) {
    const r = ineligibleReason(c, i);
    if (r !== undefined) {
      reasons[c.name] = r;
      continue;
    }
    if (best === undefined || c.index > best.index) best = c;
  }
  if (best === undefined) return { reasons };
  return { chosen: best, chosen_because: "highest eligible index", reasons: {} };
}
