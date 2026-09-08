// identity.ts — reconcile_identity_pass port (main:2634-2702). LOG-ONLY: no
// notify, no counter, no threshold, no API mutation; never affects rc.
//
// The DEVICE loop (main:2639-2681) runs only when devs is non-empty; it flags
// UNTAGGED / EXPIRY(keyExpiryDisabled!=true) / OK per grok-box device and LEGACY
// for a non-canonical original name. The ENROLLED-NAMES loop (main:2683-2696) is
// UNGATED (G2): it logs `identity: <box> legacy-name` for any enrolled name that
// is not canonical grok-box-NNN and was not already reported. The summary line
// `identity: ok=N flagged=M` is emitted ONLY when devs is non-empty (main:2700).
//
// base() here is STRICTER than dev_field's (main:2666-2669): strip a trailing
// -1 ONLY when the remainder is still a valid grok-box-N (never maul grok-box-1).

import { log } from "../log.ts";
import type { ReconcileStateApi } from "./state.ts";

/** identity base(): grok-box-N as-is, grok-box-N-1 folded, else "". */
export function identityBase(h: string): string {
  if (/^grok-box-[0-9]+$/.test(h)) return h;
  if (/^grok-box-[0-9]+-1$/.test(h)) return h.replace(/-1$/, "");
  return "";
}

interface RawDevice {
  hostname?: string;
  name?: string;
  tags?: unknown[];
  keyExpiryDisabled?: boolean;
  expires?: string;
}

export interface IdentityDeps {
  /** raw devices JSON body (empty on a read-only/failed-GET run). */
  devs: string;
  /** enrolled/target box names in reconcile order. */
  targetBoxes: string[];
  /**
   * 5.14.4: the tick's state, for the once-per-transition memo on the summary
   * line. Optional so non-tick callers/tests that do not care about de-noising
   * keep the every-tick behaviour (a missing state ⇒ log every time).
   */
  state?: ReconcileStateApi;
}

export function identityPass(deps: IdentityDeps): void {
  let ok = 0;
  let flagged = 0;
  const legacySeen = new Set<string>();

  if (deps.devs.trim() !== "") {
    let parsed: { devices?: unknown } = {};
    try {
      parsed = JSON.parse(deps.devs);
    } catch {
      parsed = {};
    }
    const devices = Array.isArray(parsed.devices) ? (parsed.devices as RawDevice[]) : [];
    for (const d of devices) {
      const orig = d.hostname ?? d.name ?? "";
      const b = identityBase(orig);
      if (b === "") continue;
      // tags/expiry classification (main:2674-2678)
      if ((d.tags ?? []).length === 0) {
        flagged++;
        log(`identity: ${b} untagged`);
      } else if (d.keyExpiryDisabled !== true) {
        flagged++;
        log(`identity: ${b} key-expiry-enabled expires=${d.expires ?? ""}`);
      } else {
        ok++;
      }
      // legacy-name when the ORIGINAL name is not canonical grok-box-NNN.
      if (!/^grok-box-[0-9]{3}$/.test(orig)) {
        log(`identity: ${b} legacy-name`);
        legacySeen.add(b);
      }
    }
  }

  // Enrolled-names legacy pass — UNGATED (G2), runs even on empty devs.
  for (const eb of deps.targetBoxes) {
    if (eb === "") continue;
    if (/^grok-box-[0-9][0-9][0-9]$/.test(eb)) continue; // already canonical
    if (!eb.startsWith("grok-box-")) continue;
    if (legacySeen.has(eb)) continue; // already reported above
    log(`identity: ${eb} legacy-name`);
    legacySeen.add(eb);
  }

  // Summary reflects the DEVICE analysis; silent on a read-only run. 5.14.4:
  // emit only when the tuple changed (or first sight / no state), then record —
  // the memo write is COUPLED to the emit (a silent empty-devs tick never gets
  // here, so never writes), mirroring driftPair. A store that cannot record
  // reads the old value next tick and the line re-emits (log-every-tick).
  if (deps.devs.trim() !== "") {
    const tuple = `${ok}|${flagged}`;
    if (deps.state === undefined || deps.state.logMemo("log.identity") !== tuple) {
      log(`identity: ok=${ok} flagged=${flagged}`);
      deps.state?.setLogMemo("log.identity", tuple);
    }
  }
}
