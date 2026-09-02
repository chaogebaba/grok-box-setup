// keys.ts — Ink's (input, key) pair → the reducer's key vocabulary (D2).
//
// The reducer in `state.ts` speaks raw bytes ("\x1b[B", "\x7f", "\x03", …)
// because that is what the hand-rolled terminal core delivered. Ink delivers a
// parsed keypress instead, so this table is the whole translation layer — and
// the reducer's key arms are its contract. It replaces `splitKeys`.

import type { Key } from "ink";

export function toReducerKeys(input: string, key: Key): string[] {
  // Ctrl: only ctrl-c has a reducer arm. Every OTHER ctrl combination maps to
  // NOTHING, because Ink reports ctrl-P as input "p" — which would open the
  // config-push modal — and ctrl-T as "t", which would POST an unconfirmed
  // check. Those bytes are inert in the hand-rolled TUI and stay inert here.
  if (key.ctrl) return input === "c" ? ["\x03"] : [];
  // Alt/Meta combinations are inert too. The old `splitKeys` turned alt+j into
  // Esc-then-j by accident of byte splitting; that was never a feature.
  if (key.meta) return [];
  if (key.escape) return ["\x1b"];
  if (key.return) return ["\r"];
  if (key.backspace || key.delete) return ["\x7f"];
  if (key.tab) return ["\t"];
  if (key.upArrow) return ["\x1b[A"];
  if (key.downArrow) return ["\x1b[B"];
  if (key.leftArrow) return ["\x1b[D"];
  if (key.rightArrow) return ["\x1b[C"];
  // The reducer has no arm for these; unmapped is a no-op.
  if (key.pageUp || key.pageDown || key.home || key.end) return [];
  // Anything else is literal text. A multi-character chunk (a paste, or two
  // keys arriving in one read) is split into single characters so the reducer's
  // `key.length === 1` guards still hold — the old `splitKeys` semantics.
  return Array.from(input);
}
