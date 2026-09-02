// config.test.ts — TUI-D6: env override precedence + tui.toml mode-600 refusal.

import { test, expect, describe } from "bun:test";
import { resolveTuiConfig, TuiConfigError, parseTuiToml, type ConfigFs } from "../../src/tui/config.ts";

function fs(over: {
  body?: string;
  mode?: number;
  missing?: boolean;
  env?: Record<string, string | undefined>;
}): ConfigFs {
  return {
    stat: () => (over.missing ? undefined : { mode: over.mode ?? 0o600 }),
    read: () => over.body ?? "",
    env: (n) => over.env?.[n],
    configPath: () => "/home/u/.config/grok-fleet/tui.toml",
  };
}

describe("resolveTuiConfig", () => {
  test("env override wins (GROKFLEET_ADMIN_URL/TOKEN), config not even required", () => {
    const c = resolveTuiConfig(fs({ missing: true, env: { GROKFLEET_ADMIN_URL: "http://h:9891/", GROKFLEET_ADMIN_TOKEN: "T" } }));
    expect(c).toEqual({ url: "http://h:9891", token: "T" }); // trailing slash stripped
  });
  test("reads url+token from a mode-600 tui.toml", () => {
    const c = resolveTuiConfig(fs({ body: `url = "http://h:9891"\ntoken = "S"\n`, mode: 0o600, env: {} }));
    expect(c).toEqual({ url: "http://h:9891", token: "S" });
  });
  test("a world-readable config is REFUSED (A14)", () => {
    expect(() => resolveTuiConfig(fs({ body: `url="x"\ntoken="y"\n`, mode: 0o644, env: {} }))).toThrow(/mode 644/);
  });
  test("a group-readable config (640) is refused too", () => {
    expect(() => resolveTuiConfig(fs({ body: `url="x"\ntoken="y"\n`, mode: 0o640, env: {} }))).toThrow(TuiConfigError);
  });
  test("missing url or token ⇒ TuiConfigError (no interactive prompt)", () => {
    expect(() => resolveTuiConfig(fs({ body: `url="only-url"\n`, mode: 0o600, env: {} }))).toThrow(/token/);
    expect(() => resolveTuiConfig(fs({ missing: true, env: {} }))).toThrow(/url, token/);
  });
  test("env url + file token compose", () => {
    const c = resolveTuiConfig(fs({ body: `token = "FT"\n`, mode: 0o600, env: { GROKFLEET_ADMIN_URL: "http://envh" } }));
    expect(c).toEqual({ url: "http://envh", token: "FT" });
  });
});

describe("parseTuiToml", () => {
  test("extracts url/token; ignores others", () => {
    expect(parseTuiToml(`url="u"\ntoken="t"\nother=1\n`)).toEqual({ url: "u", token: "t" });
  });
  test("malformed toml throws", () => {
    expect(() => parseTuiToml("[[[ not toml")).toThrow(TuiConfigError);
  });
});
