// lease-tick.ts — what the reconcile tick does about leases (blueprint
// fleet2-lease-api L3).
//
// Three jobs, in the tick's order:
//
//   begin()      BEFORE the action loop: expire due leases, end the graces, and
//                hand back the map of leases that still DEFER.
//   detectLoss() AFTER the loop: name mid-run box loss from this tick's
//                `observed` labels.
//   canarySkip() when a canary pass could not run because its canary is leased.
//
// The deferral predicate is `released_at IS NULL` and nothing else (L3/r9-B1):
// `active`, `lost` inside its grace and `expired` inside its grace all defer, so
// a box whose work may still be running is never written to. Mutant (l7) keys
// the deferral on `state='active'` and the lost-grace test catches it.

import type { Store } from "../store/db.ts";
import type { StoreState } from "../store/state.ts";
import type { NotifyLevel } from "../notify.ts";
import type { Observed } from "./observe.ts";
import { log } from "../log.ts";
import {
  DEFAULT_LEASE_LIMITS,
  deferringLeases,
  expireDue,
  isBackHealthy,
  lastTwoObserved,
  markLost,
  sweepGraces,
  twoConsecutiveTicks,
  type LeaseLimits,
  type LeaseRow,
  type LeaseState,
} from "../store/leases.ts";

/** What the tick needs to know about a deferring lease. */
export interface DeferringLease {
  lease_id: string;
  holder: string;
  purpose: string;
  state: LeaseState;
}

export type CanaryAlertKind = "rollout-canary-leased" | "config-canary-leased";

/** L3: three CONSECUTIVE skipped passes before the alert fires. */
export const CANARY_SKIP_THRESHOLD = 3;
/** …and then at most once per 24 h, through the `alerts` table's throttle. */
export const CANARY_RENOTIFY_SECS = 86400;

/**
 * The `observed` labels that lose an active lease IMMEDIATELY. `unhealthy` is
 * deliberately NOT here: heavy work can fail a single `boxup check` (r1-B5), so
 * it needs two consecutive ticks.
 */
const LOSE_AT_ONCE = new Set<Observed>(["asleep", "incoherent", "hostkey_mismatch"]);

/** The seam run.ts depends on, so a box-free tick test can inject a fake. */
export interface LeaseTickApi {
  begin(now: number): Map<string, DeferringLease>;
  detectLoss(observed: Map<string, Observed>, tick: number, now: number): Promise<void>;
  canarySkip(kind: CanaryAlertKind, box: string, now: number): Promise<void>;
  canaryRan(kind: CanaryAlertKind, box: string): void;
}

export interface LeaseTickDeps {
  store: Store;
  state: StoreState;
  notify: (level: NotifyLevel, msg: string) => Promise<void> | void;
  limits?: LeaseLimits;
}

export class LeaseTick implements LeaseTickApi {
  private readonly store: Store;
  private readonly state: StoreState;
  private readonly notify: (level: NotifyLevel, msg: string) => Promise<void> | void;
  private readonly limits: LeaseLimits;

  constructor(deps: LeaseTickDeps) {
    this.store = deps.store;
    this.state = deps.state;
    this.notify = deps.notify;
    this.limits = deps.limits ?? DEFAULT_LEASE_LIMITS;
  }

  /**
   * Expiry, then the graces, then the deferring map.
   *
   * An expiry does NOT set `released_at` (r7-B2) — the row keeps deferring and
   * keeps the box's unique-index slot for the expired grace, because expiry can
   * happen under a running command. `sweepGraces` is what eventually frees it,
   * and that is r2-B1's "an expired lease must not defer forever".
   */
  begin(now: number): Map<string, DeferringLease> {
    for (const l of expireDue(this.store, now)) {
      log(`lease: ${l.lease_id} on ${l.box} EXPIRED — deferring for ${this.limits.expiredGraceS}s of grace`);
      void this.notify("info", `${l.box}: lease ${l.lease_id} (${l.holder}) expired — grace until release or timeout`);
    }
    for (const l of sweepGraces(this.store, {
      now,
      limits: this.limits,
      healthyTwoTicks: (box) => twoConsecutiveTicks(lastTwoObserved(this.store, box), isBackHealthy),
    })) {
      log(`lease: ${l.lease_id} on ${l.box} grace ended (${l.state}) — the box is writable again`);
    }
    const out = new Map<string, DeferringLease>();
    for (const [box, r] of deferringLeases(this.store)) out.set(box, view(r));
    return out;
  }

  /**
   * Mid-run box loss (L3). An ACTIVE lease is `lost` when this tick's `observed`
   * is asleep / incoherent / hostkey_mismatch, or `unhealthy` on TWO CONSECUTIVE
   * ticks.
   *
   * The two-tick reading is `snapshot_boxes`, never `box_counters.checkfail`
   * (r3-B2): a down tunnel reads `unhealthy` but never bumps `checkfail`. THIS
   * tick's label is the in-memory one (the snapshot row for it has not been
   * written yet) and the previous one must sit at exactly `tick - 1` — exact
   * ordinal arithmetic, no wall clock. With no row at `tick - 1` the
   * conservative branch applies: NOT lost, one debug line (mutant l11).
   */
  async detectLoss(observed: Map<string, Observed>, tick: number, now: number): Promise<void> {
    const rows = this.store.db
      .query(
        `SELECT l.lease_id, l.box_id, b.name AS box, l.kind, l.holder, l.purpose, l.created_at,
                l.expires_at, l.renewed_at, l.released_at, l.state, l.expired_at, l.lost_at, l.lost_reason
           FROM leases l JOIN boxes b ON b.box_id = l.box_id
          WHERE l.state = 'active'`,
      )
      .all() as LeaseRow[];
    for (const l of rows) {
      const cur = observed.get(l.box);
      if (cur === undefined) continue;
      let reason: string | undefined;
      if (LOSE_AT_ONCE.has(cur)) {
        reason = cur;
      } else if (cur === "unhealthy") {
        const prev = lastTwoObserved(this.store, l.box)[0];
        if (prev === undefined || prev.tick !== tick - 1) {
          log(`lease: ${l.box} unhealthy but no snapshot at tick ${tick - 1} — lease kept (conservative)`);
        } else if (prev.observed === "unhealthy") {
          reason = "unhealthy";
        }
      }
      if (reason === undefined) continue;
      markLost(this.store, l, reason, now);
      log(`lease: ${l.lease_id} on ${l.box} LOST (${reason}) — holder ${l.holder}`);
      if (this.state.alertDue(l.box, "lease-lost", CANARY_RENOTIFY_SECS, now)) {
        await this.notify("warn", `${l.box}: lease ${l.lease_id} (${l.holder}) LOST — ${reason}`);
      }
    }
  }

  /**
   * A canary pass could not run because its canary holds a deferring lease. The
   * pass is SKIPPED, never run canary-less (mutant l6), and after three
   * CONSECUTIVE skips the alert fires — once per 24 h.
   */
  async canarySkip(kind: CanaryAlertKind, box: string, now: number): Promise<void> {
    const n = this.bumpSkips(kind) ;
    if (n < CANARY_SKIP_THRESHOLD) return;
    if (this.state.alertDue(box, kind, CANARY_RENOTIFY_SECS, now)) {
      await this.notify(
        "warn",
        `${box}: ${kind} — ${n} consecutive canary passes skipped because the canary is leased`,
      );
    }
  }

  /** A pass RAN: the consecutive-skip counter resets. */
  canaryRan(kind: CanaryAlertKind, box: string): void {
    this.store.setMeta(skipKey(kind), "0");
    this.state.alertClear(box, kind);
  }

  private bumpSkips(kind: CanaryAlertKind): number {
    const raw = this.store.meta(skipKey(kind));
    const n = raw !== undefined && /^[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) + 1 : 1;
    this.store.setMeta(skipKey(kind), String(n));
    return n;
  }
}

function skipKey(kind: CanaryAlertKind): string {
  return `lease_skips_${kind}`;
}

function view(r: LeaseRow): DeferringLease {
  return { lease_id: r.lease_id, holder: r.holder, purpose: r.purpose, state: r.state };
}
