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

function readFlag(): boolean {
  // In dev/test the identifier is not defined; `typeof` guards the ReferenceError.
  // In the compiled binary `--define` replaces `IS_COMPILED` with the literal
  // `true`, so this collapses to `typeof true !== "undefined" ? true : false`.
  return typeof IS_COMPILED !== "undefined" ? IS_COMPILED : false;
}

export const isCompiled: boolean = readFlag();
