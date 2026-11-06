import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  commentBatchPrompt,
  createClefJudge,
  createLlamaClient,
  createQueue,
  genrePrompt,
  parseCommentBatch,
  parseGenre,
  parseSummary,
  summaryPrompt,
  type LlamaClient,
  type SummaryInput,
} from '../src/index.ts';
import {
  startLlamaStub,
  STUB_ABUSIVE,
  STUB_BENIGN,
  STUB_GENRE,
  type LlamaStub,
} from './llama-stub.ts';

// The stub speaks what the extensions send, through the real client: if a prompt or reply
// format changes, this fails before any browser test does.
describe('llama.cpp stub', () => {
  let stub: LlamaStub;
  let client: LlamaClient;
  beforeEach(async () => {
    stub = await startLlamaStub();
    client = createLlamaClient({
      baseUrl: stub.origin,
      fetch: (input, init) => fetch(input, init),
    });
  });
  afterEach(async () => {
    await stub.stop();
  });

  test('answers a genre guess with one genre id', async () => {
    const reply = await client.chat(genrePrompt({ title: 'Fixture Quest Part 3' }));
    expect(reply.ok && parseGenre(reply.value.text)).toBe(STUB_GENRE);
  });

  test('answers a comment batch line per comment: questions by "?", BAD and ROUGH as abusive, translations for marked ones', async () => {
    const comments = [
      { text: 'which level is this?', lang: 'und-Latn', translate: true },
      { text: '今のは上手い', lang: 'ja', translate: false },
      { text: 'BAD sample line', lang: 'und-Latn', translate: true },
      { text: '次はどこ?', lang: 'ja', translate: false },
      { text: 'ROUGH sample line', lang: 'und-Latn', translate: true },
      { text: 'HARSH idiot line', lang: 'und-Latn', translate: true },
    ];
    const reply = await client.chat({
      ...commentBatchPrompt({ comments, context: 'Title: a made-up stream' }),
      model: 'gemma',
      slot: 1,
    });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.value.finishReason).toBe('stop');
    expect(parseCommentBatch(reply.value.text, comments, { cut: false })).toEqual([
      { category: 'question', ja: '訳:which level is this?' },
      { category: 'chatter' },
      { category: 'abusive', ja: '訳:BAD sample line' },
      { category: 'question' },
      { category: 'abusive', ja: '訳:ROUGH sample line' },
      { category: 'chatter', ja: '訳:HARSH idiot line' },
    ]);
  });

  test.each([
    {
      name: 'with questions',
      input: {
        windowMinutes: 5,
        questions: [{ text: 'which level?', count: 2 }],
        peaks: [],
        others: [{ text: 'nice', count: 1 }],
      },
      expected: {
        topics: ['テスト話題'],
        questions: [{ text: 'テスト質問', count: 2, ids: [1] }],
        peaks: [],
      },
    },
    {
      name: 'without questions',
      input: {
        windowMinutes: 15,
        questions: [],
        peaks: [[{ text: 'what a dodge', count: 3 }]],
        others: [],
      },
      expected: { topics: ['テスト話題'], questions: [], peaks: [undefined] },
    },
  ] satisfies { name: string; input: SummaryInput; expected: unknown }[])(
    'answers a summary $name in its line format',
    async ({ input, expected }) => {
      const reply = await client.chat({ ...summaryPrompt(input), model: 'gemma', slot: 1 });
      expect(reply.ok).toBe(true);
      if (!reply.ok) return;
      expect(parseSummary(reply.value.text, input, { cut: false })).toEqual(expected);
    },
  );

  test('has Clef score a text with BAD or HARSH as abusive, one question per comment', async () => {
    const judge = createClefJudge({
      baseUrl: stub.origin,
      model: 'clef-flash',
      fetch: (input, init) => fetch(input, init),
      queue: createQueue(),
    });
    expect(
      await judge.judge(['nice run', 'BAD sample line', 'ROUGH sample line', 'HARSH idiot line']),
    ).toEqual({
      ok: true,
      value: [STUB_BENIGN, STUB_ABUSIVE, STUB_BENIGN, STUB_ABUSIVE],
    });
  });

  test('stop refuses connections until start listens again on the same origin', async () => {
    expect((await client.status()).ok).toBe(true);
    await stub.stop();
    const down = await client.health();
    expect(down.ok ? undefined : down.error.internalCode).toBe('network_failed');
    await stub.start();
    expect(await client.status()).toEqual({ ok: true, value: { models: ['stub-model'] } });
    expect(stub.requests).toEqual([
      'GET /health',
      'GET /v1/models',
      'GET /health',
      'GET /v1/models',
    ]);
  });

  test('answers what a test responder returns, and 404 for an unknown request by default', async () => {
    const plain = await fetch(`${stub.origin}/v1/embeddings`, { method: 'POST', body: '{}' });
    expect(plain.status).toBe(404);
    stub.respond = () => ({ status: 503, body: { error: { code: 503 } } });
    const loading = await client.health();
    expect(loading.ok ? undefined : loading.error.internalCode).toBe('network_failed');
  });
});
