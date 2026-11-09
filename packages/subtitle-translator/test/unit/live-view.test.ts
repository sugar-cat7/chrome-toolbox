import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemTimers } from '@chrome-toolbox/extension-core';
import { createLiveView, LIVE_VIEW_LIMITS, liveLineView } from '../../src/overlay/live-view.ts';
import { subtitleLimit } from '@chrome-toolbox/extension-core';
import { liveLineSchema, type LiveLine } from '../../src/protocol.ts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

function start() {
  const onChange = vi.fn<() => void>();
  const view = createLiveView({
    holdMs: LIVE_VIEW_LIMITS.holdMs,
    timers: systemTimers,
    onChange,
    now: () => Date.now(),
  });
  return { view, onChange, shown: () => liveLineView(view, 'both') };
}
const line = (sentenceId: string, over: Partial<LiveLine> = {}): LiveLine => ({
  sentenceId,
  lang: 'en',
  source: `Line ${sentenceId}`,
  state: 'pending',
  endedAt: 1000,
  final: false,
  ...over,
});
const done = (sentenceId: string, over: Partial<LiveLine> = {}): LiveLine =>
  line(sentenceId, { ja: `訳${sentenceId}`, state: 'done', final: true, ...over });

describe('live view', () => {
  it('replaces a live line with the same sentence id and clears it after 6 s', () => {
    const { view, onChange } = start();
    view.upsert(line('a', { source: 'Okay chat' }));
    expect(view.current()?.source).toBe('Okay chat');
    vi.advanceTimersByTime(2000);
    view.upsert(done('a', { source: 'Okay chat', ja: 'よしチャット' }));
    expect(view.current()).toEqual(done('a', { source: 'Okay chat', ja: 'よしチャット' }));
    expect(onChange).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5999);
    expect(view.current()).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(view.current()).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows a new sentence in place of the previous one', () => {
    const { view } = start();
    view.upsert(done('a'));
    view.upsert(line('b', { endedAt: 2500 }));
    expect(view.current()?.sentenceId).toBe('b');
  });

  it('keeps one timer and sets it again on every update', () => {
    const { view } = start();
    view.upsert(line('a'));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(4000);
    view.upsert(line('a', { source: 'Line a, longer', endedAt: 4000 }));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(5999);
    expect(view.current()).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(view.current()).toBeUndefined();
  });

  it('dims the previous translation for at most 3 s while the new one is pending', () => {
    const { view, onChange, shown } = start();
    view.upsert(done('a', { ja: 'よしチャット' }));
    view.upsert(line('b', { source: 'we are', endedAt: 2500 }));
    expect(shown()).toEqual({
      display: 'both',
      lang: 'en',
      source: 'we are',
      ja: 'よしチャット',
      jaDim: true,
      endedAt: 2500,
    });
    // The sentence grows while it waits: the dim still ends 3 s after it began waiting.
    vi.advanceTimersByTime(1500);
    view.upsert(line('b', { source: 'we are going in', endedAt: 4000 }));
    vi.advanceTimersByTime(1499);
    expect(shown()).toMatchObject({ ja: 'よしチャット', jaDim: true });
    const calls = onChange.mock.calls.length;
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(calls + 1);
    expect(shown()).toEqual({
      display: 'both',
      lang: 'en',
      source: 'we are going in',
      endedAt: 4000,
    });
    // It stays for 6 s after its last update.
    vi.advanceTimersByTime(4499);
    expect(view.current()?.sentenceId).toBe('b');
    vi.advanceTimersByTime(1);
    expect(view.current()).toBeUndefined();
  });

  it('shows its own translation, not dimmed, once it comes', () => {
    const { view, shown } = start();
    view.upsert(done('a'));
    view.upsert(line('b', { endedAt: 2500 }));
    vi.advanceTimersByTime(1000);
    view.upsert(done('b', { endedAt: 2500 }));
    expect(shown()).toMatchObject({ source: 'Line b', ja: '訳b' });
    expect(shown()).not.toHaveProperty('jaDim');
  });

  it('dims the earlier translation of a sentence that grew after it was translated', () => {
    const { view, shown } = start();
    view.upsert(done('a', { source: 'Okay chat', ja: 'よしチャット' }));
    view.upsert(line('a', { source: 'Okay chat we are going in', endedAt: 2500 }));
    expect(shown()).toMatchObject({ ja: 'よしチャット', jaDim: true });
  });

  it.each(['skipped', 'failed'] as const)(
    'leaves the Japanese row empty under a %s line',
    (state) => {
      const { view, shown } = start();
      view.upsert(done('a'));
      view.upsert(line('b', { state, endedAt: 2500 }));
      expect(shown()).toEqual({ display: 'both', lang: 'en', source: 'Line b', endedAt: 2500 });
    },
  );

  it('keeps a newer sentence over a late update of an older one, whose translation shows dimmed', () => {
    const { view, shown } = start();
    view.upsert(line('a', { endedAt: 1000 }));
    view.upsert(line('b', { endedAt: 2500 }));
    view.upsert(done('a', { endedAt: 1000 }));
    expect(shown()).toMatchObject({ source: 'Line b', ja: '訳a', jaDim: true });
    view.upsert(line('a', { state: 'skipped', endedAt: 1000 }));
    expect(view.current()?.sentenceId).toBe('b');
  });

  it('forgets the previous translation when the line clears', () => {
    const { view, shown } = start();
    view.upsert(done('a'));
    vi.advanceTimersByTime(LIVE_VIEW_LIMITS.holdMs);
    view.upsert(line('b', { endedAt: 9000 }));
    expect(shown()).not.toHaveProperty('ja');
  });

  it('shows Japanese speech as its own translation', () => {
    const { view, shown } = start();
    view.upsert(
      line('a', { lang: 'ja', source: 'よし行くぞ', ja: 'よし行くぞ', state: 'done', final: true }),
    );
    expect(shown()).toEqual({
      display: 'both',
      lang: 'ja',
      source: 'よし行くぞ',
      ja: 'よし行くぞ',
      endedAt: 1000,
    });
  });

  it('shows nothing once reset, and its timer is gone', () => {
    const { view, onChange, shown } = start();
    view.upsert(done('a'));
    onChange.mockClear();
    view.reset();
    expect(view.current()).toBeUndefined();
    expect(shown()).toEqual({ display: 'both' });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(LIVE_VIEW_LIMITS.holdMs);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('live line schema', () => {
  const valid = done('s-1', {
    source: 'Okay chat',
    ja: 'よしチャット',
    endedAt: 1_762_000_000_000,
  });
  const limit = subtitleLimit('Okay chat');
  it.each([
    { name: 'a translated line', patch: {}, ok: true },
    {
      name: 'a pending line without a translation',
      patch: { ja: undefined, state: 'pending' },
      ok: true,
    },
    { name: 'a 200-character source', patch: { source: 'a'.repeat(200), ja: undefined }, ok: true },
    {
      name: 'a 201-character source',
      patch: { source: 'a'.repeat(201), ja: undefined },
      ok: false,
    },
    { name: 'a translation at the subtitle limit', patch: { ja: '訳'.repeat(limit) }, ok: true },
    {
      name: 'a translation past the subtitle limit',
      patch: { ja: '訳'.repeat(limit + 1) },
      ok: false,
    },
    { name: 'astral characters counted as one each', patch: { ja: '😀'.repeat(limit) }, ok: true },
    { name: 'an empty source', patch: { source: '' }, ok: false },
    { name: 'an empty sentence id', patch: { sentenceId: '' }, ok: false },
    { name: 'an unknown state', patch: { state: 'lost' }, ok: false },
    { name: 'a malformed language', patch: { lang: 'en us' }, ok: false },
    { name: 'a negative end', patch: { endedAt: -1 }, ok: false },
    { name: 'an extra key', patch: { extra: 1 }, ok: false },
  ])('liveLineSchema: $name', ({ patch, ok }) => {
    const value: Record<string, unknown> = { ...valid, ...patch };
    for (const [key, field] of Object.entries(patch)) if (field === undefined) delete value[key];
    expect(liveLineSchema.safeParse(value).success).toBe(ok);
  });
});
