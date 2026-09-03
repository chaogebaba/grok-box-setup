// goldens.ts — the golden catalogue (fleet-tui-ink D5).
//
// ONE list, used by two things: the one-off script that rendered the
// hand-rolled `renderFrame` into `fixtures/*.txt` before render.ts was deleted,
// and the Ink frame tests that compare against those fixtures. Because both
// read the same states, a fixture can never drift away from the golden it
// belongs to.
//
// Each golden declares which of the DECLARED CHANGES (D5/D7) apply to it. A
// golden with no exception must match its fixture byte for byte after trailing
// whitespace is stripped.

import type { SnapshotBox, SnapshotLine } from "../../src/history/schema.ts";
import type { BoxLease, FleetBox, Lease } from "../../src/tui/api-client.ts";
import type { TuiState } from "../../src/tui/state.ts";
import type { Size } from "../../src/tui/model.ts";
import { leaseRows } from "../../src/tui/model.ts";
import { box, state } from "./helpers.ts";

/**
 * The declared behaviour changes, shared verbatim with D7's non-goals list:
 *
 *  - "table-window": the table paints a WINDOW of the fleet plus a
 *    `rows a–b of N` indicator. The hand-rolled painter emitted every row and
 *    let the terminal swallow the overflow.
 *  - "detail-omitted": the Detail pane is omitted when the row budget is
 *    smaller than its fixed height. The hand-rolled painter showed it at any
 *    row count once `cols >= 100`.
 *  - "detail-column": the Detail column starts at ONE column (`leftW +
 *    DETAIL_GAP`). The hand-rolled painter composed `padVisible(left, leftW) +
 *    "  " + right` per line, so its detail text started at a DIFFERENT column
 *    on every line whose left cell was not exactly `leftW` wide — see the
 *    measurements in the build report. On these goldens the fixture is compared
 *    against the model's own composition instead of against the frame.
 */
export type GoldenException = "table-window" | "detail-omitted" | "detail-column";

export interface Golden {
  name: string;
  size: Size;
  state: TuiState;
  exceptions: GoldenException[];
  /** For a golden whose fleet overflows the budget: the LITERAL window the
   *  frame must paint. Spelled out rather than computed, so an off-by-one in
   *  the window arithmetic cannot quietly move the expectation with it. */
  window?: { indicator: string; first: string; last: string };
}

const SIZE = (cols: number, rows: number): Size => ({ cols, rows });

/** A healthy three-box fleet. */
const THREE: SnapshotBox[] = [
  box("grok-box-001"),
  box("grok-box-002", { ver: "5.6.0", drift: "yes" }),
  box("grok-box-003", { tunnel: "down", check: "FAIL", expiry_days: 3 }),
];

/** Thirty boxes, enough to overflow any of the golden sizes. */
const THIRTY: SnapshotBox[] = Array.from({ length: 30 }, (_, i) => {
  const n = String(i + 1).padStart(3, "0");
  if (i % 7 === 3) return box(`grok-box-${n}`, { check: "FAIL", tunnel: "down" });
  if (i % 5 === 2) return box(`grok-box-${n}`, { drift: "yes" });
  if (i % 11 === 6) return box(`grok-box-${n}`, { asleep: true });
  return box(`grok-box-${n}`);
});

/** A 24h history for the sparkline. */
const HISTORY: SnapshotLine[] = Array.from({ length: 12 }, (_, i) => ({
  v: 1 as const,
  ts: `2026-04-30T${String(12 + i).padStart(2, "0")}:00:00Z`,
  apply: i % 2 === 0,
  canary: null,
  boxes: [box("grok-box-001", i === 4 ? { check: "FAIL" } : i === 7 ? { drift: "yes" } : {})],
}));

// --- occupancy (5.11.1) ------------------------------------------------------
// The golden clock, the one `helpers.state` pins.
const NOW = Date.parse("2026-05-01T00:00:10Z");

const lease = (over: Partial<BoxLease> = {}): BoxLease => ({
  lease_id: "LEASEID0000000000000A",
  state: "active",
  holder: "ci:runner-3",
  purpose: "gate",
  kind: "ephemeral",
  expires_at: "2026-05-01T01:12:00Z",
  grace_ends_at: null,
  ...over,
});

const leased = (b: SnapshotBox, l: BoxLease): FleetBox => ({ ...b, lease: l });

/**
 * Eleven boxes that exercise every occupancy rule in one frame: three open
 * leases in the three states (active / expired / lost), a 9+ character holder
 * that must be cut to 8 + `…`, two asleep boxes, a FAIL, a drifted box, a box
 * with `drift=unknown, config=in-sync` (the pair that used to read
 * `unknownin-sync`), and a NEGATIVE `expiry_days` — the widest value the EXPIRY
 * cell can hold.
 */
const ELEVEN: FleetBox[] = [
  leased(box("grok-box-001"), lease()),
  box("grok-box-002"),
  box("grok-box-003", { drift: "unknown", config: "in-sync" }),
  box("grok-box-004", { expiry_days: -365 }),
  box("grok-box-005", { asleep: true }),
  box("grok-box-006", { tunnel: "down", check: "FAIL" }),
  leased(box("grok-box-007"), lease({ state: "expired", holder: "svc:brain", expires_at: "2026-04-30T23:43:00Z", grace_ends_at: "2026-05-01T00:17:00Z" })),
  leased(box("grok-box-008"), lease({ state: "lost", holder: "dev", purpose: "debug a wedged rollout", grace_ends_at: "2026-05-01T00:17:00Z" })),
  box("grok-box-009"),
  box("grok-box-010", { asleep: true }),
  box("grok-box-011", { drift: "yes" }),
];

/** The D1 facts for `grok-box-001`, so the occupancy card shows the merged
 *  asleep line beside the two lease lines. */
const FACTS_001 = {
  box: "grok-box-001",
  facts: {
    name: "grok-box-001",
    checkfail_count: 0,
    asleep_since: null,
    asleep_last: "2026-04-30T22:10:00Z",
    expires_at: "2026-06-01",
    api_backoff: null,
    phase: "enrolled",
    observed: "healthy",
  },
};

const fullLease = (over: Partial<Lease> = {}): Lease => ({
  lease_id: "LEASEID0000000000000A",
  box: "grok-box-001",
  kind: "ephemeral",
  holder: "ci:runner-3",
  purpose: "gate",
  state: "active",
  created_at: "2026-04-30T23:38:00Z",
  expires_at: "2026-05-01T01:12:00Z",
  renewed_at: null,
  released_at: null,
  expired_at: null,
  lost_at: null,
  lost_reason: null,
  grace_ends_at: null,
  ...over,
});

/** The leases view's rows, frozen the way `app.tsx` freezes them at fetch. */
const LEASE_VIEW_LINES: string[] = leaseRows(
  [
    fullLease({ box: "grok-box-008", state: "lost", holder: "dev", purpose: "debug a wedged rollout that will not finish", grace_ends_at: "2026-05-01T00:17:00Z", lost_at: "2026-05-01T00:07:00Z", lost_reason: "asleep" }),
    fullLease(),
    fullLease({ box: "grok-box-007", state: "expired", holder: "svc:brain", kind: "service", purpose: "keep-awake", expires_at: "2026-04-30T23:43:00Z", grace_ends_at: "2026-05-01T00:17:00Z" }),
  ],
  NOW,
);

const DIFF_LINES = Array.from({ length: 200 }, (_, i) => `--- diff line ${i} for the config push`);
const JOURNAL_LINES_CONTENT = Array.from({ length: 200 }, (_, i) => `Apr 30 12:${String(i % 60).padStart(2, "0")}:00 box grok-agent[1]: line ${i}`);

export const GOLDENS: Golden[] = [
  // --- the table frame -------------------------------------------------------
  {
    name: "healthy-120x40",
    size: SIZE(120, 40),
    state: state({ boxes: THREE, selected: 0, detail: { box: "grok-box-001", lines: HISTORY } }),
    exceptions: ["detail-column"],
  },
  {
    name: "empty-fleet-120x40",
    size: SIZE(120, 40),
    state: state({ boxes: [], selected: 0 }),
    exceptions: [],
  },
  {
    name: "filter-active-120x40",
    size: SIZE(120, 40),
    state: state({ boxes: THIRTY, filter: "01", filtering: true, selected: 2, detail: { box: "grok-box-010", lines: HISTORY } }),
    exceptions: ["detail-column"],
  },
  {
    name: "detail-panel-120x40",
    size: SIZE(120, 40),
    state: state({
      boxes: THREE,
      selected: 1,
      detail: { box: "grok-box-002", lines: HISTORY },
      detailFacts: {
        box: "grok-box-002",
        facts: {
          name: "grok-box-002",
          checkfail_count: 3,
          asleep_since: "2026-03-20T09:46:40Z",
          asleep_last: "2026-03-20T10:46:40Z",
          expires_at: "2026-06-01",
          api_backoff: { fails: 2, next_retry: "2026-03-20T12:33:20Z" },
          // state-store D4: the two facts the pane gained in 5.9.0.
          phase: "enrolled",
          observed: "drifted",
        },
      },
    }),
    exceptions: ["detail-column"],
  },
  {
    name: "modal-120x40",
    size: SIZE(120, 40),
    state: state({
      boxes: THREE,
      selected: 0,
      detail: { box: "grok-box-001", lines: HISTORY },
      modal: {
        actionLabel: "config-push",
        box: "grok-box-001",
        typed: "grok-box",
        field: "confirm",
        note: "single box, no canary gate",
        expect: "grok-box-001",
      },
    }),
    exceptions: ["detail-column"],
  },
  {
    name: "no-color-120x40",
    size: SIZE(120, 40),
    state: state({ boxes: THREE, selected: 2, noColor: true, message: "check grok-box-003 → rc=0" }),
    exceptions: ["detail-column"],
  },

  // --- the detail cutoff -----------------------------------------------------
  {
    name: "detail-cutoff-100x40",
    size: SIZE(100, 40),
    state: state({ boxes: THREE, selected: 0, detail: { box: "grok-box-001", lines: HISTORY } }),
    exceptions: ["detail-column"],
  },
  {
    name: "detail-cutoff-99x40",
    size: SIZE(99, 40),
    state: state({ boxes: THREE, selected: 0, detail: { box: "grok-box-001", lines: HISTORY } }),
    exceptions: [],
  },

  // --- the 30-box fleet in a 12-row terminal, both token scopes --------------
  // The literal windows. Until 5.11.1 admin got a ONE-line footer at 120 columns
  // and so one more box row than readonly; occupancy O7 added `f free` and
  // `L leases`, which pushed that line to 138 characters, so BOTH scopes now
  // take a two-line footer at 120 and the admin windows are the readonly ones.
  ...(
    [
      { scope: "admin" as const, suffix: "top", selected: 0, indicator: "rows 1–5 of 30", first: "grok-box-001", last: "grok-box-005" },
      { scope: "admin" as const, suffix: "middle", selected: 15, indicator: "rows 12–16 of 30", first: "grok-box-012", last: "grok-box-016" },
      { scope: "admin" as const, suffix: "bottom", selected: 29, indicator: "rows 26–30 of 30", first: "grok-box-026", last: "grok-box-030" },
      { scope: "readonly" as const, suffix: "top", selected: 0, indicator: "rows 1–5 of 30", first: "grok-box-001", last: "grok-box-005" },
      { scope: "readonly" as const, suffix: "middle", selected: 15, indicator: "rows 12–16 of 30", first: "grok-box-012", last: "grok-box-016" },
      { scope: "readonly" as const, suffix: "bottom", selected: 29, indicator: "rows 26–30 of 30", first: "grok-box-026", last: "grok-box-030" },
    ]
  ).map((s) => ({
    name: `fleet30-${s.scope}-120x12-${s.suffix}`,
    size: SIZE(120, 12),
    state: state({ boxes: THIRTY, scope: s.scope, selected: s.selected }),
    exceptions: ["table-window", "detail-omitted"] as GoldenException[],
    window: { indicator: s.indicator, first: s.first, last: s.last },
  })),

  // --- banners ---------------------------------------------------------------
  {
    name: "banner-linkdown-120x40",
    size: SIZE(120, 40),
    state: state({
      boxes: THREE,
      link: { up: false, sinceMs: Date.parse("2026-05-01T00:00:00Z") },
      nowMs: Date.parse("2026-05-01T00:00:45Z"),
    }),
    exceptions: ["detail-column"],
  },
  {
    name: "banner-stale-120x40",
    size: SIZE(120, 40),
    state: state({ boxes: THREE, tickAgeS: 16 * 60, link: { up: true } }),
    exceptions: ["detail-column"],
  },
  {
    name: "banner-unknown-120x40",
    size: SIZE(120, 40),
    state: state({ boxes: THREE, snapshotTs: null, tickAgeS: null, link: { up: true } }),
    exceptions: ["detail-column"],
  },

  // --- occupancy: WHO, the free filter, and the leases view (5.11.1) ---------
  {
    name: "occupancy-mixed-120x40",
    size: SIZE(120, 40),
    state: state({
      boxes: ELEVEN,
      canary: "grok-box-002",
      selected: 0,
      detail: { box: "grok-box-001", lines: HISTORY },
      detailFacts: FACTS_001,
    }),
    exceptions: ["detail-column"],
  },
  {
    name: "free-filter-120x40",
    size: SIZE(120, 40),
    state: state({ boxes: ELEVEN, canary: "grok-box-002", freeOnly: true, selected: 0 }),
    exceptions: ["detail-column"],
  },
  // The row GEOMETRY at the narrow pane, filter OFF: seven columns plus `C` in
  // exactly `tableWidth(100)` = 60, with the 9+ character holder, the
  // `unknown`/`in-sync` pair and the negative expiry all in one frame.
  {
    name: "occupancy-100x40",
    size: SIZE(100, 40),
    state: state({ boxes: ELEVEN, canary: "grok-box-002", selected: 0 }),
    exceptions: ["detail-column"],
  },
  // The HEADER budget at 100 columns with the filter on: the bar must still end
  // in `link ● up`, and the `[free]` badge must be on the status line.
  {
    name: "free-filter-100x40",
    size: SIZE(100, 40),
    state: state({ boxes: ELEVEN, canary: "grok-box-002", freeOnly: true, selected: 0 }),
    exceptions: ["detail-column"],
  },
  ...([40, 20] as const).map((rows) => ({
    name: `view-leases-120x${rows}`,
    size: SIZE(120, rows),
    state: state({
      boxes: ELEVEN,
      view: { kind: "leases" as const, box: "", offset: 0, loading: false, lines: LEASE_VIEW_LINES },
    }),
    exceptions: [] as GoldenException[],
  })),

  // --- the D / J / H views ---------------------------------------------------
  ...([40, 20] as const).flatMap((rows) => [
    {
      name: `view-diff-120x${rows}`,
      size: SIZE(120, rows),
      state: state({
        boxes: THREE,
        view: { kind: "diff" as const, box: "grok-box-001", offset: 20, loading: false, lines: DIFF_LINES },
      }),
      exceptions: [] as GoldenException[],
    },
    {
      name: `view-journal-120x${rows}`,
      size: SIZE(120, rows),
      state: state({
        boxes: THREE,
        view: { kind: "journal" as const, box: "grok-box-002", offset: 0, loading: false, lines: JOURNAL_LINES_CONTENT },
      }),
      exceptions: [] as GoldenException[],
    },
    {
      name: `view-history-120x${rows}`,
      size: SIZE(120, rows),
      state: state({
        boxes: THREE,
        view: { kind: "history" as const, box: "grok-box-001", offset: 0, loading: false, history: HISTORY },
      }),
      exceptions: [] as GoldenException[],
    },
  ]),
];
