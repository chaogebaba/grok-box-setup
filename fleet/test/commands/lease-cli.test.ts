// lease-cli.test.ts — `grokfleet lease` and its `run` wrapper (blueprint
// fleet2-lease-api L4/L7).
//
// Everything is a seam: a fake ApiClient, a fake exec, a fake clock and a fake
// interval, so the renew/poll behaviour is asserted without a second of real
// waiting.

import { describe, expect, test } from "bun:test";
import {
  cmdLease,
  parseDuration,
  parseBoxArg,
  parseLeaseFlags,
  POLL_INTERVAL_MS,
  RENEW_RETRY_MS,
  type LeaseRunDeps,
  type RunEnvelope,
} from "../../src/commands/lease.ts";
import type { AcquiredLease, ApiClient, ClientResult, Lease } from "../../src/tui/api-client.ts";
import { RC } from "../../src/upgrade.ts";

const NOW0 = 1_780_000_000_000; // epoch MILLISECONDS

/** Let every pending microtask AND one macrotask turn run. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function baseLease(over: Partial<Lease> = {}): Lease {
  return {
    lease_id: "LEASEID0000000000000A",
    box: "grok-box-003",
    kind: "ephemeral",
    holder: "admin-one",
    purpose: "gate",
    state: "active",
    created_at: "2026-06-01T00:00:00Z",
    expires_at: "2026-06-01T02:00:00Z",
    renewed_at: null,
    released_at: null,
    expired_at: null,
    lost_at: null,
    lost_reason: null,
    grace_ends_at: null,
    ...over,
  };
}

function acquired(over: Partial<AcquiredLease> = {}): AcquiredLease {
  return { ...baseLease(), observed: "healthy", drift: "no", connect: {}, chosen_because: "highest eligible index", ...over };
}

interface FakeApiOpts {
  acquire?: ClientResult<AcquiredLease>;
  /** one result per getLease call, cycling on the last. */
  polls?: Array<ClientResult<Lease>>;
  renews?: Array<ClientResult<Lease>>;
}

function fakeApi(o: FakeApiOpts = {}): { api: ApiClient; calls: string[] } {
  const calls: string[] = [];
  let pollN = 0;
  let renewN = 0;
  const notImpl = async (): Promise<never> => {
    throw new Error("not used");
  };
  const api = {
    async acquireLease(body: unknown) {
      calls.push(`acquire ${JSON.stringify(body)}`);
      return o.acquire ?? ({ ok: true, value: acquired() } as ClientResult<AcquiredLease>);
    },
    async renewLease(id: string) {
      calls.push(`renew ${id}`);
      const list = o.renews ?? [{ ok: true, value: baseLease() } as ClientResult<Lease>];
      return list[Math.min(renewN++, list.length - 1)]!;
    },
    async releaseLease(id: string) {
      calls.push(`release ${id}`);
      return { ok: true, value: baseLease({ state: "released" }) } as ClientResult<Lease>;
    },
    async getLease(id: string) {
      calls.push(`get ${id}`);
      const list = o.polls ?? [{ ok: true, value: baseLease() } as ClientResult<Lease>];
      return list[Math.min(pollN++, list.length - 1)]!;
    },
    async listLeases() {
      calls.push("list");
      return { ok: true, value: [baseLease()] } as ClientResult<Lease[]>;
    },
    fleet: notImpl,
    box: notImpl,
    diff: notImpl,
    history: notImpl,
    journal: notImpl,
    check: notImpl,
    configPush: notImpl,
    rotateKey: notImpl,
    rename: notImpl,
    reconcile: notImpl,
  } as unknown as ApiClient;
  return { api, calls };
}

interface Harness {
  deps: LeaseRunDeps;
  out: string[];
  errs: string[];
  calls: string[];
  /** advance the fake clock and fire every scheduled tick that is due. */
  advance: (ms: number) => Promise<void>;
  signal: () => void;
}

function harness(
  o: FakeApiOpts & { exec?: (box: string, cmd: string) => Promise<number> } = {},
): Harness {
  const { api, calls } = fakeApi(o);
  const out: string[] = [];
  const errs: string[] = [];
  let now = NOW0;
  const timers: Array<{ fn: () => void | Promise<void>; ms: number; next: number; live: boolean }> = [];
  let signalFn: (() => void) | undefined;
  const deps: LeaseRunDeps = {
    api,
    write: (s) => out.push(s),
    errWrite: (s) => errs.push(s),
    exec: o.exec ?? (async () => 0),
    now: () => now,
    interval: (fn, ms) => {
      const t = { fn, ms, next: now + ms, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
    onSignal: (fn) => {
      signalFn = fn;
      return () => {
        signalFn = undefined;
      };
    },
  };
  return {
    deps,
    out,
    errs,
    calls,
    async advance(ms) {
      const target = now + ms;
      // Fire every due tick in order, exactly as a real interval would.
      for (;;) {
        const due = timers.filter((t) => t.live && t.next <= target).sort((a, b) => a.next - b.next)[0];
        if (due === undefined) break;
        now = due.next;
        due.next += due.ms;
        await due.fn();
      }
      now = target;
    },
    signal: () => signalFn?.(),
  };
}

describe("L4 — flag parsing", () => {
  test("durations and box shorthands", () => {
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("30m")).toBe(1800);
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("1d")).toBe(86400);
    expect(parseDuration("0")).toBeUndefined();
    expect(parseDuration("later")).toBeUndefined();
    expect(parseBoxArg("7")).toBe("grok-box-007");
    expect(parseBoxArg("007")).toBe("grok-box-007");
    expect(parseBoxArg("grok-box-11")).toBe("grok-box-11");
    expect(parseBoxArg("nope")).toBeUndefined();
  });

  test("the require flags land in the `require` object, including the reserved one", () => {
    const p = parseLeaseFlags(
      ["--purpose", "gate", "--no-drift", "--allow-canary", "--boxup-version", "5.10.0", "--max-disk", "80"],
      { commandTail: false },
    );
    expect("flags" in p).toBe(true);
    if (!("flags" in p)) return;
    expect(p.flags.require).toEqual({
      no_drift: true,
      allow_canary: true,
      boxup_version: "5.10.0",
      // r1-B3: forwarded so the API refuses it BY NAME rather than the CLI
      // silently dropping a predicate the caller relied on.
      max_disk_pct: 80,
    });
  });

  test("an unknown flag is a usage error; `--` is only for `run`", () => {
    expect(parseLeaseFlags(["--nope"], { commandTail: false })).toEqual({ err: "unknown flag --nope" });
    expect(parseLeaseFlags(["--", "x"], { commandTail: false })).toEqual({
      err: "-- is only meaningful for `lease run`",
    });
  });
});

describe("L4 — acquire", () => {
  test("prints id, box and the ssh recipe; --json prints the whole lease", async () => {
    const h = harness();
    expect(await cmdLease(["acquire", "--purpose", "gate"], h.deps)).toBe(RC.OK);
    expect(h.out.join("")).toBe("LEASEID0000000000000A\tgrok-box-003\tgrokfleet ssh --lease LEASEID0000000000000A\n");

    const j = harness();
    await cmdLease(["acquire", "--purpose", "gate", "--json"], j.deps);
    expect(JSON.parse(j.out.join("")).lease_id).toBe("LEASEID0000000000000A");
  });

  test("rc 1 with the 409 reasons on STDERR when nothing is eligible", async () => {
    const h = harness({
      acquire: {
        ok: false,
        kind: "error",
        status: 409,
        code: "no_eligible_box",
        message: "no box satisfies the request",
        reasons: { "grok-box-001": "observed asleep", "grok-box-002": "leased by ci:runner-3 until X" },
      },
    });
    expect(await cmdLease(["acquire", "--purpose", "gate"], h.deps)).toBe(RC.FAILURE);
    expect(h.errs[0]).toBe("lease acquire: no eligible box");
    expect(h.errs).toContain("  grok-box-001: observed asleep");
    expect(h.errs).toContain("  grok-box-002: leased by ci:runner-3 until X");
  });

  test("--purpose is required", async () => {
    const h = harness();
    expect(await cmdLease(["acquire"], h.deps)).toBe(RC.USAGE);
    expect(h.errs[0]).toBe("lease acquire: --purpose is required");
  });
});

describe("L4 — `lease run`", () => {
  test("acquires, runs, and RELEASES on a clean exit; rc is the command's", async () => {
    const h = harness({ exec: async () => 0 });
    const rc = await cmdLease(["run", "--purpose", "ci", "--", "make", "test"], h.deps);
    expect(rc).toBe(0);
    expect(h.calls[0]).toContain('"purpose":"ci"');
    expect(h.calls).toContain("release LEASEID0000000000000A");
  });

  test("MUTANT (l3): the release is in a FINALLY — a failing command still releases", async () => {
    const h = harness({ exec: async () => 4 });
    expect(await cmdLease(["run", "--purpose", "ci", "--", "false"], h.deps)).toBe(4);
    expect(h.calls).toContain("release LEASEID0000000000000A");
  });

  test("MUTANT (l3): SIGTERM while the command runs releases the lease", async () => {
    let resolveExec: (rc: number) => void = () => {};
    const h = harness({ exec: () => new Promise<number>((res) => (resolveExec = res)) });
    const p = cmdLease(["run", "--purpose", "ci", "--", "sleep", "300"], h.deps);
    await settle();
    // The signal arrives mid-run, while the command is still going.
    h.signal();
    await settle();
    expect(h.calls).toContain("release LEASEID0000000000000A");
    resolveExec(143);
    expect(await p).toBe(143);
  });

  test("MUTANT (l15): NOTHING RAN ⇒ rc 255, lease_id null, and the reasons map", async () => {
    const h = harness({
      acquire: {
        ok: false,
        kind: "error",
        status: 409,
        code: "no_eligible_box",
        message: "no box satisfies the request",
        reasons: { "grok-box-001": "observed asleep" },
      },
    });
    const rc = await cmdLease(["run", "--purpose", "ci", "--json", "--", "make"], h.deps);
    expect(rc).toBe(255);
    expect(h.errs[0]).toBe("grokfleet: lease: no box — grok-box-001: observed asleep");
    const env = JSON.parse(h.out.join("")) as RunEnvelope;
    expect(env.lease_id).toBeNull();
    expect(env.box).toBeNull();
    expect(env.reasons).toEqual({ "grok-box-001": "observed asleep" });
  });

  test("an unreachable API at acquire is ALSO 255 with lease_id null", async () => {
    const h = harness({ acquire: { ok: false, kind: "link_down", message: "link down" } });
    expect(await cmdLease(["run", "--purpose", "ci", "--", "make"], h.deps)).toBe(255);
    expect(h.errs[0]).toBe("grokfleet: lease: no box — link down");
  });

  test("MUTANT (l16): the wrapper RENEWS at half the TTL while the command runs", async () => {
    let resolveExec: (rc: number) => void = () => {};
    const h = harness({ exec: () => new Promise<number>((res) => (resolveExec = res)) });
    const p = cmdLease(["run", "--purpose", "ci", "--ttl", "2h", "--", "sleep", "9999"], h.deps);
    await settle();
    // Half of 2h is 1h; nothing renews before then.
    await h.advance(30 * 60_000);
    expect(h.calls.filter((c) => c.startsWith("renew"))).toHaveLength(0);
    await h.advance(35 * 60_000);
    expect(h.calls.filter((c) => c.startsWith("renew")).length).toBeGreaterThanOrEqual(1);
    resolveExec(0);
    await p;
  });

  test("a `lifetime_cap` 409 prints ONE line and stops renewing", async () => {
    let resolveExec: (rc: number) => void = () => {};
    const h = harness({
      exec: () => new Promise<number>((res) => (resolveExec = res)),
      renews: [
        { ok: false, kind: "error", status: 409, code: "lifetime_cap", message: "cap", cap_at: "2026-06-02T00:00:00Z" },
      ],
    });
    const p = cmdLease(["run", "--purpose", "ci", "--ttl", "60", "--", "sleep", "9999"], h.deps);
    await settle();
    await h.advance(10 * POLL_INTERVAL_MS);
    const capLines = h.errs.filter((l) => l.includes("lifetime cap at 2026-06-02T00:00:00Z"));
    expect(capLines).toHaveLength(1);
    expect(capLines[0]).toContain("use --kind service for runs over 24 h");
    // Renewing STOPPED after the cap: exactly one attempt.
    expect(h.calls.filter((c) => c.startsWith("renew"))).toHaveLength(1);
    resolveExec(0);
    await p;
  });

  test("r7-n3: a FAILED renew retries on its own 5-minute cadence, not the poll's", async () => {
    let resolveExec: (rc: number) => void = () => {};
    const h = harness({
      exec: () => new Promise<number>((res) => (resolveExec = res)),
      renews: [{ ok: false, kind: "link_down", message: "link down" }],
    });
    const p = cmdLease(["run", "--purpose", "ci", "--ttl", "60", "--", "sleep", "9999"], h.deps);
    await settle();
    // First renew at ttl/2 = 30s ⇒ the first 30s tick. It fails.
    await h.advance(POLL_INTERVAL_MS);
    expect(h.calls.filter((c) => c.startsWith("renew"))).toHaveLength(1);
    // No retry for the next 4 minutes of polling…
    await h.advance(4 * 60_000);
    expect(h.calls.filter((c) => c.startsWith("renew"))).toHaveLength(1);
    // …and one more once the 5-minute retry window has passed.
    await h.advance(RENEW_RETRY_MS);
    expect(h.calls.filter((c) => c.startsWith("renew")).length).toBeGreaterThanOrEqual(2);
    resolveExec(0);
    await p;
  });

  test("MUTANT (l10): a LOST lease prints the line and sets lease_state in the envelope", async () => {
    let resolveExec: (rc: number) => void = () => {};
    const h = harness({
      exec: () => new Promise<number>((res) => (resolveExec = res)),
      polls: [{ ok: true, value: baseLease({ state: "lost", lost_reason: "asleep" }) }],
    });
    const p = cmdLease(["run", "--purpose", "ci", "--json", "--", "sleep", "9"], h.deps);
    await settle();
    await h.advance(POLL_INTERVAL_MS);
    expect(h.errs).toContain("grokfleet: lease: lost (asleep) — command outcome unknown");
    resolveExec(3);
    expect(await p).toBe(3);
    const env = JSON.parse(h.out.join("")) as RunEnvelope;
    expect(env.lease_state).toBe("lost");
    expect(env.lost_reason).toBe("asleep");
    expect(env.lease_id).toBe("LEASEID0000000000000A");
  });

  test("MUTANT (l17): an EXPIRED lease under a running command keeps the command alive", async () => {
    let resolveExec: (rc: number) => void = () => {};
    const h = harness({
      exec: () => new Promise<number>((res) => (resolveExec = res)),
      polls: [{ ok: true, value: baseLease({ state: "expired", expired_at: "2026-06-01T02:00:01Z" }) }],
    });
    const p = cmdLease(["run", "--purpose", "ci", "--json", "--", "sleep", "9"], h.deps);
    await settle();
    await h.advance(POLL_INTERVAL_MS);
    expect(
      h.errs.some((l) => l.includes("lease: expired — command outcome unverified, box deferred for 10 more minutes")),
    ).toBe(true);
    // The command was NOT killed: it runs to its own rc.
    resolveExec(7);
    expect(await p).toBe(7);
    expect((JSON.parse(h.out.join("")) as RunEnvelope).lease_state).toBe("expired");
  });

  test("MUTANT (l14): three consecutive POLL FAILURES are `unknown`, not health", async () => {
    let resolveExec: (rc: number) => void = () => {};
    const h = harness({
      exec: () => new Promise<number>((res) => (resolveExec = res)),
      polls: [
        { ok: false, kind: "link_down", message: "link down" },
        { ok: false, kind: "link_down", message: "link down" },
        { ok: false, kind: "link_down", message: "link down" },
      ],
    });
    const p = cmdLease(["run", "--purpose", "ci", "--json", "--", "sleep", "9"], h.deps);
    await settle();
    await h.advance(2 * POLL_INTERVAL_MS);
    // Two failures are not yet a verdict.
    expect(h.errs.some((l) => l.includes("state unknown"))).toBe(false);
    await h.advance(POLL_INTERVAL_MS);
    expect(h.errs).toContain("grokfleet: lease: state unknown (link_down) — command outcome unverified");
    // …and polling CONTINUES.
    const before = h.calls.filter((c) => c.startsWith("get")).length;
    await h.advance(2 * POLL_INTERVAL_MS);
    expect(h.calls.filter((c) => c.startsWith("get")).length).toBeGreaterThan(before);
    resolveExec(0);
    await p;
    const env = JSON.parse(h.out.join("")) as RunEnvelope;
    expect(env.lease_state).toBe("unknown");
    expect(env.poll_error).toBe("link_down");
  });

  test("a clean run's envelope says `released`", async () => {
    const h = harness({ exec: async () => 0 });
    await cmdLease(["run", "--purpose", "ci", "--json", "--", "true"], h.deps);
    expect((JSON.parse(h.out.join("")) as RunEnvelope).lease_state).toBe("released");
  });

  test("`run` with no command is a usage error", async () => {
    const h = harness();
    expect(await cmdLease(["run", "--purpose", "ci"], h.deps)).toBe(RC.USAGE);
  });
});

describe("L4 — renew / release / ls / show", () => {
  test("each one calls its endpoint and prints the lease", async () => {
    const h = harness();
    expect(await cmdLease(["renew", "LEASEID0000000000000A", "--ttl", "1h"], h.deps)).toBe(RC.OK);
    expect(h.calls).toContain("renew LEASEID0000000000000A");
    expect(await cmdLease(["release", "LEASEID0000000000000A"], h.deps)).toBe(RC.OK);
    expect(h.calls).toContain("release LEASEID0000000000000A");
    expect(await cmdLease(["show", "LEASEID0000000000000A"], h.deps)).toBe(RC.OK);
    expect(await cmdLease(["ls", "--json"], h.deps)).toBe(RC.OK);
    expect(h.calls).toContain("list");
  });

  test("an id is mandatory for renew/release/show", async () => {
    const h = harness();
    for (const sub of ["renew", "release", "show"]) {
      expect(await cmdLease([sub], h.deps)).toBe(RC.USAGE);
    }
  });

  test("an unknown subcommand is rc 2 with one stderr line", async () => {
    const h = harness();
    expect(await cmdLease(["frobnicate"], h.deps)).toBe(RC.USAGE);
    expect(h.errs[0]).toContain("unknown subcommand 'frobnicate'");
  });

  test("`lease` with no arguments prints the help on STDOUT, rc 0", async () => {
    const h = harness();
    expect(await cmdLease([], h.deps)).toBe(RC.OK);
    expect(h.out.join("")).toContain("grokfleet lease <sub>");
    expect(h.out.join("")).toContain("exit codes: grokfleet rc");
  });
});
