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
import type { Site } from './sites/types.ts';
import {
  DETECTED_REASONS,
  MAX_GAME,
  relaxationsIn,
  streamOf,
  type DetectedReason,
  type GenreReason,
  type StreamInfo,
} from './stream-context.ts';

/** What decides a stream's genre and relaxations: what its page shows (R63). */
export type GenreSource = Pick<StreamInfo, 'title' | 'game' | 'tags' | 'rules'>;
/** A genre and why it was given. */
export type Detected = Readonly<{ genre: StreamGenre; reason: DetectedReason }>;

/** The genres a word can name: every genre but `other`. */
type NamedGenre = Exclude<StreamGenre, 'other'>;
const NAMED_GENRES = STREAM_GENRES.filter((genre): genre is NamedGenre => genre !== 'other');
/**
 * The words that name a kind of stream (R63), after NFKC and in lower case. Traps: a frame rate
 * is no FPS (`120fps`), a chat stream run against the clock no RTA (`雑談配信RTA`), concurrent
 * viewers no watch-along (`同時視聴者`), and a simulcast (`Twitch同時配信`) has no word here.
 * `ウォッチパーティー` is a sports or esports viewing (R62); Twitch's Watch Parties category is a
 * watch-along (`GAME_GENRES`), which turns on the same categories.
 */
const GENRE_WORDS: Readonly<Record<NamedGenre, RegExp>> = {
  fps: /\b(?:fps|tps|pvp)\b|バトロワ|バトルロ[イワ]イヤル|格ゲー|格闘ゲーム|ランクマ/u,
  story: /\b[aj]?rpg\b|ストーリー|アドベンチャー|ノベルゲー/u,
  horror: /ホラ[ーゲ]|\bhorror\b/u,
  puzzle_rta: /(?<!配信)\brta\b|\bspeedrun|スピードラン|パズル|謎解き|脱出ゲーム|\bpuzzle/u,
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
 * The genre the words in a title's 【】 name (R63 step 3); words outside them do not count (a
 * title's prose often names other things), and two genres decide nothing.
 */
export function titleGenre(title: string): StreamGenre | undefined {
  const parts = [...normalized(title).matchAll(BRACKETS)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
  return soleGenre(parts.join('\n'));
}
/**
 * A rule that bans or restrains something is about the viewers, not the stream (`リスナー同士の
 * 雑談はお控えください`, `他の方の歌枠の話はNG`): its words name no genre.
 */
const RESTRAINT =
  /禁止|控え|遠慮|やめ|止め|ないで|ダメ|だめ|お断り|厳禁|不可|\bng\b|×|✕|❌|🚫|\bno\b|\bnot\b|\bdon[’']?t\b/u;
/** The genre the description's rules name (R63 step 2), from the rules that restrain nothing. */
function rulesGenre(rules: string): StreamGenre | undefined {
  const lines = normalized(rules)
    .split('\n')
    .filter((line) => !RESTRAINT.test(line));
  return soleGenre(lines.join('\n'));
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
/** The genre of a game YouTube's card or Twitch's category names (R63 step 4), when listed. */
export const gameGenre = (game: string): StreamGenre | undefined => {
  const key = gameKey(game);
  return key === '' ? undefined : GAME_INDEX.get(key);
};

/**
 * The genre what the page shows decides, in this order (R63): the description's rules, the
 * title's 【】, Twitch's tags, the game. Undefined when none decides: the stream's one guess
 * comes next (step 5), then `other`.
 */
export function detectGenre(source: GenreSource): Detected | undefined {
  const steps: readonly [DetectedReason, () => StreamGenre | undefined][] = [
    ['rules', () => (source.rules === undefined ? undefined : rulesGenre(source.rules))],
    ['title', () => (source.title === undefined ? undefined : titleGenre(source.title))],
    ['tags', () => (source.tags === undefined ? undefined : tagsGenre(source.tags))],
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
  /** The genre the viewer chose for the stream. */
  override: z.optional(streamGenreSchema),
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
  a.override === b.override &&
  a.relaxations.join() === b.relaxations.join();

export type GenreBook = {
  /** Reads the saved genres once; unreadable ones count as none. Resolves once they are known. */
  load(this: void): Promise<Result<void>>;
  /** The kept genre of the stream `partition` belongs to. */
  get(this: void, site: Site, partition: string): GenreRecord | undefined;
  /**
   * Detects the genre again from what the page shows (`detectGenre`, else the stream's guess,
   * else `other`) and its relaxations; returns whether the kept record changed (it is saved).
   */
  observe(this: void, site: Site, partition: string, source: GenreSource): boolean;
  /**
   * What the stream's one guess reads (its title and game), when it needs one: nothing decided
   * its genre, it was never guessed, the viewer chose none and its title or game is known. Asked
   * once per stream in a service worker; a guess that got no answer is not kept, so a later
   * service worker may ask again.
   */
  guessInput(
    this: void,
    site: Site,
    partition: string,
    title: string | undefined,
  ): GenreSource | undefined;
  /** Keeps the stream's guess (it decides while nothing else does); returns whether it changed. */
  guessed(this: void, site: Site, partition: string, genre: StreamGenre): boolean;
  /**
   * The viewer's genre for the stream, or none (`undefined`): in effect at once whatever the
   * storage does; `persisted: false` when it could not be saved.
   */
  choose(
    this: void,
    site: Site,
    partition: string,
    genre: StreamGenre | undefined,
  ): Promise<Result<{ persisted: boolean }>>;
};

/**
 * Every stream's genre (R63) under `STREAM_GENRES_KEY` in `area` and in memory, the newest
 * `MAX_STREAM_GENRES`: a restarted service worker or a stream back after its context was
 * evicted keeps its genre, its guess and the viewer's choice. Each write reads the saved list
 * and replaces the stream's entry, one write after another.
 */
export function createGenreBook(area: StorageArea): GenreBook {
  const records = new Map<string, GenreRecord>();
  /** Streams whose guess was handed out in this service worker. */
  const asked = createLruCache<string, true>({ max: MAX_STREAM_GENRES });
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
      const before = records.get(keyOf(site, stream));
      const detected: Detected =
        detectGenre(source) ??
        (before?.guess === undefined
          ? { genre: 'other', reason: 'none' }
          : { genre: before.guess, reason: 'guess' });
      return update(before, {
        site,
        stream,
        ...detected,
        relaxations: pageRelaxations(source),
        ...(source.game === undefined ? {} : { game: source.game }),
        ...(before?.guess === undefined ? {} : { guess: before.guess }),
        ...(before?.override === undefined ? {} : { override: before.override }),
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
        (title === undefined && record.game === undefined) ||
        asked.get(key) !== undefined
      )
        return undefined;
      asked.set(key, true);
      return {
        ...(title === undefined ? {} : { title }),
        ...(record.game === undefined ? {} : { game: record.game }),
      };
    },
    guessed(site, partition, genre) {
      const before = records.get(keyOf(site, streamOf(partition)));
      // Forgotten meanwhile (a hundred newer streams): nothing to keep it for.
      if (before === undefined) return false;
      return update(before, {
        ...before,
        guess: genre,
        ...(before.reason === 'none' ? { genre, reason: 'guess' } : {}),
      });
    },
    async choose(site, partition, genre): Promise<Result<{ persisted: boolean }>> {
      const stream = streamOf(partition);
      const { override: _previous, ...before } = records.get(keyOf(site, stream)) ?? {
        site,
        stream,
        genre: 'other',
        reason: 'none',
        relaxations: [],
      };
      const after: GenreRecord = genre === undefined ? before : { ...before, override: genre };
      remember(after);
      const written = await persist(after);
      return Ok({ persisted: written.ok });
    },
  };
}
