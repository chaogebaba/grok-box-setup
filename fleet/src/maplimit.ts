// maplimit.ts — bounded-concurrency map, ORDER-PRESERVING.
//
// Lifted verbatim out of inventory.ts (A5, 5.12.1) so `fleet-status` can use
// the same shape without importing the whole inventory module. It has no
// imports of its own, so nothing that pulls it in can create a cycle.
//
// The order guarantee is part of the contract, not an accident: every caller
// renders a TABLE whose row order is meaningful (reconcile target order, which
// is box-index order — `grok-box-8` before `grok-box-011`, which a lexicographic
// sort would reverse). Results are written into a pre-sized array by INDEX, so
// they come back in input order however the workers interleave.

/** Bounded-concurrency map (limit N). Preserves input order in the output. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const n = Math.max(1, limit);
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}
