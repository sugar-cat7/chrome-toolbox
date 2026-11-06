import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  asrReply,
  defaultResponder,
  startLlamaStub,
  STUB_TRANSCRIPT,
  withoutAudio,
  type LlamaStub,
} from '../testing/llama-stub.ts';
import { asrMaxTokens, asrPrompt } from './prompts.ts';
import { createAsrClient, encodeWav, wavBase64 } from './asr.ts';
import { createLlamaClient, type Fetch } from './llm.ts';

const text = (view: DataView, at: number): string =>
  String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)));

describe('encodeWav', () => {
  it('encodes a RIFF/WAVE header with the PCM byte length', () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768]);
    const wav = encodeWav(pcm, 16000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(wav.byteLength).toBe(44 + 2 * pcm.length);
    expect([text(view, 0), text(view, 8), text(view, 12), text(view, 36)]).toEqual([
      'RIFF',
      'WAVE',
      'fmt ',
      'data',
    ]);
    expect(view.getUint32(4, true)).toBe(36 + 2 * pcm.length);
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(2 * pcm.length);
    expect([...Array(pcm.length).keys()].map((i) => view.getInt16(44 + 2 * i, true))).toEqual([
      ...pcm,
    ]);
  });
});

describe('wavBase64', () => {
  it('equals one btoa of the whole file, also across the chunk size', () => {
    const wav = Uint8Array.from({ length: 20_000 }, (_, i) => (i * 31) % 256);
    expect(wavBase64(wav)).toBe(btoa(String.fromCharCode(...wav)));
    expect(wavBase64(new Uint8Array(0))).toBe('');
    expect(wavBase64(Uint8Array.from([1, 2, 3, 4]))).toBe('AQIDBA==');
  });
});

describe('createAsrClient', () => {
  let stub: LlamaStub;
  const options = { sourceLang: 'auto', context: 'Fixture Quest', glossary: [] };
  const pcm = new Int16Array(24_000);
  beforeEach(async () => {
    stub = await startLlamaStub();
  });
  afterEach(async () => {
    await stub.stop();
  });
  const clientOf = (fetch: Fetch = (input, init) => globalThis.fetch(input, init)) =>
    createAsrClient({
      client: createLlamaClient({ baseUrl: stub.origin, fetch, timeoutMs: 8_000 }),
      model: () => 'fixture-model',
    });

  it('sends model, id_slot 0, the grammar and the wav as input_audio', async () => {
    let body: Record<string, unknown> = {};
    const asr = clientOf(async (input, init) => {
      body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as typeof body;
      return globalThis.fetch(input, init);
    });
    const result = await asr.transcribe(pcm, options);
    const prompt = asrPrompt({
      wavBase64: wavBase64(encodeWav(pcm, 16000)),
      durationMs: 1500,
      ...options,
    });
    expect(body).toMatchObject({
      model: 'fixture-model',
      id_slot: 0,
      temperature: 0,
      cache_prompt: true,
      grammar: prompt.grammar,
      max_tokens: asrMaxTokens(1500),
      chat_template_kwargs: { enable_thinking: false },
      messages: prompt.messages,
    });
    expect(result.ok && result.value).toMatchObject({
      lang: 'en',
      text: `${STUB_TRANSCRIPT} 1.`,
    });
    expect(result.ok && result.value.ms).toBeGreaterThanOrEqual(0);
    expect(asrReply(1)).toBe(`en\t${STUB_TRANSCRIPT} 1.\n`);
  });

  it('returns audio_unsupported when the server has no projector', async () => {
    stub.respond = withoutAudio(defaultResponder);
    const result = await clientOf().transcribe(pcm, options);
    expect(result.ok ? 'ok' : result.error.internalCode).toBe('audio_unsupported');
  });

  it('fails with response_invalid when the transcript fills its bound', async () => {
    stub.respond = () => ({
      body: {
        choices: [{ message: { content: `en\t${'ha'.repeat(38)}\n` }, finish_reason: 'stop' }],
      },
    });
    const result = await clientOf().transcribe(pcm, options);
    expect(result.ok ? 'ok' : result.error.internalCode).toBe('response_invalid');
  });
});
