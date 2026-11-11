/** The last `size` latencies, for the live stats. */
export type LatencyRing = {
  record(this: void, ms: number): void;
  /** The nearest-rank `p`th percentile (0 < p ≤ 100) of the kept latencies; none before one. */
  percentile(this: void, p: number): number | undefined;
  /** How many latencies are kept (at most `size`). */
  size(this: void): number;
};

/** A ring of fixed length: recording past `size` overwrites the oldest latency. */
export function createLatencyRing(size: number): LatencyRing {
  const values = new Float64Array(size);
  let next = 0;
  let count = 0;
  return {
    record(ms) {
      values[next] = ms;
      next = (next + 1) % size;
      count = Math.min(count + 1, size);
    },
    percentile(p) {
      if (count === 0) return undefined;
      const sorted = values.slice(0, count).sort();
      return sorted[Math.max(0, Math.ceil((p / 100) * count) - 1)];
    },
    size: () => count,
  };
}
