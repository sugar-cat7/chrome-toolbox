import { encodeWav } from '@chrome-toolbox/extension-core';
import { describe, expect, it } from 'vitest';
import { decodeWav, runAsrBench } from './asr.ts';
import type { AudioSample } from './datasets.ts';
import { parseVoices } from './make-audio.ts';

const sample = (id: string, lang: AudioSample['lang'], transcript: string): AudioSample => ({
  id,
  lang,
  voice: 'v',
  transcript,
});
const wavOf = (samples: number): Uint8Array => encodeWav(new Int16Array(samples), 16000);
const chatReply = (content: string, finishReason = 'stop'): Response =>
  Response.json({ choices: [{ message: { content }, finish_reason: finishReason }] });
type Body = { model?: string; id_slot?: number; messages: { content: unknown }[] };
const bodyOf = (init: RequestInit | undefined): Body =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Body;
const audioSamples = (body: Body): number => {
  const parts = body.messages[1]?.content;
  const audio = Array.isArray(parts)
    ? (parts as { type: string; input_audio?: { data: string } }[]).find(
        (part) => part.type === 'input_audio',
      )
    : undefined;
  return audio?.input_audio === undefined
    ? 0
    : (Buffer.from(audio.input_audio.data, 'base64').length - 44) / 2;
};
const base = { server: 'http://127.0.0.1:9', model: 'fixture-model' };

describe('decodeWav', () => {
  it('reads the samples after the data chunk, also past other chunks', () => {
    const wav = encodeWav(Int16Array.from([5, -6, 7]), 16000);
    const list = new TextEncoder().encode('LIST\u0004\u0000\u0000\u0000abcd');
    const padded = new Uint8Array([...wav.subarray(0, 36), ...list, ...wav.subarray(36)]);
    expect([...(decodeWav(wav) ?? [])]).toEqual([5, -6, 7]);
    expect([...(decodeWav(padded) ?? [])]).toEqual([5, -6, 7]);
    expect(decodeWav(new Uint8Array(10))).toBeUndefined();
  });

  it.each([
    { name: 'stereo', channels: 2, rate: 16000, bits: 16, format: 1 },
    { name: '48 kHz', channels: 1, rate: 48000, bits: 16, format: 1 },
    { name: '8-bit', channels: 1, rate: 16000, bits: 8, format: 1 },
    { name: 'float', channels: 1, rate: 16000, bits: 16, format: 3 },
  ])('rejects a $name file: the extension sends 16 kHz mono 16-bit PCM', (fmt) => {
    const wav = encodeWav(Int16Array.from([1, 2, 3, 4]), 16000);
    const view = new DataView(wav.buffer);
    view.setUint16(20, fmt.format, true);
    view.setUint16(22, fmt.channels, true);
    view.setUint32(24, fmt.rate, true);
    view.setUint16(34, fmt.bits, true);
    expect(decodeWav(wav)).toBeUndefined();
  });

  it('rejects a file whose fmt chunk is missing', () => {
    const wav = encodeWav(Int16Array.from([1, 2]), 16000);
    expect(
      decodeWav(new Uint8Array([...wav.subarray(0, 12), ...wav.subarray(36)])),
    ).toBeUndefined();
  });
});

describe('runAsrBench', () => {
  it('sends the extension request: model, slot 0 and the wav as input_audio', async () => {
    const bodies: Body[] = [];
    await runAsrBench({
      ...base,
      samples: [sample('a', 'en', 'hello there')],
      loadWav: () => wavOf(24_000),
      fetch: async (_url, init) => {
        bodies.push(bodyOf(init));
        return chatReply('en\thello there\n');
      },
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ model: 'fixture-model', id_slot: 0 });
    expect(audioSamples(bodies[0] as Body)).toBe(24_000);
  });

  it('scores zh and ja by characters and excludes mixed samples from language accuracy', async () => {
    const byLength = new Map([
      [16_000, 'zh\t你好\n'],
      [32_000, 'ja\tこんにちは世界\n'],
      [48_000, 'ja\tok いいね\n'],
    ]);
    const lengthOf = new Map([
      ['zh1', 16_000],
      ['ja1', 32_000],
      ['mx1', 48_000],
    ]);
    const report = await runAsrBench({
      ...base,
      samples: [
        sample('zh1', 'zh', '你好世界'),
        sample('ja1', 'ja', 'こんにちは世界'),
        sample('mx1', 'mixed', 'ok いいね'),
      ],
      loadWav: (id) => wavOf(lengthOf.get(id) ?? 0),
      fetch: async (_url, init) => chatReply(byLength.get(audioSamples(bodyOf(init))) ?? ''),
    });
    expect(report.byLang['zh']).toMatchObject({ errorRate: 0.5, langAccuracy: 1 });
    expect(report.byLang['ja']).toMatchObject({ errorRate: 0, langAccuracy: 1 });
    expect(report.byLang['mixed']?.errorRate).toBe(0);
    expect(report.byLang['mixed']?.langAccuracy).toBeUndefined();
  });

  it('counts silent rows and language accuracy with the line format', async () => {
    const replies = [
      chatReply('en\thello\n'),
      chatReply('es\thello\n'),
      chatReply('en\t\n'),
      chatReply('ko\t안녕', 'length'),
    ];
    const report = await runAsrBench({
      ...base,
      samples: [
        sample('a', 'en', 'hello'),
        sample('b', 'en', 'hello'),
        sample('c', 'en', 'hello'),
        sample('d', 'ko', '안녕'),
      ],
      loadWav: () => wavOf(16_000),
      fetch: async () => replies.shift() ?? new Response('', { status: 500 }),
    });
    expect(report.byLang['en']).toMatchObject({ silent: 1, failed: 0, langAccuracy: 1 / 2 });
    expect(report.rows.find((row) => row.id === 'c')).toMatchObject({
      silent: true,
      hypothesis: '',
      detectedLang: 'en',
    });
    // A silent row says nothing about the language: it is in neither count of the accuracy.
    expect(report.rows.find((row) => row.id === 'c')?.langOk).toBeUndefined();
    expect(report.byLang['ko']).toMatchObject({ silent: 0, failed: 1, langAccuracy: 0 });
    expect(report.rows.find((row) => row.id === 'd')?.error).toBe('response_invalid');
  });

  it('scores chunked clips by joining the chunk transcripts', async () => {
    const lengths: number[] = [];
    const chunkReplies = ['en\tokay chat\n', 'en\twe are going in\n'];
    const report = await runAsrBench({
      ...base,
      samples: [sample('a', 'en', 'okay chat we are going in')],
      loadWav: () => wavOf(40_000),
      chunkMs: 1500,
      fetch: async (_url, init) => {
        lengths.push(audioSamples(bodyOf(init)));
        return chatReply(chunkReplies.shift() ?? 'en\t\n');
      },
    });
    expect(lengths).toEqual([24_000, 16_000]);
    expect(report.rows[0]).toMatchObject({
      hypothesis: 'okay chat we are going in',
      errorRate: 0,
      detectedLang: 'en',
    });
    const times = report.rows[0]?.requestMs ?? [];
    expect(times).toHaveLength(2);
    expect(report.rows[0]?.ms).toBe(times[0]! + times[1]!);
    expect(report.byLang['en']?.p50Ms).toBeDefined();
  });

  it('takes the language of the first chunk that has speech', async () => {
    const chunkReplies = ['en\t\n', 'ko\t안녕\n', 'ko\t하세요\n'];
    const report = await runAsrBench({
      ...base,
      samples: [sample('a', 'ko', '안녕 하세요')],
      loadWav: () => wavOf(60_000),
      chunkMs: 1500,
      fetch: async () => chatReply(chunkReplies.shift() ?? 'en\t\n'),
    });
    expect(report.rows[0]).toMatchObject({
      detectedLang: 'ko',
      hypothesis: '안녕 하세요',
      langOk: true,
    });
  });

  it('runs the samples in order n times with repeat', async () => {
    const order: string[] = [];
    const report = await runAsrBench({
      ...base,
      samples: [sample('a', 'en', 'one'), sample('b', 'en', 'two')],
      loadWav: (id) => wavOf(id === 'a' ? 16_000 : 32_000),
      repeat: 2,
      fetch: async (_url, init) => {
        order.push(audioSamples(bodyOf(init)) === 16_000 ? 'a' : 'b');
        return chatReply('en\tone\n');
      },
    });
    expect(order).toEqual(['a', 'b', 'a', 'b']);
    expect(report.rows.map((row) => `${row.id}${row.pass}`)).toEqual(['a1', 'b1', 'a2', 'b2']);
  });

  it('keeps going after a failure and counts a failed row as a language miss', async () => {
    const replies = [chatReply('en\thello\n'), new Response('', { status: 500 })];
    const report = await runAsrBench({
      ...base,
      samples: [sample('a', 'en', 'hello'), sample('b', 'en', 'hello')],
      loadWav: () => wavOf(16_000),
      fetch: async () => replies.shift() ?? new Response('', { status: 500 }),
    });
    expect(report.byLang['en']).toMatchObject({ failed: 1, langAccuracy: 0.5, errorRate: 0 });
  });

  it('counts a missing WAV as a dataset gap, not an engine failure or a language miss', async () => {
    const report = await runAsrBench({
      ...base,
      samples: [sample('a', 'en', 'hello'), sample('b', 'en', 'hello')],
      loadWav: (id) => (id === 'a' ? wavOf(16_000) : undefined),
      fetch: async () => chatReply('en\thello\n'),
    });
    expect(report.byLang['en']).toMatchObject({ missing: 1, failed: 0, langAccuracy: 1 });
    expect(report.rows.find((row) => row.id === 'b')).toMatchObject({ missing: true });
    expect(report.rows.find((row) => row.id === 'b')?.error).toBeUndefined();
  });

  it('fails with a dataset error when every WAV is missing', async () => {
    let calls = 0;
    await expect(
      runAsrBench({
        ...base,
        samples: [sample('a', 'en', 'hello')],
        loadWav: () => undefined,
        fetch: async () => {
          calls += 1;
          return chatReply('en\thello\n');
        },
      }),
    ).rejects.toThrow(/no WAV file found for any of 1 samples/);
    expect(calls).toBe(0);
  });

  it('fails instead of reporting zeros when no sample could be transcribed', async () => {
    await expect(
      runAsrBench({
        ...base,
        samples: [sample('a', 'en', 'hello')],
        loadWav: () => wavOf(16_000),
        fetch: async () => {
          throw new TypeError('fetch failed');
        },
      }),
    ).rejects.toThrow(/every sample failed.*network_failed/);
  });
});

describe('parseVoices', () => {
  it('reads voice names from say listing, including accents', () => {
    const listing =
      'Mónica              es_ES    # ¡Hola!\nSamantha            en_US    # Hello!\nGrandma (English (US)) en_US    # Hi\n';
    expect(parseVoices(listing)).toEqual(new Set(['Mónica', 'Samantha', 'Grandma (English (US))']));
  });
});
