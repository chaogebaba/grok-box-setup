// config.ts — the TUI's own config (TUI-D6).
//
// `~/.config/grok-fleet/tui.toml` carries `url` + `token`; mode 600 enforced
// (refuse world-readable, A14). Env overrides `FLEET2_ADMIN_URL` /
// `FLEET2_ADMIN_TOKEN` take precedence (A9 — deliberately NOT `FLEET_API_*`,
// which is the Tailscale token pair). No interactive token prompt: if neither
// the env nor a readable config yields both url+token, we refuse with a clear
// message.

import { statSync, readFileSync } from "node:fs";

export interface TuiConfig {
  url: string;
  token: string;
}

export class TuiConfigError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "TuiConfigError";
  }
}

/** Injectable seam so tests avoid real files/env/mode. */
export interface ConfigFs {
  /** {mode perm bits} or undefined when absent. */
  stat(path: string): { mode: number } | undefined;
  read(path: string): string;
  env(name: string): string | undefined;
  /** the resolved path of the tui.toml (so tests point elsewhere). */
  configPath(): string;
}

export const nodeConfigFs: ConfigFs = {
  stat(path) {
    try {
      const s = statSync(path);
      return { mode: s.mode & 0o777 };
    } catch {
      return undefined;
    }
  },
  read(path) {
    return readFileSync(path, "utf8");
  },
  env(name) {
    const v = process.env[name];
    return v === undefined || v === "" ? undefined : v;
  },
  configPath() {
    const home = process.env.HOME ?? "";
    const xdg = process.env.XDG_CONFIG_HOME;
    const base = xdg && xdg !== "" ? xdg : `${home}/.config`;
    return `${base}/grok-fleet/tui.toml`;
  },
};

/** Parse the tui.toml body for url/token (both optional at this layer). */
export function parseTuiToml(body: string): { url?: string; token?: string } {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new TuiConfigError(`tui.toml parse error: ${msg}`);
  }
  const root = (parsed ?? {}) as Record<string, unknown>;
  const url = typeof root["url"] === "string" && root["url"] !== "" ? (root["url"] as string) : undefined;
  const token = typeof root["token"] === "string" && root["token"] !== "" ? (root["token"] as string) : undefined;
  return { url, token };
}

/**
 * Resolve the TUI config: env override first (FLEET2_ADMIN_URL/TOKEN), then the
 * mode-600 tui.toml. A present-but-world-readable config is REFUSED (A14). A
 * missing config is fine IF the env supplies both fields. Throws TuiConfigError
 * when the resolved url+token are not BOTH present.
 */
export function resolveTuiConfig(fs: ConfigFs = nodeConfigFs): TuiConfig {
  const envUrl = fs.env("FLEET2_ADMIN_URL");
  const envToken = fs.env("FLEET2_ADMIN_TOKEN");

  let fileUrl: string | undefined;
  let fileToken: string | undefined;
  const path = fs.configPath();
  const st = fs.stat(path);
  if (st !== undefined) {
    // A file that exists must be mode 600 (no group/other bits).
    if ((st.mode & 0o077) !== 0) {
      throw new TuiConfigError(
        `tui config ${path} is mode ${st.mode.toString(8)} — refusing (must be 600; run: chmod 600 ${path})`,
      );
    }
    const parsed = parseTuiToml(fs.read(path));
    fileUrl = parsed.url;
    fileToken = parsed.token;
  }

  const url = envUrl ?? fileUrl;
  const token = envToken ?? fileToken;
  if (url === undefined || token === undefined) {
    const missing = [url === undefined ? "url" : null, token === undefined ? "token" : null].filter(Boolean).join(", ");
    throw new TuiConfigError(
      `tui: no ${missing} — set FLEET2_ADMIN_URL/FLEET2_ADMIN_TOKEN or add url/token to ${path} (mode 600). No interactive prompt.`,
    );
  }
  // normalise: strip a trailing slash from the url so path joins are clean.
  return { url: url.replace(/\/+$/, ""), token };
}
