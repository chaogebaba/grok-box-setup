// tokens.test.ts — TokenStore startup refusals (mode/owner/missing/malformed),
// mtime reload keeping last-good, and the scope split.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { TokenStore, TokenFileError } from "../../src/serve/tokens.ts";
import { memTokenFs, TWO_TOKENS } from "./helpers.ts";
import { setLogSink } from "../../src/log.ts";

let logs: string[] = [];
let restore: (l: string) => void;
beforeEach(() => {
  logs = [];
  restore = setLogSink((l) => logs.push(l));
});
afterEach(() => setLogSink(restore));

describe("startup refusals (serve refuses to start)", () => {
  test("missing file ⇒ throws", () => {
    const { fs } = memTokenFs(TWO_TOKENS, { missing: true });
    expect(() => TokenStore.load("/x", fs)).toThrow(TokenFileError);
  });
  test("mode != 600 ⇒ throws", () => {
    const { fs } = memTokenFs(TWO_TOKENS, { mode: 0o644 });
    expect(() => TokenStore.load("/x", fs)).toThrow(/mode 644/);
  });
  test("owner mismatch ⇒ throws", () => {
    const { fs } = memTokenFs(TWO_TOKENS, { uid: 4242 });
    // selfUid returns the file uid by default; force a mismatch via a custom fs.
    const badFs = { ...fs, selfUid: () => 999, stat: () => ({ mtimeMs: 1, mode: 0o600, uid: 4242 }) };
    expect(() => TokenStore.load("/x", badFs)).toThrow(/owner/);
  });
  test("malformed toml ⇒ throws", () => {
    const { fs } = memTokenFs("this is = = not toml [[[");
    expect(() => TokenStore.load("/x", fs)).toThrow(TokenFileError);
  });
  test("no [tokens.*] tables ⇒ throws", () => {
    const { fs } = memTokenFs(`[other]\nx = 1\n`);
    expect(() => TokenStore.load("/x", fs)).toThrow(/no \[tokens/);
  });
});

describe("scope split", () => {
  test("admin and readonly resolve to the right scope", () => {
    const store = TokenStore.load("/x", memTokenFs(TWO_TOKENS).fs);
    expect(store.authenticate("ADMINSECRET")).toEqual({ name: "admin-one", scope: "admin" });
    expect(store.authenticate("READSECRET")).toEqual({ name: "read-one", scope: "readonly" });
    expect(store.count()).toBe(2);
  });
});

describe("mtime reload keeps last-good on a bad edit (R2-A3)", () => {
  test("a malformed reload keeps the previous token set and never crashes", () => {
    const { fs, setBody } = memTokenFs(TWO_TOKENS);
    const store = TokenStore.load("/x", fs);
    expect(store.authenticate("ADMINSECRET")?.scope).toBe("admin");
    // Break the file (new mtime) — reloadIfChanged must keep last-good.
    setBody("garbage [[[ not toml");
    store.reloadIfChanged();
    expect(store.authenticate("ADMINSECRET")?.scope).toBe("admin"); // still works
    expect(logs.some((l) => l.includes("reload REJECTED"))).toBe(true);
    // A subsequent request does not re-warn on the same bad content.
    logs.length = 0;
    store.reloadIfChanged();
    expect(logs.length).toBe(0);
  });

  test("a valid edit is picked up (new token works, old stops)", () => {
    const { fs, setBody } = memTokenFs(TWO_TOKENS);
    const store = TokenStore.load("/x", fs);
    setBody(`[tokens.new-admin]\ntoken = "FRESH"\nscope = "admin"\n`);
    store.reloadIfChanged();
    expect(store.authenticate("FRESH")?.scope).toBe("admin");
    expect(store.authenticate("ADMINSECRET")).toBeUndefined();
  });

  test("a wrong-mode reload keeps last-good (never drops to zero tokens)", () => {
    let mode = 0o600;
    let mtime = 1;
    const fs = {
      stat: () => ({ mtimeMs: mtime, mode, uid: 7 }),
      read: () => `[tokens.a]\ntoken="S"\nscope="admin"\n`,
      selfUid: () => 7,
    };
    const store = TokenStore.load("/x", fs);
    expect(store.authenticate("S")?.scope).toBe("admin");
    mode = 0o644; // someone chmod'd it wrong
    mtime = 2;
    store.reloadIfChanged();
    expect(store.authenticate("S")?.scope).toBe("admin"); // last-good kept
    expect(store.count()).toBe(1);
  });
});
