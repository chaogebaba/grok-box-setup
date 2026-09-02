// ts-options.ts — how a TUI run renders the detail card's timestamps.
//
// Deliberately import-free: `main.ts` pulls in Ink and React, and this decision
// has to be readable from a plain `bun -e` (and from a test) without starting a
// renderer.

/** The per-run timestamp settings carried into `TuiState`. */
export interface TsOptions {
  /** IANA zone the detail card renders wall-clock readings in. */
  tz: string;
  /** print the raw UTC ISO strings instead of local wall-clock time. */
  utcRaw: boolean;
}

/**
 * `--utc` and FLEET_TUI_UTC=1 are equivalent: the flag for a one-off, the
 * variable for a wrapper or a screenshot job that must not drift with the
 * host's zone. Only the exact value `1` counts, so an accidental
 * `FLEET_TUI_UTC=0` does not silently turn it on.
 */
export function resolveTsOptions(rest: string[], utcEnv: string | undefined, zone: () => string): TsOptions {
  return { tz: zone(), utcRaw: rest.includes("--utc") || utcEnv === "1" };
}

/**
 * The host's IANA zone, which is what the operator reads their own clock in.
 * `Intl` honours TZ, so `TZ=UTC fleet2 tui` is a third way to get UTC readings
 * alongside `--utc` and FLEET_TUI_UTC=1 — the difference being that those two
 * print raw ISO strings while TZ only moves the wall clock.
 */
export function hostZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
