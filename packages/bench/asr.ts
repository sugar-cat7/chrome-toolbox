import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createAsrClient, createLlamaClient, type Fetch } from '@chrome-toolbox/extension-core';
import { loadAudioSamples, type AudioSample } from './datasets.ts';
import { errorRate, percentile } from './metrics.ts';
import { fromRoot } from './paths.ts';
import { benchMeta, writeResults } from './results.ts';

const SAMPLE_RATE = 16000;
/** The client's own timeout: a clip the extension would drop is a failure here too. */
const REQUEST_TIMEOUT_MS = 8_000;

export type AsrRow = {
  id: string;
  lang: AudioSample['lang'];
  reference: string;
  hypothesis?: string;
  detectedLang?: string;
  errorRate?: number;
  langOk?: boolean;
  /** The transcript is empty: the model heard no speech. */
  silent?: boolean;
  /** Sum of the row's request times. */
  ms: number;
  /** Time of each request of the row: one, or one per chunk with `chunkMs`. */
  chunkMs?: number[];
  error?: string;
  /** The sample's WAV file does not exist: a dataset gap, not an engine failure. */
  missing?: true;
};
export type AsrLangStats = {
  failed: number;
  /** Samples skipped because their WAV is missing; excluded from every other column. */
  missing: number;
  /** Rows whose transcript is empty. */
  silent: number;
  errorRate?: number | undefined;
  langAccuracy?: number | undefined;
  /** Over every request, so a chunked clip counts once per chunk. */
  p50Ms?: number | undefined;
  p95Ms?: number | undefined;
};
export type AsrReport = { rows: AsrRow[]; byLang: Record<string, AsrLangStats> };

/** The samples of a PCM16 mono WAV file, found by its `data` chunk; undefined if it has none. */
export function decodeWav(wav: Uint8Array): Int16Array | undefined {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number): string =>
    String.fromCharCode(...[0, 1, 2, 3].map((i) => view.getUint8(at + i)));
  if (wav.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined;
  let at = 12;
  while (at + 8 <= wav.length) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === 'data') {
      const count = Math.floor(Math.min(size, wav.length - at - 8) / 2);
      return Int16Array.from({ length: count }, (_, i) => view.getInt16(at + 8 + 2 * i, true));
    }
    at += 8 + size + (size % 2);
  }
  return undefined;
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

export async function runAsrBench(options: {
  server: string;
  model: string;
  samples: AudioSample[];
  /** `undefined` when the sample's WAV does not exist. */
  loadWav: (id: string) => Uint8Array | undefined;
  /** Runs the whole sample list this many times, in order (default 1). */
  repeat?: number;
  /** Sends each clip as pieces of at most this length, and scores the joined transcripts. */
  chunkMs?: number;
  fetch?: Fetch;
}): Promise<AsrReport> {
  const asr = createAsrClient({
    client: createLlamaClient({
      baseUrl: options.server,
      fetch: options.fetch ?? ((input, init) => fetch(input, init)),
      timeoutMs: REQUEST_TIMEOUT_MS,
    }),
    model: () => options.model,
  });
  const chunkSamples =
    options.chunkMs === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.floor((options.chunkMs * SAMPLE_RATE) / 1000));
  const rows: AsrRow[] = [];
  // Sequential on purpose: concurrent requests would pollute the latency measurement.
  for (let pass = 0; pass < (options.repeat ?? 1); pass += 1) {
    for (const sample of options.samples) {
      const row: AsrRow = { id: sample.id, lang: sample.lang, reference: sample.transcript, ms: 0 };
      const wav = options.loadWav(sample.id);
      if (wav === undefined) {
        // A dataset gap is reported once, not once per pass.
        if (pass === 0) {
          row.missing = true;
          rows.push(row);
        }
        continue;
      }
      const pcm = decodeWav(wav);
      if (pcm === undefined) {
        row.error = 'wav_invalid';
        if (sample.lang !== 'mixed') row.langOk = false;
        rows.push(row);
        continue;
      }
      const transcripts: string[] = [];
      const chunkMs: number[] = [];
      let silentSoFar = true;
      for (let at = 0; at < Math.max(pcm.length, 1); at += chunkSamples) {
        const result = await asr.transcribe(pcm.subarray(at, at + chunkSamples), {
          sourceLang: 'auto',
          context: '',
          glossary: [],
        });
        if (!result.ok) {
          row.error = result.error.internalCode;
          break;
        }
        chunkMs.push(result.value.ms);
        if (result.value.text !== '') transcripts.push(result.value.text);
        // The language of the first chunk that has speech; of the first chunk when all are silent.
        if (row.detectedLang === undefined || (silentSoFar && result.value.text !== ''))
          row.detectedLang = result.value.lang;
        silentSoFar &&= result.value.text === '';
      }
      row.chunkMs = chunkMs;
      row.ms = chunkMs.reduce((sum, value) => sum + value, 0);
      if (row.error === undefined) {
        row.hypothesis = transcripts.join(' ');
        row.silent = row.hypothesis === '';
        row.errorRate = errorRate(
          sample.transcript,
          row.hypothesis,
          sample.lang === 'zh' || sample.lang === 'ja' ? 'char' : 'word',
        );
      }
      if (sample.lang !== 'mixed')
        row.langOk = row.error === undefined && row.detectedLang === sample.lang;
      rows.push(row);
    }
  }
  const attempted = rows.filter((row) => row.missing === undefined);
  if (rows.length > 0 && attempted.length === 0)
    throw new Error(
      `no WAV file found for any of ${rows.length} samples (run pnpm --filter @chrome-toolbox/bench bench:make-audio or check --set)`,
    );
  const ok = attempted.filter((row) => row.error === undefined);
  if (attempted.length > 0 && ok.length === 0)
    throw new Error(`every sample failed; first error: ${attempted[0]?.error ?? 'unknown'}`);
  const byLang: Record<string, AsrLangStats> = {};
  for (const lang of new Set(rows.map((row) => row.lang))) {
    const all = rows.filter((row) => row.lang === lang);
    const group = all.filter((row) => row.missing === undefined);
    const rates = group.flatMap((row) => (row.errorRate === undefined ? [] : [row.errorRate]));
    const latencies = group
      .filter((row) => row.error === undefined)
      .flatMap((row) => row.chunkMs ?? [row.ms]);
    // A failed sample counts as a language miss; mixed samples are never judged.
    const judged = group.flatMap((row) => (row.langOk === undefined ? [] : [row.langOk]));
    byLang[lang] = {
      failed: group.filter((row) => row.error !== undefined).length,
      missing: all.length - group.length,
      silent: group.filter((row) => row.silent).length,
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
    '| lang | missing wav | failed | silent | error rate | lang accuracy | p50 ms | p95 ms |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...Object.entries(report.byLang).map(
      ([lang, s]) =>
        `| ${lang} | ${s.missing} | ${s.failed} | ${s.silent} | ${fixed(s.errorRate, 3)} | ${fixed(s.langAccuracy, 2)} | ${fixed(s.p50Ms, 0)} | ${fixed(s.p95Ms, 0)} |`,
    ),
    '',
    `failed samples: ${failed}/${report.rows.length - missing} (missing wav: ${missing})`,
  ].join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== '--'),
    options: {
      server: { type: 'string' },
      model: { type: 'string' },
      repeat: { type: 'string', default: '1' },
      'chunk-ms': { type: 'string' },
      set: { type: 'string', default: 'bench-data/audio' },
      manifest: { type: 'string', default: 'packages/bench/fixtures/audio.jsonl' },
      out: { type: 'string' },
    },
  });
  if (values.server === undefined) throw new Error('--server <url> is required');
  if (values.model === undefined) throw new Error('--model <name> is required');
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat must be an integer >= 1');
  const chunkMs = values['chunk-ms'] === undefined ? undefined : Number(values['chunk-ms']);
  if (chunkMs !== undefined && !(chunkMs > 0)) throw new Error('--chunk-ms must be > 0');
  const report = await runAsrBench({
    server: values.server,
    model: values.model,
    samples: loadAudioSamples(fromRoot(values.manifest)),
    loadWav: (id) => {
      const file = path.join(fromRoot(values.set), `${id}.wav`);
      return existsSync(file) ? readFileSync(file) : undefined;
    },
    repeat,
    ...(chunkMs === undefined ? {} : { chunkMs }),
  });
  const out =
    values.out ??
    `bench-data/results/asr-${values.model.replace(/[^\w.-]+/gu, '_')}-${new Date().toISOString().replace(/[:.]/gu, '-')}.jsonl`;
  const meta = await benchMeta({
    bench: 'asr',
    server: values.server,
    model: values.model,
    settings: {
      set: values.set,
      manifest: values.manifest,
      repeat,
      chunkMs: chunkMs ?? null,
      slot: 0,
      temperature: 0,
    },
  });
  writeResults(fromRoot(out), meta, report.rows);
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
