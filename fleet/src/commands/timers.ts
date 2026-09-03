// timers.ts — `grokfleet install-timer` (retired, D6) + `grokfleet remove-timer`
// (kept, F7/M5), the laptop-side systemd USER timer commands.
//
// install-timer is DROPPED as a feature (D6): it printed a retirement line and
// exits rc 2 — the VPS grokfleet-reconcile.timer alerts instead. It is NOT listed
// in usage() (M5); discoverable only by invoking it.
//
// remove-timer is KEPT and functional (F7/M5), a port of cmd_remove_timer
// (main:754-760): no systemctl ⇒ rc 1 `remove-timer: systemctl not found`
// (main:755); else `systemctl --user disable --now` (errors swallowed) + `rm -f`
// BOTH unit files + `systemctl --user daemon-reload`, then log
// `remove-timer: removed fleetctl-check timer + service` (main:759) rc 0. Same
// on-disk unit names as bash (`fleetctl-check.{timer,service}`) so an operator's
// existing laptop timer is cleaned up.

import type { Runner } from "../runner.ts";
import { log } from "../log.ts";

const SYSTEMCTL_TIMEOUT_MS = 15_000;

const UNIT_TIMER = "fleetctl-check.timer";
const UNIT_SERVICE = "fleetctl-check.service";

/** The retirement line printed by `grokfleet install-timer` (D6). rc 2. */
export const INSTALL_TIMER_RETIRED_LINE =
  "install-timer was retired in 5.4.0 — the VPS grokfleet-reconcile.timer alerts instead (docs/FLEET-BRAIN.md)";

/** cmd_install_timer (retired): log the retirement line, rc 2. */
export function cmdInstallTimer(): number {
  log(INSTALL_TIMER_RETIRED_LINE);
  return 2;
}

/** Seams over `systemctl` presence + fs unlink so tests run box-free. */
export interface TimerDeps {
  runner: Runner;
  /** Return the resolved path to systemctl, or undefined when absent (`command -v`). */
  which: (bin: string) => Promise<string | undefined>;
  /** Remove a user unit file (best-effort, errors swallowed). */
  unitDir: string; // e.g. `${HOME}/.config/systemd/user`
  removeFile: (path: string) => Promise<void>;
}

/** cmd_remove_timer (main:754-760). */
export async function cmdRemoveTimer(deps: TimerDeps): Promise<number> {
  const sc = await deps.which("systemctl");
  if (sc === undefined) {
    log("remove-timer: systemctl not found");
    return 1;
  }
  // disable --now (errors swallowed, main:756).
  await deps.runner.run(["systemctl", "--user", "disable", "--now", UNIT_TIMER], {
    timeoutMs: SYSTEMCTL_TIMEOUT_MS,
  });
  // rm -f both units (main:757).
  await deps.removeFile(`${deps.unitDir}/${UNIT_TIMER}`);
  await deps.removeFile(`${deps.unitDir}/${UNIT_SERVICE}`);
  // daemon-reload (main:758).
  await deps.runner.run(["systemctl", "--user", "daemon-reload"], {
    timeoutMs: SYSTEMCTL_TIMEOUT_MS,
  });
  log("remove-timer: removed fleetctl-check timer + service"); // main:759, verbatim
  return 0;
}
