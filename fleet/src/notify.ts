// notify.ts — notify(level, msg): ALWAYS to the journal (log), and ALSO to
// Telegram iff $FLEET_TELEGRAM_ENV exists AND is mode 0600 (m9), carrying
// TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID. Contract mirrors fleetctl:913-932:
//  - the token NEVER appears in a log (T9);
//  - the message text is prefixed `[grok-fleet/<level>] `;
//  - a POST failure logs `notify: Telegram POST failed (journal alert still
//    delivered)` and returns normally — notify NEVER fails its caller (S8).

import { log } from "./log.ts";

export type NotifyLevel = "info" | "warn";

const POST_TIMEOUT_MS = 10_000;

/** Seam over the filesystem so tests inject env-file presence/mode/content. */
export interface TelegramSource {
  /** Return {mode, token, chat} when the env file exists, else undefined. */
  read(path: string): Promise<{ mode: number; token: string; chat: string } | undefined>;
}

/** Seam over the network so tests observe the POST without hitting Telegram. */
export type Poster = (url: string, body: URLSearchParams, timeoutMs: number) => Promise<boolean>;

/** Production Telegram source: stat + parse the env file. */
export const fsTelegramSource: TelegramSource = {
  async read(path) {
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;
    const { statSync } = await import("node:fs");
    let mode = 0;
    try {
      mode = statSync(path).mode & 0o777;
    } catch {
      return undefined;
    }
    const text = await file.text();
    let token = "";
    let chat = "";
    for (const line of text.split("\n")) {
      const t = line.trim();
      const mTok = t.match(/^TELEGRAM_BOT_TOKEN=(.*)$/);
      const mChat = t.match(/^TELEGRAM_CHAT_ID=(.*)$/);
      if (mTok) token = stripQuotes(mTok[1]!);
      if (mChat) chat = stripQuotes(mChat[1]!);
    }
    return { mode, token, chat };
  },
};

function stripQuotes(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Production poster: fetch with a 10 s AbortSignal (D9). */
export const fetchPoster: Poster = async (url, body, timeoutMs) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", body, signal: ctrl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

export interface NotifyDeps {
  telegramEnvPath: string;
  source?: TelegramSource;
  poster?: Poster;
}

/**
 * notify(level, msg, deps). Journal always; Telegram only when the env file
 * exists AND is mode 0600 with both token+chat. Never throws; never logs the
 * token.
 */
export async function notify(level: NotifyLevel, msg: string, deps: NotifyDeps): Promise<void> {
  log(`notify[${level}]: ${msg}`);
  const source = deps.source ?? fsTelegramSource;
  const poster = deps.poster ?? fetchPoster;

  let entry: { mode: number; token: string; chat: string } | undefined;
  try {
    entry = await source.read(deps.telegramEnvPath);
  } catch {
    return; // journal already delivered; a read failure is silent (fail-open)
  }
  if (entry === undefined) return; // no bot configured
  // m9: only 0600 is trusted — a 0644 env file is refused.
  if (entry.mode !== 0o600) {
    log("notify: telegram.env is not mode 0600 — refusing Telegram delivery");
    return;
  }
  if (entry.token === "" || entry.chat === "") return;

  const url = `https://api.telegram.org/bot${entry.token}/sendMessage`;
  const body = new URLSearchParams();
  body.set("chat_id", entry.chat);
  body.set("text", `[grok-fleet/${level}] ${msg}`);
  let ok = false;
  try {
    ok = await poster(url, body, POST_TIMEOUT_MS);
  } catch {
    ok = false;
  }
  if (!ok) {
    log("notify: Telegram POST failed (journal alert still delivered)");
  }
}
