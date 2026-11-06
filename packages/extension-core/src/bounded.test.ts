import { describe, expect, it } from 'vitest';
import { createBatcher, createLruCache, type Timers } from './bounded.ts';

const fakeClock = (): { timers: Timers; advance(ms: number): void; active(): number } => {
  let time = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn, ms) => {
        const id = nextId++;
        pending.set(id, { at: time + ms, fn });
        return id;
      },
      clear: (id) => void pending.delete(id),
    },
    advance(ms) {
      time += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at > time) continue;
        pending.delete(id);
        entry.fn();
      }
    },
    active: () => pending.size,
  };
};

const setup = (maxItems: number, maxBuffered = 200) => {
  const clock = fakeClock();
  const flushed: number[][] = [];
  const batcher = createBatcher<number>({
    maxItems,
    maxWaitMs: 500,
    maxBuffered,
    flush: (items) => flushed.push(items),
    timers: clock.timers,
  });
  return { clock, flushed, batcher };
};

describe('batcher', () => {
  it.each([
    { pushes: 20, maxItems: 20, advance: 0, flushes: [20] },
    { pushes: 3, maxItems: 20, advance: 499, flushes: [] },
    { pushes: 3, maxItems: 20, advance: 500, flushes: [3] },
    { pushes: 3, maxItems: 3, advance: 0, flushes: [3] },
    { pushes: 7, maxItems: 3, advance: 500, flushes: [3, 3, 1] },
  ])(
    'flushes $pushes items (maxItems $maxItems) after $advance ms',
    ({ pushes, maxItems, advance, flushes }) => {
      const { clock, flushed, batcher } = setup(maxItems);
      for (let i = 0; i < pushes; i += 1) batcher.push(i);
      clock.advance(advance);
      expect(flushed.map((items) => items.length)).toEqual(flushes);
    },
  );

  it('drops the oldest beyond maxBuffered and keeps one timer', () => {
    const { clock, batcher } = setup(1000, 200);
    const dropped: number[] = [];
    for (let i = 0; i < 205; i += 1) dropped.push(...batcher.push(i).dropped);
    expect(dropped).toEqual([0, 1, 2, 3, 4]);
    expect(clock.active()).toBe(1);
  });

  it('has no timer after an immediate flush', () => {
    const { clock, batcher } = setup(3);
    for (let i = 0; i < 3; i += 1) batcher.push(i);
    expect(clock.active()).toBe(0);
  });

  it('dispose clears its timer and buffer', () => {
    const { clock, flushed, batcher } = setup(20);
    batcher.push(1);
    batcher.dispose();
    clock.advance(1000);
    expect(clock.active()).toBe(0);
    expect(flushed).toEqual([]);
  });
});

describe('batcher flush', () => {
  it('emits the buffer now and clears the window timer', () => {
    const { clock, flushed, batcher } = setup(3);
    batcher.push(1);
    batcher.push(2);
    expect(clock.active()).toBe(1);
    batcher.flush();
    expect([flushed, clock.active()]).toEqual([[[1, 2]], 0]);
  });

  it('does nothing when empty or disposed', () => {
    const { flushed, batcher } = setup(3);
    batcher.flush();
    batcher.push(1);
    batcher.dispose();
    batcher.flush();
    expect(flushed).toEqual([]);
  });
});

describe('batcher after dispose', () => {
  it('is inert: returns the item as dropped and arms no timer', () => {
    const { clock, flushed, batcher } = setup(3);
    batcher.dispose();
    expect(batcher.push(1)).toEqual({ dropped: [1] });
    clock.advance(1000);
    expect([clock.active(), flushed]).toEqual([0, []]);
  });
});

describe('lru cache', () => {
  it('evicts the least recently used', () => {
    const cache = createLruCache<string, number>({ max: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect([cache.get('a'), cache.get('b'), cache.get('c')]).toEqual([1, undefined, 3]);
    expect(cache.size()).toBe(2);
  });

  it('overwrites without growing and clears', () => {
    const cache = createLruCache<string, number>({ max: 2 });
    cache.set('a', 1);
    cache.set('a', 2);
    expect([cache.get('a'), cache.size()]).toEqual([2, 1]);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it('hands every entry it drops by the cap or clear to onEvict, but not an overwrite', () => {
    const evicted: [string, number][] = [];
    const cache = createLruCache<string, number>({
      max: 2,
      onEvict: (key, value) => evicted.push([key, value]),
    });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('b', 3);
    cache.set('c', 4);
    expect(evicted).toEqual([['a', 1]]);
    cache.clear();
    expect(evicted).toEqual([
      ['a', 1],
      ['b', 3],
      ['c', 4],
    ]);
  });

  it('deletes one key without onEvict, freeing its place', () => {
    const evicted: string[] = [];
    const cache = createLruCache<string, number>({
      max: 2,
      onEvict: (key) => evicted.push(key),
    });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.delete('a');
    cache.delete('missing');
    cache.set('c', 3);
    expect([cache.get('a'), cache.get('b'), cache.get('c'), cache.size()]).toEqual([
      undefined,
      2,
      3,
      2,
    ]);
    expect(evicted).toEqual([]);
  });
});
