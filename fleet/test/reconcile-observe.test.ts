// reconcile-observe.test.ts — D9 (h): the `observe` precedence table
// (blueprint fleet2-state-store D4).
//
// Mutant (m5) swaps `asleep` and `incoherent` in the precedence and this file is
// what kills it: the two disagree on exactly one input row, the one where both
// conditions hold at once, and that row is asserted explicitly below.

import { describe, expect, test } from "bun:test";
import { observe, OBSERVED_PRECEDENCE, isObserved, type ObserveInput, type Observed } from "../src/reconcile/observe.ts";

/** A HEALTHY box: every flag clear, tunnel up, check OK, no drift. */
function healthy(over: Partial<ObserveInput> = {}): ObserveInput {
  return {
    hostkeyMismatch: false,
    incoherent: false,
    asleep: false,
    online: "yes",
    tunnel: "up",
    check: "OK",
    drift: "no",
    ...over,
  };
}

describe("(h) observe: the precedence table", () => {
  test("the seven names, in the documented order", () => {
    expect(OBSERVED_PRECEDENCE).toEqual([
      "hostkey_mismatch",
      "incoherent",
      "asleep",
      "api_unknown",
      "unhealthy",
      "drifted",
      "healthy",
    ]);
    for (const n of OBSERVED_PRECEDENCE) expect(isObserved(n)).toBe(true);
    expect(isObserved("who-knows")).toBe(false);
  });

  // One case per level, each with EVERY lower-precedence condition also true, so
  // the assertion is about the ORDER and not about the level in isolation.
  const table: Array<{ want: Observed; input: ObserveInput; why: string }> = [
    {
      want: "hostkey_mismatch",
      why: "every reading taken through a wrong-host-key tunnel is about an unknown machine",
      input: healthy({
        hostkeyMismatch: true,
        incoherent: true,
        asleep: true,
        online: "unknown",
        tunnel: "down",
        check: "FAIL",
        drift: "yes",
      }),
    },
    {
      want: "incoherent",
      why: "the API and the paths contradict each other, so neither unhealthy nor asleep is honest",
      input: healthy({ incoherent: true, asleep: true, online: "unknown", tunnel: "down", check: "FAIL", drift: "yes" }),
    },
    {
      want: "asleep",
      why: "both paths dead AND the API agrees — there is nothing to be unhealthy about",
      input: healthy({ asleep: true, online: "unknown", tunnel: "down", check: "FAIL", drift: "yes" }),
    },
    {
      want: "api_unknown",
      why: "the devices GET failed or the run is latched, so `online` has no value this tick",
      input: healthy({ online: "unknown", tunnel: "down", check: "FAIL", drift: "yes" }),
    },
    {
      want: "unhealthy",
      why: "the tunnel is down or boxup check failed",
      input: healthy({ tunnel: "down", check: "-", drift: "yes" }),
    },
    {
      want: "drifted",
      why: "reachable and healthy, but not on the target VERSION",
      input: healthy({ drift: "yes" }),
    },
    { want: "healthy", why: "nothing to report", input: healthy() },
  ];

  for (const row of table) {
    test(`${row.want}: ${row.why}`, () => {
      expect(observe(row.input)).toBe(row.want);
    });
  }

  // (m5): swapping asleep and incoherent changes THIS row and no other.
  test("(m5) a box that is both incoherent and asleep reads `incoherent`", () => {
    expect(observe(healthy({ incoherent: true, asleep: true }))).toBe("incoherent");
    // ...and one that is only asleep still reads `asleep`, so the mutant cannot
    // pass by collapsing both to one name.
    expect(observe(healthy({ asleep: true }))).toBe("asleep");
    expect(observe(healthy({ incoherent: true }))).toBe("incoherent");
  });

  test("a FAIL check on an up tunnel is unhealthy, not drifted", () => {
    expect(observe(healthy({ check: "FAIL", drift: "yes" }))).toBe("unhealthy");
  });

  test("an offline box the API KNOWS about is unhealthy, not api_unknown", () => {
    // `online: "no"` is an ANSWER; only "unknown" is the absence of one.
    expect(observe(healthy({ online: "no", tunnel: "down", check: "-" }))).toBe("unhealthy");
  });

  test("drift `unknown` never reads as drifted", () => {
    expect(observe(healthy({ drift: "unknown" }))).toBe("healthy");
  });
});
