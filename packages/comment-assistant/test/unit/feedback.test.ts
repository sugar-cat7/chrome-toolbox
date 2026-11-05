import { describe, expect, it, vi } from 'vitest';
import { ABUSIVE_THRESHOLD, type StorageArea } from '@chrome-toolbox/extension-core';
import {
  createFeedbackStore,
  createHiddenLog,
  feedbackLimits,
  type FeedbackInput,
} from '../../src/feedback.ts';

const START = 1_800_000_000_000;

/** chrome.storage.local stand-in: values are copied through JSON like the real area. */
const memoryArea = (initial: Record<string, unknown> = {}) => {
  const data = new Map(Object.entries(initial));
  const set = vi.fn<StorageArea['set']>(async (items) => {
    for (const [key, value] of Object.entries(items))
      data.set(key, JSON.parse(JSON.stringify(value)));
  });
  const area: StorageArea = {
    get: async (key) => (data.has(key) ? { [key]: JSON.parse(JSON.stringify(data.get(key))) } : {}),
    set,
  };
  return { area, data, set };
};

const input = (overrides: Partial<FeedbackInput> = {}): FeedbackInput => ({
  site: 'youtube',
  channel: 'UC-a',
  text: 'stuff that boss for the trophy room',
  category: 'abusive',
  abusive: 0.85,
  verdict: 'ok',
  at: START,
  ...overrides,
});

const loaded = async (area: StorageArea) => {
  const store = createFeedbackStore({ area });
  const read = await store.load();
  if (!read.ok) expect.fail(read.error.internalCode);
  return store;
};
const failed = { ok: false, error: { internalCode: 'storage_failed' } };

describe('hidden log', () => {
  it('keeps the newest 200 entries of a channel, replacing the oldest first', () => {
    const log = createHiddenLog<number>();
    expect(feedbackLimits.hiddenPerChannel).toBe(200);
    for (let i = 0; i < 205; i += 1) log.add(`c${i}`, i);
    expect(log.size()).toBe(200);
    expect(log.values()[0]).toBe(5);
    expect(log.values().at(-1)).toBe(204);
    expect(log.get('c4')).toBeUndefined();
    expect(log.get('c5')).toBe(5);
    log.clear();
    expect(log.size()).toBe(0);
  });
});

describe('feedback store', () => {
  it('keeps at most 1,000 verdicts in storage, replacing the oldest first', async () => {
    const { area, data } = memoryArea();
    const store = await loaded(area);
    expect(feedbackLimits.entries).toBe(1000);
    const writes = Array.from({ length: 1005 }, (_value, i) =>
      store.record(input({ text: `comment ${i}`, at: START + i })),
    );
    expect((await Promise.all(writes)).every((written) => written.ok)).toBe(true);
    const saved = data.get('feedback') as { text: string }[];
    expect(saved).toHaveLength(1000);
    expect([saved[0]?.text, saved.at(-1)?.text]).toEqual(['comment 5', 'comment 1004']);
    expect(store.export().trim().split('\n')).toHaveLength(1000);
  });

  it('batches writes: one write for a burst, one more for what arrives while it runs', async () => {
    const { area, set } = memoryArea();
    const store = await loaded(area);
    let open: () => void = () => undefined;
    const door = new Promise<void>((resolve) => {
      open = resolve;
    });
    const write = set.getMockImplementation();
    set.mockImplementationOnce(async (items) => {
      await door;
      await write?.(items);
    });
    const burst = [1, 2, 3].map((i) => store.record(input({ text: `burst ${i}` })));
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    // The first write is still running: these two share the next one.
    const during = [
      store.record(input({ text: 'during 1' })),
      store.record(input({ text: 'during 2' })),
    ];
    open();
    expect((await Promise.all([...burst, ...during])).every((written) => written.ok)).toBe(true);
    expect(set).toHaveBeenCalledTimes(2);
    expect((await loaded(area)).export().trim().split('\n')).toHaveLength(5);
  });

  it('restores the verdicts saved earlier and skips invalid ones', async () => {
    const { area } = memoryArea();
    const first = await loaded(area);
    expect((await first.record(input({ text: 'Nice  Stuffing!' }))).ok).toBe(true);
    const { area: broken } = memoryArea({
      feedback: [{ text: 'no fields' }, ...((await area.get('feedback'))['feedback'] as unknown[])],
    });
    const second = await loaded(broken);
    expect([...second.allowlist('youtube', 'UC-a')]).toEqual(['nice stuffing!']);
    expect(second.export().trim().split('\n')).toHaveLength(1);
  });

  it('answers storage_failed when a write fails and saves the verdict with the next write', async () => {
    const { area, data, set } = memoryArea();
    const store = await loaded(area);
    set.mockRejectedValueOnce(new Error('quota'));
    expect(await store.record(input({ text: 'first' }))).toMatchObject(failed);
    // The verdict still counts for this session.
    expect(store.allowlist('youtube', 'UC-a').has('first')).toBe(true);
    expect((await store.record(input({ text: 'second' }))).ok).toBe(true);
    expect((data.get('feedback') as { text: string }[]).map((e) => e.text)).toEqual([
      'first',
      'second',
    ]);
  });

  it('stays session-only while the saved verdicts cannot be read, then reads them again later', async () => {
    let time = START;
    const { area, data, set } = memoryArea({ feedback: [{ ...input({ text: 'saved' }) }] });
    const get = vi.fn<StorageArea['get']>(async () => Promise.reject(new Error('busy')));
    const store = createFeedbackStore({ area: { get, set }, now: () => time });
    expect(await store.load()).toMatchObject(failed);
    // Nothing is written, so the saved verdict is not overwritten.
    expect(await store.record(input({ text: 'session' }))).toMatchObject(failed);
    expect(set).not.toHaveBeenCalled();
    expect(store.allowlist('youtube', 'UC-a').has('session')).toBe(true);
    // A read again within 30 s is not attempted.
    time += 29_999;
    expect(await store.load()).toMatchObject(failed);
    expect(get).toHaveBeenCalledTimes(1);
    // 30 s later the storage answers: the saved verdict comes first, and both are written.
    time += 1;
    get.mockImplementation((key) => area.get(key));
    expect(await store.load()).toEqual({ ok: true, value: undefined });
    expect(get).toHaveBeenCalledTimes(2);
    expect((data.get('feedback') as { text: string }[]).map((e) => e.text)).toEqual([
      'saved',
      'session',
    ]);
    expect([...store.allowlist('youtube', 'UC-a')].sort()).toEqual(['saved', 'session']);
  });

  it('reads at most three times when the storage keeps failing', async () => {
    let time = START;
    const get = vi.fn<StorageArea['get']>(async () => Promise.reject(new Error('gone')));
    const store = createFeedbackStore({
      area: { get, set: async () => undefined },
      now: () => time,
    });
    for (let i = 0; i < 5; i += 1) {
      expect(await store.load()).toMatchObject(failed);
      time += 60_000;
    }
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('clears every verdict, in memory and in storage, even before a read succeeded', async () => {
    const { area, data } = memoryArea();
    const store = await loaded(area);
    await store.record(input({ text: 'one', abusive: 0.85 }));
    await store.record(input({ text: 'two', abusive: 0.85 }));
    await store.record(input({ text: 'three', abusive: 0.85 }));
    expect(store.threshold('youtube', 'UC-a')).toBe(0.9);
    expect(await store.clear()).toEqual({ ok: true, value: undefined });
    expect([store.allowlist('youtube', 'UC-a').size, store.export()]).toEqual([0, '']);
    expect(store.threshold('youtube', 'UC-a')).toBe(ABUSIVE_THRESHOLD);
    expect(store.corrections('youtube', 'UC-a')).toEqual([]);
    expect(data.get('feedback')).toEqual([]);

    const unread = createFeedbackStore({
      area: { get: async () => Promise.reject(new Error('gone')), set: (items) => area.set(items) },
    });
    expect(await unread.load()).toMatchObject(failed);
    data.set('feedback', [input({ text: 'old' })]);
    expect(await unread.clear()).toEqual({ ok: true, value: undefined });
    expect(data.get('feedback')).toEqual([]);
  });

  it('allowlists the normalized texts of "ok" verdicts, per channel', async () => {
    const store = createFeedbackStore();
    await store.record(input({ text: 'STUFF that boss  for the trophy room' }));
    await store.record(input({ text: 'you are trash', verdict: 'correct' }));
    await store.record(input({ channel: 'UC-b', text: 'other channel' }));
    expect([...store.allowlist('youtube', 'UC-a')]).toEqual([
      'stuff that boss for the trophy room',
    ]);
    expect([...store.allowlist('youtube', 'UC-b')]).toEqual(['other channel']);
    expect(store.allowlist('twitch', 'UC-a').size).toBe(0);
  });

  it('lists the newest "ok" corrections of a channel first, five by default, once per text', async () => {
    const store = createFeedbackStore();
    for (let i = 1; i <= 7; i += 1)
      await store.record(input({ text: `fine ${i}`, category: i % 2 === 0 ? 'spam' : 'abusive' }));
    await store.record(input({ text: 'FINE 7' }));
    await store.record(input({ text: 'confirmed', verdict: 'correct' }));
    await store.record(input({ channel: 'UC-b', text: 'elsewhere' }));
    expect(store.corrections('youtube', 'UC-a')).toEqual([
      { text: 'FINE 7', category: 'abusive' },
      { text: 'fine 6', category: 'spam' },
      { text: 'fine 5', category: 'abusive' },
      { text: 'fine 4', category: 'spam' },
      { text: 'fine 3', category: 'abusive' },
    ]);
    expect(store.corrections('youtube', 'UC-a', 2).map((c) => c.text)).toEqual([
      'FINE 7',
      'fine 6',
    ]);
    expect(store.corrections('twitch', 'none')).toEqual([]);
  });

  it('cuts a long correction so five of them stay a small part of the prompt', async () => {
    const store = createFeedbackStore();
    await store.record(input({ text: 'x'.repeat(1000) }));
    expect(store.corrections('youtube', 'UC-a')[0]?.text).toHaveLength(
      feedbackLimits.correctionText,
    );
  });

  it.each([
    { name: 'no feedback', scores: [], expected: ABUSIVE_THRESHOLD },
    { name: 'two restores', scores: [0.85, 0.9], expected: 0.8 },
    { name: 'three restores averaging 0.8', scores: [0.8, 0.8, 0.8], expected: 0.9 },
    { name: 'three restores averaging 0.85', scores: [0.82, 0.85, 0.88], expected: 0.9 },
    { name: 'restores averaging above 0.9', scores: [0.9, 0.92, 0.94], expected: 0.92 },
    { name: 'restores averaging near 1', scores: [0.99, 0.98, 0.99], expected: 0.95 },
    { name: 'restores averaging below 0.8', scores: [0.6, 0.7, 0.75], expected: 0.8 },
  ])('sets the channel threshold from $name to $expected', async ({ scores, expected }) => {
    const store = createFeedbackStore();
    for (const [i, abusive] of scores.entries())
      await store.record(input({ text: `fine ${i}`, abusive }));
    expect(store.threshold('youtube', 'UC-a')).toBeCloseTo(expected, 10);
    expect(store.threshold('youtube', 'UC-b')).toBe(ABUSIVE_THRESHOLD);
  });

  it('raises the threshold only from restored abusive comments with a Clef probability', async () => {
    const store = createFeedbackStore();
    for (let i = 0; i < 3; i += 1) {
      await store.record(input({ text: `confirmed ${i}`, abusive: 0.95, verdict: 'correct' }));
      await store.record(input({ text: `spam ${i}`, category: 'spam', abusive: 0.95 }));
    }
    await store.record(input({ text: 'no score 1', abusive: undefined }));
    await store.record(input({ text: 'no score 2', abusive: undefined }));
    await store.record(input({ text: 'scored', abusive: 0.9 }));
    expect(store.threshold('youtube', 'UC-a')).toBe(ABUSIVE_THRESHOLD);
  });

  it('counts a restored text toward the threshold once, however many copies were restored', async () => {
    const store = createFeedbackStore();
    for (const text of ['Same Text', 'same text', 'SAME  TEXT'])
      await store.record(input({ text, abusive: 0.85 }));
    expect(store.threshold('youtube', 'UC-a')).toBe(ABUSIVE_THRESHOLD);
    await store.record(input({ text: 'other one', abusive: 0.85 }));
    await store.record(input({ text: 'other two', abusive: 0.85 }));
    expect(store.threshold('youtube', 'UC-a')).toBe(0.9);
  });

  it('exports one JSON line per verdict without the author or the channel', async () => {
    const store = createFeedbackStore();
    // The record type has no author; a caller that passes one anyway must not leak it.
    const withAuthor = {
      ...input({ translation: 'ボスを剥製にしてトロフィー部屋へ' }),
      author: 'Someone',
    };
    await store.record(withAuthor);
    await store.record(
      input({
        text: 'spam link',
        category: 'spam',
        abusive: undefined,
        source: 'rule',
        verdict: 'correct',
        at: START + 1,
      }),
    );
    const lines = store.export().trim().split('\n');
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        text: 'stuff that boss for the trophy room',
        translation: 'ボスを剥製にしてトロフィー部屋へ',
        category: 'abusive',
        abusive: 0.85,
        verdict: 'ok',
        at: START,
      },
      { text: 'spam link', category: 'spam', source: 'rule', verdict: 'correct', at: START + 1 },
    ]);
    expect(store.export()).not.toContain('Someone');
    expect(store.export()).not.toContain('UC-a');
    expect(createFeedbackStore().export()).toBe('');
  });
});
