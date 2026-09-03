// state.ts — every $FLEET_STATE file the reconcile tick reads/writes, bytes
// IDENTICAL to bash (blueprint F9/G4 table) so bash and grokfleet can be swapped
// mid-soak with no migration (D2). All writes swallow errors exactly as bash
// (`… 2>/dev/null || true`); the tick never aborts on a state-write failure.
//
// Counter idiom (main:2741-2742, 3182-3183, 3252-3253): read the file, strip
// ALL whitespace, empty or non-`[0-9]+` ⇒ 0. Counters are written `echo N >`
// (i.e. `N\n`). keys/<N>.json is atomic (tmp + `mv -f`, mode 600, read-back must
// recover the id — main:1744-1763). `<box>.expires` is `<box>\t<YYYY-MM-DD>\n`.
//
// This is a NEW module (phase-1 `state.ts` is inventory-only); it uses node:fs
// synchronously behind a small injectable seam so tests run against a tmp dir.

import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync, renameSync } from "node:fs";
import { boxIndex as boxIndexForKeys } from "../boxes.ts";

export interface StateFs {
  read(path: string): string | undefined;
  write(path: string, data: string): void;
  remove(path: string): void;
  mkdirp(path: string): void;
  chmod(path: string, mode: number): void;
  rename(from: string, to: string): void;
  exists(path: string): boolean;
  /** create a unique temp path in `dir` (does not create the file). */
  tmpname(dir: string, prefix: string): string;
}

/** Production seam over node:fs, best-effort (all failures swallowed). */
export const nodeStateFs: StateFs = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  write(path, data) {
    try {
      writeFileSync(path, data);
    } catch {
      /* swallowed, bash parity */
    }
  },
  remove(path) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* swallowed */
    }
  },
  mkdirp(path) {
    try {
      mkdirSync(path, { recursive: true });
    } catch {
      /* swallowed */
    }
  },
  chmod(path, mode) {
    try {
      chmodSync(path, mode);
    } catch {
      /* swallowed */
    }
  },
  rename(from, to) {
    renameSync(from, to); // NOT swallowed — callers check the invariant
  },
  exists(path) {
    return existsSync(path);
  },
  tmpname(dir, prefix) {
    return `${dir}/${prefix}${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  },
};

/**
 * The per-tick state surface, implemented TWICE (state-store D7 Phase A):
 *
 *  - `ReconcileState` below — the 5.7.1 file implementation. It is no longer on
 *    the tick path; it survives as the LEGACY reader the import uses and as the
 *    byte-for-byte reference the export round-trip test compares against.
 *  - `StoreState` (store/state.ts) — the bun:sqlite implementation the tick,
 *    the CLI and the readonly API endpoints use from 5.8.0 on.
 *
 * Keeping one interface is what lets `ReconcileDeps.state` stay a single type
 * and every existing test keep injecting the file version.
 */
export interface ReconcileStateApi {
  bumpCheckfail(box: string): number;
  resetCheckfail(box: string): void;
  checkfailCount(box: string): number;
  bumpSeedfail(box: string): number;
  resetSeedfail(box: string): void;
  bumpCfgfail(box: string): number;
  resetCfgfail(box: string): void;
  bumpIncoherent(box: string): number;
  resetIncoherent(box: string): void;
  readAsleep(box: string): { since: number; last: number } | undefined;
  writeAsleep(box: string, since: number, last: number): void;
  resetAsleep(box: string): void;
  writeExpires(box: string, date: string): void;
  readExpiresDate(box: string): string | undefined;
  /**
   * The recorded Tailscale key id. `box` is optional for source compatibility
   * with the 5.7.1 file layout (`keys/<index>.json` is index-keyed); the store
   * uses it when given because `box_keys` is keyed by `box_id`, and two rows may
   * legitimately share an index (`grok-box-3` + `grok-box-003`, D3/B1).
   */
  keyMetaId(index: number, box?: string): string | undefined;
  recordKeyMeta(index: number, id: string, expires: string, box?: string): boolean;
  /**
   * D5: record the key id AND both expiry forms in ONE write. 5.7.1 wrote
   * `keys/<idx>.json` and then `<box>.expires` as two files with a crash window
   * between them (survey §4b), which made the mint-window guard fail open and
   * the next tick re-mint. The store does it in one statement.
   */
  recordKey(box: string, meta: { keyId: string; expiresRaw: string; expiresDate: string }): boolean;
  recordApiFailure(nowSec: number): { n: number; mins: number };
  resetApiFailure(): void;
  apiFails(): number;
  nextRetry(): number | undefined;
  bumpTick(): number;
  currentTick(): number;
  readRepairPending(box: string): { runs: number; tick: number } | undefined;
  bumpRepairPending(box: string, tick: number): number;
  resetRepairPending(box: string, tick: number): void;
  readHostkeyMismatch(box: string): boolean;
  setHostkeyMismatch(box: string): void;
  clearHostkeyMismatch(box: string): void;
  readDiscoverLedger(): DiscoverRecord[];
  writeDiscoverLedger(records: DiscoverRecord[]): void;
  mkdirState(): void;
}

/** Paths under $FLEET_STATE. */
export class ReconcileState implements ReconcileStateApi {
  constructor(
    readonly fleetState: string,
    readonly fs: StateFs = nodeStateFs,
  ) {}

  private p(name: string): string {
    return `${this.fleetState}/${name}`;
  }
  private keysDir(): string {
    return `${this.fleetState}/keys`;
  }

  /** Counter read: strip whitespace, empty/non-numeric ⇒ 0 (main:2741-2742). */
  private readCounter(name: string): number {
    const raw = this.fs.read(this.p(name));
    if (raw === undefined) return 0;
    const stripped = raw.replace(/\s+/g, "");
    if (stripped === "" || !/^[0-9]+$/.test(stripped)) return 0;
    return Number.parseInt(stripped, 10);
  }
  /** bump a counter: read → +1 → `echo N >` (`N\n`). Returns the new value. */
  private bumpCounter(name: string): number {
    const n = this.readCounter(name) + 1;
    this.fs.write(this.p(name), `${n}\n`);
    return n;
  }

  // --- checkfail (main:3179-3198) ---
  bumpCheckfail(box: string): number {
    return this.bumpCounter(`${box}.checkfail`);
  }
  resetCheckfail(box: string): void {
    this.fs.write(this.p(`${box}.checkfail`), "0\n"); // reset = `echo 0 >`
  }
  checkfailCount(box: string): number {
    return this.readCounter(`${box}.checkfail`);
  }

  // --- seedfail (main:3201-3209) ---
  bumpSeedfail(box: string): number {
    return this.bumpCounter(`${box}.seedfail`);
  }
  resetSeedfail(box: string): void {
    this.fs.write(this.p(`${box}.seedfail`), "0\n"); // reset = `echo 0 >`
  }

  // --- cfgfail (main:2307-2315) ---
  bumpCfgfail(box: string): number {
    return this.bumpCounter(`${box}.cfgfail`);
  }
  resetCfgfail(box: string): void {
    this.fs.remove(this.p(`${box}.cfgfail`)); // reset = rm -f
  }

  // --- incoherent (main:3249-3259) — value is the consecutive-run count ---
  bumpIncoherent(box: string): number {
    return this.bumpCounter(`${box}.incoherent`);
  }
  resetIncoherent(box: string): void {
    this.fs.remove(this.p(`${box}.incoherent`)); // reset = rm -f
  }

  // --- asleep (main:3216-3243) — "<since> <last_alert>\n" ---
  readAsleep(box: string): { since: number; last: number } | undefined {
    const raw = this.fs.read(this.p(`${box}.asleep`));
    if (raw === undefined) return undefined;
    const parts = raw.trim().split(/\s+/);
    const since = /^[0-9]+$/.test(parts[0] ?? "") ? Number.parseInt(parts[0]!, 10) : NaN;
    const last = /^[0-9]+$/.test(parts[1] ?? "") ? Number.parseInt(parts[1]!, 10) : NaN;
    return { since: Number.isNaN(since) ? NaN : since, last: Number.isNaN(last) ? NaN : last };
  }
  writeAsleep(box: string, since: number, last: number): void {
    this.fs.write(this.p(`${box}.asleep`), `${since} ${last}\n`);
  }
  resetAsleep(box: string): void {
    this.fs.remove(this.p(`${box}.asleep`)); // reset = rm -f
  }

  // --- <box>.expires (main:1714) — "<box>\t<YYYY-MM-DD>\n" ---
  writeExpires(box: string, date: string): void {
    this.fs.write(this.p(`${box}.expires`), `${box}\t${date}\n`);
  }
  /** Read the expiry date (awk -F'\t' col2, whitespace-stripped) or undefined. */
  readExpiresDate(box: string): string | undefined {
    const raw = this.fs.read(this.p(`${box}.expires`));
    if (raw === undefined) return undefined;
    const first = raw.split("\n").find((l) => l.trim() !== "");
    if (first === undefined) return undefined;
    const col2 = first.split("\t")[1]?.replace(/\s+/g, "");
    return col2 && col2 !== "" ? col2 : undefined;
  }

  // --- keys/<N>.json (main:1744-1763) — {"id":..,"expires":..}, mode 600 ---
  /** key_meta_id (main:860-864): recorded id or undefined. */
  keyMetaId(index: number, box?: string): string | undefined {
    void box; // index-keyed in the file layout; the store uses the name (D3/B1)
    const raw = this.fs.read(`${this.keysDir()}/${index}.json`);
    if (raw === undefined) return undefined;
    try {
      const v = JSON.parse(raw) as { id?: unknown };
      return typeof v.id === "string" && v.id !== "" ? v.id : undefined;
    } catch {
      return undefined;
    }
  }
  /**
   * record_key_meta (main:1744-1763): refuse blank id; atomic tmp+mv, mode 600;
   * read-back must recover the id. Returns false (rc 1) on any failure.
   */
  recordKeyMeta(index: number, id: string, expires: string, box?: string): boolean {
    void box;
    if (id === "") return false; // blank id cannot satisfy the invariant
    const dir = this.keysDir();
    this.fs.mkdirp(dir);
    const f = `${dir}/${index}.json`;
    const tmp = this.fs.tmpname(dir, ".keymeta.");
    const json = JSON.stringify({ id, expires });
    this.fs.write(tmp, json);
    this.fs.chmod(tmp, 0o600);
    try {
      this.fs.rename(tmp, f);
    } catch {
      this.fs.remove(tmp);
      return false;
    }
    // read-back invariant
    return this.keyMetaId(index) === id;
  }

  /**
   * The FILE implementation of the D5 one-write mint record: still two writes
   * (that is the whole point of the store), kept so the legacy class satisfies
   * the interface and so the export round-trip test can produce 5.7.1 bytes.
   */
  recordKey(box: string, meta: { keyId: string; expiresRaw: string; expiresDate: string }): boolean {
    const idx = boxIndexForKeys(box);
    if (idx === undefined) return false;
    if (!this.recordKeyMeta(idx, meta.keyId, meta.expiresRaw)) return false;
    this.writeExpires(box, meta.expiresDate);
    return true;
  }

  // --- api backoff (main:2739-2778) ---
  recordApiFailure(nowSec: number): { n: number; mins: number } {
    const n = this.bumpCounter("api.fails");
    const mins = n === 1 ? 5 : n === 2 ? 10 : 20;
    this.fs.write(this.p("api.backoff_min"), `${mins}\n`);
    this.fs.write(this.p("api.next_retry"), `${nowSec + mins * 60}\n`);
    return { n, mins };
  }
  resetApiFailure(): void {
    this.fs.write(this.p("api.fails"), "0\n"); // reset = echo 0 >
    this.fs.remove(this.p("api.next_retry"));
    this.fs.remove(this.p("api.backoff_min"));
  }
  /**
   * READ-ONLY consecutive-API-failure count (5.7.0 D1, gate r1 B3).
   *
   * `recordApiFailure` is the only other public path that yields this number,
   * and it BUMPS the counter and writes `api.next_retry`/`api.backoff_min` on
   * the way. A read path that called it would push the engine into a fabricated
   * backoff, so `GET /v1/boxes/:name` calls THIS instead. Plain `readCounter`
   * idiom: no writes at all.
   */
  apiFails(): number {
    return this.readCounter("api.fails");
  }
  /** api.next_retry epoch (main:2767-2774), or undefined when absent/invalid. */
  nextRetry(): number | undefined {
    const raw = this.fs.read(this.p("api.next_retry"));
    if (raw === undefined) return undefined;
    const s = raw.replace(/\s+/g, "");
    return /^[0-9]+$/.test(s) ? Number.parseInt(s, 10) : undefined;
  }

  // --- tick sequence (zero-touch join D5) ---------------------------------
  //
  // `repair_pending_runs` freshness is ORDINAL — "written by the immediately
  // preceding tick" / "written by the CURRENT tick" — so it needs a tick
  // ordinal, not a wall clock. `tick.seq` is a plain counter bumped ONCE at the
  // start of every runReconcile (including early-return ticks, so the ordering
  // never has a hole). Same idiom as every other counter here: an absent or
  // non-numeric file reads 0, so a fresh brain starts at tick 1.
  bumpTick(): number {
    return this.bumpCounter("tick.seq");
  }
  /** The current tick ordinal (0 before the first bump). */
  currentTick(): number {
    return this.readCounter("tick.seq");
  }

  // --- repair_pending_runs (zero-touch join D5) ----------------------------
  //
  // `<box>.repair_pending_runs` = "<runs> <tick>\n". DISTINCT from
  // `<box>.incoherent`, whose reset semantics differ (incoherent is rm -f'd by
  // any non-alert action and drives alertIncoherent's n>=2 notify throttle).
  // This marker counts CONSECUTIVE ticks in which row e's incoherent condition
  // held, and carries the STAMP of the tick that wrote it so each consumer can
  // apply its own freshness rule:
  //   adopt  (before the loop) yields only to a marker stamped tick-1;
  //   repair (after the loop) fires only on a marker stamped tick, runs >= 2.
  // A marker older than the preceding tick is ignored by both, which is also
  // why a de-enrolled box needs no explicit clearing.
  readRepairPending(box: string): { runs: number; tick: number } | undefined {
    const raw = this.fs.read(this.p(`${box}.repair_pending_runs`));
    if (raw === undefined) return undefined;
    const parts = raw.trim().split(/\s+/);
    if (!/^[0-9]+$/.test(parts[0] ?? "") || !/^[0-9]+$/.test(parts[1] ?? "")) return undefined;
    return { runs: Number.parseInt(parts[0]!, 10), tick: Number.parseInt(parts[1]!, 10) };
  }
  /** Bump the consecutive-incoherent count and stamp it with `tick`. */
  bumpRepairPending(box: string, tick: number): number {
    const prev = this.readRepairPending(box);
    const runs = (prev?.runs ?? 0) + 1;
    this.fs.write(this.p(`${box}.repair_pending_runs`), `${runs} ${tick}\n`);
    return runs;
  }
  /** RESET TO 0 on any tick in which the incoherent condition does not hold. */
  resetRepairPending(box: string, tick: number): void {
    this.fs.write(this.p(`${box}.repair_pending_runs`), `0 ${tick}\n`);
  }

  // --- hostkey_mismatch (zero-touch join D11c) -----------------------------
  //
  // `<box>.hostkey_mismatch` is a ONE-TICK memory of an OBSERVATION: the box's
  // tunnel results this tick contained OpenSSH's REMOTE HOST IDENTIFICATION HAS
  // CHANGED banner. It is DISTINCT from `<box>.incoherent` and from
  // `<box>.repair_pending_runs` (which it feeds): it carries no count and no
  // stamp because it is rewritten from scratch at the same one site every tick
  // — set on a mismatch tick, cleared on ANY tick whose tunnel results contain
  // no mismatch, tunnel-down ticks (which make no tunnel call at all) included.
  //
  // Two consumers read it within the same tick: the tunnel-write gate in the
  // action loop, and the config pass.
  readHostkeyMismatch(box: string): boolean {
    return this.fs.read(this.p(`${box}.hostkey_mismatch`)) !== undefined;
  }
  setHostkeyMismatch(box: string): void {
    this.fs.write(this.p(`${box}.hostkey_mismatch`), "1\n");
  }
  clearHostkeyMismatch(box: string): void {
    this.fs.remove(this.p(`${box}.hostkey_mismatch`));
  }

  // --- discover.json (zero-touch join D4 backoff ledger) -------------------
  /** Read the per-box failure ledger; a missing/corrupt file reads as empty. */
  readDiscoverLedger(): DiscoverRecord[] {
    const raw = this.fs.read(this.p("discover.json"));
    if (raw === undefined) return [];
    try {
      const v = JSON.parse(raw) as { boxes?: unknown };
      if (!Array.isArray(v.boxes)) return [];
      return (v.boxes as DiscoverRecord[]).filter(
        (r) => r !== null && typeof r === "object" && typeof r.name === "string" && r.name !== "",
      );
    } catch {
      return [];
    }
  }
  /** Write the ledger (best-effort, like every other state write). */
  writeDiscoverLedger(records: DiscoverRecord[]): void {
    this.fs.write(this.p("discover.json"), JSON.stringify({ v: 1, boxes: records }) + "\n");
  }

  mkdirState(): void {
    this.fs.mkdirp(this.fleetState);
  }
}

/**
 * One box's discover failure record (D4). `last_attempt` is epoch seconds for a
 * human reading the file; `last_tick` is the tick ordinal the backoff schedule
 * actually counts in.
 */
export interface DiscoverRecord {
  name: string;
  last_attempt: number;
  failures: number;
  reason: string;
  last_tick: number;
}
