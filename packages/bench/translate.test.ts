import { describe, expect, it } from 'vitest';
import { createLlamaClient, subtitleMaxTokens } from '@chrome-toolbox/extension-core';
import { loadTextSamples, type TextSample } from './datasets.ts';
import { parseIntegerOption, runTranslationBench } from './translate.ts';

const sample = (
  lang: TextSample['lang'],
  kind: TextSample['kind'] = 'speech',
  id = `${lang}-1`,
  file?: string,
): TextSample => ({
  id,
  lang,
  kind,
  text: `text of ${id}`,
  ...(file === undefined ? {} : { file }),
});

type Sent = {
  temperature?: number;
  max_tokens?: number;
  chat_template_kwargs?: unknown;
  messages: { content: string }[];
  grammar?: string;
};

/** A fake llama-server: replies in order and advances the clock by `ms[i]` per completion. */
function fakeServer(contents: string[], options: { ms?: number[]; timings?: unknown } = {}) {
  const queue = [...contents];
  const delays = [...(options.ms ?? [])];
  const sent: Sent[] = [];
  let t = 0;
  const client = createLlamaClient({
    baseUrl: 'http://127.0.0.1:1',
    fetch: async (url, init) => {
      if (url.endsWith('/health')) return Response.json({ status: 'ok' });
      sent.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent);
      t += delays.shift() ?? 0;
      return Response.json({
        choices: [{ message: { content: queue.shift() ?? '{}' }, finish_reason: 'stop' }],
        ...(options.timings === undefined ? {} : { timings: options.timings }),
      });
    },
  });
  return { client, sent, now: () => t };
}

const userTurn = (body: Sent | undefined): string => body?.messages.at(-1)?.content ?? '';
const previousLines = (body: Sent | undefined): unknown =>
  JSON.parse(/Previous lines \(JSON, context only\): (.*)/u.exec(userTurn(body))?.[1] ?? 'null');

describe('runTranslationBench', () => {
  it('stops before measuring when the server is not ready', async () => {
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: async () => new Response('', { status: 503 }),
    });
    await expect(runTranslationBench({ client, samples: [sample('en')] })).rejects.toThrow(
      /llama-server is not ready/,
    );
  });

  it('stops before measuring when the judge server is not ready', async () => {
    const server = fakeServer(['やあ\n']);
    const judge = createLlamaClient({
      baseUrl: 'http://127.0.0.1:2',
      fetch: async () => new Response('', { status: 503 }),
    });
    await expect(
      runTranslationBench({ client: server.client, judge, samples: [sample('en')] }),
    ).rejects.toThrow(/judge server is not ready/);
    expect(server.sent).toEqual([]);
  });

  it('records a reply without its newline as a counted failure and keeps going', async () => {
    const server = fakeServer(['こん', 'こんにちは\n']);
    const report = await runTranslationBench({
      client: server.client,
      samples: [sample('en'), sample('ko')],
    });
    expect(report.failures).toEqual({ response_invalid: 1 });
    expect(report.rows.map((row) => row.output)).toEqual([undefined, 'こんにちは']);
    expect(report.overall).toMatchObject({ attempts: 2, successes: 1 });
  });

  it('reports success-only and all-attempt latency per lang × kind and overall', async () => {
    const server = fakeServer(['こん', 'a\n', 'b\n', '1\tc\n'], {
      ms: [900, 100, 300, 50],
    });
    const report = await runTranslationBench({
      client: server.client,
      now: server.now,
      samples: [
        sample('en', 'speech', 'en-1'),
        sample('en', 'speech', 'en-2'),
        sample('ko', 'speech', 'ko-1'),
        sample('en', 'chat', 'en-c'),
      ],
    });
    expect(report.groups['en/speech']).toEqual({
      attempts: 2,
      successes: 1,
      p50Ms: 100,
      p95Ms: 100,
      p95AllMs: 900,
      maxAllMs: 900,
      scored: 0,
      meanScore: undefined,
    });
    expect(report.groups['ko/speech']).toMatchObject({ attempts: 1, successes: 1, p50Ms: 300 });
    // The chat line has no translation, so the row is a failure counted at its elapsed time.
    expect(report.groups['en/chat']).toMatchObject({
      attempts: 1,
      successes: 0,
      p50Ms: undefined,
      maxAllMs: 50,
    });
    expect(report.overall).toMatchObject({ attempts: 4, successes: 2, maxAllMs: 900 });
    expect(report.failures).toEqual({ response_invalid: 2 });
  });

  it('sends a speech line under its grammar and its token budget', async () => {
    const server = fakeServer(['やあ\n']);
    await runTranslationBench({ client: server.client, samples: [sample('en')] });
    expect(server.sent[0]?.grammar).toBe('root ::= [^\\n<>]{1,40} "\\n"');
    expect(server.sent[0]?.max_tokens).toBe(subtitleMaxTokens('text of en-1'));
  });

  it('keeps one speech history per language and source file', async () => {
    const server = fakeServer(['1\n', '2\n', '3\n', '4\n']);
    await runTranslationBench({
      client: server.client,
      samples: [
        sample('en', 'speech', 'en-1', 'a.jsonl'),
        sample('en', 'speech', 'en-2', 'a.jsonl'),
        sample('ko', 'speech', 'ko-1', 'a.jsonl'),
        sample('ko', 'speech', 'ko-2', 'b.jsonl'),
      ],
    });
    expect(server.sent.map(previousLines)).toEqual([[], ['text of en-1'], [], []]);
  });

  it('translates chat samples through the comment batch prompt, N per request', async () => {
    const server = fakeServer(['1\tc\tやあ\n2\tq\tなに\n', '1\tc\tうん\n']);
    const report = await runTranslationBench({
      client: server.client,
      chatBatch: 2,
      samples: ['es-1', 'es-2', 'es-3'].map((id) => sample('es', 'chat', id)),
    });
    expect(server.sent).toHaveLength(2);
    expect(server.sent[0]?.grammar?.split('\n')[0]).toBe(
      String.raw`root ::= "1\t" code "\t" ja1 "\n" "2\t" code "\t" ja2 "\n"`,
    );
    // The categories every real batch has (genre other, R62), so the prompt is as long as one.
    expect(server.sent[0]?.grammar?.split('\n')[1]).toBe('code ::= [asqicrve]');
    expect(server.sent[0]?.messages.at(-1)?.content).toContain('Stream genre: other (unknown)');
    expect(report.rows.map((row) => [row.id, row.output, row.batchSize])).toEqual([
      ['es-1', 'やあ', 2],
      ['es-2', 'なに', 2],
      ['es-3', 'うん', 1],
    ]);
    expect(report.rows[0]?.ms).toBe(report.rows[1]?.ms);
  });

  it('pins generation settings on every request and keeps each row timing', async () => {
    const server = fakeServer(['a\n', '1\tc\tb\n'], {
      timings: { prompt_ms: 5, predicted_ms: 7, predicted_n: 3 },
    });
    const report = await runTranslationBench({
      client: server.client,
      samples: [sample('en'), sample('en', 'chat', 'en-c')],
    });
    for (const body of server.sent) {
      expect(body.temperature).toBe(0);
      expect(body.max_tokens).toBeGreaterThan(0);
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    }
    expect(report.rows.map((row) => row.timing)).toEqual([
      { promptMs: 5, predictedMs: 7, predictedTokens: 3 },
      { promptMs: 5, predictedMs: 7, predictedTokens: 3 },
    ]);
  });

  it('asks the judge for a 1-5 score per translated row', async () => {
    const server = fakeServer(['やあ\n']);
    const judge = fakeServer(['{"score":4}']);
    const report = await runTranslationBench({
      client: server.client,
      judge: judge.client,
      samples: [sample('es')],
    });
    expect(report.overall).toMatchObject({ meanScore: 4, scored: 1, attempts: 1 });
    expect(report.rows[0]?.score).toBe(4);
    expect(judge.sent[0]?.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('keeps a judge failure apart from the translation result', async () => {
    const server = fakeServer(['やあ\n']);
    const judge = fakeServer(['{"score":9}']);
    const report = await runTranslationBench({
      client: server.client,
      judge: judge.client,
      samples: [sample('es')],
    });
    expect(report.rows[0]).toMatchObject({ output: 'やあ', judgeError: 'response_invalid' });
    expect(report.rows[0]?.error).toBeUndefined();
    expect(report.failures).toEqual({});
    expect(report.judgeFailures).toEqual({ response_invalid: 1 });
    expect(report.overall).toMatchObject({ successes: 1, scored: 0 });
  });
});

describe('parseIntegerOption', () => {
  it.each([
    { value: '0', min: 0, expected: 0 },
    { value: ' 3 ', min: 1, expected: 3 },
  ])('accepts $value (min $min)', ({ value, min, expected }) => {
    expect(parseIntegerOption(value, '--n', min)).toBe(expected);
  });

  it.each([
    { value: '', min: 0 },
    { value: ' ', min: 0 },
    { value: '1.5', min: 0 },
    { value: '-1', min: 0 },
    { value: '0', min: 1 },
  ])('rejects "$value" (min $min) instead of reading it as a number', ({ value, min }) => {
    expect(() => parseIntegerOption(value, '--n', min)).toThrow(`--n must be an integer >= ${min}`);
  });
});

describe('loadTextSamples', () => {
  it('loads the bundled fixtures and remembers each source file', () => {
    const samples = loadTextSamples(new URL('./fixtures/text', import.meta.url).pathname);
    expect(samples).toHaveLength(25);
    expect(samples[0]?.file).toBe('en.jsonl');
  });
});
