import {
  createLruCache,
  RELAXABLE_CATEGORIES,
  streamCategories,
  type RelaxableCategory,
  type StreamCategory,
  type StreamGenre,
} from '@chrome-toolbox/extension-core';
import type { Site } from './sites/types.ts';

/** Streams the service worker remembers, the most recent first. */
export const MAX_STREAMS = 16;
/** Characters of a streamer key read from a page (a YouTube handle or channel id, a login). */
export const MAX_STREAMER = 128;
/** Characters of a stream title read from a page; it goes into every batch prompt. */
export const MAX_TITLE = 200;
/** Characters of the game a page names (YouTube's game card, Twitch's category slug). */
export const MAX_GAME = 100;
/** Twitch tags read from a page, and characters of each (Twitch allows 10 of 25). */
export const MAX_TAGS = 10;
export const MAX_TAG = 25;
/** Characters of the rules read from a stream's description (お約束 and the like). */
export const MAX_RULES = 1000;
/**
 * A YouTube video's comments are their own store partition, `<videoId>#comments`, in the
 * stream `<videoId>` of its chat (and chat replay).
 */
export const COMMENTS_SUFFIX = '#comments';

/**
 * What a page shows about its stream; any part may be missing. The game, the tags and the
 * description's rules decide its genre (R63), and only a page with the title shows them.
 */
export type StreamInfo = Readonly<{
  streamer?: string | undefined;
  title?: string | undefined;
  /** YouTube's game card, or Twitch's category slug. */
  game?: string | undefined;
  /** Twitch's tags. */
  tags?: readonly string[] | undefined;
  /** The rules sections of a YouTube description (`rulesOf`). */
  rules?: string | undefined;
}>;
/**
 * Why a detected stream has its genre (R63, R68), in the order that decides it: the title's 【】,
 * Twitch's tags, the description's rules or the game name it, the model guessed it once, or
 * nothing did (`other`).
 */
export const DETECTED_REASONS = ['title', 'tags', 'rules', 'game', 'guess', 'none'] as const;
export type DetectedReason = (typeof DETECTED_REASONS)[number];
/** Why a stream has its genre: the viewer chose it for the stream, or it was detected. */
export const GENRE_REASONS = ['viewer', ...DETECTED_REASONS] as const;
export type GenreReason = (typeof GENRE_REASONS)[number];
/**
 * One stream: its site, its partition (`<videoId>` on YouTube, the channel login on Twitch),
 * the streamer and title a page reported, the stream's spoiler note from the side panel, and
 * what kind of stream it is with the stream categories its own rules turn off (R62).
 */
export type StreamContext = Readonly<{
  site: Site;
  partition: string;
  streamer?: string | undefined;
  title?: string | undefined;
  spoilerNote?: string | undefined;
  /** The stream's genre as given (`classify`, R63: detected or chosen); `other` while absent. */
  genre?: StreamGenre | undefined;
  /**
   * The stream categories the stream's own rules turn off, as given with the genre (`classify`);
   * the title's own words turn them off too (`streamCategoriesOf`). Absent when none were given.
   */
  relaxations?: readonly RelaxableCategory[] | undefined;
}>;
/** What kind of stream it is and what its own rules relax (R62), as `classify` takes it. */
export type StreamGenreInfo = Readonly<{
  genre: StreamGenre;
  relaxations: readonly RelaxableCategory[];
}>;

/** The stream a store partition belongs to: the part before `#` (`<videoId>#comments` → `<videoId>`). */
export const streamOf = (partition: string): string => partition.split('#', 1)[0] ?? partition;
/** The partitions of one stream: on YouTube its chat and its video comments. */
export const partitionsOf = (context: Pick<StreamContext, 'site' | 'partition'>): string[] => {
  const stream = streamOf(context.partition);
  return context.site === 'youtube' ? [stream, `${stream}${COMMENTS_SUFFIX}`] : [stream];
};
/**
 * The key a stream's filters and feedback (allowlist, corrections, threshold) are kept under:
 * its streamer, so they follow the streamer from stream to stream, or while the streamer is
 * unknown (a popout without its watch page), the stream itself.
 */
export const ownerOf = (context: Pick<StreamContext, 'partition' | 'streamer'>): string =>
  context.streamer ?? streamOf(context.partition);

/**
 * The stream context as batch prompts carry it (in the per-channel user turn, never in the
 * fixed system turn): the title for names and the viewer's spoiler targets. Empty when neither
 * is known.
 */
export function contextText(context: StreamContext): string {
  return [
    ...(context.title === undefined ? [] : [`Title: ${context.title}`]),
    ...(context.spoilerNote === undefined ? [] : [`Spoiler targets: ${context.spoilerNote}`]),
  ].join('\n');
}

/**
 * A Japanese word that negates or bans what precedes it, after `は` or `も` too: `ネタバレOKじゃない`,
 * `指示OKではありません`, `参加型なし`, `参加型ありません`, `参加型はなし`, `ネタバレ有無`, `ネタバレ禁止`,
 * `アドバイス歓迎しない`; or a negated verb later in the same clause (up to 10 characters, before
 * any 、。！？・/ or bracket): `参加型やってません`, `参加型は行っておりません`, `指示OKな日ではありません`,
 * `参加型はやらないです`. `ないで` that invites (`遠慮しないでね`) is no negation.
 */
const JA_NOT = String.raw`(?![\s　]*(?:[はも][\s　]*)?(?:じゃ|では|ない|なし|無|禁止|ません|しない|しません|(?:あり|有り?)ません|ng|×|✕))(?![^\n、。,.!！?？・|｜/／【】[\]()（）]{0,10}?(?:ません|ない(?!よう|で(?!す))|なし|無し|禁止|お断り))`;
/**
 * An English negation that governs the phrase: right before it (`no spoilers allowed`, `don't
 * backseat me`, `do not backseat me`, `never backseat me`) or before one word that narrows it
 * (`no major spoilers allowed`). Another word between them ends its reach: `no worries spoilers
 * ok` allows spoilers.
 */
const EN_NOT = String.raw`(?<!\b(?:no|not|never|don[’']?t|doesn[’']?t)[\s-]+(?:(?:major|minor|big|huge|any|more|story|plot|game|late|endgame|ending|unmarked)[\s-]+)?)`;
/**
 * Words of a stream's own rules (its title, its description's rules and its Twitch tags, R63)
 * that turn a stream category off (R62), after NFKC (full-width `ＯＫ`, `２`) and in lower case:
 * - instruction: 参加型, アドバイス歓迎/OK, 指示OK/歓迎, "backseat me", "backseating
 *   welcome/allowed/ok";
 * - spoiler: ネタバレあり/有り/OK/歓迎/解禁, 2周目 (or 二周目), "spoilers ok/allowed/welcome".
 * A rule that forbids something never relaxes it: a Japanese negation or ban right after the
 * word (`JA_NOT`), an English one before the phrase (`EN_NOT`; `spoilers not ok` and
 * `backseating is not ok` do not match at all). Bans and warnings (ネタバレ禁止, ネタバレ注意,
 * 指示NG, NoBackseating, 指示厨お断り) and a game named after spoilers (`ネタバレが激しすぎるRPG`)
 * relax nothing.
 */
const RELAXATION_WORDS: Readonly<Record<RelaxableCategory, RegExp>> = {
  instruction: new RegExp(
    [
      `参加型${JA_NOT}`,
      `アドバイス(?:大?歓迎|ok)${JA_NOT}`,
      `指示(?:ok|大?歓迎)${JA_NOT}`,
      String.raw`${EN_NOT}\bbackseat me\b`,
      String.raw`${EN_NOT}\bbackseat(?:ing)? (?:is )?(?:welcome|allowed|ok)\b`,
    ].join('|'),
    'u',
  ),
  spoiler: new RegExp(
    [
      // `有(?!り)`: `有りません` must not match its first character alone.
      `ネタバレ(?:あり|有り|有(?!り)|ok|大?歓迎|解禁)${JA_NOT}`,
      `[2二]周目${JA_NOT}`,
      String.raw`${EN_NOT}\bspoilers? (?:are |is )?(?:ok|allowed|welcome)\b`,
    ].join('|'),
    'u',
  ),
};
/**
 * The stream categories a text of the stream's own rules turns off (R62), in order: the title
 * (`streamCategoriesOf`), the description's rules and each Twitch tag (`pageRelaxations`).
 */
export const relaxationsIn = (text: string): RelaxableCategory[] => {
  const normalized = text.normalize('NFKC').toLowerCase();
  return RELAXABLE_CATEGORIES.filter((category) => RELAXATION_WORDS[category].test(normalized));
};
/**
 * The stream categories a stream has on (R62): its genre (`other` while unknown), the
 * relaxations given for it and the ones its title names (`relaxationsIn`), and whether the
 * viewer wrote spoiler targets for it.
 */
export function streamCategoriesOf(context: StreamContext): StreamCategory[] {
  const named = relaxationsIn(context.title ?? '');
  return streamCategories({
    genre: context.genre ?? 'other',
    relaxations: [...(context.relaxations ?? []), ...named],
    spoilerTargets: context.spoilerNote !== undefined,
  });
}

/** A short key for a context text (32-bit FNV-1a, 8 hex digits); the text cache keys by it. */
export function contextHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export type StreamContexts = {
  /**
   * Merges what a page reported about the stream of `partition` (a missing field keeps what is
   * known) and returns the stream's context and whether it changed.
   */
  report(
    this: void,
    site: Site,
    partition: string,
    info: StreamInfo,
  ): { context: StreamContext; changed: boolean };
  /**
   * Sets what kind of stream `partition` belongs to and what its own rules relax (R62); returns
   * the stream's context and whether the genre or the relaxations changed. The service worker
   * gives what it detected or the viewer chose (R63, `genre.ts`); until then a stream is `other`,
   * relaxed only by its title (`streamCategoriesOf`).
   */
  classify(
    this: void,
    site: Site,
    partition: string,
    info: StreamGenreInfo,
  ): { context: StreamContext; changed: boolean };
  /**
   * The context of the stream `partition` belongs to, with the stream's spoiler note when one is
   * known. An unknown stream gets one with neither streamer nor title, which is not kept.
   */
  get(this: void, site: Site, partition: string): StreamContext;
  /** Whether the saved spoiler notes were given (`setNotes`) since the start or `clear`. */
  notesKnown(this: void): boolean;
  /** Every stream's spoiler note, keyed `<site>:<stream>` (as `spoilerNotesOf` reads them). */
  setNotes(this: void, notes: ReadonlyMap<string, string>): void;
  clear(this: void): void;
};

type Known = {
  streamer?: string;
  title?: string;
  genre?: StreamGenre;
  relaxations?: readonly RelaxableCategory[];
};

/**
 * The streams pages reported (the newest `MAX_STREAMS`) and the viewer's spoiler notes, which
 * belong to one stream each (R30). The live chat frame knows only its video; the watch page,
 * in the same or another tab, names the streamer and title of that video here.
 */
export function createStreamContexts(): StreamContexts {
  const streams = createLruCache<string, Known>({ max: MAX_STREAMS });
  let notes: ReadonlyMap<string, string> | undefined;
  const keyOf = (site: Site, name: string): string => `${site}:${name}`;
  function contextOf(site: Site, stream: string, known: Known | undefined): StreamContext {
    const { relaxations = [], ...rest } = known ?? {};
    const base: StreamContext = {
      site,
      partition: stream,
      ...rest,
      ...(relaxations.length === 0 ? {} : { relaxations }),
    };
    const note = notes?.get(keyOf(site, stream));
    return note ? { ...base, spoilerNote: note } : base;
  }
  return {
    report(site, partition, info) {
      const stream = streamOf(partition);
      const key = keyOf(site, stream);
      const before = streams.get(key);
      const after: Known = {
        ...before,
        ...(info.streamer === undefined ? {} : { streamer: info.streamer }),
        ...(info.title === undefined ? {} : { title: info.title }),
      };
      streams.set(key, after);
      const changed =
        before === undefined || before.streamer !== after.streamer || before.title !== after.title;
      return { context: contextOf(site, stream, after), changed };
    },
    classify(site, partition, info) {
      const stream = streamOf(partition);
      const key = keyOf(site, stream);
      const before = streams.get(key);
      const relaxations = RELAXABLE_CATEGORIES.filter((category) =>
        info.relaxations.includes(category),
      );
      const after: Known = { ...before, genre: info.genre, relaxations };
      streams.set(key, after);
      const changed =
        before?.genre !== after.genre || (before?.relaxations ?? []).join() !== relaxations.join();
      return { context: contextOf(site, stream, after), changed };
    },
    get(site, partition) {
      const stream = streamOf(partition);
      return contextOf(site, stream, streams.get(keyOf(site, stream)));
    },
    notesKnown: () => notes !== undefined,
    setNotes(next) {
      notes = next;
    },
    clear() {
      streams.clear();
      notes = undefined;
    },
  };
}
