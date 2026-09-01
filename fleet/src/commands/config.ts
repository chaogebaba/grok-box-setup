// config.ts — `fleet2 config render|diff|push <box>` (D12/F12), the operator
// managed-config surface. Ports cmd_config (main:3326-3404); reuses the phase-2
// managed/* render/validate/remote-script and actions/config-push.ts:pushManaged
// (D1 REUSE clause). NO JS diff library (Q5/F12): `diff` shells out to diff(1).
//
// usage/refusal rc 2 lines VERBATIM (fleetctl → fleet2):
//   bad sub          `fleet2 config: usage: config render|diff|push <box>`  (main:3331)
//   missing box      `fleet2 config <sub>: need a box name`                 (main:3333)
//   not enrolled     `fleet2 config <sub>: <box> is not enrolled (not in enrolled.tsv) — refusing` (main:3335)
//
// render: renderManaged to stdout, rc 0.
// push:   pushManaged(box, dry=false), rc = its E2 rc map (0/3/4/5/6/…).
// diff:   dry-run remote script (managedRemoteScript(want,1)) over the tunnel,
//         parse the `---FILE---` body, `diff -u --label` on-box vs rendered
//         (F12: operands onbox+"\n" and text; diff rc IGNORED), NOTE lines
//         verbatim, rc 0 ONLY iff cur==want && enabled∉{false,unknown} &&
//         support!=no, else 1. diff(1) absent ⇒ rc 2 (F12).

import type { Runner } from "../runner.ts";
import type { Env } from "../env.ts";
import { tunnelSsh, tunnelUp } from "../tunnel.ts";
import { knownHostsFile } from "../hostkey.ts";
import { parseEnrolled } from "../boxes.ts";
import { renderManaged } from "../managed/render.ts";
import { validateManaged } from "../managed/validate.ts";
import { managedRemoteScript, wrapSudoShC, textSha256 } from "../managed/remote-script.ts";
import { pushManaged, type ManagedSource } from "../actions/config-push.ts";
import { log } from "../log.ts";

const DIFF_TIMEOUT_MS = 20_000;
const DRYRUN_TIMEOUT_MS = 20_000;

/** A ManagedSource backed by $FLEET_ETC/fleet.toml + $FLEET_ETC/boxes/<box>.toml. */
export function fsManagedSource(env: Env): ManagedSource {
  const readIf = (p: string): string | undefined => {
    try {
      const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
      return existsSync(p) ? readFileSync(p, "utf8") : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    fleetToml: () => readIf(`${env.FLEET_ETC}/fleet.toml`),
    boxToml: (box: string) => readIf(`${env.FLEET_ETC}/boxes/${box}.toml`),
  };
}

/** Read enrolled.tsv membership (reconcile_target_boxes basis). */
function enrolledBoxes(env: Env): string[] {
  try {
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    const f = `${env.FLEET_STATE}/enrolled.tsv`;
    if (!existsSync(f)) return [];
    return parseEnrolled(readFileSync(f, "utf8"));
  } catch {
    return [];
  }
}

export interface ConfigDeps {
  runner: Runner;
  env: Env;
  source?: ManagedSource;
  /** enrolled.tsv membership override (tests). */
  enrolled?: string[];
  /** stdout sink for `render` and the diff body (defaults to process.stdout). */
  write?: (s: string) => void;
  /** `command -v diff` seam (tests); returns the path or undefined. */
  whichDiff?: () => Promise<string | undefined>;
}

/** cmd_config <sub> <box>. */
export async function cmdConfig(args: string[], deps: ConfigDeps): Promise<number> {
  const sub = args[0] ?? "";
  const box = args[1] ?? "";
  const write = deps.write ?? ((s: string) => process.stdout.write(s));

  if (sub !== "render" && sub !== "diff" && sub !== "push") {
    process.stderr.write("fleet2 config: usage: config render|diff|push <box>\n");
    return 2;
  }
  if (box === "") {
    process.stderr.write(`fleet2 config ${sub}: need a box name\n`);
    return 2;
  }
  const membership = deps.enrolled ?? enrolledBoxes(deps.env);
  if (!membership.includes(box)) {
    process.stderr.write(
      `fleet2 config ${sub}: ${box} is not enrolled (not in enrolled.tsv) — refusing\n`,
    );
    return 2;
  }

  const source = deps.source ?? fsManagedSource(deps.env);

  if (sub === "render") {
    const text = renderManaged(source.fleetToml(), source.boxToml(box));
    write(text);
    return 0;
  }

  if (sub === "push") {
    const r = await pushManaged(box, false, { runner: deps.runner, env: deps.env, source });
    return r.rc;
  }

  // diff.
  const text = renderManaged(source.fleetToml(), source.boxToml(box));
  const v = validateManaged(text);
  if (!v.ok) {
    process.stderr.write(`fleet2 config diff: ${box} render REFUSED by D4 — ${v.reasons[0]}\n`);
    return 2;
  }

  const whichDiff = deps.whichDiff ?? defaultWhichDiff;
  const diffPath = await whichDiff();
  if (diffPath === undefined) {
    process.stderr.write("fleet2 config diff: diff(1) not found\n");
    return 2;
  }

  // D11(c): the ONE tunnel caller that used to dial without asking whether the
  // listener is ours. A squatter on a member port must read as `tunnel: down` on
  // every path, CLI included — otherwise this human-invoked diff would hand a
  // foreign listener the rendered managed config on stdin.
  if (!(await tunnelUp(deps.runner, box))) {
    process.stderr.write(`fleet2 config diff: ${box} tunnel down\n`);
    return 2;
  }

  const wantSha = await textSha256(text);
  const remote = managedRemoteScript(wantSha, 1);
  const dry = await tunnelSsh(deps.runner, box, deps.env.FLEET_BOX_KEY, wrapSudoShC(remote), {
    stdin: text,
    timeoutMs: DRYRUN_TIMEOUT_MS,
    knownHosts: knownHostsFile(deps.env),
  });
  if (dry.code !== 0) {
    process.stderr.write(`fleet2 config diff: ${box} unreachable/failed (rc=${dry.code ?? "killed"})\n`);
    return 2;
  }

  // Split at the ---FILE--- marker (main:3373-3374).
  const lines = dry.stdout.split("\n");
  const statusLine = lines.find((l) => /(^| )cur=/.test(l)) ?? "";
  const markerIdx = lines.indexOf("---FILE---");
  const onboxBody = markerIdx >= 0 ? lines.slice(markerIdx + 1).join("\n") : "";
  let cur = "";
  let support = "";
  let enabled = "";
  for (const tok of statusLine.trim().split(/\s+/)) {
    if (tok.startsWith("cur=")) cur = tok.slice(4);
    else if (tok.startsWith("support=")) support = tok.slice(8);
    else if (tok.startsWith("enabled=")) enabled = tok.slice(8);
  }

  // Unified diff on-box (current) vs rendered (desired). F2/F12 (r1 gate fix):
  // bash captures both operands via `$(...)` — which STRIPS all trailing
  // newlines — then re-adds exactly ONE via `printf '%s\n'`. So each operand is
  // normalised to EXACTLY one trailing newline regardless of how many the raw
  // body carried. fleet2's old `onboxBody + "\n"` double-newlined a remote body
  // that already ended in `\n`, emitting a spurious trailing blank line on every
  // real box. Normalise both operands the bash way: drop trailing \n, add one.
  const oneTrailingNl = (s: string): string => s.replace(/\n+$/, "") + "\n";
  const diffOut = await runDiff(deps.runner, diffPath, {
    onbox: oneTrailingNl(onboxBody),
    rendered: oneTrailingNl(text),
    box,
  });
  if (diffOut !== "") write(diffOut);

  // NOTE lines (main:3388-3395), verbatim, ALWAYS printed for an ignored/
  // unverifiable file so we never report in-sync for one.
  if (enabled === "false")
    write(`NOTE: [managed] enabled=false on ${box} — pushed values are IGNORED on this box\n`);
  if (enabled === "unknown")
    write(
      `NOTE: could not read [managed] enabled on ${box} (managed-status probe failed) — cannot confirm pushed values are honoured\n`,
    );
  if (support === "no")
    write(`NOTE: boxup on ${box} lacks managed support — pushed values are IGNORED (deploy boxup first)\n`);

  // rc 0 in sync ONLY if cur==want && enabled not false/unknown && support!=no.
  if (cur === wantSha && enabled !== "false" && enabled !== "unknown" && support !== "no") {
    return 0;
  }
  return 1;
}

/** Default `command -v diff` (Bun.which). */
async function defaultWhichDiff(): Promise<string | undefined> {
  const p = Bun.which("diff");
  return p ?? undefined;
}

/**
 * Run `diff -u <onboxTmp> <renderedTmp> --label on-box:<box>/managed.toml
 * --label rendered:<box>` and return stdout. diff's own rc is IGNORED (bash
 * `|| true`, F12). Uses two temp files under FLEET-independent os.tmpdir since
 * this is a local diff, not a remote write.
 */
async function runDiff(
  runner: Runner,
  diffPath: string,
  arg: { onbox: string; rendered: string; box: string },
): Promise<string> {
  const { mkdtempSync, writeFileSync, rmSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "fleet2-diff-"));
  const onboxFile = join(dir, "onbox");
  const rendFile = join(dir, "rendered");
  try {
    writeFileSync(onboxFile, arg.onbox);
    writeFileSync(rendFile, arg.rendered);
    const r = await runner.run(
      [
        diffPath,
        "-u",
        onboxFile,
        rendFile,
        "--label",
        `on-box:${arg.box}/managed.toml`,
        "--label",
        `rendered:${arg.box}`,
      ],
      { timeoutMs: DIFF_TIMEOUT_MS },
    );
    return r.stdout;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

void log;
