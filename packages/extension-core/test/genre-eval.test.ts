import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  genreEvalLineSchema,
  isStreamCategory,
  STREAM_GENRES,
  streamCategories,
  streamGenreSchema,
} from '../src/stream-categories.ts';

/**
 * The self-written evaluation sets of the genre categories (R62): one JSONL file per genre,
 * `<genre>.jsonl`, one comment per line with the category the classifier should give it in a
 * stream of that genre (no relaxations, no spoiler targets). `packages/bench/genre.ts` runs
 * them against a real server. Every line is made up: no real chat, streamer, agency or viewer name.
 */
const DIRECTORY = path.join(import.meta.dirname, 'fixtures', 'genre-eval');
/** Every genre a stream can be detected as (R62); `other` (unknown) needs no set. */
const REQUIRED = STREAM_GENRES.filter((genre) => genre !== 'other');

const files = readdirSync(DIRECTORY)
  .filter((name) => name.endsWith('.jsonl'))
  .toSorted();
const linesOf = (name: string) =>
  readFileSync(path.join(DIRECTORY, name), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => genreEvalLineSchema.parse(JSON.parse(line)));

describe('genre evaluation sets', () => {
  it('has a set for every required genre, named after a known genre', () => {
    const genres = files.map((name) => name.replace(/\.jsonl$/u, ''));
    expect(genres.filter((genre) => !streamGenreSchema.safeParse(genre).success)).toEqual([]);
    for (const genre of REQUIRED) expect(genres).toContain(genre);
  });

  describe.each(files)('%s', (name) => {
    const genre = streamGenreSchema.parse(name.replace(/\.jsonl$/u, ''));
    const lines = linesOf(name);
    const enabled = streamCategories({ genre, relaxations: [], spoilerTargets: false });

    it('has at least 30 distinct lines of its own genre, each {text, genre, expected}', () => {
      expect(lines.length).toBeGreaterThanOrEqual(30);
      expect(lines.filter((line) => line.genre !== genre)).toEqual([]);
      expect(new Set(lines.map((line) => line.text)).size).toBe(lines.length);
    });

    it('expects only categories a stream of the genre can give', () => {
      expect(
        lines.filter((line) => isStreamCategory(line.expected) && !enabled.includes(line.expected)),
      ).toEqual([]);
    });

    it('has positives of every genre category it enables, and more ordinary lines than NG', () => {
      const positives = enabled.map((category) => ({
        category,
        lines: lines.filter((line) => line.expected === category).length,
      }));
      expect(positives.filter((positive) => positive.lines < 2)).toEqual([]);
      const ordinary = lines.filter((line) => !isStreamCategory(line.expected));
      expect(ordinary.length * 2).toBeGreaterThan(lines.length);
    });
  });
});
