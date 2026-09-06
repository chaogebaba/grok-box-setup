// alerts.ts — row-e alert throttles, ported from main:3216-3259 (D6).
//
// asleep (main:3218-3242): $box.asleep = "<since> <last_alert>". First alert
// (notify info) only after FLEET_ASLEEP_T_SECS (7200 = 2h) of CONTINUOUS
// both-dead; then a daily digest every FLEET_ASLEEP_DIGEST_SECS (86400). A
// non-both-dead observation resets (rm -f) via ReconcileState.resetAsleep.
//
// incoherent (main:3249-3259): $box.incoherent = consecutive-run count; notify
// warn only at >= 2 runs. Reset (rm -f) on any coherent observation.
//
// notify() is injected (the phase-1 notify seam), the clock is injected, and the
// state is a ReconcileState — so the whole thing is deterministic in tests.

import type { ReconcileStateApi } from "./state.ts";
import type { NotifyLevel } from "../notify.ts";
import type { BoxReport } from "../status.ts";

export interface AlertDeps {
  state: ReconcileStateApi;
  notify: (level: NotifyLevel, msg: string) => Promise<void> | void;
  nowSec: number;
  asleepTSecs?: number; // default 7200
  asleepDigestSecs?: number; // default 86400
  incidentRenotifySecs?: number; // default INCIDENT_RENOTIFY_SECS
  keepawakeStaleSecs?: number; // default KEEPAWAKE_STALE_SECS
}

/**
 * How long an UNRESOLVED incident stays quiet after it has been reported once.
 *
 * The incident alerts are LEVEL signals, not edges: `incoherent-both-dead` and
 * `reachable-cannot-converge` describe a condition that persists until someone
 * acts on it. The tick runs every 5 minutes, so before dedup a single unresolved
 * incident sent 288 identical messages a day, for as many days as it lasted —
 * grok-box-009 half-dead over 2026-09-02 is the worked example. The second and
 * later messages carry no information the first did not.
 *
 * A day matches the `asleep` digest cadence already in this file, so the two
 * long-running conditions a box can be in report at the same rhythm.
 */
export const INCIDENT_RENOTIFY_SECS = 86400;

/**
 * The incident kinds a tick can raise, as `alerts`-table keys (the action token
 * minus its `alert-` prefix). Anything on this list that a tick does NOT emit
 * gets cleared for that box, so a resolved incident that recurs pages at once
 * instead of waiting out the renotify window.
 *
 * Keep it exhaustive over `decide.ts`'s `alert-incident:*` tokens. A kind that
 * is raised but missing here still dedups; it just never re-arms, which is the
 * quiet failure — hence the test that walks decide.ts's own token list.
 */
export const INCIDENT_KINDS = [
  "incident:incoherent-both-dead",
  "incident:reachable-cannot-converge",
  "incident:duplicate-both-online",
] as const;

/** reconcile_alert_asleep (main:3218-3242). */
export async function alertAsleep(box: string, deps: AlertDeps): Promise<void> {
  const tSecs = deps.asleepTSecs ?? 7200;
  const digestSecs = deps.asleepDigestSecs ?? 86400;
  const now = deps.nowSec;
  const prev = deps.state.readAsleep(box);
  // first both-dead observation ⇒ since = now (main:3225)
  let since = prev && Number.isFinite(prev.since) ? prev.since : now;
  let last = prev && Number.isFinite(prev.last) ? prev.last : 0;

  if (last === 0) {
    // no alert yet: fire once asleep >= T
    if (now - since >= tSecs) {
      await deps.notify("info", `${box}: asleep — both paths dead for >= ${Math.floor(tSecs / 3600)}h`);
      last = now;
    }
  } else {
    // already alerted once: daily digest only
    if (now - last >= digestSecs) {
      await deps.notify("info", `${box}: still asleep (daily digest) — both paths dead since ${since}`);
      last = now;
    }
  }
  deps.state.writeAsleep(box, since, last);
}

/**
 * reconcile_alert_incoherent (main:3249-3259), now deduped.
 *
 * The counter still bumps on EVERY incoherent tick — it is the run count the
 * message quotes and the `>= 2` gate reads, and it is reset by the row-e marker
 * hygiene in run.ts. Only the SEND is throttled.
 */
export async function alertIncoherent(box: string, deps: AlertDeps): Promise<void> {
  const n = deps.state.bumpIncoherent(box);
  if (n < 2) return;
  const renotify = deps.incidentRenotifySecs ?? INCIDENT_RENOTIFY_SECS;
  if (!deps.state.alertDue(box, "incident:incoherent-both-dead", renotify, deps.nowSec)) return;
  await deps.notify(
    "warn",
    `${box}: incoherent-both-dead (API online yet both paths dead for ${n} consecutive runs)`,
  );
}


// --- box-reported conditions (5.13.0, box-conditions D2/D3a) ------------------
//
// `alertBoxConditions` is a POST-VERDICT pass, NOT a new `decide` row: `decide`
// is a pure function over ten brain-derived inputs with no box-reported token,
// which is exactly why box conditions raise here instead. Its precedent is the
// four kinds already raised outside `decide` and outside `INCIDENT_KINDS` —
// `enrol-stuck`, `job-<state>`, `lease-lost`, the canary kinds — each with its
// own clear discipline. run.ts calls this for every STATUS-SEEN box (D1b),
// immediately after the INCIDENT_KINDS re-arm loop and BEFORE the snapshot
// push (the push needs the `conditions` this returns).
//
// DESIGN CONSTRAINT (Decision.4, requirement 2): every kind is raised as a
// WRITTEN-OUT string literal at its own `alertDue` site — never
// `alertDue(box, CONDITION_KINDS[i], …)` and never a template built from a
// short name. That literal is the ONLY thing that puts a kind into the
// exhaustiveness scan's `emitted` set independently of the CONDITION_KINDS
// declaration, exactly as decide.ts does for the incidents. A refactor to a
// table-driven loop would silently re-open the hole the declaration-strip test
// guards — do not make one.

/**
 * `condition:keepawake-failing` gate (iv): a `keepawake_last` older than this
 * is not "failing NOW". Default two hours — longer than any configured
 * `interval_min`, short enough that a week-old failure does not count. `off`
 * boxes carry a stale failing rc forever (keepawake_rc is read back from a file
 * and not touched when keep-awake is off), which gate (i) `keepawakeOn` and
 * this window between them exclude. Overridable on `AlertDeps` like the other
 * windows.
 */
export const KEEPAWAKE_STALE_SECS = 7200;

/**
 * The box-reported condition kinds, as `alerts`-table keys — the FULL kind
 * (`condition:*`), because that is what `alertDue` is keyed on and what the
 * exhaustiveness scan compares against. The `conditions` array and the `COND`
 * column carry the SHORT names (the prefix stripped) in THIS order, via the one
 * `shortCondition` helper below so the two forms cannot drift.
 *
 * Order is load-bearing: `conditions` and `COND` present in this order
 * (`disk-fail`, `disk-warn`, `tick-wedged`, `keepawake-failing`,
 * `repair-failing`).
 */
export const CONDITION_KINDS = [
  "condition:disk-fail",
  "condition:disk-warn",
  "condition:tick-wedged",
  "condition:keepawake-failing",
  "condition:repair-failing",
] as const;

/** The `keepawake_rc` values that count as a live keep-awake failure (gate ii). */
const KEEPAWAKE_FAIL_RCS = new Set(["refused", "unreachable", "inert"]);

/** `condition:keepawake-failing` fires only after this many consecutive ticks. */
const KEEPAWAKE_FAIL_STREAK = 3;

/** Strip the `condition:` prefix — the ONE place the short/long forms convert. */
export function shortCondition(kind: string): string {
  return kind.startsWith("condition:") ? kind.slice("condition:".length) : kind;
}

/** ISO8601Z ⇒ epoch seconds, or undefined when unparseable. */
function epochSec(iso: string): number | undefined {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
}

/**
 * The post-verdict box-condition pass. Raises/clears each `CONDITION_KINDS`
 * kind for one status-seen box and RETURNS the short names of the kinds active
 * this tick, in `CONDITION_KINDS` order — the single source of truth D3a
 * carries into the snapshot so the column and the pager cannot disagree.
 *
 * `keepawake-failing` and `tick-wedged` are stateful (streak / delta), so their
 * activeness is decided from the state markers here, NOT re-derived from
 * `report` — the reason `conditions` is carried rather than recomputed.
 */
export async function alertBoxConditions(box: string, report: BoxReport, deps: AlertDeps): Promise<string[]> {
  const active: string[] = [];
  const renotify = deps.incidentRenotifySecs ?? INCIDENT_RENOTIFY_SECS;
  const staleSecs = deps.keepawakeStaleSecs ?? KEEPAWAKE_STALE_SECS;

  // 1. disk-fail (warn) — report.disk.level === "fail". Overlaps
  //    incident:reachable-cannot-converge deliberately (D2): a full box flips
  //    `boxup check` to FAIL and accrues checkfail too. This kind fires on the
  //    FIRST tick and names the cause; both alerts describe one fault.
  const diskFail = report.disk.level === "fail";
  if (diskFail) {
    active.push(shortCondition("condition:disk-fail"));
    if (deps.state.alertDue(box, "condition:disk-fail", renotify, deps.nowSec)) {
      await deps.notify("warn", `${box}: condition:disk-fail (root ${report.disk.pct ?? "?"}%)`);
    }
  } else {
    deps.state.alertClear(box, "condition:disk-fail");
  }

  // 2. disk-warn (info) — level "warn".
  const diskWarn = report.disk.level === "warn";
  if (diskWarn) {
    active.push(shortCondition("condition:disk-warn"));
    if (deps.state.alertDue(box, "condition:disk-warn", renotify, deps.nowSec)) {
      await deps.notify("info", `${box}: condition:disk-warn (root ${report.disk.pct ?? "?"}%)`);
    }
  } else {
    deps.state.alertClear(box, "condition:disk-warn");
  }

  // 3. tick-wedged (warn) — a DELTA, not a level: raised when tickwedge exceeds
  //    the highest this brain has recorded, then the record advances. A box
  //    seen for the first time records the value silently; a reboot/image-swap
  //    resets the box counter to 0 and a lower value overwrites the record
  //    without alerting. `$RUN_DIR/tickwedge` is never reset by boxup, so a
  //    level rule would page forever for one old wedge.
  const lastWedge = deps.state.lastTickwedge(box);
  const wedgeIncreased = report.tickwedge > lastWedge;
  if (wedgeIncreased) {
    active.push(shortCondition("condition:tick-wedged"));
    if (deps.state.alertDue(box, "condition:tick-wedged", renotify, deps.nowSec)) {
      await deps.notify("warn", `${box}: condition:tick-wedged (${report.tickwedge}, was ${lastWedge})`);
    }
    deps.state.setTickwedge(box, report.tickwedge);
  } else {
    // A lower or equal value overwrites the record (down is silent) and clears.
    if (report.tickwedge !== lastWedge) deps.state.setTickwedge(box, report.tickwedge);
    deps.state.alertClear(box, "condition:tick-wedged");
  }

  // 4. keepawake-failing (info) — ALL FOUR gates on 3 consecutive status-seen
  //    ticks: (i) keepawakeOn; (ii) rc ∈ {refused,unreachable,inert};
  //    (iii) keepawakeLast !== null; (iv) last within KEEPAWAKE_STALE_SECS.
  //    Gate (i) is the whole point: keepawake_rc is sticky across an off-switch,
  //    so 004/006 carry a failing rc with keep-awake OFF and must stay silent.
  const lastEpoch = report.keepawakeLast === null ? undefined : epochSec(report.keepawakeLast);
  const keepawakeQualifies =
    report.keepawakeOn &&
    report.keepawakeRc !== null &&
    KEEPAWAKE_FAIL_RCS.has(report.keepawakeRc) &&
    report.keepawakeLast !== null &&
    lastEpoch !== undefined &&
    deps.nowSec - lastEpoch <= staleSecs;
  if (keepawakeQualifies) {
    const streak = deps.state.bumpKeepawakeFail(box);
    if (streak >= KEEPAWAKE_FAIL_STREAK) {
      active.push(shortCondition("condition:keepawake-failing"));
      if (deps.state.alertDue(box, "condition:keepawake-failing", renotify, deps.nowSec)) {
        await deps.notify("info", `${box}: condition:keepawake-failing (rc=${report.keepawakeRc} for ${streak} ticks)`);
      }
    }
  } else {
    deps.state.resetKeepawakeFail(box);
    deps.state.alertClear(box, "condition:keepawake-failing");
  }

  // 5. repair-failing (warn) — repairFailing >= 3 || refreshFailing >= 3.
  const repairFailing = report.repairFailing >= 3 || report.refreshFailing >= 3;
  if (repairFailing) {
    active.push(shortCondition("condition:repair-failing"));
    if (deps.state.alertDue(box, "condition:repair-failing", renotify, deps.nowSec)) {
      await deps.notify(
        "warn",
        `${box}: condition:repair-failing (refresh=${report.refreshFailing} repair=${report.repairFailing})`,
      );
    }
  } else {
    deps.state.alertClear(box, "condition:repair-failing");
  }

  return active;
}

/**
 * The stateless subset of the conditions, evaluated from `report` ALONE — for
 * `grokfleet fleet-status`, which probes live and holds no tick state. The two
 * stateful kinds (`keepawake-failing`, `tick-wedged`) cannot be evaluated
 * without the streak/delta, so they are shown with a trailing `?` when the raw
 * token would qualify. Returns short names in `CONDITION_KINDS` order (D3d).
 */
export function statelessConditions(report: BoxReport): string[] {
  const out: string[] = [];
  if (report.disk.level === "fail") out.push("disk-fail");
  if (report.disk.level === "warn") out.push("disk-warn");
  // tick-wedged: raw non-zero counter would qualify, but the delta needs state.
  if (report.tickwedge > 0) out.push("tick-wedged?");
  // keepawake-failing: the raw token would qualify, but the streak needs state.
  if (
    report.keepawakeOn &&
    report.keepawakeRc !== null &&
    KEEPAWAKE_FAIL_RCS.has(report.keepawakeRc)
  ) {
    out.push("keepawake-failing?");
  }
  if (report.repairFailing >= 3 || report.refreshFailing >= 3) out.push("repair-failing");
  return out;
}
