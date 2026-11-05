import { parseArgs } from 'node:util';
import {
  commentBatchMaxTokens,
  commentBatchPrompt,
  createLlamaClient,
  cutByMaxTokens,
  parseCommentBatch,
  subtitleOutputSchema,
  subtitlePrompt,
  type ChatTiming,
  type LlamaClient,
} from '@chrome-toolbox/extension-core';
import { loadTextSamples, type TextSample } from './datasets.ts';
import { GENERATION } from './generation.ts';
import { percentile } from './metrics.ts';
import { benchMeta, writeResults } from './results.ts';

export type TranslationRow = {
  id: string;
  lang: TextSample['lang'];
  kind: TextSample['kind'];
  output?: string;
  /** Wall time of the request that produced the row; a chat row waits for its whole batch. */
  ms: number;
  /** llama-server timings of that request. */
  timing?: ChatTiming;
  /** Comments sent in the same request (chat rows only). */
  batchSize?: number;
  error?: string;
  score?: 1 | 2 | 3 | 4 | 5;
  /** The judge failed; the translation itself is kept. */
  judgeError?: string;
};
export type TranslationStats = {
  attempts: number;
  successes: number;
  /** Successful rows only. */
  p50Ms?: number | undefined;
  p95Ms?: number | undefined;
  /** Every attempt; a failed row counts at its elapsed time. */
  p95AllMs?: number | undefined;
  maxAllMs?: number | undefined;
  /** Rows with a judge score, out of `attempts`. */
  scored: number;
  meanScore?: number | undefined;
};
export type TranslationReport = {
  rows: TranslationRow[];
  overall: TranslationStats;
  /** Keyed by `<lang>/<kind>`. */
  groups: Record<string, TranslationStats>;
  failures: Record<string, number>;
  judgeFailures: Record<string, number>;
};

type Outcome =
  | { ok: true; output: string; timing: ChatTiming | undefined }
  | { ok: false; code: string };
type Common = { slot?: number; model?: string };

const judgeSchema = {
  type: 'object',
  properties: { score: { type: 'integer', minimum: 1, maximum: 5 } },
  required: ['score'],
  additionalProperties: false,
};
const CONTEXT_LINES = 3;
const pinned = {
  temperature: GENERATION.temperature,
  templateKwargs: GENERATION.templateKwargs,
};

async function translateSpeech(
  client: LlamaClient,
  sample: TextSample,
  previous: readonly string[],
  common: Common,
): Promise<Outcome> {
  const prompt = subtitlePrompt({
    source: sample.text,
    sourceLang: sample.lang,
    previous,
    glossary: [],
    withEnglish: false,
  });
  const result = await client.chatJson(
    { ...prompt, ...common, ...pinned, maxTokens: GENERATION.maxTokens.subtitle },
    subtitleOutputSchema,
  );
  return result.ok
    ? { ok: true, output: result.value.value.ja, timing: result.value.timing }
    : { ok: false, code: result.error.internalCode };
}

/** One request for the whole batch; every sample is non-Japanese, so every one is translated. */
async function translateChat(
  client: LlamaClient,
  batch: readonly TextSample[],
  common: Common,
): Promise<Outcome[]> {
  const comments = batch.map((s) => ({ text: s.text, lang: s.lang, translate: true }));
  const prompt = commentBatchPrompt({ comments, context: '' });
  const maxTokens = commentBatchMaxTokens(comments);
  const result = await client.chat({ ...prompt, ...common, ...pinned, maxTokens });
  if (!result.ok) return batch.map(() => ({ ok: false, code: result.error.internalCode }));
  const items = parseCommentBatch(result.value.text, comments, {
    cut: cutByMaxTokens(result.value, maxTokens),
  });
  return items.map((item) =>
    item?.ja === undefined
      ? { ok: false, code: 'response_invalid' }
      : { ok: true, output: item.ja, timing: result.value.timing },
  );
}

async function judgeScore(
  judge: LlamaClient,
  row: TranslationRow,
  source: string,
  output: string,
): Promise<{ ok: true; score: 1 | 2 | 3 | 4 | 5 } | { ok: false; code: string }> {
  const reply = await judge.chat({
    messages: [
      {
        role: 'system',
        content:
          'You grade translations into Japanese. Score 1 (unusable) to 5 (accurate and natural) for meaning, fluency and tone. Reply with JSON only: {"score":N}.',
      },
      {
        role: 'user',
        content: `Source (${row.lang}):\n${source}\n\nTranslation:\n${output}`,
      },
    ],
    jsonSchema: judgeSchema,
    ...pinned,
    maxTokens: GENERATION.maxTokens.judge,
  });
  if (!reply.ok) return { ok: false, code: reply.error.internalCode };
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.value.text);
  } catch {
    return { ok: false, code: 'response_invalid' };
  }
  const score = (parsed as { score?: unknown } | null)?.score;
  return score === 1 || score === 2 || score === 3 || score === 4 || score === 5
    ? { ok: true, score }
    : { ok: false, code: 'response_invalid' };
}

function stats(rows: readonly TranslationRow[]): TranslationStats {
  const succeeded = rows.flatMap((row) => (row.output === undefined ? [] : [row.ms]));
  const all = rows.map((row) => row.ms);
  const scores = rows.flatMap((row) => (row.score === undefined ? [] : [row.score]));
  return {
    attempts: rows.length,
    successes: succeeded.length,
    p50Ms: percentile(succeeded, 50),
    p95Ms: percentile(succeeded, 95),
    p95AllMs: percentile(all, 95),
    maxAllMs: all.length === 0 ? undefined : Math.max(...all),
    scored: scores.length,
    meanScore:
      scores.length === 0 ? undefined : scores.reduce((sum, s) => sum + s, 0) / scores.length,
  };
}

export async function runTranslationBench(options: {
  client: LlamaClient;
  samples: TextSample[];
  slot?: number;
  model?: string;
  judge?: LlamaClient;
  /** Chat samples per comment-batch request (default 1). */
  chatBatch?: number;
  /** Injected so tests can control elapsed time. */
  now?: () => number;
}): Promise<TranslationReport> {
  const { client, samples, slot, model, judge, chatBatch = 1 } = options;
  const now = options.now ?? ((): number => performance.now());
  const health = await client.health();
  if (!health.ok) throw new Error(`llama-server is not ready: ${health.error.internalCode}`);
  if (judge) {
    const judgeHealth = await judge.health();
    if (!judgeHealth.ok)
      throw new Error(`judge server is not ready: ${judgeHealth.error.internalCode}`);
  }
  const common: Common = {
    ...(slot === undefined ? {} : { slot }),
    ...(model === undefined ? {} : { model }),
  };
  const rows: TranslationRow[] = [];
  const failures: Record<string, number> = {};
  const judgeFailures: Record<string, number> = {};
  const count = (table: Record<string, number>, code: string): void => {
    table[code] = (table[code] ?? 0) + 1;
  };

  const record = async (
    sample: TextSample,
    result: Outcome,
    ms: number,
    batchSize?: number,
  ): Promise<void> => {
    const row: TranslationRow = { id: sample.id, lang: sample.lang, kind: sample.kind, ms };
    if (batchSize !== undefined) row.batchSize = batchSize;
    if (!result.ok) {
      count(failures, result.code);
      row.error = result.code;
    } else {
      row.output = result.output;
      if (result.timing !== undefined) row.timing = result.timing;
      if (judge) {
        const graded = await judgeScore(judge, row, sample.text, result.output);
        if (graded.ok) row.score = graded.score;
        else {
          count(judgeFailures, graded.code);
          row.judgeError = graded.code;
        }
      }
    }
    rows.push(row);
  };

  let pending: TextSample[] = [];
  const flushChat = async (): Promise<void> => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    const started = now();
    const results = await translateChat(client, batch, common);
    const ms = now() - started;
    for (const [i, sample] of batch.entries())
      await record(sample, results[i] ?? { ok: false, code: 'response_invalid' }, ms, batch.length);
  };

  // The real extension keeps the previous lines of the current stream, so the context
  // restarts whenever the language or the source file changes.
  let history: string[] = [];
  let historyKey: string | undefined;
  // Sequential on purpose: concurrent requests would pollute the latency measurement.
  for (const sample of samples) {
    if (sample.kind === 'chat') {
      pending.push(sample);
      if (pending.length >= chatBatch) await flushChat();
      continue;
    }
    await flushChat();
    const key = `${sample.file ?? ''}\u0000${sample.lang}`;
    if (key !== historyKey) {
      history = [];
      historyKey = key;
    }
    const started = now();
    const result = await translateSpeech(client, sample, history.slice(-CONTEXT_LINES), common);
    const ms = now() - started;
    history.push(sample.text);
    await record(sample, result, ms);
  }
  await flushChat();

  const groups: Record<string, TranslationStats> = {};
  for (const key of new Set(rows.map((row) => `${row.lang}/${row.kind}`)))
    groups[key] = stats(rows.filter((row) => `${row.lang}/${row.kind}` === key));
  return { rows, overall: stats(rows), groups, failures, judgeFailures };
}

/** Parses a CLI integer; `''`, `' '`, `1.5` and `-1` are rejected instead of becoming 0 or NaN. */
export function parseIntegerOption(value: string, name: string, min: number): number {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed) || Number(trimmed) < min)
    throw new Error(`${name} must be an integer >= ${min}`);
  return Number(trimmed);
}

function summary(report: TranslationReport): string {
  const fixed = (value: number | undefined, digits: number): string =>
    value === undefined ? '-' : value.toFixed(digits);
  const line = (label: string, s: TranslationStats): string =>
    `| ${label} | ${s.attempts} | ${s.successes} | ${fixed(s.p50Ms, 0)} | ${fixed(s.p95Ms, 0)} | ${fixed(s.p95AllMs, 0)} | ${fixed(s.maxAllMs, 0)} | ${fixed(s.meanScore, 2)} (${s.scored}/${s.attempts}) |`;
  const codes = (table: Record<string, number>): string =>
    Object.entries(table)
      .map(([code, n]) => `${code}=${n}`)
      .join(', ') || 'none';
  return [
    '| lang/kind | attempts | ok | p50 ms (ok) | p95 ms (ok) | p95 ms (all) | max ms (all) | mean score (scored/total) |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...Object.entries(report.groups).map(([key, s]) => line(key, s)),
    line('all', report.overall),
    '',
    `translation failures: ${codes(report.failures)}`,
    `judge failures: ${codes(report.judgeFailures)}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== '--'),
    options: {
      server: { type: 'string' },
      model: { type: 'string' },
      set: { type: 'string', default: 'tools/bench/fixtures/text' },
      slot: { type: 'string' },
      'chat-batch': { type: 'string', default: '1' },
      'judge-server': { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (values.server === undefined) throw new Error('--server <url> is required');
  const client = createLlamaClient({ baseUrl: values.server, fetch, timeoutMs: 120_000 });
  const judgeServer = values['judge-server'];
  const judge =
    judgeServer === undefined
      ? undefined
      : createLlamaClient({ baseUrl: judgeServer, fetch, timeoutMs: 120_000 });
  const slot = values.slot === undefined ? undefined : parseIntegerOption(values.slot, '--slot', 0);
  const chatBatch = parseIntegerOption(values['chat-batch'], '--chat-batch', 1);
  const report = await runTranslationBench({
    client,
    samples: loadTextSamples(values.set),
    chatBatch,
    ...(slot === undefined ? {} : { slot }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(judge === undefined ? {} : { judge }),
  });
  const out =
    values.out ??
    `bench-data/results/translate-${(values.model ?? 'default').replace(/[^\w.-]+/gu, '_')}-${new Date().toISOString().replace(/[:.]/gu, '-')}.jsonl`;
  const meta = await benchMeta({
    bench: 'translate',
    server: values.server,
    model: values.model,
    settings: {
      ...GENERATION,
      contextLines: CONTEXT_LINES,
      chatBatch,
      slot: slot ?? null,
      set: values.set,
      judgeServer: judgeServer ?? null,
    },
  });
  writeResults(out, meta, report.rows);
  for (const row of report.rows)
    console.log(
      `${row.id}\t${row.ms.toFixed(0)}ms\t${row.score ?? '-'}\t${row.output ?? row.error ?? ''}${row.judgeError === undefined ? '' : `\t(judge: ${row.judgeError})`}`,
    );
  console.log(summary(report));
  console.log(`wrote ${out}`);
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
