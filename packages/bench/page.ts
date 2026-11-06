import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  createLlamaClient,
  createQueue,
  cutByMaxTokens,
  PAGE_PLAMO_MAX_TOKENS,
  pageBatchMaxTokens,
  pageBatchPrompt,
  pageTokenSchema,
  pageTokensValid,
  pageUnitSource,
  parsePageBatch,
  parsePlamoLine,
  PLAMO_TRANSLATE_MODEL,
  plamoTranslateRequest,
  readPagePieces,
  type ChatTiming,
  type LlamaClient,
  type PageToken,
} from '@chrome-toolbox/extension-core';
import { GENERATION } from './generation.ts';
import { percentile } from './metrics.ts';
import { fromRoot } from './paths.ts';
import { parseIntegerOption } from './translate.ts';
import { benchMeta, writeResults } from './results.ts';

export const pageKinds = ['label', 'paragraph', 'rich'] as const;
export type PageUnitSample = {
  id: string;
  lang: string;
  kind: (typeof pageKinds)[number];
  tokens: PageToken[];
};
export type PageRow = {
  model: 'gemma' | 'plamo';
  id: string;
  lang: string;
  kind: PageUnitSample['kind'];
  /** Wall time of the request that produced the row; a Gemma row waits for its whole batch. */
  ms: number;
  /** The translated text nodes, in order (what the extension writes back). */
  pieces?: string[];
  timing?: ChatTiming;
  /** Units sent in the same request (Gemma rows only). */
  batchSize?: number;
  error?: string;
};
export type PageModelStats = {
  attempts: number;
  successes: number;
  /** Failures by code; a unit that is not valid or does not read back fails alone (P21). */
  failures: Record<string, number>;
  /** Successful rows only. */
  p50Ms?: number | undefined;
  p95Ms?: number | undefined;
  /** Units with markers, and those whose markers `readPagePieces` read back. */
  richAttempts: number;
  richKept: number;
};
export type FirstScreen = {
  /** One entry per round: the time to translate the first screen, in document order. */
  gemmaMs: number[];
  gemmaP50Ms: number | undefined;
  plamoMs?: number[];
  plamoP50Ms?: number | undefined;
};
export type PageReport = {
  rows: PageRow[];
  gemma: PageModelStats;
  plamo?: PageModelStats;
  firstScreen: FirstScreen;
  /** The `id_slot` of Gemma batches and of PLaMo's workers; undefined sends none. */
  slots: { gemma: number | undefined; plamo: (number | undefined)[] };
};

/** The extension's batch: at most 6 units and 800 characters of source text. */
export const BATCH_UNITS = 6;
export const BATCH_CHARS = 800;
export const FIRST_SCREEN_UNITS = 12;
/** The page every unit poses as; the title is PLaMo's `Page:` context line. */
export const BENCH_PAGE = { title: 'Emberfall Wiki', site: 'wiki.example.test' } as const;
const PLAMO_PARALLEL = 2;

const characters = (tokens: readonly PageToken[]): number =>
  tokens.reduce((sum, token) => sum + (token.t === 'text' ? Array.from(token.text).length : 0), 0);

/** Reads the fixture: one JSON line per unit, each with valid tokens. Errors name `file:line`. */
export function loadPageUnits(file: string): PageUnitSample[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) => {
      if (line.trim() === '') return [];
      const where = `${file}:${index + 1}`;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`${where}: invalid JSON`);
      }
      const { id, lang, kind, tokens } = (value ?? {}) as Record<string, unknown>;
      if (typeof id !== 'string' || id === '') throw new Error(`${where}: id must be a string`);
      if (typeof lang !== 'string' || lang === '')
        throw new Error(`${where}: lang must be a string`);
      const knownKind = pageKinds.find((candidate) => candidate === kind);
      if (knownKind === undefined) throw new Error(`${where}: unknown kind`);
      if (!Array.isArray(tokens)) throw new Error(`${where}: tokens must be an array`);
      const parsed: PageToken[] = [];
      for (const token of tokens as unknown[]) {
        const result = pageTokenSchema.safeParse(token);
        if (!result.success) throw new Error(`${where}: invalid token`);
        parsed.push(result.data);
      }
      if (!pageTokensValid(parsed)) throw new Error(`${where}: tokens are not a valid unit`);
      return [{ id, lang, kind: knownKind, tokens: parsed }];
    });
}

/** Units in order, cut into batches of at most `BATCH_UNITS` units and `BATCH_CHARS` characters. */
export function packBatches(units: readonly PageUnitSample[]): PageUnitSample[][] {
  const batches: PageUnitSample[][] = [];
  let chars = 0;
  for (const unit of units) {
    const size = characters(unit.tokens);
    const last = batches.at(-1);
    if (last !== undefined && last.length < BATCH_UNITS && chars + size <= BATCH_CHARS) {
      last.push(unit);
      chars += size;
    } else {
      batches.push([unit]);
      chars = size;
    }
  }
  return batches;
}

type Pass = {
  rows: PageRow[];
};

const rowOf = (
  model: PageRow['model'],
  unit: PageUnitSample,
  ms: number,
  outcome: { pieces: string[]; timing?: ChatTiming | undefined } | { error: string },
  batchSize?: number,
): PageRow => {
  const row: PageRow = { model, id: unit.id, lang: unit.lang, kind: unit.kind, ms };
  if (batchSize !== undefined) row.batchSize = batchSize;
  if ('error' in outcome) row.error = outcome.error;
  else {
    row.pieces = outcome.pieces;
    if (outcome.timing !== undefined) row.timing = outcome.timing;
  }
  return row;
};

async function gemmaPass(
  client: LlamaClient,
  model: string,
  slot: number | undefined,
  units: readonly PageUnitSample[],
  now: () => number,
): Promise<Pass> {
  const rows: PageRow[] = [];
  const valid = units.filter((unit) => pageTokensValid(unit.tokens));
  for (const unit of units)
    if (!valid.includes(unit)) rows.push(rowOf('gemma', unit, 0, { error: 'tokens_invalid' }));
  // Sequential, like the content script: one batch at a time.
  for (const batch of packBatches(valid)) {
    const tokens = batch.map((unit) => unit.tokens);
    const prompt = pageBatchPrompt({ page: BENCH_PAGE, units: tokens });
    const maxTokens = pageBatchMaxTokens(tokens);
    const started = now();
    const result = await client.chat({
      ...prompt,
      model,
      maxTokens,
      temperature: GENERATION.temperature,
      templateKwargs: GENERATION.templateKwargs,
      ...(slot === undefined ? {} : { slot }),
    });
    const ms = now() - started;
    if (!result.ok) {
      for (const unit of batch)
        rows.push(rowOf('gemma', unit, ms, { error: result.error.internalCode }, batch.length));
      continue;
    }
    const read = parsePageBatch(result.value.text, tokens, {
      cut: cutByMaxTokens(result.value, maxTokens),
    });
    for (const [i, unit] of batch.entries()) {
      const pieces = read[i];
      rows.push(
        rowOf(
          'gemma',
          unit,
          ms,
          pieces === undefined
            ? { error: 'response_invalid' }
            : { pieces, timing: result.value.timing },
          batch.length,
        ),
      );
    }
  }
  return { rows };
}

async function plamoPass(
  client: LlamaClient,
  model: string,
  slots: readonly (number | undefined)[],
  units: readonly PageUnitSample[],
  now: () => number,
): Promise<Pass> {
  const sources = units.map((unit) => pageUnitSource(unit.tokens).text);
  const rows: (PageRow | undefined)[] = units.map(() => undefined);
  let next = 0;
  // One worker per slot, each taking the next unit in document order.
  const worker = async (slot: number | undefined): Promise<void> => {
    for (let i = next++; i < units.length; i = next++) {
      const unit = units[i];
      if (unit === undefined) continue;
      if (!pageTokensValid(unit.tokens)) {
        rows[i] = rowOf('plamo', unit, 0, { error: 'tokens_invalid' });
        continue;
      }
      const line = sources[i] ?? '';
      const request = plamoTranslateRequest({
        line,
        sourceLang: 'auto',
        previous: [`Page: ${BENCH_PAGE.title}`, ...sources.slice(Math.max(0, i - 2), i)],
        glossary: [],
        slot,
        maxTokensCap: PAGE_PLAMO_MAX_TOKENS,
      });
      if (!request.ok) {
        rows[i] = rowOf('plamo', unit, 0, { error: request.error.internalCode });
        continue;
      }
      const started = now();
      const result = await client.chat({
        ...request.value,
        ...(model === PLAMO_TRANSLATE_MODEL ? {} : { model }),
      });
      const ms = now() - started;
      if (!result.ok) {
        rows[i] = rowOf('plamo', unit, ms, { error: result.error.internalCode });
        continue;
      }
      const translation = parsePlamoLine(result.value, request.value.maxTokens, line);
      const pieces = translation.ok ? readPagePieces(translation.value, unit.tokens) : undefined;
      rows[i] = rowOf(
        'plamo',
        unit,
        ms,
        pieces === undefined
          ? { error: 'response_invalid' }
          : { pieces, timing: result.value.timing },
      );
    }
  };
  await Promise.all(slots.map(worker));
  return { rows: rows.flatMap((row) => (row === undefined ? [] : [row])) };
}

function stats(rows: readonly PageRow[]): PageModelStats {
  const ok = rows.filter((row) => row.error === undefined);
  const failures: Record<string, number> = {};
  for (const row of rows)
    if (row.error !== undefined) failures[row.error] = (failures[row.error] ?? 0) + 1;
  const rich = rows.filter((row) => row.kind === 'rich');
  return {
    attempts: rows.length,
    successes: ok.length,
    failures,
    p50Ms: percentile(
      ok.map((row) => row.ms),
      50,
    ),
    p95Ms: percentile(
      ok.map((row) => row.ms),
      95,
    ),
    richAttempts: rich.length,
    richKept: rich.filter((row) => row.error === undefined).length,
  };
}

async function slotsOf(
  client: LlamaClient,
  model: string,
): Promise<{ gemma: number | undefined; plamo: (number | undefined)[] }> {
  const props = await client.props({ model });
  if (!props.ok) return { gemma: undefined, plamo: [undefined, undefined] };
  const total = props.value.totalSlots;
  if (total < 2) return { gemma: 0, plamo: [0] };
  return {
    gemma: total - 1,
    plamo: Array.from({ length: Math.min(PLAMO_PARALLEL, total - 1) }, (_, i) => i + 1),
  };
}

export async function runPageBench(options: {
  gemma: LlamaClient;
  /** Needs a queue that runs `PLAMO_PARALLEL` requests at once; defaults to `gemma`. */
  plamo?: LlamaClient;
  gemmaModel: string;
  plamoModel?: string;
  units: readonly PageUnitSample[];
  rounds: number;
  /** Injected so tests can control elapsed time. */
  now?: () => number;
}): Promise<PageReport> {
  const { gemma, plamo, gemmaModel, units, rounds } = options;
  const plamoModel = options.plamoModel ?? PLAMO_TRANSLATE_MODEL;
  const now = options.now ?? ((): number => performance.now());
  for (const client of new Set([gemma, ...(plamo === undefined ? [] : [plamo])])) {
    const health = await client.health();
    if (!health.ok) throw new Error(`llama-server is not ready: ${health.error.internalCode}`);
  }
  const gemmaSlots = await slotsOf(gemma, gemmaModel);
  const plamoSlots = plamo === undefined ? gemmaSlots : await slotsOf(plamo, plamoModel);
  const slots = { gemma: gemmaSlots.gemma, plamo: plamoSlots.plamo };
  const first = units.slice(0, FIRST_SCREEN_UNITS);

  // One model after the other: concurrent models would pollute each other's latency.
  const rows = (await gemmaPass(gemma, gemmaModel, slots.gemma, units, now)).rows;
  const plamoRows =
    plamo === undefined ? [] : (await plamoPass(plamo, plamoModel, slots.plamo, units, now)).rows;

  const timeRounds = async (pass: () => Promise<Pass>): Promise<number[]> => {
    const times: number[] = [];
    for (let round = 0; round < rounds; round += 1) {
      const started = now();
      await pass();
      times.push(now() - started);
    }
    return times;
  };
  const gemmaMs = await timeRounds(() => gemmaPass(gemma, gemmaModel, slots.gemma, first, now));
  const firstScreen: FirstScreen = { gemmaMs, gemmaP50Ms: percentile(gemmaMs, 50) };
  if (plamo !== undefined) {
    const plamoMs = await timeRounds(() => plamoPass(plamo, plamoModel, slots.plamo, first, now));
    firstScreen.plamoMs = plamoMs;
    firstScreen.plamoP50Ms = percentile(plamoMs, 50);
  }
  return {
    rows: [...rows, ...plamoRows],
    gemma: stats(rows),
    ...(plamo === undefined ? {} : { plamo: stats(plamoRows) }),
    firstScreen,
    slots,
  };
}

function summary(report: PageReport): string {
  const fixed = (value: number | undefined): string =>
    value === undefined ? '-' : value.toFixed(0);
  const codes = (table: Record<string, number>): string =>
    Object.entries(table)
      .map(([code, n]) => `${code}=${n}`)
      .join(', ') || 'none';
  const line = (label: string, s: PageModelStats, screen: number | undefined): string =>
    `| ${label} | ${s.attempts} | ${s.successes} | ${fixed(s.p50Ms)} | ${fixed(s.p95Ms)} | ${s.richKept}/${s.richAttempts} | ${fixed(screen)} | ${codes(s.failures)} |`;
  return [
    '| model | units | ok | p50 ms | p95 ms | rich kept | first screen p50 ms | failures |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    line('gemma', report.gemma, report.firstScreen.gemmaP50Ms),
    ...(report.plamo === undefined
      ? []
      : [line('plamo', report.plamo, report.firstScreen.plamoP50Ms)]),
  ].join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== '--'),
    options: {
      server: { type: 'string' },
      gemma: { type: 'string' },
      plamo: { type: 'string' },
      set: { type: 'string', default: 'packages/bench/fixtures/page/units.jsonl' },
      rounds: { type: 'string', default: '3' },
      out: { type: 'string' },
    },
  });
  if (values.server === undefined) throw new Error('--server <url> is required');
  if (values.gemma === undefined) throw new Error('--gemma <model> is required');
  const rounds = parseIntegerOption(values.rounds, '--rounds', 1);
  const timeoutMs = 120_000;
  const gemma = createLlamaClient({ baseUrl: values.server, fetch, timeoutMs });
  const plamo =
    values.plamo === undefined
      ? undefined
      : createLlamaClient({
          baseUrl: values.server,
          fetch,
          timeoutMs,
          queue: createQueue({ concurrency: PLAMO_PARALLEL }),
        });
  const units = loadPageUnits(fromRoot(values.set));
  const report = await runPageBench({
    gemma,
    gemmaModel: values.gemma,
    units,
    rounds,
    ...(plamo === undefined || values.plamo === undefined
      ? {}
      : { plamo, plamoModel: values.plamo }),
  });
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const out = values.out ?? `bench-data/results/page-${stamp}.jsonl`;
  const meta = await benchMeta({
    bench: 'page',
    server: values.server,
    model: values.gemma,
    settings: {
      ...GENERATION,
      gemmaModel: values.gemma,
      plamoModel: values.plamo ?? null,
      set: values.set,
      units: units.length,
      rounds,
      batchUnits: BATCH_UNITS,
      batchChars: BATCH_CHARS,
      firstScreenUnits: FIRST_SCREEN_UNITS,
      plamoMaxTokens: PAGE_PLAMO_MAX_TOKENS,
      slots: report.slots,
      firstScreen: report.firstScreen,
      stats: { gemma: report.gemma, plamo: report.plamo ?? null },
    },
  });
  writeResults(fromRoot(out), meta, report.rows);
  console.log(summary(report));
  console.log(`wrote ${out}`);
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
