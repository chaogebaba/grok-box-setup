// jobs-view.test.ts — the TUI jobs view, the JOB column, and the header counter
// (blueprint grokfleet-5.14.0 "TUI jobs view", D1/D2).
//
// Everything here renders from what `/v1/fleet` already carries per box (the
// `job` field, attached at serve time like `lease`) plus the existing
// `GET /v1/jobs`; no endpoint, store or reconcile change. The occupancy.test.ts
// pattern is followed verbatim: pure model/reducer assertions where possible,
// and a mounted Ink app only for the on-demand fetch paths.

import { describe, expect, test } from "bun:test";
import {
  COND_MIN_VISIBLE,
  GLYPH,
  JOB_COL_MIN_COLS,
  NO_JOBS,
  headerText,
  jobCell,
  jobCount,
  jobRows,
  showCondColumn,
  showJobColumn,
  tableLines,
  viewLines,
} from "../../src/tui/model.ts";
import { handleKey } from "../../src/tui/state.ts";
import { makeApiClient, type BoxJob, type FetchLike, type FleetBox, type Job } from "../../src/tui/api-client.ts";
import { mount, settle, silentClient } from "./ink-harness.ts";
import { box, state, SIZE_120x40 } from "./helpers.ts";

/** The clock every fixture and golden is pinned to. */
const NOW = Date.parse("2026-05-01T00:00:10Z");
const SIZE_100x40 = { cols: 100, rows: 40 };

function boxJob(over: Partial<BoxJob> = {}): BoxJob {
  return {
    job_id: "JOBID000000000000000A",
    kind: "run",
    state: "running",
    holder: "ci:runner-3",
    purpose: "gate",
    started_at: "2026-04-30T23:48:00Z", // 12m before NOW
    ...over,
  };
}

const jobbed = (name: string, j: BoxJob, over = {}): FleetBox => ({ ...box(name, over), job: j });

function job(over: Partial<Job> = {}): Job {
  return {
    job_id: "JOBID000000000000000A",
    box: "grok-box-001",
    kind: "run",
    state: "running",
    rc: null,
    holder: "ci:runner-3",
    purpose: "gate",
    cmd: "sleep 300",
    cwd: "/workspace",
    wall_cap_s: 300,
    keep_alive: false,
    lease_id: null,
    created_at: "2026-04-30T23:48:00Z",
    started_at: "2026-04-30T23:48:00Z",
    ended_at: null,
    last_poll_at: "2026-05-01T00:00:00Z",
    log_bytes: 0,
    log_truncated: false,
    lost_reason: null,
    ...over,
  };
}

// --- D1: the JOB cell renderer ----------------------------------------------
describe("D1 — the JOB cell", () => {
  test("`<kind> <age>` for run and service, the ONE relative grammar", () => {
    expect(jobCell(boxJob(), NOW)).toBe("run 12m");
    // 1h05: started 1h05 before NOW.
    expect(jobCell(boxJob({ started_at: "2026-04-30T22:55:10Z" }), NOW)).toBe("run 1h05");
    // svc 2d3h.
    expect(jobCell(boxJob({ kind: "service", started_at: "2026-04-28T21:00:10Z" }), NOW)).toBe("svc 2d3h");
  });

  test("a starting job (null started_at) renders `run ?` / `svc ?`", () => {
    expect(jobCell(boxJob({ state: "starting", started_at: null }), NOW)).toBe("run ?");
    expect(jobCell(boxJob({ kind: "service", state: "starting", started_at: null }), NOW)).toBe("svc ?");
  });

  test("no job renders `-`", () => {
    expect(jobCell(null, NOW)).toBe("-");
    expect(jobCell(undefined, NOW)).toBe("-");
  });

  // MUTANT: JOB cell uses fmtAge (no day tier) so a 3-day service reads `72h`.
  // The day tier of `age` is what keeps `svc 2d3h` from becoming `svc 51h`.
  test("the day tier survives: a multi-day service is `2d3h`, never hours", () => {
    const cell = jobCell(boxJob({ kind: "service", started_at: "2026-04-28T21:00:10Z" }), NOW);
    expect(cell).toBe("svc 2d3h");
    expect(cell).not.toContain("h ");
    expect(cell).not.toMatch(/\d{2,}h$/);
  });

  test("a value longer than the cell is cut to 8 in the rendered row", () => {
    // svc 100d5h is 9 chars; the cell budget is 9 (8 text + gap), so the row
    // shows it cut to 8 then padded.
    const s = state({ boxes: [jobbed("grok-box-001", boxJob({ kind: "service", started_at: "2026-01-16T19:00:10Z" }))] });
    const row = tableLines(s, SIZE_120x40)[1]!.text;
    // JOB starts after glyph(2)+name(14)+who(12) = 28.
    const jobCellText = row.slice(28, 28 + 9);
    expect(jobCellText.length).toBe(9);
    expect(jobCellText.trimEnd().length).toBeLessThanOrEqual(8);
  });
});

// --- D1: the JOB column gate ------------------------------------------------
describe("D1 — showJobColumn / the JOB column", () => {
  test("the floor is 110: omitted at 109, shown at 110", () => {
    expect(JOB_COL_MIN_COLS).toBe(110);
    expect(showJobColumn({ cols: 109, rows: 40 })).toBe(false);
    expect(showJobColumn({ cols: 110, rows: 40 })).toBe(true);
  });

  // MUTANT: showJobColumn threshold 100 instead of 110 (layout EXP must go red).
  test("at 100 columns the JOB header is absent and EXPIRY is intact", () => {
    const s = state({ boxes: [jobbed("grok-box-001", boxJob())] });
    const head = tableLines(s, SIZE_100x40)[0]!.text;
    expect(head).not.toContain("JOB");
    expect(head).toContain("EXP");
  });

  test("at 110 columns the JOB header is present", () => {
    const s = state({ boxes: [jobbed("grok-box-001", boxJob())] });
    expect(tableLines(s, { cols: 110, rows: 40 })[0]!.text).toContain("JOB");
  });
});

// --- D1: COND omission -------------------------------------------------------
describe("D1 — showCondColumn (COND omitted, never a stub)", () => {
  test("COND_MIN_VISIBLE is 8", () => {
    expect(COND_MIN_VISIBLE).toBe(8);
  });

  // The worked values from the blueprint (A26+A27): 99 show, 100/110/120 omit,
  // 124 show, 137 show.
  test("the boundary: shown at 99, omitted 100..123, back at 124, shown at 137", () => {
    expect(showCondColumn({ cols: 99, rows: 40 })).toBe(true);
    expect(showCondColumn({ cols: 100, rows: 40 })).toBe(false);
    expect(showCondColumn({ cols: 110, rows: 40 })).toBe(false);
    expect(showCondColumn({ cols: 120, rows: 40 })).toBe(false);
    expect(showCondColumn({ cols: 123, rows: 40 })).toBe(false);
    expect(showCondColumn({ cols: 124, rows: 40 })).toBe(true);
    expect(showCondColumn({ cols: 137, rows: 40 })).toBe(true);
  });

  // MUTANT: COND_MIN_VISIBLE is 7 instead of 8 — the 123/124 pair must move.
  test("123 omits and 124 shows — the pair that pins COND_MIN_VISIBLE=8", () => {
    expect(showCondColumn({ cols: 123, rows: 40 })).toBe(false);
    expect(showCondColumn({ cols: 124, rows: 40 })).toBe(true);
  });
});

// --- D1: the header counter --------------------------------------------------
describe("D1 — the jobs header counter", () => {
  test("jobCount keys on state (starting|running), not the field's presence", () => {
    const boxes = [
      jobbed("grok-box-001", boxJob({ state: "running" })),
      jobbed("grok-box-002", boxJob({ state: "starting" })),
      jobbed("grok-box-003", boxJob({ state: "done" })), // terminal ⇒ not counted
      box("grok-box-004"),
    ];
    expect(jobCount(boxes)).toBe(2);
  });

  // MUTANT: `jobs=` counts every box with a non-null job field regardless of
  // state, so a fleet of only terminal jobs prints `▶ 0` / `▶ 1` wrongly.
  test("a fleet of only terminal jobs counts zero and the counter is suppressed", () => {
    const s = state({ boxes: [jobbed("grok-box-001", boxJob({ state: "done" }))] });
    expect(jobCount(s.boxes)).toBe(0);
    expect(headerText(s, SIZE_120x40)).not.toContain(GLYPH.job);
  });

  test("zero-suppressed: nothing renders when n is 0 (V3)", () => {
    const s = state({ boxes: [box("grok-box-001")] });
    expect(headerText(s, SIZE_120x40)).not.toContain(GLYPH.job);
  });

  test("long form `▶ 2 jobs` at >=120, short form `▶ 2` below", () => {
    const boxes = [
      jobbed("grok-box-001", boxJob({ state: "running" })),
      jobbed("grok-box-002", boxJob({ state: "starting" })),
    ];
    const s = state({ boxes });
    expect(headerText(s, SIZE_120x40)).toContain(`${GLYPH.job} 2 jobs`);
    const short = headerText(s, SIZE_100x40);
    expect(short).toContain(`${GLYPH.job} 2`);
    expect(short).not.toContain(`${GLYPH.job} 2 jobs`);
  });

  // MUTANT: the counter renders its long form below 120 columns, truncating the
  // bar so it no longer ends in `link ● up`. Two-digit n, leased present, 100c.
  // The left side matches the `occupancy-100x40` fixture exactly (11 boxes,
  // `● 7 ◆ 1 ✖ 1 ☾ 2 · free 4 · ⚑ 3`) so the arithmetic is the blueprint's:
  // that bar uses 93 columns, and the SHORT counter ` · ▶ 11` (7 for a two-digit
  // n) lands the row at exactly 100 with `link ● up` still on it. The LONG form
  // ` · ▶ 11 jobs` (+5) would push `up` off the right edge.
  test("at 100 cols with leased and a two-digit jobs count the bar still ends in `link ● up`", () => {
    const lease = () => ({
      lease_id: "L",
      state: "active" as const,
      holder: "ci",
      purpose: "p",
      kind: "ephemeral" as const,
      expires_at: null,
      grace_ends_at: null,
    });
    // Occupancy fixture distribution, with a running job on every box so the
    // count is two-digit; the job field does not move any health/free/leased
    // count, so the left side is byte-identical to `occupancy-100x40`.
    const jr = boxJob({ state: "running" });
    const boxes: FleetBox[] = [
      { ...jobbed("grok-box-001", jr), lease: lease() },
      jobbed("grok-box-002", jr),
      jobbed("grok-box-003", jr, { drift: "unknown", config: "in-sync" }),
      jobbed("grok-box-004", jr, { expiry_days: -365 }),
      jobbed("grok-box-005", jr, { asleep: true }),
      jobbed("grok-box-006", jr, { tunnel: "down", check: "FAIL" }),
      { ...jobbed("grok-box-007", jr), lease: lease() },
      { ...jobbed("grok-box-008", jr), lease: lease() },
      jobbed("grok-box-009", jr),
      jobbed("grok-box-010", jr, { asleep: true }),
      jobbed("grok-box-011", jr, { drift: "yes" }),
    ];
    const s = state({ boxes });
    expect(jobCount(boxes)).toBe(11); // two-digit
    const bar = headerText(s, SIZE_100x40);
    expect(bar).toContain(`link ${GLYPH.healthy} up`);
    expect(bar).toContain(`${GLYPH.job} 11`);
    expect(bar).not.toContain(`${GLYPH.job} 11 jobs`); // short form at 100
  });
});

// --- D2: the B jobs view (reducer) ------------------------------------------
describe("D2 — the `B` jobs view (reducer)", () => {
  test("`B` opens a FLEET-WIDE view whose captured box is the empty string", () => {
    const { state: next, effect } = handleKey(state({ boxes: [box("a")] }), "B");
    expect(next.view).toEqual({ kind: "jobs", box: "", offset: 0, loading: true });
    expect(effect).toEqual({ type: "load-view", kind: "jobs", box: "" });
  });

  // MUTANT: `B` bound to lowercase `b`.
  test("lowercase `b` does NOTHING", () => {
    const { state: next, effect } = handleKey(state({ boxes: [box("a")] }), "b");
    expect(next.view).toBeUndefined();
    expect(effect).toEqual({ type: "none" });
  });

  test("`J` still opens journal, not jobs", () => {
    const { state: next, effect } = handleKey(state({ boxes: [box("a")] }), "J");
    expect(next.view?.kind).toBe("journal");
    expect(effect).toEqual({ type: "load-view", kind: "journal", box: "a" });
  });

  test("the title is `── jobs ──`, with no box and no double space", () => {
    const s = state({ view: { kind: "jobs", box: "", offset: 0, loading: false, lines: ["x"] } });
    expect(viewLines(s, SIZE_120x40)[0]!.text).toStartWith("── jobs ──  rows 1–1 of 1");
  });

  test("`Esc` and `q` close the view back to the table", () => {
    const open = handleKey(state({ boxes: [box("a")] }), "B").state;
    expect(handleKey(open, "\x1b").state.view).toBeUndefined();
    expect(handleKey(open, "q").state.view).toBeUndefined();
  });
});

// --- D2: jobRows (sort, columns, cap) ---------------------------------------
describe("D2 — jobRows", () => {
  const jobs: Job[] = [
    job({ job_id: "DONEJOB0000000000000A", box: "grok-box-004", state: "done", rc: 0, created_at: "2026-04-30T22:00:00Z" }),
    job({ job_id: "RUNJOB00000000000000B", box: "grok-box-001", state: "running", created_at: "2026-04-30T23:48:00Z" }),
    job({ job_id: "STARTJOB000000000000C", box: "grok-box-002", state: "starting", created_at: "2026-04-30T23:59:00Z" }),
  ];

  test("the header row names the seven columns in order", () => {
    expect(jobRows(jobs, NOW)[0]).toStartWith("JOB_ID       BOX           KIND    STATE     RC   AGE    PURPOSE");
  });

  // MUTANT: jobs view sorted by created_at only (running/starting not first).
  test("starting|running sort FIRST, then created_at desc", () => {
    const ids = jobRows(jobs, NOW).slice(1).map((r) => r.slice(0, 12).trim());
    // starting(newest) + running come before the done row even though done is
    // not the oldest by created_at within its rank.
    expect(ids).toEqual(["STARTJOB0000", "RUNJOB000000", "DONEJOB00000"]);
  });

  test("JOB_ID shows the first 12 chars; RC is `-` when null and the number otherwise", () => {
    const rows = jobRows([job({ job_id: "ABCDEFGHIJKLMNOPQRSTUV", rc: null }), job({ job_id: "ZZZ", rc: 143, state: "failed", created_at: "2026-04-30T21:00:00Z" })], NOW);
    expect(rows[1]!.slice(0, 12)).toBe("ABCDEFGHIJKL");
    // RC column: id(13)+box(14)+kind(8)+state(10) = 45.
    expect(rows.find((r) => r.startsWith("ABCDEFGHIJKL"))!.slice(45, 50).trim()).toBe("-");
    expect(rows.find((r) => r.startsWith("ZZZ"))!.slice(45, 50).trim()).toBe("143");
  });

  test("AGE reads started_at ?? created_at; a long purpose is cut to `…`", () => {
    const rows = jobRows([job({ started_at: null, created_at: "2026-04-30T23:48:00Z", purpose: "a purpose long enough to be cut off" })], NOW);
    expect(rows[1]).toContain("12m");
    expect(rows[1]).toContain("…");
  });

  test("exactly 200 rows appends the cap note; fewer does not", () => {
    const many = Array.from({ length: 200 }, (_, i) => job({ job_id: `J${i}`, created_at: "2026-04-30T22:00:00Z" }));
    const rows = jobRows(many, NOW);
    expect(rows[rows.length - 1]).toBe("(newest 200 shown)");
    const fewer = jobRows(many.slice(0, 199), NOW);
    expect(fewer[fewer.length - 1]).not.toBe("(newest 200 shown)");
  });
});

// --- D2: the on-demand fetch (mounted app) ----------------------------------
describe("D2 — the jobs fetch", () => {
  test("`B` fetches GET /v1/jobs with no filter and renders the rows", async () => {
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ jobs: [job()] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = makeApiClient("http://h", "TOK", fetch);
    const m = mount(state({ boxes: [box("grok-box-001")] }), { client: silentClient({ listJobs: client.listJobs }) });
    await settle(40);
    await m.press("B");
    await settle(40);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toEndWith("/v1/jobs");
    expect(urls[0]).not.toContain("state=");
    expect(m.lastFrame()).toContain("── jobs ──");
    m.unmount();
  });

  test("`r` refetches the open jobs view", async () => {
    let calls = 0;
    const fetch: FetchLike = async () => {
      calls++;
      return new Response(JSON.stringify({ jobs: [job()] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = makeApiClient("http://h", "TOK", fetch);
    const m = mount(state({ boxes: [box("grok-box-001")] }), { client: silentClient({ listJobs: client.listJobs }) });
    await settle(40);
    await m.press("B");
    await settle(40);
    await m.press("r");
    await settle(40);
    expect(calls).toBe(2);
    m.unmount();
  });

  test("an empty list is an ANSWER (`no jobs`)", async () => {
    const ok: FetchLike = async () =>
      new Response(JSON.stringify({ jobs: [] }), { status: 200, headers: { "content-type": "application/json" } });
    const empty = makeApiClient("http://h", "TOK", ok);
    const m = mount(state({ boxes: [box("grok-box-001")] }), { client: silentClient({ listJobs: empty.listJobs }) });
    await settle(40);
    await m.press("B");
    await settle(40);
    expect(m.lastFrame()).toContain(NO_JOBS);
    m.unmount();
  });

  test("LINK DOWN / 5xx renders the view's error line, never a throw", async () => {
    const bad: FetchLike = async () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    const failing = makeApiClient("http://h", "TOK", bad);
    const m = mount(state({ boxes: [box("grok-box-001")] }), { client: silentClient({ listJobs: failing.listJobs }) });
    await settle(40);
    await m.press("B");
    await settle(40);
    expect(m.lastFrame()).toContain("link error");
    m.unmount();
  });
});
