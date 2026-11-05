import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadAudioSamples, type AudioSample } from './datasets.ts';
import { postJson } from './http.ts';
import { errorRate, percentile } from './metrics.ts';
import { benchMeta, writeResults } from './results.ts';

export type AsrEngine = 'whisper' | 'llama';
export type AsrResult = { text: string; lang?: string; ms: number };
export type AsrRow = {
  id: string;
  lang: AudioSample['lang'];
  reference: string;
  hypothesis?: string;
  detectedLang?: string;
  errorRate?: number;
  langOk?: boolean;
  ms: number;
  error?: string;
  /** The sample's WAV file does not exist: a dataset gap, not an engine failure. */
  missing?: true;
};
export type AsrLangStats = {
  failed: number;
  /** Samples skipped because their WAV is missing; excluded from every other column. */
  missing: number;
  errorRate?: number | undefined;
  langAccuracy?: number | undefined;
  p50Ms?: number | undefined;
  p95Ms?: number | undefined;
};
export type AsrReport = { rows: AsrRow[]; byLang: Record<string, AsrLangStats> };

const asrSchema = {
  type: 'object',
  properties: { text: { type: 'string' }, lang: { type: 'string' } },
  required: ['text', 'lang'],
  additionalProperties: false,
};
const llamaInstruction =
  'Transcribe the speech in this audio verbatim in its original language (do not translate) and detect its language. Reply with JSON only: {"text": "<transcript>", "lang": "<ISO 639-1 code such as en, id, ko, es, zh>"}.';
// whisper.cpp's verbose_json may report a full language name instead of a code.
const languageNames: Record<string, string> = {
  english: 'en',
  indonesian: 'id',
  korean: 'ko',
  spanish: 'es',
  chinese: 'zh',
  japanese: 'ja',
};

/** `zh-CN` / `ZH` / `chinese` all become `zh`. */
function languageCode(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return languageNames[lower] ?? lower.split(/[-_]/u)[0] ?? lower;
}

export async function transcribe(
  engine: AsrEngine,
  server: string,
  wav: Uint8Array,
  options: { model?: string; fetch?: typeof fetch },
): Promise<AsrResult> {
  const fetchImpl = options.fetch ?? fetch;
  const base = server.replace(/\/+$/u, '');
  const started = performance.now();
  if (engine === 'whisper') {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
    form.append('response_format', 'verbose_json');
    form.append('language', 'auto');
    const body = (await postJson(fetchImpl, `${base}/inference`, {
      method: 'POST',
      body: form,
    })) as { text?: unknown; language?: unknown } | null;
    if (typeof body?.text !== 'string') throw new Error('whisper response is missing text');
    return {
      text: body.text.trim(),
      ...(typeof body.language === 'string' ? { lang: languageCode(body.language) } : {}),
      ms: performance.now() - started,
    };
  }
  const body = (await postJson(fetchImpl, `${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(options.model === undefined ? {} : { model: options.model }),
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' },
            },
            { type: 'text', text: llamaInstruction },
          ],
        },
      ],
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: { name: 'output', schema: asrSchema } },
    }),
  })) as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = body?.choices?.[0]?.message?.content;
  let parsed: { text?: unknown; lang?: unknown } | null = null;
  try {
    parsed = typeof content === 'string' ? JSON.parse(content) : null;
  } catch {
    // handled below
  }
  if (typeof parsed?.text !== 'string') throw new Error('llama response is invalid: no text');
  return {
    text: parsed.text.trim(),
    ...(typeof parsed.lang === 'string' ? { lang: languageCode(parsed.lang) } : {}),
    ms: performance.now() - started,
  };
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

export async function runAsrBench(options: {
  engine: AsrEngine;
  server: string;
  samples: AudioSample[];
  /** `undefined` when the sample's WAV does not exist. */
  loadWav: (id: string) => Uint8Array | undefined;
  model?: string;
  fetch?: typeof fetch;
}): Promise<AsrReport> {
  const rows: AsrRow[] = [];
  // Sequential on purpose: concurrent requests would pollute the latency measurement.
  for (const sample of options.samples) {
    const row: AsrRow = { id: sample.id, lang: sample.lang, reference: sample.transcript, ms: 0 };
    const wav = options.loadWav(sample.id);
    if (wav === undefined) {
      row.missing = true;
      rows.push(row);
      continue;
    }
    try {
      const result = await transcribe(options.engine, options.server, wav, {
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      row.ms = result.ms;
      row.hypothesis = result.text;
      row.errorRate = errorRate(
        sample.transcript,
        result.text,
        sample.lang === 'zh' ? 'char' : 'word',
      );
      if (result.lang !== undefined) row.detectedLang = result.lang;
      if (sample.lang !== 'mixed') row.langOk = result.lang === sample.lang;
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
      if (sample.lang !== 'mixed') row.langOk = false;
    }
    rows.push(row);
  }
  const attempted = rows.filter((row) => row.missing === undefined);
  if (rows.length > 0 && attempted.length === 0)
    throw new Error(
      `no WAV file found for any of ${rows.length} samples (run pnpm run bench:make-audio or check --set)`,
    );
  const ok = attempted.filter((row) => row.error === undefined);
  if (attempted.length > 0 && ok.length === 0)
    throw new Error(`every sample failed; first error: ${attempted[0]?.error ?? 'unknown'}`);
  const byLang: Record<string, AsrLangStats> = {};
  for (const lang of new Set(rows.map((row) => row.lang))) {
    const all = rows.filter((row) => row.lang === lang);
    const group = all.filter((row) => row.missing === undefined);
    const rates = group.flatMap((row) => (row.errorRate === undefined ? [] : [row.errorRate]));
    const latencies = group.filter((row) => row.error === undefined).map((row) => row.ms);
    // A failed sample counts as a language miss; mixed samples are never judged.
    const judged = group.flatMap((row) => (row.langOk === undefined ? [] : [row.langOk]));
    byLang[lang] = {
      failed: group.filter((row) => row.error !== undefined).length,
      missing: all.length - group.length,
      errorRate: rates.length === 0 ? undefined : mean(rates),
      langAccuracy: judged.length === 0 ? undefined : judged.filter(Boolean).length / judged.length,
      p50Ms: percentile(latencies, 50),
      p95Ms: percentile(latencies, 95),
    };
  }
  return { rows, byLang };
}

function summary(report: AsrReport): string {
  const fixed = (value: number | undefined, digits: number): string =>
    value === undefined ? '-' : value.toFixed(digits);
  const failed = report.rows.filter((row) => row.error !== undefined).length;
  const missing = report.rows.filter((row) => row.missing).length;
  return [
    '| lang | missing wav | failed | error rate | lang accuracy | p50 ms | p95 ms |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...Object.entries(report.byLang).map(
      ([lang, s]) =>
        `| ${lang} | ${s.missing} | ${s.failed} | ${fixed(s.errorRate, 3)} | ${fixed(s.langAccuracy, 2)} | ${fixed(s.p50Ms, 0)} | ${fixed(s.p95Ms, 0)} |`,
    ),
    '',
    `failed samples: ${failed}/${report.rows.length - missing} (missing wav: ${missing})`,
  ].join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== '--'),
    options: {
      engine: { type: 'string' },
      server: { type: 'string' },
      model: { type: 'string' },
      set: { type: 'string', default: 'bench-data/audio' },
      manifest: { type: 'string', default: 'tools/bench/fixtures/audio.jsonl' },
      out: { type: 'string' },
    },
  });
  if (values.engine !== 'whisper' && values.engine !== 'llama')
    throw new Error('--engine whisper|llama is required');
  if (values.server === undefined) throw new Error('--server <url> is required');
  const report = await runAsrBench({
    engine: values.engine,
    server: values.server,
    samples: loadAudioSamples(values.manifest),
    loadWav: (id) => {
      const file = path.join(values.set, `${id}.wav`);
      return existsSync(file) ? readFileSync(file) : undefined;
    },
    ...(values.model === undefined ? {} : { model: values.model }),
  });
  const out =
    values.out ??
    `bench-data/results/asr-${values.engine}-${(values.model ?? 'default').replace(/[^\w.-]+/gu, '_')}-${new Date().toISOString().replace(/[:.]/gu, '-')}.jsonl`;
  const meta = await benchMeta({
    bench: 'asr',
    server: values.server,
    model: values.model,
    settings: {
      engine: values.engine,
      set: values.set,
      manifest: values.manifest,
      // Only the llama engine takes a temperature; whisper.cpp runs with its server defaults.
      temperature: values.engine === 'llama' ? 0 : null,
    },
  });
  writeResults(out, meta, report.rows);
  for (const row of report.rows)
    console.log(
      `${row.id}\t${row.ms.toFixed(0)}ms\t${row.errorRate?.toFixed(3) ?? '-'}\t${row.detectedLang ?? '-'}\t${row.missing ? 'missing wav' : (row.hypothesis ?? row.error ?? '')}`,
    );
  console.log(summary(report));
  console.log(`wrote ${out}`);
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
