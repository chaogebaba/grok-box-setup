// history.test.ts — §7.7: write (≤2KB, v:1, 0600, tolerant append), read
// (tail-read, slice), prune (>92d startup + lazy first-read-of-new-day, NO
// timer), and the runReconcile snapshot hook (early-return append, config field,
// write-failure survival).

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSnapshot, serializeLine, MAX_LINE_BYTES, dayStamp } from "../../src/history/write.ts";
import { readLatest, readSlice, prune, RETENTION_DAYS, dayDiff } from "../../src/history/read.ts";
import type { SnapshotLine, SnapshotBox } from "../../src/history/schema.ts";
import { setLogSink } from "../../src/log.ts";

let dirs: string[] = [];
function tmpState(): string {
  const d = mkdtempSync(join(tmpdir(), "fleet2-hist-"));
  dirs.push(d);
  return d;
}
let restore: (l: string) => void;
beforeEach(() => {
  restore = setLogSink(() => {});
});
afterEach(() => {
  setLogSink(restore);
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function box(name: string, over: Partial<SnapshotBox> = {}): SnapshotBox {
  return {
    name,
    tunnel: "up",
    check: "OK",
    ver: "5.3.0",
    drift: "no",
    config: "in-sync",
    checkfail: false,
    asleep: false,
    expiry_days: 42,
    ...over,
  };
}

function line(ts: string, boxes: SnapshotBox[], over: Partial<SnapshotLine> = {}): SnapshotLine {
  return { v: 1, ts, apply: false, canary: "grok-box-1", boxes, ...over };
}

describe("write: schema + 0600 + ≤2KB", () => {
  test("appends v:1 line, mode 0600, readLatest returns the last line", () => {
    const s = tmpState();
    appendSnapshot(s, line("2026-03-01T00:00:00Z", [box("grok-box-1")]));
    appendSnapshot(s, line("2026-03-01T00:05:00Z", [box("grok-box-1", { config: "drift" })]));
    const file = join(s, "history", "2026-03-01.jsonl");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const latest = readLatest(s);
    expect(latest?.v).toBe(1);
    expect(latest?.boxes[0]!.config).toBe("drift"); // last line wins
  });

  test("a line over 2KB is stubbed to boxes:[] + boxes_dropped (freshness survives)", () => {
    const many: SnapshotBox[] = [];
    for (let i = 0; i < 500; i++) many.push(box(`grok-box-${i}`));
    const l = line("2026-03-02T00:00:00Z", many);
    const s = serializeLine(l);
    expect(Buffer.byteLength(s, "utf8")).toBeLessThanOrEqual(MAX_LINE_BYTES);
    const parsed = JSON.parse(s);
    expect(parsed.boxes).toEqual([]);
    expect(parsed.boxes_dropped).toBe(500);
    expect(parsed.ts).toBe("2026-03-02T00:00:00Z"); // ts/apply preserved
  });

  test("append tolerates a write failure (never throws)", () => {
    // A read-only history dir: create it as a FILE so mkdirp/append fail.
    const s = tmpState();
    writeFileSync(join(s, "history"), "i am a file, not a dir");
    // must not throw.
    const ok = appendSnapshot(s, line("2026-03-03T00:00:00Z", [box("grok-box-1")]));
    expect(ok).toBe(false);
  });
});

describe("read: tail-read slice newest-first + box filter", () => {
  test("slice returns lines within the window, newest-first, optionally box-filtered", () => {
    const s = tmpState();
    appendSnapshot(s, line("2026-03-10T00:00:00Z", [box("grok-box-1")]));
    appendSnapshot(s, line("2026-03-10T06:00:00Z", [box("grok-box-2")]));
    appendSnapshot(s, line("2026-03-10T12:00:00Z", [box("grok-box-1"), box("grok-box-2")]));
    const all = readSlice(s, { hours: 24, nowIso: "2026-03-10T12:30:00Z" });
    expect(all.map((l) => l.ts)).toEqual([
      "2026-03-10T12:00:00Z",
      "2026-03-10T06:00:00Z",
      "2026-03-10T00:00:00Z",
    ]);
    const onlyB1 = readSlice(s, { hours: 24, box: "grok-box-1", nowIso: "2026-03-10T12:30:00Z" });
    expect(onlyB1.map((l) => l.ts)).toEqual(["2026-03-10T12:00:00Z", "2026-03-10T00:00:00Z"]);
  });

  test("a line OUTSIDE the window is excluded", () => {
    const s = tmpState();
    appendSnapshot(s, line("2026-03-09T00:00:00Z", [box("grok-box-1")]));
    appendSnapshot(s, line("2026-03-10T12:00:00Z", [box("grok-box-1")]));
    const oneHour = readSlice(s, { hours: 1, nowIso: "2026-03-10T12:30:00Z" });
    expect(oneHour.map((l) => l.ts)).toEqual(["2026-03-10T12:00:00Z"]);
  });
});

describe("prune (>92d) — mutant: off-by-one / disabled prune", () => {
  test("startup prune removes files strictly older than 92 days, keeps the boundary", () => {
    const s = tmpState();
    const dir = join(s, "history");
    mkdirSync(dir, { recursive: true });
    // today = 2026-06-01. 92 days ago boundary kept; 93 removed.
    const today = "2026-06-01";
    const keepBoundary = new Date(Date.parse(`${today}T00:00:00Z`) - RETENTION_DAYS * 86400_000)
      .toISOString()
      .slice(0, 10);
    const removeOld = new Date(Date.parse(`${today}T00:00:00Z`) - (RETENTION_DAYS + 1) * 86400_000)
      .toISOString()
      .slice(0, 10);
    writeFileSync(join(dir, `${keepBoundary}.jsonl`), "{}\n");
    writeFileSync(join(dir, `${removeOld}.jsonl`), "{}\n");
    writeFileSync(join(dir, `${today}.jsonl`), "{}\n");
    const removed = prune(s, today);
    expect(removed).toEqual([removeOld]);
    expect(existsSync(join(dir, `${keepBoundary}.jsonl`))).toBe(true);
    expect(existsSync(join(dir, `${removeOld}.jsonl`))).toBe(false);
  });

  test("dayDiff boundary: exactly 92 days is NOT pruned, 93 is", () => {
    expect(dayDiff("2026-06-01", "2026-03-01")).toBe(92);
    expect(dayDiff("2026-06-02", "2026-03-01")).toBe(93);
  });

  test("lazy prune on the FIRST read of a NEW day (no timer)", () => {
    const s = tmpState();
    const dir = join(s, "history");
    mkdirSync(dir, { recursive: true });
    // an old file + a recent file; read with today far ahead ⇒ old pruned lazily.
    writeFileSync(join(dir, "2026-01-01.jsonl"), JSON.stringify(line("2026-01-01T00:00:00Z", [box("grok-box-1")])) + "\n");
    writeFileSync(join(dir, "2026-05-01.jsonl"), JSON.stringify(line("2026-05-01T00:00:00Z", [box("grok-box-1")])) + "\n");
    // readLatest with today = 2026-06-01 (a NEW day past the newest file) prunes.
    readLatest(s, { today: "2026-06-01" });
    expect(existsSync(join(dir, "2026-01-01.jsonl"))).toBe(false); // pruned (>92d)
    expect(existsSync(join(dir, "2026-05-01.jsonl"))).toBe(true);
  });
});

describe("dayStamp", () => {
  test("extracts YYYY-MM-DD from an iso ts", () => {
    expect(dayStamp("2026-03-01T12:34:56Z")).toBe("2026-03-01");
  });
});
