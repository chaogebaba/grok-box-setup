// T16 — cutover drop-in rendering (F7/G3/I1/I3): wrapper vs soak ExecStart, the
// bare-$apply hazard (T2), the soak floor scaling (I3), and the FORCE=1 marker.

import { test, expect, describe } from "bun:test";
import {
  wrapperExecStart,
  soakExecStart,
  dropin,
  soakFloor,
  forcedMarker,
  FLEET2_BIN,
} from "../src/cutover.ts";

describe("T16 cutover drop-in", () => {
  test("wrapper ExecStart mirrors install-vps.sh:212 with the binary swapped", () => {
    const e = wrapperExecStart();
    expect(e).toBe(
      `ExecStart=/bin/bash -c 'apply=""; grep -Eq "^[[:space:]]*apply[[:space:]]*=[[:space:]]*true" /opt/grok-fleet/config.toml && apply="--apply"; exec ${FLEET2_BIN} reconcile $apply'`,
    );
  });

  test("T2 hazard: $apply stays a BARE $apply (never ${apply})", () => {
    expect(wrapperExecStart()).toContain("reconcile $apply'");
    expect(wrapperExecStart().includes("${apply}")).toBe(false);
  });

  test("soak ExecStart is hard-coded --dry-run (config ignored)", () => {
    expect(soakExecStart()).toBe(`ExecStart=${FLEET2_BIN} reconcile --dry-run`);
  });

  test("drop-in resets ExecStart before setting the new one", () => {
    const d = dropin("soak");
    expect(d.startsWith("[Service]\nExecStart=\nExecStart=")).toBe(true);
    expect(d).toContain("reconcile --dry-run");
    const w = dropin("wrapper");
    expect(w).toContain("[Service]\nExecStart=\nExecStart=/bin/bash -c");
  });

  test("I3 soak floor = ceil(0.69 × window/300); 24h ⇒ 199", () => {
    expect(soakFloor(24 * 3600)).toBe(199);
    // a 48h window scales up
    expect(soakFloor(48 * 3600)).toBe(Math.ceil(0.69 * ((48 * 3600) / 300)));
    expect(soakFloor(48 * 3600)).toBe(398);
  });

  test("I1 FORCE=1 marker records the skipped-soak provenance", () => {
    const m = forcedMarker(120, 199, ["2026-08-30T01:00:00Z"], "2026-08-30T02:00:00Z");
    expect(m).toBe("forced=1 observed=120 required=199 failed_runs=2026-08-30T01:00:00Z at=2026-08-30T02:00:00Z\n");
  });
});
