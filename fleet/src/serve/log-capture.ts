// log-capture.ts — the per-request log tee (B3/§4).
//
// A handler runs its core(s) inside an AsyncLocalStorage scope holding a line
// buffer. The installed tee sink ALSO forwards every log() line to the process
// sink (journald keeps everything). `{log:[…]}` in a 200 body is the buffer's
// contents. Cores that log via the shared log() are captured transparently;
// cores that write through an injected `write()` get a buffer-backed writer.
//
// installCapture() is called ONCE at server start; it chains the existing sink
// so nothing that already logged to stderr/journald stops doing so.

import { AsyncLocalStorage } from "node:async_hooks";
import { setLogSink, type LogSink } from "../log.ts";

const als = new AsyncLocalStorage<string[]>();

let installed = false;

/** Install the tee sink once. Idempotent. */
export function installCapture(): void {
  if (installed) return;
  installed = true;
  const prev: LogSink = setLogSink((line) => {
    const buf = als.getStore();
    if (buf !== undefined) buf.push(line);
    prev(line); // always forward to journald/stderr
  });
}

/**
 * Run `fn` with a fresh capture buffer active; resolve to {value, log}. The
 * `log` array is every line log() emitted during `fn` (in order). Nested scopes
 * each get their own buffer (the innermost store wins).
 */
export async function withCapture<T>(fn: () => Promise<T> | T): Promise<{ value: T; log: string[] }> {
  const buf: string[] = [];
  const value = await als.run(buf, async () => fn());
  return { value, log: buf };
}

/** A buffer-backed writer for cores that take an injected write() (§4). */
export function captureWriter(): (s: string) => void {
  return (s: string) => {
    const buf = als.getStore();
    if (buf !== undefined) {
      // strip a single trailing newline so a writer line matches a log() line.
      buf.push(s.replace(/\n$/, ""));
    }
  };
}
