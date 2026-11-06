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
  PLAMO_STOP,
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
  STUB_TRANSCRIPT,
  withoutAudio,
  withPlamo,
  type LlamaStub,
  type StubChat,
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

  test('answers input_audio chats with numbered transcript lines', async () => {
    const ask = () =>
      client.chat({
        messages: [
          { role: 'system', content: 'Transcribe.' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Context line.' },
              { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
            ],
          },
        ],
      });
    const first = await ask();
    const second = await ask();
    expect(first.ok && first.value.text).toBe(`en\t${STUB_TRANSCRIPT} 1.\n`);
    expect(second.ok && second.value.text).toBe(`en\t${STUB_TRANSCRIPT} 2.\n`);
    expect(STUB_TRANSCRIPT).toBe('Stub speech');
  });

  test('records audio parts: the count, and the text parts joined by a newline', async () => {
    const seen: (StubChat | undefined)[] = [];
    stub.respond = (request) => {
      seen.push(request.chat);
      return defaultResponder(request);
    };
    await client.chat({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
            { type: 'text', text: 'b' },
          ],
        },
      ],
    });
    await client.chat(genrePrompt({}));
    expect(seen[0]?.audio).toBe(1);
    expect(seen[0]?.messages).toEqual([{ role: 'user', content: 'a\nb' }]);
    expect(seen[1]?.audio).toBe(0);
  });

  test('props reports a projector and 2 slots', async () => {
    expect(await client.props()).toEqual({ ok: true, value: { totalSlots: 2, audio: true } });
  });

  test('withoutAudio reports no audio in props and rejects input_audio with 400', async () => {
    stub.respond = withoutAudio(defaultResponder);
    expect(await client.props()).toEqual({ ok: true, value: { totalSlots: 2, audio: false } });
    const audio = await client.chat({
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } }],
        },
      ],
      tellRefusal: true,
    });
    expect(codeOf(audio)).toBe('audio_unsupported');
    // The rejected audio chat took serial number 1: the next one answered is 2.
    stub.respond = defaultResponder;
    const next = await client.chat({
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } }],
        },
      ],
    });
    expect(next.ok && next.value.text).toBe(`en\t${STUB_TRANSCRIPT} 2.\n`);
    const text = await client.chat(genrePrompt({}));
    expect(text.ok && parseGenre(text.value.text)).toBe(STUB_GENRE);
  });

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

  // The responder is called directly: through the client, 400, 404 and 5xx all read as model_refused.
  const REFUSED = { status: 400, body: { error: { code: 400, type: 'invalid_request_error' } } };
  const plamoChat = (
    change: Partial<StubChat> = {},
    kwargs: Record<string, unknown> = {},
  ): StubChat => ({
    messages: [{ role: 'user', content: 'Okay chat' }],
    audio: 0,
    model: PLAMO_TRANSLATE_MODEL,
    temperature: 0,
    stop: [...PLAMO_STOP],
    chat_template_kwargs: { target_lang: 'ja', source_lang: 'en', ...kwargs },
    ...change,
  });
  const ask = (chat: StubChat, responder = withPlamo(defaultResponder)) =>
    responder({ method: 'POST', path: '/v1/chat/completions', body: chat, chat });
  const noStop = (): StubChat => {
    const { stop: _stop, ...rest } = plamoChat();
    return rest;
  };

  test.each([
    {
      name: 'system メッセージ',
      chat: plamoChat({
        messages: [
          { role: 'system', content: 'x' },
          { role: 'user', content: 'Okay chat' },
        ],
      }),
    },
    { name: 'grammar', chat: plamoChat({ grammar: 'root ::= "a"' }) },
    { name: 'stop のキーがない', chat: noStop() },
    { name: '空の stop', chat: plamoChat({ stop: [] }) },
    { name: 'response_format', chat: plamoChat({ response_format: { type: 'json_object' } }) },
    { name: '大文字と地域の言語コード', chat: plamoChat({}, { source_lang: 'zh-CN' }) },
    { name: '対応していない言語コード', chat: plamoChat({}, { source_lang: 'pt' }) },
    { name: '文脈の予約トークン', chat: plamoChat({}, { context: 'a <|plamo:tag|> b' }) },
    {
      name: '用語集の source の予約トークン',
      chat: plamoChat({}, { glossary: [{ source: '<|plamo:x', target: 'y' }] }),
    },
    {
      name: '用語集の target の予約トークン',
      chat: plamoChat({}, { glossary: [{ source: 'x', target: '<|plamo:y' }] }),
    },
    {
      name: 'ASCII の空白だけの原文',
      chat: plamoChat({ messages: [{ role: 'user', content: ' \t\r\n' }] }),
    },
  ])('withPlamo refuses a PLaMo chat with $name with exactly HTTP 400', async ({ chat }) => {
    expect(await ask(chat)).toEqual(REFUSED);
  });

  test('withPlamo accepts a line of only U+3000, as the real server does', async () => {
    const reply = await ask(plamoChat({ messages: [{ role: 'user', content: '\u3000' }] }));
    expect(reply.status).toBeUndefined();
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
    expect(await ask(plamoChat(), defaultResponder)).toEqual({
      status: 404,
      body: { error: { code: 404 } },
    });
  });
});
