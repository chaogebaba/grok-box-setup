// handlers.ts — the /v1 handlers (TUI-D1 thin adapters; §3 surface).
//
// Every handler is a pure-ish function of (ctx, req-parts) → Response. Auth +
// routing live in server.ts; these implement the per-endpoint behavior, calling
// the SAME internal modules as the CLI. Box names are validated
// (isValidBoxName) + enrolled-membership-checked BEFORE any argv (B6). Mutations
// take the reconcile lock in-process (TUI-D3) and audit on completion.

import type { ServerContext } from "./context.ts";
import type { RequestAuth } from "./http.ts";
import { err, jsonOk, opResult } from "./http.ts";
import { isValidBoxName } from "../boxes.ts";
import { withReconcileLock } from "./lock.ts";
import { writeAudit } from "./audit.ts";
import { withCapture } from "./log-capture.ts";
import type { SnapshotBox, SnapshotLine } from "../history/schema.ts";
import { observedFor, readLatestSnapshot, readSnapshotSlice } from "../store/snapshots.ts";
import type { Observed } from "../reconcile/observe.ts";
import type { Phase } from "../store/state.ts";
import { pushManaged } from "../actions/config-push.ts";
import { fsManagedSource, cmdConfig } from "../commands/config.ts";
import { mintKey } from "../actions/mint.ts";
import { rotate } from "../actions/rotate.ts";
import { ReconcileState, nodeStateFs } from "../reconcile/state.ts";
import { integrityBlocked, openReadHandle, openReadState, openWriteState, readMembership } from "../store/membership.ts";
import { RunContext, TailscaleKeys } from "../reconcile/tailscale-keys.ts";
import { resolveTokenFile, fetchTransport } from "../tailscale.ts";
import { readJournal } from "./journal.ts";
import { tunnelUp, tunnelSsh } from "../tunnel.ts";
import { knownHostsFile } from "../hostkey.ts";
import { CHECK_COMMAND } from "../remote.ts";
import { existsSync, readFileSync } from "node:fs";

const CHECK_TIMEOUT_MS = 20_000;

/** The current version string source (kept in sync with cli.ts PKG_VERSION). */
/** The product name reported by the API (N1): `/v1/health`.name and the
 * `server` response header. */
export const SERVE_NAME = "grokfleet";
export const SERVE_VERSION = "5.10.0";

/**
 * state-store D3/D7 (Phase B): every snapshot read is a STORE query.
 *
 * `history/*.jsonl` is no longer written, so the file readers are gone. The
 * reassembled `SnapshotLine` is byte-identical in shape to the one 5.8.0 served
 * from the daily files — that is the round-trip contract, and it is why these
 * handlers did not otherwise change.
 *
 * A store that is absent (the window before the first tick) or still on schema
 * v1 (a Phase A file, i.e. a rollback) yields `undefined`, and every caller
 * renders the same "no snapshot yet" response it always did for an empty
 * `history/` directory.
 */
function latestSnapshot(env: ServerContext["env"]): SnapshotLine | undefined {
  const h = openReadHandle(env);
  try {
    if (h.store === undefined || h.store.userVersion() < 2) return undefined;
    return readLatestSnapshot(h.store);
  } finally {
    h.close();
  }
}

/** Live per-box marker mirror read from FLEET_STATE (TUI-D4 merge inputs). */
function liveMarkers(env: ServerContext["env"], box: string): {
  checkfail: boolean;
  asleep: boolean;
  expiry_days: number | null;
} {
  // state-store D7: a READ-ONLY store handle, closing survey §4e — these three
  // values used to be read straight off marker files that a tick could be
  // mid-write on. WAL gives the reader a consistent snapshot instead.
  const h = openReadState(env);
  try {
    const st = h.state;
    const expires = st.readExpiresDate(box);
    let expiry_days: number | null = null;
    if (expires !== undefined) {
      const ms = Date.parse(`${expires}T00:00:00Z`);
      if (!Number.isNaN(ms)) expiry_days = Math.floor((ms - Date.now()) / 86400_000);
    }
    return {
      checkfail: st.checkfailCount(box) > 0,
      asleep: st.readAsleep(box) !== undefined,
      expiry_days,
    };
  } finally {
    h.close();
  }
}

/** epoch seconds → ISO8601Z, or null for a NaN/absent/non-finite input. */
function isoFromEpochSec(sec: number | undefined): string | null {
  if (sec === undefined || !Number.isFinite(sec)) return null;
  const d = new Date(sec * 1000);
  const t = d.getTime();
  if (Number.isNaN(t)) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The 5.7.0 per-box detail facts (D1) — every one of them from an EXISTING
 * READ-ONLY state reader, none from ssh, none of them a mutation.
 *
 * These sit at the TOP LEVEL of the box response rather than inside `markers`
 * (gate note 8): `markers.checkfail` is a boolean and `checkfail_count` is the
 * number behind it, and the two next to each other under one key read as a
 * contradiction.
 *
 * `readAsleep` returns NaN fields for a malformed marker file rather than
 * undefined (gate note 9), so the ISO conversion maps NaN to null and the pane
 * never renders `Invalid Date`.
 */
export interface BoxDetailFacts {
  checkfail_count: number;
  asleep_since: string | null;
  asleep_last: string | null;
  expires_at: string | null;
  api_backoff: { fails: number; next_retry: string | null } | null;
  /**
   * state-store D4 (Phase B): the box's MEMBERSHIP phase and the liveness label
   * the last tick recorded for it. Both are `null` when there is no store yet or
   * the store is still on schema v1 (a Phase A rollback) — a client that
   * predates them ignores them, and the TUI renders `—`.
   */
  phase: Phase | null;
  observed: Observed | null;
}

export function boxDetailFacts(env: ServerContext["env"], box: string): BoxDetailFacts {
  const h = openReadHandle(env);
  try {
    const facts = boxDetailFactsFrom(h.state, box);
    if (h.store === undefined) return facts;
    const row = h.store.db.query("SELECT phase FROM boxes WHERE name = ?").get(box) as { phase?: string } | null;
    facts.phase = (row?.phase as Phase | undefined) ?? null;
    if (h.store.userVersion() >= 2) facts.observed = observedFor(h.store, box) ?? null;
    return facts;
  } finally {
    h.close();
  }
}

function boxDetailFactsFrom(st: ReturnType<typeof openReadState>["state"], box: string): BoxDetailFacts {
  const asleep = st.readAsleep(box);
  // READ-ONLY: apiFails(), never recordApiFailure (B3).
  const fails = st.apiFails();
  const nextRetry = st.nextRetry();
  const expires = st.readExpiresDate(box);
  return {
    checkfail_count: st.checkfailCount(box),
    asleep_since: asleep === undefined ? null : isoFromEpochSec(asleep.since),
    asleep_last: asleep === undefined ? null : isoFromEpochSec(asleep.last),
    expires_at: expires !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(expires) ? expires : null,
    // null when there is no backoff state at all, so a client can tell "no
    // failures recorded" from "0 failures and a pending retry stamp".
    api_backoff: fails === 0 && nextRetry === undefined ? null : { fails, next_retry: isoFromEpochSec(nextRetry) },
    phase: null,
    observed: null,
  };
}

/** Merge live state markers over a snapshot box (TUI-D4 precedence). */
function mergeBox(env: ServerContext["env"], sb: SnapshotBox): SnapshotBox {
  const m = liveMarkers(env, sb.name);
  // live markers override the snapshot copies; probe-derived fields
  // (tunnel/check/ver/drift/config) come from the snapshot only.
  return { ...sb, checkfail: m.checkfail, asleep: m.asleep, expiry_days: m.expiry_days ?? sb.expiry_days };
}

/**
 * R2: read `apply` LIVE from $FLEET_CONFIG on every request.
 *
 * The snapshot's `apply` records what the LAST TICK did. A stale snapshot
 * therefore reports a stale answer: a 34h-old line said `apply=off` while
 * production had been applying for a day — a reading an operator could act on.
 * `apply` is a config fact, not a tick observation, so read the config itself.
 *
 * The authority is the reconcile drop-in's OWN test, which is what actually
 * decides whether the timer passes `--apply`:
 *
 *   grep -Eq "^[[:space:]]*apply[[:space:]]*=[[:space:]]*true" config.toml
 *
 * So we run THAT regex over the raw file text rather than parsing TOML and
 * imitating it. Parity is then exact by construction. A TOML parse could only
 * ever approximate it and the gap is not academic: `apply = true` under ANY
 * table — `[rollout]`, or a section someone adds next year — makes the UNIT
 * apply, while a parse that inspects only the tables it knows about would
 * report `apply=false` and label it `apply_source: "config"`, i.e. present a
 * WRONG reading as authoritative. That is the same failure class as the stale
 * reading this function exists to fix. The grep is line-oriented and
 * section-blind, and so are we.
 *
 * Corollaries, all of them the unit's behaviour and therefore ours:
 *   - `#apply = true` is not at the start of a line's content ⇒ false;
 *   - `apply=true` and leading whitespace both match (the regex allows both);
 *   - `apply = "true"` does NOT match (a quote sits where `true` must be), so
 *     the unit dry-runs and we report false;
 *   - malformed TOML is irrelevant — grep does not parse, and neither do we.
 *
 * Cheap: one local file read, NO ssh and NO reconcile. On a genuine READ
 * failure (missing file, EACCES, a directory at the path) it does NOT throw —
 * it falls back to the snapshot value and reports `apply_source: "snapshot"` so
 * the client can tell the reading may be stale.
 */
/** The drop-in's grep, as a regex. `[[:space:]]` minus the line separator. */
const APPLY_TRUE_RE = /^[ \t\v\f\r]*apply[ \t\v\f\r]*=[ \t\v\f\r]*true/m;

export function readLiveApply(
  env: ServerContext["env"],
  snapshotApply: boolean | null,
): { apply: boolean | null; apply_source: "config" | "snapshot" } {
  const fallback = { apply: snapshotApply, apply_source: "snapshot" as const };
  let text: string;
  try {
    if (!existsSync(env.FLEET_CONFIG)) return fallback;
    text = readFileSync(env.FLEET_CONFIG, "utf8");
  } catch {
    return fallback;
  }
  // No match ⇒ the unit finds nothing to flip on ⇒ dry-run. That IS the live
  // answer, not a read failure.
  return { apply: APPLY_TRUE_RE.test(text), apply_source: "config" };
}

/** ISO8601Z now. */
function nowIso(ctx: ServerContext): string {
  return (ctx.now ? ctx.now() : new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** tick_age_s from the newest snapshot ts, or null (TUI-D4). */
export function tickAgeSeconds(latest: SnapshotLine | undefined, now: Date): number | null {
  if (latest === undefined) return null;
  const t = Date.parse(latest.ts);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 1000));
}

// --- GET /v1/health (no auth) ------------------------------------------------
export function handleHealth(ctx: ServerContext): Response {
  const latest = latestSnapshot(ctx.env);
  const now = ctx.now ? ctx.now() : new Date();
  // N1: `name` is the product name as a MACHINE-READABLE field. A consumer
  // that parses it (the TUI, a monitor) would break silently on a rename that
  // only touched display text, so it is asserted by a JSON-parsing test.
  return jsonOk({ ok: true, name: SERVE_NAME, version: SERVE_VERSION, tick_age_s: tickAgeSeconds(latest, now) });
}

// --- GET /v1/fleet (readonly) ------------------------------------------------
export function handleFleet(ctx: ServerContext, auth: RequestAuth): Response {
  const latest = latestSnapshot(ctx.env);
  const boxes = (latest?.boxes ?? []).map((b) => mergeBox(ctx.env, b));
  // `apply` is read LIVE from the config; every OTHER field still comes from the
  // snapshot (and tick_age_s / staleness are unchanged).
  const live = readLiveApply(ctx.env, latest?.apply ?? null);
  return jsonOk({
    snapshot_ts: latest?.ts ?? null,
    apply: live.apply,
    apply_source: live.apply_source,
    canary: latest?.canary ?? null,
    scope: auth.scope, // R3-A1: TUI dims action keys for a readonly token
    boxes,
    // D7: this response is an EXPLICIT object, not a spread of the snapshot
    // line, so `discover` has to be named here too. null (not absent) when the
    // line predates 5.6.0 or the tick ran no discovery.
    discover: latest?.discover ?? null,
  });
}

// --- GET /v1/boxes/:name (readonly, NO ssh) ----------------------------------
export function handleBox(ctx: ServerContext, box: string): Response {
  const latest = latestSnapshot(ctx.env);
  const snap = latest?.boxes.find((b) => b.name === box);
  const merged = snap ? mergeBox(ctx.env, snap) : undefined;
  const m = liveMarkers(ctx.env, box);
  return jsonOk({
    name: box,
    snapshot_ts: latest?.ts ?? null,
    box: merged ?? null,
    markers: m,
    // D1 (5.7.0): the facts the engine records and the TUI never showed. All
    // read-only; a client that predates them simply ignores them.
    ...boxDetailFacts(ctx.env, box),
  });
}

// --- GET /v1/history?box=&hours= (readonly) ----------------------------------
export function handleHistory(ctx: ServerContext, box: string | null, hours: number): Response {
  const clamped = Number.isFinite(hours) && hours > 0 ? Math.min(Math.floor(hours), 2160) : 24;
  const h = openReadHandle(ctx.env);
  let lines: SnapshotLine[] = [];
  try {
    if (h.store !== undefined && h.store.userVersion() >= 2) {
      lines = readSnapshotSlice(h.store, { hours: clamped, box: box ?? undefined, nowIso: nowIso(ctx) });
    }
  } finally {
    h.close();
  }
  return jsonOk({ hours: clamped, box: box ?? null, lines });
}

// --- GET /v1/boxes/:name/diff (readonly; ssh to that box only) ---------------
export async function handleDiff(ctx: ServerContext, box: string): Promise<Response> {
  const { value, log } = await withCapture(async () => {
    // config diff core; the core writes the unified diff + NOTE lines to the
    // provided write() sink, and its refusal/unreachable reasons to
    // process.stderr (NOT the ALS log). The buffer collects the write() body.
    const buf: string[] = [];
    const rc = await cmdConfig(["diff", box], {
      runner: ctx.runner,
      env: ctx.env,
      enrolled: ctx.enrolledBoxes(),
      write: (s) => buf.push(s.replace(/\n$/, "")),
    });
    return { rc, body: buf };
  });
  // R2-A1: the diff core emits its D4-refused / diff(1)-missing / box-unreachable
  // reasons to process.stderr, which the ALS tee does NOT capture. So for ANY
  // nonzero rc with no body, re-emit a one-line reason into log[] so the client
  // never gets an empty explanation.
  const combined = [...value.body, ...log.filter((l) => !value.body.includes(l))];
  if (value.rc !== 0 && combined.length === 0) {
    combined.push(`config diff ${box}: rc=${value.rc} (drift, unreachable, or diff(1) missing — see journald)`);
  }
  return opResult(value.rc, combined);
}

// --- GET /v1/boxes/:name/journal?lines= (admin) ------------------------------
export async function handleJournal(ctx: ServerContext, box: string, lines: number | undefined): Promise<Response> {
  const r = await readJournal(box, lines, { runner: ctx.runner, which: ctx.whichJournalctl });
  return opResult(r.rc, r.log);
}

// --- POST /v1/boxes/:name/check (admin, no confirm) --------------------------
export async function handleCheck(ctx: ServerContext, box: string, auth: RequestAuth): Promise<Response> {
  const { value, log } = await withCapture(async () => {
    const up = await tunnelUp(ctx.runner, box);
    if (!up) return 1;
    const chk = await tunnelSsh(ctx.runner, box, ctx.env.FLEET_BOX_KEY, CHECK_COMMAND, {
      timeoutMs: CHECK_TIMEOUT_MS,
      knownHosts: knownHostsFile(ctx.env),
    });
    return chk.code === 0 ? 0 : 1;
  });
  writeAudit(ctx.env.FLEET_STATE, { token: auth.name, action: "check", box, rc: value }, ctx.auditSink, ctx.now);
  return opResult(value, log);
}

// --- POST /v1/boxes/:name/config-push (admin+confirm) ------------------------
export async function handleConfigPush(ctx: ServerContext, box: string, auth: RequestAuth): Promise<Response> {
  if (integrityBlocked(ctx.env)) return err.integrityFailed();
  const outcome = await withReconcileLock(
    ctx.lockPath,
    () =>
      withCapture(async () => {
        // single box, NO canary gate (B5 — pushManaged directly, dry=false).
        const r = await pushManaged(box, false, {
          runner: ctx.runner,
          env: ctx.env,
          source: fsManagedSource(ctx.env),
        });
        return r.rc;
      }),
    ctx.lockDeps,
  );
  if (!outcome.ok) return err.lockBusy();
  const { value: rc, log } = outcome.value;
  writeAudit(ctx.env.FLEET_STATE, { token: auth.name, action: "config-push", box, rc }, ctx.auditSink, ctx.now);
  return opResult(rc, log);
}

// --- POST /v1/boxes/:name/rotate-key (admin+confirm) -------------------------
export async function handleRotate(ctx: ServerContext, box: string, auth: RequestAuth): Promise<Response> {
  // state-store D8: a MUTATION must not run against a store that declared itself
  // corrupt. Readonly endpoints are deliberately NOT gated.
  if (integrityBlocked(ctx.env)) return err.integrityFailed();
  let exportError: string | undefined;
  const outcome = await withReconcileLock(
    ctx.lockPath,
    () =>
      withCapture(async () => {
        // The rotate WRITES key material, so it takes a read-write store handle
        // (the reconcile lock is already held). Its export runs inside
        // `recordKey`; a failure is recorded, never thrown.
        const w = openWriteState(ctx.env, SERVE_VERSION);
        const state = w?.state ?? new ReconcileState(ctx.env.FLEET_STATE, nodeStateFs);
        const rctx = new RunContext();
        const tokenFile = resolveTokenFile(ctx.env, ctx.cfg);
        let token: string | undefined;
        try {
          token = await fetchTransport.readToken(tokenFile);
        } catch {
          token = undefined;
        }
        const keys = new TailscaleKeys(
          fetchTransport,
          ctx.env.FLEET_TS_API,
          ctx.env.FLEET_TS_TAILNET,
          token ?? "",
          rctx,
        );
        try {
          const r = await rotate(box, { runner: ctx.runner, env: ctx.env, keys, state });
          return r.rc;
        } finally {
          exportError = w?.state.takeExportErrors()[0];
          w?.close();
        }
      }),
    ctx.lockDeps,
  );
  if (!outcome.ok) return err.lockBusy();
  const { value: rc, log } = outcome.value;
  writeAudit(ctx.env.FLEET_STATE, { token: auth.name, action: "rotate-key", box, rc }, ctx.auditSink, ctx.now);
  // state-store D6/r6-n3: a committed mutation is a SUCCESS. A lagging legacy
  // export is reported as a warning in the 200 body (the TUI shows it in the
  // message line), never as an error status.
  return exportError === undefined
    ? opResult(rc, log)
    : opResult(rc, log, { warnings: [{ code: "export_failed", detail: exportError }] });
}

// --- POST /v1/reconcile (admin+confirm, async job) ---------------------------
export function handleReconcile(ctx: ServerContext, auth: RequestAuth): Response {
  if (integrityBlocked(ctx.env)) return err.integrityFailed();
  const outcome = ctx.jobs.start(async () => {
    // Runs under the SAME lock (TUI-D3). runReconcile is invoked DIRECTLY via
    // ctx.tick (assembleTickDeps), never cliReconcile (R3-B1).
    const locked = await withReconcileLock(
      ctx.lockPath,
      () => withCapture(async () => ctx.tick.run({ apply: false })),
      ctx.lockDeps,
    );
    const settle: { rc: number; log: string[] } = locked.ok
      ? { rc: locked.value.value, log: locked.value.log }
      : { rc: 0, log: ["reconcile: lock busy — tick skipped"] };
    // R3-A8: write the audit line ONCE, at job completion, WITH the job id
    // (never at 202-time — no missing/double rc). box=fleet for the whole tick.
    writeAudit(
      ctx.env.FLEET_STATE,
      { token: auth.name, action: "reconcile", box: "fleet", rc: settle.rc, job: currentJobId },
      ctx.auditSink,
      ctx.now,
    );
    return settle;
  });
  if (!outcome.started) {
    return err.jobRunning();
  }
  currentJobId = outcome.id;
  return jsonOk({ job_id: outcome.id }, 202);
}

/** The id of the job most recently started — captured so the settle closure can
 *  stamp its audit line with the id (the closure runs after start() returns). */
let currentJobId = "";

// --- GET /v1/jobs/:id (admin) ------------------------------------------------
export function handleJob(ctx: ServerContext, id: string): Response {
  const rec = ctx.jobs.get(id);
  if (rec === undefined) return err.notFound("unknown job id");
  if (rec.state === "running") return jsonOk({ state: "running" });
  return jsonOk({ state: "done", rc: rec.rc, log: rec.log });
}

// --- POST /v1/boxes/:name/rename (admin+confirm) -----------------------------
// Body {to, confirm}. Holds the TUI-D3 in-process lock; the injected RenameOps
// variant's acquireLock() returns "ok" (the request ALREADY holds the lock —
// the production wiring's external `flock -w 90` CANNOT see the handler's
// fd-held lock and would self-deadlock 90s otherwise, R3-B1).
export async function handleRename(
  ctx: ServerContext,
  box: string,
  to: string,
  auth: RequestAuth,
): Promise<Response> {
  if (typeof to !== "string" || to === "") return err.badBody("rename requires a non-empty 'to'");
  if (integrityBlocked(ctx.env)) return err.integrityFailed();
  const outcome = await withReconcileLock(
    ctx.lockPath,
    () =>
      withCapture(async () => {
        const { makeRenameDeps } = require("../commands/rename-wiring.ts") as typeof import("../commands/rename-wiring.ts");
        const { cmdRename } = require("../commands/rename.ts") as typeof import("../commands/rename.ts");
        const deps = makeRenameDeps(ctx.env, ctx.cfg, ctx.runner);
        // R3-B1: the request already holds reconcile.lock in-process; the
        // rename core's own acquireLock() MUST NOT re-acquire (the external
        // `flock -w 90` cannot see our fd-held lock → self-deadlock). Inject an
        // "ok" acquireLock so the core proceeds under the held lock.
        const lockHeldDeps = { ...deps, ops: { ...deps.ops, acquireLock: async () => "ok" as const } };
        return cmdRename([box, to], lockHeldDeps);
      }),
    ctx.lockDeps,
  );
  if (!outcome.ok) return err.lockBusy();
  const { value: rc, log } = outcome.value;
  writeAudit(
    ctx.env.FLEET_STATE,
    { token: auth.name, action: "rename", box: `${box}->${to}`, rc },
    ctx.auditSink,
    ctx.now,
  );
  return opResult(rc, log);
}

/** Read enrolled.tsv membership from FLEET_STATE (production ctx.enrolledBoxes). */
export function fsEnrolledBoxes(env: ServerContext["env"]): string[] {
  // state-store D4: membership is `phase='enrolled'` from the store; the
  // exported `enrolled.tsv` is the rollback artefact, consulted only in the
  // window before the first tick creates the store.
  try {
    return readMembership(env);
  } catch {
    return [];
  }
}

/** Validate a box name AND enrolled membership; returns an error Response or null. */
export function boxGuard(ctx: ServerContext, box: string): Response | null {
  if (!isValidBoxName(box)) return err.notFound(`unknown box '${box}'`);
  if (!ctx.enrolledBoxes().includes(box)) return err.notFound(`box '${box}' not enrolled`);
  return null;
}
