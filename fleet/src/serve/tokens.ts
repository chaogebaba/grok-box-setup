// tokens.ts — the serve auth token store (TUI-D2).
//
// Tokens live in `${FLEET_ETC}/serve-tokens.toml`, mode 600 (wrong mode/owner/
// missing/malformed at STARTUP ⇒ serve refuses to start). Format:
//   [tokens.<name>]
//   token = "<plaintext>"
//   scope = "admin" | "readonly"
// `<name>` must match ^[a-z0-9-]{1,32}$ (audit-forgery guard, B4). Plaintext is
// acceptable at this trust level (same posture as the Tailscale token file).
//
// Comparison (TUI-D2): SHA-256 BOTH sides, then `crypto.timingSafeEqual` on the
// 32-byte digests — length-safe (never throws on a short/long presented token,
// R2-A2) and constant-time.
//
// The file is re-checked per request by an uncached mtime stat (cheap); a reload
// re-enforces mode/owner. A MALFORMED file on reload keeps the LAST-GOOD token
// set and logs a warning — a running server never crashes or drops to zero
// tokens on a bad edit (R2-A3). Error bodies never echo tokens.

import { createHash, timingSafeEqual } from "node:crypto";
import { statSync, readFileSync } from "node:fs";
import { log } from "../log.ts";

export type Scope = "admin" | "readonly";

export interface TokenEntry {
  name: string;
  /** SHA-256 (hex) of the plaintext token — the plaintext is never retained. */
  sha256: Buffer;
  scope: Scope;
}

/** ^[a-z0-9-]{1,32}$ (B4). */
export const TOKEN_NAME_RE = /^[a-z0-9-]{1,32}$/;

export class TokenFileError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "TokenFileError";
  }
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/** Injectable fs seam so tests avoid real files/modes. */
export interface TokenFs {
  /** {mtimeMs, mode (perm bits), uid} or undefined when the file is absent. */
  stat(path: string): { mtimeMs: number; mode: number; uid: number } | undefined;
  read(path: string): string;
  /** the euid the server runs as (owner check). */
  selfUid(): number;
}

export const nodeTokenFs: TokenFs = {
  stat(path) {
    try {
      const s = statSync(path);
      return { mtimeMs: s.mtimeMs, mode: s.mode & 0o777, uid: s.uid };
    } catch {
      return undefined;
    }
  },
  read(path) {
    return readFileSync(path, "utf8");
  },
  selfUid() {
    // process.getuid is absent on some platforms; default to the file owner
    // check being satisfied (-1 sentinel disables the owner mismatch arm).
    return typeof process.getuid === "function" ? process.getuid() : -1;
  },
};

/** Parse + validate the toml body into entries. Throws TokenFileError on any
 *  structural problem (malformed table, bad name, missing/invalid fields). */
export function parseTokens(body: string): TokenEntry[] {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new TokenFileError(`serve-tokens.toml parse error: ${msg}`);
  }
  const root = (parsed ?? {}) as Record<string, unknown>;
  const tokensTable = root["tokens"];
  if (tokensTable === undefined || typeof tokensTable !== "object" || Array.isArray(tokensTable)) {
    throw new TokenFileError("serve-tokens.toml has no [tokens.<name>] tables");
  }
  const entries: TokenEntry[] = [];
  const seenSha = new Set<string>();
  for (const [name, v] of Object.entries(tokensTable as Record<string, unknown>)) {
    if (!TOKEN_NAME_RE.test(name)) {
      throw new TokenFileError(`serve-tokens.toml: token name '${name}' does not match ^[a-z0-9-]{1,32}$`);
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw new TokenFileError(`serve-tokens.toml: [tokens.${name}] is not a table`);
    }
    const t = v as Record<string, unknown>;
    const token = t["token"];
    const scope = t["scope"];
    if (typeof token !== "string" || token === "") {
      throw new TokenFileError(`serve-tokens.toml: [tokens.${name}] token must be a non-empty string`);
    }
    if (scope !== "admin" && scope !== "readonly") {
      throw new TokenFileError(`serve-tokens.toml: [tokens.${name}] scope must be "admin" or "readonly"`);
    }
    const digest = sha256(token);
    const hex = digest.toString("hex");
    if (seenSha.has(hex)) {
      throw new TokenFileError(`serve-tokens.toml: duplicate token value across names (ambiguous auth)`);
    }
    seenSha.add(hex);
    entries.push({ name, sha256: digest, scope });
  }
  if (entries.length === 0) {
    throw new TokenFileError("serve-tokens.toml defines no tokens");
  }
  return entries;
}

/** A resolved auth identity for a request (never carries the token itself). */
export interface AuthIdentity {
  name: string;
  scope: Scope;
}

/**
 * TokenStore — loads + validates at construction (STARTUP refusal), then
 * re-checks the file per request by an uncached mtime stat. A malformed reload
 * keeps the last-good set (R2-A3). Never retains plaintext.
 */
export class TokenStore {
  private entries: TokenEntry[];
  private lastMtimeMs: number;

  private constructor(
    private readonly path: string,
    private readonly fs: TokenFs,
    initial: TokenEntry[],
    mtimeMs: number,
  ) {
    this.entries = initial;
    this.lastMtimeMs = mtimeMs;
  }

  /**
   * Load at startup. Enforces existence + mode 600 + owner; a malformed/absent/
   * wrong-mode file throws TokenFileError (serve refuses to start).
   */
  static load(path: string, fs: TokenFs = nodeTokenFs): TokenStore {
    const st = fs.stat(path);
    if (st === undefined) {
      throw new TokenFileError(`serve-tokens.toml missing at ${path} — refusing to start`);
    }
    TokenStore.enforceMode(path, st, fs);
    const entries = parseTokens(fs.read(path));
    return new TokenStore(path, fs, entries, st.mtimeMs);
  }

  private static enforceMode(
    path: string,
    st: { mode: number; uid: number },
    fs: TokenFs,
  ): void {
    if ((st.mode & 0o777) !== 0o600) {
      throw new TokenFileError(
        `serve-tokens.toml has mode ${(st.mode & 0o777).toString(8)} (must be 600) at ${path} — refusing`,
      );
    }
    const self = fs.selfUid();
    if (self !== -1 && st.uid !== self) {
      throw new TokenFileError(
        `serve-tokens.toml owner uid ${st.uid} != server uid ${self} at ${path} — refusing`,
      );
    }
  }

  /**
   * Re-stat the file; if the mtime changed, re-enforce mode/owner and re-parse.
   * A malformed / wrong-mode / vanished file keeps the LAST-GOOD set and logs a
   * warning (R2-A3). Called at the head of every authenticated request.
   */
  reloadIfChanged(): void {
    const st = this.fs.stat(this.path);
    if (st === undefined) {
      log(`serve: serve-tokens.toml vanished on reload — keeping last-good token set`);
      return;
    }
    if (st.mtimeMs === this.lastMtimeMs) return;
    try {
      TokenStore.enforceMode(this.path, st, this.fs);
      const next = parseTokens(this.fs.read(this.path));
      this.entries = next;
      this.lastMtimeMs = st.mtimeMs;
      log(`serve: reloaded serve-tokens.toml (${next.length} token(s))`);
    } catch (e) {
      // Advance the mtime cursor so we do not re-warn every request on the same
      // bad content, but KEEP the last-good entries (never drop to zero).
      this.lastMtimeMs = st.mtimeMs;
      const msg = e instanceof Error ? e.message : String(e);
      log(`serve: serve-tokens.toml reload REJECTED (${msg}) — keeping last-good token set`);
    }
  }

  /**
   * Authenticate a presented plaintext token. SHA-256 both sides, timingSafeEqual
   * on the 32-byte digests (length-safe). Returns the identity or undefined.
   * `undefined`/empty presented token ⇒ undefined (401).
   */
  authenticate(presented: string | undefined): AuthIdentity | undefined {
    if (presented === undefined || presented === "") return undefined;
    const digest = sha256(presented);
    let match: TokenEntry | undefined;
    // Constant-time over ALL entries: compare against each, never short-circuit
    // on first mismatch in a timing-observable way (both are fixed 32 bytes).
    for (const e of this.entries) {
      if (e.sha256.length === digest.length && timingSafeEqual(e.sha256, digest)) {
        match = e;
      }
    }
    return match ? { name: match.name, scope: match.scope } : undefined;
  }

  /** Count of loaded tokens (for the startup/reload log; never the values). */
  count(): number {
    return this.entries.length;
  }
}
