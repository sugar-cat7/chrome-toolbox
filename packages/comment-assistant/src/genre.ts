import { z } from 'zod/mini';
import { capture, decode, launch, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  commentRecordSchema,
  createLruCache,
  RELAXABLE_CATEGORIES,
  STREAM_GENRES,
  streamGenreSchema,
  type RelaxableCategory,
  type StorageArea,
  type StreamGenre,
} from '@chrome-toolbox/extension-core';
import { GAME_GENRES } from './game-genres.ts';
import { isRulesHeading } from './sites/rules.ts';
import type { Site } from './sites/types.ts';
import {
  contextHash,
  DETECTED_REASONS,
  MAX_GAME,
  relaxationsIn,
  streamOf,
  type DetectedReason,
  type GenreReason,
  type StreamInfo,
} from './stream-context.ts';

/** What decides a stream's genre and relaxations: what its page shows (R63, R68). */
export type GenreSource = Pick<StreamInfo, 'title' | 'game' | 'tags' | 'rules'>;
/** A genre and why it was given. */
export type Detected = Readonly<{ genre: StreamGenre; reason: DetectedReason }>;

/** The genres a word can name: every genre but `other`. */
type NamedGenre = Exclude<StreamGenre, 'other'>;
const NAMED_GENRES = STREAM_GENRES.filter((genre): genre is NamedGenre => genre !== 'other');
/**
 * The words that name a kind of stream (R63), after NFKC and in lower case. Traps: a frame rate
 * is no FPS (`120fps`), a chat stream run against the clock no RTA (`雑談配信RTA`, `雑談配信 RTA`), concurrent
 * viewers no watch-along (`同時視聴者`), and a simulcast (`Twitch同時配信`) has no word here.
 * `ウォッチパーティー` is a sports or esports viewing (R62); Twitch's Watch Parties category is a
 * watch-along (`GAME_GENRES`), which turns on the same categories.
 */
const GENRE_WORDS: Readonly<Record<NamedGenre, RegExp>> = {
  fps: /\b(?:fps|tps|pvp)\b|バトロワ|バトルロ[イワ]イヤル|格ゲー|格闘ゲーム|ランクマ/u,
  story: /\b[aj]?rpg\b|ストーリー|アドベンチャー|ノベルゲー/u,
  horror: /ホラ[ーゲ]|\bhorror\b/u,
  puzzle_rta: /(?<!配信\s*)\brta\b|\bspeedrun|スピードラン|パズル|謎解き|脱出ゲーム|\bpuzzle/u,
  chat: /雑談|\bzatsudan\b|フリートーク|\bfree ?talk\b|\b(?:just ?)?chatting\b|おしゃべり|マシュマロ/u,
  singing: /歌枠|\butawaku\b|歌配信|カラオケ|\bkaraoke\b|弾き語り|\bsinging\b|アカペラ/u,
  watchalong: /同時視聴(?!者)|同時試聴|\bwatch[ -]?along\b/u,
  sports_viewing: /観戦|ウォッチパーティ|\bwatch ?party\b|パブリックビューイング/u,
  board:
    /麻雀|マージャン|雀魂|じゃんたま|ボドゲ|ボードゲーム|\bboard ?games?\b|カードゲーム|\btcg\b|将棋|囲碁|チェス|\bchess\b|ポーカー|\bpoker\b/u,
  deduction: /人狼|\bwerewolf\b|マーダーミステリー|マダミス|アモアス|\bamong ?us\b/u,
};
const normalized = (text: string): string => text.normalize('NFKC').toLowerCase();
/** The one genre the words of `text` name; undefined for none or several. */
function soleGenre(text: string): StreamGenre | undefined {
  const named = NAMED_GENRES.filter((genre) => GENRE_WORDS[genre].test(text));
  return named.length === 1 ? named[0] : undefined;
}

/** A title's bracketed parts: 【】, 〖〗 and [] (full-width ［］ after NFKC). */
const BRACKETS = /【([^【】]*)】|〖([^〖〗]*)〗|\[([^[\]]*)\]/gu;
/**
 * The genre the words in a title's 【】 name (R68 step 2); words outside them do not count (a
 * title's prose often names other things), and two genres decide nothing.
 */
export function titleGenre(title: string): StreamGenre | undefined {
  const parts = [...normalized(title).matchAll(BRACKETS)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
  return soleGenre(parts.join('\n'));
}
/** A line of the description's rules about this stream: この配信, 本配信, 今日の配信, 今回. */
const THIS_STREAM = /この配信|本配信|今日の配信|今回/u;
/**
 * A rule that bans or restrains something is about the viewers, not the stream (`リスナー同士の
 * 雑談はお控えください`, `他の方の歌枠の話はNG`); one that sets a condition, negates or speaks of
 * another stream is not about this one (`歌枠ではリクエストは受け付けていません`, `ホラーが苦手な
 * 方は`, `この配信以外の`). Their words name no genre. The heading words 禁止事項 and 注意事項 are
 * no restraint of their own.
 */
const ASIDE =
  /禁止|控え|遠慮|やめ|止め|ないで|ダメ|だめ|お断り|厳禁|不可|\bng\b|×|✕|❌|🚫|\bno\b|\bnot\b|\bdon[’']?t\b|では|の時|のとき|の際|場合|苦手|注意|ません|ない|以外|他の/u;
const HEADING_WORDS = /禁止事項|注意事項/gu;
/**
 * The genre the description's rules name (R68 step 3): only in a heading of the rules (`【歌枠の
 * お約束】`) or a line about this stream (`今回はホラーゲームを遊びます`), never in a line that
 * restrains, sets a condition, negates or speaks of another stream (`ASIDE`). A channel's
 * standard rules thus seldom name one.
 */
function rulesGenre(rules: string): StreamGenre | undefined {
  const lines = rules.split('\n').filter((line) => {
    const text = normalized(line);
    return (
      (isRulesHeading(line) || THIS_STREAM.test(text)) &&
      !ASIDE.test(text.replace(HEADING_WORDS, ''))
    );
  });
  return soleGenre(normalized(lines.join('\n')));
}
/** The genre Twitch's tags name, each tag on its own. */
const tagsGenre = (tags: readonly string[]): StreamGenre | undefined =>
  soleGenre(tags.map(normalized).join('\n'));

/**
 * A game name as `GAME_GENRES` matches it: NFKC, lower case, letters and digits only (`Apex
 * Legends`, `apex-legends` and `ＡＰＥＸ ＬＥＧＥＮＤＳ` are one game).
 */
export const gameKey = (name: string): string => normalized(name).replace(/[^\p{L}\p{N}]+/gu, '');
const GAME_INDEX: ReadonlyMap<string, StreamGenre> = new Map(
  GAME_GENRES.flatMap((entry) => entry.names.map((name) => [gameKey(name), entry.genre] as const)),
);
/** The genre of a game YouTube's card or Twitch's category names (R68 step 4), when listed. */
export const gameGenre = (game: string): StreamGenre | undefined => {
  const key = gameKey(game);
  return key === '' ? undefined : GAME_INDEX.get(key);
};

/**
 * The genre what the page shows decides, in this order (R68, which put the title before the
 * description of R63): the title's 【】, Twitch's tags, the description's rules, the game.
 * Undefined when none decides: the stream's one guess comes next (step 5), then `other`.
 */
export function detectGenre(source: GenreSource): Detected | undefined {
  const steps: readonly [DetectedReason, () => StreamGenre | undefined][] = [
    ['title', () => (source.title === undefined ? undefined : titleGenre(source.title))],
    ['tags', () => (source.tags === undefined ? undefined : tagsGenre(source.tags))],
    ['rules', () => (source.rules === undefined ? undefined : rulesGenre(source.rules))],
    ['game', () => (source.game === undefined ? undefined : gameGenre(source.game))],
  ];
  for (const [reason, step] of steps) {
    const genre = step();
    if (genre !== undefined) return { genre, reason };
  }
  return undefined;
}
/**
 * The stream categories the description's rules and Twitch's tags turn off (R62), read like a
 * title (`relaxationsIn`, negation-safe), each tag on its own. The title's own are read from the
 * title whenever its categories are (`streamCategoriesOf`).
 */
export function pageRelaxations(source: GenreSource): RelaxableCategory[] {
  const found = [source.rules ?? '', ...(source.tags ?? [])].flatMap(relaxationsIn);
  return RELAXABLE_CATEGORIES.filter((category) => found.includes(category));
}

/**
 * Extension storage key of every stream's genre: one list, the newest last, so it stays
 * bounded. Only the service worker writes it.
 */
export const STREAM_GENRES_KEY = 'streamGenres';
/** Streams whose genre is kept, the most recently changed ones. */
export const MAX_STREAM_GENRES = 100;
const genreRecordSchema = z.strictObject({
  site: commentRecordSchema.shape.site,
  /** The stream: the YouTube video id, the Twitch login. */
  stream: z.string().check(z.minLength(1), z.maxLength(256)),
  /** What the page decided, else the guess, else `other` (`none`). */
  genre: streamGenreSchema,
  reason: z.enum(DETECTED_REASONS),
  /** What the description's rules and Twitch's tags relax. */
  relaxations: z.array(z.enum(RELAXABLE_CATEGORIES)),
  /** The game the page names: the guess reads it. */
  game: z.optional(z.string().check(z.maxLength(MAX_GAME))),
  /** The model's one guess for the stream, kept whatever decides later. */
  guess: z.optional(streamGenreSchema),
  /** On Twitch, the category and the title (`contextHash`) the guess was made for (R69). */
  guessGame: z.optional(z.string().check(z.maxLength(MAX_GAME))),
  guessTitle: z.optional(z.string().check(z.maxLength(16))),
  /** The genre the viewer chose for the stream. */
  override: z.optional(streamGenreSchema),
  /** On Twitch, the category the viewer chose it under (R69). */
  overrideGame: z.optional(z.string().check(z.maxLength(MAX_GAME))),
});
/** One stream's genre as kept (R63): detected, guessed once and chosen by the viewer. */
export type GenreRecord = Readonly<z.infer<typeof genreRecordSchema>>;
/** The genre a stream has, why, and what its rules and tags relax. */
export type Classification = Readonly<{
  genre: StreamGenre;
  reason: GenreReason;
  relaxations: readonly RelaxableCategory[];
}>;
/** The genre in effect: the viewer's choice, else the detected one; undefined for none kept. */
export function genreOf(record: GenreRecord | undefined): Classification | undefined {
  if (record === undefined) return undefined;
  const { relaxations } = record;
  return record.override === undefined
    ? { genre: record.genre, reason: record.reason, relaxations }
    : { genre: record.override, reason: 'viewer', relaxations };
}
/** The readable entries of a stored list, oldest first. */
function entriesOf(value: unknown): GenreRecord[] {
  return (Array.isArray(value) ? value : []).flatMap((item: unknown) => {
    const entry = decode(genreRecordSchema, item);
    return entry.ok ? [entry.value] : [];
  });
}
const same = (a: GenreRecord, b: GenreRecord): boolean =>
  a.genre === b.genre &&
  a.reason === b.reason &&
  a.game === b.game &&
  a.guess === b.guess &&
  a.guessGame === b.guessGame &&
  a.guessTitle === b.guessTitle &&
  a.override === b.override &&
  a.overrideGame === b.overrideGame &&
  a.relaxations.join() === b.relaxations.join();
/** A title as a guess remembers it: a short hash, not the title. */
const titleKey = (title: string | undefined): string => contextHash(title ?? '');
/**
 * Whether the viewer's choice and the guess still hold for what the page shows (R69). On
 * YouTube a stream is one video: they hold for it. A Twitch login streams many broadcasts, so a
 * choice holds while the category it was made under lasts, and a guess while its category lasts
 * and, under a category the table does not list (which the guess stands in for), its title.
 */
const choiceHolds = (site: Site, record: GenreRecord, source: GenreSource): boolean =>
  site !== 'twitch' || record.overrideGame === source.game;
const guessHolds = (site: Site, record: GenreRecord, source: GenreSource): boolean =>
  site !== 'twitch' ||
  (record.guessGame === source.game &&
    ((source.game !== undefined && gameGenre(source.game) !== undefined) ||
      record.guessTitle === titleKey(source.title)));
/** The guess of a record with what it was made for. */
const guessOf = ({ guess, guessGame, guessTitle }: GenreRecord): Partial<GenreRecord> => ({
  ...(guess === undefined ? {} : { guess }),
  ...(guessGame === undefined ? {} : { guessGame }),
  ...(guessTitle === undefined ? {} : { guessTitle }),
});
/** The viewer's choice of a record with what it was made under. */
const choiceOf = ({ override, overrideGame }: GenreRecord): Partial<GenreRecord> => ({
  ...(override === undefined ? {} : { override }),
  ...(overrideGame === undefined ? {} : { overrideGame }),
});

export type GenreBook = {
  /** Reads the saved genres once; unreadable ones count as none. Resolves once they are known. */
  load(this: void): Promise<Result<void>>;
  /** The kept genre of the stream `partition` belongs to. */
  get(this: void, site: Site, partition: string): GenreRecord | undefined;
  /**
   * Detects the genre again from what the page shows (`detectGenre`, else the stream's guess,
   * else `other`) and its relaxations; on Twitch a choice or a guess made for another category
   * (or a guess for another title under an unlisted one) goes (R69). Returns whether the kept
   * record changed (it is saved).
   */
  observe(this: void, site: Site, partition: string, source: GenreSource): boolean;
  /**
   * What the stream's one guess reads (its title and game), when it needs one: nothing decided
   * its genre, it was never guessed (or its guess went, R69), the viewer chose none and its
   * title or game is known. Asked once per stream, title and game in a service worker; a guess
   * that got no answer is not kept, so a later service worker may ask again.
   */
  guessInput(
    this: void,
    site: Site,
    partition: string,
    title: string | undefined,
  ): GenreSource | undefined;
  /**
   * Keeps the stream's guess for what it was asked from (`guessInput`), which decides while
   * nothing else does; on Twitch not when the page shows another category or title by now (R69).
   * Returns whether the record changed.
   */
  guessed(
    this: void,
    site: Site,
    partition: string,
    genre: StreamGenre,
    asked: GenreSource,
  ): boolean;
  /**
   * The viewer's genre for the stream, or none (`undefined`): in effect at once whatever the
   * storage does, on Twitch while the category shown now lasts (R69); `persisted: false` when it
   * could not be saved.
   */
  choose(
    this: void,
    site: Site,
    partition: string,
    genre: StreamGenre | undefined,
  ): Promise<Result<{ persisted: boolean }>>;
};

/**
 * Every stream's genre (R63, R69) under `STREAM_GENRES_KEY` in `area` and in memory, the newest
 * `MAX_STREAM_GENRES`: a restarted service worker or a stream back after its context was
 * evicted keeps its genre, its guess and the viewer's choice. Each write reads the saved list
 * and replaces the stream's entry, one write after another.
 */
export function createGenreBook(area: StorageArea): GenreBook {
  const records = new Map<string, GenreRecord>();
  /** Streams, titles and games whose guess was handed out in this service worker. */
  const asked = createLruCache<string, true>({ max: MAX_STREAM_GENRES });
  /** The title each stream's page showed last (`titleKey`): a guess for another is stale. */
  const titles = createLruCache<string, string>({ max: MAX_STREAM_GENRES });
  let reading: Promise<Result<void>> | undefined;
  let writing: Promise<Result<void>> = Promise.resolve(Ok(undefined));
  const keyOf = (site: Site, stream: string): string => `${site}:${stream}`;
  function remember(record: GenreRecord): void {
    const key = keyOf(record.site, record.stream);
    records.delete(key);
    records.set(key, record);
    for (const oldest of records.keys()) {
      if (records.size <= MAX_STREAM_GENRES) break;
      records.delete(oldest);
    }
  }
  async function saved(): Promise<Result<GenreRecord[]>> {
    const stored = await capture(() => area.get(STREAM_GENRES_KEY), 'storage_failed');
    return stored.ok ? Ok(entriesOf(stored.value[STREAM_GENRES_KEY])) : stored;
  }
  function persist(record: GenreRecord): Promise<Result<void>> {
    const write = async (): Promise<Result<void>> => {
      const list = await saved();
      if (!list.ok) return list;
      const others = list.value.filter(
        (entry) => entry.site !== record.site || entry.stream !== record.stream,
      );
      const next = [...others, record].slice(-MAX_STREAM_GENRES);
      const written = await capture(
        () => area.set({ [STREAM_GENRES_KEY]: next }),
        'storage_failed',
      );
      return written.ok ? Ok(undefined) : written;
    };
    writing = writing.then(write);
    return writing;
  }
  /** Keeps `after` and saves it when it differs from `before`; returns whether it did. */
  function update(before: GenreRecord | undefined, after: GenreRecord): boolean {
    if (before !== undefined && same(before, after)) return false;
    remember(after);
    // A failed write keeps the record for the session; the next change writes it again.
    launch(
      async () => void (await persist(after)),
      () => undefined,
    );
    return true;
  }
  return {
    load() {
      reading ??= (async (): Promise<Result<void>> => {
        const list = await saved();
        if (!list.ok) return Ok(undefined);
        // What was learned before the read is newer than what it read.
        const learned = [...records.values()];
        records.clear();
        for (const record of [...list.value, ...learned]) remember(record);
        return Ok(undefined);
      })();
      return reading;
    },
    get: (site, partition) => records.get(keyOf(site, streamOf(partition))),
    observe(site, partition, source) {
      const stream = streamOf(partition);
      const key = keyOf(site, stream);
      if (source.title !== undefined) titles.set(key, titleKey(source.title));
      const before = records.get(key);
      const guess =
        before !== undefined && guessHolds(site, before, source) ? before.guess : undefined;
      const detected: Detected =
        detectGenre(source) ??
        (guess === undefined
          ? { genre: 'other', reason: 'none' }
          : { genre: guess, reason: 'guess' });
      return update(before, {
        site,
        stream,
        ...detected,
        relaxations: pageRelaxations(source),
        ...(source.game === undefined ? {} : { game: source.game }),
        ...(before === undefined || guess === undefined ? {} : guessOf(before)),
        ...(before !== undefined && choiceHolds(site, before, source) ? choiceOf(before) : {}),
      });
    },
    guessInput(site, partition, title) {
      const key = keyOf(site, streamOf(partition));
      const record = records.get(key);
      if (
        record === undefined ||
        record.reason !== 'none' ||
        record.guess !== undefined ||
        record.override !== undefined ||
        (title === undefined && record.game === undefined)
      )
        return undefined;
      const question = `${key}\u0000${titleKey(title)}\u0000${record.game ?? ''}`;
      if (asked.get(question) !== undefined) return undefined;
      asked.set(question, true);
      return {
        ...(title === undefined ? {} : { title }),
        ...(record.game === undefined ? {} : { game: record.game }),
      };
    },
    guessed(site, partition, genre, question) {
      const key = keyOf(site, streamOf(partition));
      const before = records.get(key);
      // Forgotten meanwhile (a hundred newer streams): nothing to keep it for.
      if (before === undefined) return false;
      const twitch = site === 'twitch';
      // Asked for a category or title the Twitch page no longer shows: a new guess comes.
      const shown = titles.get(key);
      if (
        twitch &&
        (before.game !== question.game ||
          (shown !== undefined && shown !== titleKey(question.title)))
      )
        return false;
      return update(before, {
        ...before,
        guess: genre,
        ...(twitch
          ? {
              ...(question.game === undefined ? {} : { guessGame: question.game }),
              guessTitle: titleKey(question.title),
            }
          : {}),
        ...(before.reason === 'none' ? { genre, reason: 'guess' } : {}),
      });
    },
    async choose(site, partition, genre): Promise<Result<{ persisted: boolean }>> {
      const stream = streamOf(partition);
      const {
        override: _previous,
        overrideGame: _under,
        ...before
      } = records.get(keyOf(site, stream)) ?? {
        site,
        stream,
        genre: 'other',
        reason: 'none',
        relaxations: [],
      };
      // On Twitch the choice lasts while the category shown now does (R69).
      const under =
        site === 'twitch' && before.game !== undefined ? { overrideGame: before.game } : {};
      const after: GenreRecord =
        genre === undefined ? before : { ...before, override: genre, ...under };
      remember(after);
      const written = await persist(after);
      return Ok({ persisted: written.ok });
    },
  };
}
