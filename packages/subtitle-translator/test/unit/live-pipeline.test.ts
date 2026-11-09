import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Err, failure, Ok, type AppError, type Result } from '@chrome-toolbox/contracts';
import { systemTimers, type AsrClient, type AsrLine } from '@chrome-toolbox/extension-core';
import { createLivePipeline, LIVE_LIMITS, type LiveConfig } from '../../src/audio/live-pipeline.ts';
import type { LineInput } from '../../src/line-translator.ts';
import { liveLineSchema, type LiveLine } from '../../src/protocol.ts';

/** The fake clock at the start of each test (`Date.now()`), in ms. */
const START = 100_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: START });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Lets the pipeline see an answer and start what comes next. */
const settle = () => vi.advanceTimersByTimeAsync(0);

type AsrOptions = Parameters<AsrClient['transcribe']>[1];
type AsrCall = {
  pcm: Int16Array;
  options: AsrOptions;
  resolve: (result: Result<AsrLine & { ms: number }>) => void;
};
type TranslateCall = {
  input: LineInput & { signal: AbortSignal };
  resolve: (result: Result<string>) => void;
};
type Speech = { durationMs?: number; gapBeforeMs?: number; endedAt?: number };

/** `lang\ttext` as the ASR client returns it (the text untrimmed, to see the pipeline trim it). */
function asrLine(reply: string): Result<AsrLine & { ms: number }> {
  const [lang = '', text = ''] = reply.split('\t');
  return Ok({ lang, text, ms: 0 });
}

const CONFIG: LiveConfig = {
  display: 'both',
  sourceLang: 'auto',
  context: 'Stream: Fixture Ch',
  glossary: [{ source: 'Fixturo', target: 'フィクスチャロ' }],
  translator: 'gemma',
};

/**
 * A pipeline on fake clients that answer when the test says so. `log` lists the requests in the
 * order they started: `asr:<durationMs>` and `translate:<source>`.
 */
function start(config: Partial<LiveConfig> = {}) {
  const log: string[] = [];
  const asrCalls: AsrCall[] = [];
  const translateCalls: TranslateCall[] = [];
  const lines: LiveLine[] = [];
  const failures: AppError[] = [];
  const asr: AsrClient = {
    transcribe: (pcm, options) =>
      new Promise((resolve) => {
        log.push(`asr:${pcm.length / 16}`);
        asrCalls.push({ pcm, options, resolve });
      }),
  };
  const translate = (input: LineInput & { signal: AbortSignal }) =>
    new Promise<Result<string>>((resolve) => {
      log.push(`translate:${input.source}`);
      translateCalls.push({ input, resolve });
    });
  const pipeline = createLivePipeline({
    asr,
    translate,
    config: () => ({ ...CONFIG, ...config }),
    emit: (line) => lines.push(line),
    now: () => Date.now(),
    timers: systemTimers,
    onFailure: (error) => failures.push(error),
  });
  let heard = 0;
  let translated = 0;

  /** Pushes a segment (1,000 ms long by default) whose speech ended now unless `endedAt` says. */
  function push({ durationMs = 1000, gapBeforeMs = 0, endedAt = Date.now() }: Speech = {}) {
    pipeline.push({
      pcm: new Int16Array(16 * durationMs),
      durationMs,
      trailingSilenceMs: 300,
      carriedMs: 0,
      gapBeforeMs,
      endedAt,
    });
  }
  /** Answers the oldest transcription not answered yet with `lang\ttext`, or fails it. */
  async function hear(reply: string | AppError) {
    const call = asrCalls[heard];
    if (call === undefined) throw new Error(`no transcription ${heard}`);
    heard += 1;
    call.resolve(typeof reply === 'string' ? asrLine(reply) : Err(reply));
    await settle();
  }
  /** Answers the oldest translation not answered yet with `訳:<source>`, the given text, or fails it. */
  async function translateNext(reply?: string | AppError) {
    const call = translateCalls[translated];
    if (call === undefined) throw new Error(`no translation ${translated}`);
    translated += 1;
    call.resolve(
      reply === undefined
        ? Ok(`訳:${call.input.source}`)
        : typeof reply === 'string'
          ? Ok(reply)
          : Err(reply),
    );
    await settle();
  }
  /** Pushes a segment and answers its transcription. */
  async function say(reply: string | AppError, speech: Speech = {}) {
    push(speech);
    await hear(reply);
  }
  /** Answers every request until none runs: transcriptions as silence, translations as `訳:`. */
  async function drain() {
    for (;;) {
      if (heard < asrCalls.length) await hear('en\t');
      else if (translated < translateCalls.length) await translateNext();
      else return;
    }
  }
  return {
    pipeline,
    log,
    asrCalls,
    translateCalls,
    lines,
    failures,
    push,
    hear,
    translateNext,
    say,
    drain,
    stats: () => pipeline.stats(),
    /** The lines as `[id, source, state, final, ja]`, ids numbered by first appearance. */
    rows: () => {
      const ids: string[] = [];
      return lines.map((line) => {
        if (!ids.includes(line.sentenceId)) ids.push(line.sentenceId);
        return [ids.indexOf(line.sentenceId), line.source, line.state, line.final, line.ja];
      });
    },
  };
}

describe('live pipeline', () => {
  it('emits the source line before the translation and records latency from the speech end', async () => {
    const t = start();
    t.push();
    expect(t.asrCalls[0]?.options).toEqual({
      sourceLang: 'auto',
      context: CONFIG.context,
      glossary: CONFIG.glossary,
      signal: expect.any(AbortSignal),
    });
    vi.advanceTimersByTime(200);
    await t.hear('en\tOkay chat.');
    expect(t.lines).toEqual([
      {
        sentenceId: expect.any(String),
        lang: 'en',
        source: 'Okay chat.',
        state: 'pending',
        endedAt: START,
        final: true,
      },
    ]);
    expect(t.translateCalls[0]?.input).toEqual({
      source: 'Okay chat.',
      sourceLang: 'en',
      previous: [],
      context: CONFIG.context,
      glossary: CONFIG.glossary,
      signal: expect.any(AbortSignal),
    });
    vi.advanceTimersByTime(300);
    await t.translateNext();
    expect(t.lines[1]).toEqual({ ...t.lines[0], ja: '訳:Okay chat.', state: 'done' });
    for (const line of t.lines) expect(liveLineSchema.safeParse(line).success).toBe(true);
    expect(t.stats()).toEqual({
      segments: 1,
      silent: 0,
      dropped: 0,
      expired: 0,
      skipped: 0,
      failed: 0,
      lang: 'en',
      sourceP50Ms: 200,
      jaP50Ms: 500,
      jaP95Ms: 500,
    });
  });

  it.each([
    {
      name: '日本語の音声',
      asr: 'ja\tよし行くぞ',
      display: 'both',
      translateCalls: 0,
      ja: 'よし行くぞ',
    },
    {
      name: '原語のみ',
      asr: 'en\tOkay chat.',
      display: 'source',
      translateCalls: 0,
      ja: undefined,
    },
  ] as const)('skips translation: $name', async (row) => {
    const t = start({ display: row.display });
    vi.advanceTimersByTime(300);
    await t.say(row.asr, { endedAt: START });
    expect(t.translateCalls).toHaveLength(row.translateCalls);
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]?.state).toBe('done');
    expect(t.lines[0]?.ja).toBe(row.ja);
    expect(t.stats().sourceP50Ms).toBe(300);
  });

  it('re-translates a split sentence under the same id and closes it at the end mark', async () => {
    const t = start();
    await t.say('en\tOkay chat', { durationMs: 800 });
    await t.translateNext();
    await t.say('en\twe are going in.', { durationMs: 900, gapBeforeMs: 200 });
    await t.translateNext();
    expect(t.rows()).toEqual([
      [0, 'Okay chat', 'pending', false, undefined],
      [0, 'Okay chat', 'done', false, '訳:Okay chat'],
      [0, 'Okay chat we are going in.', 'pending', true, undefined],
      [0, 'Okay chat we are going in.', 'done', true, '訳:Okay chat we are going in.'],
    ]);
    expect(t.log).toEqual([
      'asr:800',
      'translate:Okay chat',
      'asr:900',
      'translate:Okay chat we are going in.',
    ]);
  });

  it.each<{ name: string; first: [string, Speech?][]; next: [string, Speech?] }>([
    {
      name: '700ms の間',
      first: [['en\tOkay chat']],
      next: ['en\twe are going in', { gapBeforeMs: LIVE_LIMITS.sentenceGapMs }],
    },
    { name: '言語が変わった', first: [['en\tOkay chat']], next: ['ko\t가자'] },
    {
      name: '6 秒',
      first: ['one', 'two', 'three', 'four'].map((word) => [`en\t${word}`, { durationMs: 1500 }]),
      next: ['en\tfive'],
    },
    { name: '200 文字', first: [[`en\t${'a'.repeat(150)}`]], next: [`en\t${'b'.repeat(60)}`] },
  ])('closes the open sentence: $name', async ({ first, next }) => {
    const t = start({ display: 'source' });
    for (const [reply, speech] of first) await t.say(reply, speech);
    const opened = t.lines[0]?.sentenceId;
    expect(t.lines.every((line) => line.sentenceId === opened)).toBe(true);
    await t.say(...next);
    const closed = t.lines.filter((line) => line.sentenceId === opened);
    expect(closed.at(-1)?.final).toBe(true);
    expect(t.lines.at(-1)?.sentenceId).not.toBe(opened);
    expect(t.lines.at(-1)?.final).toBe(false);
    for (const line of t.lines) expect(liveLineSchema.safeParse(line).success).toBe(true);
  });

  it('keeps at most two segments waiting and drops the oldest', async () => {
    const t = start();
    for (const durationMs of [400, 500, 600, 700, 800]) t.push({ durationMs });
    expect(t.asrCalls).toHaveLength(1);
    expect(t.stats()).toMatchObject({ segments: 5, dropped: 2 });
    await t.drain();
    expect(t.log).toEqual(['asr:400', 'asr:700', 'asr:800']);
    expect(t.stats()).toMatchObject({ segments: 5, dropped: 2, silent: 3 });
  });

  it('drops ASR that cannot start within 1.5 s and translations within 2.5 s of the speech end', async () => {
    const t = start();
    t.push({ durationMs: 400 });
    t.push({ durationMs: 500 });
    vi.advanceTimersByTime(LIVE_LIMITS.asrStartDeadlineMs);
    expect(t.stats().expired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(t.stats().expired).toBe(1);
    vi.advanceTimersByTime(LIVE_LIMITS.translationStartDeadlineMs - LIVE_LIMITS.asrStartDeadlineMs);
    await t.hear('en\tOkay chat.');
    expect(t.log).toEqual(['asr:400']);
    expect(t.rows()).toEqual([
      [0, 'Okay chat.', 'pending', true, undefined],
      [0, 'Okay chat.', 'skipped', true, undefined],
    ]);
    expect(t.stats()).toMatchObject({ segments: 2, expired: 1, skipped: 1, dropped: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    {
      name: '翻訳の方が古い',
      endedAt: START + 100,
      order: ['asr:400', 'translate:Okay chat.', 'asr:500'],
    },
    {
      name: '同じなら翻訳が先',
      endedAt: START,
      order: ['asr:400', 'translate:Okay chat.', 'asr:500'],
    },
    {
      name: 'ASR の方が古い',
      endedAt: START - 100,
      order: ['asr:400', 'asr:500', 'translate:Okay chat.'],
    },
  ])(
    'runs the job with the oldest speech end first, translation before ASR on a tie: $name',
    async ({ endedAt, order }) => {
      const t = start();
      t.push({ durationMs: 400 });
      vi.advanceTimersByTime(100);
      t.push({ durationMs: 500, endedAt });
      await t.hear('en\tOkay chat.');
      await t.drain();
      expect(t.log).toEqual(order);
    },
  );

  it('replaces a waiting translation of the same sentence with the newer text', async () => {
    const t = start();
    t.push({ durationMs: 400 });
    // A speech end before the running one's is what puts a segment ahead of that one's translation.
    t.push({ durationMs: 500, endedAt: START - 50 });
    await t.hear('en\tOkay chat');
    await t.hear('en\twe are going in.');
    await t.drain();
    expect(t.log).toEqual(['asr:400', 'asr:500', 'translate:Okay chat we are going in.']);
    expect(t.rows()).toEqual([
      [0, 'Okay chat', 'pending', false, undefined],
      [0, 'Okay chat we are going in.', 'pending', true, undefined],
      [0, 'Okay chat we are going in.', 'done', true, '訳:Okay chat we are going in.'],
    ]);
    expect(t.stats().skipped).toBe(0);
  });

  it('keeps at most two sentences waiting for translation and skips the oldest', async () => {
    const t = start();
    t.push({ durationMs: 400 });
    t.push({ durationMs: 500, endedAt: START - 100 });
    await t.hear('en\tOne.');
    t.push({ durationMs: 600, endedAt: START - 200 });
    await t.hear('en\tTwo.');
    await t.hear('en\tThree.');
    expect(t.stats().skipped).toBe(1);
    await t.drain();
    expect(t.log).toEqual(['asr:400', 'asr:500', 'asr:600', 'translate:Three.', 'translate:Two.']);
    expect(t.rows()).toEqual([
      [0, 'One.', 'pending', true, undefined],
      [1, 'Two.', 'pending', true, undefined],
      [2, 'Three.', 'pending', true, undefined],
      [0, 'One.', 'skipped', true, undefined],
      [2, 'Three.', 'done', true, '訳:Three.'],
      [1, 'Two.', 'done', true, '訳:Two.'],
    ]);
  });

  it('away drops waiting jobs and aborts the running one; pause lets them finish', async () => {
    const away = start();
    for (const durationMs of [400, 500, 600]) away.push({ durationMs });
    away.pipeline.mode('away');
    expect(away.asrCalls[0]?.options.signal?.aborted).toBe(true);
    expect(away.stats()).toMatchObject({ segments: 3, dropped: 3 });
    // The aborted request answers late; a segment already on its way when the front changed comes.
    await away.hear(failure('operation_cancelled'));
    away.push({ durationMs: 700 });
    expect(away.stats()).toMatchObject({ segments: 4, dropped: 4, failed: 0 });
    expect(away.lines).toEqual([]);
    expect(away.failures).toEqual([]);
    away.pipeline.mode('active');
    away.push({ durationMs: 800 });
    expect(away.log).toEqual(['asr:400', 'asr:800']);

    const pause = start();
    pause.push({ durationMs: 400 });
    pause.push({ durationMs: 500 });
    pause.pipeline.mode('pause');
    await pause.hear('en\tOkay chat.');
    await pause.translateNext();
    await pause.hear('en\tWe are going in.');
    await pause.translateNext();
    expect(pause.log).toEqual([
      'asr:400',
      'translate:Okay chat.',
      'asr:500',
      'translate:We are going in.',
    ]);
    expect(pause.lines.filter((line) => line.state === 'done').map((line) => line.ja)).toEqual([
      '訳:Okay chat.',
      '訳:We are going in.',
    ]);
    expect(pause.stats()).toMatchObject({ dropped: 0, skipped: 0 });
  });

  it('away closes the open sentence and leaves it in its source', async () => {
    const t = start();
    await t.say('en\tOkay chat');
    t.push({ durationMs: 500 });
    t.pipeline.mode('away');
    expect(t.translateCalls[0]?.input.signal.aborted).toBe(true);
    expect(t.stats()).toMatchObject({ dropped: 1, skipped: 1 });
    await t.translateNext('遅い訳');
    expect(t.rows()).toEqual([
      [0, 'Okay chat', 'pending', false, undefined],
      [0, 'Okay chat', 'skipped', true, undefined],
    ]);
    t.pipeline.mode('active');
    await t.say('en\twe are going in.');
    expect(t.rows().at(-1)).toEqual([1, 'we are going in.', 'pending', true, undefined]);
    expect(t.translateCalls[1]?.input.previous).toEqual(['Okay chat']);
  });

  it('starts a new sentence after a pause: the gap across it is unknown', async () => {
    const t = start({ display: 'source' });
    await t.say('en\tOkay chat');
    t.pipeline.mode('pause');
    t.pipeline.mode('active');
    await t.say('en\twe are going in');
    expect(t.rows()).toEqual([
      [0, 'Okay chat', 'done', false, undefined],
      [0, 'Okay chat', 'done', true, undefined],
      [1, 'we are going in', 'done', false, undefined],
    ]);
  });

  it('counts a failed recognition and goes on with the next segment', async () => {
    const t = start();
    t.push({ durationMs: 400 });
    t.push({ durationMs: 500 });
    await t.hear(failure('response_invalid'));
    expect(t.lines).toEqual([]);
    expect(t.stats().failed).toBe(1);
    expect(t.failures.map((error) => error.internalCode)).toEqual(['response_invalid']);
    await t.hear('en\tWe are going in.');
    expect(t.rows()).toEqual([[0, 'We are going in.', 'pending', true, undefined]]);
  });

  it.each<{
    name: string;
    between: string | AppError;
    speech: Speech;
    next: Speech;
    joins: boolean;
  }>([
    {
      name: '認識できなかった区切りの後',
      between: failure('response_invalid'),
      speech: {},
      next: {},
      joins: false,
    },
    {
      name: '無音の区切りを挟んで 700 ms 以上',
      between: 'en\t',
      speech: { gapBeforeMs: 200, durationMs: 400 },
      next: { gapBeforeMs: 100 },
      joins: false,
    },
    {
      name: '無音の区切りを挟んで 700 ms 未満',
      between: 'en\t',
      speech: { gapBeforeMs: 100, durationMs: 300 },
      next: { gapBeforeMs: 100 },
      joins: true,
    },
  ])('joins the next text across a segment without one: $name', async (row) => {
    const t = start({ display: 'source' });
    await t.say('en\tOkay chat');
    await t.say(row.between, row.speech);
    await t.say('en\twe are going in', row.next);
    const ids = new Set(t.lines.map((line) => line.sentenceId));
    expect(ids.size).toBe(row.joins ? 1 : 2);
  });

  it('starts a new sentence after a segment dropped from the queue', async () => {
    const t = start({ display: 'source' });
    t.push({ durationMs: 400 });
    for (const durationMs of [500, 600, 700]) t.push({ durationMs });
    await t.hear('en\tOkay chat');
    await t.hear('en\tand');
    await t.hear('en\twe are going in');
    expect(t.log).toEqual(['asr:400', 'asr:600', 'asr:700']);
    expect(t.rows()).toEqual([
      [0, 'Okay chat', 'done', false, undefined],
      [0, 'Okay chat', 'done', true, undefined],
      [1, 'and', 'done', false, undefined],
      [1, 'and we are going in', 'done', false, undefined],
    ]);
  });

  it('leaves a line in its source when its translation fails', async () => {
    const t = start();
    await t.say('en\tOkay chat.');
    await t.translateNext(failure('network_failed'));
    expect(t.rows().at(-1)).toEqual([0, 'Okay chat.', 'failed', true, undefined]);
    expect(t.stats()).toMatchObject({ failed: 1 });
    expect(t.stats().jaP50Ms).toBeUndefined();
    expect(t.failures.map((error) => error.internalCode)).toEqual(['network_failed']);
  });

  it('counts silent segments without emitting a line', async () => {
    const t = start();
    await t.say('en\t');
    await t.say('ko\t   ');
    expect(t.lines).toEqual([]);
    expect(t.translateCalls).toEqual([]);
    expect(t.stats()).toMatchObject({ segments: 2, silent: 2 });
    expect(t.stats().lang).toBeUndefined();
  });

  it('passes the three previous closed sentences of the same language as context', async () => {
    const t = start();
    for (const text of ['One.', 'Two.', 'Three.', 'Four.', '하나.', 'Five', 'six.']) {
      const lang = text === '하나.' ? 'ko' : 'en';
      await t.say(`${lang}\t${text}`);
      await t.translateNext();
    }
    expect(t.translateCalls.map(({ input }) => [input.source, input.previous])).toEqual([
      ['One.', []],
      ['Two.', ['One.']],
      ['Three.', ['One.', 'Two.']],
      ['Four.', ['One.', 'Two.', 'Three.']],
      ['하나.', []],
      // Only the last three sentences are kept (Three., Four., 하나.); the open one is not context.
      ['Five', ['Three.', 'Four.']],
      ['Five six.', ['Three.', 'Four.']],
    ]);
  });

  it('reset forgets the language, the context and the open sentence, and drops queued work', async () => {
    const t = start();
    await t.say('en\tOne.');
    await t.translateNext();
    await t.say('en\tOkay chat');
    t.push({ durationMs: 500 });
    const emitted = t.lines.length;
    t.pipeline.reset();
    expect(t.translateCalls[1]?.input.signal.aborted).toBe(true);
    expect(t.stats()).toMatchObject({ dropped: 1, skipped: 1 });
    expect(t.stats().lang).toBeUndefined();
    await t.translateNext('遅い訳');
    expect(t.lines).toHaveLength(emitted);
    await t.say('en\twe are going in');
    expect(t.lines).toHaveLength(emitted + 1);
    expect(t.rows().at(-1)).toEqual([2, 'we are going in', 'pending', false, undefined]);
    expect(t.translateCalls[2]?.input.previous).toEqual([]);
    expect(t.stats().lang).toBe('en');
  });

  it('dispose aborts the running request and ignores what comes after', async () => {
    const t = start();
    t.push({ durationMs: 400 });
    t.push({ durationMs: 500 });
    t.pipeline.dispose();
    expect(t.asrCalls[0]?.options.signal?.aborted).toBe(true);
    await t.hear('en\tOkay chat.');
    t.push();
    t.pipeline.mode('active');
    expect(t.lines).toEqual([]);
    expect(t.asrCalls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
