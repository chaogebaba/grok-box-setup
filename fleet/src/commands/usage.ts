// usage.ts — the fleet2 usage/help text (D1, §7 heredoc; F2/M1/M5/D3/D6/D16;
// agent-ux U5).
//
// U5 reshaped it for greppability: ONE line per command, `  <cmd> <args>  —
// <one-line purpose>`, so `fleet2 help | grep enroll` yields a complete answer
// instead of half a wrapped paragraph. No pager, no colour, no ANSI. The long
// prose that used to hang under each command lives in docs/FLEET-BRAIN.md.
//
// Kept from the original port:
//   - line 1 states the VPS-side locality (F2/M1): list/ssh also run from the
//     laptop, everything else is VPS-side;
//   - status/check/rollout are phase-1-rebased aliases (D3/F9);
//   - the install-timer line stays DROPPED, remove-timer stays (M5/F7);
//   - FLEET_CONFIG default is /opt/grok-fleet/config.toml (D16/S5);
//   - rollout --dirty is accepted for compatibility (M4).
//
// The `flags:` block and the closing `exit codes: fleet2 rc` pointer are U3/U5.

export const USAGE = `fleet2 — grok-fleet brain (VPS-side; list/ssh also run from the laptop)

Usage: fleet2 <command> [args] [flags]

Laptop or VPS:
  fleet2 list                              — discover grok-box-N peers (name, tailscale IP, online)
  fleet2 ssh <box> [cmd...]                — run ONE quoted command on a box, or open a session
  fleet2 tui                               — laptop admin panel over the serve API
  fleet2 remove-timer                      — remove the retired laptop check timer (once per laptop)
  fleet2 rc                                — print the exit-code table
  fleet2 version                           — version, git sha and bun version
  fleet2 help                              — this text

VPS-side (refuse rc 6 elsewhere):
  fleet2 status [box...]                   — fleet inventory table + drift/mixed-version summary
  fleet2 check [--notify]                  — health gate; rc 1 if any box is unhealthy
  fleet2 inventory [box...]                — the raw inventory pass, no summary lines
  fleet2 upgrade [--to REF] <box...|--all> — plan a deploy; DRY-RUN unless --apply
  fleet2 rollout <box...|--all>            — upgrade --apply: canary first, verify, abort on failure
  fleet2 reconcile [--apply]               — the 5-min decision table (dry-run by default)
  fleet2 enroll [--no-box-config] <box>    — trust a box's reverse tunnel and record membership
  fleet2 rename [--dry-run] <old> <new>    — live-rename a box to canonical grok-box-NNN (same port)
  fleet2 mint-key <box>                    — mint a per-box tag-scoped auth key and seed it
  fleet2 config render|diff|push <box>     — the box's managed.toml: print, compare (rc 1 on drift), push
  fleet2 fleet-status                      — brain table: API / tunnel / check / authkey / version
  fleet2 serve [--bind <ip>] [--port <n>]  — the tailnet-bound token-auth admin API (port 9891)
  fleet2 state check                       — report the state store: schema, integrity, rows, divergence
  fleet2 state backup                      — take today's backup now (VACUUM INTO, keep 7)
  fleet2 state restore <file>              — copy a backup over fleet.db (stop the timer first)
  fleet2 state import [--force]            — replay the pre-5.8.0 files into the store
  fleet2 state reconcile-files [--apply]   — resolve a reported enrolled.tsv divergence

flags:
  --json          one JSON document on stdout instead of the table — list, status, inventory,
                  version, rc, state check, state reconcile-files, upgrade --dry-run.
                  FLEET2_JSON=1 in the environment is equivalent wherever --json exists.
  --apply         actually act (reconcile, state reconcile-files, upgrade); default is dry-run
  --dry-run       plan only (reconcile, rename)
  --tty           ssh: force a pty (ssh -t) for programs that need one
  --no-stdin      ssh: close the child's stdin instead of inheriting it
  --timeout <s>   ssh: kill the remote command after <s> seconds and exit 124
  --notify        check: send the unhealthy summary to Telegram
  --all           upgrade/rollout: every enrolled box, canary first
  --canary <box>  upgrade/rollout: override the canary for this pass
  --to <ref>      upgrade/rollout: the git ref to deploy
  --dirty         rollout: accepted for compatibility; fleet2 deploys the resolved ref, never the tree

For agents: stdout is DATA, stderr is diagnostics; pass ONE quoted command string
to \`fleet2 ssh\` (the words are joined with a space); no non-zero exit is silent.

Environment:
  FLEET_SSH_PASSWORD   ssh password (else config.toml [ssh].password, else 12345678)
  FLEET2_JSON          set to 1 to make every read command emit JSON
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

exit codes: fleet2 rc
`;

/** The usage text (trailing newline included). */
export function usage(): string {
  return USAGE;
}
