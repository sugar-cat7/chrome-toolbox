import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import type { Result } from '@chrome-toolbox/contracts';
import { createLlamaClient, cutByMaxTokens, hostPattern, parseBaseUrl, type Fetch } from './llm.ts';
import { createQueue } from './queue.ts';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const routes =
  (table: Record<string, () => Response | Promise<Response>>): Fetch =>
  async (input) => {
    const handler = table[new URL(input).pathname];
    return handler ? handler() : new Response('missing', { status: 404 });
  };
const code = (result: Result<unknown>): string => (result.ok ? 'ok' : result.error.internalCode);
const healthy = {
  '/health': () => json({ status: 'ok' }),
  '/v1/models': () => json({ object: 'list', data: [{ id: 'qwen-4b', object: 'model' }] }),
};

describe('llama.cpp base URL', () => {
  it.each([
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080', 'http://127.0.0.1/*'],
    [' http://192.0.2.20:8080/ ', 'http://192.0.2.20:8080', 'http://192.0.2.20/*'],
    ['https://llm.local/api/', 'https://llm.local/api', 'https://llm.local/*'],
    ['ftp://127.0.0.1', 'input_invalid', 'input_invalid'],
    ['http://user:secret@127.0.0.1', 'input_invalid', 'input_invalid'],
    ['not a url', 'input_invalid', 'input_invalid'],
  ])('%s', (input, base, pattern) => {
    const parsed = parseBaseUrl(input);
    const host = hostPattern(input);
    expect(parsed.ok ? parsed.value : parsed.error.internalCode).toBe(base);
    expect(host.ok ? host.value : host.error.internalCode).toBe(pattern);
  });
});

describe('llama.cpp client', () => {
  it.each([
    { name: 'loaded server', table: healthy, expected: 'ok' },
    {
      name: 'model still loading',
      table: { ...healthy, '/health': () => json({ error: { code: 503 } }, 503) },
      expected: 'network_failed',
    },
    {
      name: 'unreachable host',
      table: { '/health': () => Promise.reject(new TypeError('fetch failed')) },
      expected: 'network_failed',
    },
    {
      name: 'non-JSON body',
      table: { ...healthy, '/v1/models': () => new Response('<html>') },
      expected: 'response_invalid',
    },
    {
      name: 'unexpected shape',
      table: { ...healthy, '/v1/models': () => json({ models: ['x'] }) },
      expected: 'response_invalid',
    },
  ])('reports status for a $name', async ({ table, expected }) => {
    const client = createLlamaClient({ baseUrl: 'http://127.0.0.1:8080', fetch: routes(table) });
    const status = await client.status();
    expect(code(status)).toBe(expected);
    expect(status.ok ? status.value : undefined).toEqual(
      expected === 'ok' ? { models: ['qwen-4b'] } : undefined,
    );
  });

  it.each([
    { name: 'caller abort', abort: true, timeoutMs: 5_000, expected: 'operation_cancelled' },
    { name: 'deadline', abort: false, timeoutMs: 20, expected: 'network_failed' },
  ])('stops a hung request on $name', async ({ abort, timeoutMs, expected }) => {
    const hung: Fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    const client = createLlamaClient({ baseUrl: 'http://127.0.0.1:8080', fetch: hung, timeoutMs });
    const controller = new AbortController();
    const pending = client.health(controller.signal);
    if (abort) controller.abort();
    expect(code(await pending)).toBe(expected);
  });

  it('sends one non-streaming chat completion through the queue', async () => {
    const fetch = vi.fn<Fetch>(async () =>
      json({ choices: [{ message: { role: 'assistant', content: 'こんにちは' } }] }),
    );
    const client = createLlamaClient({ baseUrl: 'http://127.0.0.1:8080/', fetch });
    const reply = await client.chat({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'qwen-4b',
      maxTokens: 64,
    });
    expect(reply).toEqual({ ok: true, value: { text: 'こんにちは', timing: undefined } });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
      model: 'qwen-4b',
      max_tokens: 64,
      cache_prompt: true,
    });
  });

  it.each([
    { name: 'slot と cache', request: { slot: 1 }, body: { id_slot: 1, cache_prompt: true } },
    { name: 'cache 無効', request: { cachePrompt: false }, body: { cache_prompt: false } },
    {
      name: 'generation settings',
      request: { temperature: 0, maxTokens: 32 },
      body: { temperature: 0, max_tokens: 32 },
    },
    {
      name: 'template kwargs',
      request: { templateKwargs: { enable_thinking: false } },
      body: { chat_template_kwargs: { enable_thinking: false } },
    },
    {
      name: 'json schema',
      request: { jsonSchema: { type: 'object' } },
      body: {
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'output', schema: { type: 'object' } },
        },
      },
    },
    {
      name: 'GBNF grammar',
      request: { grammar: 'root ::= "1\\t" [ac] "\\n"' },
      body: { grammar: 'root ::= "1\\t" [ac] "\\n"' },
    },
  ])('chat sends $name', async ({ request, body }) => {
    const sent: unknown[] = [];
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async (_u, init) => {
        sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : ''));
        return json({
          choices: [{ message: { content: '{"a":1}' } }],
          timings: { prompt_ms: 5, predicted_ms: 7, predicted_n: 3 },
        });
      },
    });
    await client.chat({ messages: [{ role: 'user', content: 'x' }], ...request });
    expect(sent[0]).toMatchObject(body);
  });

  it.each([
    { content: '{"a":1}', expected: 'ok' },
    { content: '{"a":', expected: 'response_invalid' },
    { content: '{"b":1}', expected: 'response_invalid' },
  ])('chatJson decodes $content', async ({ content, expected }) => {
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async () => json({ choices: [{ message: { content } }] }),
    });
    const result = await client.chatJson(
      { messages: [], jsonSchema: {} },
      z.strictObject({ a: z.number() }),
    );
    expect(code(result)).toBe(expected);
  });

  it('reports llama-server timings', async () => {
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async () =>
        json({
          choices: [{ message: { content: '{"a":1}' } }],
          timings: { prompt_ms: 5, predicted_ms: 7, predicted_n: 3 },
        }),
    });
    const timing = { promptMs: 5, predictedMs: 7, predictedTokens: 3 };
    expect(await client.chat({ messages: [] })).toEqual({
      ok: true,
      value: { text: '{"a":1}', timing },
    });
    expect(
      await client.chatJson({ messages: [], jsonSchema: {} }, z.strictObject({ a: z.number() })),
    ).toEqual({ ok: true, value: { value: { a: 1 }, timing } });
  });

  it.each([
    {
      reply: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] },
      expected: 'stop',
    },
    {
      reply: { choices: [{ message: { content: 'x' }, finish_reason: 'length' }] },
      expected: 'length',
    },
    { reply: { choices: [{ message: { content: 'x' } }] }, expected: undefined },
    { reply: { choices: [{ message: { content: 'x' }, finish_reason: 7 }] }, expected: undefined },
  ])('reports finish_reason $expected', async ({ reply, expected }) => {
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async () => json(reply),
    });
    const result = await client.chat({ messages: [] });
    expect(result.ok ? result.value.finishReason : 'failed').toBe(expected);
  });

  it.each([
    { name: 'finish_reason length', finishReason: 'length', predicted: 10, expected: true },
    { name: 'finish_reason stop', finishReason: 'stop', predicted: 100, expected: false },
    { name: 'no reason, budget used up', finishReason: undefined, predicted: 100, expected: true },
    { name: 'no reason, budget left', finishReason: undefined, predicted: 99, expected: false },
    {
      name: 'no reason and no timings',
      finishReason: undefined,
      predicted: undefined,
      expected: true,
    },
  ])('cutByMaxTokens: $name -> $expected', ({ finishReason, predicted, expected }) => {
    const timing =
      predicted === undefined
        ? undefined
        : { promptMs: 1, predictedMs: 1, predictedTokens: predicted };
    expect(cutByMaxTokens({ finishReason, timing }, 100)).toBe(expected);
  });

  it.each([
    { name: 'null', timings: null },
    { name: 'a string', timings: 'fast' },
    { name: 'missing fields', timings: { prompt_ms: 5 } },
    { name: 'wrong field types', timings: { prompt_ms: '5', predicted_ms: 7, predicted_n: 3 } },
  ])('keeps the reply when timings are $name', async ({ timings }) => {
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async () => json({ choices: [{ message: { content: '{"a":1}' } }], timings }),
    });
    expect(await client.chat({ messages: [] })).toEqual({
      ok: true,
      value: { text: '{"a":1}', timing: undefined },
    });
  });

  it('omits chat_template_kwargs and grammar unless requested', async () => {
    const sent: unknown[] = [];
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async (_u, init) => {
        sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : ''));
        return json({ choices: [{ message: { content: 'x' } }] });
      },
    });
    await client.chat({ messages: [] });
    expect(sent[0]).not.toHaveProperty('chat_template_kwargs');
    expect(sent[0]).not.toHaveProperty('grammar');
  });

  it.each([
    {
      name: 'reported slots',
      reply: () => json({ total_slots: 2, build_info: 'b11475-7e8324f' }),
      expected: { totalSlots: 2 },
    },
    {
      name: 'missing total_slots',
      reply: () => json({ build_info: 'b1' }),
      expected: 'response_invalid',
    },
    {
      name: 'fractional total_slots',
      reply: () => json({ total_slots: 1.5 }),
      expected: 'response_invalid',
    },
    {
      name: 'server error',
      reply: () => json({ error: { code: 503 } }, 503),
      expected: 'network_failed',
    },
  ])('props reads $name from GET /props', async ({ reply, expected }) => {
    const calls: { path: string; method: string | undefined }[] = [];
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080/',
      fetch: async (input, init) => {
        calls.push({ path: new URL(input).pathname, method: init?.method });
        return reply();
      },
    });
    const result = await client.props();
    expect(calls).toEqual([{ path: '/props', method: 'GET' }]);
    expect(result.ok ? result.value : result.error.internalCode).toEqual(expected);
  });

  it('props passes the model to GET /props?model= in router mode', async () => {
    const calls: { path: string; search: string }[] = [];
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:18083',
      fetch: async (input) => {
        const url = new URL(input);
        calls.push({ path: url.pathname, search: url.search });
        return json({ total_slots: 2 });
      },
    });
    const result = await client.props({ model: 'gemma4-e4b' });
    expect(calls).toEqual([{ path: '/props', search: '?model=gemma4-e4b' }]);
    expect(result.ok ? result.value : result.error.internalCode).toEqual({ totalSlots: 2 });
  });

  it.each([
    { name: 'ルーター', model: 'gemma4-e4b', search: '?model=gemma4-e4b' },
    { name: 'モデルなし', model: undefined, search: '' },
  ])('slots reads id and is_processing from GET /slots: $name', async ({ model, search }) => {
    const calls: { method: string | undefined; path: string; search: string }[] = [];
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async (input, init) => {
        const url = new URL(input);
        calls.push({ method: init?.method, path: url.pathname, search: url.search });
        return json([
          { id: 0, id_task: 12, n_ctx: 4096, is_processing: true, params: {} },
          { id: 1, is_processing: false },
        ]);
      },
    });
    const result = await client.slots(model === undefined ? {} : { model });
    expect(calls).toEqual([{ method: 'GET', path: '/slots', search }]);
    expect(result).toStrictEqual({
      ok: true,
      value: [
        { id: 0, processing: true },
        { id: 1, processing: false },
      ],
    });
  });

  it.each([
    {
      name: 'HTTP 501',
      status: 501,
      body: { error: { code: 501, message: 'not supported' } },
      code: 'network_failed',
    },
    { name: '配列でない', status: 200, body: { slots: [] }, code: 'response_invalid' },
    { name: 'is_processing がない', status: 200, body: [{ id: 0 }], code: 'response_invalid' },
    {
      name: '負の id',
      status: 200,
      body: [{ id: -1, is_processing: false }],
      code: 'response_invalid',
    },
  ])('slots fails: $name', async ({ status, body, code: expected }) => {
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async () => json(body, status),
    });
    expect(code(await client.slots())).toBe(expected);
  });

  it('slots does not wait behind the chat queue', async () => {
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      queue: createQueue({ concurrency: 1 }),
      fetch: (input, init) =>
        new URL(input).pathname === '/slots'
          ? Promise.resolve(json([{ id: 0, is_processing: true }]))
          : new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
    });
    const stop = new AbortController();
    const chat = client.chat({
      messages: [{ role: 'user', content: 'never answered' }],
      signal: stop.signal,
    });
    expect(await client.slots()).toStrictEqual({
      ok: true,
      value: [{ id: 0, processing: true }],
    });
    stop.abort();
    expect(code(await chat)).toBe('operation_cancelled');
  });

  it('sends stop strings only when the request has them', async () => {
    const sent: Record<string, unknown>[] = [];
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async (_u, init) => {
        sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
        return json({ choices: [{ message: { content: 'x' } }] });
      },
    });
    await client.chat({ messages: [], stop: ['<|plamo:tag|>', '<|plamo:bos|>'] });
    await client.chat({ messages: [] });
    expect(sent[0]?.stop).toEqual(['<|plamo:tag|>', '<|plamo:bos|>']);
    expect(sent[1]).not.toHaveProperty('stop');
  });

  it('sends audio parts as OpenAI input_audio content', async () => {
    const sent: { messages: { content: unknown }[] }[] = [];
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async (_u, init) => {
        sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
        return json({ choices: [{ message: { content: 'x' } }] });
      },
    });
    await client.chat({
      messages: [
        { role: 'system', content: 'sys' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe.' },
            { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
          ],
        },
      ],
    });
    expect(sent[0]?.messages[0]?.content).toBe('sys');
    expect(sent[0]?.messages[1]?.content).toEqual([
      { type: 'text', text: 'Transcribe.' },
      { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
    ]);
  });

  it.each([
    {
      name: '音声入力あり',
      body: { total_slots: 3, modalities: { vision: false, video: false, audio: true } },
      expected: { totalSlots: 3, audio: true },
    },
    {
      name: '投影器なし',
      body: { total_slots: 3, modalities: { vision: false, video: false, audio: false } },
      expected: { totalSlots: 3, audio: false },
    },
    {
      name: 'modalities を返さない',
      body: { total_slots: 3 },
      expected: { totalSlots: 3, audio: undefined },
    },
  ])('props: $name', async ({ body, expected }) => {
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async () => json(body),
    });
    const result = await client.props();
    expect(result).toStrictEqual({ ok: true, value: expected });
  });

  it.each([
    { name: 'tellRefusal なし', tellRefusal: false },
    { name: 'tellRefusal あり', tellRefusal: true },
  ])("maps the server's no-projector 400 to audio_unsupported: $name", async ({ tellRefusal }) => {
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async () =>
        json(
          {
            error: {
              code: 400,
              message:
                'audio input is not supported - hint: if this is unexpected, you may need to provide the mmproj',
              type: 'invalid_request_error',
            },
          },
          400,
        ),
    });
    expect(code(await client.chat({ messages: [], tellRefusal }))).toBe('audio_unsupported');
  });

  it.each([
    { name: 'a non-JSON body', body: 'Bad Request' },
    { name: 'JSON without error.message', body: JSON.stringify({ error: { code: 400 } }) },
    {
      name: 'a message without the audio phrase',
      body: JSON.stringify({ error: { code: 400, message: 'image input is not supported' } }),
    },
  ])('a 400 with $name is not audio_unsupported', async ({ body }) => {
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async () => new Response(body, { status: 400 }),
    });
    expect(code(await client.chat({ messages: [], tellRefusal: false }))).toBe('network_failed');
    expect(code(await client.chat({ messages: [], tellRefusal: true }))).toBe('model_refused');
  });

  it('reports operation_cancelled when the caller aborts while the 400 body is read', async () => {
    const controller = new AbortController();
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async () => {
        const response = json({ error: { code: 400, message: 'Invalid slot ID' } }, 400);
        const read = response.text.bind(response);
        response.text = async () => {
          controller.abort();
          return read();
        };
        return response;
      },
    });
    const result = await client.chat({
      messages: [],
      tellRefusal: true,
      signal: controller.signal,
    });
    expect(code(result)).toBe('operation_cancelled');
  });

  it.each([
    { tellRefusal: false, expected: 'network_failed' },
    { tellRefusal: true, expected: 'model_refused' },
  ])(
    'keeps other 400 replies as Task 0 maps them: $expected',
    async ({ tellRefusal, expected }) => {
      const client = createLlamaClient({
        baseUrl: 'http://127.0.0.1:8080',
        fetch: async () => json({ error: { code: 400, message: 'Invalid slot ID' } }, 400),
      });
      expect(code(await client.chat({ messages: [], tellRefusal }))).toBe(expected);
    },
  );

  it.each([
    {
      status: 400,
      message: "model 'plamo-3-translate-2b' not found",
      tellRefusal: true,
      expected: 'model_refused',
    },
    { status: 400, message: 'Invalid slot ID', tellRefusal: true, expected: 'model_refused' },
    { status: 404, message: 'File Not Found', tellRefusal: true, expected: 'model_refused' },
    { status: 503, message: 'Loading model', tellRefusal: true, expected: 'model_refused' },
    { status: 503, message: 'Loading model', tellRefusal: false, expected: 'network_failed' },
    { status: 404, message: 'File Not Found', tellRefusal: false, expected: 'network_failed' },
  ])('HTTP $status "$message" with tellRefusal $tellRefusal is $expected', async (row) => {
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async () => json({ error: { code: row.status, message: row.message } }, row.status),
    });
    expect(code(await client.chat({ messages: [], tellRefusal: row.tellRefusal }))).toBe(
      row.expected,
    );
  });

  it('keeps an unreachable server as network_failed even with tellRefusal', async () => {
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(code(await client.chat({ messages: [], tellRefusal: true }))).toBe('network_failed');
  });

  it('returns operation_cancelled before reading the status of a refused reply', async () => {
    const controller = new AbortController();
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:8080',
      fetch: async () => {
        controller.abort();
        return json({ error: { code: 503 } }, 503);
      },
    });
    expect(
      code(await client.chat({ messages: [], tellRefusal: true, signal: controller.signal })),
    ).toBe('operation_cancelled');
  });
});
