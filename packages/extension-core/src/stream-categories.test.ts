import { describe, expect, it } from 'vitest';
import {
  genreEvalLineSchema,
  STREAM_CATEGORY_DEFINITIONS,
  isStreamCategory,
  STREAM_CATEGORIES,
  STREAM_GENRES,
  streamCategories,
  type StreamCategory,
  type StreamGenre,
} from './stream-categories.ts';

describe('streamCategories (R62)', () => {
  const always = ['relay', 'privacy', 'sensitive'] as const;
  const table: readonly { genre: StreamGenre; expected: readonly StreamCategory[] }[] = [
    { genre: 'fps', expected: ['instruction', 'relay', 'ghosting', 'privacy', 'sensitive'] },
    { genre: 'story', expected: ['spoiler', 'instruction', ...always] },
    { genre: 'horror', expected: ['spoiler', 'instruction', ...always] },
    { genre: 'puzzle_rta', expected: ['spoiler', 'instruction', ...always] },
    { genre: 'chat', expected: always },
    { genre: 'singing', expected: always },
    { genre: 'watchalong', expected: ['spoiler', ...always] },
    { genre: 'sports_viewing', expected: ['spoiler', ...always] },
    { genre: 'board', expected: ['instruction', 'relay', 'ghosting', 'privacy', 'sensitive'] },
    { genre: 'deduction', expected: ['relay', 'ghosting', 'privacy', 'sensitive'] },
    { genre: 'other', expected: always },
  ];

  it('covers every genre once', () => {
    expect(table.map((row) => row.genre).toSorted()).toEqual([...STREAM_GENRES].toSorted());
  });

  it.each(table)(
    'enables for a $genre stream without spoiler targets: $expected',
    ({ genre, expected }) => {
      expect(streamCategories({ genre, relaxations: [], spoilerTargets: false })).toEqual(expected);
    },
  );

  it.each(table)(
    'enables spoilers for a $genre stream with spoiler targets (R31)',
    ({ genre, expected }) => {
      const categories = streamCategories({ genre, relaxations: [], spoilerTargets: true });
      expect(categories).toEqual(
        STREAM_CATEGORIES.filter((c) => c === 'spoiler' || expected.includes(c)),
      );
    },
  );

  it.each([
    // The stream's own rules invite advice (【参加型】, 指示OK): instructions are fine there.
    { genre: 'fps', relaxations: ['instruction'], without: ['instruction'] },
    { genre: 'board', relaxations: ['instruction'], without: ['instruction'] },
    // ネタバレOK, 2周目: the genre's spoilers are off; never the always-on categories.
    { genre: 'story', relaxations: ['spoiler'], without: ['spoiler'] },
    {
      genre: 'horror',
      relaxations: ['instruction', 'spoiler'],
      without: ['spoiler', 'instruction'],
    },
    { genre: 'chat', relaxations: ['instruction', 'spoiler'], without: [] },
  ] as const)(
    'turns off $without for a $genre stream that relaxes $relaxations',
    ({ genre, relaxations, without }) => {
      const strict = streamCategories({ genre, relaxations: [], spoilerTargets: false });
      expect(streamCategories({ genre, relaxations, spoilerTargets: false })).toEqual(
        strict.filter((category) => !(without as readonly string[]).includes(category)),
      );
    },
  );

  it("keeps the viewer's own spoiler targets over a stream that allows spoilers", () => {
    expect(
      streamCategories({ genre: 'story', relaxations: ['spoiler'], spoilerTargets: true }),
    ).toContain('spoiler');
  });

  it('tells the stream categories from the base ones', () => {
    expect(STREAM_CATEGORIES.every(isStreamCategory)).toBe(true);
    const base = ['abusive', 'spam', 'question', 'important', 'chatter'] as const;
    expect(base.some((category) => isStreamCategory(category))).toBe(false);
  });
});

describe('STREAM_CATEGORY_DEFINITIONS', () => {
  it('states the principles behind the confusions with chatter (R62, fix round 1)', () => {
    const { privacy, instruction, spoiler, ghosting } = STREAM_CATEGORY_DEFINITIONS;
    // Privacy is about real people only; characters never are.
    expect(privacy).toMatch(
      /Only real people count: fictional and game characters are never privacy/u,
    );
    // An instruction is a concrete action; a shout at danger is a reaction.
    expect(instruction).toMatch(/a concrete action, route, target or strategy/u);
    expect(instruction).toMatch(/Not instruction: emotional shouts or cheering at danger/u);
    // A hedged guess is chat unless it states hidden information as a known fact.
    expect(spoiler).toMatch(/guess.*unless it states hidden information as a known fact/u);
    expect(ghosting).toMatch(/guesses.*unless they state hidden information as a known fact/u);
    // A hint stating what will happen stays a spoiler.
    expect(spoiler).toMatch(/stated as what will happen/u);
  });

  it('widens sensitive to comparisons, sexual remarks and 不謹慎 baiting, and moves comparisons out of relay (R66)', () => {
    const { sensitive, relay } = STREAM_CATEGORY_DEFINITIONS;
    expect(sensitive).toMatch(/politics, religion/u);
    expect(sensitive).toMatch(/compares the streamer with another named or identifiable streamer/u);
    expect(sensitive).toMatch(/whether the comparison is kind or not/u);
    expect(sensitive).toMatch(
      /sexual remarks, requests or advances to the streamer or another real person/u,
    );
    expect(sensitive).toMatch(/a real disaster, accident, death or tragedy \(不謹慎\)/u);
    expect(sensitive).toMatch(
      /Not sensitive: games, films, songs or shows about war, politics or disasters/u,
    );
    expect(sensitive).toMatch(/compliments that are not sexual/u);
    expect(relay).toMatch(
      /a neutral mention that another streamer exists or has played the same game/u,
    );
    expect(relay).toMatch(/a comparison of this streamer with another \(that is sensitive\)/u);
  });
});

describe('genreEvalLineSchema', () => {
  it('reads {text, genre, expected}', () => {
    expect(
      genreEvalLineSchema.safeParse({ text: 'ナイス', genre: 'fps', expected: 'chatter' }).success,
    ).toBe(true);
  });

  it.each([
    { name: 'an extra key', line: { text: 'x', genre: 'fps', expected: 'chatter', note: 'n' } },
    { name: 'an empty text', line: { text: '', genre: 'fps', expected: 'chatter' } },
    {
      name: 'a text over 200 characters',
      line: { text: 'x'.repeat(201), genre: 'fps', expected: 'chatter' },
    },
    { name: 'an unknown genre', line: { text: 'x', genre: 'rpg', expected: 'chatter' } },
    { name: 'an unknown category', line: { text: 'x', genre: 'fps', expected: 'backseat' } },
    { name: 'a missing category', line: { text: 'x', genre: 'fps' } },
  ])('rejects $name', ({ line }) => {
    expect(genreEvalLineSchema.safeParse(line).success).toBe(false);
  });
});
