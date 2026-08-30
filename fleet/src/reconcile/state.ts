// state.ts — every $FLEET_STATE file the reconcile tick reads/writes, bytes
// IDENTICAL to bash (blueprint F9/G4 table) so bash and fleet2 can be swapped
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

/** Paths under $FLEET_STATE. */
export class ReconcileState {
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
  keyMetaId(index: number): string | undefined {
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
  recordKeyMeta(index: number, id: string, expires: string): boolean {
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
  /** api.next_retry epoch (main:2767-2774), or undefined when absent/invalid. */
  nextRetry(): number | undefined {
    const raw = this.fs.read(this.p("api.next_retry"));
    if (raw === undefined) return undefined;
    const s = raw.replace(/\s+/g, "");
    return /^[0-9]+$/.test(s) ? Number.parseInt(s, 10) : undefined;
  }

  mkdirState(): void {
    this.fs.mkdirp(this.fleetState);
  }
}
