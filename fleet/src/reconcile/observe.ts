// observe.ts — liveness named ONCE (blueprint fleet2-state-store D4, Phase B).
//
// Before 5.9.0 a box's liveness was a TUPLE re-derived on every read: the tick
// had `tunnel`/`check`/`drift`/`online` plus four marker files, the API had a
// snapshot row plus three live markers, and the TUI had a colour rule of its
// own. Nothing anywhere carried a NAME for the state, so no two readers could be
// shown to agree.
//
// `observe()` is that name, computed once per box per tick from the tuple
// `run.ts` already has, written into `snapshot_boxes.observed`, and served from
// there to `GET /v1/boxes/:name` and the TUI Detail card.
//
// It is a LABEL, not a decision input: `decide.ts` is untouched and no action
// anywhere branches on it. That is deliberate — the decision table is the
// engine's contract and this blueprint does not reopen it.

/** The seven liveness names, in precedence order (worst first). */
export type Observed =
  | "hostkey_mismatch"
  | "incoherent"
  | "asleep"
  | "api_unknown"
  | "unhealthy"
  | "drifted"
  | "healthy";

/**
 * PRECEDENCE (D4), highest first:
 *
 *   hostkey_mismatch > incoherent > asleep > api_unknown > unhealthy > drifted > healthy
 *
 * The order is not arbitrary — each level names a reason the level BELOW it
 * cannot be trusted:
 *
 *  - `hostkey_mismatch`: the tunnel answered with the wrong host key, so every
 *    reading taken through it this tick is about an unknown machine.
 *  - `incoherent`: the API says the box is online while both paths are dead —
 *    the two sources contradict each other, so neither `unhealthy` nor `asleep`
 *    is the honest word for it.
 *  - `asleep`: both paths dead AND the API agrees the box is gone. There is
 *    nothing to be unhealthy about.
 *  - `api_unknown`: the devices GET failed or the run is latched read-only, so
 *    "online" has no value this tick. Reported rather than guessed.
 *  - `unhealthy`: the tunnel is down, or `boxup check` failed.
 *  - `drifted`: reachable and healthy, but not on the target VERSION.
 */
export const OBSERVED_PRECEDENCE: Observed[] = [
  "hostkey_mismatch",
  "incoherent",
  "asleep",
  "api_unknown",
  "unhealthy",
  "drifted",
  "healthy",
];

/** The tick facts `observe` reads — every one of them already computed in run.ts. */
export interface ObserveInput {
  /** D11(c): a tunnel call met the REMOTE HOST IDENTIFICATION banner this tick. */
  hostkeyMismatch: boolean;
  /** row e fired: the API says online while both paths are dead. */
  incoherent: boolean;
  /** the `alert-asleep` observation (both paths dead, API agrees). */
  asleep: boolean;
  /** devFields online, or "unknown" on a failed GET / a latched read-only run. */
  online: "yes" | "no" | "unknown";
  tunnel: "up" | "down";
  /** fleet-status CHECK semantics: "-" when the tunnel was down (never probed). */
  check: "OK" | "FAIL" | "-";
  drift: "yes" | "no" | "unknown";
}

/** Name this box's liveness (D4). Pure; the precedence above is the whole rule. */
export function observe(f: ObserveInput): Observed {
  if (f.hostkeyMismatch) return "hostkey_mismatch";
  if (f.incoherent) return "incoherent";
  if (f.asleep) return "asleep";
  if (f.online === "unknown") return "api_unknown";
  if (f.tunnel === "down" || f.check === "FAIL") return "unhealthy";
  if (f.drift === "yes") return "drifted";
  return "healthy";
}

/** Is `s` one of the seven names? (validating a value read back from the store) */
export function isObserved(s: string): s is Observed {
  return (OBSERVED_PRECEDENCE as string[]).includes(s);
}
