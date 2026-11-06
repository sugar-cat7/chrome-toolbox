import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Result } from '@chrome-toolbox/contracts';
import {
  commentBatchPrompt,
  createClefJudge,
  createLlamaClient,
  createQueue,
  genrePrompt,
  parseCommentBatch,
  parseGenre,
  parseSummary,
  PLAMO_TRANSLATE_MODEL,
  plamoTranslateRequest,
  summaryPrompt,
  type LlamaClient,
  type SummaryInput,
} from '../src/index.ts';
import {
  commentBatchReply,
  defaultResponder,
  startLlamaStub,
  STUB_ABUSIVE,
  STUB_BENIGN,
  STUB_GENRE,
  STUB_PLAMO_PREFIX,
  withPlamo,
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

  const plamoLine = { line: 'Okay chat', sourceLang: 'en', previous: [], glossary: [], slot: 0 };
  const plamoRequest = () => {
    const request = plamoTranslateRequest(plamoLine);
    if (!request.ok) throw new Error('the request must build');
    return request.value;
  };
  const codeOf = (result: Result<unknown>): string =>
    result.ok ? 'ok' : result.error.internalCode;

  test('withPlamo lists the model and answers the request plamoTranslateRequest builds', async () => {
    stub.respond = withPlamo(defaultResponder);
    expect(await client.models()).toEqual({
      ok: true,
      value: ['stub-model', PLAMO_TRANSLATE_MODEL],
    });
    const reply = await client.chat(plamoRequest());
    expect(reply.ok && reply.value.text).toBe(`${STUB_PLAMO_PREFIX}Okay chat`);
    expect(STUB_PLAMO_PREFIX).toBe('訳P:');
  });

  test.each([
    { name: 'system メッセージ', change: 'system' },
    { name: 'grammar', change: 'grammar' },
    { name: 'stop がない', change: 'no-stop' },
    { name: 'response_format', change: 'response-format' },
  ])('withPlamo refuses a PLaMo chat with $name with 400', async ({ change }) => {
    stub.respond = withPlamo(defaultResponder);
    const request = plamoRequest();
    const changed = {
      system: {
        ...request,
        messages: [{ role: 'system' as const, content: 'x' }, ...request.messages],
      },
      grammar: { ...request, grammar: 'root ::= "a"' },
      'no-stop': { ...request, stop: [] },
      'response-format': { ...request, jsonSchema: {} },
    }[change];
    expect(codeOf(await client.chat(changed ?? request))).toBe('model_refused');
  });

  test('withPlamo leaves Gemma chats to the wrapped responder', async () => {
    const comments = [{ text: 'which level is this?', lang: 'und-Latn', translate: true }];
    const prompt = commentBatchPrompt({ comments, context: 'Title: a made-up stream' });
    const plain = await client.chat({ ...prompt, model: 'gemma', slot: 1 });
    stub.respond = withPlamo(defaultResponder);
    const wrapped = await client.chat({ ...prompt, model: 'gemma', slot: 1 });
    expect(wrapped).toEqual(plain);
    expect(wrapped.ok && wrapped.value.text).toBe(
      commentBatchReply(
        '{"id":1,"lang":"und-Latn","translate":true,"text":"which level is this?"}',
      ),
    );
  });

  test('the default stub lists no PLaMo and answers a PLaMo chat with 404', async () => {
    expect(await client.models()).toEqual({ ok: true, value: ['stub-model'] });
    expect(codeOf(await client.chat(plamoRequest()))).toBe('model_refused');
  });
});
