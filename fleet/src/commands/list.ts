// list.ts — `fleet2 list` (D15/F8), the laptop-side tailnet discovery.
//
// Ports cmd_list (main:218-229) + fleet_discover (main:122-146) VERBATIM in
// behaviour: `tailscale status --json`, keep every Peer whose HostName matches
// ^grok-box-([0-9]+)$, pick the first IPv4 TailscaleIP (else the first IP, else
// "-"), online = "yes"|"no", sort by decimal index. Header and row format:
//   printf '%-14s %-16s %-6s\n' NAME "TAILSCALE IP" ONLINE   (main:220,224)
// Empty fleet ⇒ `(no grok-box-N peers found on the tailnet)` (main:228). rc 0
// always. No state files, no tunnel — the tailnet CLI only (laptop-runnable,
// M1).

import type { Runner } from "../runner.ts";

const TAILSCALE_TIMEOUT_MS = 15_000;

export interface DiscoverRow {
  index: number;
  name: string;
  ip: string;
  online: string; // "yes" | "no"
}

const BOX_RE = /^grok-box-([0-9]+)$/;

/**
 * Parse a `tailscale status --json` body into sorted grok-box rows (pure).
 * Mirrors fleet_discover's python EXACTLY: IPv4 first (no `:`), else first IP,
 * else "-"; Online bool ⇒ yes/no; sort by the decimal index. Never throws.
 */
export function parseDiscover(body: string): DiscoverRow[] {
  let d: unknown;
  try {
    d = JSON.parse(body);
  } catch {
    return [];
  }
  const peers = (d as { Peer?: Record<string, unknown> })?.Peer;
  if (peers === null || typeof peers !== "object") return [];
  const rows: DiscoverRow[] = [];
  for (const peer of Object.values(peers as Record<string, unknown>)) {
    const p = peer as { HostName?: unknown; TailscaleIPs?: unknown; Online?: unknown };
    const name = String(p.HostName ?? "").trim();
    const m = BOX_RE.exec(name);
    if (!m) continue;
    const ips = Array.isArray(p.TailscaleIPs) ? (p.TailscaleIPs as unknown[]).map(String) : [];
    let ip = "";
    for (const cand of ips) {
      if (!cand.includes(":")) {
        ip = cand;
        break;
      }
    }
    if (ip === "" && ips.length > 0) ip = ips[0]!;
    const online = p.Online ? "yes" : "no";
    rows.push({ index: Number.parseInt(m[1]!, 10), name, ip: ip || "-", online });
  }
  rows.sort((a, b) => (a.index !== b.index ? a.index - b.index : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/** Render the list table body (header + rows + empty-fleet line), pure. */
export function renderList(rows: DiscoverRow[]): string {
  const out: string[] = [];
  out.push(`${pad("NAME", 14)} ${pad("TAILSCALE IP", 16)} ${pad("ONLINE", 6)}`);
  for (const r of rows) {
    out.push(`${pad(r.name, 14)} ${pad(r.ip, 16)} ${pad(r.online, 6)}`);
  }
  if (rows.length === 0) out.push("(no grok-box-N peers found on the tailnet)");
  return out.join("\n");
}

/** `tailscale status --json` over the Runner (2>/dev/null; "" on any failure). */
export async function discover(runner: Runner): Promise<DiscoverRow[]> {
  const r = await runner.run(["tailscale", "status", "--json"], { timeoutMs: TAILSCALE_TIMEOUT_MS });
  if (r.code !== 0) return [];
  return parseDiscover(r.stdout);
}

/**
 * The `--json` document (agent-ux U2): one object, key `boxes`, one entry per
 * discovered peer. `online` is a real boolean here — the "yes"/"no" strings are
 * a table-rendering detail, not data.
 */
export function renderListJson(rows: DiscoverRow[]): string {
  return (
    JSON.stringify(
      { boxes: rows.map((r) => ({ index: r.index, name: r.name, ip: r.ip, online: r.online === "yes" })) },
      null,
      2,
    ) + "\n"
  );
}

/** cmd_list: print the table (or the JSON document) to stdout, rc 0 always. */
export async function cmdList(runner: Runner, write: (s: string) => void, json = false): Promise<number> {
  const rows = await discover(runner);
  write(json ? renderListJson(rows) : renderList(rows) + "\n");
  return 0;
}
