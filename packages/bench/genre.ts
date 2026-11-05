import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  commentBatchMaxTokens,
  commentBatchPrompt,
  commentCategorySchema,
  createLlamaClient,
  genreEvalLineSchema,
  cutByMaxTokens,
  isStreamCategory,
  needsTranslation,
  parseCommentBatch,
  scriptLanguageGuess,
  STREAM_CATEGORIES,
  STREAM_GENRES,
  streamCategories,
  type CommentCategory,
  type GenreEvalLine,
  type LlamaClient,
  type StreamGenre,
} from '@chrome-toolbox/extension-core';
import { GENERATION } from './generation.ts';
import { fromRoot } from './paths.ts';
import { benchMeta, writeResults } from './results.ts';

/**
 * The self-written evaluation sets of the genre categories (R62), one `<genre>.jsonl` per
 * genre, from the repository root. Every line is made up.
 */
export const GENRE_EVAL_DIR = 'packages/extension-core/test/fixtures/genre-eval';
/** Comments per request, as the comment extension batches them (spec §7). */
const BATCH = 3;
/**
 * A made-up title per genre: the stream context of the prompt, as a stream title would be (no
 * spoiler note, no relaxation).
 */
const GENRE_TITLES = {
  fps: '【Fixture Royale】ランクマ ダイヤ目指す',
  story: '【初見】Fixture Quest #3 王都へ',
  horror: '【初見ホラー】Fixture Manor 叫んだら終わり',
  puzzle_rta: '【RTA】Fixture Puzzle any% 自己ベ更新したい',
  chat: '【雑談】週末の話とお便り読み',
  singing: '【歌枠】しっとりバラード縛り',
  watchalong: '【同時視聴】Fixture Anime 第5話',
  sports_viewing: '【観戦】Fixture Cup 決勝ウォッチパーティー',
  board: '【Fixture麻雀】段位戦 半荘',
  deduction: '【Fixture人狼】10人村',
  other: 'Fixture stream',
} as const satisfies Record<StreamGenre, string>;

/** One line of a set (`GenreEvalLine`) and the `*.jsonl` file it came from. */
export type GenreSample = GenreEvalLine & { file?: string };
/** A line as the model classified it; `predicted` is absent when its reply line failed. */
export type GenreRow = GenreSample & { predicted?: CommentCategory; error?: string; ms: number };
export type CategoryScore = {
  tp: number;
  fp: number;
  fn: number;
  /** Absent when nothing was predicted as the category. */
  precision?: number;
  /** Absent when no line expects the category. */
  recall?: number;
};
/** Lines expected as `total` of which the model flagged `flagged` as a stream category. */
export type FalsePositives = { flagged: number; total: number; rate?: number };
export type GenreScore = {
  categories: Partial<Record<CommentCategory, CategoryScore>>;
  /** Chatter lines put in a stream category (spoiler or a genre category). */
  chatterFalsePositives: FalsePositives;
  /** Chatter, question and important lines put in a stream category. */
  ordinaryFalsePositives: FalsePositives;
  /** Lines whose reply line did not decode. */
  failed: number;
};
export type GenreReport = {
  rows: GenreRow[];
  score: GenreScore & { genres: Partial<Record<StreamGenre, GenreScore>> };
};

/** One line, checked with the shape test's schema (`genreEvalLineSchema`). */
function parseLine(value: unknown, where: string, fileGenre: string): GenreSample {
  const line = genreEvalLineSchema.safeParse(value);
  if (!line.success)
    throw new Error(
      `${where}: not a genre eval line ({text: 1-200 characters, genre: ${STREAM_GENRES.join('|')}, expected: a category}, no other key)`,
    );
  if (line.data.genre !== fileGenre)
    throw new Error(`${where}: ${line.data.genre} is not the genre of ${fileGenre}`);
  return line.data;
}

/** Reads every `<genre>.jsonl` in `dir` (sorted by name); one non-blank line is one sample. */
export function loadGenreSamples(dir: string): GenreSample[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .toSorted();
  return files.flatMap((name) =>
    readFileSync(path.join(dir, name), 'utf8')
      .split('\n')
      .flatMap((line, index) => {
        if (line.trim() === '') return [];
        const where = `${name}:${index + 1}`;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          throw new Error(`${where}: invalid JSON`);
        }
        return [{ ...parseLine(value, where, name.replace(/\.jsonl$/u, '')), file: name }];
      }),
  );
}

const ratio = (part: number, whole: number): number | undefined =>
  whole === 0 ? undefined : part / whole;
/**
 * How many of `rows` the model put in a stream category, of those it judged: a failed line was
 * never judged, so it neither lowers nor raises the share (it counts under `failed`).
 */
const flaggedAmong = (rows: readonly GenreRow[]): FalsePositives => {
  const judged = rows.filter((row) => row.predicted !== undefined);
  const flagged = judged.filter(
    (row) => row.predicted !== undefined && isStreamCategory(row.predicted),
  ).length;
  const rate = ratio(flagged, judged.length);
  return { flagged, total: judged.length, ...(rate === undefined ? {} : { rate }) };
};
function scoreOf(rows: readonly GenreRow[]): GenreScore {
  const categories: Partial<Record<CommentCategory, CategoryScore>> = {};
  for (const category of commentCategorySchema.options) {
    const tp = rows.filter((r) => r.expected === category && r.predicted === category).length;
    const fp = rows.filter((r) => r.expected !== category && r.predicted === category).length;
    const fn = rows.filter((r) => r.expected === category && r.predicted !== category).length;
    if (tp + fp + fn === 0) continue;
    const precision = ratio(tp, tp + fp);
    const recall = ratio(tp, tp + fn);
    categories[category] = {
      tp,
      fp,
      fn,
      ...(precision === undefined ? {} : { precision }),
      ...(recall === undefined ? {} : { recall }),
    };
  }
  return {
    categories,
    chatterFalsePositives: flaggedAmong(rows.filter((row) => row.expected === 'chatter')),
    ordinaryFalsePositives: flaggedAmong(
      rows.filter((row) => ['chatter', 'question', 'important'].includes(row.expected)),
    ),
    failed: rows.filter((row) => row.predicted === undefined).length,
  };
}

/** Precision and recall per category, and the chatter flagged as NG, overall and per genre. */
export function scoreGenreRows(rows: readonly GenreRow[]): GenreReport['score'] {
  const genres: Partial<Record<StreamGenre, GenreScore>> = {};
  for (const genre of STREAM_GENRES) {
    const own = rows.filter((row) => row.genre === genre);
    if (own.length > 0) genres[genre] = scoreOf(own);
  }
  return { ...scoreOf(rows), genres };
}

/**
 * Runs the sets against a server with the comment extension's prompt and grammar: per genre,
 * in file order, batches of 3 with the genre's stream categories (no relaxation, no spoiler
 * note) and a made-up title. Japanese lines are classified only, as in the extension.
 */
export async function runGenreBench(options: {
  client: LlamaClient;
  samples: readonly GenreSample[];
  model?: string;
  slot?: number;
  now?: () => number;
}): Promise<GenreReport> {
  const { client, samples } = options;
  const now = options.now ?? ((): number => performance.now());
  const health = await client.health();
  if (!health.ok) throw new Error(`llama-server is not ready: ${health.error.internalCode}`);
  const rows: GenreRow[] = [];
  for (const genre of STREAM_GENRES) {
    const own = samples.filter((sample) => sample.genre === genre);
    const categories = streamCategories({ genre, relaxations: [], spoilerTargets: false });
    for (let at = 0; at < own.length; at += BATCH) {
      const batch = own.slice(at, at + BATCH);
      const comments = batch.map((sample) => {
        const guess = scriptLanguageGuess(sample.text);
        return { text: sample.text, lang: guess.lang, translate: needsTranslation(guess, 'ja') };
      });
      const maxTokens = commentBatchMaxTokens(comments);
      const started = now();
      const reply = await client.chat({
        ...commentBatchPrompt({
          comments,
          context: `Title: ${GENRE_TITLES[genre]}`,
          genre,
          categories,
        }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.slot === undefined ? {} : { slot: options.slot }),
        temperature: GENERATION.temperature,
        templateKwargs: GENERATION.templateKwargs,
        maxTokens,
      });
      const ms = now() - started;
      const items = reply.ok
        ? parseCommentBatch(reply.value.text, comments, {
            cut: cutByMaxTokens(reply.value, maxTokens),
          })
        : batch.map(() => undefined);
      batch.forEach((sample, i) => {
        const item = items[i];
        rows.push(
          item === undefined
            ? { ...sample, error: reply.ok ? 'response_invalid' : reply.error.internalCode, ms }
            : { ...sample, predicted: item.category, ms },
        );
      });
    }
  }
  return { rows, score: scoreGenreRows(rows) };
}

const fixed = (value: number | undefined): string => (value === undefined ? '-' : value.toFixed(2));
const percent = (value: number | undefined): string =>
  value === undefined ? '-' : `${(value * 100).toFixed(1)}%`;

/** The report as Markdown: per category P/R, per genre, and the misjudged lines. */
export function genreSummary(report: GenreReport): string {
  const { score } = report;
  const categoryLine = (category: CommentCategory, s: CategoryScore | undefined): string =>
    s === undefined
      ? `| ${category} | - | - | 0 | 0 | 0 |`
      : `| ${category} | ${fixed(s.precision)} | ${fixed(s.recall)} | ${s.tp} | ${s.fp} | ${s.fn} |`;
  const fpText = (fp: FalsePositives): string => `${percent(fp.rate)} (${fp.flagged}/${fp.total})`;
  const misjudged = report.rows.filter((row) => row.predicted !== row.expected);
  return [
    '| category | precision | recall | tp | fp | fn |',
    '| --- | --- | --- | --- | --- | --- |',
    ...STREAM_CATEGORIES.map((category) => categoryLine(category, score.categories[category])),
    '',
    '| genre | lines | chatter flagged | chatter/question/important flagged | failed |',
    '| --- | --- | --- | --- | --- |',
    ...Object.entries(score.genres).map(
      ([genre, s]) =>
        `| ${genre} | ${report.rows.filter((row) => row.genre === genre).length} | ${fpText(s.chatterFalsePositives)} | ${fpText(s.ordinaryFalsePositives)} | ${s.failed} |`,
    ),
    `| all | ${report.rows.length} | ${fpText(score.chatterFalsePositives)} | ${fpText(score.ordinaryFalsePositives)} | ${score.failed} |`,
    '',
    `misjudged (${misjudged.length}):`,
    ...misjudged.map(
      (row) =>
        `  ${row.genre}\texpected ${row.expected}\tgot ${row.predicted ?? row.error ?? '-'}\t${row.text}`,
    ),
  ].join('\n');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== '--'),
    options: {
      server: { type: 'string' },
      model: { type: 'string' },
      set: { type: 'string', default: GENRE_EVAL_DIR },
      slot: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (values.server === undefined) throw new Error('--server <url> is required');
  const slot = values.slot === undefined ? undefined : Number(values.slot);
  if (slot !== undefined && !(Number.isInteger(slot) && slot >= 0))
    throw new Error('--slot must be an integer >= 0');
  const client = createLlamaClient({ baseUrl: values.server, fetch, timeoutMs: 120_000 });
  const report = await runGenreBench({
    client,
    samples: loadGenreSamples(fromRoot(values.set)),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(slot === undefined ? {} : { slot }),
  });
  const out =
    values.out ??
    `bench-data/results/genre-${(values.model ?? 'default').replace(/[^\w.-]+/gu, '_')}-${new Date().toISOString().replace(/[:.]/gu, '-')}.jsonl`;
  const meta = await benchMeta({
    bench: 'genre',
    server: values.server,
    model: values.model,
    settings: { ...GENERATION, batch: BATCH, slot: slot ?? null, set: values.set },
  });
  writeResults(fromRoot(out), meta, report.rows);
  console.log(genreSummary(report));
  console.log(`wrote ${out}`);
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
