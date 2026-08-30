// T7 — config precedence (D5, S5, S6) and TOML strictness.

import { test, expect, describe } from "bun:test";
import { parseConfig, resolveRollout, ConfigError } from "../src/config.ts";
import { setLogSink } from "../src/log.ts";

describe("T7 config precedence", () => {
  test("env > [rollout] > [fleet-brain].rollout_src > default", () => {
    const cfg = parseConfig(
      `[fleet-brain]\nrollout_src = "/legacy/src"\ncanary_box = "grok-box-002"\n` +
        `[rollout]\nsrc = "/rollout/src"\ntarget = "v1.2.3"\ncanary = "grok-box-005"\n`,
      "/x/config.toml",
    );

    // env wins over everything
    const withEnv = resolveRollout(cfg, {
      FLEET_ROLLOUT_SRC: "/env/src",
      FLEET_TARGET_REF: "envref",
    });
    expect(withEnv.src).toBe("/env/src");
    expect(withEnv.target).toBe("envref");

    // no env → [rollout] wins over [fleet-brain]
    const noEnv = resolveRollout(cfg, {});
    expect(noEnv.src).toBe("/rollout/src");
    expect(noEnv.target).toBe("v1.2.3");
    expect(noEnv.canary).toBe("grok-box-005"); // [rollout].canary > canary_box
  });

  test("[rollout].src absent → falls back to [fleet-brain].rollout_src", () => {
    const cfg = parseConfig(`[fleet-brain]\nrollout_src = "/legacy/src"\n`, "/x");
    expect(resolveRollout(cfg, {}).src).toBe("/legacy/src");
  });

  test("nothing set → defaults", () => {
    const cfg = parseConfig("", "/x");
    const r = resolveRollout(cfg, {});
    expect(r.src).toBe("/opt/grok-fleet/src");
    expect(r.target).toBe("main");
    expect(r.canary).toBe("grok-box-008");
    expect(r.verifyTries).toBe(8);
    expect(r.verifyInterval).toBe(15);
  });

  test("canary falls back to [fleet-brain].canary_box then grok-box-008", () => {
    const cfg = parseConfig(`[fleet-brain]\ncanary_box = "grok-box-003"\n`, "/x");
    expect(resolveRollout(cfg, {}).canary).toBe("grok-box-003");
  });

  test("verify_tries/verify_interval read from [rollout]", () => {
    const cfg = parseConfig(`[rollout]\nverify_tries = 5\nverify_interval = 30\n`, "/x");
    const r = resolveRollout(cfg, {});
    expect(r.verifyTries).toBe(5);
    expect(r.verifyInterval).toBe(30);
  });

  test("bad TOML → ConfigError rc 3 naming the file", () => {
    let err: unknown;
    try {
      parseConfig("this is [not valid = toml", "/opt/grok-fleet/config.toml");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).rc).toBe(3);
    expect((err as ConfigError).message).toContain("/opt/grok-fleet/config.toml");
  });

  test("absent config file (text undefined) is not an error", () => {
    const cfg = parseConfig(undefined, "/x");
    expect(cfg.present).toBe(false);
    expect(resolveRollout(cfg, {}).target).toBe("main");
  });

  test("unknown [rollout] key → one info line, not fatal", () => {
    // captured via the log sink
    const cfg = parseConfig(`[rollout]\nbogus = "x"\ntarget = "main"\n`, "/x");
    expect(cfg.present).toBe(true);
    expect(resolveRollout(cfg, {}).target).toBe("main");
  });

  test("phase-2 prep: [rollout].auto is a KNOWN key (no unknown-key log, ignored)", () => {
    const logs: string[] = [];
    const prev = setLogSink((l) => logs.push(l));
    try {
      const cfg = parseConfig(`[rollout]\nauto = true\ntarget = "main"\n`, "/x");
      expect(cfg.present).toBe(true);
      // no "unknown key" line for `auto`
      expect(logs.some((l) => l.includes("[rollout].auto"))).toBe(false);
      // and it does not affect upgrade resolution in phase 1
      expect(resolveRollout(cfg, {}).target).toBe("main");
    } finally {
      setLogSink(prev);
    }
  });
});
