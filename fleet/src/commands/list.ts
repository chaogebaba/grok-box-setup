// list.ts — `grokfleet list` (D15/F8), the laptop-side tailnet discovery.
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
import type { ApiClient } from "../tui/api-client.ts";

const TAILSCALE_TIMEOUT_MS = 15_000;

export interface DiscoverRow {
  index: number;
  name: string;
  ip: string;
  online: string; // "yes" | "no"
  /**
   * S4 (memo B4): `snapshot_boxes.observed` verbatim, one of the seven
   * `Observed` names, or absent/"-" when it cannot be obtained (no API
   * configured, unreachable, or no snapshot row for this peer). Optional so
   * `DiscoverRow` stays the shared shape `reconcile/*` also builds — those
   * callers never populate it, and `renderList`/`renderListJson` default it.
   */
  observed?: string;
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
  // S4 (memo B4): OBSERVED is the new trailing column; ONLINE keeps its
  // meaning and its position.
  out.push(`${pad("NAME", 14)} ${pad("TAILSCALE IP", 16)} ${pad("ONLINE", 6)} OBSERVED`);
  for (const r of rows) {
    out.push(`${pad(r.name, 14)} ${pad(r.ip, 16)} ${pad(r.online, 6)} ${r.observed ?? "-"}`);
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
      {
        boxes: rows.map((r) => ({
          index: r.index,
          name: r.name,
          ip: r.ip,
          online: r.online === "yes",
          observed: r.observed ?? "-",
        })),
      },
      null,
      2,
    ) + "\n"
  );
}

/**
 * S4 (memo B4): the OBSERVED column's data path is the typed `ApiClient`,
 * resolved through `tui/config.ts` — NEVER the store, on either machine, the
 * same convention `grokfleet lease` follows. One `GET /v1/fleet` request
 * serves every row. An absent client, an unreachable API, an unconfigured
 * base URL, no snapshot row, or a name the fleet view does not carry all fold
 * to "-" — `list` must still work with no API configured.
 */
async function attachObserved(rows: DiscoverRow[], api: ApiClient | undefined): Promise<DiscoverRow[]> {
  if (api === undefined || rows.length === 0) return rows;
  const r = await api.fleet();
  if (!r.ok) return rows;
  const observed = new Map<string, string>();
  for (const b of r.value.boxes) if (b.observed !== undefined) observed.set(b.name, b.observed);
  return rows.map((row) => ({ ...row, observed: observed.get(row.name) ?? "-" }));
}

/** cmd_list: print the table (or the JSON document) to stdout, rc 0 always. */
export async function cmdList(
  runner: Runner,
  write: (s: string) => void,
  json = false,
  api?: ApiClient,
): Promise<number> {
  const rows = await attachObserved(await discover(runner), api);
  write(json ? renderListJson(rows) : renderList(rows) + "\n");
  return 0;
}
