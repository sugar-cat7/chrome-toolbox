import { describe, expect, it } from 'vitest';
import { runAsrBench, transcribe, type AsrEngine } from './asr.ts';
import type { AudioSample } from './datasets.ts';
import { parseVoices } from './make-audio.ts';

describe('transcribe', () => {
  it.each([
    { engine: 'whisper', path: '/inference', reply: { text: 'halo semua', language: 'id' } },
    {
      engine: 'llama',
      path: '/v1/chat/completions',
      reply: { choices: [{ message: { content: '{"text":"halo semua","lang":"id"}' } }] },
    },
  ])('$engine transcribes through $path', async ({ engine, path, reply }) => {
    const calls: string[] = [];
    const result = await transcribe(engine as AsrEngine, 'http://127.0.0.1:9', new Uint8Array(44), {
      fetch: async (url) => {
        calls.push(new URL(url instanceof Request ? url.url : url).pathname);
        return Response.json(reply);
      },
    });
    expect(calls).toEqual([path]);
    expect(result).toMatchObject({ text: 'halo semua', lang: 'id' });
  });

  it('sends multipart file, verbose_json and language=auto to whisper', async () => {
    let form: FormData | undefined;
    await transcribe('whisper', 'http://127.0.0.1:9/', new Uint8Array(44), {
      fetch: async (_url, init) => {
        form = init?.body as FormData;
        return Response.json({ text: 'x', language: 'english' });
      },
    }).then((result) => expect(result.lang).toBe('en'));
    expect(form?.get('response_format')).toBe('verbose_json');
    expect(form?.get('language')).toBe('auto');
    expect(form?.get('file')).toBeInstanceOf(Blob);
  });

  it('sends input_audio and a json_schema to llama', async () => {
    let body: unknown;
    await transcribe('llama', 'http://127.0.0.1:9', new Uint8Array([1, 2, 3]), {
      model: 'm',
      fetch: async (_url, init) => {
        body = JSON.parse(typeof init?.body === 'string' ? init.body : '');
        return Response.json({ choices: [{ message: { content: '{"text":"x","lang":"en"}' } }] });
      },
    });
    const parsed = body as {
      model: string;
      messages: { content: { type: string; input_audio?: unknown }[] }[];
      response_format: { type: string; json_schema: { name: string } };
    };
    expect(parsed.model).toBe('m');
    expect(parsed.messages[0]?.content[0]).toEqual({
      type: 'input_audio',
      input_audio: { data: 'AQID', format: 'wav' },
    });
    expect(parsed.messages[0]?.content[1]?.type).toBe('text');
    expect(parsed.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'output' },
    });
  });

  it('throws a readable error on HTTP failure and on invalid llama JSON', async () => {
    await expect(
      transcribe('whisper', 'http://127.0.0.1:9', new Uint8Array(44), {
        fetch: async () => new Response('', { status: 503 }),
      }),
    ).rejects.toThrow(/HTTP 503/);
    await expect(
      transcribe('llama', 'http://127.0.0.1:9', new Uint8Array(44), {
        fetch: async () => Response.json({ choices: [{ message: { content: 'nope' } }] }),
      }),
    ).rejects.toThrow(/invalid/);
  });
});

describe('runAsrBench', () => {
  const sample = (id: string, lang: AudioSample['lang'], transcript: string): AudioSample => ({
    id,
    lang,
    voice: 'v',
    transcript,
  });

  it('scores zh by characters and excludes mixed samples from language accuracy', async () => {
    const hypotheses = new Map([
      ['zh1', { text: '你好', language: 'zh' }],
      ['mx1', { text: 'ok いいね', language: 'ja' }],
    ]);
    const report = await runAsrBench({
      engine: 'whisper',
      server: 'http://127.0.0.1:9',
      samples: [sample('zh1', 'zh', '你好世界'), sample('mx1', 'mixed', 'ok いいね')],
      loadWav: (id) => new TextEncoder().encode(id),
      fetch: async (_url, init) => {
        const file = init?.body instanceof FormData ? init.body.get('file') : null;
        return Response.json(hypotheses.get(file instanceof Blob ? await file.text() : ''));
      },
    });
    expect(report.byLang['zh']).toMatchObject({ errorRate: 0.5, langAccuracy: 1 });
    expect(report.byLang['mixed']?.errorRate).toBe(0);
    expect(report.byLang['mixed']?.langAccuracy).toBeUndefined();
  });

  it('counts a wrong or missing language as a miss and keeps going after a failure', async () => {
    const replies = [
      Response.json({ text: 'hello', language: 'es' }),
      new Response('', { status: 500 }),
      Response.json({ text: 'hola' }),
    ];
    const report = await runAsrBench({
      engine: 'whisper',
      server: 'http://127.0.0.1:9',
      samples: [sample('a', 'en', 'hello'), sample('b', 'en', 'hello'), sample('c', 'es', 'hola')],
      loadWav: () => new Uint8Array(44),
      fetch: async () => replies.shift() ?? new Response('', { status: 500 }),
    });
    expect(report.byLang['en']).toMatchObject({ errorRate: 0, langAccuracy: 0 });
    expect(report.byLang['es']?.langAccuracy).toBe(0);
    expect(report.rows.filter((row) => row.error !== undefined)).toHaveLength(1);
  });

  it('keeps a language whose samples all failed in byLang and counts failures as misses', async () => {
    const report = await runAsrBench({
      engine: 'whisper',
      server: 'http://127.0.0.1:9',
      samples: [
        sample('e', 'en', 'hello'),
        sample('k1', 'ko', '안녕'),
        sample('k2', 'ko', '안녕'),
        sample('s1', 'es', 'hola'),
        sample('s2', 'es', 'hola'),
      ],
      loadWav: (id) => new TextEncoder().encode(id),
      fetch: async (_url, init) => {
        const file = init?.body instanceof FormData ? init.body.get('file') : null;
        const id = file instanceof Blob ? await file.text() : '';
        if (id === 'e') return Response.json({ text: 'hello', language: 'en' });
        if (id === 's1') return Response.json({ text: 'hola', language: 'es' });
        return new Response('', { status: 500 });
      },
    });
    expect(report.byLang['ko']).toMatchObject({ failed: 2, langAccuracy: 0 });
    expect(report.byLang['ko']?.errorRate).toBeUndefined();
    expect(report.byLang['ko']?.p50Ms).toBeUndefined();
    expect(report.byLang['es']).toMatchObject({ failed: 1, langAccuracy: 0.5, errorRate: 0 });
    expect(report.byLang['en']).toMatchObject({ failed: 0, langAccuracy: 1 });
  });

  it('counts a missing WAV as a dataset gap, not an engine failure or a language miss', async () => {
    const report = await runAsrBench({
      engine: 'whisper',
      server: 'http://127.0.0.1:9',
      samples: [sample('a', 'en', 'hello'), sample('b', 'en', 'hello')],
      loadWav: (id) => (id === 'a' ? new Uint8Array(44) : undefined),
      fetch: async () => Response.json({ text: 'hello', language: 'en' }),
    });
    expect(report.byLang['en']).toMatchObject({ missing: 1, failed: 0, langAccuracy: 1 });
    expect(report.rows.find((row) => row.id === 'b')).toMatchObject({ missing: true });
    expect(report.rows.find((row) => row.id === 'b')?.error).toBeUndefined();
    expect(report.rows.find((row) => row.id === 'b')?.langOk).toBeUndefined();
  });

  it('fails with a dataset error when every WAV is missing', async () => {
    let calls = 0;
    await expect(
      runAsrBench({
        engine: 'whisper',
        server: 'http://127.0.0.1:9',
        samples: [sample('a', 'en', 'hello')],
        loadWav: () => undefined,
        fetch: async () => {
          calls += 1;
          return Response.json({ text: 'hello' });
        },
      }),
    ).rejects.toThrow(/no WAV file found for any of 1 samples/);
    expect(calls).toBe(0);
  });

  it('fails instead of reporting zeros when no sample could be transcribed', async () => {
    await expect(
      runAsrBench({
        engine: 'llama',
        server: 'http://127.0.0.1:9',
        samples: [sample('a', 'en', 'hello')],
        loadWav: () => new Uint8Array(44),
        fetch: async () => {
          throw new TypeError('fetch failed');
        },
      }),
    ).rejects.toThrow(/every sample failed.*fetch failed/);
  });
});

describe('parseVoices', () => {
  it('reads voice names from say listing, including accents', () => {
    const listing =
      'Mónica              es_ES    # ¡Hola!\nSamantha            en_US    # Hello!\nGrandma (English (US)) en_US    # Hi\n';
    expect(parseVoices(listing)).toEqual(new Set(['Mónica', 'Samantha', 'Grandma (English (US))']));
  });
});
