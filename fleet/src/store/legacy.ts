// legacy.ts — import ONCE, export ALWAYS (blueprint fleet2-state-store D6).
//
// IMPORT is gated on `meta.legacy_imported_at` being ABSENT — NOT on the files
// being absent, because a crashed import leaves an empty file behind. The rule
// table is exactly:
//
//   marker absent + enrolled.tsv present  ⇒ import, then write the marker with
//                                           source='files' in the SAME transaction
//   marker absent + no enrolled.tsv       ⇒ fresh store, marker source='fresh'
//   marker present                        ⇒ NEVER import, whatever the files say
//
// `fleet2 state import --force` replays explicitly (operator only). The replay
// DELETEs every data row first, so a re-run after a crash is a clean replay
// rather than a merge. An UNPARSEABLE legacy file is rc 3 naming the file, the
// transaction rolled back and the marker NOT written: corrupt must not read as
// zero (survey §4f is the whole reason this store exists).
//
// EXPORT is everything 5.7.1 READS that 5.8.0 stops writing, rewritten after
// every membership write and every key write. Rolling back to 5.7.1 is the
// Phase A rollback, so these files must be correct at every instant:
//
//   $FLEET_STATE/enrolled.tsv          after every membership write
//   $FLEET_ETC/authorized-keys.map     after every membership write
//   $FLEET_STATE/<box>.expires         after every box_keys write
//   $FLEET_STATE/keys/<idx>.json       after every box_keys write
//
// Counters are NOT exported: they are ephemeral, and 5.7.1 rebuilds them from
// zero in a few ticks. Export failures are NOT swallowed — see store/state.ts.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Store } from "./db.ts";
import { ConfigError } from "./db.ts";
import { V1_TABLES_CHILD_FIRST } from "./schema.ts";
import { boxIndex } from "../boxes.ts";
import { resolvePort } from "./state.ts";
import { log } from "../log.ts";

export interface ExportPaths {
  fleetState: string;
  etc: string;
  /** the running fleet2 version, stamped into the export header. */
  version: string;
}

/** The header every exported TEXT file carries (D6, note 5). */
export function exportHeader(version: string): string {
  return `# exported by fleet2 ${version} — read-only, edit via fleet2\n`;
}

// --- atomic file helpers -----------------------------------------------------

/**
 * tmp + chmod + rename in the target's own directory — the `keys/<n>.json`
 * idiom (reconcile/state.ts:186-202) applied to every exported file. Throws on
 * failure; the caller records the failure and reports rc 7.
 */
function atomicWrite(path: string, data: string, mode = 0o600): void {
  const dir = path.replace(/\/[^/]*$/, "");
  mkdirSync(dir, { recursive: true });
  const tmp = `${dir}/.fleet2-export.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, data);
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort */
    }
    throw new Error(`export ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function readIf(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

// --- export ------------------------------------------------------------------

interface ExportRow {
  name: string;
  port: number | null;
  pubkey: string | null;
}

function enrolledForExport(store: Store): ExportRow[] {
  return store.db
    .query("SELECT name, port, pubkey FROM boxes WHERE phase = 'enrolled' ORDER BY name")
    .all() as ExportRow[];
}

/**
 * `enrolled.tsv` + `authorized-keys.map`, enrolled rows ONLY, sorted by NAME.
 *
 * 5.7.1's `#` comment lines are NOT preserved (they were operator annotations on
 * a file the engine now owns) and the ordering is by name rather than the
 * append order — both stated here because the round-trip test asserts them.
 *
 * A row whose port is NULL is written with an EMPTY port field: `parseEnrolled`
 * reads field 1 only (boxes.ts:51), so the row keeps its membership across a
 * rollback even though no port can be rendered for it. Such a row is left OUT of
 * `authorized-keys.map`, which is a port→key binding and has nothing to say
 * about a box with no port.
 */
export function exportMembership(store: Store, paths: ExportPaths): void {
  const rows = enrolledForExport(store);
  const header = exportHeader(paths.version);

  const tsv = header + rows.map((r) => `${r.name}\t${r.port ?? ""}`).join("\n") + (rows.length > 0 ? "\n" : "");
  atomicWrite(`${paths.fleetState}/enrolled.tsv`, tsv);

  const mapRows = rows.filter((r) => r.port !== null && r.pubkey !== null && r.pubkey !== "");
  const map =
    header + mapRows.map((r) => `${r.name}\t${r.port}\t${r.pubkey}`).join("\n") + (mapRows.length > 0 ? "\n" : "");
  atomicWrite(`${paths.etc}/authorized-keys.map`, map);
}

/**
 * `<box>.expires` and `keys/<idx>.json` for ONE box, byte-identical to the 5.7.1
 * writers (reconcile/state.ts:157,186) for the same inputs. A box with no key
 * row has both files REMOVED, which is also the retire path (D6).
 */
export function exportKeyFiles(store: Store, paths: ExportPaths, box: string): void {
  const row = store.db
    .query(
      `SELECT b.idx AS idx, k.key_id AS key_id, k.expires_raw AS expires_raw, k.expires_date AS expires_date
       FROM boxes b LEFT JOIN box_keys k ON k.box_id = b.box_id WHERE b.name = ?`,
    )
    .get(box) as { idx: number | null; key_id: string | null; expires_raw: string | null; expires_date: string | null } | null;

  const expiresPath = `${paths.fleetState}/${box}.expires`;
  if (row === null || row.key_id === null) {
    try {
      rmSync(expiresPath, { force: true });
    } catch (e) {
      throw new Error(`export ${expiresPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (row !== null && row.idx !== null) {
      try {
        rmSync(`${paths.fleetState}/keys/${row.idx}.json`, { force: true });
      } catch (e) {
        throw new Error(`export keys/${row.idx}.json: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return;
  }

  // 5.7.1 byte formats: `<box>\t<YYYY-MM-DD>\n` and `{"id":..,"expires":..}`
  // (no trailing newline — JSON.stringify of the same object shape).
  atomicWrite(expiresPath, `${box}\t${row.expires_date}\n`);
  if (row.idx !== null) {
    atomicWrite(
      `${paths.fleetState}/keys/${row.idx}.json`,
      JSON.stringify({ id: row.key_id, expires: row.expires_raw }),
    );
  }
}

/** Every exported artefact, from scratch (after an import or `reconcile-files`). */
export function exportAll(store: Store, paths: ExportPaths): void {
  exportMembership(store, paths);
  for (const r of enrolledForExport(store)) exportKeyFiles(store, paths, r.name);
}

// --- import ------------------------------------------------------------------

/** Strict integer parse for a legacy counter; corrupt is an ERROR, not zero. */
function strictInt(path: string, raw: string): number {
  const s = raw.replace(/\s+/g, "");
  if (s === "" || !/^[0-9]+$/.test(s)) {
    throw new ConfigError(`state store: legacy file ${path} is not a counter (${JSON.stringify(raw.slice(0, 40))}) — refusing to import`);
  }
  return Number.parseInt(s, 10);
}

function strictIntPair(path: string, raw: string): [number, number] {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2 || !/^[0-9]+$/.test(parts[0] ?? "") || !/^[0-9]+$/.test(parts[1] ?? "")) {
    throw new ConfigError(`state store: legacy file ${path} is not a "<n> <n>" marker (${JSON.stringify(raw.slice(0, 40))}) — refusing to import`);
  }
  return [Number.parseInt(parts[0]!, 10), Number.parseInt(parts[1]!, 10)];
}

export type ImportOutcome =
  | { kind: "imported"; boxes: number; keys: number; counters: number; ledger: number }
  | { kind: "fresh" }
  | { kind: "already" };

export interface ImportOptions {
  fleetState: string;
  etc: string;
  /** replay even when the marker is present (`fleet2 state import --force`). */
  force?: boolean;
}

/**
 * Import the 5.7.1 files into the store, once. Returns what it did. Throws
 * ConfigError (rc 3) on an unparseable legacy file, leaving the store untouched
 * and the marker unwritten.
 */
export function importLegacy(store: Store, opts: ImportOptions): ImportOutcome {
  const marker = store.meta("legacy_imported_at");
  if (marker !== undefined && opts.force !== true) return { kind: "already" };

  const enrolledPath = `${opts.fleetState}/enrolled.tsv`;
  const enrolledRaw = readIf(enrolledPath);
  const at = store.now();

  if (enrolledRaw === undefined && opts.force !== true) {
    store.tx(() => {
      store.setMeta("legacy_imported_at", String(at));
      store.setMeta("legacy_import_source", "fresh");
    });
    log(`state store: no ${enrolledPath} — fresh store (legacy_import_source=fresh)`);
    return { kind: "fresh" };
  }

  // Parse EVERYTHING before the transaction opens, so an unparseable file
  // refuses without having touched a row.
  const parsed = parseLegacy(opts.fleetState, opts.etc, enrolledRaw ?? "", at);

  store.tx(() => {
    // A clean replay, not a merge (D6): every DATA row goes first. `meta` and
    // `engine` are deliberately NOT truncated — `min_reader`/`schema_created_at`
    // are the schema contract this very transaction relies on, and `engine` is
    // one fixed row that is overwritten below.
    for (const t of V1_TABLES_CHILD_FIRST) store.db.run(`DELETE FROM ${t}`);
    store.db.run("UPDATE engine SET tick_seq = 0, api_fails = 0, api_backoff_min = NULL, api_next_retry = NULL WHERE id = 1");

    const insBox = store.db.query(
      `INSERT INTO boxes(name,idx,port,phase,created_at,enrolled_at,updated_at,pubkey)
       VALUES(?,?,?,'enrolled',?,NULL,?,?)`,
    );
    const insCounters = store.db.query(
      `INSERT INTO box_counters(box_id,checkfail,seedfail,cfgfail,incoherent,
                                repair_pending_runs,repair_pending_tick,hostkey_mismatch,
                                asleep_since,asleep_last_alert)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    );
    const insKey = store.db.query(
      "INSERT INTO box_keys(box_id,key_id,expires_raw,expires_date,minted_at) VALUES(?,?,?,?,?)",
    );

    for (const b of parsed.boxes) {
      // `enrolled_at` is NULL for every imported row and stays NULL: the files
      // never recorded when a box was enrolled, and a Phase B join must not
      // assume otherwise (D6/r2-B4).
      insBox.run(b.name, b.idx, b.port, at, at, b.pubkey);
      const id = (store.db.query("SELECT box_id FROM boxes WHERE name = ?").get(b.name) as { box_id: number }).box_id;
      insCounters.run(
        id,
        b.counters.checkfail,
        b.counters.seedfail,
        b.counters.cfgfail,
        b.counters.incoherent,
        b.counters.repair_runs,
        b.counters.repair_tick,
        b.counters.hostkey_mismatch,
        b.counters.asleep_since,
        b.counters.asleep_last,
      );
      if (b.key !== undefined) {
        insKey.run(id, b.key.key_id, b.key.expires_raw, b.key.expires_date, b.key.minted_at);
      }
    }

    store.db
      .query("UPDATE engine SET tick_seq = ?, api_fails = ?, api_backoff_min = ?, api_next_retry = ? WHERE id = 1")
      .run(parsed.engine.tick_seq, parsed.engine.api_fails, parsed.engine.api_backoff_min, parsed.engine.api_next_retry);

    const insLedger = store.db.query(
      "INSERT OR REPLACE INTO discover_ledger(name,last_attempt,failures,reason,last_tick) VALUES(?,?,?,?,?)",
    );
    for (const r of parsed.ledger) insLedger.run(r.name, r.last_attempt, r.failures, r.reason, r.last_tick);

    store.setMeta("legacy_imported_at", String(at));
    store.setMeta("legacy_import_source", "files");
    store.audit({
      actor: "fleet2",
      action: "legacy-import",
      rc: 0,
      at,
      detail: `boxes=${parsed.boxes.length} keys=${parsed.keys} ledger=${parsed.ledger.length}`,
    });
  });

  for (const w of parsed.warnings) log(w);
  log(
    `state store: imported ${parsed.boxes.length} enrolled box(es), ${parsed.keys} key row(s), ` +
      `${parsed.ledger.length} discover ledger record(s) from ${opts.fleetState}`,
  );

  resetLegacyFiles(opts.fleetState, parsed.boxes.map((b) => b.name), parsed.engine.tick_seq);

  return { kind: "imported", boxes: parsed.boxes.length, keys: parsed.keys, counters: parsed.boxes.length, ledger: parsed.ledger.length };
}

interface ParsedBox {
  name: string;
  idx: number | null;
  port: number | null;
  pubkey: string | null;
  counters: {
    checkfail: number;
    seedfail: number;
    cfgfail: number;
    incoherent: number;
    repair_runs: number;
    repair_tick: number | null;
    hostkey_mismatch: number;
    asleep_since: number | null;
    asleep_last: number | null;
  };
  key?: { key_id: string; expires_raw: string; expires_date: string; minted_at: number };
}

interface ParsedLegacy {
  boxes: ParsedBox[];
  keys: number;
  engine: { tick_seq: number; api_fails: number; api_backoff_min: number | null; api_next_retry: number | null };
  ledger: Array<{ name: string; last_attempt: number | null; failures: number; reason: string | null; last_tick: number | null }>;
  warnings: string[];
}

/**
 * Parse every legacy file. Pure with respect to the store: nothing here writes,
 * so a refusal costs nothing.
 *
 * `enrolled.tsv` is parsed to ROWS (name + raw port column), not through
 * `parseEnrolled` (which discards the port). Dedup by name, first row wins, as
 * `parseEnrolled` does. A duplicate INDEX (`grok-box-3` + `grok-box-003`) is
 * imported as TWO rows exactly as it exists today (D3/B1); their key export then
 * collides on `keys/3.json`, also exactly as today.
 */
function parseLegacy(fleetState: string, etc: string, enrolledRaw: string, at: number): ParsedLegacy {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const boxes: ParsedBox[] = [];
  const pubkeys = parseAuthorizedKeysMap(readIf(`${etc}/authorized-keys.map`));
  let keys = 0;

  for (const rawLine of enrolledRaw.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const fields = line.split("\t");
    const name = (fields[0] ?? "").trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);

    const idx = boxIndex(name);
    const { port, warn } = resolvePort(name, fields[1]);
    if (warn !== undefined) warnings.push(warn);

    const counters = readCounters(fleetState, name);
    const key = readKeyRow(fleetState, name, idx, at, warnings);
    if (key !== undefined) keys += 1;

    boxes.push({
      name,
      idx: idx === undefined ? null : idx,
      port,
      pubkey: pubkeys.get(name) ?? null,
      counters,
      key,
    });
  }

  return {
    boxes,
    keys,
    engine: readEngine(fleetState),
    ledger: readLedger(fleetState),
    warnings,
  };
}

function readCounters(fleetState: string, box: string): ParsedBox["counters"] {
  const num = (suffix: string): number => {
    const p = `${fleetState}/${box}.${suffix}`;
    const raw = readIf(p);
    return raw === undefined ? 0 : strictInt(p, raw);
  };
  const asleepPath = `${fleetState}/${box}.asleep`;
  const asleepRaw = readIf(asleepPath);
  const asleep = asleepRaw === undefined ? undefined : strictIntPair(asleepPath, asleepRaw);
  const repairPath = `${fleetState}/${box}.repair_pending_runs`;
  const repairRaw = readIf(repairPath);
  const repair = repairRaw === undefined ? undefined : strictIntPair(repairPath, repairRaw);

  return {
    checkfail: num("checkfail"),
    seedfail: num("seedfail"),
    cfgfail: num("cfgfail"),
    incoherent: num("incoherent"),
    repair_runs: repair?.[0] ?? 0,
    repair_tick: repair?.[1] ?? null,
    // presence-only in 5.7.1 (reconcile/state.ts:297-305).
    hostkey_mismatch: existsSync(`${fleetState}/${box}.hostkey_mismatch`) ? 1 : 0,
    asleep_since: asleep?.[0] ?? null,
    asleep_last: asleep?.[1] ?? null,
  };
}

/**
 * `keys/<idx>.json` + `<box>.expires` → one `box_keys` row (D6/r3-n5):
 *
 *  - key file present, `<box>.expires` ABSENT ⇒ the row is still created, with
 *    `expires_date` derived from the key file's own ISO `expires` (the same
 *    first-10-chars derivation `writeExpires` uses). This IS the mint crash
 *    window this blueprint closes, and it must not fail the guard open on the
 *    first tick.
 *  - `<box>.expires` present with NO key file ⇒ NO row, one log line: without a
 *    key id there is nothing to revoke and nothing the guard can check.
 */
function readKeyRow(
  fleetState: string,
  box: string,
  idx: number | undefined,
  at: number,
  warnings: string[],
): ParsedBox["key"] {
  const keyPath = idx === undefined ? undefined : `${fleetState}/keys/${idx}.json`;
  const keyRaw = keyPath === undefined ? undefined : readIf(keyPath);
  const expiresPath = `${fleetState}/${box}.expires`;
  const expiresRaw = readIf(expiresPath);

  if (keyRaw === undefined) {
    if (expiresRaw !== undefined) {
      warnings.push(
        `state store: ${box} has ${box}.expires but no keys/${idx ?? "?"}.json — no key row imported (nothing to revoke)`,
      );
    }
    return undefined;
  }

  let parsed: { id?: unknown; expires?: unknown };
  try {
    parsed = JSON.parse(keyRaw) as { id?: unknown; expires?: unknown };
  } catch (e) {
    throw new ConfigError(
      `state store: legacy file ${keyPath} is not JSON (${e instanceof Error ? e.message : String(e)}) — refusing to import`,
    );
  }
  if (typeof parsed.id !== "string" || parsed.id === "") {
    throw new ConfigError(`state store: legacy file ${keyPath} has no usable "id" — refusing to import`);
  }
  const rawExpires = typeof parsed.expires === "string" ? parsed.expires : "";

  // The expiry date: the marker file's column 2 when it exists, else the first
  // 10 characters of the key file's ISO expiry.
  let date = "";
  if (expiresRaw !== undefined) {
    const first = expiresRaw.split("\n").find((l) => l.trim() !== "");
    date = (first?.split("\t")[1] ?? "").replace(/\s+/g, "");
  }
  if (date.length !== 10) date = rawExpires.slice(0, 10);
  if (date.length !== 10) {
    throw new ConfigError(
      `state store: cannot derive a YYYY-MM-DD expiry for ${box} from ${keyPath} (${JSON.stringify(rawExpires.slice(0, 30))}) — refusing to import`,
    );
  }

  let mtime = at;
  try {
    if (keyPath !== undefined) mtime = Math.floor(statSync(keyPath).mtimeMs / 1000);
  } catch {
    /* fall back to the import time */
  }

  return { key_id: parsed.id, expires_raw: rawExpires === "" ? date : rawExpires, expires_date: date, minted_at: mtime };
}

function readEngine(fleetState: string): ParsedLegacy["engine"] {
  const read = (name: string): number | null => {
    const p = `${fleetState}/${name}`;
    const raw = readIf(p);
    return raw === undefined ? null : strictInt(p, raw);
  };
  return {
    tick_seq: read("tick.seq") ?? 0,
    api_fails: read("api.fails") ?? 0,
    api_backoff_min: read("api.backoff_min"),
    api_next_retry: read("api.next_retry"),
  };
}

function readLedger(fleetState: string): ParsedLegacy["ledger"] {
  const p = `${fleetState}/discover.json`;
  const raw = readIf(p);
  if (raw === undefined) return [];
  let v: { boxes?: unknown };
  try {
    v = JSON.parse(raw) as { boxes?: unknown };
  } catch (e) {
    throw new ConfigError(
      `state store: legacy file ${p} is not JSON (${e instanceof Error ? e.message : String(e)}) — refusing to import`,
    );
  }
  if (!Array.isArray(v.boxes)) return [];
  const out: ParsedLegacy["ledger"] = [];
  const seen = new Set<string>();
  for (const r of v.boxes as Array<Record<string, unknown>>) {
    if (r === null || typeof r !== "object") continue;
    const name = typeof r.name === "string" ? r.name : "";
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      last_attempt: typeof r.last_attempt === "number" ? r.last_attempt : null,
      failures: typeof r.failures === "number" ? r.failures : 0,
      reason: typeof r.reason === "string" ? r.reason : null,
      last_tick: typeof r.last_tick === "number" ? r.last_tick : null,
    });
  }
  return out;
}

/** `box\tport\tkey` → name→key. Comment lines and short rows ignored. */
export function parseAuthorizedKeysMap(content: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (content === undefined) return m;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const f = line.split("\t");
    const name = (f[0] ?? "").trim();
    const key = (f[2] ?? "").trim();
    if (name === "" || key === "") continue;
    if (!m.has(name)) m.set(name, key);
  }
  return m;
}

/**
 * D6/B4: reset the legacy files the store now owns, so a rollback to 5.7.1
 * starts from a clean slate rather than replaying stale counts.
 *
 *  - the `<box>.*` counters: `0` where 5.7.1's reset is `echo 0 >`, REMOVED
 *    where its reset is `rm -f` (survey §2a, column by column);
 *  - `api.fails`/`api.backoff_min`/`api.next_retry`: REMOVED — a stale future
 *    `next_retry` would suppress the devices GET for up to 20 minutes after a
 *    rollback;
 *  - `tick.seq` and `discover.json`: LEFT. The first is a freshness ordinal the
 *    store now continues from the same number, and the second is a harmless
 *    backoff schedule.
 *
 * `<box>.expires` and `keys/<idx>.json` are NOT reset — they are export targets.
 */
function resetLegacyFiles(fleetState: string, boxes: string[], tickSeq: number): void {
  const zero = ["checkfail", "seedfail"];
  const remove = ["cfgfail", "incoherent", "asleep", "hostkey_mismatch"];
  let zeroed = 0;
  let removed = 0;
  for (const b of boxes) {
    for (const s of zero) {
      const p = `${fleetState}/${b}.${s}`;
      if (!existsSync(p)) continue;
      try {
        writeFileSync(p, "0\n");
        zeroed += 1;
      } catch {
        /* best-effort: the store is authoritative now */
      }
    }
    for (const s of remove) {
      const p = `${fleetState}/${b}.${s}`;
      if (!existsSync(p)) continue;
      try {
        rmSync(p, { force: true });
        removed += 1;
      } catch {
        /* best-effort */
      }
    }
    // repair_pending_runs' own reset is `0 <tick>`, not a removal.
    const rp = `${fleetState}/${b}.repair_pending_runs`;
    if (existsSync(rp)) {
      try {
        writeFileSync(rp, `0 ${tickSeq}\n`);
        zeroed += 1;
      } catch {
        /* best-effort */
      }
    }
  }
  for (const f of ["api.fails", "api.backoff_min", "api.next_retry"]) {
    const p = `${fleetState}/${f}`;
    if (!existsSync(p)) continue;
    try {
      rmSync(p, { force: true });
      log(`state store: reset legacy ${f} (removed — a stale backoff must not survive the import)`);
      removed += 1;
    } catch {
      /* best-effort */
    }
  }
  log(`state store: reset legacy marker files (${zeroed} zeroed, ${removed} removed; tick.seq and discover.json left as they are)`);
}
