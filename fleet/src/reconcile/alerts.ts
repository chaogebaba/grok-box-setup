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

import type { ReconcileState } from "./state.ts";
import type { NotifyLevel } from "../notify.ts";

export interface AlertDeps {
  state: ReconcileState;
  notify: (level: NotifyLevel, msg: string) => Promise<void> | void;
  nowSec: number;
  asleepTSecs?: number; // default 7200
  asleepDigestSecs?: number; // default 86400
}

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

/** reconcile_alert_incoherent (main:3249-3259). */
export async function alertIncoherent(box: string, deps: AlertDeps): Promise<void> {
  const n = deps.state.bumpIncoherent(box);
  if (n >= 2) {
    await deps.notify(
      "warn",
      `${box}: incoherent-both-dead (API online yet both paths dead for ${n} consecutive runs)`,
    );
  }
}
