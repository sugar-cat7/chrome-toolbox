import { describe, expect, it } from 'vitest';
import {
  ASR_SAMPLE_RATE,
  commentBatchPrompt,
  createLlamaClient,
  encodeWav,
  subtitleMaxTokens,
  subtitlePrompt,
} from '@chrome-toolbox/extension-core';
import type { AudioSample } from './datasets.ts';
import { runSlotBench, type Stats } from './slots.ts';

const SUBTITLE_INPUT = {
  source: 'x',
  sourceLang: 'en',
  previous: [],
  glossary: [],
  context: '',
};
const SUBTITLE_SYSTEM = subtitlePrompt(SUBTITLE_INPUT).messages[0]?.content;
const COMMENT_SYSTEM = commentBatchPrompt({
  comments: [{ text: 'x', lang: 'en', translate: true }],
  context: '',
}).messages[0]?.content;
/** A compact reply that translates every comment of a commentBatchPrompt user turn. */
const commentReply = (user: string): string =>
  user
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => `${(JSON.parse(line) as { id: number }).id}\tc\t訳\n`)
    .join('');

type Seen = {
  kind: 'subtitle' | 'comment' | 'unknown';
  model: unknown;
  slot: unknown;
  client: string;
  temperature: unknown;
  maxTokens: unknown;
  templateKwargs: unknown;
  /** A comment batch's grammar code class and whether its user turn names a genre. */
  codes?: string | undefined;
  grammar?: string | undefined;
  user?: string | undefined;
  genre?: string | undefined;
};

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number): void => {
      t += ms;
    },
    sleep: async (ms: number): Promise<void> => {
      t += ms;
    },
  };
}

function fakeServer(
  totalSlots: unknown,
  options: {
    failComments?: boolean;
    subtitleMs?: number;
    clock?: ReturnType<typeof fakeClock>;
  } = {},
) {
  const seen: Seen[] = [];
  const propsUrls: string[] = [];
  const clock = options.clock ?? fakeClock();
  const fetchFor =
    (client: string) =>
    async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/health')) return Response.json({ status: 'ok' });
      if (url.includes('/props')) {
        propsUrls.push(url);
        return Response.json({ total_slots: totalSlots });
      }
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        id_slot?: number;
        model?: string;
        temperature?: number;
        max_tokens?: number;
        chat_template_kwargs?: unknown;
        grammar?: string;
        messages: { role: string; content: string }[];
      };
      const system = body.messages[0]?.content;
      const kind =
        system === SUBTITLE_SYSTEM ? 'subtitle' : system === COMMENT_SYSTEM ? 'comment' : 'unknown';
      seen.push({
        kind,
        slot: body.id_slot,
        model: body.model,
        client,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
        templateKwargs: body.chat_template_kwargs,
        codes: body.grammar?.split('\n')[1],
        grammar: body.grammar,
        user: body.messages[1]?.content,
        genre: body.messages[1]?.content
          .split('\n')
          .find((line) => line.startsWith('Stream genre: ')),
      });
      if (kind === 'comment')
        return options.failComments
          ? new Response('', { status: 500 })
          : Response.json({
              choices: [{ message: { content: commentReply(body.messages[1]?.content ?? '') } }],
            });
      clock.advance(options.subtitleMs ?? 0);
      return Response.json({
        choices: [{ message: { content: 'こんにちは\n' }, finish_reason: 'stop' }],
      });
    };
  return { seen, propsUrls, fetchFor, clock };
}

const options = (server: ReturnType<typeof fakeServer>, pinSlots: boolean) => {
  const make = (name: string) =>
    createLlamaClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: server.fetchFor(name) as typeof fetch,
    });
  return {
    client: make('subtitle-client'),
    commentClients: [make('comment-client')],
    seconds: 6,
    subtitleEveryMs: 1500,
    commentBatchSize: 20,
    pinSlots,
    now: server.clock.now,
    sleep: server.clock.sleep,
  };
};

describe('runSlotBench', () => {
  it('passes --model to every request and to props', async () => {
    const server = fakeServer(2);
    await runSlotBench({ ...options(server, true), model: 'gemma4-e4b' });
    expect(server.propsUrls).toEqual(['http://127.0.0.1:1/props?model=gemma4-e4b']);
    expect(server.seen.length).toBeGreaterThan(0);
    expect(server.seen.every((s) => s.model === 'gemma4-e4b')).toBe(true);
    expect(new Set(server.seen.map((s) => s.kind))).toEqual(new Set(['subtitle', 'comment']));
  });

  it('sends comment batches with the categories every real batch has (genre other, R62)', async () => {
    const server = fakeServer(2);
    await runSlotBench(options(server, true));
    const comment = server.seen.filter((s) => s.kind === 'comment');
    expect(comment.length).toBeGreaterThan(0);
    expect(new Set(comment.map((s) => s.codes))).toEqual(new Set(['code ::= [asqicrve]']));
    expect(new Set(comment.map((s) => s.genre))).toEqual(
      new Set(['Stream genre: other (unknown)']),
    );
  });

  it('pins subtitles to slot 0 and comment batches to slot 1 on separate clients', async () => {
    const server = fakeServer(2);
    const report = await runSlotBench(options(server, true));
    const subtitle = server.seen.filter((s) => s.kind === 'subtitle');
    const comment = server.seen.filter((s) => s.kind === 'comment');
    expect(server.seen.some((s) => s.kind === 'unknown')).toBe(false);
    expect(subtitle.length).toBeGreaterThan(0);
    expect(comment.length).toBeGreaterThan(0);
    expect(subtitle.every((s) => s.slot === 0 && s.client === 'subtitle-client')).toBe(true);
    expect(comment.every((s) => s.slot === 1 && s.client === 'comment-client')).toBe(true);
    expect(report.idle).toMatchObject({ expected: 4, sent: 4, late: 0, count: 4, pass: true });
    expect(report.idle.commentOk).toBe(0);
    expect(report.idle.commentP50Ms).toBeUndefined();
    expect(report.loaded).toMatchObject({ expected: 4, sent: 4, count: 4, pass: true });
    expect(report.loaded.commentOk).toBe(comment.length);
    expect(report.loaded.commentFailed).toBe(0);
    expect(report.loaded.commentP50Ms).toBeTypeOf('number');
    expect(report.loaded.commentP95Ms).toBeGreaterThanOrEqual(report.loaded.commentP50Ms ?? 0);
  });

  it('runs two comment streams on slots 1 and 2, each on its own client', async () => {
    const server = fakeServer(3);
    const make = (name: string) =>
      createLlamaClient({
        baseUrl: 'http://127.0.0.1:1',
        fetch: server.fetchFor(name) as typeof fetch,
      });
    const report = await runSlotBench({
      ...options(server, true),
      commentClients: [make('comment-1'), make('comment-2')],
    });
    const comment = server.seen.filter((s) => s.kind === 'comment');
    expect(new Set(comment.map((s) => `${s.client}@${String(s.slot)}`))).toEqual(
      new Set(['comment-1@1', 'comment-2@2']),
    );
    expect(server.seen.filter((s) => s.kind === 'subtitle').every((s) => s.slot === 0)).toBe(true);
    expect(report.loaded).toMatchObject({ expected: 4, sent: 4, count: 4, pass: true });
    expect(report.loaded.commentOk).toBe(comment.length);
  });

  it('sends each subtitle under its own grammar and token budget', async () => {
    const server = fakeServer(2);
    await runSlotBench(options(server, true));
    const subtitle = server.seen.filter((s) => s.kind === 'subtitle');
    expect(subtitle.length).toBeGreaterThan(0);
    for (const seen of subtitle) {
      const line = /^Line to translate \(JSON string\): (.*)$/mu.exec(seen.user ?? '')?.[1] ?? '';
      const source = JSON.parse(line) as string;
      expect(seen.grammar).toBe(subtitlePrompt({ ...SUBTITLE_INPUT, source }).grammar);
      expect(seen.maxTokens).toBe(subtitleMaxTokens(source));
    }
  });

  it('pins generation settings on subtitle and comment requests', async () => {
    const server = fakeServer(2);
    await runSlotBench(options(server, true));
    for (const seen of server.seen) {
      expect(seen.temperature).toBe(0);
      expect(seen.maxTokens).toBeGreaterThan(0);
      expect(seen.templateKwargs).toEqual({ enable_thinking: false });
    }
  });

  it('measures from the scheduled tick, so a slow reply delays every later subtitle', async () => {
    // Each subtitle takes 2 s against a 1.5 s cadence: ticks back up behind each other.
    const server = fakeServer(2, { subtitleMs: 2000 });
    const report = await runSlotBench(options(server, true));
    const expected: Partial<Stats> = {
      expected: 4,
      sent: 3,
      late: 2,
      count: 3,
      failed: 0,
      p50Ms: 2500,
      p95Ms: 3000,
      pass: false,
    };
    expect(report.idle).toMatchObject(expected);
  });

  it.each([
    { name: 'p50 over 2000 ms', subtitleMs: 2100, pass: false },
    { name: 'within the targets', subtitleMs: 1400, pass: true },
  ])('marks a phase PASS only when $name', async ({ subtitleMs, pass }) => {
    const report = await runSlotBench(options(fakeServer(2, { subtitleMs }), true));
    expect(report.idle.pass).toBe(pass);
  });

  it('sends no id_slot at all when pinSlots is false', async () => {
    const server = fakeServer(2);
    await runSlotBench(options(server, false));
    expect(server.seen.length).toBeGreaterThan(0);
    expect(server.seen.every((s) => s.slot === undefined)).toBe(true);
  });

  it('rejects a loaded phase where every comment batch fails, after reporting idle', async () => {
    const server = fakeServer(2, { failComments: true });
    const phases: string[] = [];
    await expect(
      runSlotBench({ ...options(server, true), onPhase: (phase) => phases.push(phase) }),
    ).rejects.toThrow(/loaded phase is invalid: no comment batch succeeded \(\d+ failed\)/);
    expect(phases).toEqual(['idle']);
    const attempts = server.seen.filter((s) => s.kind === 'comment').length;
    // 6 s of fake time at 250 ms backoff bounds the retries; a hot loop would never end.
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(6000 / 250 + 1);
  });

  it('reports each phase as soon as it ends', async () => {
    const phases: [string, number][] = [];
    await runSlotBench({
      ...options(fakeServer(2), true),
      onPhase: (phase, stats) => phases.push([phase, stats.count]),
    });
    expect(phases).toEqual([
      ['idle', 4],
      ['loaded', 4],
    ]);
  });

  it.each([
    {
      name: 'fewer than 2 slots',
      totalSlots: 1,
      streams: 1,
      message: /total_slots=1.*--parallel 2/,
    },
    {
      name: 'no total_slots',
      totalSlots: null,
      streams: 1,
      message: /could not read total_slots.*--parallel 2/,
    },
    {
      name: 'fewer than 3 slots for two comment streams',
      totalSlots: 2,
      streams: 2,
      message: /total_slots=2.*2 comment streams.*--parallel 3/,
    },
  ])(
    'throws before measuring when the server has $name',
    async ({ totalSlots, streams, message }) => {
      const server = fakeServer(totalSlots);
      const base = options(server, true);
      const commentClients = Array.from({ length: streams }, () => base.client);
      await expect(runSlotBench({ ...base, commentClients })).rejects.toThrow(message);
      expect(server.seen).toEqual([]);
    },
  );

  it('throws before measuring without a comment stream', async () => {
    const server = fakeServer(2);
    await expect(runSlotBench({ ...options(server, true), commentClients: [] })).rejects.toThrow(
      /at least one comment stream/,
    );
    expect(server.seen).toEqual([]);
  });

  it('throws a readable error when the server is not ready', async () => {
    const down = (async () => new Response('', { status: 503 })) as typeof fetch;
    const server = fakeServer(2);
    await expect(
      runSlotBench({
        ...options(server, true),
        client: createLlamaClient({ baseUrl: 'http://127.0.0.1:1', fetch: down }),
      }),
    ).rejects.toThrow(/not ready/);
  });
});

describe('runSlotBench with --audio', () => {
  const WAV = encodeWav(new Int16Array(ASR_SAMPLE_RATE), ASR_SAMPLE_RATE);
  const sample = (id: string, lang: AudioSample['lang']): AudioSample => ({
    id,
    lang,
    voice: 'synthetic',
    transcript: 'made up',
  });
  type Call = {
    kind: 'asr' | 'translate';
    slot: unknown;
    model: unknown;
    at: number;
    /** The request body's length: tells clips of different lengths apart. */
    size: number;
  };

  /** A server that answers audio chats with `asrLine` and translations with a made-up line. */
  function audioServer(options: {
    asrLine?: string;
    asrMs?: number;
    translateMs?: (n: number) => number;
    promptMs?: { asr: number; translate: number };
  }) {
    const clock = fakeClock();
    const calls: Call[] = [];
    let translations = 0;
    const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/health')) return Response.json({ status: 'ok' });
      if (url.includes('/props')) return Response.json({ total_slots: 2 });
      const text = typeof init?.body === 'string' ? init.body : '{}';
      const body = JSON.parse(text) as {
        id_slot?: number;
        model?: string;
        messages: { content: unknown }[];
      };
      if (body.messages[0]?.content === COMMENT_SYSTEM)
        return Response.json({
          choices: [{ message: { content: commentReply(String(body.messages[1]?.content)) } }],
        });
      const asr = text.includes('input_audio');
      calls.push({
        kind: asr ? 'asr' : 'translate',
        slot: body.id_slot,
        model: body.model,
        at: clock.now(),
        size: text.length,
      });
      if (asr) clock.advance(options.asrMs ?? 0);
      else {
        translations += 1;
        clock.advance(options.translateMs?.(translations) ?? 0);
      }
      return Response.json({
        choices: [
          {
            message: { content: asr ? (options.asrLine ?? 'en\tHello there\n') : 'こんにちは\n' },
            finish_reason: 'stop',
          },
        ],
        timings: {
          prompt_ms: asr ? (options.promptMs?.asr ?? 1) : (options.promptMs?.translate ?? 1),
          predicted_ms: 1,
          predicted_n: 1,
        },
      });
    };
    const make = (): ReturnType<typeof createLlamaClient> =>
      createLlamaClient({ baseUrl: 'http://127.0.0.1:1', fetch: fetchFn as typeof fetch });
    const base = {
      client: make(),
      commentClients: [make()],
      seconds: 6,
      subtitleEveryMs: 1500,
      commentBatchSize: 20,
      pinSlots: true,
      now: clock.now,
      sleep: clock.sleep,
    };
    return { calls, base };
  }
  const audio = (...samples: AudioSample[]) => ({ samples, loadWav: () => WAV });

  it('sends ASR then the translation on slot 0 and measures both from the tick schedule', async () => {
    const server = audioServer({
      asrMs: 300,
      translateMs: () => 500,
      promptMs: { asr: 40, translate: 7 },
    });
    const report = await runSlotBench({
      ...server.base,
      model: 'gemma4-e4b',
      audio: audio(sample('a', 'en')),
    });
    const idle = server.calls.slice(0, 8);
    expect(idle.map((c) => c.kind)).toEqual([
      'asr',
      'translate',
      'asr',
      'translate',
      'asr',
      'translate',
      'asr',
      'translate',
    ]);
    expect(server.calls.slice(0, 8).every((c) => c.slot === 0 && c.model === 'gemma4-e4b')).toBe(
      true,
    );
    expect(report.idle).toMatchObject({
      expected: 4,
      sent: 4,
      count: 4,
      failed: 0,
      sourceP50Ms: 300,
      sourceP95Ms: 300,
      p50Ms: 800,
      p95Ms: 800,
      asrPromptP50Ms: 40,
      translatePromptP50Ms: 7,
      pass: true,
    });
  });

  it('skips the translation for Japanese speech', async () => {
    const server = audioServer({ asrLine: 'ja\tこんにちは\n', asrMs: 300 });
    const report = await runSlotBench({
      ...server.base,
      audio: audio(sample('a', 'ja')),
    });
    expect(server.calls.slice(0, 4).map((c) => c.kind)).toEqual(['asr', 'asr', 'asr', 'asr']);
    expect(report.idle).toMatchObject({ sent: 4, failed: 0, sourceP50Ms: 300, count: 0 });
    expect(report.idle.translatePromptP50Ms).toBeUndefined();
  });

  it('skips the translation of silence but still measures the ASR', async () => {
    const server = audioServer({ asrLine: 'en\t\n', asrMs: 200 });
    const report = await runSlotBench({ ...server.base, audio: audio(sample('a', 'en')) });
    expect(server.calls.slice(0, 4).every((c) => c.kind === 'asr')).toBe(true);
    expect(report.idle).toMatchObject({ sent: 4, failed: 0, sourceP50Ms: 200, count: 0 });
  });

  it('sends the manifest samples in order, one per tick, repeating', async () => {
    const clips: Record<string, Uint8Array> = {
      a: encodeWav(new Int16Array(ASR_SAMPLE_RATE), ASR_SAMPLE_RATE),
      b: encodeWav(new Int16Array(2 * ASR_SAMPLE_RATE), ASR_SAMPLE_RATE),
    };
    const server = audioServer({});
    await runSlotBench({
      ...server.base,
      audio: {
        samples: [sample('a', 'en'), sample('b', 'en')],
        loadWav: (id) => clips[id],
      },
    });
    const sizes = server.calls
      .filter((c) => c.kind === 'asr')
      .slice(0, 4)
      .map((c) => c.size);
    const [a, b] = [sizes[0] as number, sizes[1] as number];
    expect(b).toBeGreaterThan(a);
    expect(sizes).toEqual([a, b, a, b]);
  });

  it('rejects an unpinned audio run, since ASR always uses slot 0', async () => {
    const server = audioServer({});
    await expect(
      runSlotBench({ ...server.base, pinSlots: false, audio: audio(sample('a', 'en')) }),
    ).rejects.toThrow(/audio.*pinned|pinned.*audio/i);
    expect(server.calls).toEqual([]);
  });

  it('fails the target when ja p95 exceeds 3000 ms', async () => {
    // Three ticks of 700 ms and one of 3100 ms: p50 is fine, p95 is not.
    const server = audioServer({
      asrMs: 200,
      translateMs: (n) => (n === 4 ? 2900 : n > 4 ? 100 : 500),
    });
    const report = await runSlotBench({ ...server.base, audio: audio(sample('a', 'en')) });
    expect(report.idle).toMatchObject({ sent: 4, failed: 0, p50Ms: 700, p95Ms: 3100, pass: false });
  });

  it.each([
    { name: 'source p50 over 1000 ms', asrMs: 1100, translateMs: 100, pass: false },
    { name: 'ja p50 over 2000 ms', asrMs: 900, translateMs: 1200, pass: false },
    { name: 'within every target', asrMs: 900, translateMs: 800, pass: true },
  ])('marks a phase PASS only when $name is not hit', async ({ asrMs, translateMs, pass }) => {
    const server = audioServer({ asrMs, translateMs: () => translateMs });
    const report = await runSlotBench({
      ...server.base,
      seconds: 1.5,
      audio: audio(sample('a', 'en')),
    });
    expect(report.idle.pass).toBe(pass);
  });

  it('throws before measuring when no sample has a WAV file', async () => {
    const server = audioServer({});
    await expect(
      runSlotBench({
        ...server.base,
        audio: { samples: [sample('a', 'en')], loadWav: () => undefined },
      }),
    ).rejects.toThrow(/no WAV file/);
    expect(server.calls).toEqual([]);
  });
});
