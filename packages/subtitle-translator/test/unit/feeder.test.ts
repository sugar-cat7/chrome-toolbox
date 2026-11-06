import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import { systemTimers } from '@chrome-toolbox/extension-core';
import {
  createCaptionFeeder,
  FEEDER_LIMITS,
  type TranslatedLine,
} from '../../src/captions/feeder.ts';
import type { Sentence } from '../../src/captions/sentences.ts';
import type { TranslateRequest, TranslateResponse } from '../../src/protocol.ts';
import type { DisplayMode } from '../../src/settings.ts';

const VIDEO = 'abcdefghijk';
/** Sentence `i`: by default one every 3 s, each 2.5 s long. */
const s = (i: number, startMs = i * 3000): Sentence => ({
  id: `s${i}`,
  startMs,
  endMs: startMs + 2500,
  source: `Line ${i}.`,
});
const first = (n: number): Sentence[] => Array.from({ length: n }, (_, i) => s(i));
const ids = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `s${from + i}`);
/** Lets the feeder see an answer (and anything it starts from there). */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** A `subs/translate` that answers each request when the test says so. */
function server() {
  const calls: {
    batch: TranslateRequest;
    answer: (result: Promise<Result<TranslateResponse>>) => void;
  }[] = [];
  const request = vi.fn<(batch: TranslateRequest) => Promise<Result<TranslateResponse>>>(
    (batch) =>
      new Promise<Result<TranslateResponse>>((resolve) => {
        calls.push({ batch, answer: resolve });
      }),
  );
  /** Request `n` answered with `result`. */
  async function answer(n: number, result: Promise<Result<TranslateResponse>>): Promise<void> {
    const call = calls[n];
    if (call === undefined) throw new Error(`no request ${n}`);
    call.answer(result);
    await settle();
  }
  return {
    request,
    calls,
    answer,
    /** The sentence ids of each request so far. */
    asked: () => calls.map((call) => call.batch.sentences.map((sentence) => sentence.id)),
    /** Answers request `n`: every sentence translated, except the ids in `failed`. */
    reply: (n: number, failed: readonly string[] = []) =>
      answer(
        n,
        Promise.resolve(
          Ok({
            lines: (calls[n]?.batch.sentences ?? []).map(({ id, source }) =>
              failed.includes(id)
                ? { id, state: 'failed' as const }
                : { id, ja: `訳:${source}`, state: 'done' as const },
            ),
          }),
        ),
      ),
  };
}

function start({
  sentences = first(100),
  sourceLang = 'en',
  display = 'both',
}: { sentences?: Sentence[]; sourceLang?: string; display?: DisplayMode } = {}) {
  const fake = server();
  const emitted: TranslatedLine[][] = [];
  let mode = display;
  const feeder = createCaptionFeeder({
    videoId: VIDEO,
    sentences,
    sourceLang,
    display: () => mode,
    request: fake.request,
    onLines: (lines) => emitted.push(lines),
    timers: systemTimers,
  });
  return {
    ...fake,
    feeder,
    emitted,
    lines: () => emitted.flat(),
    show: (next: DisplayMode) => {
      mode = next;
    },
  };
}
const done = (i: number, startMs = i * 3000): TranslatedLine => ({
  ...s(i, startMs),
  ja: `訳:Line ${i}.`,
  state: 'done',
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('caption feeder', () => {
  it('asks for the next untranslated sentences in time order, four at a time, one request at a time', async () => {
    const run = start({ sentences: first(30) });
    run.feeder.position(0);
    run.feeder.position(40);
    run.feeder.position(100);
    await settle();
    expect(run.calls.map((call) => call.batch)).toEqual([
      {
        videoId: VIDEO,
        sourceLang: 'en',
        previous: [],
        sentences: [0, 1, 2, 3].map((i) => ({ id: `s${i}`, source: `Line ${i}.` })),
      },
    ]);
    await run.reply(0);
    expect(run.emitted.at(-1)).toEqual([done(0), done(1), done(2), done(3)]);
    expect(run.asked()).toEqual([ids(0, 3), ids(4, 7)]);
    expect(run.calls[1]?.batch.previous).toEqual(['Line 1.', 'Line 2.', 'Line 3.']);
    for (let n = 1; n <= 5; n += 1) await run.reply(n);
    // 60 s ahead of 100 ms: the sentence that starts at 60,000 is the last one.
    expect(run.asked()).toEqual([
      ids(0, 3),
      ids(4, 7),
      ids(8, 11),
      ids(12, 15),
      ids(16, 19),
      ['s20'],
    ]);
    for (const at of [1000, 2000, 2999]) run.feeder.position(at);
    await settle();
    expect(run.calls).toHaveLength(6);
    run.feeder.position(3000);
    await settle();
    expect(run.emitted.at(-1)).toEqual([{ ...s(21), state: 'pending' }]);
    expect(run.asked().at(-1)).toEqual(['s21']);
  });

  it('shows each sentence in range once, untranslated until its answer comes', async () => {
    const run = start({ sentences: first(30) });
    run.feeder.position(0);
    for (let at = 16; at < 1000; at += 16) run.feeder.position(at);
    await settle();
    // From 2 s before the position to 60 s after it: s0 to s20.
    expect(run.lines()).toEqual(first(21).map((sentence) => ({ ...sentence, state: 'pending' })));
    const shown = run.emitted.length;
    // 1,999 ms on from 992 is no seek, and nothing new is in range.
    run.feeder.position(2_991);
    expect(run.emitted).toHaveLength(shown);
    // 2,000 ms on is a seek: the whole range is shown again.
    run.feeder.position(4_991);
    expect(run.emitted.at(-1)?.map((line) => line.id)).toEqual(ids(1, 21));
  });

  it('starts again from the new position after a seek', async () => {
    const run = start();
    run.feeder.position(0);
    await settle();
    run.feeder.position(121_500);
    await settle();
    expect(run.asked()).toEqual([ids(0, 3)]);
    // The sentences around the new position are shown at once; s39 (117–119.5 s) ends exactly
    // 2 s before the position, s38 earlier.
    expect(run.emitted.at(-1)?.[0]).toEqual({ ...s(39), state: 'pending' });
    await run.reply(0);
    // The answer from before the seek is within 10 minutes of the position: it is kept.
    expect(run.emitted.at(-1)).toEqual([done(0), done(1), done(2), done(3)]);
    expect(run.asked()[1]).toEqual(ids(39, 42));
    expect(run.calls[1]?.batch.previous).toEqual(['Line 36.', 'Line 37.', 'Line 38.']);
    for (let n = 1; n <= 6; n += 1) await run.reply(n);
    expect(run.asked().slice(1).flat()).toEqual(ids(39, 60));
  });

  it.each([
    { name: '前面でない', front: false, display: 'both', lang: 'en', shown: 'source' },
    { name: '表示オフ', front: true, display: 'off', lang: 'en', shown: 'nothing' },
    { name: '原語のみ', front: true, display: 'source', lang: 'en', shown: 'source' },
    { name: '日本語の字幕', front: true, display: 'both', lang: 'ja', shown: 'ja' },
  ] as const)('sends nothing: $name', async ({ front, display, lang, shown }) => {
    const run = start({ sentences: first(10), sourceLang: lang, display });
    run.feeder.front(front);
    run.feeder.position(0);
    run.feeder.position(1000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.request).not.toHaveBeenCalled();
    const expected = {
      nothing: [],
      source: first(10).map((sentence) => ({ ...sentence, state: 'pending' })),
      ja: first(10).map((sentence) => ({ ...sentence, ja: sentence.source, state: 'done' })),
    }[shown];
    expect(run.lines()).toEqual(expected);
  });

  it('sends once the page is in front again and the display shows Japanese', async () => {
    const run = start({ sentences: first(10), display: 'source' });
    run.feeder.front(false);
    run.feeder.position(0);
    run.show('both');
    run.feeder.front(true);
    await settle();
    expect(run.asked()).toEqual([ids(0, 3)]);
  });

  it('retries a failed sentence once after 5 s, then marks it failed', async () => {
    const run = start({ sentences: [s(0), s(1)] });
    run.feeder.position(0);
    await settle();
    await run.reply(0, ['s0']);
    // Only the translated line changes; s0 stays untranslated until its retry.
    expect(run.emitted.at(-1)).toEqual([done(1)]);
    expect(FEEDER_LIMITS.retryMs).toBe(5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(run.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.asked()).toEqual([['s0', 's1'], ['s0']]);
    await run.reply(1, ['s0']);
    expect(run.emitted.at(-1)).toEqual([{ ...s(0), state: 'failed' }]);
    run.feeder.position(100);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.calls).toHaveLength(2);
  });

  it.each([
    { name: 'an error', result: () => Promise.resolve(Err(failure('network_failed'))) },
    { name: 'a rejection', result: () => Promise.reject(new Error('channel closed')) },
  ])(
    'treats a request answered with $name as failed for each of its sentences',
    async ({ result }) => {
      const run = start({ sentences: [s(0), s(1)] });
      run.feeder.position(0);
      await settle();
      await run.answer(0, result());
      expect(run.lines().filter((line) => line.state !== 'pending')).toEqual([]);
      await vi.advanceTimersByTimeAsync(FEEDER_LIMITS.retryMs);
      expect(run.asked()).toEqual([
        ['s0', 's1'],
        ['s0', 's1'],
      ]);
      await run.answer(1, result());
      expect(run.emitted.at(-1)).toEqual([
        { ...s(0), state: 'failed' },
        { ...s(1), state: 'failed' },
      ]);
    },
  );

  // s0 ends at 2,500 ms: it stays while the position is at most 602,500 ms.
  it.each([
    { name: '10 分より遠い', seekTo: 602_501, again: true },
    { name: '10 分以内', seekTo: 602_500, again: false },
  ])(
    'prunes translations farther than 10 minutes from the position: $name',
    async ({ seekTo, again }) => {
      const run = start({ sentences: [s(0), s(1, seekTo)] });
      run.feeder.position(0);
      await settle();
      await run.reply(0);
      run.feeder.position(seekTo);
      await settle();
      expect(run.asked()).toEqual([['s0'], ['s1']]);
      await run.reply(1);
      run.feeder.position(0);
      await settle();
      expect(run.asked()).toEqual(again ? [['s0'], ['s1'], ['s0']] : [['s0'], ['s1']]);
      expect(run.emitted.at(-1)).toEqual(again ? [{ ...s(0), state: 'pending' }] : [done(0)]);
    },
  );

  it('drops an answer that arrives after a seek more than 10 minutes away', async () => {
    const run = start({ sentences: [s(0), s(1, 700_000)] });
    run.feeder.position(0);
    await settle();
    run.feeder.position(700_000);
    await run.reply(0);
    expect(run.lines()).not.toContainEqual(expect.objectContaining({ id: 's0', state: 'done' }));
    expect(run.asked()).toEqual([['s0'], ['s1']]);
    await run.reply(1);
    run.feeder.position(0);
    await settle();
    expect(run.asked()).toEqual([['s0'], ['s1'], ['s0']]);
  });

  it('stops sending, showing and retrying once disposed', async () => {
    const run = start({ sentences: first(10) });
    run.feeder.position(0);
    await settle();
    await run.reply(0, ['s0']);
    const shown = run.emitted.length;
    run.feeder.dispose();
    expect(vi.getTimerCount()).toBe(0);
    run.feeder.position(100);
    run.feeder.front(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run.calls).toHaveLength(2);
    await run.reply(1);
    expect(run.emitted).toHaveLength(shown);
  });
});
