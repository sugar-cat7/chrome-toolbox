import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  commentBatchMaxTokens,
  commentBatchPrompt,
  createLlamaClient,
  createQueue,
  cutByMaxTokens,
  parseCommentBatch,
  subtitleOutputSchema,
  subtitlePrompt,
  type LlamaClient,
} from '@chrome-toolbox/extension-core';
import { loadTextSamples, type TextSample } from './datasets.ts';
import { GENERATION } from './generation.ts';
import { percentile } from './metrics.ts';

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
  /** Latency from the scheduled tick to the reply, successful ticks only. */
  p50Ms?: number;
  p95Ms?: number;
  /** p50 <= 2000 ms and p95 <= 3000 ms, with every expected tick sent and none failed. */
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
}): Stats {
  const p50Ms = percentile(phase.latencies, 50);
  const p95Ms = percentile(phase.latencies, 95);
  const commentP50Ms = percentile(phase.comments.latencies, 50);
  const commentP95Ms = percentile(phase.comments.latencies, 95);
  return {
    expected: phase.expected,
    sent: phase.sent,
    late: phase.late,
    count: phase.latencies.length,
    failed: phase.failed,
    ...(p50Ms === undefined ? {} : { p50Ms }),
    ...(p95Ms === undefined ? {} : { p95Ms }),
    pass:
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

  let comments = 0;
  const sendBatch = async (commentClient: LlamaClient, commentSlot: number): Promise<boolean> => {
    const batch = Array.from({ length: commentBatchSize }, (_, i) => {
      const sample = chat[(comments + i) % chat.length] as TextSample;
      return { text: sample.text, lang: sample.lang, translate: true };
    });
    comments += commentBatchSize;
    const prompt = commentBatchPrompt({ comments: batch, context: '' });
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
      const sample = speech[i % speech.length] as TextSample;
      const prompt = subtitlePrompt({
        source: sample.text,
        sourceLang: sample.lang,
        previous: [],
        glossary: [],
        withEnglish: false,
      });
      const result = await client.chatJson(
        {
          ...prompt,
          ...slot(SUBTITLE_SLOT),
          ...modelOption,
          ...pinned,
          maxTokens: GENERATION.maxTokens.subtitle,
        },
        subtitleOutputSchema,
      );
      previousEnd = now();
      if (result.ok) latencies.push(previousEnd - scheduled);
      else failed += 1;
    }
    running = false;
    await floods;
    if (withLoad && commentTotals.ok === 0)
      throw new Error(
        `loaded phase is invalid: no comment batch succeeded (${commentTotals.failed} failed), so subtitles were not measured under load`,
      );
    return stats({ expected, sent, late, latencies, failed, comments: commentTotals });
  };

  const idle = await measure(false);
  options.onPhase?.('idle', idle);
  const loaded = await measure(true);
  options.onPhase?.('loaded', loaded);
  return { idle, loaded };
}

const TABLE_HEADER = [
  '| case | sent/expected | late | ok | failed | p50 ms | p95 ms | target (p50<=2000, p95<=3000) | comment batches ok | comment batches failed | batch p50 ms | batch p95 ms |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
].join('\n');

function tableRow(label: string, s: Stats): string {
  const fixed = (value: number | undefined): string =>
    value === undefined ? '-' : value.toFixed(0);
  return `| ${label} | ${s.sent}/${s.expected} | ${s.late} | ${s.count} | ${s.failed} | ${fixed(s.p50Ms)} | ${fixed(s.p95Ms)} | ${s.pass ? 'PASS' : 'FAIL'} | ${s.commentOk} | ${s.commentFailed} | ${fixed(s.commentP50Ms)} | ${fixed(s.commentP95Ms)} |`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== '--'),
    options: {
      server: { type: 'string' },
      model: { type: 'string' },
      seconds: { type: 'string', default: '60' },
      'comment-streams': { type: 'string', default: '1' },
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
  console.log(
    `settings: ${JSON.stringify({ ...GENERATION, model, subtitleEveryMs: SUBTITLE_EVERY_MS, commentBatchSize: COMMENT_BATCH_SIZE, commentStreams, seconds })}`,
  );
  // Rows are printed as each phase ends, so a failed loaded phase keeps the idle row.
  console.log(TABLE_HEADER);
  for (const pinSlots of [true, false]) {
    const label = pinSlots ? 'pinned' : 'unpinned';
    await runSlotBench({
      client: make(),
      commentClients: Array.from({ length: commentStreams }, make),
      ...(model === undefined ? {} : { model }),
      seconds,
      subtitleEveryMs: SUBTITLE_EVERY_MS,
      commentBatchSize: COMMENT_BATCH_SIZE,
      pinSlots,
      onPhase: (phase, stats) => console.log(tableRow(`${phase}, ${label}`, stats)),
    });
  }
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
