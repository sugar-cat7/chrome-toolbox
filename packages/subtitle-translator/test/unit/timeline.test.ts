import { describe, expect, it } from 'vitest';
import type { TranslatedLine } from '../../src/captions/feeder.ts';
import { createTimeline } from '../../src/overlay/timeline.ts';

const KEEP_MS = 600_000;
const line = (id: string, startMs: number, endMs: number, ja?: string): TranslatedLine => ({
  id,
  startMs,
  endMs,
  source: `Line ${id}.`,
  ...(ja === undefined ? { state: 'pending' } : { ja, state: 'done' }),
});
const s1 = line('s1', 0, 2000);
const s2 = line('s2', 3000, 5000);

describe('caption timeline', () => {
  it.each([
    { at: 500, expected: 's1' },
    { at: 2500, expected: undefined },
    { at: 3100, expected: 's2' },
  ])('timeline.at($at)', ({ at, expected }) => {
    const timeline = createTimeline({ keepMs: KEEP_MS });
    timeline.upsert([s1, s2]);
    expect(timeline.at(at)?.id).toBe(expected);
  });

  it.each([
    { at: -1, expected: undefined },
    { at: 0, expected: 's1' },
    { at: 1999, expected: 's1' },
    { at: 2000, expected: undefined },
    { at: 3000, expected: 's2' },
    { at: 5000, expected: undefined },
  ])('shows a line from its start until its end: at($at)', ({ at, expected }) => {
    const timeline = createTimeline({ keepMs: KEEP_MS });
    timeline.upsert([s1, s2]);
    expect(timeline.at(at)?.id).toBe(expected);
  });

  it('keeps time order whatever order the lines come in', () => {
    const timeline = createTimeline({ keepMs: KEEP_MS });
    timeline.upsert([line('s3', 6000, 7000)]);
    timeline.upsert([s2]);
    timeline.upsert([s1]);
    expect([500, 3500, 6500].map((ms) => timeline.at(ms)?.id)).toEqual(['s1', 's2', 's3']);
  });

  it('replaces a line with the same id instead of adding it again', () => {
    const timeline = createTimeline({ keepMs: KEEP_MS });
    timeline.upsert([s1, s2]);
    timeline.upsert([line('s1', 0, 2000, '訳1')]);
    expect(timeline.size()).toBe(2);
    expect(timeline.at(500)).toEqual(line('s1', 0, 2000, '訳1'));
  });

  it('shows the later of two overlapping lines once it starts', () => {
    const timeline = createTimeline({ keepMs: KEEP_MS });
    timeline.upsert([line('a', 0, 4000), line('b', 3000, 5000)]);
    expect([2000, 3500, 4500].map((ms) => timeline.at(ms)?.id)).toEqual(['a', 'b', 'b']);
  });

  it('prunes lines farther than 10 minutes from the position', () => {
    const timeline = createTimeline({ keepMs: KEEP_MS });
    timeline.upsert([
      s1,
      line('far-before', 97_999, 99_999),
      line('near-before', 98_000, 100_000),
      line('near-after', 1_300_000, 1_302_000),
      line('far-after', 1_300_001, 1_302_000),
    ]);
    expect(timeline.size()).toBe(5);
    timeline.prune(700_000);
    expect(timeline.size()).toBe(2);
    expect(timeline.at(99_000)?.id).toBe('near-before');
    expect(timeline.at(1_300_000)?.id).toBe('near-after');
    expect(timeline.at(500)).toBeUndefined();
  });

  it('forgets every line on reset', () => {
    const timeline = createTimeline({ keepMs: KEEP_MS });
    timeline.upsert([s1, s2]);
    timeline.reset();
    expect(timeline.size()).toBe(0);
    expect(timeline.at(500)).toBeUndefined();
  });
});
