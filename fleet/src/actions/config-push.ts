// config-push.ts — push_managed port (main:2138-2298).
//
// rc map:
//   0  in sync / pushed / dry-run OK
//   3  remote stdin sha mismatch (returned verbatim)
//   4  render failure OR D4 validation refusal (brain-side content)
//   5  read-back mismatch OR remote ran but emitted NO status line (E2)
//   6  transport unreachable — ssh rc 255 ONLY
//   other  a non-3 rc that DID emit a status line ⇒ returned VERBATIM (S2)
//
// The rendered text arrives on the box over STDIN; the remote script runs under
// `sudo sh -c '<script>'`. Unknown-but-well-formed keys are accumulated into an
// optional run-scoped sink (deduped) and logged once by the pass; outside a pass
// they are logged here.

import type { Runner } from "../runner.ts";
import type { Env } from "../env.ts";
import { tunnelSsh } from "../tunnel.ts";
import { classify } from "../runner.ts";
import { renderManaged, unknownManagedKeys } from "../managed/render.ts";
import { validateManaged } from "../managed/validate.ts";
import {
  managedRemoteScript,
  wrapSudoShC,
  textSha256,
  parseStatusTokens,
  hadStatus,
} from "../managed/remote-script.ts";
import { log } from "../log.ts";

const PUSH_TIMEOUT_MS = 20_000;

/** Source of the managed inputs for a box (fleet-wide + per-box contents). */
export interface ManagedSource {
  /** fleet.toml contents, or undefined when absent. */
  fleetToml(): string | undefined;
  /** boxes/<box>.toml contents, or undefined when absent. */
  boxToml(box: string): string | undefined;
}

export interface PushDeps {
  runner: Runner;
  env: Env;
  source: ManagedSource;
  /** run-scoped dedup sink for unknown keys (undefined ⇒ log here per-call). */
  unknownSink?: Set<string>;
}

export interface PushResult {
  rc: number;
  /**
   * The box's CURRENT managed.toml sha (`cur=` token), when the remote script
   * ran and emitted a status line; otherwise undefined. Added for TUI-D4 so the
   * config pass can derive the snapshot's per-box `config` field
   * ("in-sync"|"drift") without a second probe. Behavior-preserving (TUI-D1):
   * every existing caller reads only `.rc`.
   */
  cur?: string;
  /** The WANT sha (the rendered managed.toml sha) for this box, when computed. */
  want?: string;
}

/** push_managed <box> [--dry-run]. */
export async function pushManaged(box: string, dry: boolean, deps: PushDeps): Promise<PushResult> {
  const fleetToml = deps.source.fleetToml();
  const boxToml = deps.source.boxToml(box);

  // render (never throws here — renderManaged is pure over the provided text).
  const text = renderManaged(fleetToml, boxToml);

  // D4 validate.
  const v = validateManaged(text);
  if (!v.ok) {
    log(`config: ${box} render REFUSED by D4 validation — ${v.reasons[0]}`);
    return { rc: 4 };
  }

  // forward-compat unknown keys
  const unknown = unknownManagedKeys(text);
  if (unknown.length > 0) {
    if (deps.unknownSink) {
      for (const u of unknown) deps.unknownSink.add(u);
    } else {
      const list = [...unknown].sort().join(" ");
      log(`config: ${box} unknown-but-well-formed keys (allowed, forward-compat): ${list}`);
    }
  }

  const wantSha = await textSha256(text);
  const remote = managedRemoteScript(wantSha, dry ? 1 : 0);
  const cmd = wrapSudoShC(remote);
  const r = await tunnelSsh(deps.runner, box, deps.env.FLEET_BOX_KEY, cmd, {
    // `text` already ends in exactly one trailing newline (renderManaged),
    // matching bash's `printf '%s\n' "$text"` canonical bytes — send it AS-IS so
    // the STDIN bytes the box hashes equal want_sha (gate-r1 fix: an extra `\n`
    // here + in textSha256 hashed a double newline, disagreeing with bash).
    stdin: text,
    timeoutMs: PUSH_TIMEOUT_MS,
  });
  const out = r.stdout;
  const status = hadStatus(out);

  if (r.code !== 0) {
    // transport = ssh rc 255 (classify maps 255 ⇒ transport; killed ⇒ null).
    const cls = classify(r);
    if (r.code === 255 || cls === "transport") {
      log(`config: ${box} unreachable over tunnel (ssh rc=255) — no change applied`);
      return { rc: 6, want: wantSha };
    }
    if (r.code !== 3 && !status) {
      log(`config: ${box} remote script FAILED (rc=${r.code}, no status line) — no change applied`);
      return { rc: 5, want: wantSha };
    }
    log(`config: ${box} push FAILED (rc=${r.code}) — no change applied`);
    return { rc: r.code ?? 5, want: wantSha };
  }

  const tok = parseStatusTokens(out);
  const cur = tok?.cur ?? "";
  const nowSha = tok?.sha ?? "";
  const support = tok?.support ?? "";
  const enabled = tok?.enabled ?? "";

  let ann = "";
  if (enabled === "false") ann += " [IGNORED locally: [managed] enabled=false]";
  if (enabled === "unknown")
    ann += " [enabled UNKNOWN: box managed-status probe failed — cannot confirm the file is honoured]";
  if (support === "no") ann += " [inert: boxup lacks managed support — deploy boxup first]";

  if (dry) {
    if (cur === wantSha) log(`config: ${box} in sync${ann}`);
    else log(`config: ${box} WOULD push (${cur || "none"}->${wantSha})${ann}`);
    return { rc: 0, cur, want: wantSha };
  }

  if (nowSha !== wantSha) {
    log(`config: ${box} push read-back MISMATCH (got ${nowSha || "none"}, want ${wantSha})`);
    return { rc: 5, cur, want: wantSha };
  }
  if (cur === wantSha) log(`config: ${box} in sync${ann}`);
  else log(`config: ${box} pushed (${cur || "none"}->${wantSha})${ann}`);
  return { rc: 0, cur, want: wantSha };
}
