// state.ts — the inventory.json persistence seam (D6, F7.6, T8).
//
// The file is written ATOMICALLY: a temp file in the same directory, chmod
// 0600, then rename over the target (rename is atomic within a filesystem).
// bash fleetctl never reads this file (no coupling, D6).

export interface BoxEntry {
  api: string | null;
  tunnel: string | null;
  check: string | null;
  version: string | null;
  sha: string | null;
  /** the box's own tunnel= token (F7.1), never the table TUNNEL column. */
  boxTunnel?: string | null;
  checkReason?: string | null;
  expires?: string | null;
  checkedAt: string;
  /** reason string when a field is `?`/null (F7.3). */
  reason?: string | null;
  /** last upgrade attempt on this box (F7.6, S-E). */
  lastUpgrade?: {
    target: string;
    result: "ok" | "failed" | "skipped" | "aborted";
    at: string;
    detail: string;
  };
}

export interface Inventory {
  generatedAt: string;
  target: { ref: string | null; sha: string | null; version: string | null };
  boxes: Record<string, BoxEntry>;
}

/** Filesystem seam so tests can observe the tmp→rename sequence (T8). */
export interface FsSeam {
  writeFile(path: string, data: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(path: string): Promise<string | undefined>;
}

/** Production FsSeam over node:fs/promises. */
export const nodeFs: FsSeam = {
  async writeFile(path, data) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, data, { mode: 0o600 });
  },
  async chmod(path, mode) {
    const { chmod } = await import("node:fs/promises");
    await chmod(path, mode);
  },
  async rename(from, to) {
    const { rename } = await import("node:fs/promises");
    await rename(from, to);
  },
  async readFile(path) {
    const { readFile } = await import("node:fs/promises");
    try {
      return await readFile(path, "utf8");
    } catch {
      return undefined;
    }
  },
};

/** The inventory.json path under FLEET_STATE. */
export function inventoryPath(fleetState: string): string {
  return `${fleetState}/inventory.json`;
}

/**
 * Write inventory atomically: <path>.tmp.<pid> → chmod 0600 → rename. The tmp
 * name is deterministic-ish (pid + a random suffix) so a crash cannot collide.
 */
export async function writeInventory(fs: FsSeam, path: string, inv: Inventory): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  const data = JSON.stringify(inv, null, 2) + "\n";
  await fs.writeFile(tmp, data);
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, path);
}

/** Read + parse inventory.json (undefined when absent/corrupt). */
export async function readInventory(fs: FsSeam, path: string): Promise<Inventory | undefined> {
  const text = await fs.readFile(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Inventory;
  } catch {
    return undefined;
  }
}
