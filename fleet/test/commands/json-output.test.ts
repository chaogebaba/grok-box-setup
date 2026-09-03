// json-output.test.ts — agent-ux U2/U6: `--json` on every read command, and
// GROKFLEET_JSON=1 as its environment equivalent.
//
// Mutant (b): drop the GROKFLEET_JSON branch from `wantsJson` ⇒ every
// "GROKFLEET_JSON=1 is equivalent" case fails.

import { afterAll, describe, test, expect } from "bun:test";
import { envWantsJson, wantsJson } from "../../src/commands/json-flag.ts";
import { cmdList, renderListJson, type DiscoverRow } from "../../src/commands/list.ts";
import { cmdState } from "../../src/commands/state.ts";
import { renderRcJson } from "../../src/commands/rc.ts";
import { FakeRunner, result } from "../fake-runner.ts";
import { openStore, storePath } from "../../src/store/db.ts";
import { StoreState } from "../../src/store/state.ts";
import { testEnv } from "../helpers.ts";
import { cleanup, suiteScratch, T0 } from "../store/helpers.ts";
import { RC } from "../../src/upgrade.ts";

// One bucket for this file, dropped whole in afterAll even if a test threw
// before its own cleanup (side-fixes-1 portable-scratch API).
const SCRATCH = suiteScratch("json-output");
afterAll(() => SCRATCH.clean());

describe("U2 the --json / GROKFLEET_JSON decision (mutant (b))", () => {
  test("--json wins on its own", () => {
    expect(wantsJson(["--json"], {})).toBe(true);
    expect(wantsJson(["status"], {})).toBe(false);
  });

  test("GROKFLEET_JSON=1 is equivalent to --json", () => {
    expect(wantsJson([], { GROKFLEET_JSON: "1" })).toBe(true);
    expect(wantsJson(["status"], { GROKFLEET_JSON: "true" })).toBe(true);
    expect(envWantsJson({ GROKFLEET_JSON: "1" })).toBe(true);
  });

  test("a set-but-off GROKFLEET_JSON does NOT force JSON", () => {
    for (const v of ["", "0", "false", "no", "off", " OFF "]) {
      expect(wantsJson([], { GROKFLEET_JSON: v })).toBe(false);
    }
    expect(wantsJson([], {})).toBe(false);
  });
});

const TS_JSON = JSON.stringify({
  Peer: {
    a: { HostName: "grok-box-003", TailscaleIPs: ["100.64.0.3"], Online: true },
    b: { HostName: "grok-box-011", TailscaleIPs: ["100.64.0.11"], Online: false },
  },
});

describe("U2 list --json", () => {
  test("one document, key `boxes`, online as a real boolean", async () => {
    const runner = new FakeRunner(() => result({ code: 0, stdout: TS_JSON }));
    let text = "";
    const rc = await cmdList(runner, (s) => void (text += s), true);
    expect(rc).toBe(RC.OK);
    const doc = JSON.parse(text) as { boxes: Array<{ name: string; ip: string; online: boolean; index: number }> };
    expect(doc.boxes.map((b) => b.name)).toEqual(["grok-box-003", "grok-box-011"]);
    expect(doc.boxes[0]!.online).toBe(true);
    expect(doc.boxes[1]!.online).toBe(false);
    expect(doc.boxes[0]!.ip).toBe("100.64.0.3");
    expect(doc.boxes[0]!.index).toBe(3);
    // no trailing prose: the whole stdout is the document.
    expect(text.trimEnd().endsWith("}")).toBe(true);
  });

  test("without --json the human table is unchanged", async () => {
    const runner = new FakeRunner(() => result({ code: 0, stdout: TS_JSON }));
    let text = "";
    await cmdList(runner, (s) => void (text += s));
    expect(text).toContain("NAME");
    expect(text).toContain("grok-box-003");
    expect(() => JSON.parse(text)).toThrow();
  });

  test("an empty fleet is still a valid document", () => {
    expect(JSON.parse(renderListJson([] as DiscoverRow[]))).toEqual({ boxes: [] });
  });
});

describe("U2 state check --json / state reconcile-files --json", () => {
  function deps(state: string, etc: string, over: Record<string, unknown> = {}) {
    const out: string[] = [];
    return {
      out,
      d: {
        env: testEnv({ FLEET_STATE: state, FLEET_ETC: etc }),
        runner: new FakeRunner(() => result({ stdout: "" })),
        version: "5.8.0",
        notify: async () => {},
        acquireLock: async () => "ok" as const,
        out: (s: string) => out.push(s),
        now: () => T0,
        json: true,
        ...over,
      },
    };
  }

  test("state check --json parses and carries the documented keys", async () => {
    const dir = SCRATCH.dir("json-check");
    try {
      const state = `${dir}/state`;
      const etc = `${dir}/etc`;
      const store = openStore({ path: storePath(state), dir: state, now: () => T0 });
      const st = new StoreState(store, { paths: { fleetState: state, etc, version: "5.8.0" } });
      st.recordEnrolled("grok-box-003", 20003, "AAAAKEY003");
      store.close();

      const { out, d } = deps(state, etc);
      expect(await cmdState(["check", "--json"], d)).toBe(RC.OK);
      const doc = JSON.parse(out.join("")) as Record<string, unknown>;
      for (const k of [
        "store",
        "present",
        "schema",
        "legacy_import",
        "last_backup",
        "quick_check",
        "integrity",
        "boxes",
        "divergence",
        "warnings",
      ]) {
        expect(Object.hasOwn(doc, k)).toBe(true);
      }
      expect(doc.quick_check).toBe("ok");
      expect(doc.integrity).toBe("ok");
      expect((doc.boxes as { enrolled: number }).enrolled).toBe(1);
    } finally {
      cleanup(dir);
    }
  });

  test("state check --json on a missing store is still one document", async () => {
    const dir = SCRATCH.dir("json-check-none");
    try {
      const { out, d } = deps(`${dir}/state`, `${dir}/etc`);
      expect(await cmdState(["check", "--json"], d)).toBe(RC.OK);
      const doc = JSON.parse(out.join("")) as { present: boolean };
      expect(doc.present).toBe(false);
    } finally {
      cleanup(dir);
    }
  });

  test("state reconcile-files --json is a dry-run listing, no prose", async () => {
    const dir = SCRATCH.dir("json-recon");
    try {
      const state = `${dir}/state`;
      const etc = `${dir}/etc`;
      const store = openStore({ path: storePath(state), dir: state, now: () => T0 });
      new StoreState(store, { paths: { fleetState: state, etc, version: "5.8.0" } });
      store.close();

      const { out, d } = deps(state, etc);
      expect(await cmdState(["reconcile-files", "--json"], d)).toBe(RC.OK);
      const text = out.join("");
      const doc = JSON.parse(text) as { apply: boolean; findings: unknown[] };
      expect(doc.apply).toBe(false);
      expect(Array.isArray(doc.findings)).toBe(true);
      expect(text).not.toContain("dry-run —");
    } finally {
      cleanup(dir);
    }
  });
});

describe("U2 rc --json", () => {
  test("parses", () => {
    expect(() => JSON.parse(renderRcJson())).not.toThrow();
  });
});
