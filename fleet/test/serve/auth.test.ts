// auth.test.ts — the serve auth matrix + routing + confirm + scope (§7 items
// 3/5; mutants: auth scope, timingSafeEqual-swap, token-name regex, confirm
// compare, 404-unknown-box, rc→HTTP table).

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { makeFetch } from "../../src/serve/server.ts";
import { TokenStore, TOKEN_NAME_RE, parseTokens } from "../../src/serve/tokens.ts";
import { fakeContext, memTokenFs, getReq, postReq, TWO_TOKENS, fakeSyscalls, fakeLockDeps, memAudit, jsonBody, jsonError } from "./helpers.ts";
import { setLogSink } from "../../src/log.ts";
import { SERVE_NAME, SERVE_VERSION } from "../../src/serve/handlers.ts";
import { SERVER_HEADER } from "../../src/serve/http.ts";

let restore: (l: string) => void;
beforeEach(() => {
  restore = setLogSink(() => {});
});
afterEach(() => setLogSink(restore));

describe("§7.3 auth matrix", () => {
  test("none/bad/readonly-POST/admin-POST → 401/401/403/423-or-200", async () => {
    const { sys } = fakeSyscalls();
    const ctx = await fakeContext({ lockDeps: fakeLockDeps(sys) });
    const fetch = makeFetch(ctx);

    // none → 401
    expect((await fetch(getReq("/v1/fleet"))).status).toBe(401);
    // bad token → 401
    expect((await fetch(getReq("/v1/fleet", "WRONG"))).status).toBe(401);
    // readonly GET /v1/fleet → 200
    expect((await fetch(getReq("/v1/fleet", "READSECRET"))).status).toBe(200);
    // readonly POST (config-push) → 403 (scope), even with a valid confirm body
    const roPost = await fetch(postReq("/v1/boxes/grok-box-1/config-push", "READSECRET", { confirm: "grok-box-1" }));
    expect(roPost.status).toBe(403);
    // admin POST check (non-destructive) → 200
    const okPost = await fetch(postReq("/v1/boxes/grok-box-1/check", "ADMINSECRET"));
    expect(okPost.status).toBe(200);
  });

  test("m: readonly token must NOT pass the admin scope gate (auth-scope mutant)", async () => {
    const ctx = await fakeContext();
    const fetch = makeFetch(ctx);
    // journal is admin-scope; a readonly token → 403.
    const r = await fetch(getReq("/v1/boxes/grok-box-1/journal", "READSECRET"));
    expect(r.status).toBe(403);
  });

  test("m: expired-mtime reload picks up a NEW admin token (reload arm)", async () => {
    const { fs, setBody } = memTokenFs(TWO_TOKENS);
    const ctx = await fakeContext({ tokenFs: fs });
    const fetch = makeFetch(ctx);
    // new token not present yet → 401
    expect((await fetch(getReq("/v1/fleet", "NEWSECRET"))).status).toBe(401);
    setBody(`
[tokens.admin-one]
token = "NEWSECRET"
scope = "admin"
`);
    // reloadIfChanged runs at request head → new token works
    expect((await fetch(getReq("/v1/fleet", "NEWSECRET"))).status).toBe(200);
  });
});

describe("timingSafeEqual comparison (mutant: swap to ===)", () => {
  test("a token that is a prefix/superstring of a real token does NOT authenticate", () => {
    const store = TokenStore.load("/x", memTokenFs(TWO_TOKENS).fs);
    expect(store.authenticate("ADMINSECRET")?.scope).toBe("admin");
    // length-safe: a short/long presented token never throws and never matches.
    expect(store.authenticate("ADMIN")).toBeUndefined();
    expect(store.authenticate("ADMINSECRETXXXX")).toBeUndefined();
    expect(store.authenticate("")).toBeUndefined();
    expect(store.authenticate(undefined)).toBeUndefined();
  });
});

describe("token-name regex ^[a-z0-9-]{1,32}$ (mutant: relax the regex)", () => {
  test("accepts valid names, rejects uppercase / too-long / bad chars", () => {
    expect(TOKEN_NAME_RE.test("admin-one")).toBe(true);
    expect(TOKEN_NAME_RE.test("a")).toBe(true);
    expect(TOKEN_NAME_RE.test("A")).toBe(false); // uppercase
    expect(TOKEN_NAME_RE.test("has_underscore")).toBe(false);
    expect(TOKEN_NAME_RE.test("x".repeat(33))).toBe(false); // >32
    expect(TOKEN_NAME_RE.test("")).toBe(false);
  });
  test("parseTokens REFUSES a table whose name breaks the regex", () => {
    expect(() =>
      parseTokens(`[tokens.BAD_NAME]\ntoken="x"\nscope="admin"\n`),
    ).toThrow(/does not match/);
  });
  test("parseTokens REFUSES a bad scope", () => {
    expect(() => parseTokens(`[tokens.ok]\ntoken="x"\nscope="root"\n`)).toThrow(/scope/);
  });
});

describe("confirm guard server-side (§7.5; mutant: confirm compare)", () => {
  test("wrong/missing confirm → 400 confirm_mismatch; correct → proceeds", async () => {
    const { sys } = fakeSyscalls();
    const ctx = await fakeContext({ lockDeps: fakeLockDeps(sys) });
    const fetch = makeFetch(ctx);
    // missing confirm
    let r = await fetch(postReq("/v1/boxes/grok-box-1/config-push", "ADMINSECRET", {}));
    expect(r.status).toBe(400);
    expect((await jsonError(r)).error.code).toBe("confirm_mismatch");
    // wrong confirm
    r = await fetch(postReq("/v1/boxes/grok-box-1/config-push", "ADMINSECRET", { confirm: "grok-box-2" }));
    expect(r.status).toBe(400);
    // correct confirm → 200 (op ran; ssh unreachable ⇒ some rc but HTTP 200)
    r = await fetch(postReq("/v1/boxes/grok-box-1/config-push", "ADMINSECRET", { confirm: "grok-box-1" }));
    expect(r.status).toBe(200);
  });

  test("reconcile confirm is the literal 'fleet'", async () => {
    const { sys } = fakeSyscalls();
    const ctx = await fakeContext({ lockDeps: fakeLockDeps(sys) });
    const fetch = makeFetch(ctx);
    let r = await fetch(postReq("/v1/reconcile", "ADMINSECRET", { confirm: "grok-box-1" }));
    expect(r.status).toBe(400);
    r = await fetch(postReq("/v1/reconcile", "ADMINSECRET", { confirm: "fleet" }));
    expect(r.status).toBe(202);
  });
});

describe("404 unknown box / route (mutant: 404-unknown-box)", () => {
  test("a well-formed but NOT-enrolled box → 404", async () => {
    const ctx = await fakeContext({ enrolled: ["grok-box-1"] });
    const fetch = makeFetch(ctx);
    const r = await fetch(getReq("/v1/boxes/grok-box-99", "READSECRET"));
    expect(r.status).toBe(404);
  });
  test("an invalid box NAME → 404 (never reaches argv)", async () => {
    const ctx = await fakeContext();
    const fetch = makeFetch(ctx);
    const r = await fetch(getReq("/v1/boxes/not-a-box/diff", "READSECRET"));
    expect(r.status).toBe(404);
  });
  test("an unknown route → 404", async () => {
    const ctx = await fakeContext();
    const fetch = makeFetch(ctx);
    expect((await fetch(getReq("/v1/nope", "READSECRET"))).status).toBe(404);
    expect((await fetch(getReq("/nope", "READSECRET"))).status).toBe(404);
  });
});

describe("rc→HTTP table (mutant: map a domain rc to a non-200)", () => {
  test("a nonzero DOMAIN rc is still HTTP 200 with {rc,log}", async () => {
    // check on a box whose tunnel is down ⇒ rc 1, HTTP 200.
    const ctx = await fakeContext(); // FakeRunner returns "" ⇒ ss shows no listener ⇒ tunnel down
    const fetch = makeFetch(ctx);
    const r = await fetch(postReq("/v1/boxes/grok-box-1/check", "ADMINSECRET"));
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.rc).toBe(1);
    expect(Array.isArray(body.log)).toBe(true);
  });

  test("GET /v1/health is unauthenticated and reports version", async () => {
    const ctx = await fakeContext();
    const fetch = makeFetch(ctx);
    const r = await fetch(getReq("/v1/health"));
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.ok).toBe(true);
    expect(body.version).toBe(SERVE_VERSION);
    expect(body).toHaveProperty("tick_age_s");
  });

  // N1/N5 (5.10.0 rename): the product name is a MACHINE-READABLE field, not
  // display text, so it is asserted by PARSING the JSON — a mechanical grep over
  // the source would keep passing if the field were dropped or misspelled, and a
  // consumer reading it would break silently.
  test("GET /v1/health names the product (N1) — parsed, not grepped", async () => {
    const ctx = await fakeContext();
    const fetch = makeFetch(ctx);
    const r = await fetch(getReq("/v1/health"));
    const body = await jsonBody(r);
    expect(body.name).toBe("grokfleet");
    expect(SERVE_NAME).toBe("grokfleet");
  });

  test("every API response carries the `server: grokfleet` header (N1)", async () => {
    const ctx = await fakeContext();
    const fetch = makeFetch(ctx);
    expect(SERVER_HEADER).toBe("grokfleet");
    // an unauthenticated route, an authenticated one, and an error body
    for (const req of [getReq("/v1/health"), getReq("/v1/fleet", "READSECRET"), getReq("/v1/fleet")]) {
      const r = await fetch(req);
      expect(r.headers.get("server")).toBe("grokfleet");
    }
  });

  test("GET /v1/fleet carries the calling token's scope (R3-A1)", async () => {
    const ctx = await fakeContext();
    const fetch = makeFetch(ctx);
    const ro = await jsonBody(await fetch(getReq("/v1/fleet", "READSECRET")));
    expect(ro.scope).toBe("readonly");
    const ad = await jsonBody(await fetch(getReq("/v1/fleet", "ADMINSECRET")));
    expect(ad.scope).toBe("admin");
  });
});

// audit line is written on a mutation (used by later tests too).
describe("audit line format", () => {
  test("config-push writes token=<name> action=config-push box=<box> rc=<n>", async () => {
    const { sink, lines } = memAudit();
    const { sys } = fakeSyscalls();
    const ctx = await fakeContext({ auditSink: sink, lockDeps: fakeLockDeps(sys) });
    const fetch = makeFetch(ctx);
    await fetch(postReq("/v1/boxes/grok-box-1/config-push", "ADMINSECRET", { confirm: "grok-box-1" }));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/token=admin-one action=config-push box=grok-box-1 rc=\d+/);
  });
});
