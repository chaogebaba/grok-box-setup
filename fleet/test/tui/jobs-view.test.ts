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
  NO_JOB_LOG,
  headerText,
  jobCell,
  jobCount,
  jobRows,
  modalLines,
  showCondColumn,
  showJobColumn,
  sortJobs,
  tableLines,
  viewLines,
  viewRowsAvailable,
} from "../../src/tui/model.ts";
import { applyViewResult, handleKey, type ViewState } from "../../src/tui/state.ts";
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

  // MUTANT: showCondColumn hard-codes 66 for condStart instead of deriving it
  // from TABLE_HEADER_COLS. Below 110 the JOB column is off, so condStart is 57,
  // not 66; a hard-coded 66 would omit COND at 65..73 columns where the derived
  // 57 keeps it (65−57=8 ≥ 8, but 65−66 < 0). These widths pin the derivation.
  test("condStart is derived (57 with JOB off): COND shown at 65..73, not omitted", () => {
    for (const cols of [65, 70, 73]) {
      expect(showJobColumn({ cols, rows: 40 })).toBe(false); // JOB off ⇒ condStart 57
      expect(showCondColumn({ cols, rows: 40 })).toBe(true); // hard-coded-66 would be false
    }
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

// =============================================================================
// 5.14.1 — the jobs view becomes actionable: a cursor, `Enter`, `s`.
// =============================================================================

/** Four jobs whose SORTED order is deterministic and not their input order:
 *  two live (starting newest, then running) ahead of two terminal ones. */
const FOUR: Job[] = [
  job({ job_id: "DONEJOB0000000000000A", box: "grok-box-004", state: "done", rc: 0, created_at: "2026-04-30T22:00:00Z" }),
  job({ job_id: "RUNJOB00000000000000B", box: "grok-box-001", state: "running", created_at: "2026-04-30T23:48:00Z" }),
  job({ job_id: "FAILJOB0000000000000D", box: "grok-box-007", state: "failed", rc: 1, created_at: "2026-04-30T21:00:00Z" }),
  job({ job_id: "STARTJOB000000000000C", box: "grok-box-002", state: "starting", created_at: "2026-04-30T23:59:00Z" }),
];

/** The jobs view as it stands once a result has landed. */
function jobsView(over: Partial<ViewState> = {}): ViewState {
  const jobs = sortJobs(FOUR);
  return { kind: "jobs", box: "", offset: 0, loading: false, lines: jobRows(FOUR, NOW), jobs, cursor: 0, ...over };
}

const openJobs = (over: Partial<ViewState> = {}, s: Partial<Parameters<typeof state>[0]> = {}) =>
  state({ boxes: [box("grok-box-001")], view: jobsView(over), ...s });

describe("5.14.1 D1 — sortJobs is the ONE ordering", () => {
  // MUTANT 1: `sortJobs` sorts but the captured `jobs` are stored unsorted, so
  // `Enter` opens the wrong job. The two must agree row for row.
  test("sortJobs order equals jobRows order, id column for id column", () => {
    const rowIds = jobRows(FOUR, NOW).slice(1).map((r) => r.slice(0, 12).trim());
    const sortedIds = sortJobs(FOUR).map((j) => j.job_id.slice(0, 12));
    expect(rowIds).toEqual(sortedIds);
    expect(sortedIds).toEqual(["STARTJOB0000", "RUNJOB000000", "DONEJOB00000", "FAILJOB00000"]);
  });

  test("sortJobs does not mutate its input", () => {
    const input = [...FOUR];
    sortJobs(input);
    expect(input.map((j) => j.job_id)).toEqual(FOUR.map((j) => j.job_id));
  });
});

describe("5.14.1 D1 — the cursor's lifecycle", () => {
  test("`B` opens the view with NO cursor and no jobs (both arrive with the result)", () => {
    const { state: next } = handleKey(state({ boxes: [box("a")] }), "B");
    expect(next.view).toEqual({ kind: "jobs", box: "", offset: 0, loading: true });
    expect(next.view?.cursor).toBeUndefined();
    expect(next.view?.jobs).toBeUndefined();
  });

  test("the result sets cursor 0 and stores the SORTED jobs", () => {
    const opening = handleKey(state({ boxes: [box("a")] }), "B").state;
    const next = applyViewResult(opening, "jobs", "", { lines: jobRows(FOUR, NOW), jobs: sortJobs(FOUR) }, SIZE_120x40);
    expect(next.view?.cursor).toBe(0);
    expect(next.view?.jobs?.map((j) => j.job_id.slice(0, 8))).toEqual(["STARTJOB", "RUNJOB00", "DONEJOB0", "FAILJOB0"]);
    expect(next.view?.loading).toBe(false);
  });

  test("an EMPTY list leaves the cursor undefined", () => {
    const opening = handleKey(state({ boxes: [box("a")] }), "B").state;
    const next = applyViewResult(opening, "jobs", "", { lines: [NO_JOBS], jobs: [] }, SIZE_120x40);
    expect(next.view?.cursor).toBeUndefined();
  });

  // MUTANT 2: j/k move `offset` instead of `cursor`.
  test("j/k move the CURSOR and never the offset", () => {
    const s = openJobs();
    const down = handleKey(s, "j", SIZE_120x40).state;
    expect(down.view?.cursor).toBe(1);
    expect(down.view?.offset).toBe(0);
    const down2 = handleKey(down, "\x1b[B", SIZE_120x40).state;
    expect(down2.view?.cursor).toBe(2);
    expect(handleKey(down2, "k", SIZE_120x40).state.view?.cursor).toBe(1);
    expect(handleKey(down2, "\x1b[A", SIZE_120x40).state.view?.cursor).toBe(1);
    expect(down2.view?.offset).toBe(0);
  });

  // MUTANT 3: the cursor can reach the header line (clamp lower bound −1).
  test("k at the top clamps to 0 — the cursor can never reach the header line", () => {
    const s = openJobs({ cursor: 0 });
    expect(handleKey(s, "k", SIZE_120x40).state.view?.cursor).toBe(0);
    expect(handleKey(handleKey(s, "k", SIZE_120x40).state, "k", SIZE_120x40).state.view?.cursor).toBe(0);
  });

  test("j at the bottom clamps to the last row", () => {
    const s = openJobs({ cursor: 3 });
    expect(handleKey(s, "j", SIZE_120x40).state.view?.cursor).toBe(3);
  });

  test("j/k are INERT while loading, on an error and on an empty list", () => {
    const loading = openJobs({ loading: true, jobs: undefined, cursor: undefined });
    expect(handleKey(loading, "j", SIZE_120x40).state.view?.cursor).toBeUndefined();
    const errored = openJobs({ jobs: undefined, cursor: undefined, error: "link error" });
    expect(handleKey(errored, "j", SIZE_120x40).state.view?.cursor).toBeUndefined();
    const empty = openJobs({ jobs: [], cursor: undefined, lines: [NO_JOBS] });
    expect(handleKey(empty, "j", SIZE_120x40).state.view?.cursor).toBeUndefined();
  });

  // MUTANT 5: `applyViewResult` resets the cursor to 0 after a reload.
  test("a reload PRESERVES the cursor, and clamps it when the list shrank", () => {
    const s = openJobs({ cursor: 3 });
    const same = applyViewResult(s, "jobs", "", { lines: jobRows(FOUR, NOW), jobs: sortJobs(FOUR) }, SIZE_120x40);
    expect(same.view?.cursor).toBe(3);
    const shrunk = sortJobs(FOUR).slice(0, 2);
    const fewer = applyViewResult(s, "jobs", "", { lines: jobRows(shrunk, NOW), jobs: shrunk }, SIZE_120x40);
    expect(fewer.view?.cursor).toBe(1);
  });
});

describe("5.14.1 D1 — the painted window follows the cursor", () => {
  test("line 0 (the column header) is NEVER selected", () => {
    const painted = viewLines(openJobs({ cursor: 0 }), SIZE_120x40);
    expect(painted[0]!.selected).toBeUndefined(); // the title
    expect(painted[1]!.selected).toBeUndefined(); // the column header
    expect(painted[2]!.selected).toBe(true); // jobs[0]
  });

  // MUTANT 4: the window does not follow the cursor (offset stays 0), so a
  // cursor past the bottom of the window is painted nowhere at all.
  test("cursor 30 of 40 rows at 12 available rows ⇒ the selected line is the LAST painted one", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      job({ job_id: `J${String(i).padStart(4, "0")}00000000000000`, state: "done", created_at: `2026-04-30T${String(23 - (i % 24)).padStart(2, "0")}:00:00Z` }),
    );
    const sorted = sortJobs(many);
    const size = { cols: 120, rows: 18 };
    const s = state({
      boxes: [box("grok-box-001")],
      view: { kind: "jobs", box: "", offset: 0, loading: false, lines: jobRows(many, NOW), jobs: sorted, cursor: 30 },
    });
    expect(viewRowsAvailable(s, size)).toBe(12);
    const painted = viewLines(s, size);
    const content = painted.slice(1); // drop the title
    expect(content).toHaveLength(12);
    expect(content[content.length - 1]!.selected).toBe(true);
    // helpers.state is NO_COLOR, so the selected row carries the `>` marker.
    expect(content[content.length - 1]!.text).toStartWith(`>${sorted[30]!.job_id.slice(0, 12)}`);
    // and nothing above it is selected.
    expect(content.slice(0, -1).some((l) => l.selected === true)).toBe(false);
  });

  test("under NO_COLOR the selected row is PREPENDED with `>`, never overwritten", () => {
    const s = openJobs({ cursor: 1 }); // helpers.state is NO_COLOR
    const painted = viewLines(s, SIZE_120x40);
    const sel = painted.find((l) => l.selected === true)!;
    expect(sel.text).toStartWith(">RUNJOB000000");
    expect(sel.text.length).toBeLessThanOrEqual(SIZE_120x40.cols);
  });

  test("with colour ON the row carries no marker; the selection is a flag", () => {
    const s = openJobs({ cursor: 1 }, { noColor: false });
    const sel = viewLines(s, SIZE_120x40).find((l) => l.selected === true)!;
    expect(sel.text).toStartWith("RUNJOB000000");
    expect(sel.bold).toBe(true);
  });

  test("loading / error / empty have no cursor and paint the plain window", () => {
    for (const over of [{ loading: true, jobs: undefined, cursor: undefined }, { jobs: undefined, cursor: undefined, error: "link error" }, { jobs: [], cursor: undefined, lines: [NO_JOBS] }]) {
      const painted = viewLines(openJobs(over as Partial<ViewState>), SIZE_120x40);
      expect(painted.some((l) => l.selected === true)).toBe(false);
      expect(painted.length).toBeGreaterThan(1);
    }
  });
});

describe("5.14.1 D2 — `Enter` opens the joblog", () => {
  test("Enter with a cursor opens `joblog` on the job id, with a COPY of the list as parent", () => {
    const s = openJobs({ cursor: 2 });
    const { state: next, effect } = handleKey(s, "\r", SIZE_120x40);
    expect(next.view?.kind).toBe("joblog");
    expect(next.view?.box).toBe("DONEJOB0000000000000A");
    expect(effect).toEqual({ type: "load-view", kind: "joblog", box: "DONEJOB0000000000000A" });
    // MUTANT 6: `parent` is a REFERENCE to the live view, not a copy.
    expect(next.view?.parent).toEqual(s.view!);
    expect(next.view?.parent).not.toBe(s.view!);
  });

  test("`\\n` opens it too", () => {
    expect(handleKey(openJobs({ cursor: 1 }), "\n", SIZE_120x40).state.view?.kind).toBe("joblog");
  });

  test("Enter is INERT without a cursor (empty list, error)", () => {
    for (const over of [{ jobs: [], cursor: undefined, lines: [NO_JOBS] }, { jobs: undefined, cursor: undefined, error: "link error" }]) {
      const { state: next, effect } = handleKey(openJobs(over as Partial<ViewState>), "\r", SIZE_120x40);
      expect(next.view?.kind).toBe("jobs");
      expect(effect).toEqual({ type: "none" });
    }
  });

  // MUTANT 19: the `v.loading` guard is dropped, so a mid-reload Enter captures
  // a `loading: true` parent, the in-flight result is swallowed by the kind
  // guard, and `Esc` returns to a list stuck on `(loading…)`.
  test("Enter is INERT while the list is reloading, even though the cursor is still set", () => {
    const reloading = openJobs({ loading: true, cursor: 2 });
    expect(reloading.view?.cursor).toBe(2); // the cursor survives `r` — that is D1
    const { state: next, effect } = handleKey(reloading, "\r", SIZE_120x40);
    expect(next.view?.kind).toBe("jobs");
    expect(effect).toEqual({ type: "none" });
    // … and the reload's result then lands normally and clears `loading`.
    const landed = applyViewResult(next, "jobs", "", { lines: jobRows(FOUR, NOW), jobs: sortJobs(FOUR) }, SIZE_120x40);
    expect(landed.view?.loading).toBe(false);
    expect(landed.view?.cursor).toBe(2);
  });

  // MUTANT 7: `Esc` in the joblog sets `view: undefined` and drops the list.
  test("`Esc`/`q` in the joblog restores the parent list, cursor and jobs intact, with NO effect", () => {
    const opened = handleKey(openJobs({ cursor: 2 }), "\r", SIZE_120x40).state;
    for (const key of ["\x1b", "q"]) {
      const { state: back, effect } = handleKey(opened, key, SIZE_120x40);
      expect(back.view?.kind).toBe("jobs");
      expect(back.view?.cursor).toBe(2);
      expect(back.view?.jobs).toHaveLength(4);
      expect(effect).toEqual({ type: "none" });
    }
  });

  test("`Esc` in the LIST still returns to the table", () => {
    expect(handleKey(openJobs(), "\x1b", SIZE_120x40).state.view).toBeUndefined();
  });

  test("the joblog title names the job's first 12 characters", () => {
    const s = state({ view: { kind: "joblog", box: "DONEJOB0000000000000A", offset: 0, loading: false, lines: ["x"] } });
    expect(viewLines(s, SIZE_120x40)[0]!.text).toStartWith("── job DONEJOB00000 ──  rows 1–1 of 1");
  });

  // MUTANT 10: the joblog opens at offset 0 instead of bottom-anchored.
  test("`applyViewResult` for joblog BOTTOM-ANCHORS the offset", () => {
    const opened = handleKey(openJobs({ cursor: 2 }), "\r", SIZE_120x40).state;
    const lines = Array.from({ length: 100 }, (_, i) => `log line ${i}`);
    const size = { cols: 120, rows: 18 };
    const landed = applyViewResult(opened, "joblog", "DONEJOB0000000000000A", { lines }, size);
    const rows = viewRowsAvailable(landed, size);
    expect(landed.view?.offset).toBe(100 - rows);
    expect(viewLines(landed, size).at(-1)!.text).toStartWith("log line 99");
  });

  test("a short log stays at offset 0, and an empty one is `(empty log)`", () => {
    const opened = handleKey(openJobs({ cursor: 2 }), "\r", SIZE_120x40).state;
    const short = applyViewResult(opened, "joblog", "DONEJOB0000000000000A", { lines: ["one", "two"] }, SIZE_120x40);
    expect(short.view?.offset).toBe(0);
    const empty = applyViewResult(opened, "joblog", "DONEJOB0000000000000A", { lines: [NO_JOB_LOG] }, SIZE_120x40);
    expect(viewLines(empty, SIZE_120x40)[1]!.text).toStartWith(NO_JOB_LOG);
  });

  test("the joblog is scroll-only: j/k move the offset, and it has no cursor", () => {
    const opened = handleKey(openJobs({ cursor: 2 }), "\r", SIZE_120x40).state;
    const lines = Array.from({ length: 100 }, (_, i) => `log line ${i}`);
    const landed = applyViewResult(opened, "joblog", "DONEJOB0000000000000A", { lines }, SIZE_120x40);
    const up = handleKey(landed, "k", SIZE_120x40).state;
    expect(up.view?.offset).toBe(landed.view!.offset - 1);
    expect(up.view?.cursor).toBeUndefined();
  });
});

describe("5.14.1 D3 — `s` stops the selected job", () => {
  // MUTANT 11: `s` under readonly opens the modal.
  test("readonly ⇒ the admin sentence and NO modal", () => {
    const s = openJobs({ cursor: 1 }, { scope: "readonly" });
    const { state: next, effect } = handleKey(s, "s", SIZE_120x40);
    expect(next.message).toBe("admin token required for that action");
    expect(next.modal).toBeUndefined();
    expect(effect).toEqual({ type: "none" });
  });

  // MUTANT 12: `s` on a terminal row opens the modal.
  test("a TERMINAL row ⇒ `job already finished` and no modal", () => {
    for (const cursor of [2, 3]) {
      const { state: next } = handleKey(openJobs({ cursor }), "s", SIZE_120x40);
      expect(next.message).toBe("job already finished");
      expect(next.modal).toBeUndefined();
    }
  });

  // MUTANT 13: `expect` is the box name or the full id.
  test("a running row opens a `stop-job` modal expecting the id's FIRST 6 characters", () => {
    const { state: next } = handleKey(openJobs({ cursor: 1 }), "s", SIZE_120x40);
    expect(next.modal).toEqual({
      kind: "stop-job",
      jobId: "RUNJOB00000000000000B",
      actionLabel: "stop job",
      box: "",
      typed: "",
      field: "confirm",
      expect: "RUNJOB",
    });
  });

  test("a `starting` row opens the modal too", () => {
    expect(handleKey(openJobs({ cursor: 0 }), "s", SIZE_120x40).state.modal?.kind).toBe("stop-job");
  });

  test("no cursor ⇒ `s` is inert under admin", () => {
    const { state: next, effect } = handleKey(openJobs({ jobs: [], cursor: undefined, lines: [NO_JOBS] }), "s", SIZE_120x40);
    expect(next.modal).toBeUndefined();
    expect(next.message).toBeUndefined();
    expect(effect).toEqual({ type: "none" });
  });

  test("a MISMATCHED confirm keeps the modal open and sets the message", () => {
    const withModal = handleKey(openJobs({ cursor: 1 }), "s", SIZE_120x40).state;
    let typed = withModal;
    for (const ch of "WRONGX") typed = handleKey(typed, ch, SIZE_120x40).state;
    const { state: next, effect } = handleKey(typed, "\r", SIZE_120x40);
    expect(next.modal).toBeDefined();
    expect(next.message).toBe('confirm mismatch (expected "RUNJOB")');
    expect(effect).toEqual({ type: "none" });
  });

  // MUTANT 14: the Enter arm falls through to `specKeyFromLabel`, which has no
  // entry for "stop job" — `actionForKey("")!` is undefined and it throws.
  test("a MATCHING confirm emits `stop-job` with the job id and closes the modal", () => {
    const withModal = handleKey(openJobs({ cursor: 1 }), "s", SIZE_120x40).state;
    let typed = withModal;
    for (const ch of "RUNJOB") typed = handleKey(typed, ch, SIZE_120x40).state;
    const { state: next, effect } = handleKey(typed, "\r", SIZE_120x40);
    expect(next.modal).toBeUndefined();
    expect(next.message).toBe("stopping RUNJOB000000…");
    expect(effect).toEqual({ type: "stop-job", jobId: "RUNJOB00000000000000B" });
  });

  test("`Esc` cancels the modal and leaves the view untouched", () => {
    const withModal = handleKey(openJobs({ cursor: 1 }), "s", SIZE_120x40).state;
    const { state: next, effect } = handleKey(withModal, "\x1b", SIZE_120x40);
    expect(next.modal).toBeUndefined();
    expect(next.message).toBe("cancelled");
    expect(next.view?.kind).toBe("jobs");
    expect(next.view?.cursor).toBe(1);
    expect(effect).toEqual({ type: "none" });
  });

  test("Tab is inert for the single-field stop modal", () => {
    const withModal = handleKey(openJobs({ cursor: 1 }), "s", SIZE_120x40).state;
    expect(handleKey(withModal, "\t", SIZE_120x40).state.modal).toEqual(withModal.modal!);
  });

  test("the stop modal's lines name the JOB, not a box", () => {
    const withModal = handleKey(openJobs({ cursor: 1 }), "s", SIZE_120x40).state;
    const text = modalLines(withModal).map((l) => l.text);
    expect(text[0]).toBe("┌─ stop job RUNJOB000000 ─┐");
    expect(text[1]).toBe("type the first 6 characters of the job id to confirm: _");
    expect(text[2]).toBe('(expect "RUNJOB")   Enter=confirm  Esc=cancel');
  });
});

// --- 5.14.1 D2/D3: the effect runner (mounted) -------------------------------
describe("5.14.1 D2 — the joblog fetch", () => {
  /** A client that records the call ORDER and the arguments of each. */
  function recordingClient(logBytes: number, text = "a\nb\n") {
    const calls: string[] = [];
    const args: { offset?: number; limit?: number } = {};
    return {
      calls,
      args,
      client: silentClient({
        listJobs: async () => ({ ok: true as const, value: [job({ job_id: "JOBID000000000000000A" })] }),
        getJob: async () => {
          calls.push("getJob");
          return { ok: true as const, value: job({ job_id: "JOBID000000000000000A", log_bytes: logBytes }) };
        },
        jobLog: async (_id: string, offset: number, limit?: number) => {
          calls.push("jobLog");
          args.offset = offset;
          args.limit = limit;
          return { ok: true as const, value: { text, next: offset + text.length, truncated: false } };
        },
      }),
    };
  }

  async function openLog(logBytes: number, text?: string) {
    const r = recordingClient(logBytes, text);
    const m = mount(state({ boxes: [box("grok-box-001")] }), { client: r.client });
    await settle(40);
    await m.press("B");
    await settle(40);
    await m.press("\r");
    await settle(40);
    return { ...r, m };
  }

  // MUTANT 8: `jobLog` is called with offset 0 (no tail).
  test("getJob runs FIRST, then jobLog at `max(0, log_bytes − 65536)` with the 64 KiB limit", async () => {
    const small = await openLog(10_000);
    expect(small.calls).toEqual(["getJob", "jobLog"]);
    expect(small.args.offset).toBe(0);
    expect(small.args.limit).toBe(65_536);
    small.m.unmount();

    const big = await openLog(100_000);
    expect(big.calls).toEqual(["getJob", "jobLog"]);
    expect(big.args.offset).toBe(34_464);
    big.m.unmount();
  });

  // MUTANT 1: `sortJobs` is applied to the ROWS but the captured `jobs` are
  // stored in the server's order, so the cursor's index picks a different job
  // than the row under it and `Enter` opens the WRONG log.
  test("the stored jobs are the SORTED ones, so the cursor's row and its job agree", async () => {
    const opened: string[] = [];
    const client = silentClient({
      listJobs: async () => ({ ok: true as const, value: FOUR }),
      getJob: async (id: string) => {
        opened.push(id);
        return { ok: true as const, value: job({ job_id: id, log_bytes: 4 }) };
      },
      jobLog: async (_id: string, offset: number) => ({ ok: true as const, value: { text: "x\n", next: offset + 2, truncated: false } }),
    });
    const m = mount(state({ boxes: [box("grok-box-001")] }), { client });
    await settle(40);
    await m.press("B");
    await settle(40);
    // cursor 0 is the FIRST SORTED row — the newest `starting` job — not the
    // first row the server happened to return (`DONEJOB…`).
    expect(m.lastFrame()).toContain("STARTJOB0000");
    await m.press("\r");
    await settle(40);
    expect(opened).toEqual(["STARTJOB000000000000C"]);
    expect(m.lastFrame()).toContain("── job STARTJOB0000 ──");
    m.unmount();
  });

  test("the joblog frame shows the job title and the log body", async () => {
    const r = await openLog(10_000, "first line\nsecond line\n");
    expect(r.m.lastFrame()).toContain("── job JOBID0000000 ──");
    expect(r.m.lastFrame()).toContain("second line");
    r.m.unmount();
  });

  test("a tailed log carries the `showing the last 64 KiB` header line", async () => {
    const r = await openLog(100_000, "tail\n");
    expect(r.m.lastFrame()).toContain("(showing the last 64 KiB of 100000 bytes)");
    r.m.unmount();
  });

  test("an EMPTY log is the answer `(empty log)`", async () => {
    const r = await openLog(0, "");
    expect(r.m.lastFrame()).toContain(NO_JOB_LOG);
    r.m.unmount();
  });

  test("a failed getJob renders the view's error line, never a throw", async () => {
    const client = silentClient({
      listJobs: async () => ({ ok: true as const, value: [job()] }),
      getJob: async () => ({ ok: false as const, kind: "link_down" as const, message: "link down" }),
    });
    const m = mount(state({ boxes: [box("grok-box-001")] }), { client });
    await settle(40);
    await m.press("B");
    await settle(40);
    await m.press("\r");
    await settle(40);
    expect(m.lastFrame()).toContain("link error");
    m.unmount();
  });
});

describe("5.14.1 D3 — the `stop-job` effect runner", () => {
  // MUTANT 15: the arm calls `poll()` instead of re-fetching the jobs view, so
  // the fleet table the operator is NOT looking at is refreshed and the open
  // list stays stale.
  test("stopJob(id) → action-done → the jobs list re-fetched, and `poll` never called", async () => {
    let fleetCalls = 0;
    let listCalls = 0;
    const stopped: string[] = [];
    const client = silentClient({
      fleet: async () => {
        fleetCalls++;
        return { ok: false as const, kind: "link_down" as const, message: "link down" };
      },
      listJobs: async () => {
        listCalls++;
        return { ok: true as const, value: [job({ job_id: "JOBID000000000000000A" })] };
      },
      stopJob: async (id: string) => {
        stopped.push(id);
        return { ok: true as const, value: job({ job_id: id, state: "stopped" }) };
      },
    });
    const m = mount(state({ boxes: [box("grok-box-001")] }), { client });
    await settle(40);
    await m.press("B");
    await settle(40);
    expect(listCalls).toBe(1);
    const fleetBefore = fleetCalls;

    await m.press("s");
    for (const ch of "JOBID0") await m.press(ch);
    await m.press("\r");
    await settle(60);

    expect(stopped).toEqual(["JOBID000000000000000A"]);
    expect(listCalls).toBe(2); // the LIST was re-fetched …
    expect(fleetCalls).toBe(fleetBefore); // … and the fleet table was not.
    expect(m.lastFrame()).toContain("stopped JOBID0000000");
    m.unmount();
  });

  test("a failed stop reports the client's error text and still leaves the list open", async () => {
    const client = silentClient({
      fleet: async () => ({ ok: false as const, kind: "link_down" as const, message: "link down" }),
      listJobs: async () => ({ ok: true as const, value: [job({ job_id: "JOBID000000000000000A" })] }),
      stopJob: async () => ({ ok: false as const, kind: "error" as const, status: 409, message: "job already terminal" }),
    });
    const m = mount(state({ boxes: [box("grok-box-001")] }), { client });
    await settle(40);
    await m.press("B");
    await settle(40);
    await m.press("s");
    for (const ch of "JOBID0") await m.press(ch);
    await m.press("\r");
    await settle(60);
    expect(m.lastFrame()).toContain("job already terminal");
    expect(m.lastFrame()).toContain("── jobs ──");
    m.unmount();
  });

  // MUTANT 16: the modal is opened under the view but never PAINTED.
  test("the stop modal is painted UNDER the open list, with the list still on screen", async () => {
    const client = silentClient({
      fleet: async () => ({ ok: false as const, kind: "link_down" as const, message: "link down" }),
      listJobs: async () => ({ ok: true as const, value: [job({ job_id: "JOBID000000000000000A" })] }),
    });
    const m = mount(state({ boxes: [box("grok-box-001")] }), { client });
    await settle(40);
    await m.press("B");
    await settle(40);
    await m.press("s");
    await settle(20);
    const frame = m.lastFrame();
    expect(frame).toContain("── jobs ──");
    expect(frame).toContain("┌─ stop job JOBID0000000 ─┐");
    expect(frame).toContain("type the first 6 characters of the job id to confirm:");
    m.unmount();
  });
});

describe("5.14.1 D2 — the joblog's ONE header line", () => {
  async function openWith(logBytes: number, truncated: boolean) {
    const client = silentClient({
      listJobs: async () => ({ ok: true as const, value: [job({ job_id: "JOBID000000000000000A" })] }),
      getJob: async () => ({ ok: true as const, value: job({ job_id: "JOBID000000000000000A", log_bytes: logBytes }) }),
      jobLog: async (_id: string, offset: number) => ({ ok: true as const, value: { text: "body\n", next: offset + 5, truncated } }),
    });
    const m = mount(state({ boxes: [box("grok-box-001")] }), { client });
    await settle(40);
    await m.press("B");
    await settle(40);
    await m.press("\r");
    await settle(40);
    return m;
  }

  test("the brain's truncation wins, and NEVER both lines at once", async () => {
    const m = await openWith(100_000, true);
    const frame = m.lastFrame();
    expect(frame).toContain("(log truncated on the brain; showing the last 64 KiB of 100000 bytes)");
    expect(frame).not.toContain("(showing the last 64 KiB of 100000 bytes)\n(log truncated");
    // exactly one header line on screen.
    expect(frame.split("\n").filter((l) => l.includes("showing the last 64 KiB"))).toHaveLength(1);
    m.unmount();
  });

  test("a whole log that was NOT truncated carries no header line at all", async () => {
    const m = await openWith(5, false);
    expect(m.lastFrame()).not.toContain("showing the last 64 KiB");
    expect(m.lastFrame()).toContain("body");
    m.unmount();
  });
});
