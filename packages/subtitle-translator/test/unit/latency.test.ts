import { describe, expect, it } from 'vitest';
import { createLatencyRing } from '../../src/audio/latency.ts';

describe('latency ring', () => {
  it('reports p50 and p95 from the last 200 latencies only', () => {
    const ring = createLatencyRing(200);
    for (let ms = 1; ms <= 1000; ms += 1) ring.record(ms);
    expect(ring.size()).toBe(200);
    // The ring keeps 801…1000: the nearest rank of p50 is the 100th, of p95 the 190th.
    expect(ring.percentile(50)).toBe(900);
    expect(ring.percentile(95)).toBe(990);
  });

  it('reports nothing until a latency is recorded', () => {
    const ring = createLatencyRing(200);
    expect(ring.size()).toBe(0);
    expect(ring.percentile(50)).toBeUndefined();
  });

  it.each([
    { name: '1 件', values: [700], p50: 700, p95: 700 },
    { name: '順不同', values: [900, 100, 500, 300, 700], p50: 500, p95: 900 },
    { name: '4 件', values: [400, 100, 300, 200], p50: 200, p95: 400 },
  ])('takes the nearest rank: $name', ({ values, p50, p95 }) => {
    const ring = createLatencyRing(200);
    for (const ms of values) ring.record(ms);
    expect(ring.percentile(50)).toBe(p50);
    expect(ring.percentile(95)).toBe(p95);
  });
});
