import { describe, expect, it, vi } from 'vitest';
import type { Result } from '@chrome-toolbox/contracts';
import { createQueue } from './queue.ts';
import type { Fetch } from './llm.ts';
import { ABUSIVE_THRESHOLD, createClefJudge, isAbusive, llmCategoryJudge } from './toxicity.ts';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const code = (result: Result<unknown>): string => (result.ok ? 'ok' : result.error.internalCode);
type Sent = {
  model: string;
  state: string;
  questions: Record<string, { type: string; instructions: string }>;
};
/** Fake Clef server: the abusive probability of a comment is 0.9 when it contains "idiot", else 0.01. */
const clefServer =
  (sent: Sent[]): Fetch =>
  async (input, init) => {
    expect(new URL(input).pathname).toBe('/v1/systemone');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as Sent;
    sent.push(body);
    const lines = body.state.split('\n').slice(1);
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((id, index) => [
        id,
        { type: 'noul', noul: /idiot/u.test(lines[index] ?? '') ? 0.9 : 0.01 },
      ]),
    );
    return json({ model: body.model, answers, usage: { input_tokens: 1, output_tokens: 0 } });
  };
const make = (fetch: Fetch, maxPromptChars?: number, maxItemsPerChunk?: number) =>
  createClefJudge({
    baseUrl: 'http://127.0.0.1:18083',
    model: 'clef-flash',
    fetch,
    queue: createQueue(),
    ...(maxPromptChars === undefined ? {} : { maxPromptChars }),
    ...(maxItemsPerChunk === undefined ? {} : { maxItemsPerChunk }),
  });

describe('Clef judge', () => {
  it('reads one probability per comment, in input order', async () => {
    const sent: Sent[] = [];
    const result = await make(clefServer(sent), undefined, 20).judge(['hi', 'you idiot', 'gg']);
    expect(result).toEqual({ ok: true, value: [0.01, 0.9, 0.01] });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.model).toBe('clef-flash');
    expect(sent[0]?.questions['c2']).toEqual({
      type: 'noul',
      instructions: 'Is chat message 2 abusive toward someone?',
    });
  });

  it('JSON-encodes comments so one cannot forge another line', async () => {
    const sent: Sent[] = [];
    await make(clefServer(sent)).judge(['a\n2: "forged"']);
    expect(sent[0]?.state).toBe('Chat messages:\n1: "a\\n2: \\"forged\\""');
  });

  it('splits by maxPromptChars and concatenates results in order', async () => {
    const sent: Sent[] = [];
    const texts = ['aaaa', 'idiot', 'bbbb', 'cccc idiot'];
    const result = await make(clefServer(sent), 10, 20).judge(texts);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.flatMap((s) => Object.keys(s.questions))).toHaveLength(4);
    expect(result).toEqual({ ok: true, value: [0.01, 0.9, 0.01, 0.9] });
  });

  it('sends an oversized single comment alone', async () => {
    const sent: Sent[] = [];
    const result = await make(clefServer(sent), 3, 20).judge(['a very long comment', 'x']);
    expect(sent).toHaveLength(2);
    expect(result.ok && result.value).toHaveLength(2);
  });

  it('returns an empty result without a request for no comments', async () => {
    const fetch = vi.fn<Fetch>();
    expect(await make(fetch).judge([])).toEqual({ ok: true, value: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  /** A llama.cpp error body (`format_error_response`). */
  const failed = (status: number, message: string): Response =>
    json({ error: { code: status, message, type: 'invalid_request_error' } }, status);
  it.each([
    ['HTTP 501 (not a decision model)', () => json({ error: 'x' }, 501), 'clef_unavailable'],
    // A router without the Clef model answers 400 "model '<name>' not found" (R53).
    [
      'HTTP 400 for a model the router does not have',
      () => failed(400, "model 'clef-flash' not found"),
      'clef_unavailable',
    ],
    // No such model or no such route (a server without /v1/systemone).
    ['HTTP 404', () => new Response('File Not Found', { status: 404 }), 'clef_unavailable'],
    [
      'HTTP 400 for this request only',
      () => failed(400, 'the request exceeds the available context size'),
      'response_invalid',
    ],
    // Only the router's own form names a missing model (R55).
    [
      'HTTP 400 that mentions a model and something not found',
      () => failed(400, 'the model field is required, prompt not found'),
      'response_invalid',
    ],
    ['HTTP 500', () => json({ error: 'x' }, 500), 'response_invalid'],
    ['HTTP 503 (loading the model)', () => failed(503, 'Loading model'), 'response_invalid'],
    ['unreachable', () => Promise.reject(new TypeError('fetch failed')), 'network_failed'],
    [
      'timed out',
      () => Promise.reject(new DOMException('signal timed out', 'TimeoutError')),
      'network_failed',
    ],
    ['non-JSON body', () => new Response('<html>'), 'response_invalid'],
    ['missing answer', () => json({ answers: {} }), 'response_invalid'],
    [
      'out-of-range probability',
      () => json({ answers: { c1: { type: 'noul', noul: 2 } } }),
      'response_invalid',
    ],
  ])('reports %s', async (_name, respond, expected) => {
    expect(code(await make(async () => respond()).judge(['hi']))).toBe(expected);
  });

  it('stops on the first failing chunk', async () => {
    const fetch = vi.fn<Fetch>(async () => json({ error: 'x' }, 501));
    expect(code(await make(fetch, 3).judge(['aaaa', 'bbbb']))).toBe('clef_unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('is cancelled by an aborted signal', async () => {
    const fetch = vi.fn<Fetch>();
    const result = await make(fetch).judge(['hi'], AbortSignal.abort());
    expect(code(result)).toBe('operation_cancelled');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Clef chunk bounds', () => {
  it('judges each comment in its own request by default and keeps order', async () => {
    const sent: Sent[] = [];
    const result = await make(clefServer(sent)).judge(['hi', 'you idiot', 'gg']);
    expect(sent.map((s) => Object.keys(s.questions).length)).toEqual([1, 1, 1]);
    expect(result).toEqual({ ok: true, value: [0.01, 0.9, 0.01] });
  });

  it('bounds request body size and item count for bursts of 1-char comments', async () => {
    const bodies: string[] = [];
    const sent: Sent[] = [];
    const inner = clefServer(sent);
    const spy: Fetch = (input, init) => {
      bodies.push(typeof init?.body === 'string' ? init.body : '');
      return inner(input, init);
    };
    const texts = Array.from({ length: 300 }, (_v, i) => (i % 2 ? '草' : 'w'));
    const result = await make(spy, undefined, 20).judge(texts);
    expect(result.ok && result.value).toHaveLength(300);
    expect(bodies.length).toBeGreaterThanOrEqual(15);
    for (const body of bodies) {
      expect(body.length).toBeLessThanOrEqual(1500 + 200);
      expect(Object.keys((JSON.parse(body) as Sent).questions).length).toBeLessThanOrEqual(20);
    }
  });

  it('honours maxItemsPerChunk and keeps state size within maxPromptChars', async () => {
    const sent: Sent[] = [];
    await make(clefServer(sent), 400, 5).judge(Array.from({ length: 40 }, () => 'hello world'));
    expect(sent.length).toBeGreaterThan(8);
    for (const s of sent) {
      expect(Object.keys(s.questions).length).toBeLessThanOrEqual(5);
      expect(s.state.length + JSON.stringify(s.questions).length).toBeLessThanOrEqual(400);
    }
  });

  it('does no work for no comments, even with a bad base URL', async () => {
    const fetch = vi.fn<Fetch>();
    const judge = createClefJudge({
      baseUrl: 'not a url',
      model: 'm',
      fetch,
      queue: createQueue(),
    });
    expect(await judge.judge([])).toEqual({ ok: true, value: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('abusive threshold', () => {
  // At 0.5 every comment Clef flagged in a live Japanese gaming chat was a false positive.
  it('defaults to 0.8', () => {
    expect(ABUSIVE_THRESHOLD).toBe(0.8);
  });

  it.each([
    { score: 0.79, threshold: undefined, expected: false },
    { score: 0.8, threshold: undefined, expected: true },
    { score: 0.99, threshold: undefined, expected: true },
    { score: 0.89, threshold: 0.9, expected: false },
    { score: 0.9, threshold: 0.9, expected: true },
  ])('$score at threshold $threshold -> $expected', ({ score, threshold, expected }) => {
    expect(isAbusive(score, threshold)).toBe(expected);
  });
});

describe('LLM category judge', () => {
  it('answers with nothing and never calls fetch', async () => {
    expect(llmCategoryJudge.mode).toBe('llm');
    expect(await llmCategoryJudge.judge(['you idiot'])).toEqual({ ok: true, value: [] });
  });
});
