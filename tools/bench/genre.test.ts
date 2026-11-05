import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMENT_CATEGORY_CODES, createLlamaClient } from '@chrome-toolbox/extension-core';
import {
  GENRE_EVAL_DIR,
  loadGenreSamples,
  runGenreBench,
  scoreGenreRows,
  type GenreRow,
  type GenreSample,
} from './genre.ts';

type Sent = {
  model?: string;
  temperature?: number;
  chat_template_kwargs?: unknown;
  grammar?: string;
  messages: { content: string }[];
};

/** A fake llama-server: answers each batch with `answer(texts)`, one category per comment. */
function fakeServer(answer: (texts: string[]) => (string | undefined)[]) {
  const sent: Sent[] = [];
  const client = createLlamaClient({
    baseUrl: 'http://127.0.0.1:1',
    fetch: async (url, init) => {
      if (url.endsWith('/health')) return Response.json({ status: 'ok' });
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent;
      sent.push(body);
      const comments = (body.messages.at(-1)?.content ?? '')
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as { id: number; translate: boolean; text: string });
      const codes = answer(comments.map((c) => c.text));
      const content = comments
        .map((c, i) => {
          const code = codes[i];
          if (code === undefined) return '';
          return `${c.id}\t${code}${c.translate ? `\t訳:${c.text}` : ''}\n`;
        })
        .join('');
      return Response.json({ choices: [{ message: { content } }] });
    },
  });
  return { client, sent };
}

const sample = (text: string, genre: GenreSample['genre'], expected: GenreSample['expected']) =>
  ({ text, genre, expected }) satisfies GenreSample;

describe('loadGenreSamples', () => {
  const dir = (files: Record<string, string>): string => {
    const directory = mkdtempSync(path.join(tmpdir(), 'genre-eval-'));
    for (const [name, content] of Object.entries(files))
      writeFileSync(path.join(directory, name), content);
    return directory;
  };

  it('reads every set of the repository', () => {
    const samples = loadGenreSamples(GENRE_EVAL_DIR);
    expect(samples.length).toBeGreaterThanOrEqual(300);
    // At least these genres; a set added later must not break the bench.
    const genres = new Set(samples.map((s) => s.genre));
    for (const genre of ['fps', 'story', 'horror', 'chat', 'singing', 'board'] as const)
      expect(genres).toContain(genre);
  });

  it('reads {text, genre, expected} per line, in file order', () => {
    const samples = loadGenreSamples(
      dir({
        'fps.jsonl': [
          '{"text":"右から敵来るよ別窓で見た","genre":"fps","expected":"ghosting"}',
          '',
          '{"text":"ナイス！","genre":"fps","expected":"chatter"}',
        ].join('\n'),
        'notes.txt': 'ignored',
      }),
    );
    expect(samples).toEqual([
      { text: '右から敵来るよ別窓で見た', genre: 'fps', expected: 'ghosting', file: 'fps.jsonl' },
      { text: 'ナイス！', genre: 'fps', expected: 'chatter', file: 'fps.jsonl' },
    ]);
  });

  it.each([
    // One schema with the shape test (genreEvalLineSchema): strict keys, at most 200 characters.
    { line: '{"text":"x","genre":"fps"}', error: /fps\.jsonl:1: not a genre eval line/u },
    { line: '{"text":"x","genre":"rpg","expected":"chatter"}', error: /not a genre eval line/u },
    { line: '{"text":"","genre":"fps","expected":"chatter"}', error: /not a genre eval line/u },
    {
      line: `{"text":"${'x'.repeat(201)}","genre":"fps","expected":"chatter"}`,
      error: /not a genre eval line/u,
    },
    {
      line: '{"text":"x","genre":"fps","expected":"chatter","note":"n"}',
      error: /not a genre eval line/u,
    },
    { line: '{"text":"x","genre":"chat","expected":"chatter"}', error: /not the genre of fps/u },
    { line: 'not json', error: /fps\.jsonl:1: invalid JSON/u },
  ])('rejects $line', ({ line, error }) => {
    expect(() => loadGenreSamples(dir({ 'fps.jsonl': line }))).toThrow(error);
  });
});

describe('scoreGenreRows', () => {
  const row = (
    expected: GenreRow['expected'],
    predicted: GenreRow['predicted'],
    genre: GenreRow['genre'] = 'fps',
  ): GenreRow => ({
    text: `${expected}/${predicted}`,
    genre,
    expected,
    ...(predicted === undefined ? {} : { predicted }),
    ms: 1,
  });

  it('gives precision and recall per category and the share of chatter flagged as NG', () => {
    const score = scoreGenreRows([
      row('instruction', 'instruction'),
      row('instruction', 'chatter'),
      row('chatter', 'instruction'),
      row('chatter', 'chatter'),
      row('chatter', 'chatter'),
      row('chatter', 'chatter'),
      row('question', 'relay'),
      row('relay', 'relay'),
      row('privacy', undefined),
    ]);
    expect(score.categories.instruction).toEqual({
      tp: 1,
      fp: 1,
      fn: 1,
      precision: 0.5,
      recall: 0.5,
    });
    expect(score.categories.relay).toEqual({ tp: 1, fp: 1, fn: 0, precision: 0.5, recall: 1 });
    // Nothing predicted: no precision; a failed line misses its category.
    expect(score.categories.privacy).toEqual({ tp: 0, fp: 0, fn: 1, recall: 0 });
    expect(score.chatterFalsePositives).toEqual({ flagged: 1, total: 4, rate: 0.25 });
    // Chatter, questions and important lines together: 2 of 5 flagged.
    expect(score.ordinaryFalsePositives).toEqual({ flagged: 2, total: 5, rate: 0.4 });
    expect(score.failed).toBe(1);
  });

  it('leaves failed lines out of the false-positive shares', () => {
    const score = scoreGenreRows([
      row('chatter', 'relay'),
      row('chatter', 'chatter'),
      row('chatter', undefined),
      row('question', undefined),
    ]);
    // A failed line was never judged: it neither lowers nor raises the share.
    expect(score.chatterFalsePositives).toEqual({ flagged: 1, total: 2, rate: 0.5 });
    expect(score.ordinaryFalsePositives).toEqual({ flagged: 1, total: 2, rate: 0.5 });
    expect(score.failed).toBe(2);
  });

  it('scores each genre on its own rows', () => {
    const score = scoreGenreRows([
      row('instruction', 'instruction', 'fps'),
      row('chatter', 'instruction', 'story'),
    ]);
    expect(score.genres.fps?.categories.instruction?.precision).toBe(1);
    expect(score.genres.story?.categories.instruction?.precision).toBe(0);
  });
});

describe('runGenreBench', () => {
  it('stops before measuring when the server is not ready', async () => {
    const client = createLlamaClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: async () => new Response('', { status: 503 }),
    });
    await expect(
      runGenreBench({ client, samples: [sample('ナイス', 'fps', 'chatter')] }),
    ).rejects.toThrow(/llama-server is not ready/u);
  });

  it("sends each genre's lines in batches of 3 with that genre's prompt and grammar", async () => {
    const server = fakeServer((texts) =>
      texts.map((text) =>
        text.startsWith('heal')
          ? COMMENT_CATEGORY_CODES.instruction
          : text === '最終章で裏切るよ'
            ? COMMENT_CATEGORY_CODES.spoiler
            : text === 'broken'
              ? undefined
              : COMMENT_CATEGORY_CODES.chatter,
      ),
    );
    const report = await runGenreBench({
      client: server.client,
      model: 'gemma4-e4b',
      samples: [
        sample('heal now', 'fps', 'instruction'),
        sample('ナイス', 'fps', 'chatter'),
        sample('heal first', 'fps', 'instruction'),
        sample('broken', 'fps', 'chatter'),
        sample('最終章で裏切るよ', 'story', 'spoiler'),
      ],
    });
    // fps: two batches (3 + 1), then story: one.
    expect(server.sent.map((body) => body.grammar?.split('\n')[1])).toEqual([
      'code ::= [asqicnrgve]',
      'code ::= [asqicnrgve]',
      'code ::= [aspqicnrve]',
    ]);
    const users = server.sent.map((body) => body.messages.at(-1)?.content ?? '');
    expect(users[0]).toContain('Stream genre: fps (');
    expect(users[2]).toContain('Stream genre: story (');
    // A made-up title per genre stands for the stream title (no note, no relaxations).
    expect(users[2]?.split('\n')[0]).toMatch(/^Stream context: "Title: /u);
    expect(server.sent.every((body) => body.model === 'gemma4-e4b')).toBe(true);
    expect(server.sent.every((body) => body.temperature === 0)).toBe(true);
    expect(report.rows.map((r) => [r.text, r.predicted ?? r.error])).toEqual([
      ['heal now', 'instruction'],
      ['ナイス', 'chatter'],
      ['heal first', 'instruction'],
      ['broken', 'response_invalid'],
      ['最終章で裏切るよ', 'spoiler'],
    ]);
    expect(report.score.categories.instruction?.precision).toBe(1);
    expect(report.score.failed).toBe(1);
  });
});
