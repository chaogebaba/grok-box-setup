// keys.test.ts — the Ink keypress → reducer-key table (fleet-tui-ink D2).
//
// The reducer in state.ts speaks raw bytes; Ink speaks a parsed keypress. This
// table is the entire translation, so it is pinned key by key — and the three
// deliberate NO-OPS (ctrl combinations other than ctrl-c, alt/meta, and the
// navigation keys the reducer has no arm for) are pinned as hard as the rest,
// because mapping ctrl-P to "P" would open the config-push modal.

import { test, expect, describe } from "bun:test";
import type { Key } from "ink";
import { toReducerKeys } from "../../src/tui/keys.ts";

function key(over: Partial<Key> = {}): Key {
  return {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageDown: false, pageUp: false, home: false, end: false,
    return: false, escape: false, ctrl: false, shift: false, tab: false,
    backspace: false, delete: false, meta: false,
    super: false, hyper: false, capsLock: false, numLock: false,
    ...over,
  };
}

describe("plain text", () => {
  test("a letter is itself", () => {
    expect(toReducerKeys("q", key())).toEqual(["q"]);
    expect(toReducerKeys("/", key())).toEqual(["/"]);
  });
  test("shift+letter arrives already uppercase — the view and action keys", () => {
    expect(toReducerKeys("D", key({ shift: true }))).toEqual(["D"]);
    expect(toReducerKeys("P", key({ shift: true }))).toEqual(["P"]);
  });
  test("a multi-character chunk is split into single characters", () => {
    // a paste, or two keys arriving in one read. The reducer's `length === 1`
    // guards depend on this (it is the old `splitKeys` semantics).
    expect(toReducerKeys("ab", key())).toEqual(["a", "b"]);
    expect(toReducerKeys("grok", key())).toEqual(["g", "r", "o", "k"]);
  });
});

describe("named keys", () => {
  test("escape, return, backspace/delete, tab", () => {
    expect(toReducerKeys("", key({ escape: true }))).toEqual(["\x1b"]);
    expect(toReducerKeys("", key({ return: true }))).toEqual(["\r"]);
    expect(toReducerKeys("", key({ backspace: true }))).toEqual(["\x7f"]);
    expect(toReducerKeys("", key({ delete: true }))).toEqual(["\x7f"]);
    expect(toReducerKeys("", key({ tab: true }))).toEqual(["\t"]);
  });
  test("the arrows keep the byte sequences the reducer's arms match", () => {
    expect(toReducerKeys("", key({ upArrow: true }))).toEqual(["\x1b[A"]);
    expect(toReducerKeys("", key({ downArrow: true }))).toEqual(["\x1b[B"]);
    expect(toReducerKeys("", key({ leftArrow: true }))).toEqual(["\x1b[D"]);
    expect(toReducerKeys("", key({ rightArrow: true }))).toEqual(["\x1b[C"]);
  });
});

describe("the deliberate no-ops", () => {
  test("ctrl-c is the ONLY ctrl combination that reaches the reducer", () => {
    expect(toReducerKeys("c", key({ ctrl: true }))).toEqual(["\x03"]);
  });
  test("every other ctrl combination maps to NOTHING", () => {
    // Ink reports ctrl-P as input "p". Mapping it to the bare letter would open
    // the config-push modal; ctrl-T would POST an unconfirmed check.
    for (const c of ["p", "P", "r", "t", "T", "d", "j", "a", "z"]) {
      expect(toReducerKeys(c, key({ ctrl: true }))).toEqual([]);
    }
  });
  test("alt/meta combinations map to nothing", () => {
    for (const c of ["j", "k", "q"]) {
      expect(toReducerKeys(c, key({ meta: true }))).toEqual([]);
    }
  });
  test("page up/down and home/end map to nothing — the reducer has no arm", () => {
    expect(toReducerKeys("", key({ pageUp: true }))).toEqual([]);
    expect(toReducerKeys("", key({ pageDown: true }))).toEqual([]);
    expect(toReducerKeys("", key({ home: true }))).toEqual([]);
    expect(toReducerKeys("", key({ end: true }))).toEqual([]);
  });
});
