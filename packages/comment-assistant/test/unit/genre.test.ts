import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { streamGenreSchema } from '@chrome-toolbox/extension-core';
import { GAME_GENRES } from '../../src/game-genres.ts';
import { rulesOf } from '../../src/sites/rules.ts';
import {
  createGenreBook,
  detectGenre,
  gameGenre,
  gameKey,
  genreOf,
  MAX_STREAM_GENRES,
  pageRelaxations,
  STREAM_GENRES_KEY,
  titleGenre,
} from '../../src/genre.ts';

afterEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe('genre words', () => {
  it.each([
    // The words in a title's 【】 name the stream (R63 step 3).
    { title: '【雑談】のんびり話す夜', genre: 'chat' },
    { title: '【#雑談作業】イラストを描きながら', genre: 'chat' },
    { title: '【フリートーク】Fixture Talk', genre: 'chat' },
    { title: '【歌枠】Fixture Karaoke Night', genre: 'singing' },
    { title: '【KARAOKE】fixture songs', genre: 'singing' },
    { title: '【同時視聴】Fixture Movie を一緒に見よう', genre: 'watchalong' },
    { title: '[Watchalong] Fixture Show S2', genre: 'watchalong' },
    { title: '【観戦】Fixture Cup 決勝', genre: 'sports_viewing' },
    { title: '【ウォッチパーティー】Fixture League', genre: 'sports_viewing' },
    { title: '【ホラー】Fixture Haunt 初見', genre: 'horror' },
    { title: '【ホラゲ】Fixture Haunt', genre: 'horror' },
    { title: '【FPS】Fixture Royale ランク', genre: 'fps' },
    { title: '【格ゲー】Fixture Fighter', genre: 'fps' },
    { title: '【RPG】Fixture Quest Part 3', genre: 'story' },
    { title: '【マリオRTA】any% 練習', genre: 'puzzle_rta' },
    { title: '【謎解き】Fixture Escape', genre: 'puzzle_rta' },
    { title: '【麻雀】Fixture Mahjong 段位戦', genre: 'board' },
    { title: '【人狼】Fixture Village 村', genre: 'deduction' },
    { title: '【マダミス】Fixture Mystery', genre: 'deduction' },
    // NFKC: full-width brackets and letters.
    { title: '［ＦＰＳ］Fixture Royale', genre: 'fps' },
    // Traps: a simulcast is no watch-along, a chat "speedrun" no RTA, viewers no watch-along.
    { title: '【Twitch同時配信】Fixture Quest', genre: undefined },
    { title: '【雑談配信RTA】30分で寝る', genre: 'chat' },
    { title: '【雑談配信 RTA】30分で寝る', genre: 'chat' },
    { title: '【同時視聴者100人目標】Fixture Quest', genre: undefined },
    // A frame rate is no FPS; a game named after spoilers names no genre.
    { title: '【120fps】Fixture Royale', genre: undefined },
    { title: '【ネタバレあり】Fixture Quest 感想会', genre: undefined },
    { title: '【初見】『ネタバレが激しすぎるRPG』', genre: undefined },
    // Two genres decide nothing; words outside the brackets do not count.
    { title: '【雑談&歌枠】Fixture Night', genre: undefined },
    { title: '雑談しながら Fixture Quest', genre: undefined },
    { title: '【APEX】Fixture ランク', genre: undefined },
    { title: '', genre: undefined },
  ])('reads "$title" as $genre', ({ title, genre }) => {
    expect(titleGenre(title)).toBe(genre);
  });
});

describe('game table', () => {
  it('maps about 60 commonly streamed games to valid genres, each name once', () => {
    expect(GAME_GENRES.length).toBeGreaterThanOrEqual(55);
    expect(GAME_GENRES.length).toBeLessThanOrEqual(90);
    for (const entry of GAME_GENRES)
      expect(streamGenreSchema.safeParse(entry.genre).success).toBe(true);
    const names = GAME_GENRES.flatMap((entry) => entry.names);
    // Unique after NFKC and lower case, and after `gameKey`, which also drops punctuation.
    const lowered = names.map((name) => name.normalize('NFKC').toLowerCase());
    expect(new Set(lowered).size).toBe(names.length);
    const keys = names.map(gameKey);
    expect(new Set(keys).size).toBe(names.length);
    expect(keys.every((key) => key.length > 0)).toBe(true);
  });

  it.each([
    // YouTube's card in English and in Japanese, and Twitch's category slug.
    { game: 'Apex Legends', genre: 'fps' },
    { game: 'エーペックスレジェンズ', genre: 'fps' },
    { game: 'apex-legends', genre: 'fps' },
    { game: 'ＶＡＬＯＲＡＮＴ', genre: 'fps' },
    { game: '崩壊：スターレイル', genre: 'story' },
    { game: '8番出口', genre: 'horror' },
    { game: 'just-chatting', genre: 'chat' },
    { game: 'Fixture Quest', genre: undefined },
    { game: '', genre: undefined },
  ])('maps the game "$game" to $genre', ({ game, genre }) => {
    expect(gameGenre(game)).toBe(genre);
  });
});

describe('detectGenre', () => {
  const rules = '【お約束】\n・この配信は雑談配信です。ゆっくりしていってね';
  it('takes the title first, then the tags, the description rules and the game (R68)', () => {
    const all = {
      rules,
      title: '【ホラー】Fixture Haunt',
      tags: ['FPS'],
      game: 'Apex Legends',
    };
    expect(detectGenre(all)).toEqual({ genre: 'horror', reason: 'title' });
    expect(detectGenre({ ...all, title: 'Fixture Haunt' })).toEqual({
      genre: 'fps',
      reason: 'tags',
    });
    expect(detectGenre({ ...all, title: 'Fixture Haunt', tags: [] })).toEqual({
      genre: 'chat',
      reason: 'rules',
    });
    expect(detectGenre({ title: 'Fixture Quest', game: 'Apex Legends' })).toEqual({
      genre: 'fps',
      reason: 'game',
    });
    // Nothing decides: the one guess comes next (step 5).
    expect(detectGenre({ title: 'Fixture Quest Part 3', game: 'Fixture Quest' })).toBeUndefined();
    expect(detectGenre({})).toBeUndefined();
  });

  it.each([
    // The review's cases: an explicit title wins over a channel's standard rules ...
    {
      name: 'a warning to viewers under a 【雑談】 title',
      source: {
        title: '【雑談】のんびり',
        rules: '【配信ルール】\nホラーが苦手な方はブラウザバック推奨です',
      },
      expected: { genre: 'chat', reason: 'title' },
    },
    // ... and a conditional or negated rule names no genre at all.
    {
      name: 'a rule for singing streams under an Apex title',
      source: {
        title: '【APEX】ランク',
        game: 'Apex Legends',
        rules: '【お約束】\n・歌枠ではリクエストは受け付けていません\n・指示コメはお控えください',
      },
      expected: { genre: 'fps', reason: 'game' },
    },
    {
      name: 'a rule for singing streams without a title genre or game',
      source: {
        title: 'ランク',
        rules: '【お約束】\n・歌枠ではリクエストは受け付けていません\n・指示コメはお控えください',
      },
      expected: undefined,
    },
    {
      name: 'a warning to viewers without a title genre',
      source: { title: 'のんびり', rules: '【配信ルール】\nホラーが苦手な方はご注意ください' },
      expected: undefined,
    },
    // Rules read from a description by `rulesOf`: a greeting or a pointer is no heading, so
    // these descriptions have no rules at all.
    {
      name: 'a greeting before links under an 【FPS】 title',
      source: {
        title: '【FPS】Fixture Royale',
        rules: rulesOf(
          '今日もよろしくお願いいたします！\n過去の歌枠はこちら▼\nhttps://example.com/',
        ),
      },
      expected: { genre: 'fps', reason: 'title' },
    },
    {
      name: 'a pointer to the rules before a schedule',
      source: { rules: rulesOf('Please read the rules below\nWe play horror games on Fridays') },
      expected: undefined,
    },
    // A genre counts in a heading of the rules or in a line about this stream.
    {
      name: 'a heading that names the stream',
      source: { title: 'Fixture night', rules: '【歌枠のお約束】\n・リクエストは受け付けます' },
      expected: { genre: 'singing', reason: 'rules' },
    },
    {
      name: 'a line about this stream',
      source: { title: 'Fixture night', rules: '■配信ルール\n今回はホラーゲームを遊びます' },
      expected: { genre: 'horror', reason: 'rules' },
    },
    {
      name: 'a line that is neither',
      source: { title: 'Fixture night', rules: '【お約束】\n毎週金曜はホラーゲームを遊びます' },
      expected: undefined,
    },
    {
      name: 'a line about this stream that negates',
      source: { title: 'Fixture night', rules: '【お約束】\n・今日の配信は雑談ではないです' },
      expected: undefined,
    },
    {
      name: 'a line about this stream that speaks of other streams',
      source: { title: 'Fixture night', rules: '【お約束】\n・この配信以外の歌枠の話はしないでね' },
      expected: undefined,
    },
  ])('reads $name', ({ source, expected }) => {
    expect(detectGenre(source)).toEqual(expected);
  });

  it('skips a rule that bans or restrains: it is about the viewers, not the stream', () => {
    expect(
      detectGenre({
        rules:
          '【お約束】\n・この配信でのリスナー同士の雑談はお控えください\n・他の方の歌枠の話はNG',
      }),
    ).toBeUndefined();
  });

  it('reads the relaxations of the rules and the tags, negation-safe (R62)', () => {
    expect(pageRelaxations({ rules: '【お約束】\n・指示OK、アドバイス歓迎です' })).toEqual([
      'instruction',
    ]);
    expect(pageRelaxations({ tags: ['日本語', '参加型'] })).toEqual(['instruction']);
    expect(pageRelaxations({ rules: '【お約束】\n・参加型ありません\n・ネタバレ禁止' })).toEqual(
      [],
    );
    // Tags are read one by one: two tags never make one phrase.
    expect(pageRelaxations({ tags: ['no', 'spoilers ok'] })).toEqual(['spoiler']);
    expect(pageRelaxations({ title: '【参加型】Fixture Royale' })).toEqual([]);
  });
});

describe('createGenreBook', () => {
  const read = async (): Promise<unknown> =>
    (await fakeBrowser.storage.local.get(STREAM_GENRES_KEY))[STREAM_GENRES_KEY];

  it('detects from what the page shows, then guesses once and keeps the guess (R63)', async () => {
    const book = createGenreBook(fakeBrowser.storage.local);
    expect((await book.load()).ok).toBe(true);
    expect(
      book.observe('youtube', 'fixture0001', {
        title: 'Fixture Quest Part 3',
        game: 'Fixture Quest',
      }),
    ).toBe(true);
    expect(genreOf(book.get('youtube', 'fixture0001'))).toEqual({
      genre: 'other',
      reason: 'none',
      relaxations: [],
    });
    // Unchanged page: nothing changes.
    expect(
      book.observe('youtube', 'fixture0001', {
        title: 'Fixture Quest Part 3',
        game: 'Fixture Quest',
      }),
    ).toBe(false);
    // The stream needs its one guess, from its title and game; asked once only.
    expect(book.guessInput('youtube', 'fixture0001', 'Fixture Quest Part 3')).toEqual({
      title: 'Fixture Quest Part 3',
      game: 'Fixture Quest',
    });
    expect(book.guessInput('youtube', 'fixture0001', 'Fixture Quest Part 3')).toBeUndefined();
    expect(book.guessed('youtube', 'fixture0001', 'story')).toBe(true);
    expect(genreOf(book.get('youtube', 'fixture0001'))).toMatchObject({
      genre: 'story',
      reason: 'guess',
    });
    // The page names a genre later: it decides, and the guess stays for when it does not.
    book.observe('youtube', 'fixture0001', { title: '【雑談】Fixture Talk' });
    expect(genreOf(book.get('youtube', 'fixture0001'))).toMatchObject({
      genre: 'chat',
      reason: 'title',
    });
    book.observe('youtube', 'fixture0001', { title: 'Fixture Quest Part 4' });
    expect(genreOf(book.get('youtube', 'fixture0001'))).toMatchObject({
      genre: 'story',
      reason: 'guess',
    });
    expect(book.guessInput('youtube', 'fixture0001', 'Fixture Quest Part 4')).toBeUndefined();
    await vi.waitFor(async () =>
      expect(await read()).toEqual([
        {
          site: 'youtube',
          stream: 'fixture0001',
          genre: 'story',
          reason: 'guess',
          relaxations: [],
          guess: 'story',
        },
      ]),
    );
    // A new service worker reads it back: no second guess.
    const again = createGenreBook(fakeBrowser.storage.local);
    await again.load();
    expect(genreOf(again.get('youtube', 'fixture0001'))).toMatchObject({
      genre: 'story',
      reason: 'guess',
    });
    expect(again.guessInput('youtube', 'fixture0001', 'Fixture Quest Part 4')).toBeUndefined();
  });

  it('asks for no guess where the page decides, nothing is known or the viewer chose', async () => {
    const book = createGenreBook(fakeBrowser.storage.local);
    await book.load();
    expect(book.guessInput('twitch', 'fixturechannel', 'Fixture night')).toBeUndefined();
    book.observe('twitch', 'fixturechannel', { title: 'Fixture night', game: 'apex-legends' });
    expect(book.guessInput('twitch', 'fixturechannel', 'Fixture night')).toBeUndefined();
    book.observe('twitch', 'quietchannel', {});
    expect(book.guessInput('twitch', 'quietchannel', undefined)).toBeUndefined();
    book.observe('twitch', 'chosenchannel', { title: 'Fixture night' });
    await book.choose('twitch', 'chosenchannel', 'singing');
    expect(book.guessInput('twitch', 'chosenchannel', 'Fixture night')).toBeUndefined();
  });

  it("keeps the viewer's choice per stream over every detection, and clears it", async () => {
    const book = createGenreBook(fakeBrowser.storage.local);
    await book.load();
    book.observe('youtube', 'fixture0001', { title: '【雑談】Fixture Talk', tags: [] });
    expect(await book.choose('youtube', 'fixture0001', 'horror')).toEqual({
      ok: true,
      value: { persisted: true },
    });
    expect(genreOf(book.get('youtube', 'fixture0001'))).toEqual({
      genre: 'horror',
      reason: 'viewer',
      relaxations: [],
    });
    // Another stream of the same streamer is detected on its own.
    expect(book.get('youtube', 'fixture0002')).toBeUndefined();
    book.observe('youtube', 'fixture0001', { title: '【歌枠】Fixture Karaoke' });
    expect(genreOf(book.get('youtube', 'fixture0001'))).toMatchObject({
      genre: 'horror',
      reason: 'viewer',
    });
    await book.choose('youtube', 'fixture0001', undefined);
    expect(genreOf(book.get('youtube', 'fixture0001'))).toMatchObject({
      genre: 'singing',
      reason: 'title',
    });
    expect(await read()).toEqual([
      {
        site: 'youtube',
        stream: 'fixture0001',
        genre: 'singing',
        reason: 'title',
        relaxations: [],
      },
    ]);
    // A choice for a stream the page never described is kept too.
    await book.choose('twitch', 'newchannel', 'chat');
    expect(genreOf(book.get('twitch', 'newchannel'))).toMatchObject({
      genre: 'chat',
      reason: 'viewer',
    });
  });

  it('says when a choice could not be saved, and keeps it for the session', async () => {
    const book = createGenreBook(fakeBrowser.storage.local);
    await book.load();
    vi.spyOn(fakeBrowser.storage.local, 'set').mockRejectedValue(new Error('quota'));
    expect(await book.choose('youtube', 'fixture0001', 'fps')).toEqual({
      ok: true,
      value: { persisted: false },
    });
    expect(genreOf(book.get('youtube', 'fixture0001'))).toMatchObject({
      genre: 'fps',
      reason: 'viewer',
    });
  });

  it(`keeps the newest ${MAX_STREAM_GENRES} streams, in memory and in storage`, async () => {
    const book = createGenreBook(fakeBrowser.storage.local);
    await book.load();
    for (let i = 0; i <= MAX_STREAM_GENRES; i += 1)
      book.observe('youtube', `video${i}`, { title: '【雑談】Fixture Talk' });
    expect(book.get('youtube', 'video0')).toBeUndefined();
    expect(book.get('youtube', `video${MAX_STREAM_GENRES}`)).toBeDefined();
    await vi.waitFor(async () => {
      const stored = (await read()) as { stream: string }[];
      expect(stored).toHaveLength(MAX_STREAM_GENRES);
      expect(stored.at(-1)?.stream).toBe(`video${MAX_STREAM_GENRES}`);
    });
  });

  it('skips unreadable saved entries and keeps what was learned before the read', async () => {
    await fakeBrowser.storage.local.set({
      [STREAM_GENRES_KEY]: [
        {
          site: 'youtube',
          stream: 'fixture0001',
          genre: 'horror',
          reason: 'game',
          relaxations: [],
        },
        { site: 'youtube', stream: 'broken', genre: 'not-a-genre', reason: 'game' },
        'junk',
      ],
    });
    const book = createGenreBook(fakeBrowser.storage.local);
    book.observe('youtube', 'fixture0002', { title: '【雑談】Fixture Talk' });
    await book.load();
    expect(genreOf(book.get('youtube', 'fixture0001'))).toMatchObject({
      genre: 'horror',
      reason: 'game',
    });
    expect(book.get('youtube', 'broken')).toBeUndefined();
    expect(genreOf(book.get('youtube', 'fixture0002'))).toMatchObject({ genre: 'chat' });
  });

  it('gives no classification for a stream it does not know', () => {
    expect(genreOf(undefined)).toBeUndefined();
  });
});
