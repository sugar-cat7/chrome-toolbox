import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  ASR_TIMEOUT_MS,
  commentBatchMaxTokens,
  commentBatchPrompt,
  createAsrClient,
  createLlamaClient,
  createQueue,
  cutByMaxTokens,
  parseCommentBatch,
  parseSubtitleLine,
  subtitleMaxTokens,
  subtitlePrompt,
  type LlamaClient,
} from '@chrome-toolbox/extension-core';
import { decodeWav } from './asr.ts';
import {
  loadAudioSamples,
  loadTextSamples,
  type AudioSample,
  type TextSample,
} from './datasets.ts';
import { BENCH_STREAM, GENERATION } from './generation.ts';
import { percentile } from './metrics.ts';
import { fromRoot } from './paths.ts';

export type Stats = {
  /** Subtitle ticks scheduled in the phase window. */
  expected: number;
  /** Ticks sent before the window closed; a backlog leaves the rest unsent. */
  sent: number;
  /** Ticks sent after their schedule because the previous subtitle was still in flight. */
  late: number;
  /** Subtitles that came back. */
  count: number;
  failed: number;
  /**
   * Latency from the scheduled tick to the translation, successful ticks only. With `--audio`
   * only ticks that were translated count (not silence or Japanese speech).
   */
  p50Ms?: number;
  p95Ms?: number;
  /** With `--audio`: latency from the scheduled tick to the transcript, ticks whose ASR answered. */
  sourceP50Ms?: number;
  sourceP95Ms?: number;
  /** With `--audio`: p50 of llama-server's `timings.prompt_ms` of the ASR and translation requests. */
  asrPromptP50Ms?: number;
  translatePromptP50Ms?: number;
  /**
   * p50 <= 2000 ms and p95 <= 3000 ms, with every expected tick sent and none failed; with
   * `--audio` also source p50 <= 1000 ms.
   */
  pass: boolean;
  /** Comment batches (all streams) that succeeded / failed in the phase (always 0 when idle). */
  commentOk: number;
  commentFailed: number;
  /** Wall time of each successful comment batch. */
  commentP50Ms?: number;
  commentP95Ms?: number;
};
export type SlotReport = { idle: Stats; loaded: Stats };
export type SlotBenchOptions = {
  /** Sends the subtitle requests. */
  client: LlamaClient;
  /**
   * One client (own queue) per comment stream; a shared queue would defeat the isolation under
   * test. Stream `i` pins its batches to slot `1 + i`, so the server needs one slot more than
   * there are streams (the comment extension runs one batch per spare slot, R39).
   */
  commentClients: readonly LlamaClient[];
  /** Model name; a llama.cpp router needs it on every request and on `/props`. */
  model?: string;
  seconds: number;
  subtitleEveryMs: number;
  commentBatchSize: number;
  pinSlots: boolean;
  samples?: TextSample[];
  /**
   * Measures speech recognition and translation together: each tick sends the next sample's audio
   * (manifest order, repeating) on slot 0, then translates a non-Japanese transcript on slot 0.
   * ASR always uses slot 0, so this is a pinned measurement.
   */
  audio?: {
    samples: readonly AudioSample[];
    /** `undefined` when the sample's WAV does not exist. */
    loadWav: (id: string) => Uint8Array | undefined;
    /** The ASR requests' client; defaults to `client`. */
    client?: LlamaClient;
  };
  /** Called as each phase ends, so the idle result survives a loaded-phase failure. */
  onPhase?: (phase: 'idle' | 'loaded', stats: Stats) => void;
  /** Injected so tests can drive the time loop without waiting. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const COMMENT_BACKOFF_MS = 250;
const SUBTITLE_EVERY_MS = 1500;
const COMMENT_BATCH_SIZE = 20;
const SUBTITLE_SLOT = 0;
const FIRST_COMMENT_SLOT = 1;
// Spec targets for the Japanese subtitle (global constraints).
const TARGET_P50_MS = 2000;
const TARGET_P95_MS = 3000;
const TARGET_SOURCE_P50_MS = 1000;
const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'text');
const pinned = { temperature: GENERATION.temperature, templateKwargs: GENERATION.templateKwargs };

/**
 * Throws a readable reason unless llama-server has a slot for subtitles and one per comment
 * stream (`--parallel` streams + 1).
 */
async function assertSlots(
  client: LlamaClient,
  model: string | undefined,
  streams: number,
): Promise<void> {
  const needed = streams + 1;
  const start = `start llama-server with --parallel ${needed} (docs/llama-server.md)`;
  const props = await client.props(model === undefined ? {} : { model });
  if (!props.ok)
    throw new Error(
      `could not read total_slots from GET /props (${props.error.internalCode}); ${start}`,
    );
  if (props.value.totalSlots < needed)
    throw new Error(
      `llama-server reports total_slots=${props.value.totalSlots}, but subtitles and ${streams} comment stream${streams === 1 ? '' : 's'} need ${needed}; ${start}`,
    );
}

function stats(phase: {
  expected: number;
  sent: number;
  late: number;
  latencies: readonly number[];
  failed: number;
  comments: { ok: number; failed: number; latencies: readonly number[] };
  /** Present with `--audio`. */
  audio?: {
    sourceLatencies: readonly number[];
    asrPromptMs: readonly number[];
    translatePromptMs: readonly number[];
  };
}): Stats {
  const p50Ms = percentile(phase.latencies, 50);
  const p95Ms = percentile(phase.latencies, 95);
  const commentP50Ms = percentile(phase.comments.latencies, 50);
  const commentP95Ms = percentile(phase.comments.latencies, 95);
  const sourceP50Ms = percentile(phase.audio?.sourceLatencies ?? [], 50);
  const sourceP95Ms = percentile(phase.audio?.sourceLatencies ?? [], 95);
  const asrPromptP50Ms = percentile(phase.audio?.asrPromptMs ?? [], 50);
  const translatePromptP50Ms = percentile(phase.audio?.translatePromptMs ?? [], 50);
  return {
    expected: phase.expected,
    sent: phase.sent,
    late: phase.late,
    count: phase.latencies.length,
    failed: phase.failed,
    ...(p50Ms === undefined ? {} : { p50Ms }),
    ...(p95Ms === undefined ? {} : { p95Ms }),
    ...(sourceP50Ms === undefined ? {} : { sourceP50Ms }),
    ...(sourceP95Ms === undefined ? {} : { sourceP95Ms }),
    ...(asrPromptP50Ms === undefined ? {} : { asrPromptP50Ms }),
    ...(translatePromptP50Ms === undefined ? {} : { translatePromptP50Ms }),
    pass:
      (phase.audio === undefined ||
        (sourceP50Ms !== undefined && sourceP50Ms <= TARGET_SOURCE_P50_MS)) &&
      p50Ms !== undefined &&
      p95Ms !== undefined &&
      p50Ms <= TARGET_P50_MS &&
      p95Ms <= TARGET_P95_MS &&
      phase.failed === 0 &&
      phase.sent === phase.expected,
    commentOk: phase.comments.ok,
    commentFailed: phase.comments.failed,
    ...(commentP50Ms === undefined ? {} : { commentP50Ms }),
    ...(commentP95Ms === undefined ? {} : { commentP95Ms }),
  };
}

export async function runSlotBench(options: SlotBenchOptions): Promise<SlotReport> {
  const { client, seconds, subtitleEveryMs, commentBatchSize, pinSlots } = options;
  const modelOption = options.model === undefined ? {} : { model: options.model };
  const { commentClients } = options;
  if (commentClients.length === 0) throw new Error('slot bench needs at least one comment stream');
  const now = options.now ?? ((): number => performance.now());
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const health = await client.health();
  if (!health.ok) throw new Error(`llama-server is not ready: ${health.error.internalCode}`);
  await assertSlots(client, options.model, commentClients.length);

  const samples = options.samples ?? loadTextSamples(FIXTURES);
  const speech = samples.filter((sample) => sample.kind === 'speech');
  const chat = samples.filter((sample) => sample.kind === 'chat');
  if (speech.length === 0 || chat.length === 0)
    throw new Error('slot bench needs both speech and chat samples');
  const slot = (id: number): { slot?: number } => (pinSlots ? { slot: id } : {});
  // Decoded once, in manifest order; a sample without a usable WAV is left out of the cycle.
  const clips = (options.audio?.samples ?? []).flatMap((sample) => {
    const wav = options.audio?.loadWav(sample.id);
    const pcm = wav === undefined ? undefined : decodeWav(wav);
    return pcm === undefined ? [] : [pcm];
  });
  if (options.audio !== undefined && clips.length === 0)
    throw new Error(
      `no WAV file found for any of ${options.audio.samples.length} samples, or none is 16 kHz mono 16-bit PCM (run pnpm --filter @chrome-toolbox/bench bench:make-audio or check --set)`,
    );

  let comments = 0;
  const sendBatch = async (commentClient: LlamaClient, commentSlot: number): Promise<boolean> => {
    const batch = Array.from({ length: commentBatchSize }, (_, i) => {
      const sample = chat[(comments + i) % chat.length] as TextSample;
      return { text: sample.text, lang: sample.lang, translate: true };
    });
    comments += commentBatchSize;
    const prompt = commentBatchPrompt({ comments: batch, context: '', ...BENCH_STREAM });
    const maxTokens = commentBatchMaxTokens(batch);
    const result = await commentClient.chat({
      ...prompt,
      ...slot(commentSlot),
      ...modelOption,
      ...pinned,
      maxTokens,
    });
    if (!result.ok) return false;
    // A batch succeeds when every comment got its line.
    const cut = cutByMaxTokens(result.value, maxTokens);
    return !parseCommentBatch(result.value.text, batch, { cut }).includes(undefined);
  };

  const measure = async (withLoad: boolean): Promise<Stats> => {
    const latencies: number[] = [];
    let failed = 0;
    let sent = 0;
    let late = 0;
    let running = true;
    const sourceLatencies: number[] = [];
    const asrPromptMs: number[] = [];
    const translatePromptMs: number[] = [];
    // The ASR client does not report timings, so its replies are read on their way through.
    const asrBase = options.audio?.client ?? client;
    const asr = createAsrClient({
      client: {
        ...asrBase,
        chat: async (request) => {
          const reply = await asrBase.chat(request);
          if (reply.ok && reply.value.timing !== undefined)
            asrPromptMs.push(reply.value.timing.promptMs);
          return reply;
        },
      },
      model: () => options.model ?? '',
    });
    const commentTotals = { ok: 0, failed: 0, latencies: [] as number[] };
    // Each stream sends its next batch as soon as the last one answered, on its own slot.
    const flood = async (commentClient: LlamaClient, commentSlot: number): Promise<void> => {
      while (running) {
        const begin = now();
        if (await sendBatch(commentClient, commentSlot)) {
          commentTotals.ok += 1;
          commentTotals.latencies.push(now() - begin);
        } else {
          commentTotals.failed += 1;
          await sleep(COMMENT_BACKOFF_MS);
        }
      }
    };
    const floods = withLoad
      ? Promise.all(commentClients.map((stream, i) => flood(stream, FIRST_COMMENT_SLOT + i)))
      : undefined;
    const windowMs = seconds * 1000;
    const expected = Math.ceil(windowMs / subtitleEveryMs);
    const started = now();
    let previousEnd = started;
    // Latency counts from the tick's schedule, not from when it was sent: a slow reply
    // delays the ticks behind it, and that wait is what a viewer sees (coordinated omission).
    for (let i = 0; i < expected && now() - started < windowMs; i += 1) {
      const scheduled = started + i * subtitleEveryMs;
      await sleep(Math.max(0, scheduled - now()));
      if (previousEnd > scheduled) late += 1;
      sent += 1;
      const translate = async (source: string, sourceLang: string): Promise<'ok' | 'failed'> => {
        const maxTokens = subtitleMaxTokens(source);
        const prompt = subtitlePrompt({
          source,
          sourceLang,
          previous: [],
          context: '',
          glossary: [],
        });
        const result = await client.chat({
          ...prompt,
          ...slot(SUBTITLE_SLOT),
          ...modelOption,
          ...pinned,
          maxTokens,
        });
        previousEnd = now();
        if (result.ok && result.value.timing !== undefined)
          translatePromptMs.push(result.value.timing.promptMs);
        const line = result.ok ? parseSubtitleLine(result.value, maxTokens, source) : result;
        if (!line.ok) return 'failed';
        latencies.push(previousEnd - scheduled);
        return 'ok';
      };
      if (options.audio === undefined) {
        const sample = speech[i % speech.length] as TextSample;
        if ((await translate(sample.text, sample.lang)) === 'failed') failed += 1;
        continue;
      }
      const transcript = await asr.transcribe(clips[i % clips.length] as Int16Array, {
        sourceLang: 'auto',
        context: '',
        glossary: [],
      });
      previousEnd = now();
      if (!transcript.ok) {
        failed += 1;
        continue;
      }
      sourceLatencies.push(previousEnd - scheduled);
      // Silence has nothing to translate, and Japanese speech is already the Japanese line.
      if (transcript.value.text === '' || transcript.value.lang === 'ja') continue;
      if ((await translate(transcript.value.text, transcript.value.lang)) === 'failed') failed += 1;
    }
    running = false;
    await floods;
    if (withLoad && commentTotals.ok === 0)
      throw new Error(
        `loaded phase is invalid: no comment batch succeeded (${commentTotals.failed} failed), so subtitles were not measured under load`,
      );
    return stats({
      expected,
      sent,
      late,
      latencies,
      failed,
      comments: commentTotals,
      ...(options.audio === undefined
        ? {}
        : { audio: { sourceLatencies, asrPromptMs, translatePromptMs } }),
    });
  };

  const idle = await measure(false);
  options.onPhase?.('idle', idle);
  const loaded = await measure(true);
  options.onPhase?.('loaded', loaded);
  return { idle, loaded };
}

const AUDIO_TABLE_HEADER = [
  '| case | sent/expected | late | ja ok | failed | source p50 ms | source p95 ms | ja p50 ms | ja p95 ms | target (source p50<=1000, ja p50<=2000, ja p95<=3000) | asr prompt p50 ms | translate prompt p50 ms | comment batches ok | comment batches failed | batch p50 ms | batch p95 ms |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
].join('\n');

const TABLE_HEADER = [
  '| case | sent/expected | late | ok | failed | p50 ms | p95 ms | target (p50<=2000, p95<=3000) | comment batches ok | comment batches failed | batch p50 ms | batch p95 ms |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
].join('\n');

function tableRow(label: string, s: Stats): string {
  const fixed = (value: number | undefined): string =>
    value === undefined ? '-' : value.toFixed(0);
  return `| ${label} | ${s.sent}/${s.expected} | ${s.late} | ${s.count} | ${s.failed} | ${fixed(s.p50Ms)} | ${fixed(s.p95Ms)} | ${s.pass ? 'PASS' : 'FAIL'} | ${s.commentOk} | ${s.commentFailed} | ${fixed(s.commentP50Ms)} | ${fixed(s.commentP95Ms)} |`;
}

function audioTableRow(label: string, s: Stats): string {
  const fixed = (value: number | undefined): string =>
    value === undefined ? '-' : value.toFixed(0);
  return `| ${label} | ${s.sent}/${s.expected} | ${s.late} | ${s.count} | ${s.failed} | ${fixed(s.sourceP50Ms)} | ${fixed(s.sourceP95Ms)} | ${fixed(s.p50Ms)} | ${fixed(s.p95Ms)} | ${s.pass ? 'PASS' : 'FAIL'} | ${fixed(s.asrPromptP50Ms)} | ${fixed(s.translatePromptP50Ms)} | ${s.commentOk} | ${s.commentFailed} | ${fixed(s.commentP50Ms)} | ${fixed(s.commentP95Ms)} |`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== '--'),
    options: {
      server: { type: 'string' },
      model: { type: 'string' },
      seconds: { type: 'string', default: '60' },
      'comment-streams': { type: 'string', default: '1' },
      audio: { type: 'boolean', default: false },
      set: { type: 'string', default: 'bench-data/audio' },
      manifest: { type: 'string', default: 'packages/bench/fixtures/audio.jsonl' },
    },
  });
  if (values.server === undefined) throw new Error('--server <url> is required');
  if (values.model !== undefined && values.model.trim() === '')
    throw new Error('--model must not be empty');
  const model = values.model?.trim();
  const seconds = Number(values.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--seconds must be positive');
  const commentStreams = Number(values['comment-streams']);
  if (!Number.isInteger(commentStreams) || commentStreams < 1)
    throw new Error('--comment-streams must be a positive integer');
  // One queue per client: the server, not a shared client queue, schedules the streams.
  const make = (): LlamaClient =>
    createLlamaClient({
      baseUrl: values.server as string,
      fetch,
      timeoutMs: 120_000,
      queue: createQueue({ concurrency: 1 }),
    });
  const audio = values.audio
    ? {
        samples: loadAudioSamples(fromRoot(values.manifest)),
        loadWav: (id: string): Uint8Array | undefined => {
          const file = path.join(fromRoot(values.set), `${id}.wav`);
          return existsSync(file) ? readFileSync(file) : undefined;
        },
      }
    : undefined;
  console.log(
    `settings: ${JSON.stringify({ ...GENERATION, model, subtitleEveryMs: SUBTITLE_EVERY_MS, commentBatchSize: COMMENT_BATCH_SIZE, commentStreams, seconds, audio: values.audio, ...(audio === undefined ? {} : { set: values.set, manifest: values.manifest }) })}`,
  );
  // Rows are printed as each phase ends, so a failed loaded phase keeps the idle row.
  console.log(audio === undefined ? TABLE_HEADER : AUDIO_TABLE_HEADER);
  // ASR always uses slot 0, so the audio measurement has no unpinned variant.
  for (const pinSlots of audio === undefined ? [true, false] : [true]) {
    const label = pinSlots ? 'pinned' : 'unpinned';
    await runSlotBench({
      client: make(),
      commentClients: Array.from({ length: commentStreams }, make),
      ...(model === undefined ? {} : { model }),
      seconds,
      subtitleEveryMs: SUBTITLE_EVERY_MS,
      commentBatchSize: COMMENT_BATCH_SIZE,
      pinSlots,
      ...(audio === undefined
        ? {}
        : {
            audio: {
              ...audio,
              client: createLlamaClient({
                baseUrl: values.server as string,
                fetch,
                timeoutMs: ASR_TIMEOUT_MS,
                queue: createQueue({ concurrency: 1 }),
              }),
            },
          }),
      onPhase: (phase, stats) =>
        console.log((audio === undefined ? tableRow : audioTableRow)(`${phase}, ${label}`, stats)),
    });
  }
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
