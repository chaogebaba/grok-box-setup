// dispatch.ts — the fleet2 command router decisions (D1/F10), pure + testable.
//
// Ports the bash dispatch (main:3850-3874): `cmd="${1:-help}"`; bare/`-h`/
// `--help`/`help` ⇒ usage on STDOUT rc 0; `version|--version` ⇒ the version
// string on stdout rc 0; a KNOWN command ⇒ routed; unknown ⇒
// `fleet2: unknown command: <cmd>` + usage BOTH on STDERR rc 2 (m11).
//
// This module decides ROUTING + the help/version/unknown streams; the concrete
// command implementations are wired in cli.ts main() (they need the runtime env
// / runner / API seams). Keeping the decision here lets dispatch.test.ts assert
// stream + rc of every documented subcommand without spawning a process.

import { USAGE } from "./usage.ts";

/** Version string shape: `fleet2 <ver> (<sha>) (bun <v>)`. */
export function versionString(pkgVersion: string, sha: string, bunVersion: string): string {
  return `fleet2 ${pkgVersion} (${sha}) (bun ${bunVersion})`;
}

/** Every documented subcommand (for the router + T6 "every subcommand routes"). */
export const KNOWN_COMMANDS = [
  "list",
  "status",
  "check",
  "rollout",
  "ssh",
  "remove-timer",
  "install-timer", // retired stub, still routed (D6)
  "enroll",
  "reconcile",
  "rename",
  "retire", // state-store D4: un-enrol a box and keep the name un-adoptable
  "config",
  "mint-key",
  "fleet-status",
  "inventory",
  "upgrade",
  "serve", // TUI-D11: the VPS-side admin API (VPS-only, locality-guarded)
  "tui", // TUI-D11: the laptop admin panel (lane B)
  "state", // state-store D8: check/backup/restore/import/reconcile-files
] as const;

export type KnownCommand = (typeof KNOWN_COMMANDS)[number];

export interface DispatchDecision {
  /** "help" ⇒ print usage stdout; "version" ⇒ print version stdout; */
  /** "route" ⇒ run KnownCommand `command`; "unknown" ⇒ stderr usage + rc 2. */
  kind: "help" | "version" | "route" | "unknown";
  command?: KnownCommand;
  /** for help/version/unknown: the rc to return. */
  rc?: number;
  /** the raw unknown command name (for the error line). */
  unknownName?: string;
}

/** Decide the route for argv[0] (the subcommand). `cmd` undefined ⇒ bare fleet2. */
export function decide(cmd: string | undefined): DispatchDecision {
  if (cmd === undefined || cmd === "help" || cmd === "-h" || cmd === "--help") {
    // bare/`help`/`-h`/`--help` ⇒ usage on STDOUT rc 0 (F10; bash `${1:-help}`).
    return { kind: "help", rc: 0 };
  }
  if (cmd === "version" || cmd === "--version") {
    return { kind: "version", rc: 0 };
  }
  if ((KNOWN_COMMANDS as readonly string[]).includes(cmd)) {
    return { kind: "route", command: cmd as KnownCommand };
  }
  return { kind: "unknown", rc: 2, unknownName: cmd };
}

/** Emit help/version/unknown to the right stream; returns the rc. */
export function emit(
  decision: DispatchDecision,
  versionLine: string,
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  switch (decision.kind) {
    case "help":
      out(USAGE);
      return decision.rc ?? 0;
    case "version":
      out(versionLine + "\n");
      return 0;
    case "unknown":
      // BOTH lines on STDERR (m11): the error then the usage.
      err(`fleet2: unknown command: ${decision.unknownName}\n`);
      err(USAGE);
      return 2;
    case "route":
      return 0; // caller runs the command
  }
}
