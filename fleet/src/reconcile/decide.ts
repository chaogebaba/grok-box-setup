// decide.ts — PURE port of reconcile_decide (main:2473-2524). No I/O.
//
// Signature mirrors bash main:2474-2475 EXACTLY (F10/S11: there is NO `<box>`
// parameter — the comment block at main:2467-2472 is stale). Returns the decided
// action tokens, one per array element, in bash's emission order. Multiple
// tokens may fire; `noop` iff none did.
//
// Rows (main:2477-2523), evaluated in this order:
//   b  dupcount>=2: both_online ⇒ alert-incident:duplicate-both-online, else delete-then-rename
//   a  (online=no || lastseen_fresh=no) && tunnel=up ⇒ mint
//   c  expiry_days!=unknown && expiry_days<7 && tunnel=up ⇒ rotate
//   d  drift=yes && tunnel=up ⇒ rollout
//   e  tunnel=down && online!=unknown: (online=no||fresh=no) ⇒ alert-asleep
//                                       else ⇒ alert-incident:incoherent-both-dead
//   N-1 tunnel=up && checkfail=yes && checkfail_runs>3 ⇒ alert-incident:reachable-cannot-converge
//   —  none ⇒ noop
//
// Deviation (D3/F10-S2): row c compares WHOLE days against
// floor(FLEET_ROTATE_BEFORE_SECS/86400); with the 604800 default this is
// bash's literal `< 7` exactly. The threshold is passed in (default 7) so the
// caller resolves the env; decide stays pure.

export type Tri = "yes" | "no" | "unknown";

export interface DecideInputs {
  online: Tri;
  lastseenFresh: Tri;
  dupcount: number;
  bothOnlineDup: "yes" | "no";
  tunnel: "up" | "down";
  checkfail: "yes" | "no";
  /** integer days to expiry, or "unknown" */
  expiryDays: number | "unknown";
  drift: "yes" | "no" | "unknown";
  checkfailRuns: number;
  /** row-c threshold in whole days (default 7 = floor(604800/86400)). */
  rotateBeforeDays?: number;
}

export function decide(inp: DecideInputs): string[] {
  const tokens: string[] = [];
  const rotateBeforeDays = inp.rotateBeforeDays ?? 7;

  // Row b: duplicate hostname. Never delete when both online.
  if (inp.dupcount >= 2) {
    tokens.push(
      inp.bothOnlineDup === "yes" ? "alert-incident:duplicate-both-online" : "delete-then-rename",
    );
  }
  // Row a: tailnet says gone/offline (absent or stale lastSeen) but tunnel alive.
  if ((inp.online === "no" || inp.lastseenFresh === "no") && inp.tunnel === "up") {
    tokens.push("mint");
  }
  // Row c: auth-key expiry < threshold days ⇒ rotate (needs a tunnel to seed over).
  if (inp.expiryDays !== "unknown" && inp.expiryDays < rotateBeforeDays && inp.tunnel === "up") {
    tokens.push("rotate");
  }
  // Row d: version drift, tunnel alive.
  if (inp.drift === "yes" && inp.tunnel === "up") {
    tokens.push("rollout");
  }
  // Row e: tunnel DOWN and we HAVE an API reading (online known).
  if (inp.tunnel === "down" && inp.online !== "unknown") {
    if (inp.online === "no" || inp.lastseenFresh === "no") {
      tokens.push("alert-asleep");
    } else {
      tokens.push("alert-incident:incoherent-both-dead");
    }
  }
  // N-1: reachable (tunnel up) but boxup check fails > 3 runs.
  if (inp.tunnel === "up" && inp.checkfail === "yes" && inp.checkfailRuns > 3) {
    tokens.push("alert-incident:reachable-cannot-converge");
  }

  return tokens.length > 0 ? tokens : ["noop"];
}
