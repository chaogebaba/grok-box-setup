// stage.ts — target resolution + tree staging (D7, F7.2/F7.9).
//
// resolveTarget(ref): best-effort `git fetch` (offline ⇒ warn, use local), then
// `git rev-parse --short <origin/ref or ref>` → sha (D1: the remote-tracking ref
// wins when it exists), `git show <sha>:VERSION` → version.
// stageTree(sha): `git archive --format=tar` to a temp .tar; zero-byte ⇒ error.
// The `src` must be a git repo or the command fails BEFORE touching any box
// (rc 3, message names the config key `[rollout].src`). Every git call goes
// through the Runner (no Bun.$).

import type { Runner } from "./runner.ts";
import { log } from "./log.ts";
import { ConfigError } from "./config.ts";

const FETCH_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 30_000;

export interface Target {
  ref: string;
  sha: string;
  version: string;
}

/** Seam over `mktemp`/`stat`/`rm` so tests avoid the real filesystem. */
export interface StageFs {
  mktempTar(): Promise<string>;
  sizeOf(path: string): Promise<number>;
  remove(path: string): Promise<void>;
}

export const nodeStageFs: StageFs = {
  async mktempTar() {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(`${tmpdir()}/grokfleet-stage-`);
    return `${dir}/tree.tar`;
  },
  async sizeOf(path) {
    const { statSync } = await import("node:fs");
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  },
  async remove(path) {
    const { rm } = await import("node:fs/promises");
    try {
      await rm(path, { force: true });
    } catch {
      /* best-effort */
    }
  },
};

/** Verify `src` is a git repository; throw ConfigError (rc 3) naming the key. */
export async function assertGitSrc(runner: Runner, src: string): Promise<void> {
  const r = await runner.run(["git", "-C", src, "rev-parse", "--git-dir"], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (r.code !== 0) {
    throw new ConfigError(
      `stage: [rollout].src '${src}' is not a git repository (git rev-parse --git-dir failed)`,
    );
  }
}

/**
 * Resolve a git ref to {ref, sha, version}. Fetch is best-effort (offline ⇒
 * warn). rev-parse failure ⇒ ConfigError rc 3. VERSION missing ⇒ "unknown".
 *
 * D1 — the REMOTE-TRACKING ref is resolved first when one exists.
 *
 * `[rollout].target` is `main`, and `main` in `[rollout].src` is a LOCAL branch
 * that a `git fetch` never advances: fetch updates `refs/remotes/origin/main`
 * and leaves the local branch exactly where the last checkout put it. The VPS
 * source tree is never checked out or pulled by grokfleet, so its `main` had been
 * frozen 77 commits behind `origin/main` since 30 Aug and the resolved target
 * sha never moved. Every box was therefore "at target" and no boxup release
 * could ever reach the fleet, with auto-rollout on or off.
 *
 * So: probe `refs/remotes/origin/<ref>` and, when it exists, resolve
 * `origin/<ref>`. A ref with no remote-tracking counterpart — a tag, a raw sha,
 * a purely local branch — falls through to the bare ref exactly as before.
 * `stageTree(sha)` is unchanged: `git archive` works on any reachable sha, and
 * no local branch is ever moved.
 *
 * When the FETCH fails, the remote-tracking ref still resolves — to the value of
 * the last successful fetch. That is the intended offline behaviour: an
 * unreachable origin means the fleet converges on the newest target the VPS has
 * actually seen, rather than falling back to a stale local branch or failing the
 * tick outright.
 */
export async function resolveTarget(runner: Runner, src: string, ref: string): Promise<Target> {
  await assertGitSrc(runner, src);
  // Best-effort fetch — offline is not fatal.
  const fetched = await runner.run(["git", "-C", src, "fetch", "--quiet", "origin"], {
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (fetched.code !== 0) {
    log(`stage: git fetch failed (offline?) — resolving '${ref}' against the local repo`);
  }
  // --verify --quiet: a pure existence probe. It prints nothing and returns
  // non-zero for a ref that is not there, so it never has to be parsed.
  const remoteProbe = await runner.run(
    ["git", "-C", src, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${ref}`],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  const useRemote = remoteProbe.code === 0;
  const resolveRef = useRemote ? `origin/${ref}` : ref;

  const rp = await runner.run(["git", "-C", src, "rev-parse", "--short", resolveRef], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (rp.code !== 0) {
    throw new ConfigError(`stage: cannot resolve target ref '${ref}' in '${src}'`);
  }
  const sha = rp.stdout.trim();
  const sv = await runner.run(["git", "-C", src, "show", `${sha}:VERSION`], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const version = sv.code === 0 ? sv.stdout.trim() : "unknown";
  // One line per tick, and only when the remote ref was the one used, so the
  // journal says which of the two refs the target came from.
  if (useRemote) {
    log(`stage: target ${ref} → origin/${ref} ${sha} (v${version})`);
  }
  return { ref, sha, version };
}

/**
 * Stage the tree for `sha` into a temp tarball via `git archive`. Returns the
 * tar path; a zero-byte archive throws (fleetctl:2974 precedent). The caller is
 * responsible for removing the tar via StageFs.remove after the run.
 */
export async function stageTree(runner: Runner, fs: StageFs, src: string, sha: string): Promise<string> {
  const tar = await fs.mktempTar();
  const r = await runner.run(["git", "-C", src, "archive", "--format=tar", "-o", tar, sha], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (r.code !== 0) {
    await fs.remove(tar);
    throw new ConfigError(`stage: git archive of '${sha}' from '${src}' failed`);
  }
  if ((await fs.sizeOf(tar)) === 0) {
    await fs.remove(tar);
    throw new ConfigError(`stage: git archive of '${sha}' produced an empty tree`);
  }
  return tar;
}
