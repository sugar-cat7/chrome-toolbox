import { z } from 'zod/mini';

/**
 * The comment categories, which stream turns on which of them (R62) and how a prompt defines
 * them. The prompts (`prompts.ts`) and the comment assistant's stream context read this policy;
 * nothing here builds a prompt.
 */
export const COMMENT_CATEGORIES = [
  'abusive',
  'spam',
  'spoiler',
  'question',
  'important',
  'chatter',
  'instruction',
  'relay',
  'ghosting',
  'privacy',
  'sensitive',
] as const;
export const commentCategorySchema = z.enum(COMMENT_CATEGORIES);
export type CommentCategory = z.infer<typeof commentCategorySchema>;
/**
 * The categories a stream turns on or off (R62), defined in its batch prompts' user turn and
 * allowed by their grammar only when on: spoilers (R31) and the genre categories. Every other
 * category is in every prompt.
 */
export const STREAM_CATEGORIES = [
  'spoiler',
  'instruction',
  'relay',
  'ghosting',
  'privacy',
  'sensitive',
] as const satisfies readonly CommentCategory[];
export type StreamCategory = (typeof STREAM_CATEGORIES)[number];
const STREAM_CATEGORY_SET: ReadonlySet<CommentCategory> = new Set(STREAM_CATEGORIES);
export const isStreamCategory = (category: CommentCategory): category is StreamCategory =>
  STREAM_CATEGORY_SET.has(category);
/** A category every prompt has. */
export type BaseCategory = Exclude<CommentCategory, StreamCategory>;

/**
 * The definition of each stream category, in the user turn of a stream that has it on (R62),
 * short and stated as principles: what the category needs, then the look-alikes that are not it
 * (a long list of exceptions primed the 4B model toward the category, fix round 2).
 */
export const STREAM_CATEGORY_DEFINITIONS = {
  spoiler:
    'states as fact what happens later in what the stream plays or watches (the spoiler targets in the stream context when it has them, else what the stream title names): story events, twists, deaths, the ending, a hidden answer, a result already seen on a faster broadcast, or a hint that something is coming ("この後〜する"). A guess, a hope or a belief about what will happen is not a spoiler.',
  instruction:
    'tells the streamer what to do in the game right now, unasked: an action, a route, a choice, a puzzle solution or a tile to discard ("左の通路を先に調べて", "ここは索子切って"). The streamer must be told to do something: reading the situation aloud, wishing for luck from the game (〜てくれ, 来い), cheers, shouts and questions are not instructions.',
  relay:
    'brings another streamer\'s stream into this chat: what someone else is doing or did on their stream, or "I came from X\'s stream" ("○○くんの配信ではこのボスもう倒してた", "○○ちゃんの所から来ました"). A name with さん, ちゃん or くん that the title does not name, playing or streaming on their own, is another streamer. Not relay: people named in the stream title, characters of the game or show, talk about this streamer, a neutral mention that another streamer exists or has played the same game, and a comparison of this streamer with another (that is sensitive).',
  ghosting:
    "gives the streamer, as fact, hidden information from a source they cannot see during a match: where opponents are or what they plan, seen on another stream or view; other players' hidden hands, waits or roles; or stream sniping (joining the streamer's match on purpose, or asking for their server to do so). A guess or a worry about what opponents hold, and a question about what just happened, are not ghosting.",
  privacy:
    'pries into or reveals private information the streamer has not made public: real name, face, age, address or where they live, school or workplace, family, partner or love life, or the person behind a VTuber: who they were before or a claim to recognize them (前世, 中の人, "声で誰だかわかる"). Only real people count: fictional and game characters are never privacy, whatever is said about them. Not privacy: ordinary questions about the stream, the game or the streamer\'s tastes and day, and the cast or characters of a game or show.',
  sensitive:
    'raises politics, religion or another divisive social issue, or baits the streamer into a statement on one (elections, parties, politicians, territorial disputes such as asking the streamer to say a region is or is not a country, wars, spreading a religion); compares the streamer with another named or identifiable streamer, or puts either down, whether the comparison is kind or not ("○○ちゃんより歌うまいね", "○○の方が面白かった"); makes sexual remarks, requests or advances to the streamer or another real person (their body, their voice described sexually, asking for outfits, poses or camera angles); or jokes about, provokes or baits on a real disaster, accident, death or tragedy (不謹慎). Not sensitive: games, films, songs or shows about war, politics or disasters, idol popularity votes (総選挙), national teams in sports, 神 as praise (神ゲー), a neutral mention that another streamer exists or has played the same game, and compliments that are not sexual ("声きれい").',
} as const satisfies Record<StreamCategory, string>;

/** What kind of stream it is (R62); `other` while unknown. Task G2 detects it. */
export const STREAM_GENRES = [
  'fps',
  'story',
  'horror',
  'puzzle_rta',
  'chat',
  'singing',
  'watchalong',
  'sports_viewing',
  'board',
  'deduction',
  'other',
] as const;
export const streamGenreSchema = z.enum(STREAM_GENRES);
export type StreamGenre = z.infer<typeof streamGenreSchema>;
/** Each genre as the prompt names it, after its id. */
export const GENRE_NAMES = {
  fps: 'FPS, battle royale, PvP or fighting game',
  story: 'story game, RPG or adventure',
  horror: 'horror game',
  puzzle_rta: 'puzzle game or speedrun (RTA)',
  chat: 'just chatting (雑談)',
  singing: 'singing stream (歌枠)',
  watchalong: 'watch-along of an anime, a film or a show (同時視聴)',
  sports_viewing: 'sports or esports viewing (観戦)',
  board: 'mahjong, board or card game',
  deduction: 'social deduction game (人狼, Among Us)',
  other: 'unknown',
} as const satisfies Record<StreamGenre, string>;
/** The stream categories a stream's own rules may turn off (R62): 【参加型】, ネタバレOK … */
export const RELAXABLE_CATEGORIES = [
  'instruction',
  'spoiler',
] as const satisfies readonly StreamCategory[];
export type RelaxableCategory = (typeof RELAXABLE_CATEGORIES)[number];
/** The stream categories every stream has on (R62). */
const ALWAYS_ON: ReadonlySet<StreamCategory> = new Set(['relay', 'privacy', 'sensitive']);
/** The genres in which each other stream category is on (R62), before relaxations. */
const ON_IN: Readonly<Partial<Record<StreamCategory, ReadonlySet<StreamGenre>>>> = {
  spoiler: new Set(['story', 'horror', 'puzzle_rta', 'watchalong', 'sports_viewing']),
  instruction: new Set(['fps', 'story', 'horror', 'puzzle_rta', 'board']),
  ghosting: new Set(['fps', 'board', 'deduction']),
};
/**
 * The stream categories a stream has on, in `STREAM_CATEGORIES` order (R62):
 * - relay, privacy and sensitive always;
 * - instruction in fps, story, horror, puzzle_rta and board streams, unless relaxed;
 * - ghosting in fps, board and deduction streams;
 * - spoiler with the viewer's spoiler targets (R31, R64), whatever the stream's rules say: the
 *   viewer asked for it. Without them in story, horror, puzzle_rta, watchalong and
 *   sports_viewing streams, unless relaxed.
 */
export function streamCategories(
  input: Readonly<{
    genre: StreamGenre;
    relaxations: readonly RelaxableCategory[];
    /** The viewer wrote spoiler targets for the stream. */
    spoilerTargets: boolean;
  }>,
): StreamCategory[] {
  const relaxed = (category: StreamCategory): boolean =>
    input.relaxations.some((relaxation) => relaxation === category);
  const on = (category: StreamCategory): boolean => {
    if (ALWAYS_ON.has(category)) return true;
    if (category === 'spoiler' && input.spoilerTargets) return true;
    return ON_IN[category]?.has(input.genre) === true && !relaxed(category);
  };
  return STREAM_CATEGORIES.filter(on);
}

/**
 * One line of a genre evaluation set (`test/fixtures/genre-eval/<genre>.jsonl`, R62): a made-up
 * comment, the genre of its stream and the category it should get there (no relaxation, no
 * spoiler note). The shape test and `pnpm bench:genre` read the sets with it.
 */
export const genreEvalLineSchema = z.strictObject({
  text: z.string().check(z.minLength(1), z.maxLength(200)),
  genre: streamGenreSchema,
  expected: commentCategorySchema,
});
export type GenreEvalLine = z.infer<typeof genreEvalLineSchema>;
