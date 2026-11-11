import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Err,
  failure,
  Ok,
  type RawChatComment,
  type RelayComment,
  type Result,
} from '@chrome-toolbox/contracts';
import { createLlamaClient, type ChatReply, type LlamaClient } from './llm.ts';
import type { ToxicityJudge } from './toxicity.ts';
import {
  createRelayPipeline,
  RELAY_THRESHOLDS,
  type RelayOptions,
  type RelayPipeline,
} from './relay.ts';

const SESSION = '11111111-1111-4111-8111-111111111111';
const NEXT_SESSION = '22222222-2222-4222-8222-222222222222';
const pipelines: RelayPipeline[] = [];
const raw = (id: string, text = 'hello'): RawChatComment => ({ id, text, author: 'viewer', at: 0 });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
};
const reply = (text = 'こんにちは'): Result<ChatReply> =>
  Ok({ text, finishReason: 'stop', timing: undefined });

function setup(options: Partial<RelayOptions> = {}) {
  const published: RelayComment[] = [];
  const requests: Record<string, unknown>[] = [];
  const judge = vi.fn<ToxicityJudge['judge']>(async () => Ok([0.01]));
  const plamo = createLlamaClient({
    baseUrl: 'http://127.0.0.1:18083',
    fetch: async (_url, init) => {
      requests.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'こんにちは' }, finish_reason: 'stop' }],
        }),
      );
    },
  });
  const pipeline = createRelayPipeline({
    sessionId: SESSION,
    judge: { mode: 'clef', judge },
    plamo,
    publish: (comments) => published.push(...comments),
    now: Date.now,
    threshold: 0.8,
    translate: true,
    ...options,
  });
  pipelines.push(pipeline);
  const ingest = (comments: RawChatComment[], sessionId = SESSION) =>
    pipeline.ingest({
      sessionId,
      batchId: crypto.randomUUID(),
      site: 'youtube',
      channel: 'stream',
      comments,
    });
  return { pipeline, published, requests, judge, ingest };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  for (const pipeline of pipelines.splice(0)) pipeline.dispose();
  vi.useRealTimers();
});

describe('relay filtering', () => {
  it.each([
    { strength: 'normal', threshold: RELAY_THRESHOLDS.normal, score: 0.79, allowed: true },
    { strength: 'normal', threshold: RELAY_THRESHOLDS.normal, score: 0.8, allowed: false },
    { strength: 'mild', threshold: RELAY_THRESHOLDS.mild, score: 0.8, allowed: true },
    { strength: 'mild', threshold: RELAY_THRESHOLDS.mild, score: 0.9, allowed: false },
    { strength: 'strict', threshold: RELAY_THRESHOLDS.strict, score: 0.69, allowed: true },
    { strength: 'strict', threshold: RELAY_THRESHOLDS.strict, score: 0.7, allowed: false },
    { strength: 'strict', threshold: RELAY_THRESHOLDS.strict, score: 0.79, allowed: false },
  ])('$strength at $score: allowed=$allowed', async ({ threshold, score, allowed }) => {
    const { ingest, published, judge, pipeline } = setup({ threshold });
    judge.mockResolvedValue(Ok([score]));
    expect(await ingest([{ ...raw('1'), role: 'owner' }])).toMatchObject({
      ok: true,
      value: { accepted: 1, dropped: 0 },
    });
    await settle();
    expect(published).toHaveLength(allowed ? 1 : 0);
    expect(pipeline.status().filtered).toBe(allowed ? 0 : 1);
    expect(published.map((comment) => comment.filter)).toEqual(
      allowed ? [{ verdict: 'allowed', probability: score }] : [],
    );
    expect(judge).toHaveBeenCalledWith(['hello'], expect.any(AbortSignal));
  });

  it.each([
    Ok([]),
    Ok([Number.NaN]),
    Ok([-0.1]),
    Ok([1.1]),
    Ok([0.1, 0.2]),
    Err(failure('network_failed')),
  ])('fails closed for an undecided Clef response %o', async (result) => {
    const { ingest, judge, published, pipeline, requests } = setup();
    judge.mockResolvedValue(result);
    await ingest([raw('1')]);
    await settle();
    expect(published).toEqual([]);
    expect(requests).toEqual([]);
    expect(pipeline.status().failed).toBe(1);
  });

  it('suppresses new input for 30 seconds after a transient Clef failure without retrying old comments', async () => {
    const { ingest, judge, published, pipeline } = setup();
    judge.mockResolvedValueOnce(Err(failure('network_failed')));
    await ingest([raw('1')]);
    await settle();
    expect(await ingest([raw('2')])).toMatchObject({
      ok: true,
      value: { accepted: 0, dropped: 1 },
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(judge).toHaveBeenCalledTimes(1);
    await ingest([raw('3')]);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
    await ingest([raw('4')]);
    await settle();
    expect(published.map((item) => item.id)).toEqual(['4']);
    expect(pipeline.status()).toMatchObject({ failed: 1, dropped: 2, published: 1 });
  });

  it('requires manual reset after clef_unavailable', async () => {
    const { ingest, judge, pipeline, published } = setup();
    judge.mockResolvedValueOnce(Err(failure('clef_unavailable')));
    await ingest([raw('1')]);
    await settle();
    await vi.advanceTimersByTimeAsync(300_000);
    await ingest([raw('2')]);
    await settle();
    expect(judge).toHaveBeenCalledTimes(1);
    pipeline.reset();
    await ingest([raw('3')]);
    await settle();
    expect(published.map((item) => item.id)).toEqual(['3']);
  });

  it('does not publish or start later batch entries when the first Clef request fails', async () => {
    const { ingest, judge, pipeline, published } = setup();
    judge.mockResolvedValueOnce(Err(failure('network_failed')));
    await ingest([raw('1', 'a'), raw('2', 'b'), raw('3', 'c'), raw('4', 'd')]);
    await settle();
    expect(published).toEqual([]);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(pipeline.status().dropped).toBeGreaterThanOrEqual(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('relay translation', () => {
  it.each([
    { translate: false, text: 'hello', state: 'disabled', calls: 0 },
    { translate: true, text: 'こんにちは', state: 'unnecessary', calls: 0 },
    { translate: true, text: 'hello', state: 'translated', calls: 1 },
    { translate: true, text: '謝謝', state: 'translated', calls: 1 },
  ])('$text translate=$translate becomes $state', async ({ translate, text, state, calls }) => {
    const { ingest, published, requests } = setup({ translate });
    await ingest([raw('1', text)]);
    await settle();
    expect(requests).toHaveLength(calls);
    expect(published[0]).toMatchObject({
      original: text,
      translationState: state,
      translation: calls ? 'こんにちは' : null,
    });
  });

  it.each(['hello', '謝謝'])(
    'omits uncertain source_lang for %s and sends only the PLaMo contract',
    async (text) => {
      const { ingest, requests } = setup();
      await ingest([raw('1', text)]);
      await settle();
      expect(requests[0]).toEqual({
        model: 'plamo-3-translate-2b',
        messages: [{ role: 'user', content: text }],
        stream: false,
        cache_prompt: true,
        temperature: 0,
        max_tokens: expect.any(Number),
        chat_template_kwargs: { target_lang: 'ja' },
        stop: ['<|plamo:tag|>', '<|plamo:bos|>'],
      });
      expect(Number(requests[0]?.max_tokens)).toBeLessThanOrEqual(256);
    },
  );

  it('sends a normalized supported explicit source language', async () => {
    const { ingest, requests } = setup({ sourceLang: 'en-US' });
    await ingest([raw('1')]);
    await settle();
    expect(requests[0]?.chat_template_kwargs).toEqual({ target_lang: 'ja', source_lang: 'en' });
  });

  it('falls back without a request for an unsupported explicit language', async () => {
    const { ingest, requests, published } = setup({ sourceLang: 'pt' });
    await ingest([raw('1')]);
    await settle();
    expect(requests).toEqual([]);
    expect(published[0]).toMatchObject({
      original: 'hello',
      translation: null,
      translationState: 'unsupported',
      translator: null,
    });
  });

  it.each([
    Err(failure('model_refused')),
    reply(''),
    reply('<|plamo:tag|>broken'),
    Ok({ text: 'partial', finishReason: 'length', timing: undefined }),
  ])('falls back to the judged original on PLaMo failure %o', async (result) => {
    const { ingest, published, pipeline } = setup({
      plamo: {
        ...createLlamaClient({ baseUrl: '', fetch: async () => new Response() }),
        chat: async () => result,
      },
    });
    await ingest([raw('1')]);
    await settle();
    expect(published[0]).toMatchObject({
      original: 'hello',
      translation: null,
      translationState: 'failed',
      translator: null,
    });
    expect(pipeline.status()).toMatchObject({ published: 1, failed: 1 });
  });

  it('rejects reserved markers without passing them to PLaMo', async () => {
    const { ingest, requests, published } = setup();
    await ingest([raw('1', 'hello <|plamo:tag|>')]);
    await settle();
    expect(requests).toEqual([]);
    expect(published[0]?.translationState).toBe('failed');
  });

  it('retries PLaMo only for a new arrival after its 30-second suppression', async () => {
    const calls: string[] = [];
    const client = createLlamaClient({ baseUrl: '', fetch: async () => new Response() });
    const { ingest, published } = setup({
      plamo: {
        ...client,
        chat: async (input) => {
          const content = input.messages[0]?.content;
          calls.push(typeof content === 'string' ? content : '');
          return calls.length === 1 ? Err(failure('network_failed')) : reply();
        },
      },
    });
    await ingest([raw('1', 'one')]);
    await settle();
    await ingest([raw('2', 'two')]);
    await settle();
    expect(calls).toEqual(['one']);
    expect(published.map((item) => item.translationState)).toEqual(['failed', 'failed']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toEqual(['one']);
    await ingest([raw('3', 'three')]);
    await settle();
    expect(calls).toEqual(['one', 'three']);
    expect(published[2]?.translationState).toBe('translated');
  });
});

describe('relay scheduling and lifetime', () => {
  it('drops wrong sessions, duplicate IDs and blank text before inference', async () => {
    const { ingest, judge, published } = setup();
    expect(await ingest([raw('1')], NEXT_SESSION)).toMatchObject({
      ok: true,
      value: { accepted: 0, dropped: 1 },
    });
    expect(await ingest([raw('1'), raw('1'), raw('2', '  '), raw('3', '')])).toMatchObject({
      ok: true,
      value: { accepted: 1, dropped: 3 },
    });
    await settle();
    expect(published.map((item) => item.id)).toEqual(['1']);
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('drops the oldest waiting entry beyond 64 and preserves the executing batch', async () => {
    const gate = deferred<Result<number[]>>();
    const { ingest, judge, published, pipeline } = setup({ translate: false });
    judge.mockImplementationOnce(() => gate.promise);
    await ingest([raw('a', 'held'), raw('b', 'held'), raw('c', 'held')]);
    await ingest(Array.from({ length: 65 }, (_, i) => raw(String(i), 'queued')));
    expect(pipeline.status().dropped).toBe(1);
    gate.resolve(Ok([0.01]));
    await settle();
    expect(published.map((item) => item.id)).toEqual([
      'a',
      'b',
      'c',
      ...Array.from({ length: 64 }, (_, i) => String(i + 1)),
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires waiting entries after eight seconds without publishing unjudged text', async () => {
    const gate = deferred<Result<number[]>>();
    const { ingest, judge, published, pipeline } = setup({ translate: false });
    judge.mockImplementationOnce(() => gate.promise);
    await ingest([raw('a', 'held'), raw('b', 'held'), raw('c', 'held'), raw('waiting', 'queued')]);
    await vi.advanceTimersByTimeAsync(8001);
    expect(pipeline.status().dropped).toBe(1);
    gate.resolve(Ok([0.01]));
    await settle();
    expect(published.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('bounds the entire processing time and ignores a late model answer', async () => {
    const gate = deferred<Result<number[]>>();
    const { ingest, judge, published, pipeline } = setup();
    judge.mockImplementationOnce(() => gate.promise);
    await ingest([raw('1')]);
    await vi.advanceTimersByTimeAsync(30_000);
    gate.resolve(Ok([0.01]));
    await settle();
    expect(published).toEqual([]);
    expect(pipeline.status().dropped + pipeline.status().failed).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['session', 'settings', 'dispose'])(
    'invalidates delayed results on %s changes',
    async (change) => {
      const gate = deferred<Result<number[]>>();
      const { ingest, judge, published, pipeline } = setup();
      judge.mockImplementationOnce(() => gate.promise);
      await ingest([raw('1')]);
      const signal = judge.mock.calls[0]?.[1];
      if (change === 'dispose') pipeline.dispose();
      else pipeline.reset(change === 'session' ? { sessionId: NEXT_SESSION } : { threshold: 0.7 });
      expect(signal?.aborted).toBe(true);
      gate.resolve(Ok([0.01]));
      await settle();
      expect(published).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('publishes in receive order while translating one line and judging the next concurrently', async () => {
    const gate = deferred<Result<ChatReply>>();
    const client = createLlamaClient({ baseUrl: '', fetch: async () => new Response() });
    const chat = vi.fn<LlamaClient['chat']>(async () => gate.promise);
    const { ingest, judge, published } = setup({ plamo: { ...client, chat } });
    await ingest([raw('1', 'hello'), raw('2', 'こんにちは'), raw('3', 'hello')]);
    await settle();
    expect(judge).toHaveBeenCalledTimes(2);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(published).toEqual([]);
    gate.resolve(reply());
    await settle();
    expect(published.map((item) => [item.id, item.seq])).toEqual([
      ['1', 1],
      ['2', 2],
      ['3', 3],
    ]);
  });

  it('has zero idle timers and makes no periodic model requests', async () => {
    const { ingest, judge, requests } = setup();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(judge).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    await ingest([raw('1')]);
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });
});

describe('relay caches', () => {
  it('shares in-flight identical text and caches probability and translation until ten minutes', async () => {
    const gate = deferred<Result<number[]>>();
    const { ingest, judge, requests, published } = setup();
    judge.mockImplementationOnce(() => gate.promise);
    await ingest([raw('1'), raw('2')]);
    await settle();
    expect(judge).toHaveBeenCalledTimes(1);
    gate.resolve(Ok([0.01]));
    await settle();
    expect(published).toHaveLength(2);
    expect(requests).toHaveLength(1);
    await ingest([raw('3')]);
    await settle();
    expect(judge).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600_000);
    await ingest([raw('4')]);
    await settle();
    expect(judge).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
  });

  it('clears dedupe and caches when models/session change and applies the current threshold', async () => {
    const { ingest, judge, requests, pipeline, published } = setup();
    judge.mockResolvedValue(Ok([0.79]));
    await ingest([raw('1')]);
    await settle();
    pipeline.reset({ threshold: 0.7, clefRevision: 'new' });
    await ingest([raw('1')]);
    await settle();
    expect(judge).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(pipeline.status().filtered).toBe(1);
  });
});

describe('relay resource boundaries', () => {
  it('evicts the least recently used probability and translation beyond 500 entries', async () => {
    const { ingest, judge, requests } = setup();
    for (let i = 0; i < 500; i += 1) {
      await ingest([raw(String(i), `line ${i}`)]);
      await settle();
    }
    await ingest([raw('touch', 'line 0')]);
    await settle();
    expect(judge).toHaveBeenCalledTimes(500);
    expect(requests).toHaveLength(500);
    await ingest([raw('501', 'line 500')]);
    await settle();
    await ingest([raw('keep', 'line 0')]);
    await settle();
    expect(judge).toHaveBeenCalledTimes(501);
    await ingest([raw('evicted', 'line 1')]);
    await settle();
    expect(judge).toHaveBeenCalledTimes(502);
    expect(requests).toHaveLength(502);
  });

  it('bounds dedupe to 2000 IDs while retaining recently accessed IDs', async () => {
    const { ingest, published } = setup({ translate: false });
    for (let i = 0; i < 2000; i += 1) {
      await ingest([raw(String(i))]);
      await settle();
    }
    await ingest([raw('0')]);
    await ingest([raw('2000')]);
    await settle();
    expect(await ingest([raw('0')])).toMatchObject({
      ok: true,
      value: { accepted: 0, dropped: 1 },
    });
    expect(await ingest([raw('1')])).toMatchObject({
      ok: true,
      value: { accepted: 1, dropped: 0 },
    });
    await settle();
    expect(published).toHaveLength(2002);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not truncate a long comment before Clef judgment', async () => {
    const { ingest, judge, published } = setup({ translate: false });
    const text = 'あ'.repeat(1000);
    await ingest([raw('1', text)]);
    await settle();
    expect(judge).toHaveBeenCalledWith([text], expect.any(AbortSignal));
    expect(published[0]?.original).toBe(text);
  });

  it('discards a late PLaMo result after reset without poisoning the new generation cache', async () => {
    const gate = deferred<Result<ChatReply>>();
    const client = createLlamaClient({ baseUrl: '', fetch: async () => new Response() });
    const chat = vi
      .fn<LlamaClient['chat']>()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue(reply('新しい訳'));
    const { ingest, pipeline, published } = setup({ plamo: { ...client, chat } });
    await ingest([raw('1')]);
    await settle();
    pipeline.reset({ sessionId: NEXT_SESSION, plamoRevision: 'new' });
    await ingest([raw('2')], NEXT_SESSION);
    await settle();
    gate.resolve(reply('古い訳'));
    await settle();
    expect(published.map((comment) => [comment.sessionId, comment.translation])).toEqual([
      [NEXT_SESSION, '新しい訳'],
    ]);
    await ingest([raw('3')], NEXT_SESSION);
    await settle();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(published[1]?.translation).toBe('新しい訳');
  });

  it('applies a 30-second total deadline across judging and translation', async () => {
    const clef = deferred<Result<number[]>>();
    const plamo = deferred<Result<ChatReply>>();
    const client = createLlamaClient({ baseUrl: '', fetch: async () => new Response() });
    const { ingest, judge, published } = setup({
      plamo: { ...client, chat: async () => plamo.promise },
    });
    judge.mockImplementationOnce(() => clef.promise);
    await ingest([raw('1')]);
    await vi.advanceTimersByTimeAsync(20_000);
    clef.resolve(Ok([0.01]));
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    plamo.resolve(reply());
    await settle();
    expect(published).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1])(
  'fails closed for an invalid threshold %s',
  async (threshold) => {
    const { ingest, judge, published } = setup({ threshold });
    expect(await ingest([raw('1')])).toMatchObject({
      ok: false,
      error: { internalCode: 'input_invalid' },
    });
    await settle();
    expect(judge).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  },
);

it('includes the seven-second admission wait in the total 30-second deadline', async () => {
  const first = deferred<Result<number[]>>();
  const second = deferred<Result<number[]>>();
  const { ingest, judge, published } = setup({ translate: false });
  judge.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  await ingest([raw('1', 'first')]);
  await vi.advanceTimersByTimeAsync(1000);
  await ingest([raw('2', 'second')]);
  await vi.advanceTimersByTimeAsync(7000);
  first.resolve(Ok([0.01]));
  await settle();
  await vi.advanceTimersByTimeAsync(24_000);
  second.resolve(Ok([0.01]));
  await settle();
  expect(published.map((comment) => comment.id)).toEqual(['1']);
  expect(vi.getTimerCount()).toBe(0);
});
