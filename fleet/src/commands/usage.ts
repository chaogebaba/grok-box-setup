// usage.ts — the grokfleet usage/help text (D1, §7 heredoc; F2/M1/M5/D3/D6/D16;
// agent-ux U5).
//
// U5 reshaped it for greppability: ONE line per command, `  <cmd> <args>  —
// <one-line purpose>`, so `grokfleet help | grep enroll` yields a complete answer
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
// The `flags:` block and the closing `exit codes: grokfleet rc` pointer are U3/U5.

export const USAGE = `grokfleet — grok-fleet brain (VPS-side; list/ssh also run from the laptop)

Usage: grokfleet <command> [args] [flags]

Laptop or VPS:
  grokfleet list                              — discover grok-box-N peers (name, tailscale IP, online)
  grokfleet ssh <box> [cmd...]                — run ONE quoted command on a box, or open a session
  grokfleet tui [--utc]                       — laptop admin panel over the serve API
  grokfleet remove-timer                      — remove the retired laptop check timer (once per laptop)
  grokfleet rc                                — print the exit-code table
  grokfleet version                           — version, git sha and bun version
  grokfleet help                              — this text

VPS-side (refuse rc 6 elsewhere):
  grokfleet status [box...]                   — fleet inventory table + drift/mixed-version summary
  grokfleet check [--notify]                  — health gate; rc 1 if any box is unhealthy
  grokfleet inventory [box...]                — the raw inventory pass, no summary lines
  grokfleet upgrade [--to REF] <box...|--all> — plan a deploy; DRY-RUN unless --apply
  grokfleet rollout <box...|--all>            — upgrade --apply: canary first, verify, abort on failure
  grokfleet reconcile [--apply]               — the 5-min decision table (dry-run by default)
  grokfleet enroll [--no-box-config] <box>    — trust a box's reverse tunnel and record membership
  grokfleet rename [--dry-run] <old> <new>    — live-rename a box to canonical grok-box-NNN (same port)
  grokfleet retire [--forget] <box>           — un-enrol a box: retired, un-adoptable until enroll revives it
  grokfleet mint-key <box>                    — mint a per-box tag-scoped auth key and seed it
  grokfleet config render|diff|push <box>     — the box's managed.toml: print, compare (rc 1 on drift), push
  grokfleet fleet-status                      — brain table: API / tunnel / check / authkey / version
  grokfleet serve [--bind <ip>] [--port <n>]  — the tailnet-bound token-auth admin API (port 9891)
  grokfleet state check                       — report the state store: schema, integrity, rows, divergence
  grokfleet state backup                      — take today's backup now (VACUUM INTO, keep 7)
  grokfleet state restore <file>              — copy a backup over fleet.db (stop the timer first)
  grokfleet state import [--force]            — replay the pre-5.8.0 files into the store
  grokfleet state reconcile-files [--apply]   — resolve a reported enrolled.tsv divergence

flags:
  --json          one JSON document on stdout instead of the table — list, status, inventory,
                  version, rc, state check, state reconcile-files, upgrade --dry-run.
                  GROKFLEET_JSON=1 in the environment is equivalent wherever --json exists.
  --apply         actually act (reconcile, state reconcile-files, upgrade); default is dry-run
  --forget        retire: delete the row too, so the name is an ordinary candidate again
  --dry-run       plan only (reconcile, rename, retire)
  --utc           tui: raw UTC timestamps instead of local time (FLEET_TUI_UTC=1 equivalent)
  --tty           ssh: force a pty (ssh -t) for programs that need one
  --no-stdin      ssh: close the child's stdin instead of inheriting it
  --timeout <s>   ssh: kill the remote command after <s> seconds and exit 124
  --notify        check: send the unhealthy summary to Telegram
  --all           upgrade/rollout: every enrolled box, canary first
  --canary <box>  upgrade/rollout: override the canary for this pass
  --to <ref>      upgrade/rollout: the git ref to deploy
  --dirty         rollout: accepted for compatibility; grokfleet deploys the resolved ref, never the tree

For agents: stdout is DATA, stderr is diagnostics; pass ONE quoted command string
to \`grokfleet ssh\` (the words are joined with a space); no non-zero exit is silent.

Environment:
  FLEET_SSH_PASSWORD   ssh password (else config.toml [ssh].password, else 12345678)
  GROKFLEET_JSON          set to 1 to make every read command emit JSON
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

exit codes: grokfleet rc
`;

/** The usage text (trailing newline included). */
export function usage(): string {
  return USAGE;
}
