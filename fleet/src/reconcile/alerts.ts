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

export interface AlertDeps {
  state: ReconcileStateApi;
  notify: (level: NotifyLevel, msg: string) => Promise<void> | void;
  nowSec: number;
  asleepTSecs?: number; // default 7200
  asleepDigestSecs?: number; // default 86400
  incidentRenotifySecs?: number; // default INCIDENT_RENOTIFY_SECS
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
