import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { probeClef, scoreClef, type ClefProbe } from './clef.ts';
import { loadClefSamples } from './datasets.ts';

const fixture = fileURLToPath(new URL('./fixtures/clef.jsonl', import.meta.url));
const cli = fileURLToPath(new URL('./clef.ts', import.meta.url));

const systemoneReply = (yes: number): Response =>
  Response.json({
    model: 'clef-flash',
    answers: {
      abusive: {
        type: 'choice',
        choice: yes >= 0.5 ? 'yes' : 'no',
        probabilities: { no: 1 - yes, yes },
        confidence: Math.abs(2 * yes - 1),
      },
    },
    usage: { input_tokens: 40, output_tokens: 0 },
  });

const logprobsReply = (top: Record<string, number>): Response => {
  const entries = Object.entries(top).map(([token, p]) => ({
    id: 1,
    token,
    bytes: [],
    logprob: Math.log(p),
  }));
  return Response.json({
    choices: [
      {
        message: { role: 'assistant', content: entries[0]?.token ?? '' },
        logprobs: { content: [{ ...entries[0], top_logprobs: entries }] },
      },
    ],
  });
};

type Handler = (body: Record<string, unknown>) => Response;

/** A fake llama-server: unknown paths answer 404, a `null` handler drops the connection. */
function fakeServer(routes: Record<string, Handler | null>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    calls.push({ path: url.pathname, body });
    const handler = routes[url.pathname];
    if (handler === null) throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') });
    return handler === undefined ? new Response('', { status: 404 }) : handler(body);
  };
  return { calls, fetch: fetchImpl };
}

describe('probeClef', () => {
  it.each([
    {
      name: 'systemone answers with option probabilities',
      routes: { '/v1/systemone': () => systemoneReply(0.97) },
      mode: 'systemone',
      paths: ['/v1/systemone'],
    },
    {
      name: 'systemone is not a decision model (501), chat gives yes/no logprobs',
      routes: {
        '/v1/systemone': () => new Response('{"error":"not a decision model"}', { status: 501 }),
        '/v1/chat/completions': () => logprobsReply({ Yes: 0.9, No: 0.05 }),
      },
      mode: 'logprobs',
      paths: ['/v1/systemone', '/v1/chat/completions'],
    },
    {
      name: 'systemone answers 200 with another shape, chat gives yes/no logprobs',
      routes: {
        '/v1/systemone': () => Response.json({ answers: { abusive: { type: 'noul' } } }),
        '/v1/chat/completions': () => logprobsReply({ no: 0.7, yes: 0.2 }),
      },
      mode: 'logprobs',
      paths: ['/v1/systemone', '/v1/chat/completions'],
    },
    {
      name: 'no systemone route and chat without logprobs',
      routes: {
        '/v1/chat/completions': () =>
          Response.json({ choices: [{ message: { content: 'yes' }, logprobs: null }] }),
      },
      mode: 'unavailable',
      paths: ['/v1/systemone', '/v1/chat/completions'],
    },
    {
      name: 'chat logprobs without a yes/no token',
      routes: { '/v1/chat/completions': () => logprobsReply({ Maybe: 0.6, I: 0.3 }) },
      mode: 'unavailable',
      paths: ['/v1/systemone', '/v1/chat/completions'],
    },
    {
      name: 'server unreachable',
      routes: { '/v1/systemone': null, '/v1/chat/completions': null },
      mode: 'unavailable',
      paths: ['/v1/systemone', '/v1/chat/completions'],
    },
  ])('$name → $mode', async ({ routes, mode, paths }) => {
    const server = fakeServer(routes);
    const probe = await probeClef('http://127.0.0.1:9/', { fetch: server.fetch });
    expect(probe.mode).toBe(mode);
    expect(probe.detail).not.toBe('');
    expect(server.calls.map((call) => call.path)).toEqual(paths);
  });

  it('keeps the reason of every failed mode in the detail', async () => {
    const server = fakeServer({ '/v1/systemone': null, '/v1/chat/completions': null });
    const probe = await probeClef('http://127.0.0.1:9', { fetch: server.fetch });
    expect(probe.detail).toMatch(/systemone: request to http:\/\/127\.0\.0\.1:9\/v1\/systemone/);
    expect(probe.detail).toMatch(/logprobs: request to .*\/v1\/chat\/completions failed/);
  });

  it('sends a yes/no choice question to systemone and a one-token logprobs request to chat', async () => {
    const server = fakeServer({
      '/v1/systemone': () => new Response('', { status: 501 }),
      '/v1/chat/completions': () => logprobsReply({ yes: 0.5, no: 0.5 }),
    });
    await probeClef('http://127.0.0.1:9', { fetch: server.fetch, model: 'clef-flash' });
    const [systemone, chat] = server.calls.map((call) => call.body);
    expect(systemone).toMatchObject({
      model: 'clef-flash',
      state: expect.any(String),
      questions: {
        abusive: {
          type: 'choice',
          criteria: { yes: expect.any(String), no: expect.any(String) },
        },
      },
    });
    expect(chat).toMatchObject({
      model: 'clef-flash',
      max_tokens: 1,
      temperature: 0,
      logprobs: true,
      top_logprobs: 5,
      chat_template_kwargs: { enable_thinking: false },
    });
  });
});

describe('scoreClef', () => {
  const samples = [
    { text: 'you are useless, quit streaming', toxic: true },
    { text: 'gg, that was a great run', toxic: false },
  ];
  const systemone: ClefProbe = { mode: 'systemone', detail: '' };
  const byText: Handler = (body) =>
    systemoneReply(String(body.state).includes('useless') ? 0.9 : 0.2);

  it('scores each sample with the probed mode and reports accuracy and p50', async () => {
    const server = fakeServer({ '/v1/systemone': byText });
    const score = await scoreClef('http://127.0.0.1:9', systemone, samples, {
      fetch: server.fetch,
    });
    expect(score.accuracy).toBe(1);
    expect(score.failed).toBe(0);
    expect(score.p50Ms).toBeTypeOf('number');
    expect(score.rows.map((row) => row.pToxic)).toEqual([0.9, 0.2]);
    expect(server.calls.map((call) => call.path)).toEqual(['/v1/systemone', '/v1/systemone']);
  });

  it('normalises p(yes) over case and whitespace variants of the yes/no tokens', async () => {
    const server = fakeServer({
      '/v1/chat/completions': () => logprobsReply({ Yes: 0.6, ' yes': 0.2, NO: 0.1, Maybe: 0.05 }),
    });
    const score = await scoreClef(
      'http://127.0.0.1:9',
      { mode: 'logprobs', detail: '' },
      samples.slice(0, 1),
      { fetch: server.fetch },
    );
    expect(score.rows[0]?.pToxic).toBeCloseTo(0.8 / 0.9, 6);
    expect(score.accuracy).toBe(1);
  });

  it('counts a failed sample as wrong and keeps going', async () => {
    let first = true;
    const server = fakeServer({
      '/v1/systemone': (body) => {
        if (!first) return byText(body);
        first = false;
        return new Response('', { status: 500 });
      },
    });
    const score = await scoreClef('http://127.0.0.1:9', systemone, samples, {
      fetch: server.fetch,
    });
    expect(score.failed).toBe(1);
    expect(score.accuracy).toBe(0.5);
    expect(score.rows[0]?.error).toMatch(/HTTP 500/);
  });

  it.each([
    {
      name: 'the probe found no usable mode',
      probe: { mode: 'unavailable', detail: 'nothing answered' } satisfies ClefProbe,
      error: /unavailable/,
    },
    { name: 'every sample fails', probe: systemone, error: /every sample failed/ },
  ])('fails instead of reporting zeros when $name', async ({ probe, error }) => {
    const server = fakeServer({ '/v1/systemone': () => new Response('', { status: 503 }) });
    await expect(
      scoreClef('http://127.0.0.1:9', probe, samples, { fetch: server.fetch }),
    ).rejects.toThrow(error);
  });
});

describe('loadClefSamples', () => {
  it('loads 20 labelled comments with both labels present', () => {
    const loaded = loadClefSamples(fixture);
    expect(loaded).toHaveLength(20);
    expect(new Set(loaded.map((sample) => sample.toxic))).toEqual(new Set([true, false]));
  });
});

describe('bench:clef CLI', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
  });

  const listen = async (handler: Parameters<typeof createServer>[1]): Promise<number> => {
    server = createServer(handler);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  };

  const run = (args: string[]) =>
    new Promise<{ code: number; lines: string[] }>((resolve) => {
      execFile(process.execPath, [cli, ...args], (error, stdout) => {
        resolve({
          code: error ? Number(error.code ?? 1) : 0,
          lines: stdout.trimEnd().split('\n'),
        });
      });
    });

  it('prints the accuracy and ends with CLEF_MODE=systemone against a decision server', async () => {
    const toxic = new Map(loadClefSamples(fixture).map((sample) => [sample.text, sample.toxic]));
    const port = await listen((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && request.url === '/props') {
        response.end(JSON.stringify({ build_info: 'b11475-test', total_slots: 1 }));
        return;
      }
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      request.on('end', () => {
        const { state } = JSON.parse(raw) as { state: string };
        const yes = toxic.get(state) === false ? 0.1 : 0.9;
        response.end(
          JSON.stringify({ answers: { abusive: { probabilities: { yes, no: 1 - yes } } } }),
        );
      });
    });
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'clef-')), 'rows.jsonl');
    const { code, lines } = await run(['--server', `http://127.0.0.1:${port}`, '--out', out]);
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/\| systemone \| 20 \| 0 \| 1\.00 \|/);
    expect(lines.at(-1)).toBe('CLEF_MODE=systemone');
    const [meta, ...rows] = readFileSync(out, 'utf8').trimEnd().split('\n');
    expect(rows).toHaveLength(20);
    expect(JSON.parse(meta ?? '')).toMatchObject({
      type: 'meta',
      bench: 'clef',
      serverProps: { build_info: 'b11475-test' },
      settings: { mode: 'systemone', threshold: 0.5, logprobs: null },
    });
  });

  it('ends with CLEF_MODE=unavailable and exits non-zero when the server is unreachable', async () => {
    const port = await listen(() => undefined);
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
    const { code, lines } = await run(['--', '--server', `http://127.0.0.1:${port}`]);
    expect(code).toBe(1);
    expect(lines.at(-1)).toBe('CLEF_MODE=unavailable');
  });
});
