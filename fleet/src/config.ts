// config.ts — read $FLEET_CONFIG with Bun.TOML.parse (D5, S5, S6) and resolve
// the [rollout] table with the SAME env-over-config precedence the bash brain
// uses. Unknown keys → one info line, never fatal (D5). A parse error is rc 3
// with the file path + Bun's message (T7).

import { log } from "./log.ts";

export class ConfigError extends Error {
  constructor(
    msg: string,
    readonly rc: number = 3,
  ) {
    super(msg);
    this.name = "ConfigError";
  }
}

export interface RolloutConfig {
  /** git checkout the brain archives from (D5). */
  src: string;
  /** git ref: tag, branch, or sha (D5). */
  target: string;
  /** canary box name (D5/F3). */
  canary: string;
  /** verify poll count (D5, fleetctl:455 precedent = 8). */
  verifyTries: number;
  /** verify poll interval seconds (default 15). */
  verifyInterval: number;
  /** phase-2 D10/F8: gate auto-rollout in row d (default false). */
  auto: boolean;
}

/**
 * The CONFIG-pass canary (phase-2 F1/F2): `[fleet-brain].canary_box` with NO
 * default. Distinct from `RolloutConfig.canary` (which defaults to grok-box-008
 * for the rollout engine). Undefined ⇒ the config pass uses the DYNAMIC policy
 * (lowest-index enrolled box whose tunnel is up).
 */
export function configCanary(cfg: ParsedConfig): string | undefined {
  return asStr(cfg.fleetBrain["canary_box"]);
}

type Table = Record<string, unknown>;

function asTable(v: unknown): Table {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Table) : {};
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function asPosInt(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string" && /^[0-9]+$/.test(v)) {
    const n = Number.parseInt(v, 10);
    if (n > 0) return n;
  }
  return fallback;
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return fallback;
}

// `auto` is reserved for phase-2 (P1/P3 auto-rollout) — phase 1 IGNORES it
// entirely (no behaviour change for upgrade), it is listed here only so a config
// that pre-declares it does not emit a spurious "unknown key" info line.
const KNOWN_ROLLOUT_KEYS = new Set([
  "src",
  "target",
  "canary",
  "verify_tries",
  "verify_interval",
  "auto",
]);

export interface ParsedConfig {
  fleetBrain: Table;
  rollout: Table;
  /** The raw parsed object (empty when the file is absent). */
  raw: Table;
  /** True when the config file existed and parsed. */
  present: boolean;
}

/**
 * Parse the config text (or absence). `text` is the file content, or undefined
 * when the file does not exist (absence is NOT an error — every key has a
 * default). A malformed TOML string throws ConfigError (rc 3) with `path` in
 * the message (T7).
 */
export function parseConfig(text: string | undefined, path: string): ParsedConfig {
  if (text === undefined) {
    return { fleetBrain: {}, rollout: {}, raw: {}, present: false };
  }
  let raw: Table;
  try {
    raw = asTable(Bun.TOML.parse(text));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ConfigError(`config: cannot parse ${path}: ${msg}`);
  }
  const fleetBrain = asTable(raw["fleet-brain"]);
  const rollout = asTable(raw["rollout"]);
  // Unknown keys in [rollout] → one info line, never fatal (D5).
  for (const k of Object.keys(rollout)) {
    if (!KNOWN_ROLLOUT_KEYS.has(k)) {
      log(`config: unknown key [rollout].${k} ignored`);
    }
  }
  return { fleetBrain, rollout, raw, present: true };
}

export interface RolloutEnv {
  FLEET_ROLLOUT_SRC?: string | undefined;
  FLEET_TARGET_REF?: string | undefined;
}

/**
 * Resolve the [rollout] config with precedence (T7):
 *   src    : FLEET_ROLLOUT_SRC env > [rollout].src > [fleet-brain].rollout_src > /opt/grok-fleet/src
 *   target : FLEET_TARGET_REF env > [rollout].target > main
 *   canary : [rollout].canary > [fleet-brain].canary_box > grok-box-008
 *   verify_tries / verify_interval : [rollout].* > 8 / 15
 */
export function resolveRollout(cfg: ParsedConfig, env: RolloutEnv): RolloutConfig {
  const src =
    asStr(env.FLEET_ROLLOUT_SRC) ??
    asStr(cfg.rollout["src"]) ??
    asStr(cfg.fleetBrain["rollout_src"]) ??
    "/opt/grok-fleet/src";
  const target = asStr(env.FLEET_TARGET_REF) ?? asStr(cfg.rollout["target"]) ?? "main";
  const canary =
    asStr(cfg.rollout["canary"]) ?? asStr(cfg.fleetBrain["canary_box"]) ?? "grok-box-008";
  const verifyTries = asPosInt(cfg.rollout["verify_tries"], 8);
  const verifyInterval = asPosInt(cfg.rollout["verify_interval"], 15);
  const auto = asBool(cfg.rollout["auto"], false);
  return { src, target, canary, verifyTries, verifyInterval, auto };
}

/** Read + parse the config file from disk. Absence is not an error. */
export async function loadConfig(path: string): Promise<ParsedConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return parseConfig(undefined, path);
  const text = await file.text();
  return parseConfig(text, path);
}
