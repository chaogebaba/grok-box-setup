// cutover.ts — render the systemd drop-in for `make ts-cutover` (F7/G3/I1/I3).
//
// Two drop-in shapes:
//   WRAPPER (apply-flip form): mirrors vps/install-vps.sh:212 verbatim with the
//     binary swapped to /opt/grok-fleet/fleet2. `$apply` stays a BARE `$apply`
//     inside the single-quoted `bash -c` (T2 hazard: `${apply}` would be
//     expanded by systemd against the unit env to empty and --apply lost).
//   SOAK form: hard-coded `--dry-run` (config ignored) — the only path into the
//     timer during the gate/soak.
//
// The Makefile targets call `bun run src/cutover.ts <wrapper|soak>` to get the
// drop-in body, then install it; T16 asserts the rendered bytes + the refuse
// gate + the FORCE=1 marker contents. This module is PURE (no filesystem/systemd
// side effects) so it is unit-testable.

export const FLEET2_BIN = "/opt/grok-fleet/fleet2";
export const CONFIG_PATH = "/opt/grok-fleet/config.toml";
export const SOAK_MARKER = "/var/lib/grok-fleet/fleet2.soak-ok";
export const DROPIN_PATH = "/etc/systemd/system/fleet-reconcile.service.d/fleet2.conf";

/** The runtime-wrapper ExecStart (byte-identical to install-vps.sh:212, binary swapped). */
export function wrapperExecStart(): string {
  return (
    `ExecStart=/bin/bash -c 'apply=""; ` +
    `grep -Eq "^[[:space:]]*apply[[:space:]]*=[[:space:]]*true" ${CONFIG_PATH} && apply="--apply"; ` +
    `exec ${FLEET2_BIN} reconcile $apply'`
  );
}

/** The soak ExecStart: hard-coded --dry-run (config ignored). */
export function soakExecStart(): string {
  return `ExecStart=${FLEET2_BIN} reconcile --dry-run`;
}

/** The full drop-in body for a given mode (an ExecStart= reset + the new one). */
export function dropin(mode: "wrapper" | "soak"): string {
  const exec = mode === "wrapper" ? wrapperExecStart() : soakExecStart();
  return ["[Service]", "ExecStart=", exec, ""].join("\n");
}

/**
 * I3: required `reconcile: done (DRY-RUN)` count = ceil(0.69 × expected) where
 * expected = windowSeconds / 300. 24h ⇒ 288 ⇒ ceil(198.72) = 199.
 */
export function soakFloor(windowSeconds: number): number {
  const expected = windowSeconds / 300;
  return Math.ceil(0.69 * expected);
}

/** The FORCE=1 marker contents (I1): forced flip stays visible afterwards. */
export function forcedMarker(observed: number, required: number, failedRuns: string[], atIso: string): string {
  return `forced=1 observed=${observed} required=${required} failed_runs=${failedRuns.join(",")} at=${atIso}\n`;
}
