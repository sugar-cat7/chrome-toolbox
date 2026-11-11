import { describe, expect, it, vi } from 'vitest';
import { Err, failure, Ok } from '@chrome-toolbox/contracts';
import { createLlamaClient } from './llm.ts';
import { createClefJudge } from './toxicity.ts';
import { createQueue } from './queue.ts';
import { normalizeFetch, readResponseText, type ResultFetch } from './transport.ts';

const baseUrl = 'http://127.0.0.1:18083';

describe('ResultFetch compatibility', () => {
  it('normalizes a rejected legacy fetch into AppError', async () => {
    const fetch = normalizeFetch(() => Promise.reject(new TypeError('private cause')));
    expect(await fetch(baseUrl)).toMatchObject({
      ok: false,
      error: {
        internalCode: 'network_failed',
        diagnosticId: expect.stringMatching(/^[a-f0-9]{32}$/u),
      },
    });
  });

  it('preserves native diagnostic IDs in both clients', async () => {
    const error = failure('ipc_failed', 'a'.repeat(32));
    const fetch: ResultFetch = async () => Err(error);
    expect(await createLlamaClient({ baseUrl, resultFetch: fetch }).health()).toEqual(Err(error));
    expect(
      await createClefJudge({
        baseUrl,
        model: 'clef-flash',
        resultFetch: fetch,
        queue: createQueue(),
      }).judge(['hi']),
    ).toEqual(Err(error));
  });

  it.each([
    { status: 503, body: 'Loading model', expected: 'response_invalid' },
    { status: 501, body: 'not a decision model', expected: 'clef_unavailable' },
    { status: 400, body: "model 'clef-flash' not found", expected: 'clef_unavailable' },
    { status: 400, body: 'context size exceeded', expected: 'response_invalid' },
  ])('delivers HTTP $status to the Clef parser', async ({ status, body, expected }) => {
    const fetch: ResultFetch = async () => Ok(new Response(body, { status }));
    const result = await createClefJudge({
      baseUrl,
      model: 'clef-flash',
      resultFetch: fetch,
      queue: createQueue(),
    }).judge(['hi']);
    expect(result).toMatchObject({ ok: false, error: { internalCode: expected } });
  });

  it('delivers an HTTP refusal through the PLaMo client', async () => {
    const fetch: ResultFetch = async () => Ok(new Response('loading', { status: 503 }));
    expect(
      await createLlamaClient({ baseUrl, resultFetch: fetch }).chat({
        messages: [],
        tellRefusal: true,
      }),
    ).toMatchObject({ ok: false, error: { internalCode: 'model_refused' } });
  });
});

describe('bounded response bodies', () => {
  it('reads UTF-8 split across chunks within the byte limit', async () => {
    const bytes = new TextEncoder().encode('あ');
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 1));
          controller.enqueue(bytes.slice(1));
          controller.close();
        },
      }),
    );
    expect(await readResponseText(response, undefined, 3)).toEqual(Ok('あ'));
  });

  it('cancels a chunked body as soon as the limit is exceeded', async () => {
    const cancel = vi.fn<() => void>();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(65_537));
        },
        cancel,
      }),
    );
    expect(await readResponseText(response)).toMatchObject({
      ok: false,
      error: { internalCode: 'response_invalid' },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  });

  it('cancels a stalled body on abort and removes its reader lock', async () => {
    const cancel = vi.fn<() => void>();
    const response = new Response(new ReadableStream({ cancel }));
    const controller = new AbortController();
    const result = readResponseText(response, controller.signal);
    controller.abort();
    expect(await result).toMatchObject({
      ok: false,
      error: { internalCode: 'operation_cancelled' },
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it.each(['llama', 'clef'])('rejects an oversized successful %s JSON body', async (client) => {
    const fetch: ResultFetch = async () => Ok(new Response(' '.repeat(65_536) + '{}'));
    const result =
      client === 'llama'
        ? await createLlamaClient({ baseUrl, resultFetch: fetch }).health()
        : await createClefJudge({
            baseUrl,
            model: 'clef-flash',
            resultFetch: fetch,
            queue: createQueue(),
          }).judge(['hi']);
    expect(result).toMatchObject({ ok: false, error: { internalCode: 'response_invalid' } });
  });
});

it('captures a synchronous exception from a legacy SDK thunk', async () => {
  const fetch = normalizeFetch(() => {
    JSON.parse('{');
    return Promise.resolve(new Response());
  });
  expect(await fetch(baseUrl)).toMatchObject({
    ok: false,
    error: { internalCode: 'network_failed' },
  });
});

it('normalizes a rejected ResultFetch at ingress', async () => {
  const resultFetch: ResultFetch = () => Promise.reject(new TypeError('transport rejected'));
  expect(await createLlamaClient({ baseUrl, resultFetch }).health()).toMatchObject({
    ok: false,
    error: { internalCode: 'network_failed' },
  });
  expect(
    await createClefJudge({
      baseUrl,
      model: 'clef-flash',
      resultFetch,
      queue: createQueue(),
    }).judge(['hi']),
  ).toMatchObject({ ok: false, error: { internalCode: 'network_failed' } });
});

it('decodes successful Clef and chat bodies through ResultFetch', async () => {
  const resultFetch: ResultFetch = async (input) =>
    Ok(
      new Response(
        JSON.stringify(
          new URL(input).pathname === '/v1/systemone'
            ? { answers: { c1: { noul: 0.79 } } }
            : { choices: [{ message: { content: 'こんにちは' }, finish_reason: 'stop' }] },
        ),
      ),
    );
  expect(
    await createClefJudge({
      baseUrl,
      model: 'clef-flash',
      resultFetch,
      queue: createQueue(),
    }).judge(['hello']),
  ).toEqual(Ok([0.79]));
  expect(
    await createLlamaClient({ baseUrl, resultFetch }).chat({
      messages: [{ role: 'user', content: 'hello' }],
    }),
  ).toEqual(Ok({ text: 'こんにちは', finishReason: 'stop', timing: undefined }));
});
