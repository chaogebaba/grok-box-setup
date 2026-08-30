// T9 — notify (D9, F9/S8, m9). Telegram only when the env file is mode 0600;
// body prefix [grok-fleet/<level>]; POST failure still returns; token never
// logged.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { notify, type TelegramSource, type Poster } from "../src/notify.ts";
import { setLogSink } from "../src/log.ts";

const TOKEN = "SECRET-BOT-TOKEN-12345";

let logs: string[] = [];
let prevSink: (l: string) => void;

beforeEach(() => {
  logs = [];
  prevSink = setLogSink((l) => logs.push(l));
});
afterEach(() => {
  setLogSink(prevSink);
});

function source0600(): TelegramSource {
  return { async read() {
    return { mode: 0o600, token: TOKEN, chat: "9999" };
  } };
}
function source0644(): TelegramSource {
  return { async read() {
    return { mode: 0o644, token: TOKEN, chat: "9999" };
  } };
}
function sourceAbsent(): TelegramSource {
  return { async read() {
    return undefined;
  } };
}

describe("T9 notify", () => {
  test("Telegram POST fires only when env is 0600; body prefix + no token in logs", async () => {
    let seenUrl = "";
    let seenText = "";
    const poster: Poster = async (url, body) => {
      seenUrl = url;
      seenText = body.get("text") ?? "";
      return true;
    };
    await notify("warn", "canary aborted", {
      telegramEnvPath: "/x/telegram.env",
      source: source0600(),
      poster,
    });
    expect(seenUrl).toContain(TOKEN); // the URL carries the token (not logged)
    expect(seenText).toBe("[grok-fleet/warn] canary aborted");
    // journal line present, token NEVER in any log line (T9)
    expect(logs.some((l) => l.includes("notify[warn]: canary aborted"))).toBe(true);
    expect(logs.some((l) => l.includes(TOKEN))).toBe(false);
  });

  test("m9: 0644 env file → NO Telegram send", async () => {
    let posted = false;
    const poster: Poster = async () => {
      posted = true;
      return true;
    };
    await notify("info", "hi", { telegramEnvPath: "/x", source: source0644(), poster });
    expect(posted).toBe(false);
    expect(logs.some((l) => l.includes("not mode 0600"))).toBe(true);
  });

  test("no env file → journal only, no send, no error", async () => {
    let posted = false;
    const poster: Poster = async () => {
      posted = true;
      return true;
    };
    await notify("info", "hi", { telegramEnvPath: "/x", source: sourceAbsent(), poster });
    expect(posted).toBe(false);
    expect(logs.some((l) => l.includes("notify[info]: hi"))).toBe(true);
  });

  test("S8: POST failure logs the fallback line and still returns", async () => {
    const poster: Poster = async () => false;
    await notify("warn", "boom", {
      telegramEnvPath: "/x",
      source: source0600(),
      poster,
    });
    expect(logs.some((l) => l.includes("Telegram POST failed (journal alert still delivered)"))).toBe(
      true,
    );
  });

  test("a poster that throws never propagates", async () => {
    const poster: Poster = async () => {
      throw new Error("network down");
    };
    await expect(
      notify("warn", "x", { telegramEnvPath: "/x", source: source0600(), poster }),
    ).resolves.toBeUndefined();
  });
});
