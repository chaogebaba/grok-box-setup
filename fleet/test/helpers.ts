// helpers.ts — small test fixtures shared across the suite.

import type { Env } from "../src/env.ts";
import type { RolloutConfig } from "../src/config.ts";

export function testEnv(over: Partial<Env> = {}): Env {
  return {
    FLEET_ETC: "/etc/grok-fleet",
    FLEET_STATE: "/var/lib/grok-fleet",
    FLEET_CONFIG: "/opt/grok-fleet/config.toml",
    FLEET_BOX_KEY: "/etc/grok-fleet/box_access_ed25519",
    FLEET_TELEGRAM_ENV: "/etc/grok-fleet/telegram.env",
    FLEET_BOXES: undefined,
    FLEET_MAX_CONCURRENCY: 2,
    FLEET2_LOCKED: false,
    FLEET_API_TOKEN_FILE: undefined,
    FLEET_ROLLOUT_SRC: undefined,
    FLEET_TARGET_REF: undefined,
    FLEET_TS_API: "https://api.tailscale.com/api/v2",
    FLEET_TS_TAILNET: "-",
    ...over,
  };
}

export function testRollout(over: Partial<RolloutConfig> = {}): RolloutConfig {
  return {
    src: "/opt/grok-fleet/src",
    target: "main",
    canary: "grok-box-008",
    // small values so verify loops don't take real time; sleep is stubbed anyway
    verifyTries: 3,
    verifyInterval: 0,
    ...over,
  };
}

/** A representative full boxup status line (S1 field order: tunnel= LAST). */
export const FULL_STATUS_LINE =
  "backend=tailscale online=yes exit-node=no sshd=yes ipfwd=4:1,6:1 " +
  "tailscaled=123 selfheal=456 worker=456 hb=ok name=grok-box-008 v=5.3.0/abc1234 " +
  "tags=tag:box keyexpiry=disabled tunnel=up";
