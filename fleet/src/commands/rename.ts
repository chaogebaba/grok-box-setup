// rename.ts — `fleet2 rename [--dry-run] <old> <new>` (D11/F11), the live
// box-rename to the canonical grok-box-NNN WITHOUT changing the index/port.
// Ports cmd_rename (main:3670-3848) + helpers (main:3493-3665): copy-first,
// verify, delete-last, resumable, under the reconcile lock (F2). The
// authoritative ~fleet/.ssh/authorized_keys is NEVER touched (F6) — only the
// box-name-keyed AUDIT copies + the .toml managed overlay move (F11).
//
// rc map (§8): 0 ok/dry-run/already-canonical / 1 lock+precheck+poll+verify+
// delete aborts / 2 usage + validation refusals.
//
// State I/O is behind a `RenameStore` seam (a tiny fs abstraction) so tests run
// against a tmp FLEET_STATE/FLEET_ETC; the box step + API poll are behind a
// `RenameOps` seam so tests stub the transport (mirrors the bash rename_fns
// harness with stubbed tunnel_ssh / flock / HOOK_VERIFY_FAIL).

import { boxIndex } from "../boxes.ts";
import { log } from "../log.ts";

const RENAME_MIN_BOXUP_VERSION = "5.3.0";

/** rename_ver_ge (main:3505-3523): dotted <have> >= <want>, missing parts 0. */
export function renameVerGe(have: string, want: string): boolean {
  const p = (s: string): [number, number, number] => {
    const [a, b, c] = s.split(".");
    return [Number.parseInt(a ?? "0", 10) || 0, Number.parseInt(b ?? "0", 10) || 0, Number.parseInt(c ?? "0", 10) || 0];
  };
  const [h1, h2, h3] = p(have);
  const [w1, w2, w3] = p(want);
  if (h1 !== w1) return h1 > w1;
  if (h2 !== w2) return h2 > w2;
  return h3 >= w3;
}

/** rename_plan_paths (main:3575-3585): the "old\tnew" artefact pairs for --dry-run. */
export function renamePlanPaths(
  paths: { state: string; akDir: string; etc: string; managedBoxDir: string },
  old: string,
  neu: string,
): Array<[string, string]> {
  const { state, akDir, etc, managedBoxDir } = paths;
  return [
    [`${state}/${old}.expires`, `${state}/${neu}.expires`],
    [`${state}/${old}.checkfail`, `${state}/${neu}.checkfail`],
    [`${state}/${old}.cfgfail`, `${state}/${neu}.cfgfail`],
    [`${akDir}/${old}.line`, `${akDir}/${neu}.line`],
    [`${managedBoxDir}/${old}.toml`, `${managedBoxDir}/${neu}.toml`],
    [`${state}/enrolled.tsv (row ${old})`, `${state}/enrolled.tsv (row ${neu})`],
    [`${etc}/authorized-keys.map (row ${old})`, `${etc}/authorized-keys.map (row ${neu})`],
  ];
}

/** The brain-state store seam (fs-backed; tests inject a tmp-dir impl). */
export interface RenameStore {
  /** enrolled row port for a box, or undefined. */
  enrolledPort(box: string): string | undefined;
  /** true iff the <new> enrolled row exists (resume probe, main:3661-3665). */
  hasEnrolledRow(box: string): boolean;
  /** rename_copy_state (main:3591-3633): copy sidecars/.line/.toml, ADD new rows. */
  copyState(old: string, neu: string): boolean;
  /** rename_delete_old_state (main:3638-3657): drop old sidecars/.line/.toml/rows. */
  deleteOldState(old: string, neu: string): boolean;
}

/** The box/API operations seam (transport; tests stub). */
export interface RenameOps {
  /** tunnel_up(box). */
  tunnelUp(box: string): Promise<boolean>;
  /** rename_box_boxup_version(box) — dotted version or "" on failure. */
  boxBoxupVersion(box: string): Promise<string>;
  /** on-box: write <new> to $ROOT/hostname + boxup once. false ⇒ ABORT. */
  writeHostnameAndOnce(old: string, neu: string): Promise<boolean>;
  /** one devices GET: {ok, malformed, hostname, dnslabel, oldLiveId, newLiveId, corpseId}. */
  pollDevices(old: string, neu: string): Promise<PollResult>;
  /** POST /device/<id>/name {name:new}. */
  forceName(liveId: string, neu: string): Promise<{ ok: boolean; code: number }>;
  /** DELETE /device/<corpse>. */
  reapCorpse(corpseId: string): Promise<{ ok: boolean; code: number }>;
  /** flock -w 90 on reconcile.lock: 'ok' | 'busy' | 'open-fail'. */
  acquireLock(): Promise<"ok" | "busy" | "open-fail">;
  /** sleep RENAME_POLL_INTERVAL (stubbed in tests). */
  sleepInterval(): Promise<void>;
}

export interface PollResult {
  ok: boolean; // API 2xx
  malformed: boolean; // body not valid
  code: number; // TS_API_CODE
  hostname: string;
  dnslabel: string;
  oldLiveId: string;
  newLiveId: string;
}

export interface RenameDeps {
  store: RenameStore;
  ops: RenameOps;
  pollSecs?: number; // RENAME_POLL_SECS default 60
  pollInterval?: number; // RENAME_POLL_INTERVAL default 5
  /** the paths for the dry-run plan. */
  paths: { state: string; akDir: string; etc: string; managedBoxDir: string };
}

/** cmd_rename orchestrator. */
export async function cmdRename(args: string[], deps: RenameDeps): Promise<number> {
  let dry = false;
  const pos: string[] = [];
  for (const a of args) {
    if (a === "--dry-run") dry = true;
    else if (a.startsWith("-")) {
      process.stderr.write(`fleet2 rename: unknown flag '${a}'\n`);
      return 2;
    } else pos.push(a);
  }
  const old = pos[0] ?? "";
  const neu = pos[1] ?? "";
  if (old === "" || neu === "") {
    process.stderr.write("fleet2 rename: usage: rename [--dry-run] <old> <new>\n");
    return 2;
  }

  // (1) validate.
  if (!/^grok-box-[0-9][0-9][0-9]$/.test(neu)) {
    log(`rename: refusing — <new> '${neu}' is not canonical grok-box-NNN`);
    return 2;
  }
  const oidx = boxIndex(old);
  if (oidx === undefined) {
    log(`rename: refusing — <old> '${old}' is not a grok-box name`);
    return 2;
  }
  const nidx = boxIndex(neu);
  if (nidx === undefined) {
    log(`rename: refusing — <new> '${neu}' is not a grok-box name`);
    return 2;
  }
  if (oidx !== nidx) {
    log(`rename: refusing — index change ${old}(${oidx}) -> ${neu}(${nidx}) is out of scope (rename never changes the port)`);
    return 2;
  }
  if (old === neu) {
    log(`rename: ${old} is already canonical — nothing to do`);
    return 0;
  }
  if (deps.store.enrolledPort(old) === undefined) {
    log(`rename: refusing — ${old} is not enrolled (not in enrolled.tsv)`);
    return 2;
  }

  // (F4) dry-run.
  if (dry) {
    log(`rename: DRY-RUN plan ${old} -> ${neu} (index ${oidx}, port unchanged)`);
    for (const [o, n] of renamePlanPaths(deps.paths, old, neu)) log(`rename:   ${o}  ->  ${n}`);
    log(`rename:   on box: write '${neu}' to $ROOT/hostname; sudo boxup once`);
    return 0;
  }

  // (F2) lock.
  const lock = await deps.ops.acquireLock();
  if (lock === "open-fail") {
    log(`rename: cannot open lock ${deps.paths.state}/reconcile.lock`);
    return 1;
  }
  if (lock === "busy") {
    log("rename: reconcile busy — could not acquire the reconcile lock within 90s; refusing");
    return 1;
  }

  // (3) precheck.
  if (!(await deps.ops.tunnelUp(old))) {
    log(`rename: ABORT — ${old} tunnel is DOWN (cannot drive the box)`);
    return 1;
  }
  const bver = await deps.ops.boxBoxupVersion(old);
  if (bver === "") {
    log(`rename: ABORT — could not read '${old}' boxup version over the tunnel`);
    return 1;
  }
  if (!renameVerGe(bver, RENAME_MIN_BOXUP_VERSION)) {
    log(`rename: ABORT — ${old} runs boxup ${bver} (< ${RENAME_MIN_BOXUP_VERSION}); update boxup first`);
    return 1;
  }

  // resume probe.
  if (deps.store.hasEnrolledRow(neu)) {
    log(`rename: resuming — ${neu} state already copied; continuing from the box step`);
  }

  // (2/F3) copy state.
  if (!deps.store.copyState(old, neu)) {
    log(`rename: ABORT — failed to copy brain state ${old} -> ${neu} (both names still valid; re-run to resume)`);
    return 1;
  }
  log(`rename: copied brain state ${old} -> ${neu} (audit copies only; ~fleet/.ssh/authorized_keys untouched)`);

  // (3/F3) box step.
  if (!(await deps.ops.writeHostnameAndOnce(old, neu))) {
    log(`rename: ABORT — failed to write new hostname / run boxup once on ${old} (both names still valid; re-run to resume)`);
    return 1;
  }
  log(`rename: wrote '${neu}' to the box hostname and ran boxup once`);

  // (4/5) poll.
  const pollSecs = deps.pollSecs ?? 60;
  const pollInterval = deps.pollInterval ?? 5;
  let waited = 0;
  let posted = false;
  let lastLiveId = "";
  for (;;) {
    const p = await deps.ops.pollDevices(old, neu);
    if (!p.ok) {
      log(`rename: ABORT — tailscale API read failed (HTTP ${p.code}) while polling`);
      return 1;
    }
    if (p.malformed) {
      log("rename: ABORT — tailscale API body malformed while polling");
      return 1;
    }
    if (p.hostname === neu && p.dnslabel === neu) break;
    if (!posted) {
      const liveid = p.oldLiveId !== "" ? p.oldLiveId : p.newLiveId;
      lastLiveId = liveid;
      if (liveid !== "") {
        const f = await deps.ops.forceName(liveid, neu);
        if (f.ok) {
          log(`rename: forced control-plane name for device ${liveid} -> ${neu}`);
          posted = true;
        } else {
          log(`rename: ABORT — POST /device/${liveid}/name failed (HTTP ${f.code})`);
          return 1;
        }
      }
    }
    waited += pollInterval;
    if (waited >= pollSecs) {
      log(
        `rename: ABORT — timed out (${pollSecs}s) waiting for HostName/DNS=${neu} (saw hostname='${p.hostname}' dns='${p.dnslabel}'; both names still valid, re-run to resume)`,
      );
      log(`rename: timeout diagnosis — POST /device/<id>/name device_id='${lastLiveId}' response_body=''`);
      return 1;
    }
    await deps.ops.sleepInterval();
  }

  // (5b) final verify.
  if (!(await deps.ops.tunnelUp(neu))) {
    log(`rename: ABORT — ${neu} tunnel not up after rename (both names still valid, re-run to resume)`);
    return 1;
  }
  log(`rename: verified ${neu} — HostName=${neu} DNS=${neu} tunnel up`);

  // (6/F3/F6) delete old state.
  if (!deps.store.deleteOldState(old, neu)) {
    log(`rename: FAILED deleting old-name state for ${old} — leftover paths under ${deps.paths.state}/${old}.* and ${deps.paths.akDir}/${old}.line`);
    return 1;
  }
  log(`rename: deleted old-name state for ${old}`);

  // (7) corpse reap (non-fatal).
  const reap = await deps.ops.pollDevices(old, neu);
  if (reap.ok && !reap.malformed) {
    // corpse = any device under old name with id != new live id; the ops seam
    // surfaces oldLiveId as the corpse candidate when it differs from newLiveId.
    const corpse = reap.oldLiveId !== "" && reap.oldLiveId !== reap.newLiveId ? reap.oldLiveId : "";
    if (corpse !== "") {
      const d = await deps.ops.reapCorpse(corpse);
      if (d.ok) log(`rename: reaped stale corpse device ${corpse} (old name ${old})`);
      else log(`rename: WARNING could not reap corpse ${corpse} (HTTP ${d.code}) — rename itself succeeded`);
    }
  }

  log(`rename: DONE ${old} -> ${neu} (index ${oidx}, port unchanged)`);
  return 0;
}
