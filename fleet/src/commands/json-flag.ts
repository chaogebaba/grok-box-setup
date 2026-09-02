// json-flag.ts — the ONE `--json` / `FLEET2_JSON` decision (agent-ux U2).
//
// Every read command answers to the same two switches: the `--json` flag, and
// `FLEET2_JSON=1` in the environment so an agent can set it once for a whole
// session instead of threading a flag through every call. Both are read here so
// the two can never disagree per command (mutant (b): drop the env check).

/** Values that turn FLEET2_JSON OFF even when it is set (a set-but-empty var). */
const FALSEY = new Set(["", "0", "false", "no", "off"]);

/** True iff `FLEET2_JSON` in `source` asks for JSON. */
export function envWantsJson(source: Record<string, string | undefined> = process.env): boolean {
  const v = source["FLEET2_JSON"];
  if (v === undefined) return false;
  return !FALSEY.has(v.trim().toLowerCase());
}

/** True iff `--json` is present in `args` OR `FLEET2_JSON` asks for it. */
export function wantsJson(
  args: readonly string[],
  source: Record<string, string | undefined> = process.env,
): boolean {
  return args.includes("--json") || envWantsJson(source);
}
