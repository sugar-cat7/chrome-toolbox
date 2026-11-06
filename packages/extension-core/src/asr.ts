import { Ok, type Result } from '@chrome-toolbox/contracts';
import type { LlamaClient } from './llm.ts';
import {
  asrMaxTokens,
  asrPrompt,
  parseAsrLine,
  type AsrLine,
  type GlossaryEntry,
} from './prompts.ts';

/** The sample rate of the PCM a transcription takes. */
export const ASR_SAMPLE_RATE = 16000;
/** The timeout of the client a transcription goes through: a late clip is dropped. */
export const ASR_TIMEOUT_MS = 8_000;
const HEADER_BYTES = 44;
/** A multiple of 3, so that the base64 of each chunk joins the next without padding. */
const BASE64_CHUNK = 8190;

/** PCM16 mono as a WAV file: a 44-byte RIFF header and the samples, little-endian. */
export function encodeWav(pcm: Int16Array, sampleRate: 16000): Uint8Array {
  const bytes = 2 * pcm.length;
  const wav = new Uint8Array(HEADER_BYTES + bytes);
  const view = new DataView(wav.buffer);
  const tag = (at: number, value: string): void => {
    for (let i = 0; i < 4; i += 1) view.setUint8(at + i, value.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + bytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, 2 * sampleRate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, bytes, true);
  pcm.forEach((sample, i) => view.setInt16(HEADER_BYTES + 2 * i, sample, true));
  return wav;
}

/** Plain base64 of a file, `btoa` of one chunk at a time: no string as long as the file. */
export function wavBase64(wav: Uint8Array): string {
  let encoded = '';
  for (let at = 0; at < wav.length; at += BASE64_CHUNK)
    encoded += btoa(String.fromCharCode(...wav.subarray(at, at + BASE64_CHUNK)));
  return encoded;
}

export type AsrClient = {
  /**
   * Transcribes 16 kHz mono PCM on slot 0 (the subtitle slot, shared with translation). `ms`
   * runs from the request to the end of the reply. `audio_unsupported` means the server has no
   * audio projector.
   */
  transcribe(
    this: void,
    pcm: Int16Array,
    options: {
      sourceLang: string;
      context: string;
      glossary: readonly GlossaryEntry[];
      signal?: AbortSignal;
    },
  ): Promise<Result<AsrLine & { ms: number }>>;
};

/** `client` is made with `timeoutMs: ASR_TIMEOUT_MS`: a clip that cannot be read in time is dropped. */
export function createAsrClient({
  client,
  model,
}: {
  client: LlamaClient;
  model: () => string;
}): AsrClient {
  async function transcribe(
    pcm: Int16Array,
    options: {
      sourceLang: string;
      context: string;
      glossary: readonly GlossaryEntry[];
      signal?: AbortSignal;
    },
  ): Promise<Result<AsrLine & { ms: number }>> {
    const durationMs = (pcm.length / ASR_SAMPLE_RATE) * 1000;
    const { messages, grammar } = asrPrompt({
      wavBase64: wavBase64(encodeWav(pcm, ASR_SAMPLE_RATE)),
      durationMs,
      sourceLang: options.sourceLang,
      context: options.context,
      glossary: options.glossary,
    });
    const maxTokens = asrMaxTokens(durationMs);
    const started = performance.now();
    const reply = await client.chat({
      messages,
      model: model(),
      slot: 0,
      temperature: 0,
      cachePrompt: true,
      grammar,
      maxTokens,
      templateKwargs: { enable_thinking: false },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const ms = performance.now() - started;
    if (!reply.ok) return reply;
    const line = parseAsrLine(reply.value, maxTokens, durationMs);
    return line.ok ? Ok({ ...line.value, ms }) : line;
  }
  return { transcribe };
}
