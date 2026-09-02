// usage.ts — the fleet2 usage/help text (D1, §7 heredoc; F2/M1/M5/D3/D6/D16).
//
// Ported from fleetctl's usage() heredoc (main:3441-3490) with the declared
// phase-3 edits:
//   - `fleetctl` → `fleet2` throughout;
//   - line 1 states the VPS-side locality (F2/M1): list/ssh also run from the
//     laptop, everything else is VPS-side;
//   - status/check/rollout documented as phase-1-rebased aliases (D3/F9);
//   - install-timer line DROPPED, remove-timer line KEPT (M5/F7);
//   - FLEET_CONFIG default is /opt/grok-fleet/config.toml (D16/S5);
//   - rollout --dirty documented as accepted-for-compatibility (M4).

export const USAGE = `fleet2 — grok-fleet brain (VPS-side; list/ssh also run from the laptop)

Usage:
  fleet2 list                    discover grok-box-N peers (name, ts IP, online)
  fleet2 status [box...]         fleet inventory table (VPS-side; --json kept)
  fleet2 check [--notify]        health gate; exit 1 if any box unhealthy
  fleet2 rollout <box...>        deploy the resolved ref to explicit boxes
  fleet2 rollout --all [--canary <box>]
                                 deploy to the whole fleet (canary first,
                                 verify, abort on first verified failure)
  fleet2 rollout [--dirty] ...   --dirty accepted for compatibility (fleet2
                                 deploys the resolved ref, never the working tree)
  fleet2 ssh <box> [cmd...]      ssh into a box (or run a command)
  fleet2 remove-timer            remove the retired laptop check timer (run once per laptop)

Brain subcommands (docs/FLEET-BRAIN.md — VPS-side unless noted):
  fleet2 enroll <grok-box-N>     trust a box's reverse tunnel (OpenSSH/tailnet;
                                 ACL-prechecks tag:fleet-brain tagOwners), write
                                 the box's [fleet] vps/box_index, then wait for
                                 the reverse listener to come up (ENROLL_TUNNEL_WAIT).
                                 VPS-ONLY (refuses rc 6 if the fleet user is absent)
  fleet2 enroll --no-box-config <grok-box-N>
                                 as above but SKIP the box-side [fleet] write
  fleet2 reconcile [--apply]     the 5-min decision table (DRY-RUN by default)
  fleet2 rename [--dry-run] <old> <new>
                                 live-rename a box to the canonical grok-box-NNN
                                 (same index/port); copy-first, verify, then
                                 delete the old-name state. --dry-run prints the
                                 plan only.
  fleet2 config render <box>     print the box's rendered managed.toml (stdout)
  fleet2 config diff <box>       unified diff of on-box vs rendered (exit 1 on drift)
  fleet2 config push <box>       push the rendered managed.toml to ONE box (D5)
  fleet2 mint-key <grok-box-N>   mint a per-box tag-scoped key + atomic seed
  fleet2 fleet-status            brain table: API / tunnel / check / authkey / ver
  fleet2 serve [--bind <ip>] [--port <n>]
                                 run the tailnet-bound token-auth admin API
                                 (VPS-ONLY, refuses rc 6 off the VPS; port 9891)
  fleet2 tui [--utc]             laptop admin panel over the serve API (lane B)
                                 --utc: raw UTC timestamps, not local time
  fleet2 state check             report the state store: schema, integrity,
                                 rows, divergence findings (read-only)
  fleet2 state backup            take today's backup now (VACUUM INTO, keep 7)
  fleet2 state restore <file>    copy a backup over fleet.db (stop the timer first)
  fleet2 state import [--force]  replay the pre-5.8.0 files into the store
  fleet2 state reconcile-files [--apply]
                                 resolve a reported enrolled.tsv divergence
                                 (dry-run by default)
  fleet2 version | help

Environment:
  FLEET_SSH_PASSWORD   ssh password (else config.toml [ssh].password, else 12345678)
  FLEET_BOXES          space-separated box list, bypasses tailscale discovery
  FLEET_CONFIG         config path (default /opt/grok-fleet/config.toml)
  FLEET_MAX_CONCURRENCY  max concurrent rollouts (default 2)
  FLEET_ETC            brain secrets dir (default /etc/grok-fleet)
  FLEET_STATE          brain state dir (default /var/lib/grok-fleet)
  FLEET_VPS_ADDR       VPS address boxes dial for the tunnel; enroll writes it
                       to the box's [fleet].vps (else config [fleet].vps)
  FLEET_API_TOKEN_FILE Tailscale API token file (600; else [fleet-brain].api_token_file)
  ENROLL_TUNNEL_WAIT   seconds enroll waits for the reverse tunnel to come up
                       (default 90; 0 = skip the wait, for offline/test enrol)
`;

/** The usage text (trailing newline included). */
export function usage(): string {
  return USAGE;
}
