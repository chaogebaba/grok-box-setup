// remote.ts — remote command construction (D4, F5, F6, G1, H1).
//
// Every value interpolated into a remote command is validated against the F6
// charset ^[A-Za-z0-9_./:@-]+$ and refused otherwise (T4b, m14). The rendered
// install command and the poll command contain NO apostrophe and NO backtick —
// a VOLUNTARY invariant (F5) scanned by T4 (m5), so the constants stay safe if a
// future caller ever wraps them in `sudo sh -c '…'`.

/** The fixed remote paths (F5). No spaces, no metacharacters. */
export const REMOTE_TAR = "/tmp/grok-box-setup-brain.tar";
export const REMOTE_DIR = "/tmp/grok-box-setup-brain";
/** The box's install log the box truncates + the detached phase appends to. */
export const INSTALL_LOG = "/var/log/boxup-install.log";
/** Bytes of the tail we read when polling for the DONE marker (H1). */
export const POLL_TAIL_BYTES = 4096;

/** F6 charset: the ONLY characters allowed in an interpolated remote value. */
export const REMOTE_VALUE_RE = /^[A-Za-z0-9_./:@-]+$/;

export class UnsafeRemoteValueError extends Error {
  constructor(
    readonly parameter: string,
    readonly value: string,
  ) {
    super(`unsafe remote value for '${parameter}': refusing to send [${value}]`);
    this.name = "UnsafeRemoteValueError";
  }
}

/** Validate an interpolated remote value (F6). Throws UnsafeRemoteValueError. */
export function assertRemoteValue(parameter: string, value: string): void {
  if (!REMOTE_VALUE_RE.test(value)) {
    throw new UnsafeRemoteValueError(parameter, value);
  }
}

/**
 * Render the install command (single line, `;`-joined) per G1 + H1. The leading
 * `sudo truncate -s 0 <log>` (H1) means fleet2 owns the log truncation, so the
 * only writer between the truncate and our DONE match is this run's detached
 * phase. `BOX_SETUP_ONCE=1` (G1) forces the detached path so the DONE marker is
 * always written and no foreground `boxup once` races the detached one.
 *
 * `sha` is validated (F6); a bad sha throws before any string is built.
 */
export function renderInstallCommand(sha: string): string {
  assertRemoteValue("sha", sha);
  return (
    `set -e; ` +
    `sudo truncate -s 0 ${INSTALL_LOG}; ` +
    `[ -f ${REMOTE_TAR} ] || { echo ROLLOUT_NO_ARTIFACT >&2; exit 4; }; ` +
    `rm -rf ${REMOTE_DIR}; ` +
    `mkdir -p ${REMOTE_DIR}; ` +
    `tar -xf ${REMOTE_TAR} -C ${REMOTE_DIR}; ` +
    `sudo env BOX_SETUP_GIT_SHA=${sha} BOX_SETUP_ONCE=1 bash ${REMOTE_DIR}/install.sh; ` +
    `rm -rf ${REMOTE_DIR} ${REMOTE_TAR}`
  );
}

/** The verify-poll command (H1): read the tail of the log; no sh -c, no quotes. */
export const POLL_COMMAND = `sudo tail -c ${POLL_TAIL_BYTES} ${INSTALL_LOG}`;

/** `boxup check` over the tunnel (S2/G4). One call gives rc + status on health. */
export const CHECK_COMMAND = "sudo /workspace/box-setup/boxup check";

/** `boxup status` — the second probe only used for an unhealthy box (G4/S-C). */
export const STATUS_COMMAND = "sudo /workspace/box-setup/boxup status";

/**
 * Match the LAST `DONE (rc=N)` line in a slice (H1). Returns the rc, or null
 * when no marker is present. Because fleet2 truncated the log itself, any DONE
 * in the slice is this run's by construction.
 */
export function matchDoneRc(slice: string): number | null {
  const re = /DONE \(rc=([0-9]+)\)/g;
  let last: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slice)) !== null) {
    last = Number.parseInt(m[1]!, 10);
  }
  return last;
}

/** Every exported remote-command string, for the T4 apostrophe/backtick scan. */
export function remoteCommandConstants(): string[] {
  return [
    // renderInstallCommand with a representative sha (chars in the F6 set).
    renderInstallCommand("deadbeef"),
    POLL_COMMAND,
    CHECK_COMMAND,
    STATUS_COMMAND,
  ];
}
