// build-flags.ts — build-time constant injected by `bun build --define`.
//
// IS_COMPILED is `true` in the compiled binary (ts-build passes
// `--define IS_COMPILED=true`) and `false` under `bun run`/`bun test`. It drives
// the flock re-exec argv shape (G3/SHOULD-A): in a compiled binary
// `process.execPath` IS fleet2 and `process.argv[1]` is a synthetic `$bunfs`
// script path that must NOT be re-passed; under `bun run` `execPath` is bun and
// `argv[1]` is the entry .ts file which MUST be re-passed.
//
// `--define IS_COMPILED=true` performs a TEXTUAL substitution of the bare
// identifier `IS_COMPILED` at build time. We declare it as a global so the bare
// reference type-checks in dev, and read it through a guarded expression that
// falls back to `false` when the define is absent (dev/test).

declare const IS_COMPILED: boolean;
declare const FLEET2_GIT_SHA: string;

function readFlag(): boolean {
  // In dev/test the identifier is not defined; `typeof` guards the ReferenceError.
  // In the compiled binary `--define` replaces `IS_COMPILED` with the literal
  // `true`, so this collapses to `typeof true !== "undefined" ? true : false`.
  return typeof IS_COMPILED !== "undefined" ? IS_COMPILED : false;
}

export const isCompiled: boolean = readFlag();

// FLEET2_GIT_SHA — the git short-sha embedded at build time by
// `ts-build` (`--define FLEET2_GIT_SHA="<sha>"`). Empty in dev/test, where the
// runtime falls back to `git rev-parse` (see cli.ts resolveGitSha). This is the
// gate-r1 finding-1 fix: the COMPILED binary must print its OWN build sha, not
// re-run git in whatever directory it happens to be invoked from (which prints
// `unknown` on the VPS where there is no repo).
function readGitSha(): string {
  // `--define FLEET2_GIT_SHA="abc1234"` substitutes the bare identifier with the
  // string literal at build time; absent in dev ⇒ typeof guard yields "".
  return typeof FLEET2_GIT_SHA !== "undefined" ? FLEET2_GIT_SHA : "";
}

/** The build-embedded git sha, or "" when not injected (dev/test). */
export const buildGitSha: string = readGitSha();
