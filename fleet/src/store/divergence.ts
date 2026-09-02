// divergence.ts — the ADVISORY file-vs-store membership check (blueprint
// fleet2-state-store D6/r2-B7/r3-B1/r4-B2).
//
// The store is authoritative. The exported `enrolled.tsv` is what a rolled-back
// 5.7.1 reads and writes, so after a rollback-and-adopt cycle the FILE can hold a
// row the store does not. This check REPORTS that; it NEVER writes membership.
// Resolution is the operator's, through `fleet2 state reconcile-files`.
//
// Where it runs: on the TICK path only, under the reconcile lock, after
// membership is read and before any action. Readonly opens (CLI queries,
// `serve`, the readonly endpoints, `state check`) never run it — no write on a
// read path, the 5.7.0 `apiFails()` precedent.
//
// The state machine, per diverging NAME, lives in `divergence_findings`:
//   NEW       no row          ⇒ insert + audit('divergence')       + notify(warn)
//   CHANGED   row, other kind ⇒ update + audit('divergence')       + notify(warn)
//   UNCHANGED row, same kind  ⇒ advance last_seen ONLY; re-notify at most daily
//   CLEARED   no longer diverging ⇒ delete + audit('divergence-cleared') + notify(info)
//
// A missing or unreadable file is "cannot compare" and is INERT for the WHOLE
// machine: no new, no changed, no cleared, and no `last_seen` advance (r5-B3).
// Absence is never read as emptiness in either direction, so a finding recorded
// before the file vanished persists with a frozen `last_seen` until the file
// returns or the operator resolves it.

import { existsSync, readFileSync } from "node:fs";
import type { Store } from "./db.ts";
import { parseEnrolled } from "../boxes.ts";
import { log } from "../log.ts";

/** At most one repeat notify per 24 h for an UNCHANGED finding. */
export const DIVERGENCE_RENOTIFY_SECS = 86400;

export type FindingKind = "file-only" | "store-only";

export interface Finding {
  name: string;
  kind: FindingKind;
  first_seen: number;
  last_seen: number;
  last_reported: number | null;
}

export interface DivergenceResult {
  /** true when the file could not be read at all — the machine did nothing. */
  cannotCompare?: string;
  new_: Finding[];
  changed: Finding[];
  unchanged: Finding[];
  cleared: Finding[];
  /** the messages the caller should notify, level-tagged and already worded. */
  notifications: Array<{ level: "info" | "warn"; msg: string }>;
}

export interface DivergenceDeps {
  /** `$FLEET_STATE/enrolled.tsv`. */
  enrolledPath: string;
  now?: number;
  /** injected for tests; defaults to a real read. */
  readFile?: (p: string) => string | undefined;
}

export function currentFindings(store: Store): Finding[] {
  return store.db
    .query("SELECT name, kind, first_seen, last_seen, last_reported FROM divergence_findings ORDER BY name")
    .all() as Finding[];
}

/**
 * Compare the exported file with the store's enrolled set and drive the finding
 * state machine. Writes ONLY `divergence_findings` and `audit`; membership is
 * untouched by design.
 */
export function checkDivergence(store: Store, deps: DivergenceDeps): DivergenceResult {
  const now = deps.now ?? store.now();
  const read =
    deps.readFile ??
    ((p: string): string | undefined => {
      try {
        return existsSync(p) ? readFileSync(p, "utf8") : undefined;
      } catch (e) {
        throw new Error(e instanceof Error ? e.message : String(e));
      }
    });

  let content: string | undefined;
  let reason: string | undefined;
  try {
    content = read(deps.enrolledPath);
    if (content === undefined) reason = "file absent";
  } catch (e) {
    reason = e instanceof Error ? e.message : String(e);
  }

  const result: DivergenceResult = { new_: [], changed: [], unchanged: [], cleared: [], notifications: [] };

  if (reason !== undefined) {
    // INERT. Nothing is inserted, updated, cleared or advanced (r5-B3).
    result.cannotCompare = `cannot compare: ${deps.enrolledPath} ${reason}`;
    log(`reconcile: divergence ${result.cannotCompare}`);
    return result;
  }

  const fileNames = new Set(parseEnrolled(content!));
  const storeNames = new Set(
    (store.db.query("SELECT name FROM boxes WHERE phase = 'enrolled'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );

  const diverging = new Map<string, FindingKind>();
  for (const n of fileNames) if (!storeNames.has(n)) diverging.set(n, "file-only");
  for (const n of storeNames) if (!fileNames.has(n)) diverging.set(n, "store-only");

  const existing = new Map(currentFindings(store).map((f) => [f.name, f]));

  for (const [name, kind] of [...diverging.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const prior = existing.get(name);
    if (prior === undefined) {
      const f: Finding = { name, kind, first_seen: now, last_seen: now, last_reported: now };
      store.db
        .query("INSERT INTO divergence_findings(name,kind,first_seen,last_seen,last_reported) VALUES(?,?,?,?,?)")
        .run(name, kind, now, now, now);
      store.audit({ actor: "reconcile", action: "divergence", box: name, at: now, detail: kind });
      result.new_.push(f);
      result.notifications.push({ level: "warn", msg: divergenceMessage(name, kind, deps.enrolledPath) });
      continue;
    }
    if (prior.kind !== kind) {
      store.db
        .query("UPDATE divergence_findings SET kind = ?, last_seen = ?, last_reported = ? WHERE name = ?")
        .run(kind, now, now, name);
      store.audit({ actor: "reconcile", action: "divergence", box: name, at: now, detail: `${prior.kind} -> ${kind}` });
      result.changed.push({ ...prior, kind, last_seen: now, last_reported: now });
      result.notifications.push({ level: "warn", msg: divergenceMessage(name, kind, deps.enrolledPath) });
      continue;
    }
    // UNCHANGED: advance last_seen; re-notify at most daily.
    const due = prior.last_reported === null || now - prior.last_reported >= DIVERGENCE_RENOTIFY_SECS;
    store.db
      .query("UPDATE divergence_findings SET last_seen = ?, last_reported = ? WHERE name = ?")
      .run(now, due ? now : prior.last_reported, name);
    result.unchanged.push({ ...prior, last_seen: now, last_reported: due ? now : prior.last_reported });
    if (due) result.notifications.push({ level: "warn", msg: divergenceMessage(name, kind, deps.enrolledPath) });
  }

  for (const [name, prior] of existing) {
    if (diverging.has(name)) continue;
    store.db.query("DELETE FROM divergence_findings WHERE name = ?").run(name);
    store.audit({ actor: "reconcile", action: "divergence-cleared", box: name, at: now, detail: prior.kind });
    result.cleared.push(prior);
    result.notifications.push({
      level: "info",
      msg: `${name}: membership divergence cleared — ${deps.enrolledPath} and the state store agree again`,
    });
  }

  return result;
}

function divergenceMessage(name: string, kind: FindingKind, path: string): string {
  return kind === "file-only"
    ? `${name}: membership divergence — ${path} has a row the state store does not; run 'fleet2 state reconcile-files' (advisory, nothing changed)`
    : `${name}: membership divergence — the state store has an enrolled row missing from ${path}; the next export will restore it (advisory, nothing changed)`;
}
