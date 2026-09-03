// occupancy.test.ts — who holds each box, which boxes are free, and the leases
// view (blueprint fleet-tui-occupancy O1–O8, grokfleet 5.11.1).
//
// The panel answers four questions it could not answer at 5.11.0: WHO holds a
// box, for WHAT, for HOW MUCH LONGER, and — the one an operator actually acts
// on — WHICH boxes can I take right now. Everything here renders from what
// `/v1/fleet` already carries per box plus the existing `GET /v1/leases`; no
// endpoint, store or reconcile change.

import { describe, expect, test } from "bun:test";
import {
  DETAIL_ROWS,
  GLYPH,
  age,
  detailLines,
  detailWidth,
  filteredBoxes,
  freeCount,
  headerText,
  headerSegments,
  isFree,
  leaseRows,
  left,
  statusLine,
  tableLines,
  viewLines,
  whoSegment,
} from "../../src/tui/model.ts";
import { handleKey } from "../../src/tui/state.ts";
import { makeApiClient, type BoxLease, type FetchLike, type Lease } from "../../src/tui/api-client.ts";
import { mount, settle, silentClient } from "./ink-harness.ts";
import { box, state, SIZE_120x40 } from "./helpers.ts";

/** The clock every fixture and golden is pinned to. */
const NOW = Date.parse("2026-05-01T00:00:10Z");
const SIZE_100x40 = { cols: 100, rows: 40 };
/** A pane wide enough to read a whole card row without truncation. */
const WIDE = 200;

function lease(over: Partial<BoxLease> = {}): BoxLease {
  return {
    lease_id: "LEASEID0000000000000A",
    state: "active",
    holder: "ci:runner-3",
    purpose: "gate",
    kind: "ephemeral",
    expires_at: "2026-05-01T01:12:00Z",
    grace_ends_at: null,
    ...over,
  };
}

function fullLease(over: Partial<Lease> = {}): Lease {
  return {
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
  };
}

const card = (s: ReturnType<typeof state>, width = WIDE): string =>
  detailLines(s, width)
    .map((l) => l.text)
    .join("\n");

// --- O2: one relative-time function, one grammar -----------------------------
describe("O2 — left() and age()", () => {
  const at = (iso: string): string => iso;

  test("the whole grammar, future and past", () => {
    // under a minute either way is `<1m` with NO sign: the past form of
    // under-a-minute is also `<1m`.
    expect(left(NOW, at("2026-05-01T00:00:40Z"))).toBe("<1m");
    expect(left(NOW, at("2026-04-30T23:59:40Z"))).toBe("<1m");
    // minutes, hours with the minutes ALWAYS two digits (a stable width), days.
    expect(left(NOW, at("2026-05-01T00:42:10Z"))).toBe("42m");
    expect(left(NOW, at("2026-05-01T01:05:10Z"))).toBe("1h05");
    expect(left(NOW, at("2026-05-03T03:00:10Z"))).toBe("2d3h");
    // the past keeps the same forms behind a `-`.
    expect(left(NOW, at("2026-04-30T23:55:10Z"))).toBe("-5m");
    expect(left(NOW, at("2026-04-30T22:55:10Z"))).toBe("-1h05");
  });

  test("an absent or unparseable instant is a dash, never a guess", () => {
    for (const v of [null, undefined, "", "not-a-time"]) expect(left(NOW, v)).toBe("-");
  });

  test("age() is left() with the sign stripped", () => {
    expect(age(NOW, at("2026-04-30T23:55:10Z"))).toBe("5m");
    expect(age(NOW, at("2026-04-30T22:55:10Z"))).toBe("1h05");
    // …and it never invents a sign for a future instant.
    expect(age(NOW, at("2026-05-01T00:42:10Z"))).toBe("42m");
  });
});

// --- O3: isFree, the one predicate ------------------------------------------
describe("O3 — isFree", () => {
  const s = state();

  test("the truth table: only an awake, healthy, unleased box is free", () => {
    expect(isFree(s, box("b"))).toBe(true); // ● and no lease
    expect(isFree(s, box("b", { asleep: true }))).toBe(false); // ☾
    expect(isFree(s, box("b", { check: "FAIL" }))).toBe(false); // ✖
    expect(isFree(s, box("b", { drift: "yes" }))).toBe(false); // ◆
    expect(isFree(s, box("b", { checkfail: true }))).toBe(false); // ◆
    expect(isFree(s, box("b", { config: "drift" }))).toBe(false); // ◆
    expect(isFree(s, box("b", { tunnel: "down", check: "-" }))).toBe(false); // ○
    expect(isFree(s, { ...box("b"), lease: lease() })).toBe(false); // ⚑
  });

  test("EVERY lease state defers, not just `active` (the L3 rule)", () => {
    for (const st of ["active", "expired", "lost"] as const) {
      expect(isFree(s, { ...box("b"), lease: lease({ state: st }) })).toBe(false);
    }
  });
});

// --- O1: the WHO cell --------------------------------------------------------
describe("O1 — the WHO cell", () => {
  test("`-` when nobody holds it, `⚑ <holder>` when somebody does", () => {
    const free = whoSegment(box("b"));
    expect(free.text).toBe("-           ");
    expect(free.text.length).toBe(12);
    expect(free.tone).toBe("muted");

    const held = whoSegment({ ...box("b"), lease: lease({ holder: "dev" }) });
    expect(held.text).toBe(`${GLYPH.leased} dev       `);
    expect(held.text.length).toBe(12);
  });

  test("the tone follows the lease STATE (L3), on the cell as on the glyph", () => {
    expect(whoSegment({ ...box("b"), lease: lease({ state: "active" }) }).tone).toBe("main");
    expect(whoSegment({ ...box("b"), lease: lease({ state: "expired" }) }).tone).toBe("warn");
    expect(whoSegment({ ...box("b"), lease: lease({ state: "lost" }) }).tone).toBe("down");
  });

  // m4: dropping the truncation lets `pad` hard-cut a long holder to 12 with no
  // `…` and, worse, no gap at all before VER.
  test("a 40-character holder is cut to 8 + `…` and STILL leaves a gap", () => {
    const long = "x".repeat(40);
    const seg = whoSegment({ ...box("b"), lease: lease({ holder: long }) });
    expect(seg.text.length).toBe(12);
    expect(seg.text).toBe(`${GLYPH.leased} xxxxxxxx… `);
    expect(seg.text.endsWith(" ")).toBe(true); // the gap before VER
    expect(seg.text).toContain("…");
  });

  test("a holder exactly 9 long is not cut, and still leaves its gap", () => {
    const seg = whoSegment({ ...box("b"), lease: lease({ holder: "svc:brain" }) });
    expect(seg.text).toBe(`${GLYPH.leased} svc:brain `);
  });

  test("the row is 57 columns, or 60 with the canary — exactly tableWidth(100)", () => {
    const withCanary = state({ boxes: [box("grok-box-001")], canary: "grok-box-001" });
    const row = tableLines(withCanary, SIZE_100x40)[1]!.text;
    expect(row.trimEnd().length).toBeLessThanOrEqual(60);
    const head = tableLines(withCanary, SIZE_100x40)[0]!.text;
    expect(head.trimEnd()).toBe("  NAME          WHO         VER     DRIFT   CONFIG  EXP    C");
    expect(head.trimEnd().length).toBe(60);
  });

  // m9: an EXPIRY narrower than 5 cuts `-365d` to `-365`, which reads as a
  // four-digit day count rather than an expired key.
  test("EXPIRY holds the widest real value, a NEGATIVE day count, uncut", () => {
    const s = state({ boxes: [box("grok-box-001", { expiry_days: -365 })] });
    expect(tableLines(s, SIZE_120x40)[1]!.text).toContain("-365d");
  });
});

// --- O3: the header ----------------------------------------------------------
describe("O3 — the header answers `can I take one`", () => {
  const fleet = [box("a"), box("b"), { ...box("c"), lease: lease() }, box("d", { asleep: true })];

  test("`free n` is ALWAYS printed, and `free 0` is WARN, not quiet", () => {
    const none = state({ boxes: [box("a", { asleep: true })] });
    expect(freeCount(none, none.boxes)).toBe(0);
    expect(headerText(none, SIZE_120x40)).toContain("free 0");
    expect(headerSegments(none, SIZE_120x40).find((x) => x.text === "free 0")?.tone).toBe("warn");

    const some = state({ boxes: fleet });
    expect(freeCount(some, some.boxes)).toBe(2);
    expect(headerSegments(some, SIZE_120x40).find((x) => x.text === "free 2")?.tone).toBe("ok");
  });

  // m3: counting all boxes rather than the free ones.
  test("`free` counts FREE boxes, not boxes", () => {
    const s = state({ boxes: fleet });
    expect(headerText(s, SIZE_120x40)).toContain("free 2");
    expect(headerText(s, SIZE_120x40)).not.toContain("free 4");
  });

  test("`⚑ n leased` keeps its zero-suppression — quiet is still the goal state", () => {
    const s = state({ boxes: [box("a")] });
    expect(headerText(s, SIZE_120x40)).not.toContain("leased");
    expect(headerText(s, SIZE_120x40)).not.toContain(GLYPH.leased);
    expect(headerText(s, SIZE_120x40)).toContain("free 1");
  });

  // m12: keeping ` leased` below 120 pushes `link ● up` off the bar.
  test("below 120 columns the word `leased` goes and the COUNT stays", () => {
    const s = state({ boxes: fleet });
    expect(headerText(s, SIZE_120x40)).toContain(`${GLYPH.leased} 1 leased`);
    const narrow = headerText(s, SIZE_100x40);
    expect(narrow).toContain(`${GLYPH.leased} 1`);
    expect(narrow).not.toContain("leased");
  });

  test("at 100 columns the bar still ENDS in `link ● up`, even with two-digit counts", () => {
    // The worst realistic case: ten free boxes, ten leased, admin scope.
    const many = [
      ...Array.from({ length: 10 }, (_, i) => box(`grok-box-${String(i + 1).padStart(3, "0")}`)),
      ...Array.from({ length: 10 }, (_, i) => ({
        ...box(`grok-box-${String(i + 11).padStart(3, "0")}`),
        lease: lease(),
      })),
    ];
    const s = state({ boxes: many, scope: "admin" });
    expect(freeCount(s, s.boxes)).toBe(10);
    const text = headerText(s, SIZE_100x40);
    expect(text.trimEnd().length).toBeLessThanOrEqual(100);
    expect(text.trimEnd().endsWith("link ● up")).toBe(true);
  });
});

// --- O4: the free filter -----------------------------------------------------
describe("O4 — `f` toggles the free filter", () => {
  const fleet = [
    box("grok-box-001"),
    { ...box("grok-box-010"), lease: lease() },
    box("grok-box-003", { asleep: true }),
    box("grok-box-011"),
  ];

  test("`f` toggles, and the conjunction lives inside filteredBoxes", () => {
    const s = state({ boxes: fleet });
    expect(filteredBoxes(s).map((b) => b.name)).toHaveLength(4);
    const on = handleKey(s, "f").state;
    expect(on.freeOnly).toBe(true);
    expect(filteredBoxes(on).map((b) => b.name)).toEqual(["grok-box-001", "grok-box-011"]);
    expect(handleKey(on, "f").state.freeOnly).toBe(false);
  });

  // m6: applying the two filters as an OR, or applying only one of them.
  test("it ANDs with the `/` name filter, in both orders", () => {
    const s = state({ boxes: fleet, filter: "01" });
    // `01` alone matches 001, 010 and 011 — one of which is leased.
    expect(filteredBoxes(s).map((b) => b.name)).toEqual(["grok-box-001", "grok-box-010", "grok-box-011"]);
    const both = handleKey(s, "f").state;
    expect(filteredBoxes(both).map((b) => b.name)).toEqual(["grok-box-001", "grok-box-011"]);
    // and the name filter still narrows further under the badge.
    expect(filteredBoxes({ ...both, filter: "011" }).map((b) => b.name)).toEqual(["grok-box-011"]);
  });

  test("`Esc` clears the filter; a fleet with no free boxes stays on screen", () => {
    const s = handleKey(state({ boxes: [box("a", { asleep: true })] }), "f").state;
    expect(filteredBoxes(s)).toHaveLength(0);
    // A15's auto-clear is for the NAME filter only: an empty free list is a
    // state the operator wants to keep looking at.
    expect(s.freeOnly).toBe(true);
    expect(tableLines(s, SIZE_120x40)[1]!.text.trimEnd()).toBe("no free boxes");
    expect(handleKey(s, "\x1b").state.freeOnly).toBe(false);
  });

  test("it works under a readonly token — it is a view, not an action", () => {
    const s = state({ boxes: fleet, scope: "readonly" });
    const on = handleKey(s, "f").state;
    expect(on.freeOnly).toBe(true);
    expect(on.message).toBeUndefined();
  });
});

// --- O4a: the status line ----------------------------------------------------
describe("O4a — the status line", () => {
  // The NULL case has reach: a `statusLine` that returned an empty Seg[] would
  // charge two chrome rows on every frame, and because layout.test.ts recounts
  // with the same function the agreement assertion would still pass.
  test("null when there is no filter, no badge and no message", () => {
    expect(statusLine(state())).toBeNull();
    expect(statusLine(state(), { view: true })).toBeNull();
  });

  test("the three parts in priority order, joined by two spaces", () => {
    const s = state({ filter: "01", freeOnly: true, message: "done" });
    const segs = statusLine(s)!;
    expect(segs.map((x) => x.text).join("")).toBe("/01  [free]  done");
    expect(segs[0]!.tone).toBe("accent"); // the filter
    expect(segs[2]!.tone).toBe("accent"); // the badge
    expect(segs[4]!.tone).toBe("ok"); // messageTone still decides the message
  });

  test("the cursor shows while typing and goes once the filter is committed", () => {
    // The prompt appears on the FIRST keystroke, when `filter` is still "".
    expect(statusLine(state({ filtering: true, filter: "" }))!.map((x) => x.text).join("")).toBe("/▏");
    expect(statusLine(state({ filtering: true, filter: "01" }))!.map((x) => x.text).join("")).toBe("/01▏");
    expect(statusLine(state({ filtering: false, filter: "01" }))!.map((x) => x.text).join("")).toBe("/01");
  });

  // m13/m14: the badge belongs on this line, never in the header.
  test("the badge is on the status line and NOT in the header", () => {
    const s = state({ boxes: [box("a")], freeOnly: true });
    expect(statusLine(s)!.map((x) => x.text).join("")).toBe("[free]");
    expect(headerText(s, SIZE_120x40)).not.toContain("[free]");
    expect(headerText(s, SIZE_100x40)).not.toContain("[free]");
  });

  test("under a full-screen view only the MESSAGE shows", () => {
    const s = state({ filter: "01", freeOnly: true, message: "refreshing…" });
    expect(statusLine(s, { view: true })!.map((x) => x.text).join("")).toBe("refreshing…");
    expect(statusLine(state({ filter: "01", freeOnly: true }), { view: true })).toBeNull();
  });
});

// --- O5: the leases view -----------------------------------------------------
describe("O5 — the `L` leases view", () => {
  const leases: Lease[] = [
    fullLease({ box: "grok-box-008", state: "lost", holder: "dev", grace_ends_at: "2026-05-01T00:17:00Z" }),
    fullLease({ box: "grok-box-001" }),
    fullLease({ box: "grok-box-007", state: "expired", kind: "service", grace_ends_at: "2026-05-01T00:17:00Z" }),
  ];

  test("`L` opens a FLEET-WIDE view whose captured box is the empty string", () => {
    const { state: next, effect } = handleKey(state({ boxes: [box("a")] }), "L");
    expect(next.view).toEqual({ kind: "leases", box: "", offset: 0, loading: true });
    expect(effect).toEqual({ type: "load-view", kind: "leases", box: "" });
  });

  test("the title is `── leases ──`, with no box and no double space", () => {
    const s = state({ view: { kind: "leases", box: "", offset: 0, loading: false, lines: ["x"] } });
    expect(viewLines(s, SIZE_120x40)[0]!.text).toStartWith("── leases ──  rows 1–1 of 1");
  });

  test("rows are sorted by box index, and every cell keeps a column of gap", () => {
    const rows = leaseRows(leases, NOW);
    expect(rows[0]).toStartWith("BOX           WHO         KIND      PURPOSE               AGE   LEFT   STATE");
    expect(rows.slice(1).map((r) => r.slice(0, 12).trim())).toEqual(["grok-box-001", "grok-box-007", "grok-box-008"]);
    // `ephemeral` is 9 in a 10-wide KIND: one space, never none.
    expect(rows[1]).toContain("ephemeral gate");
  });

  // m10: rendering a lost lease's grace without the `≤` claims an exactness
  // the store does not have — a lost lease's grace may end early.
  test("LEFT is the countdown for active, the grace for expired, and `≤`-bounded for lost", () => {
    const rows = leaseRows(leases, NOW);
    const cell = (name: string): string => {
      const r = rows.find((x) => x.startsWith(name))!;
      return r.slice(64, 71).trim();
    };
    expect(cell("grok-box-001")).toBe("1h11"); // active: time left on the lease
    expect(cell("grok-box-007")).toBe("16m"); // expired: the grace remaining
    expect(cell("grok-box-008")).toBe("≤16m"); // lost: an UPPER bound
  });

  // O6 (r7): the row's LEFT for an ACTIVE service lease is `-` — there is no
  // expiry to count down to — while a lost/expired one still shows its grace.
  test("LEFT is `-` for an active SERVICE lease, and still the grace when it is lost", () => {
    const active = leaseRows([fullLease({ kind: "service", expires_at: null })], NOW)[1]!;
    expect(active.slice(64, 71).trim()).toBe("-");
    const lost = leaseRows(
      [fullLease({ kind: "service", state: "lost", expires_at: null, grace_ends_at: "2026-05-01T00:17:00Z" })],
      NOW,
    )[1]!;
    expect(lost.slice(64, 71).trim()).toBe("≤16m");
  });

  test("a long purpose is cut to `…` and does not touch AGE", () => {
    const rows = leaseRows([fullLease({ purpose: "debug a wedged rollout that will not finish" })], NOW);
    expect(rows[1]).toContain("debug a wedged rollo… ");
  });

  test("AGE reads from created_at, with the sign stripped", () => {
    expect(leaseRows([fullLease()], NOW)[1]).toContain("22m");
  });

  // m7: `all=1` asks the server for released leases too, and then the view has
  // to re-derive "in use" for itself — a rule that already exists server-side.
  test("the request carries NO `all` param: the server default IS `in use`", async () => {
    const urls: string[] = [];
    const fetch: FetchLike = async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ leases: [] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const client = makeApiClient("http://h", "TOK", fetch);
    const m = mount(state({ boxes: [box("grok-box-001")] }), {
      client: silentClient({ listLeases: client.listLeases }),
    });
    await settle(40);
    await m.press("L");
    await settle(40);
    m.unmount();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toEndWith("/v1/leases");
    expect(urls[0]).not.toContain("all");
  });

  test("an empty list is an ANSWER, and a failure renders the view's error line", async () => {
    const ok: FetchLike = async () =>
      new Response(JSON.stringify({ leases: [] }), { status: 200, headers: { "content-type": "application/json" } });
    const empty = makeApiClient("http://h", "TOK", ok);
    const m = mount(state({ boxes: [box("grok-box-001")] }), { client: silentClient({ listLeases: empty.listLeases }) });
    await settle(40);
    await m.press("L");
    await settle(40);
    expect(m.lastFrame()).toContain("no open leases");
    m.unmount();

    const bad: FetchLike = async () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    const failing = makeApiClient("http://h", "TOK", bad);
    const m2 = mount(state({ boxes: [box("grok-box-001")] }), { client: silentClient({ listLeases: failing.listLeases }) });
    await settle(40);
    await m2.press("L");
    await settle(40);
    expect(m2.lastFrame()).toContain("link error");
    m2.unmount();
  });
});

// --- O6: the detail card -----------------------------------------------------
describe("O6 — the detail card's lease lines", () => {
  test("the card is still exactly DETAIL_ROWS lines, in every lease state", () => {
    for (const l of [null, lease(), lease({ state: "expired" }), lease({ state: "lost" })]) {
      const s = state({ boxes: [{ ...box("grok-box-1"), lease: l }] });
      expect(detailLines(s, detailWidth(SIZE_120x40)).length).toBe(DETAIL_ROWS);
    }
    // …and for the free / not-free split of an unleased box.
    expect(detailLines(state({ boxes: [box("b", { asleep: true })] }), 46).length).toBe(DETAIL_ROWS);
  });

  test("an ACTIVE lease: who, then the countdown and the expiry clock", () => {
    const s = state({ boxes: [{ ...box("grok-box-1"), lease: lease() }] });
    expect(card(s)).toContain(`lease ${GLYPH.leased} ci:runner-3 · ephemeral · gate`);
    expect(card(s)).toContain("in 1h11 · expires 01:12");
  });

  test("an EXPIRED lease shows the grace exactly; a LOST one bounds it with `≤`", () => {
    const exp = state({
      boxes: [{ ...box("grok-box-1"), lease: lease({ state: "expired", grace_ends_at: "2026-05-01T00:17:00Z" }) }],
    });
    expect(card(exp)).toContain("grace 16m · expired");
    const lost = state({
      boxes: [{ ...box("grok-box-1"), lease: lease({ state: "lost", grace_ends_at: "2026-05-01T00:17:00Z" }) }],
    });
    expect(card(lost)).toContain("grace ≤16m · lost");
  });

  // m8: saying `free` about a box nobody could take is the one lie this card
  // must not tell.
  test("`free` is never said about an asleep or a failing box", () => {
    expect(card(state({ boxes: [box("grok-box-1")] }))).toContain("free");
    for (const over of [{ asleep: true }, { check: "FAIL" as const }, { drift: "yes" as const }]) {
      const text = card(state({ boxes: [box("grok-box-1", over)] }));
      expect(text).toContain("no lease");
      expect(text.split("\n").some((l) => l.includes("│free"))).toBe(false);
    }
  });

  // O6 (r7): a `service` lease has no expiry, so line 2 is its own sentence —
  // in the LEASE's tone, because the box IS held. And the state branch owns
  // `expired`/`lost` FIRST: a lost service lease takes the grace form, not this
  // one, so a box that went away is never reported as a standing reservation.
  test("an ACTIVE service lease reads `no expiry`, in the lease's own tone", () => {
    const s = state({
      boxes: [{ ...box("grok-box-1"), lease: lease({ kind: "service", expires_at: null }) }],
    });
    const line = detailLines(s, WIDE).find((l) => l.text.includes("no expiry"))!;
    expect(line.text).toContain("  no expiry");
    expect(line.segments!.find((x) => x.text.includes("no expiry"))!.tone).toBe("main");
  });

  test("a LOST or EXPIRED service lease takes the state-keyed grace form, not `no expiry`", () => {
    for (const [st, want] of [
      ["lost", "grace ≤16m · lost"],
      ["expired", "grace 16m · expired"],
    ] as const) {
      const s = state({
        boxes: [
          {
            ...box("grok-box-1"),
            lease: lease({ kind: "service", state: st, expires_at: null, grace_ends_at: "2026-05-01T00:17:00Z" }),
          },
        ],
      });
      const text = card(s);
      expect(text).toContain(want);
      expect(text).not.toContain("no expiry");
    }
  });

  test("a free box is told the API may still refuse", () => {
    expect(card(state({ boxes: [box("grok-box-1")] }))).toContain("acquire may still refuse: /v1/leases 409 reasons");
  });

  test("the two asleep lines MERGED, which is what paid for the second lease line", () => {
    expect(card(state({ boxes: [box("grok-box-1")] }))).toContain("asleep since — · last — · backoff —");
  });
});
