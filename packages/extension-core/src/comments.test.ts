import { describe, expect, it } from 'vitest';
import {
  commentLimits,
  commentRecordSchema,
  createCommentStore,
  type CommentRecord,
} from './comments.ts';

const NOW = 100 * 60_000;
const record = (id: string, age = 0): CommentRecord => ({
  id,
  site: 'youtube',
  channel: 'c',
  author: 'a',
  text: 't',
  lang: 'en',
  at: NOW - age,
  state: 'pending',
});
const store = (maxItems: number) =>
  createCommentStore({ maxItems, maxAgeMs: 30 * 60_000, now: () => NOW });

describe('comment store', () => {
  it.each([
    { name: 'count cap', maxItems: 3, ages: [0, 0, 0, 0], kept: 3 },
    { name: 'age cap', maxItems: 10, ages: [31 * 60_000, 0], kept: 1 },
  ])('enforces $name', ({ maxItems, ages, kept }) => {
    const s = store(maxItems);
    s.add(ages.map((age, i) => record(`r${i}`, age)));
    expect(s.size()).toBe(kept);
  });

  it('evicts oldest first and frees their ids', () => {
    const s = store(2);
    s.add([record('a'), record('b'), record('c')]);
    expect(s.since(1000).map((r) => r.id)).toEqual(['b', 'c']);
    expect(s.add([record('a')]).map((r) => r.id)).toEqual(['a']);
  });

  it('ignores duplicate ids', () => {
    const s = store(10);
    expect(s.add([record('a')])).toHaveLength(1);
    expect(s.add([record('a')])).toEqual([]);
    expect(s.size()).toBe(1);
  });

  it('updates in place and ignores unknown ids', () => {
    const s = store(10);
    s.add([record('a')]);
    expect(s.update('a', { state: 'done', translation: 'x' })).toMatchObject({
      state: 'done',
      translation: 'x',
    });
    expect(s.update('zzz', { state: 'done' })).toBeUndefined();
  });

  it('keeps a comment stored without processing and completes it in place later (R44)', () => {
    const s = store(10);
    s.add([{ ...record('a'), lang: 'und-Latn', state: 'stored' }]);
    expect(s.since(1000)).toMatchObject([{ id: 'a', state: 'stored' }]);
    expect(
      s.update('a', { state: 'done', lang: 'en', translation: 'x', category: 'chatter' }),
    ).toMatchObject({ state: 'done', lang: 'en', translation: 'x', category: 'chatter' });
    expect(s.size()).toBe(1);
  });

  it('since returns the recent window and clear empties', () => {
    const s = store(10);
    s.add([record('old', 10_000), record('new', 100)]);
    expect(s.since(1000).map((r) => r.id)).toEqual(['new']);
    s.clear();
    expect(s.size()).toBe(0);
  });
});

describe('comment store bounds', () => {
  it('stays at the cap across many adds and compacts', () => {
    const s = store(5000);
    for (let i = 0; i < 6000; i += 1) s.add([record(`r${i}`)]);
    expect(s.size()).toBe(5000);
    expect(s.since(1000)).toHaveLength(5000);
    expect(s.update('r0', { state: 'done' })).toBeUndefined();
    expect(s.update('r6000'.replace('6000', '5999'), { state: 'done' })).toBeDefined();
  });

  it('prunes the expired prefix as the clock advances', () => {
    let time = NOW;
    const s = createCommentStore({ maxItems: 100, maxAgeMs: 1000, now: () => time });
    s.add([{ ...record('a'), at: time }]);
    time += 600;
    s.add([{ ...record('b'), at: time }]);
    time += 600;
    s.add([{ ...record('c'), at: time }]);
    expect(s.since(10_000).map((r) => r.id)).toEqual(['b', 'c']);
    expect(s.size()).toBe(2);
  });

  it('keeps an out-of-order record until its predecessors expire', () => {
    const s = store(10);
    s.add([record('a', 100), record('b', 500)]);
    expect(s.size()).toBe(2);
  });

  it('since includes the exact boundary', () => {
    const s = store(10);
    s.add([record('edge', 1000), record('out', 1001)]);
    expect(s.since(1000).map((r) => r.id)).toEqual(['edge']);
  });
});

describe('comment record schema and limits', () => {
  it('rejects unknown keys', () => {
    expect(commentRecordSchema.safeParse({ ...record('a'), extra: 1 }).success).toBe(false);
    expect(commentRecordSchema.safeParse(record('a')).success).toBe(true);
    expect(commentRecordSchema.safeParse({ ...record('a'), state: 'stored' }).success).toBe(true);
  });
  it('exposes the agreed defaults', () => {
    expect(commentLimits).toEqual({
      batcher: { maxItems: 3, maxWaitMs: 500, maxBuffered: 200 },
      store: { maxItems: 5000, maxAgeMs: 1_800_000 },
      lruMax: 2000,
    });
  });
});
