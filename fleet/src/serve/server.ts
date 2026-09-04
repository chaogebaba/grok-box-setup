// server.ts — `grokfleet serve` (TUI-D2/D9/D10/D11): the tailnet-bound token-auth
// HTTP/JSON API. Bind resolution, auth, routing, confirm guard, scope
// enforcement live here; per-endpoint behavior is in handlers.ts (thin
// adapters, TUI-D1).

import type { Env } from "../env.ts";
import type { ParsedConfig, RolloutConfig } from "../config.ts";
import type { Runner } from "../runner.ts";
import { BunRunner } from "../runner.ts";
import { resolveRollout } from "../config.ts";
import { TokenStore } from "./tokens.ts";
import { JobRegistry } from "./jobs.ts";
import { nodeAuditSink } from "./audit.ts";
import { openLibcFlock } from "./lock.ts";
import { installCapture } from "./log-capture.ts";
import { assembleTickDeps } from "../reconcile/cli-reconcile.ts";
import { runReconcile } from "../reconcile/run.ts";
import type { ServerContext, TickRunner } from "./context.ts";
import { err, jsonError } from "./http.ts";
import type { RequestAuth } from "./http.ts";
import {
  handleHealth,
  handleFleet,
  handleBox,
  handleHistory,
  handleDiff,
  handleJournal,
  handleCheck,
  handleConfigPush,
  handleRotate,
  handleRename,
  handleReconcile,
  handleJob,
  boxGuard,
  fsEnrolledBoxes,
  SERVE_VERSION,
} from "./handlers.ts";
import {
  handleLeaseAcquire,
  handleLeaseGet,
  handleLeaseList,
  handleLeaseRelease,
  handleLeaseRenew,
} from "./lease-handlers.ts";
import { log } from "../log.ts";
import { openStore, storePath } from "../store/db.ts";
import { existsSync } from "node:fs";

export const DEFAULT_PORT = 9891;

/**
 * Run `PRAGMA quick_check` once at startup; on failure SET `integrity_failed_at`
 * and log it. Never throws — a store that will not open is logged and serve
 * carries on with the readonly surface it can still serve.
 */
export function startupIntegrityCheck(env: Env): void {
  const path = storePath(env.FLEET_STATE);
  if (!existsSync(path)) return;
  try {
    const store = openStore({ path, dir: env.FLEET_STATE });
    try {
      if (store.userVersion() < 1) return;
      const verdict = store.quickCheck();
      if (verdict === "ok") {
        log("serve: state store quick_check ok");
        return;
      }
      store.setIntegrityFailed();
      log(`serve: state store quick_check FAILED (${verdict}) — starting with mutations refused (503); run 'grokfleet state check'`);
    } finally {
      store.close();
    }
  } catch (e) {
    log(`serve: state store could not be checked (${e instanceof Error ? e.message : String(e)}) — starting anyway`);
  }
}

/** Resolve the tailnet bind IPv4 (TUI-D2). `tailscale ip -4` first line; binary
 *  absent/empty/error ⇒ undefined (caller refuses rc 6). `--bind` overrides. */
export async function resolveBind(runner: Runner, override: string | undefined): Promise<string | undefined> {
  if (override !== undefined && override !== "") return override;
  try {
    const r = await runner.run(["tailscale", "ip", "-4"], { timeoutMs: 5000 });
    if (r.code !== 0) return undefined;
    const first = r.stdout.split("\n").map((l) => l.trim()).find((l) => l !== "");
    return first && first !== "" ? first : undefined;
  } catch {
    return undefined;
  }
}

export interface ServeArgs {
  bind?: string;
  port?: number;
}

/** Parse `serve` flags (--bind <ip>, --port <n>). */
export function parseServeArgs(rest: string[]): ServeArgs | { err: string } {
  const out: ServeArgs = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--bind") out.bind = rest[++i];
    else if (a === "--port") {
      const p = rest[++i];
      const n = Number.parseInt(p ?? "", 10);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return { err: `serve: invalid --port '${p}'` };
      out.port = n;
    } else if (a === "--help" || a === "-h") {
      return out;
    } else {
      return { err: `serve: unknown flag ${a}` };
    }
  }
  return out;
}


/** Danger classification: mutations require {confirm} (TUI-D10). */
const CONFIRM_ACTIONS = new Set(["config-push", "rotate-key", "rename", "reconcile"]);

/**
 * Build the request handler. Auth + routing + confirm + scope; delegates to
 * handlers.ts. Exposed for tests (they call this with a fake ctx and Request).
 */
export function makeFetch(ctx: ServerContext): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      return await route(ctx, req);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`serve: unhandled error — ${msg}`);
      return err.internal();
    }
  };
}

/** Extract the bearer token from Authorization. */
function bearer(req: Request): string | undefined {
  const h = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (h === null) return undefined;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : undefined;
}

async function readConfirm(req: Request): Promise<{ body: Record<string, unknown> } | { bad: true }> {
  try {
    const text = await req.text();
    if (text.trim() === "") return { body: {} };
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { bad: true };
    return { body: parsed as Record<string, unknown> };
  } catch {
    return { bad: true };
  }
}

async function route(ctx: ServerContext, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // --- unauthenticated health ---
  if (path === "/v1/health" && method === "GET") return handleHealth(ctx);

  // Every other route is under /v1/ and requires auth.
  if (!path.startsWith("/v1/")) return err.notFound("unknown route");

  // Auth: re-check the token file per request (mtime), then authenticate.
  ctx.tokens.reloadIfChanged();
  const identity = ctx.tokens.authenticate(bearer(req));
  if (identity === undefined) return err.unauthorized();
  const auth: RequestAuth = identity;

  // --- readonly GETs ---
  if (method === "GET") {
    if (path === "/v1/fleet") return handleFleet(ctx, auth);

    const mBox = path.match(/^\/v1\/boxes\/([^/]+)$/);
    if (mBox) {
      const box = decodeURIComponent(mBox[1]!);
      const g = boxGuard(ctx, box);
      if (g) return g;
      return handleBox(ctx, box);
    }
    const mDiff = path.match(/^\/v1\/boxes\/([^/]+)\/diff$/);
    if (mDiff) {
      const box = decodeURIComponent(mDiff[1]!);
      const g = boxGuard(ctx, box);
      if (g) return g;
      return handleDiff(ctx, box);
    }
    const mJournal = path.match(/^\/v1\/boxes\/([^/]+)\/journal$/);
    if (mJournal) {
      // journal is ADMIN scope (B6).
      if (auth.scope !== "admin") return err.forbidden();
      const box = decodeURIComponent(mJournal[1]!);
      const g = boxGuard(ctx, box);
      if (g) return g;
      const linesParam = url.searchParams.get("lines");
      const lines = linesParam !== null ? Number.parseInt(linesParam, 10) : undefined;
      return handleJournal(ctx, box, Number.isNaN(lines as number) ? undefined : lines);
    }
    if (path === "/v1/history") {
      const box = url.searchParams.get("box");
      const hoursParam = url.searchParams.get("hours");
      const hours = hoursParam !== null ? Number.parseInt(hoursParam, 10) : 24;
      return handleHistory(ctx, box, Number.isNaN(hours) ? 24 : hours);
    }
    // lease-api L2: the lease READS are readonly scope. The default set is
    // `released_at IS NULL` (all three deferring states); `?all=1` adds released
    // rows and `?state=` filters within the chosen set.
    if (path === "/v1/leases") {
      return handleLeaseList(ctx, url.searchParams.get("all") === "1", url.searchParams.get("state"));
    }
    const mLease = path.match(/^\/v1\/leases\/([^/]+)$/);
    if (mLease) return handleLeaseGet(ctx, decodeURIComponent(mLease[1]!));

    const mJob = path.match(/^\/v1\/jobs\/([^/]+)$/);
    if (mJob) {
      if (auth.scope !== "admin") return err.forbidden();
      return handleJob(ctx, decodeURIComponent(mJob[1]!));
    }
    return err.notFound("unknown route");
  }

  // --- POST mutations (admin scope) ---
  if (method === "POST") {
    if (auth.scope !== "admin") return err.forbidden();

    // lease-api L2: acquire + renew. NO confirm (a lease is a reservation, not a
    // destructive action) and NO reconcile lock — see lease-handlers.ts.
    if (path === "/v1/leases") {
      const c = await readConfirm(req);
      if ("bad" in c) return err.badBody();
      return handleLeaseAcquire(ctx, auth, c.body);
    }
    const mRenew = path.match(/^\/v1\/leases\/([^/]+)\/renew$/);
    if (mRenew) {
      const c = await readConfirm(req);
      if ("bad" in c) return err.badBody();
      return handleLeaseRenew(ctx, auth, decodeURIComponent(mRenew[1]!), c.body);
    }

    // reconcile (no box).
    if (path === "/v1/reconcile") {
      const c = await readConfirm(req);
      if ("bad" in c) return err.badBody();
      const guard = confirmGuard("reconcile", c.body, "fleet");
      if (guard) return guard;
      return handleReconcile(ctx, auth);
    }

    const mCheck = path.match(/^\/v1\/boxes\/([^/]+)\/check$/);
    if (mCheck) {
      const box = decodeURIComponent(mCheck[1]!);
      const g = boxGuard(ctx, box);
      if (g) return g;
      return handleCheck(ctx, box, auth); // no confirm (non-destructive)
    }

    const mPush = path.match(/^\/v1\/boxes\/([^/]+)\/config-push$/);
    if (mPush) {
      const box = decodeURIComponent(mPush[1]!);
      const g = boxGuard(ctx, box);
      if (g) return g;
      const c = await readConfirm(req);
      if ("bad" in c) return err.badBody();
      const guard = confirmGuard("config-push", c.body, box);
      if (guard) return guard;
      return handleConfigPush(ctx, box, auth);
    }

    const mRotate = path.match(/^\/v1\/boxes\/([^/]+)\/rotate-key$/);
    if (mRotate) {
      const box = decodeURIComponent(mRotate[1]!);
      const g = boxGuard(ctx, box);
      if (g) return g;
      const c = await readConfirm(req);
      if ("bad" in c) return err.badBody();
      const guard = confirmGuard("rotate-key", c.body, box);
      if (guard) return guard;
      return handleRotate(ctx, box, auth);
    }

    const mRename = path.match(/^\/v1\/boxes\/([^/]+)\/rename$/);
    if (mRename) {
      const box = decodeURIComponent(mRename[1]!);
      const g = boxGuard(ctx, box);
      if (g) return g;
      const c = await readConfirm(req);
      if ("bad" in c) return err.badBody();
      const guard = confirmGuard("rename", c.body, box);
      if (guard) return guard;
      const to = typeof c.body["to"] === "string" ? (c.body["to"] as string) : "";
      return handleRename(ctx, box, to, auth);
    }

    return err.notFound("unknown route");
  }

  // --- DELETE (admin scope): lease release ---
  if (method === "DELETE") {
    if (auth.scope !== "admin") return err.forbidden();
    const mRel = path.match(/^\/v1\/leases\/([^/]+)$/);
    if (mRel) return handleLeaseRelease(ctx, auth, decodeURIComponent(mRel[1]!));
    return err.notFound("unknown route");
  }

  return err.notFound("unknown route");
}

/** Confirm guard (TUI-D10): body.confirm must equal `expected` for a
 *  destructive action; mismatch/missing ⇒ 400 confirm_mismatch. */
function confirmGuard(action: string, body: Record<string, unknown>, expected: string): Response | null {
  if (!CONFIRM_ACTIONS.has(action)) return null;
  const confirm = body["confirm"];
  if (typeof confirm !== "string" || confirm !== expected) {
    return jsonError(400, "confirm_mismatch", `confirm must equal "${expected}"`);
  }
  return null;
}

/** Build the production ServerContext. */
export function buildContext(env: Env, cfg: ParsedConfig, rollout: RolloutConfig, runner: Runner): ServerContext {
  const tokens = TokenStore.load(`${env.FLEET_ETC}/serve-tokens.toml`);
  const jobs = new JobRegistry();
  const lockPath = `${env.FLEET_STATE}/reconcile.lock`;
  const tick: TickRunner = {
    async run(opts) {
      // R3-B1: runReconcile(assembleTickDeps(...)) DIRECTLY, never cliReconcile.
      const deps = await assembleTickDeps(env, cfg, rollout, {
        apply: opts.apply,
        runner,
        version: SERVE_VERSION,
      });
      try {
        const res = await runReconcile(deps);
        return res.rc;
      } finally {
        // state-store D1: one handle per tick; the API keeps its own read-only
        // handles for the GET endpoints.
        deps.store?.close();
      }
    },
  };
  return {
    env,
    cfg,
    rollout,
    runner,
    tokens,
    jobs,
    auditSink: nodeAuditSink,
    lockPath,
    tick,
    enrolledBoxes: () => fsEnrolledBoxes(env),
  };
}

export interface ServeDeps {
  env: Env;
  cfg: ParsedConfig;
  rollout?: RolloutConfig;
  runner?: Runner;
  /** injectable serve() (tests never bind a real socket). Returns the server
   *  handle whose stop() is called on graceful shutdown. */
  serve?: (opts: { hostname: string; port: number; fetch: (req: Request) => Promise<Response> }) => { stop: () => void };
  /**
   * Injectable shutdown seam. Production registers SIGTERM/SIGINT handlers and
   * resolves when one fires; a test resolves it directly to drive a graceful
   * stop without real signals. Returns a promise that resolves on shutdown +
   * an `unregister()` to drop the handlers. When omitted, the default wires
   * process signals.
   */
  onShutdown?: () => { done: Promise<void>; unregister: () => void };
}

/** Default shutdown seam: resolve on the FIRST SIGTERM/SIGINT/SIGHUP. */
function processShutdown(): { done: Promise<void>; unregister: () => void } {
  const handlers: Array<[NodeJS.Signals, () => void]> = [];
  const done = new Promise<void>((resolve) => {
    let fired = false;
    const onSig = () => {
      if (fired) return;
      fired = true;
      resolve();
    };
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.on(sig, onSig);
      handlers.push([sig, onSig]);
    }
  });
  return {
    done,
    unregister: () => {
      for (const [sig, h] of handlers) process.off(sig, h);
    },
  };
}

/**
 * `grokfleet serve` entry (already past the locality guard in cli.ts). Resolves the
 * bind (rc 6 when absent), loads tokens (rc 6 on a bad file / missing ffi),
 * installs the log tee, and starts Bun.serve. THE RETURNED PROMISE STAYS PENDING
 * FOR THE SERVER'S LIFETIME — it resolves ONLY on a shutdown signal
 * (SIGTERM/SIGINT/SIGHUP), after `server.stop()`, with rc 0. This is the fix for
 * the r1 gate blocker: cli.ts does `process.exit(rc)` after main() resolves, so
 * if cmdServe resolved right after Bun.serve the process (and the socket) would
 * die immediately. Early-refusal paths (bad args / bind / ffi / tokens) still
 * resolve promptly with their rc.
 */
export async function cmdServe(rest: string[], deps: ServeDeps): Promise<number> {
  const parsed = parseServeArgs(rest);
  if ("err" in parsed) {
    log(parsed.err);
    return 2;
  }
  const runner = deps.runner ?? new BunRunner();
  const rollout = deps.rollout ?? resolveRollout(deps.cfg, {
    FLEET_ROLLOUT_SRC: deps.env.FLEET_ROLLOUT_SRC,
    FLEET_TARGET_REF: deps.env.FLEET_TARGET_REF,
  });

  const bind = await resolveBind(runner, parsed.bind);
  if (bind === undefined) {
    log("serve: refusing — could not resolve a tailnet IPv4 (tailscale ip -4 absent/empty/error). Use --bind for tests.");
    return 6;
  }

  // Verify the ffi lock is available BEFORE binding (R3-A2: symbol unavailable
  // ⇒ serve refuses to start with a clear reason).
  try {
    openLibcFlock();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(msg);
    return 6;
  }

  let ctx: ServerContext;
  try {
    ctx = buildContext(deps.env, deps.cfg, rollout, runner);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`serve: refusing — ${msg}`);
    return 6;
  }

  // state-store D8: `quick_check` at serve start. A FAILURE sets the flag and
  // serve STARTS in the flagged mode — mutations 503, readonly endpoints and the
  // TUI keep serving. It deliberately does NOT refuse: the unit is
  // Restart=on-failure with StartLimitIntervalSec=0 (vps/install-vps.sh), so a
  // refusing serve would be an unbounded restart loop of full scans that never
  // parks in `failed`.
  startupIntegrityCheck(deps.env);

  installCapture();
  const port = parsed.port ?? DEFAULT_PORT;
  const fetchFn = makeFetch(ctx);
  const serveFn = deps.serve ?? ((o) => Bun.serve(o) as unknown as { stop: () => void });
  const server = serveFn({ hostname: bind, port, fetch: fetchFn });
  log(`serve: listening on ${bind}:${port} (${ctx.tokens.count()} token(s))`);

  // Stay alive for the server's lifetime: block on the shutdown seam, then stop
  // the server gracefully and resolve rc 0. Without this the CLI's
  // `process.exit(rc)` would kill Bun.serve the instant we returned (r1 blocker).
  const shutdown = (deps.onShutdown ?? processShutdown)();
  try {
    await shutdown.done;
  } finally {
    shutdown.unregister();
    try {
      server.stop();
    } catch {
      /* best-effort graceful stop */
    }
  }
  log("serve: shutting down (signal) — server stopped");
  return 0;
}
