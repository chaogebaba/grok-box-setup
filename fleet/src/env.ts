// env.ts — the environment/path resolution seam, mirroring fleetctl:780-851.
//
// Every default here matches the bash brain so a hand-run fleet2 and the
// systemd unit agree, with ONE stated deviation: FLEET_CONFIG defaults to
// /opt/grok-fleet/config.toml (the unit's value, vps/install-vps.sh:208), NOT
// fleetctl's ~/.config/fleetctl/config.toml (blueprint S5).

export interface Env {
  FLEET_ETC: string;
  FLEET_STATE: string;
  FLEET_CONFIG: string;
  FLEET_BOX_KEY: string;
  FLEET_TELEGRAM_ENV: string;
  /** Membership override (space-separated), used by tests (F7.5). */
  FLEET_BOXES: string | undefined;
  /** Inventory concurrency cap (S3, same env name as fleetctl:50). */
  FLEET_MAX_CONCURRENCY: number;
  /** Set by the flock re-exec child so it does not re-lock (F2). */
  FLEET2_LOCKED: boolean;
  /** API token file path override (fleetctl api_token_file precedence head). */
  FLEET_API_TOKEN_FILE: string | undefined;
  /** git source override for rollout staging (compat with bash). */
  FLEET_ROLLOUT_SRC: string | undefined;
  /** git ref override for the upgrade target. */
  FLEET_TARGET_REF: string | undefined;
}

function get(source: Record<string, string | undefined>, key: string): string | undefined {
  const v = source[key];
  return v === undefined || v === "" ? undefined : v;
}

function toPositiveInt(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  if (!/^[0-9]+$/.test(v)) return fallback;
  const n = Number.parseInt(v, 10);
  return n > 0 ? n : fallback;
}

/**
 * Resolve the runtime environment from a process-env-like record (injectable
 * for tests). Pure — no side effects, no filesystem reads.
 */
export function resolveEnv(source: Record<string, string | undefined> = process.env): Env {
  const etc = get(source, "FLEET_ETC") ?? "/etc/grok-fleet";
  const state = get(source, "FLEET_STATE") ?? "/var/lib/grok-fleet";
  return {
    FLEET_ETC: etc,
    FLEET_STATE: state,
    FLEET_CONFIG: get(source, "FLEET_CONFIG") ?? "/opt/grok-fleet/config.toml",
    FLEET_BOX_KEY: get(source, "FLEET_BOX_KEY") ?? `${etc}/box_access_ed25519`,
    FLEET_TELEGRAM_ENV: get(source, "FLEET_TELEGRAM_ENV") ?? `${etc}/telegram.env`,
    FLEET_BOXES: get(source, "FLEET_BOXES"),
    FLEET_MAX_CONCURRENCY: toPositiveInt(get(source, "FLEET_MAX_CONCURRENCY"), 2),
    FLEET2_LOCKED: get(source, "FLEET2_LOCKED") === "1",
    FLEET_API_TOKEN_FILE: get(source, "FLEET_API_TOKEN_FILE"),
    FLEET_ROLLOUT_SRC: get(source, "FLEET_ROLLOUT_SRC"),
    FLEET_TARGET_REF: get(source, "FLEET_TARGET_REF"),
  };
}
