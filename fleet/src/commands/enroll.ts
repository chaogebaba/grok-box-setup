// enroll.ts — `fleet2 enroll [--no-box-config] <grok-box-N>` (D10), the VPS-side
// box-enrollment command. Ports cmd_enroll (main:1052-1215) + its helpers
// (main:1035-1330, 1374-1505, 1792-1840). The side-effecting steps are behind an
// injectable `EnrollSideEffects` seam so tests drive the real orchestration with
// stubbed transport (mirrors bash's enroll_run harness).
//
// rc map (§8): 0 ok (incl. WAIT=0) / 1 policy-ACL-pubkey-key-install-box-config
// / 2 usage / 4 tunnel timeout / 5 permitlisten DENIED / 6 not-on-VPS.
//
// The box's [fleet]-block remote script (enroll_write_box_config, main:1391-1476)
// is copied VERBATIM into WRITE_BOX_CONFIG_REMOTE below (D2). The enroll box_ssh
// transport is the TAILNET `sshpass -e ssh box@<box>` (main:206-215), NOT the
// reverse tunnel — enroll runs before the tunnel is trusted.

import { boxIndex, portFor } from "../boxes.ts";
import { log } from "../log.ts";

const BOX_TUNNEL_PUB = "/workspace/box-setup/secrets/tunnel_ed25519.pub";
const BOX_CONFIG = "/workspace/box-setup/config.toml";
const BOXUP_REMOTE = "/workspace/box-setup/boxup";

/** authorized_keys_line (main:1035-1038), verbatim. */
export function authorizedKeysLine(port: number, pubkey: string): string {
  return `restrict,port-forwarding,permitlisten="127.0.0.1:${port}" ${pubkey}`;
}

/**
 * Parse `sshd -T -C user=fleet` output for the permitlisten verdict (main:1792-1804):
 *   0 allowed (a token is `any` or `127.0.0.1:<port>`)
 *   1 unknown (no permitlisten tokens at all / sshd -T failed)
 *   2 denied  (tokens present but none match)
 * `out` undefined ⇒ sshd -T failed ⇒ 1.
 */
export function permitlistenVerdict(out: string | undefined, port: number): 0 | 1 | 2 {
  if (out === undefined) return 1;
  const toks: string[] = [];
  for (const line of out.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[0] === "permitlisten") for (let i = 1; i < f.length; i++) toks.push(f[i]!);
  }
  if (toks.length === 0) return 1;
  for (const t of toks) {
    if (t === "any" || t === `127.0.0.1:${port}`) return 0;
  }
  return 2;
}

/**
 * enroll_write_box_config remote script (main:1391-1476), VERBATIM. Delivered to
 * the box as `sudo sh -s -- '<vps>' '<idx>' '<BOX_CONFIG>' '<want_port>'` with
 * the script on STDIN. Zero apostrophes/backticks would break the outer `sh -s`;
 * the awk body IS apostrophe-bearing (bash wraps it as '"'"'…'"'"'), so this
 * constant reproduces the exact bytes bash pipes over box_ssh — E1 scan
 * (enrollWriteBoxConfigApostropheSafe) is limited to the outer sh wrapper.
 */
export const WRITE_BOX_CONFIG_REMOTE = `
set -e
want_vps="$1"; want_idx="$2"; cf="$3"; want_port="$4"
[ -f "$cf" ] || { echo "enroll: box config not found: $cf" >&2; exit 4; }
tmp="$(mktemp "\${cf}.enroll.XXXXXX")" || exit 1
awk -v want_vps="$want_vps" -v want_idx="$want_idx" -v want_port="$want_port" '
  function trim(s){ sub(/^[ \\t\\r]+/,"",s); sub(/[ \\t\\r]+$/,"",s); return s }
  function active_key(line,   t,eq){
    t=trim(line)
    if (t=="" || substr(t,1,1)=="#") return ""
    eq=index(t,"="); if (eq==0) return ""
    return trim(substr(t,1,eq-1))
  }
  function comment_key(line,   t,eq){
    t=trim(line)
    if (substr(t,1,1)!="#") return ""
    sub(/^#[ \\t]*/,"",t)
    eq=index(t,"="); if (eq==0) return ""
    return trim(substr(t,1,eq-1))
  }
  function vps_line()  { return "vps = \\"" want_vps "\\"" }
  function idx_line()  { return "box_index = " want_idx }
  function port_line() { return "port = " want_port }
  function flush_fleet() {
    if (!wrote_vps)  { print vps_line();  wrote_vps=1 }
    if (!wrote_idx)  { print idx_line();  wrote_idx=1 }
    if (want_port!="" && !wrote_port) { print port_line(); wrote_port=1 }
  }
  BEGIN { in_fleet=0; seen_fleet=0; wrote_vps=0; wrote_idx=0; wrote_port=0
          scan=1; have_vps=0; have_idx=0; have_port=0 }
  NR==FNR {
    t=trim($0)
    if (t ~ /^\\[/) { scan=(t=="[fleet]"); next }
    if (scan) {
      ak=active_key($0)
      if (ak=="vps") have_vps=1
      if (ak=="box_index") have_idx=1
      if (ak=="port") have_port=1
    }
    next
  }
  /^[ \\t]*\\[/ {
    t=trim($0)
    if (in_fleet) { flush_fleet(); in_fleet=0 }
    if (t=="[fleet]") { in_fleet=1; seen_fleet=1 }
    print; next
  }
  {
    if (in_fleet) {
      ak=active_key($0)
      if (ak=="vps")       { print vps_line();  wrote_vps=1;  next }
      if (ak=="box_index") { print idx_line();  wrote_idx=1;  next }
      if (ak=="port") {
        if (want_port!="") { print port_line(); wrote_port=1 }
        next
      }
      ck=comment_key($0)
      if (ck=="vps" && !have_vps && !wrote_vps)             { print; print vps_line();  wrote_vps=1;  next }
      if (ck=="box_index" && !have_idx && !wrote_idx)       { print; print idx_line();  wrote_idx=1;  next }
      if (ck=="port" && want_port!="" && !have_port && !wrote_port) { print; print port_line(); wrote_port=1; next }
    }
    print
  }
  END {
    if (in_fleet) { flush_fleet() }
    else if (!seen_fleet) {
      print "[fleet]"
      print vps_line()
      print idx_line()
      if (want_port!="") print port_line()
    }
  }
' "$cf" "$cf" > "$tmp"
if cmp -s "$cf" "$tmp"; then
  rm -f "$tmp"
  exit 0
fi
chmod 600 "$tmp"
mv -f "$tmp" "$cf"
chmod 600 "$cf"
`;

/** Injectable side-effect seam (each = a bash stubbable enroll helper). */
export interface EnrollSideEffects {
  /** id -u FLEET_VPS_USER — true when the fleet user exists (locality guard). */
  vpsUserExists(): Promise<boolean>;
  /** `have sshd` — true when sshd is on PATH. */
  haveSshd(): Promise<boolean>;
  /** sshd -T -C user=fleet output (undefined ⇒ failed). */
  sshdEffective(): Promise<string | undefined>;
  /** fleet_vps_addr — VPS address, or undefined ⇒ refuse. */
  fleetVpsAddr(): string | undefined;
  /** fleet_vps_port — default 22. */
  fleetVpsPort(): string;
  /** acl_has_fleet_brain_tagowner: 0 present / 1 absent / 2 API failure. */
  aclHasFleetBrainTagowner(): Promise<0 | 1 | 2>;
  /** last TS_API_CODE for the ACL log line. */
  lastApiCode(): number;
  /** read the box tunnel pubkey over the tailnet (undefined ⇒ fail). */
  readBoxPubkey(box: string): Promise<string | undefined>;
  /** tunnel_up(box) — VPS-side listener probe. */
  tunnelUp(box: string): Promise<boolean>;
  /**
   * D11(b)(i): forget this box's known_hosts pins at THIS identity-binding
   * moment, so an enrol (manual, adopt or repair) always binds from a clean
   * pin. Local processes only; never fatal; the tunnel spec is fail-closed
   * behind the listener ownership check inside forgetHostKeys.
   */
  forgetHostKeys(box: string, port: number): Promise<void>;
  /** install the VPS authorized_keys line (BUG-E perms). */
  installVpsAuthorizedKey(line: string): Promise<boolean>;
  /** /etc mapping copy (non-fatal). */
  recordEtcMapping(box: string, port: number, line: string): Promise<boolean>;
  /** the VPS box-access pubkey (undefined ⇒ no key). */
  vpsBoxAccessPubkey(): Promise<string | undefined>;
  /** install that pubkey into the box authorized_keys. */
  installBoxAuthorizedKey(box: string, pubkey: string): Promise<boolean>;
  /** enroll_write_box_config: 0 ok / 4 absent / 1 other. */
  writeBoxConfig(box: string, vps: string, idx: number, port: string): Promise<0 | 1 | 4>;
  /** enroll_record_enrolled (idempotent). */
  /**
   * Record membership. From 5.8.0 this writes the STORE and then exports the
   * legacy files (state-store D6); the returned string is the EXPORT error, if
   * any. The store write has already committed when it is set, so the enrolment
   * is a success with a lagging export — rc 7, never a failure.
   */
  recordEnrolled(box: string, port: number, pubkey?: string): Promise<string | undefined>;
  /** notify info. */
  notify(level: "info" | "warn", msg: string): Promise<void>;
  /** the ENROLL_TUNNEL_WAIT budget (raw env string). */
  tunnelWaitBudget(): string;
  /** sleep 5s (stubbed in tests). */
  sleep5(): Promise<void>;

  // --- the enrol SAGA (state-store D5, Phase B) ------------------------------
  //
  // Five EXTERNAL stages, in exactly this order:
  //   1 installVpsAuthorizedKey   3 installBoxAuthorizedKey   5 recordEnrolled
  //   2 recordEtcMapping          4 writeBoxConfig
  //
  // Stages 1–4 are re-runnable (the box-side install `grep -vF`s the key then
  // appends and `mv -f`s; the VPS-side writes dedup by port and key material),
  // which is what lets the resume pass restart from `enrol_stage` instead of
  // from scratch.
  //
  // All three are OPTIONAL. A caller that supplies none gets the 5.8.0
  // behaviour — every stage runs, nothing is staged — which is what keeps the
  // box-free enroll tests hermetic against a store they do not have.

  /**
   * Open or RESUME the saga and return the stage already reached (0 ⇒ run them
   * all). Called after the tunnel pubkey is read and before stage 1, so a
   * failure at the ACL or pubkey step leaves no `enrolling` row behind.
   */
  beginEnrol?(box: string, port: number, pubkey?: string): Promise<{ stage: number }>;
  /** A stage COMPLETED. `warn` is stage 2's warning path (D5). */
  stageOk?(box: string, stage: number, warn?: string): Promise<void>;
  /** A stage was ATTEMPTED and FAILED: record it, bump the streak, do not advance. */
  stageFailed?(box: string, stage: number, warn: string): Promise<void>;
}

/** enroll_wait_tunnel (main:1818-1840): rc 0 up/skip, rc 4 timeout. */
export async function waitTunnel(box: string, se: EnrollSideEffects): Promise<0 | 4> {
  const port = portFor(box);
  const portStr = port === undefined ? "?" : String(port);
  const raw = se.tunnelWaitBudget();
  let budget: number;
  if (raw === "0") return 0; // skip
  if (raw === "" || /[^0-9]/.test(raw)) {
    log(`enroll: ENROLL_TUNNEL_WAIT='${raw}' is not a non-negative integer — using 90`);
    budget = 90;
  } else {
    budget = Number.parseInt(raw, 10);
    if (budget === 0) return 0;
  }
  let elapsed = 0;
  for (;;) {
    if (await se.tunnelUp(box)) {
      log(`enroll: ${box} tunnel up on 127.0.0.1:${portStr}`);
      return 0;
    }
    // timeout-BEFORE-sleep (F5): a budget < 5 never sleeps.
    elapsed += 5;
    if (elapsed >= budget) {
      log(
        `enroll: ${box} DONE but tunnel NOT up after ${budget}s — inspect: sshd -T -C user=fleet | grep -i permitlisten ; and the box's boxup log`,
      );
      return 4;
    }
    await se.sleep5();
  }
}

export interface EnrollArgs {
  box: string;
  writeBoxConfig: boolean;
}

/** Parse enroll argv (--no-box-config, order-independent; sole positional). */
export function parseEnrollArgs(args: string[]): EnrollArgs | { usage: true } {
  let write = true;
  const rest: string[] = [];
  for (const a of args) {
    if (a === "--no-box-config") write = false;
    else rest.push(a);
  }
  const box = rest[0];
  if (box === undefined || box === "") return { usage: true };
  return { box, writeBoxConfig: write };
}

/**
 * The enrol RESULT (state-store D6/r5-B4). A committed enrolment whose legacy
 * export lagged is `{rc: 0, exportError}` — NOT a failure. The discover adopt
 * path branches on `rc === 0` (discover.ts:496-508), so it counts such an
 * enrolment as ADOPTED and clears the failure ledger, logging one warning; the
 * CLI wrapper turns the same result into exit code 7.
 */
export interface EnrollResult {
  rc: number;
  exportError?: string;
}

/** cmd_enroll orchestrator (main:1052-1215). */
export async function cmdEnrollResult(args: string[], se: EnrollSideEffects): Promise<EnrollResult> {
  const parsed = parseEnrollArgs(args);
  if ("usage" in parsed) {
    log("usage: fleet2 enroll [--no-box-config] <grok-box-N>");
    return { rc: 2 };
  }
  const { box, writeBoxConfig } = parsed;
  if (!/^grok-box-[0-9]/.test(box)) {
    log(`enroll: refusing non-grok box '${box}'`);
    return { rc: 2 };
  }
  const n = boxIndex(box);
  if (n === undefined) {
    log(`enroll: bad box name '${box}'`);
    return { rc: 2 };
  }
  const port = portFor(box)!;

  // Locality guard (F4) — rc 6 before any side effect.
  if (!(await se.vpsUserExists())) {
    log(`enroll: must run on the VPS (user fleet not present here) — see docs/FLEET-BRAIN.md`);
    return { rc: 6 };
  }

  // Policy precheck (D4/F2/F6) — rc 5 on DENIED; rc 1-verdict warn continues.
  if (await se.haveSshd()) {
    const v = permitlistenVerdict(await se.sshdEffective(), port);
    if (v === 2) {
      log(
        `enroll: sshd effective permitlisten for fleet does not include 127.0.0.1:${port} — re-run vps/install-vps.sh (#12)`,
      );
      return { rc: 5 };
    } else if (v === 1) {
      log(`enroll: cannot evaluate sshd permitlisten policy (sshd -T failed) — continuing`);
    }
  }

  // D11(b)(i): the forget goes HERE — after the rc-6 locality guard and the
  // rc-5 permitlisten guard, which the design requires to run "before any side
  // effect", and a forget IS a side effect on the engine's own file; and before
  // the `acl` abort point, so every remote step below meets a clean pin.
  await se.forgetHostKeys(box, port);

  // (0) VPS address precheck (D1) — skipped under --no-box-config.
  let vps = "";
  let vpsPort = "22";
  if (writeBoxConfig) {
    const addr = se.fleetVpsAddr();
    if (addr === undefined) {
      log("enroll: REFUSING — no VPS address resolved for the box-side [fleet].vps.");
      log('enroll: set FLEET_VPS_ADDR in the env, or add  vps = "<addr>"  under');
      log("enroll: [fleet-brain] in the brain config (docs/FLEET-BRAIN.md §ops).");
      log("enroll: (or pass --no-box-config to skip the box-side write entirely).");
      return { rc: 1 };
    }
    vps = addr;
    vpsPort = se.fleetVpsPort();
  }

  // (1) ACL precheck (fail-closed).
  const aclRc = await se.aclHasFleetBrainTagowner();
  if (aclRc === 2) {
    log(`enroll: ACL read FAILED (HTTP ${se.lastApiCode()}) — refusing (cannot confirm tag:fleet-brain tagOwners)`);
    return { rc: 1 };
  }
  if (aclRc !== 0) {
    log("enroll: REFUSING — 'tag:fleet-brain' has no tagOwners entry in the ACL.");
    log('enroll: add  "tag:fleet-brain": ["autogroup:admin"]  to tagOwners first (Resolved decision 3),');
    log("enroll: else a tagged rejoin fails opaquely.");
    return { rc: 1 };
  }

  // (2) read the box tunnel pubkey.
  log(`enroll: reading ${box} tunnel pubkey over OpenSSH on the tailnet`);
  const pubkey = await se.readBoxPubkey(box);
  if (pubkey === undefined) {
    log(`enroll: could not read ${BOX_TUNNEL_PUB} on ${box} (is it on the tailnet? has boxup run once?)`);
    return { rc: 1 };
  }
  if (!pubkey.startsWith("ssh-ed25519 ")) {
    log(`enroll: unexpected pubkey shape from ${box}: [${pubkey.split(" ")[0]} ...]`);
    return { rc: 1 };
  }

  // (F7) pre-listener warning (log-only).
  if (await se.tunnelUp(box)) {
    log(
      `enroll: WARNING 127.0.0.1:${port} already has a listener before enrol — tunnel-up proof may be a false positive`,
    );
  }

  // --- the SAGA opens here (state-store D5) ---------------------------------
  // The row is created (or resumed, or revived from `retired`) BEFORE the first
  // external write, so a crash after stage 1 leaves a record of exactly how far
  // the enrolment got. Everything above this line is a precheck that wrote
  // nothing, so a failure there must leave no `enrolling` row.
  const line = authorizedKeysLine(port, pubkey);
  const material = pubkey.split(/\s+/)[1];
  const done = (await se.beginEnrol?.(box, port, material))?.stage ?? 0;
  if (done > 0) log(`enroll: ${box} resuming the enrol saga from stage ${done}`);

  // (stage 1) install VPS authorized_keys line.
  if (done < 1) {
    if (!(await se.installVpsAuthorizedKey(line))) {
      log("enroll: failed to install VPS authorized_keys line");
      await se.stageFailed?.(box, 1, "installVpsAuthorizedKey failed");
      return { rc: 1 };
    }
    log(`enroll: installed VPS fleet authorized_keys line for ${box} (permitlisten 127.0.0.1:${port})`);
    await se.stageOk?.(box, 1);
  }

  // (stage 2) the /etc mapping copy. Its failure is a WARNING today and stays
  // one: the stage ADVANCES with `enrol_warn` set, because the mapping is an
  // audit copy and the enrolment it describes is real either way.
  if (done < 2) {
    if (await se.recordEtcMapping(box, port, line)) {
      await se.stageOk?.(box, 2);
    } else {
      log(`enroll: WARNING could not write /etc mapping copy for ${box}`);
      await se.stageOk?.(box, 2, "recordEtcMapping failed (/etc mapping copy missing)");
    }
  }

  // (stage 3) install VPS box-access pubkey into the box.
  if (done < 3) {
    const vpspub = await se.vpsBoxAccessPubkey();
    if (vpspub === undefined) {
      log(`enroll: no VPS box-access key at <FLEET_BOX_KEY>(.pub) — generate it on the VPS first`);
      await se.stageFailed?.(box, 3, "no VPS box-access key");
      return { rc: 1 };
    }
    if (!(await se.installBoxAuthorizedKey(box, vpspub))) {
      log(`enroll: failed to install VPS key into ${box} authorized_keys`);
      await se.stageFailed?.(box, 3, "installBoxAuthorizedKey failed");
      return { rc: 1 };
    }
    log(`enroll: installed VPS box-access key into ${box}:~box/.ssh/authorized_keys`);
    await se.stageOk?.(box, 3);
  }

  // (stage 4) box-side [fleet] block (D8 partial-enroll contract). rc 4 —
  // "config absent on the box" — does NOT advance and does NOT record the
  // enrolment, exactly as 5.8.0 behaves; it is still an ATTEMPTED stage that
  // returned failure, so it bumps the streak.
  if (writeBoxConfig) {
    if (done < 4) {
      const wbc = await se.writeBoxConfig(box, vps, n, vpsPort === "22" ? "" : vpsPort);
      if (wbc === 0) {
        const portmsg = vpsPort !== "22" ? ` port=${vpsPort}` : "";
        log(`enroll: wrote ${box}:${BOX_CONFIG} [fleet] block (vps=${vps} box_index=${n}${portmsg}) and verified it`);
        await se.stageOk?.(box, 4);
      } else if (wbc === 4) {
        log(`enroll: WARNING box config not written — ${BOX_CONFIG} is ABSENT on ${box}; run install.sh on the box first`);
        log(`enroll:   (then re-run 'fleet2 enroll ${box}'). NOT recording enrollment; the VPS-side key is installed and harmless.`);
        await se.stageFailed?.(box, 4, `${BOX_CONFIG} absent on the box (run install.sh there first)`);
        return { rc: 1 };
      } else {
        const portFrag = vpsPort !== "22" ? ` port=${vpsPort}` : "";
        log("enroll: WARNING box config not written — run the manual [fleet] step:");
        log(`enroll:   set [fleet] vps="${vps}" box_index=${n}${portFrag} in ${box}:${BOX_CONFIG},`);
        log(`enroll:   then: sudo ${BOXUP_REMOTE} once. NOT recording enrollment; the VPS-side`);
        log(`enroll:   key is installed and harmless — re-run 'fleet2 enroll ${box}' to retry (idempotent).`);
        await se.stageFailed?.(box, 4, "writeBoxConfig failed");
        return { rc: 1 };
      }
    }
  } else {
    log(
      `enroll: --no-box-config — skipped the box-side [fleet] write; set [fleet] vps/box_index by hand, then: sudo ${BOXUP_REMOTE} once`,
    );
  }

  // (stage 5) record + export (AFTER box-config success, D8). This IS the
  // `enrolling -> enrolled` transition: the phase change, the stage/streak reset
  // and the audit row commit together. The key MATERIAL (field 2 of the pubkey
  // line) is what `authorized-keys.map` carries and what `mapCoherent` compares,
  // so that is what the store row keeps.
  const exportError = await se.recordEnrolled(box, port, material);
  await se.notify("info", `enrolled ${box} (reverse port 127.0.0.1:${port})`);
  if (exportError !== undefined) {
    log(`enroll: ${box} recorded; export failed: ${exportError}`);
  }

  if (!writeBoxConfig) {
    log(
      `enroll: ${box} DONE — box-side [fleet] not written (--no-box-config); tunnel comes up after you set it and run 'boxup once'`,
    );
    return { rc: 0, exportError };
  }
  return { rc: await waitTunnel(box, se), exportError };
}

/**
 * The CLI entry: the same orchestrator, collapsed to an exit code. rc 7 is
 * "recorded; export failed" (state-store D6/r6-B2) — 5 was already the policy
 * precheck refusal where nothing was written.
 */
export async function cmdEnroll(args: string[], se: EnrollSideEffects): Promise<number> {
  const r = await cmdEnrollResult(args, se);
  return r.rc === 0 && r.exportError !== undefined ? 7 : r.rc;
}

