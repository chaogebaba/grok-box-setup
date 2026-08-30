// T8 — inventory.json persistence: atomic write (tmp then rename), 0600, JSON
// round-trip. m8: a non-atomic direct write is killed by the tmp→rename order
// assertion.

import { test, expect, describe } from "bun:test";
import { writeInventory, readInventory, inventoryPath, type FsSeam, type Inventory } from "../src/state.ts";

function fakeFs(): {
  fs: FsSeam;
  ops: string[];
  store: Map<string, string>;
  modes: Map<string, number>;
} {
  const store = new Map<string, string>();
  const modes = new Map<string, number>();
  const ops: string[] = [];
  const fs: FsSeam = {
    async writeFile(path, data) {
      ops.push(`write:${path}`);
      store.set(path, data);
    },
    async chmod(path, mode) {
      ops.push(`chmod:${path}:${mode.toString(8)}`);
      modes.set(path, mode);
    },
    async rename(from, to) {
      ops.push(`rename:${from}->${to}`);
      const v = store.get(from);
      if (v !== undefined) {
        store.set(to, v);
        store.delete(from);
      }
      const m = modes.get(from);
      if (m !== undefined) {
        modes.set(to, m);
        modes.delete(from);
      }
    },
    async readFile(path) {
      return store.get(path);
    },
  };
  return { fs, ops, store, modes };
}

const INV: Inventory = {
  generatedAt: "2026-08-30T00:00:00.000Z",
  target: { ref: "main", sha: "abc1234", version: "5.3.0" },
  boxes: {
    "grok-box-008": {
      api: "online",
      tunnel: "up",
      check: "OK",
      version: "5.3.0",
      sha: "abc1234",
      checkedAt: "2026-08-30T00:00:00.000Z",
    },
  },
};

describe("T8 inventory persistence", () => {
  test("write is atomic: writeFile(tmp) → chmod(tmp,0600) → rename(tmp→path)", async () => {
    const { fs, ops, modes } = fakeFs();
    const path = inventoryPath("/var/lib/grok-fleet");
    await writeInventory(fs, path, INV);

    // Exactly three ops, in order, all on a tmp name before the final rename.
    expect(ops.length).toBe(3);
    expect(ops[0]!.startsWith("write:")).toBe(true);
    expect(ops[1]!.startsWith("chmod:")).toBe(true);
    expect(ops[2]!.startsWith("rename:")).toBe(true);

    // m8: the write target is NOT the final path (it's a tmp), then renamed.
    const tmpName = ops[0]!.slice("write:".length);
    expect(tmpName).not.toBe(path);
    expect(tmpName.startsWith(`${path}.tmp.`)).toBe(true);
    expect(ops[2]).toBe(`rename:${tmpName}->${path}`);

    // chmod applied to the tmp, mode 0600.
    expect(modes.get(path)).toBe(0o600);
  });

  test("JSON round-trips through the store", async () => {
    const { fs } = fakeFs();
    const path = inventoryPath("/var/lib/grok-fleet");
    await writeInventory(fs, path, INV);
    const back = await readInventory(fs, path);
    expect(back).toEqual(INV);
  });

  test("readInventory returns undefined for absent / corrupt", async () => {
    const { fs } = fakeFs();
    expect(await readInventory(fs, "/nope")).toBeUndefined();
    await fs.writeFile("/bad", "{not json");
    expect(await readInventory(fs, "/bad")).toBeUndefined();
  });
});
