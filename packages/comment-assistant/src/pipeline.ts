import {
  capture,
  Err,
  failure,
  launch,
  Ok,
  type AppError,
  type Result,
} from '@chrome-toolbox/contracts';
import {
  channelLanguageGuess,
  commentBatchMaxTokens,
  commentBatchPrompt,
  commentLimits,
  createBatcher,
  cutByMaxTokens,
  createCommentStore,
  createLanguageMix,
  createLruCache,
  GENRE_MAX_TOKENS,
  genrePrompt,
  isAbusive,
  isStreamCategory,
  llmCategoryJudge,
  needsTranslation,
  parseCommentBatch,
  parseGenre,
  parsePlamoLine,
  parseSubtitleLine,
  PLAMO_TRANSLATE_MODEL,
  plamoLanguage,
  plamoTranslateRequest,
  scriptLanguageGuess,
  subtitleMaxTokens,
  subtitlePrompt,
  systemTimers,
  type ChatRequest,
  type CommentBatchItem,
  type CommentCategory,
  type CommentCorrection,
  type CommentRecord,
  type CommentStore,
  type LanguageDetector,
  type LanguageGuess,
  type LanguageMix,
  type LlamaClient,
  type LruCache,
  type StreamCategory,
  type StreamGenre,
  type Timers,
  type ToxicityJudge,
} from '@chrome-toolbox/extension-core';
import {
  createFeedbackStore,
  createHiddenLog,
  HIDDEN_CATEGORIES,
  type FeedbackStore,
  type HiddenLog,
} from './feedback.ts';
import {
  createTextCache,
  endsAsQuestion,
  hasAbuseCue,
  hasLink,
  isCopypasta,
  isEmoteChatter,
  mayBeQuestion,
  normalizeComment,
  trivialVerdict,
  unstretched,
  type CachedVerdict,
} from './fastpath.ts';
import type {
  Annotation,
  CommentStats,
  FeedbackVerdict,
  HiddenEntry,
  RawComment,
  Summary,
  SummaryWindow,
  VerdictSource,
} from './protocol.ts';
import { SUMMARY_WINDOWS } from './protocol.ts';
import {
  contextHash,
  contextText,
  ownerOf,
  streamCategoriesOf,
  type StreamContext,
} from './stream-context.ts';
import { createSubtitleYield } from './subtitle-yield.ts';
import { summarize } from './summary.ts';

/** A tab frame whose content script sent the comments; annotations go back to it. */
export type Target = Readonly<{ tabId: number; frameId: number }>;
/**
 * What an ingest took: comments accepted and dropped, and the code of the latest failed model
 * batch while it is the latest (stats `lastError`; the frame then does not wait for answers, R52).
 */
export type IngestReply = { accepted: number; dropped: number; lastError?: string };
type Site = CommentRecord['site'];
export type CommentPipeline = {
  /**
   * Takes new comments for processing; ids already seen are not inferred again. With `process:
   * false` (R44) they are only stored, without the model, Clef, a rule or an annotation. A stored
   * comment sent again with `process` (the default) is processed then, its record completed in
   * place. With `left` (the frame's chat left the viewer, R49) the channel's comments still
   * waiting for the model that no other frame shows are stored too; batches already running
   * finish. A new channel takes the place of the least recently processed one when 4 are kept;
   * comments only to be stored never evict a channel with comments waiting for or with the
   * model, nor one processed in the last minute (of channels never processed, the one that sent
   * comments longest ago goes first), and without room they are not stored: answered as
   * `dropped`, counted as `unstored` for their channel (R53, R55).
   */
  ingest(
    this: void,
    target: Target,
    input: Readonly<{
      site: Site;
      channel: string;
      process?: boolean | undefined;
      left?: boolean | undefined;
      /**
       * A comment marked `held` is one the frame keeps out of sight until it is judged (R52):
       * `batchOrder` takes it first while it can still be judged in time (R57).
       */
      comments: readonly RawComment[];
    }>,
  ): IngestReply;
  /** The channel's records; an unknown channel gets an empty store that is not kept. */
  store(this: void, site: Site, channel: string): CommentStore;
  stats(this: void, site: Site, channel: string): CommentStats;
  /**
   * The channel's hidden (abusive, spam or spoiler) comments, oldest first, of the newest 200;
   * ones marked `ok` are shown again and no longer listed.
   */
  hidden(this: void, site: Site, channel: string): HiddenEntry[];
  /**
   * Records the viewer's verdict on a hidden comment (`resource_missing` when it is not among
   * the channel's newest 200). `ok` shows it, and every other hidden copy of its text in the
   * channel without a verdict, again in every frame that got its annotation, also one that only
   * stored it (`override: 'show'`; the latest four of each kind, R50, R53) and,
   * through `feedback`, keeps the text visible in every stream of the streamer from then on
   * (the verdict is saved under `ownerOf` the stream context). The first verdict on a comment
   * wins: a later one, also on a copy restored with it, gets the first answer.
   * The verdict takes effect at once whatever the storage does; `persisted: false` means the
   * write failed (or the saved verdicts are not read yet) and the next write saves it.
   */
  review(
    this: void,
    site: Site,
    channel: string,
    id: string,
    verdict: FeedbackVerdict,
  ): Promise<Result<Reviewed>>;
  /**
   * The viewer cleared the feedback: hidden comments confirmed as `correct` can be judged
   * again. Comments shown again through `ok` stay shown and unlisted.
   */
  clearVerdicts(this: void): void;
  /**
   * The server's slot count (`/props` `total_slots`) is known: batches may then use every spare
   * slot (one stays for subtitles), never more than a caller-supplied `commentConcurrency`.
   */
  setServerSlots(this: void, totalSlots: number): void;
  /**
   * Runs `fn` on a comment slot of its own: the lowest one no batch or other `exclusive` holds.
   * While it runs, new batches use the other comment slots only. When every comment slot is
   * busy it waits: a slot freed by a batch goes to it before the batches that queued meanwhile,
   * but a slot freed by an `exclusive` goes to the waiting batches first, so two never run back
   * to back ahead of them (R36). A call with the `key` of one still waiting takes its place in
   * line, and the one replaced runs at once with an aborted signal. `signal` also aborts on
   * dispose (calls still waiting then run at once, aborted). A `spare` call (the genre guess,
   * R63) starts only on a slot that no waiting batch takes, the highest free one: batches never
   * wait for it to start, and slot 1 keeps the batch prompt's prefix where there are two.
   */
  exclusive<T>(
    this: void,
    fn: (slot: number, signal: AbortSignal) => Promise<T>,
    key?: string,
    options?: Readonly<{ spare?: boolean }>,
  ): Promise<T>;
  /**
   * The stream's genre as the model guesses it from its title and game (R63 step 5): one short
   * request on a spare comment slot (`exclusive`, never slot 0, which subtitles keep), with the
   * translation model; an answer outside the genre ids is `other`.
   */
  guessGenre(
    this: void,
    input: Readonly<{ title?: string | undefined; game?: string | undefined }>,
  ): Promise<Result<StreamGenre>>;
  /**
   * The channel's chat summary over the last `windowMinutes` (`summarize`), the model asked on
   * a slot of its own (`exclusive`, keyed by the channel: one summary of a channel waits at a
   * time, and a newer request, of any window, answers a waiting one with its counted parts).
   * Requests for the same channel and window share one run. While the channel's records are
   * unchanged (the same revision, bumped by every stored comment, in-place update and verdict)
   * and the window holds as many of them, the last summary is returned without the model; one
   * made without the model's answer is made again. The 8 most recent summaries are kept.
   */
  summary(
    this: void,
    site: Site,
    channel: string,
    windowMinutes: SummaryWindow,
  ): Promise<Result<Summary>>;
  /**
   * Cancels the running batches and summaries, drops all buffered comments and clears every
   * store and summary.
   */
  dispose(this: void): void;
};

/** llama-server slot of the first comment batch; subtitles use slot 0, a second batch slot 2. */
const FIRST_COMMENT_SLOT = 1;
/** Summaries kept for a request with no new records (a few channels × windows). */
const SUMMARY_CACHE_MAX = 8;
const MINUTE = 60_000;
/** Comment batches that may run at once, whatever the server reports. */
export const MAX_COMMENT_CONCURRENCY = 4;
/** A comment that waited this long without reaching the model is shown in the original (R19). */
const STALE_AFTER_MS = 8_000;
/** Channels kept at once; the least recently processed one goes for a new one (R53). */
const MAX_CHANNELS = 4;
/**
 * A channel processed this recently is never evicted for comments only to be stored (R53): a
 * chat in front that paused (a quiet minute, a scroll) keeps its records.
 */
const RECENTLY_PROCESSED_MS = 60_000;
/** Channels not kept whose comments could not be stored, for their `unstored` count (R55). */
const UNKEPT_MAX = 16;
/**
 * Comments that waited for the model whose first-annotation latency the median covers (R55):
 * the channel's latest 200.
 */
const LATENCY_WINDOW = 200;
/** The median (nearest rank) of `values`; undefined when empty. */
function median(values: readonly number[]): number | undefined {
  return quantile(values, 0.5);
}
/** A held line comes in at the latest this long after the page added it (R52). */
const HOLD_MS = 2000;
/** The content script sends a line at most this long after the page added it (its flush). */
const FLUSH_MS = 250;
/** A model batch, until the pipeline has measured one (R57). */
const TYPICAL_BATCH_MS = 450;
/** Completed model batches whose durations `holdWindowMs` looks at (R58). */
const BATCH_DURATIONS = 20;
/** The `share` quantile (nearest rank) of `values`; undefined when empty. */
function quantile(values: readonly number[], share: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * share) - 1];
}
/**
 * How long after it reached the service worker a held comment can still be judged before its
 * line comes in as it is (R57, R58, R59): 2,000 ms of the hold, less 250 ms of the content
 * script's flush, less the 90th percentile (nearest rank) of the latest model batches' durations
 * (`durations`, from a batch's start to its reply, Clef included; 450 ms until one is measured,
 * which gives 1,300 ms), within 0 to 1,750 ms. Not the median: with durations that vary, as a
 * server's do, a median window kept choosing lines a slow batch could no longer answer in time
 * and lost to newest first under overload (the review's simulation, R59).
 */
export function holdWindowMs(durations: readonly number[]): number {
  const batch = quantile(durations, 0.9) ?? TYPICAL_BATCH_MS;
  return Math.min(HOLD_MS - FLUSH_MS, Math.max(0, HOLD_MS - FLUSH_MS - batch));
}
/** What `batchOrder` looks at in a waiting comment. */
export type WaitingComment = Readonly<{ held: boolean; receivedAt: number }>;
/**
 * The order in which waiting comments (`waiting`, oldest first) are taken for a batch at `now`
 * (R57): first the held ones that can still be judged before their lines come in (received
 * within `windowMs`, `holdWindowMs`), oldest first, the order the chat lets them in; then every
 * other one, newest first. A plain oldest-first order would spend the model on lines already
 * shown and fall behind for good near capacity (R56 measured in the review's simulation).
 */
export function batchOrder(
  waiting: readonly WaitingComment[],
  now: number,
  windowMs: number,
): number[] {
  const cutoff = now - windowMs;
  const inTime: number[] = [];
  const others: number[] = [];
  waiting.forEach((comment, i) => {
    (comment.held && comment.receivedAt > cutoff ? inTime : others).push(i);
  });
  return [...inTime, ...others.reverse()];
}
/** Frames remembered per pending comment (page chat, popout, other tabs of the same stream). */
const MAX_FRAMES = 4;
/** Emoji, stamps and punctuation alone carry no text worth a model call. */
const hasText = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);
const frameKey = (target: Target): string => `${target.tabId}:${target.frameId}`;
const clampConcurrency = (concurrency: number): number =>
  Math.min(Math.max(1, Math.floor(concurrency)), MAX_COMMENT_CONCURRENCY);
/**
 * Comment batches to run at once on a server with `totalSlots` slots (`--parallel`): one slot
 * stays free for subtitles, so a 2-slot server keeps comments serial.
 */
export const commentConcurrencyFor = (totalSlots: number): number =>
  clampConcurrency(totalSlots - 1);
/**
 * Clef's scores laid over the batch: the score of each comment Clef was asked about, in order,
 * and undefined for the rest. Without one score per asked comment (Clef failed), none.
 */
function spread(
  asked: readonly boolean[],
  judged: Result<readonly number[]>,
): (number | undefined)[] {
  const scores = judged.ok ? judged.value : [];
  if (scores.length !== asked.filter(Boolean).length) return asked.map(() => undefined);
  let next = 0;
  return asked.map((ask) => {
    if (!ask) return undefined;
    const score = scores[next];
    next += 1;
    return score;
  });
}
/**
 * Clef decides abuse at `threshold` whenever it answered (R17); without a score (Clef failed, or
 * was not asked: no abuse cue and no abusive model verdict, R43) the LLM category stands.
 */
function categoryOf(
  llm: CommentCategory | undefined,
  abusive: number | undefined,
  threshold: number,
): CommentCategory | undefined {
  if (abusive === undefined) return llm;
  if (isAbusive(abusive, threshold)) return 'abusive';
  return llm === 'abusive' ? 'chatter' : llm;
}
/**
 * The category of a post by the streamer, a moderator or a verified account (R38): never
 * abusive, spam or a stream category (spoiler and the genre categories, R62). A spam verdict of
 * the model or a link makes it important (the streamer's own "now playing" post), copypasta
 * without a link chatter (R53), an abusive verdict or a stream category chatter; anything else
 * is the model's.
 */
function trustedCategory(
  llm: CommentCategory | undefined,
  text: string,
  copypasta: boolean,
): CommentCategory | undefined {
  if (hasLink(text)) return 'important';
  if (copypasta) return 'chatter';
  if (llm === 'spam') return 'important';
  return llm === 'abusive' || (llm !== undefined && isStreamCategory(llm)) ? 'chatter' : llm;
}

type Channel = {
  site: Site;
  channel: string;
  /** False once evicted: late results for it are still shown but no longer stored. */
  live: boolean;
  /**
   * `now()` when its chat was last in front with comments (an ingest that processes), or -∞:
   * eviction takes the least recently processed channel (R53).
   */
  processedAt: number;
  /** `now()` of its latest ingest with comments: breaks a tie in `processedAt` (R55). */
  ingestedAt: number;
  store: CommentStore;
  /**
   * The pipeline's revision at the last change of the stored records or of a verdict; summaries
   * are kept by it. Pipeline-wide, so a channel evicted and kept again never repeats one.
   */
  revision: number;
  /** Recently accepted comments by id, so a re-sent comment is answered without inference. */
  seen: LruCache<string, Entry>;
  /** Comments settled as abusive, spam or spoiler, for the viewer to review. */
  hidden: HiddenLog<Hidden>;
  pending: number;
  /** Waiting comments given up beyond `maxBuffered`, or when the channel was evicted. */
  dropped: number;
  /** Comments only to be stored that found no channel free to make room (R53, R55). */
  unstored: number;
  failed: number;
  /** Answered from the text cache, by rule, or shown in the original after waiting too long. */
  cached: number;
  trivial: number;
  expired: number;
  /** Batch comments not asked of Clef while Clef judges abuse (R43). */
  clefSkipped: number;
  /** Comments stored while their chat was not in front of the viewer and not processed since. */
  stored: number;
  /**
   * Milliseconds from arrival (or from being processed, for one stored before) to the first
   * annotation of the latest `LATENCY_WINDOW` comments that waited for the model (R55): a ring,
   * `latencyNext` the next slot to write.
   */
  latencies: number[];
  latencyNext: number;
  /**
   * The languages the detector found for its latest 200 comments sent to the model (R60): at
   * least half Japanese, and its kanji-only comments are Japanese (`channelLanguageGuess`).
   */
  languages: LanguageMix;
};
type Entry = {
  comment: RawComment;
  channel: Channel;
  /** `normalizeComment(text)`: what the allowlist and the stock-reaction rules compare. */
  text: string;
  /** `now()` when the comment was accepted. */
  receivedAt: number;
  /** A frame keeps its line out of sight until it is judged (R52, R57). */
  held: boolean;
  /** Frames showing the comment, oldest first, keyed `tabId:frameId`. */
  targets: Map<string, Target>;
  /**
   * Other frames sent its annotation once it existed (a reloaded frame, one only storing it,
   * R50), oldest first: an `ok` verdict shows it there too (R53). At most `MAX_FRAMES`; made
   * for the first such frame.
   */
  answered?: Map<string, Target>;
  /** Stored while its chat was not in front, and not processed since (R44). */
  stored: boolean;
  /**
   * Copypasta (`isCopypasta`): spam by rule whatever the model says. One with an abuse cue by
   * a viewer goes to the model and Clef, and Clef's score may make it abusive (R53).
   */
  copypasta: boolean;
  annotation?: Annotation;
};
type Verdict = Readonly<{
  lang: string;
  state: 'done' | 'skipped' | 'failed';
  translation?: string | undefined;
  category?: CommentCategory | undefined;
  abusive?: number | undefined;
  source?: VerdictSource | undefined;
}>;
/** Whether a verdict reached extension storage. */
type Reviewed = Readonly<{ persisted: boolean }>;
/**
 * A hidden comment as listed for review, the comment it came from (its frames), and once the
 * viewer judged it, the verdict and the answer every later review of it gets.
 */
type Hidden = {
  readonly record: HiddenEntry;
  readonly entry: Entry;
  verdict?: FeedbackVerdict;
  answer?: Promise<Result<Reviewed>>;
};
/** The model's reply read per comment, in batch order; `undefined` where its line did not fit. */
type BatchReply = Result<readonly (CommentBatchItem | undefined)[]>;
/** The channel's records a summary read: their revision and how many were in the window. */
type Mark = Readonly<{ revision: number; count: number }>;
type MadeSummary = Readonly<{ mark: Mark; summary: Summary }>;

/**
 * What a channel's stream context gives its comments: the owner its feedback is kept under
 * (the streamer, else the stream), the prompt text (title, spoiler targets), the stream's genre
 * and the stream categories it has on (R62), the owner's latest corrections for the prompt and
 * the prefix of its text cache keys (site, owner and a hash of the text, the genre, the
 * categories and the corrections: the same comment may be classified differently for another
 * streamer, context or genre, or once the streamer's corrections changed, R53).
 */
type Scope = Readonly<{
  owner: string;
  text: string;
  genre: StreamGenre;
  categories: readonly StreamCategory[];
  corrections: readonly CommentCorrection[];
  prefix: string;
}>;
/**
 * Clef's part in a batch, per comment in batch order: whether it has an abuse cue, whether the
 * streamer's allowlist holds its text, whether Clef was asked about it, and Clef's score
 * (undefined where it was not asked or did not answer).
 */
type ClefPart = Readonly<{
  cues: readonly boolean[];
  allowed: readonly boolean[];
  asked: readonly boolean[];
  scores: readonly (number | undefined)[];
}>;
/**
 * One comment PLaMo translates: the line it reads (the unstretched comment text), the language
 * guess the fallback prompt repeats, the `source_lang` sent to PLaMo (`auto` when the guess
 * names only a script), and the request `plamoTranslateRequest` built for it.
 */
type PlamoPlan = Readonly<{
  line: string;
  lang: string;
  sourceLang: string;
  request: ChatRequest & Readonly<{ model: string; maxTokens: number }>;
}>;

/**
 * Background comment processing: drop empty text, answer stock reactions, emotes and laughter
 * by rule and repeated texts from the text cache, batch the rest per channel, detect the
 * language, then let one LLM call translate and classify the batch while Clef judges the comments
 * with an abuse cue; a comment without one that the model calls abusive goes to Clef after the
 * reply, and the batch is shown once Clef answered (R43). Up to `commentConcurrency` batches run
 * at once (default 1; a 3-slot server gives 2) and one starts at once when a slot is free;
 * otherwise new comments wait in the batcher window. Waiting comments go in `batchOrder` (R57):
 * held ones that can still be judged in time oldest first, then the rest newest first, also
 * within one ingest; beyond `commentLimits.batcher.maxBuffered` waiting comments, or after
 * `staleAfterMs` of waiting, a comment is shown in the original (spec §7: about 1 translated
 * comment per second). Only the chat in front of the viewer is processed (R44): comments a frame
 * sends with `process: false` are only stored, and when its chat leaves the viewer (`left`, R49)
 * so are the waiting comments only it shows.
 */
export function createCommentPipeline(deps: {
  client: LlamaClient;
  /** Model name sent with every translation request (a llama.cpp router needs it). */
  model: string;
  /** Should use its own queue so Clef runs while the chat call does. */
  judge: ToxicityJudge;
  detector: LanguageDetector;
  /**
   * The stream context of a channel: its streamer (the key of its feedback), the title and
   * spoiler targets its batch prompts carry, and its genre and relaxations, which decide its
   * stream categories (R62). Asked whenever a comment is judged, so a context that arrives later
   * applies from then on.
   */
  context: (site: Site, channel: string) => StreamContext;
  /**
   * The viewer's verdicts on hidden comments: per streamer (`ownerOf` the channel's context),
   * texts marked fine are chatter, the abuse threshold may be raised and the latest corrections
   * go into batch prompts. Defaults to a store that keeps verdicts for the session only.
   */
  feedback?: FeedbackStore;
  emit: (target: Target, annotations: Annotation[]) => void;
  /**
   * A channel's hidden comments without a verdict, each time that number may have changed: one
   * was hidden, judged, judged again after the feedback was cleared, or the channel was dropped
   * (0). The toolbar badge shows it (R54).
   */
  onHiddenChange?: (site: Site, channel: string, count: number) => void;
  now: () => number;
  timers?: Timers;
  /**
   * Batches that may run at once, each on its own slot from 1 up; defaults to 1 until
   * `setServerSlots`, which also caps a value given here at the server's spare slots.
   */
  commentConcurrency?: number;
  /**
   * The PLaMo translation model's client, on its own queue (its requests name
   * `plamo-3-translate-2b` themselves). Comments it can translate go to it one line each,
   * in parallel with the batch that classifies them; without it every translation stays in
   * the batch call, as before.
   */
  plamo?: LlamaClient;
  /** A comment waiting longer than this without reaching the model is skipped; 8000 ms. */
  staleAfterMs?: number;
  /**
   * Whether llama-server's slot 0 (the subtitles') is processing. When given, a second request
   * on the comment slots waits for a fresh answer, and while subtitles use slot 0 the comment
   * slots run one request at a time (`subtitle-yield.ts`). Without it comments never give way.
   */
  subtitleSlotBusy?: (signal: AbortSignal) => Promise<Result<boolean>>;
}): CommentPipeline {
  const { maxItems, maxBuffered } = commentLimits.batcher;
  const staleAfterMs = deps.staleAfterMs ?? STALE_AFTER_MS;
  const requested =
    deps.commentConcurrency === undefined ? undefined : clampConcurrency(deps.commentConcurrency);
  let concurrency = requested ?? 1;
  let judge = deps.judge;
  const feedback = deps.feedback ?? createFeedbackStore();
  let lastError: string | undefined;
  let judgeError: string | undefined;
  let disposed = false;
  /** Comments accepted but not yet answered: in the batcher, the backlog or a running batch. */
  let queued = 0;
  let droppedTotal = 0;
  /** Flushed comments waiting for the model, oldest first. */
  let backlog: Entry[] = [];
  /** Running batches and the llama-server slot each one holds. */
  const running = new Map<AbortController, number>();
  /** `now()` when each running batch started, for its duration. */
  const started = new Map<AbortController, number>();
  /**
   * Durations of the latest `BATCH_DURATIONS` model batches that got a reply, start to reply,
   * Clef included, oldest first: `holdWindowMs` takes their median (R58).
   */
  const batchDurations: number[] = [];
  /** Work holding a comment slot through `exclusive` (a summary) and the slot it holds. */
  const held = new Map<AbortController, number>();
  /**
   * `exclusive` calls waiting for a free comment slot, oldest first; `begin` starts one on a
   * slot, or at once with an aborted signal (`cancelled`).
   */
  type Waiting = Readonly<{
    key: string | undefined;
    /** Starts only on a slot left after the waiting batches took theirs. */
    spare: boolean;
    begin: (slot: number, cancelled: boolean) => void;
  }>;
  let waiting: Waiting[] = [];
  /** An `exclusive` just ended: the next `pump` fills free slots with waiting batches first. */
  let batchesFirst = false;
  /** Comment slots in use, by batches and by `exclusive`. */
  const busy = (): number => running.size + held.size;
  /**
   * Comment requests that may run at once now: the first always starts at once; a second or
   * later one only while subtitles do not use slot 0 (batches, summaries and the genre guess
   * alike: they all decode on the same model, ruling S38).
   */
  const allowed = (): number =>
    busy() === 0 || subtitles === undefined ? concurrency : subtitles.limit(concurrency);
  /** The latest summary per channel and window, and the ones being made. */
  const summaries = createLruCache<string, MadeSummary>({ max: SUMMARY_CACHE_MAX });
  const summarizing = new Map<string, Promise<Result<Summary>>>();
  /** Text cache keys of the running batches: waiting copies stay for the cache. */
  const inFlight = new Set<string>();
  /** A batch stored new texts: waiting copies of them can be answered from the cache. */
  let cacheGrew = false;
  /** `ingest` delivers once at its end, so a flush inside it does not deliver early. */
  let ingesting = false;
  const textCache = createTextCache();
  const outbox = new Map<string, { target: Target; annotations: Annotation[] }>();

  /** The kept channels by `keyOf`, at most `MAX_CHANNELS`. */
  const channels = new Map<string, Channel>();
  /** Comments of channels not kept that could not be stored (R53), until the channel is kept. */
  const unkept = createLruCache<string, number>({ max: UNKEPT_MAX });
  /** The latest revision of any channel's records. */
  let revisions = 0;
  function bump(owner: Channel): void {
    revisions += 1;
    owner.revision = revisions;
  }
  const newStore = (): CommentStore =>
    createCommentStore({ ...commentLimits.store, now: deps.now });
  const keyOf = (site: Site, channel: string): string => `${site}:${channel}`;
  /**
   * The channel that makes room for a new one: the least recently processed (R53). For comments
   * only to be stored, never one with comments waiting for or with the model, nor one processed
   * within `RECENTLY_PROCESSED_MS`; undefined when no channel may go.
   */
  function evictable(process: boolean): Channel | undefined {
    const recent = deps.now() - RECENTLY_PROCESSED_MS;
    let oldest: Channel | undefined;
    for (const candidate of channels.values()) {
      if (!process && (candidate.pending > 0 || candidate.processedAt > recent)) continue;
      // Of channels processed as long ago (stored-only ones never were), the one that sent
      // comments longest ago goes (R55); then the one kept first.
      if (
        oldest === undefined ||
        candidate.processedAt < oldest.processedAt ||
        (candidate.processedAt === oldest.processedAt && candidate.ingestedAt < oldest.ingestedAt)
      )
        oldest = candidate;
    }
    return oldest;
  }
  /** Forgets a channel: its records, hidden list and summaries; its waiting comments are dropped. */
  function evict(gone: Channel): void {
    const key = keyOf(gone.site, gone.channel);
    channels.delete(key);
    gone.live = false;
    gone.store.clear();
    gone.seen.clear();
    gone.hidden.clear();
    gone.languages.clear();
    deps.onHiddenChange?.(gone.site, gone.channel, 0);
    for (const minutes of SUMMARY_WINDOWS) summaries.delete(`${key}\u0000${minutes}`);
    const waiting = backlog.filter((entry) => entry.channel === gone);
    if (waiting.length === 0) return;
    backlog = backlog.filter((entry) => entry.channel !== gone);
    drop(waiting);
  }
  /**
   * The kept channel, or a new one in place of the least recently processed (`evictable`);
   * undefined when comments only to be stored find no room.
   */
  function channelFor(site: Site, channel: string, process: boolean): Channel | undefined {
    const key = keyOf(site, channel);
    const existing = channels.get(key);
    if (existing) return existing;
    if (channels.size >= MAX_CHANNELS) {
      const gone = evictable(process);
      if (gone === undefined) return undefined;
      evict(gone);
    }
    const created: Channel = {
      site,
      channel,
      live: true,
      processedAt: Number.NEGATIVE_INFINITY,
      ingestedAt: deps.now(),
      store: newStore(),
      revision: 0,
      seen: createLruCache({ max: commentLimits.lruMax }),
      hidden: createHiddenLog(),
      pending: 0,
      dropped: 0,
      // Comments that found no room before it was kept.
      unstored: unkept.get(key) ?? 0,
      failed: 0,
      cached: 0,
      trivial: 0,
      expired: 0,
      clefSkipped: 0,
      stored: 0,
      latencies: [],
      latencyNext: 0,
      languages: createLanguageMix(),
    };
    unkept.delete(key);
    channels.set(key, created);
    return created;
  }

  /**
   * The latest context text with its corrections and their hash: most comments in a row share
   * one stream.
   */
  let hashed: { text: string; hash: string } | undefined;
  /**
   * The latest stream's categories by what decides them (title, genre, relaxations, a spoiler
   * note or none): `scopeOf` runs several times per comment, and reading the title's relaxations
   * normalizes it and runs two patterns (review G1 M3).
   */
  let categorized: { key: string; categories: readonly StreamCategory[] } | undefined;
  function categoriesOf(context: StreamContext): readonly StreamCategory[] {
    const key = [
      context.title ?? '',
      context.genre ?? 'other',
      (context.relaxations ?? []).join(','),
      context.spoilerNote === undefined ? '' : 'noted',
    ].join('\u0000');
    if (categorized?.key !== key) categorized = { key, categories: streamCategoriesOf(context) };
    return categorized.categories;
  }
  function scopeOf(channel: Channel): Scope {
    const context = deps.context(channel.site, channel.channel);
    const owner = ownerOf(context);
    const text = contextText(context);
    const genre = context.genre ?? 'other';
    const categories = categoriesOf(context);
    const corrections = feedback.corrections(channel.site, owner);
    const learned = corrections.map((item) => `${item.category}\u0001${item.text}`);
    const keyed = [text, `${genre}\u0001${categories.join(',')}`, ...learned].join('\u0000');
    if (hashed?.text !== keyed) hashed = { text: keyed, hash: contextHash(keyed) };
    return {
      owner,
      text,
      genre,
      categories,
      corrections,
      prefix: `${channel.site}\u0000${owner}\u0000${hashed.hash}\u0000`,
    };
  }
  /** The text cache key of a comment under its channel's current scope. */
  const cacheKey = (entry: Entry, scope: Scope = scopeOf(entry.channel)): string =>
    `${scope.prefix}${entry.text}`;

  /** Remembers a frame among `frames`; beyond `MAX_FRAMES` the oldest is forgotten. */
  function remember(frames: Map<string, Target>, target: Target): void {
    const key = frameKey(target);
    frames.delete(key);
    frames.set(key, target);
    for (const oldest of frames.keys()) {
      if (frames.size <= MAX_FRAMES) break;
      frames.delete(oldest);
    }
  }
  /** Remembers a frame that shows the comment and waits for its annotation. */
  const addTarget = (entry: Entry, target: Target): void => remember(entry.targets, target);
  function post(target: Target, annotation: Annotation): void {
    const key = frameKey(target);
    const box = outbox.get(key);
    if (box) box.annotations.push(annotation);
    else outbox.set(key, { target, annotations: [annotation] });
  }
  const replyOf = (accepted: number, dropped: number): IngestReply => ({
    accepted,
    dropped,
    ...(lastError === undefined ? {} : { lastError }),
  });
  /** Tells the channel's hidden comments without a verdict (R54). */
  function hiddenChanged(owner: Channel): void {
    if (deps.onHiddenChange === undefined) return;
    let open = 0;
    for (const item of owner.hidden.values()) if (item.verdict === undefined) open += 1;
    deps.onHiddenChange(owner.site, owner.channel, open);
  }
  /** One emit per frame for everything settled in the current turn. */
  function deliver(): void {
    const boxes = [...outbox.values()];
    outbox.clear();
    for (const { target, annotations } of boxes) deps.emit(target, annotations);
  }
  /**
   * The category a comment shows with: Clef decides abuse at the streamer's threshold, and a
   * text the viewer marked fine for the streamer is chatter whatever the model, Clef or the text
   * cache said. Copypasta is spam by rule instead of the model's category, unless Clef found it
   * abusive (R53). A stream category the stream does not have on is chatter (R31, R62: a
   * spoiler in a chatting stream without spoiler targets, an instruction in a 参加型 stream). A
   * question verdict on a Latin comment without a question mark or question word, or on one
   * interjection (`WHAT??`), is chatter (R38, R60), and a post by the streamer, a moderator or a
   * verified account follows `trustedCategory` instead of Clef and the feedback. Anyone else's
   * spam verdict of the model stands only on a comment with a link (R60): without one the model
   * mostly took a complaint about ads or advice for spam.
   */
  function decide(
    entry: Entry,
    llm: CommentCategory | undefined,
    abusive: number | undefined,
  ): { category: CommentCategory | undefined; source: VerdictSource | undefined } {
    const { site } = entry.channel;
    const { owner, categories } = scopeOf(entry.channel);
    const rule = entry.copypasta;
    // The grammar allows only the stream's own categories; another one (from a server that
    // ignored the grammar) is chat (R31, R62).
    const allowed =
      llm !== undefined && isStreamCategory(llm) && !categories.includes(llm) ? 'chatter' : llm;
    const asked = rule
      ? 'spam'
      : allowed === 'question' && !mayBeQuestion(entry.comment.text)
        ? 'chatter'
        : allowed;
    if (entry.comment.role !== undefined) {
      const trusted = trustedCategory(asked, entry.comment.text, rule);
      if (trusted === undefined) return { category: trusted, source: undefined };
      return { category: trusted, source: trusted === asked && !rule ? 'model' : 'rule' };
    }
    const linked = asked === 'spam' && !rule && !hasLink(entry.comment.text) ? 'chatter' : asked;
    const threshold = feedback.threshold(site, owner);
    const judged = categoryOf(linked, abusive, threshold);
    const category =
      judged !== undefined && feedback.allowlist(site, owner).has(entry.text) ? 'chatter' : judged;
    if (category === undefined) return { category, source: undefined };
    const source =
      category === 'abusive' && abusive !== undefined ? 'clef' : rule ? 'rule' : 'model';
    return { category, source };
  }
  /** A model verdict, fresh or from the text cache, judged for the comment's own channel. */
  const judgeFor = (entry: Entry, cached: CachedVerdict): Verdict => ({
    ...cached,
    ...decide(entry, cached.category, cached.abusive),
    state: 'done',
  });
  function settle(entry: Entry, verdict: Verdict): void {
    const { comment, channel } = entry;
    if (channel.live) {
      bump(channel);
      const record: CommentRecord = {
        id: comment.id,
        site: channel.site,
        channel: channel.channel,
        author: comment.author,
        text: comment.text,
        lang: verdict.lang,
        at: comment.at,
        state: verdict.state,
        ...(verdict.translation === undefined ? {} : { translation: verdict.translation }),
        ...(verdict.category === undefined ? {} : { category: verdict.category }),
        ...(verdict.abusive === undefined ? {} : { abusive: verdict.abusive }),
      };
      // A comment stored while its chat was not in front is completed in place (R44).
      if (channel.store.add([record]).length === 0) channel.store.update(comment.id, record);
    }
    // An unknown category shows as plain chat.
    const annotation: Annotation = {
      id: comment.id,
      category: verdict.category ?? 'chatter',
      state: verdict.state,
      ...(verdict.translation === undefined ? {} : { translation: verdict.translation }),
    };
    entry.annotation = annotation;
    for (const target of entry.targets.values()) post(target, annotation);
    if (!channel.live || !HIDDEN_CATEGORIES.has(annotation.category)) return;
    channel.hidden.add(comment.id, {
      entry,
      record: {
        id: comment.id,
        site: channel.site,
        channel: channel.channel,
        text: comment.text,
        ...(verdict.translation === undefined ? {} : { translation: verdict.translation }),
        category: annotation.category,
        ...(verdict.abusive === undefined ? {} : { abusive: verdict.abusive }),
        ...(verdict.source === undefined ? {} : { source: verdict.source }),
        at: comment.at,
      },
    });
    hiddenChanged(channel);
  }
  /**
   * Shows again every hidden comment of the channel with this text and no verdict yet, in every
   * frame that showed it, and returns them. The text cache keeps its entry: the allowlist
   * decides on every read from it.
   */
  function restore(owner: Channel, text: string): Hidden[] {
    const restored = owner.hidden
      .values()
      .filter((item) => item.entry.text === text && item.verdict === undefined);
    for (const { entry } of restored) {
      const { id } = entry.comment;
      owner.store.update(id, { category: 'chatter' });
      bump(owner);
      const shown: Annotation = {
        id,
        category: 'chatter',
        state: entry.annotation?.state ?? 'done',
        ...(entry.annotation?.translation === undefined
          ? {}
          : { translation: entry.annotation.translation }),
        override: 'show',
      };
      entry.annotation = shown;
      // Every frame that got its annotation, also one that only stored it (R50, R53).
      const frames = new Map([...entry.targets, ...(entry.answered ?? [])]);
      for (const target of frames.values()) post(target, shown);
    }
    deliver();
    return restored;
  }
  /** The verdict is in effect once recorded; whether storage took it is only reported. */
  async function reviewed(saved: Promise<Result<void>>): Promise<Result<Reviewed>> {
    const written = await saved;
    return Ok({ persisted: written.ok });
  }
  /**
   * Stores a comment read while its chat was not in front of the viewer, without the model,
   * Clef, a rule or an annotation (R44); the chat shows it as it is.
   */
  function keep(entry: Entry): void {
    const { comment, channel } = entry;
    entry.stored = true;
    channel.stored += 1;
    if (!channel.live) return;
    bump(channel);
    const added = channel.store.add([
      {
        id: comment.id,
        site: channel.site,
        channel: channel.channel,
        author: comment.author,
        text: comment.text,
        lang: hasText(comment.text) ? scriptLanguageGuess(comment.text).lang : 'und',
        at: comment.at,
        state: 'stored',
      },
    ]);
    // Stored before, processed on return and stored again before the model answered.
    if (added.length === 0) channel.store.update(comment.id, { state: 'stored' });
  }
  /**
   * The chat of `target` left the viewer: the channel's comments still waiting for the model (in
   * the batch window or the backlog) that no other frame shows are stored instead; a frame still
   * in front keeps its comments. Running batches finish (R44, R49).
   */
  function stash(owner: Channel, target: Target): void {
    // Inside `ingest` the batch window's comments only join the backlog: no batch starts.
    batcher.flush();
    const key = frameKey(target);
    const leaving = (entry: Entry): boolean =>
      entry.channel === owner && entry.targets.size === 1 && entry.targets.has(key);
    const waiting = backlog.filter(leaving);
    if (waiting.length === 0) return;
    backlog = backlog.filter((entry) => !leaving(entry));
    for (const entry of waiting) {
      queued -= 1;
      owner.pending -= 1;
      keep(entry);
    }
  }
  /**
   * Processes a comment: one without text is skipped, a stock reaction, copypasta or a cached
   * text is answered at once, and the rest waits for the model.
   */
  function admit(entry: Entry): void {
    if (!hasText(entry.comment.text)) {
      settle(entry, { lang: 'und', state: 'skipped', category: 'chatter' });
      return;
    }
    if (answerFast(entry)) return;
    queued += 1;
    entry.channel.pending += 1;
    drop(batcher.push(entry).dropped);
    trim();
  }
  /**
   * Releases a comment that was counted as queued, and counts its wait (R55): a model answer, a
   * failed line, a cache answer after waiting, or the original after expiry or a drop.
   */
  function answer(entry: Entry, verdict: Verdict): void {
    const { channel } = entry;
    queued -= 1;
    channel.pending -= 1;
    if (verdict.state === 'failed') channel.failed += 1;
    if (channel.live) {
      channel.latencies[channel.latencyNext] = deps.now() - entry.receivedAt;
      channel.latencyNext = (channel.latencyNext + 1) % LATENCY_WINDOW;
    }
    settle(entry, verdict);
  }
  /**
   * What a comment the model never answered shows with: copypasta keeps the rule's verdict (spam,
   * chat for a role or an allowlisted text, R55), else nothing.
   */
  const unanswered = (entry: Entry): Pick<Verdict, 'category' | 'source'> =>
    entry.copypasta ? decide(entry, undefined, undefined) : {};
  function drop(entries: readonly Entry[]): void {
    for (const entry of entries) {
      droppedTotal += 1;
      entry.channel.dropped += 1;
      answer(entry, {
        lang: scriptLanguageGuess(entry.comment.text).lang,
        state: 'skipped',
        ...unanswered(entry),
      });
    }
  }
  /** Keeps the newest `maxBuffered` waiting comments; running batches are never dropped. */
  function trim(): void {
    const excess = Math.min(queued - maxBuffered, backlog.length);
    if (excess > 0) drop(backlog.splice(0, excess));
  }
  /**
   * Shows comments that waited over `staleAfterMs` in the original; the backlog is oldest first.
   * Copypasta keeps the rule's verdict (R55); another one that ends in a question mark is a
   * question by rule (R38), still skipped and untranslated, unless it is one interjection
   * (`mayBeQuestion`, R60).
   */
  function expire(): void {
    const cutoff = deps.now() - staleAfterMs;
    let stale = 0;
    while (stale < backlog.length && (backlog[stale]?.receivedAt ?? cutoff) < cutoff) stale += 1;
    for (const entry of backlog.splice(0, stale)) {
      entry.channel.expired += 1;
      answer(entry, {
        lang: scriptLanguageGuess(entry.comment.text).lang,
        state: 'skipped',
        ...(entry.copypasta
          ? unanswered(entry)
          : endsAsQuestion(entry.comment.text) && mayBeQuestion(entry.comment.text)
            ? { category: 'question', source: 'rule' }
            : {}),
      });
    }
  }
  /** Answers waiting copies of texts that a finished batch has just cached. */
  function answerCached(): void {
    if (!cacheGrew) return;
    cacheGrew = false;
    const scopes = new Map<Channel, Scope>();
    backlog = backlog.filter((entry) => {
      const cached = textCache.get(cacheKey(entry, scopeFor(scopes, entry.channel)));
      if (cached === undefined) return true;
      entry.channel.cached += 1;
      answer(entry, judgeFor(entry, cached));
      return false;
    });
  }
  /** One scope per channel for a pass over many waiting comments. */
  function scopeFor(scopes: Map<Channel, Scope>, channel: Channel): Scope {
    const known = scopes.get(channel);
    if (known) return known;
    const scope = scopeOf(channel);
    scopes.set(channel, scope);
    return scope;
  }
  /**
   * The waiting comments of the next batch, in arrival order, taken in `batchOrder` with the
   * window the latest batches leave (`holdWindowMs`, R57, R58): the
   * first comment that order offers decides the channel, so a channel with held comments still
   * in time goes first and one whose held comments are past their window does not; then that
   * channel's held comments in time, oldest first, then its others, newest first. A copy of a
   * text already in this or a running batch (same cache key) stays waiting and is answered from
   * the cache once that batch ends; empty when every waiting comment is such a copy.
   */
  function takeBatch(): Entry[] {
    let owner: Channel | undefined;
    const picked = new Set<number>();
    const keys = new Set<string>();
    const scopes = new Map<Channel, Scope>();
    for (const i of batchOrder(backlog, deps.now(), holdWindowMs(batchDurations))) {
      if (picked.size >= maxItems) break;
      const entry = backlog[i];
      if (entry === undefined || (owner !== undefined && entry.channel !== owner)) continue;
      const key = cacheKey(entry, scopeFor(scopes, entry.channel));
      if (inFlight.has(key) || keys.has(key)) continue;
      owner ??= entry.channel;
      keys.add(key);
      picked.add(i);
    }
    const batch = backlog.filter((_entry, i) => picked.has(i));
    backlog = backlog.filter((_entry, i) => !picked.has(i));
    return batch;
  }
  /** The lowest comment slot that neither a running batch nor an `exclusive` holds. */
  function freeSlot(): number {
    const taken = new Set([...running.values(), ...held.values()]);
    let slot = FIRST_COMMENT_SLOT;
    while (taken.has(slot)) slot += 1;
    return slot;
  }
  /**
   * The highest comment slot nothing holds, for a `spare` call (the genre guess): with
   * llama-server's `--cache-ram 0` a slot keeps only its own last prefix, so slot 1 keeps the
   * batch prompt's while a second slot takes the guess.
   */
  function highestFreeSlot(): number {
    const taken = new Set([...running.values(), ...held.values()]);
    for (let slot = FIRST_COMMENT_SLOT + concurrency - 1; slot > FIRST_COMMENT_SLOT; slot -= 1)
      if (!taken.has(slot)) return slot;
    return freeSlot();
  }
  /**
   * Whether Clef may judge the comment (R53): Clef judges abuse, the author has no role and the
   * streamer's allowlist does not hold the text.
   */
  function judgeable(entry: Entry): boolean {
    if (judge.mode !== 'clef' || entry.comment.role !== undefined) return false;
    const { site } = entry.channel;
    return !feedback.allowlist(site, scopeOf(entry.channel).owner).has(entry.text);
  }
  /** Answers a comment at once by rule or from the text cache; false when it needs the model. */
  function answerFast(entry: Entry): boolean {
    // Emotes, laughter and stock reactions alone are chatter, untranslated (R39).
    const rule =
      trivialVerdict(entry.text) ??
      (isEmoteChatter(entry.comment.text) ? { category: 'chatter' as const } : undefined);
    if (rule !== undefined) {
      entry.channel.trivial += 1;
      settle(entry, {
        lang: scriptLanguageGuess(entry.comment.text).lang,
        state: 'done',
        source: 'rule',
        ...rule,
      });
      return true;
    }
    entry.copypasta = isCopypasta(entry.text);
    // Copypasta is spam by rule: a copy the viewer marked fine stays chat, and one by the
    // streamer, a moderator or a verified account is chat (important with a link). One with an
    // abuse cue by a viewer goes to Clef with the model batch, unless it is allowlisted (R53).
    if (entry.copypasta && !(judgeable(entry) && hasAbuseCue(entry.text))) {
      entry.channel.trivial += 1;
      settle(entry, {
        lang: scriptLanguageGuess(entry.comment.text).lang,
        state: 'done',
        ...decide(entry, undefined, undefined),
      });
      return true;
    }
    const cached = textCache.get(cacheKey(entry));
    if (cached === undefined) return false;
    entry.channel.cached += 1;
    settle(entry, judgeFor(entry, cached));
    return true;
  }

  const subtitles =
    deps.subtitleSlotBusy === undefined
      ? undefined
      : createSubtitleYield({
          probe: deps.subtitleSlotBusy,
          now: deps.now,
          timers: deps.timers ?? systemTimers,
          // As `setServerSlots`: a slot may be open now.
          changed: () => {
            if (busy() < allowed()) batcher.flush();
            pump();
            deliver();
          },
        });
  const batcher = createBatcher<Entry>({
    ...commentLimits.batcher,
    timers: deps.timers ?? systemTimers,
    flush: (entries) => {
      backlog.push(...entries);
      // Inside `ingest` the whole message is taken first and pumped at its end, so its newest
      // comments go to the model first.
      if (ingesting) return;
      pump();
      // The batch window ended on its own: deliver what expired or hit the cache meanwhile.
      deliver();
    },
  });

  /**
   * Clef's scores for `texts`. A Clef error never fails the batch or cuts its chat call short
   * (R53): the comments without a score keep the model's category, and `judgeError` reports it.
   */
  async function abusiveScores(
    texts: readonly string[],
    signal: AbortSignal,
  ): Promise<Result<readonly number[]>> {
    if (judge.mode !== 'clef' || texts.length === 0) return Ok([]);
    const scores = await judge.judge(texts, signal);
    if (scores.ok) judgeError = undefined;
    else if (scores.error.internalCode !== 'operation_cancelled') {
      judgeError = scores.error.internalCode;
      // Clef is not there (HTTP 501, 404 or a router without the model): the LLM category
      // decides abuse from now on (R14, R53).
      if (scores.error.internalCode === 'clef_unavailable') judge = llmCategoryJudge;
    }
    return scores;
  }

  function finish(
    controller: AbortController,
    batch: readonly Entry[],
    /** The batch's text cache keys, under the context its prompt carried. */
    keys: readonly string[],
    guesses: readonly LanguageGuess[],
    /** Clef was asked about a comment with an abuse cue or an abusive verdict (R43). */
    { cues, allowed, asked, scores }: ClefPart,
    reply: BatchReply,
  ): void {
    // Each batch settles once, and never after dispose.
    if (!running.delete(controller)) return;
    const startedAt = started.get(controller);
    started.delete(controller);
    if (reply.ok && startedAt !== undefined) {
      batchDurations.push(deps.now() - startedAt);
      if (batchDurations.length > BATCH_DURATIONS) batchDurations.shift();
    }
    for (const key of keys) inFlight.delete(key);
    // A line that did not fit its comment is reported like a reply that did not decode.
    lastError = !reply.ok
      ? reply.error.internalCode
      : reply.value.includes(undefined)
        ? 'response_invalid'
        : undefined;
    batch.forEach((entry, i) => {
      if (judge.mode === 'clef' && asked[i] !== true) entry.channel.clefSkipped += 1;
      const guess = guesses[i] ?? scriptLanguageGuess(entry.comment.text);
      const abusive = scores[i];
      // The parser already checked the line number and that a translation exists exactly when
      // the comment needed one; a comment without a fitting line stays in the original.
      const item = reply.ok ? reply.value[i] : undefined;
      if (item === undefined) {
        answer(entry, {
          lang: guess.lang,
          state: 'failed',
          ...decide(entry, undefined, abusive),
          abusive,
        });
        return;
      }
      // The cache keeps the model's own category: each channel judges it with its feedback.
      const verdict: CachedVerdict = {
        lang: guess.lang,
        category: item.category,
        translation: item.ja,
        abusive,
      };
      answer(entry, judgeFor(entry, verdict));
      // In Clef mode a reply that needed Clef's score (an abuse cue or an abusive verdict) and
      // has none is not reused: Clef decides abuse (R17), also for a viewer's copy of a role's
      // text Clef was not asked about (R53). One that needed none (R43) is reused with the
      // model's category, and so is an allowlisted one: every copy under its scope is too.
      const key = keys[i];
      const needed = (cues[i] === true || item.category === 'abusive') && allowed[i] !== true;
      if ((judge.mode === 'clef' && needed && abusive === undefined) || key === undefined) return;
      textCache.set(key, verdict);
      cacheGrew = true;
    });
    // A slot is free again: what arrived during the batch goes now instead of at the end of its
    // window, and the next batch starts.
    batcher.flush();
    pump();
    deliver();
  }

  /**
   * Starts waiting `exclusive` calls on the free slots, oldest first; `spare` ones only when
   * `spares` (the batches took their slots already).
   */
  function grant(spares: boolean): void {
    for (let i = 0; i < waiting.length && busy() < allowed();) {
      const next = waiting[i];
      if (next === undefined || (next.spare && !spares)) {
        i += 1;
        continue;
      }
      waiting.splice(i, 1);
      next.begin(next.spare ? highestFreeSlot() : freeSlot(), false);
    }
  }
  /**
   * Gives a free slot to a waiting `exclusive` (unless one just ended: then the waiting batches
   * go first, R36), answers newly cached copies (before expiry: an answer at hand is never
   * thrown away), expires stale comments, fills the free slots with batches and gives what is
   * left to waiting `exclusive` calls. It runs when a batch window ends, a batch finishes or a
   * slot frees up, so a comment is always checked for expiry before it can be taken for
   * inference (no timer of its own).
   */
  function pump(): void {
    if (disposed) return;
    const summariesFirst = !batchesFirst;
    batchesFirst = false;
    // A waiting summary takes the first free slot, before the batches queued meanwhile.
    if (summariesFirst) grant(false);
    answerCached();
    expire();
    // Only waiting comments ask whether another batch may start.
    while (backlog.length > 0 && busy() < allowed()) {
      const batch = takeBatch();
      if (batch.length === 0) break;
      start(batch);
    }
    grant(true);
  }

  /**
   * Whether the router lists PLaMo, once a `/v1/models` answer said so: undefined until then,
   * and again after a failed ask. A list that cannot be read offers nothing this batch.
   */
  let plamoOffered: boolean | undefined;
  /** The `source_lang` a comment's guess maps to for PLaMo. */
  const plamoSourceLang = (lang: string): string =>
    // A script-only guess (`und-Latn`, `und-Other`) names no language: PLaMo detects it.
    lang === 'und-Latn' || lang === 'und-Other' ? 'auto' : lang;
  /**
   * The PLaMo plan of one comment, or undefined when PLaMo cannot take it: a language it does
   * not know, or a line `plamoTranslateRequest` refuses. The caller checked that the router
   * lists the model and that the comment needs a translation. The line takes the batch's own
   * slot: every model has the same slots, so PLaMo's slot 0 stays free for subtitle
   * translations while comment batches spread over 1 and up.
   */
  function plamoPlanOf(
    comment: { text: string; lang: string },
    slot: number,
  ): PlamoPlan | undefined {
    const sourceLang = plamoSourceLang(comment.lang);
    if (plamoLanguage(sourceLang).kind === 'unsupported') return undefined;
    const request = plamoTranslateRequest({
      line: comment.text,
      sourceLang,
      previous: [],
      glossary: [],
      slot,
    });
    return request.ok
      ? { line: comment.text, lang: comment.lang, sourceLang, request: request.value }
      : undefined;
  }

  function start(batch: readonly Entry[]): void {
    const owner = batch[0]?.channel;
    if (owner === undefined) return;
    const controller = new AbortController();
    const slot = freeSlot();
    running.set(controller, slot);
    started.set(controller, deps.now());
    // One context for the whole batch: its prompt and the cache keys of its answers.
    const scope = scopeOf(owner);
    const keys = batch.map((entry) => cacheKey(entry, scope));
    for (const key of keys) inFlight.add(key);
    const { signal } = controller;
    const texts = batch.map((entry) => entry.comment.text);
    // Clef judges the comments with an abuse cue while the model runs (R43), never a role's or
    // an allowlisted text (R53).
    const allowlist = feedback.allowlist(owner.site, scope.owner);
    const allowed = batch.map((entry) => allowlist.has(entry.text));
    const cues = batch.map((entry) => hasAbuseCue(entry.text));
    const asks = batch.map(
      (entry, i) => judge.mode === 'clef' && entry.comment.role === undefined && !allowed[i],
    );
    const cued = cues.map((cue, i) => cue && asks[i] === true);
    let guesses: LanguageGuess[] = [];
    launch(
      async () => {
        const detected = await Promise.all(texts.map((text) => deps.detector.detect(text)));
        const found = detected.map((guess, i) =>
          guess.ok ? guess.value : scriptLanguageGuess(texts[i] ?? ''),
        );
        // The channel counts what the detector found, this batch included, and reads its
        // kanji-only comments by that (R60): a guess it gave is never counted, so the mix cannot
        // feed itself.
        for (const guess of found) owner.languages.add(guess.lang);
        guesses = found.map((guess, i) =>
          channelLanguageGuess(texts[i] ?? '', guess, owner.languages),
        );
        if (signal.aborted) return;
        // The model reads stretched letters as two (R40); Clef and the store keep the original.
        const comments = guesses.map((guess, i) => ({
          text: unstretched(texts[i] ?? ''),
          lang: guess.lang,
          translate: needsTranslation(guess, 'ja'),
        }));
        // PLaMo translates the comments it can, one line each in parallel with the batch; the
        // batch call then only classifies them (`translate` off), as it does for Japanese ones.
        // The router's model list is asked once, and again only while it cannot be read.
        const wantsPlamo =
          deps.plamo !== undefined && comments.some((comment) => comment.translate);
        if (wantsPlamo && plamoOffered === undefined) {
          const models = await deps.client.models(signal);
          if (models.ok) plamoOffered = models.value.includes(PLAMO_TRANSLATE_MODEL);
        }
        const plans = comments.map((comment) =>
          wantsPlamo && plamoOffered === true && comment.translate
            ? plamoPlanOf(comment, slot)
            : undefined,
        );
        const promptComments = comments.map((comment, i) =>
          plans[i] === undefined ? comment : { ...comment, translate: false },
        );
        const maxTokens = commentBatchMaxTokens(promptComments);
        const plamo = deps.plamo;
        // Clef, PLaMo and the translation model are separate llama.cpp processes, so they overlap.
        const [judged, replied, plamoReplies] = await Promise.all([
          abusiveScores(
            texts.filter((_text, i) => cued[i]),
            signal,
          ),
          deps.client.chat({
            ...commentBatchPrompt({
              comments: promptComments,
              context: scope.text,
              genre: scope.genre,
              categories: scope.categories,
              corrections: scope.corrections,
            }),
            model: deps.model,
            slot,
            temperature: 0,
            templateKwargs: { enable_thinking: false },
            maxTokens,
            signal,
          }),
          Promise.all(
            plans.map((plan) =>
              plan === undefined || plamo === undefined
                ? Promise.resolve(undefined)
                : plamo.chat({ ...plan.request, signal }),
            ),
          ),
        ]);
        const parsed: BatchReply = replied.ok
          ? Ok(
              parseCommentBatch(replied.value.text, promptComments, {
                cut: cutByMaxTokens(replied.value, maxTokens),
              }),
            )
          : replied;
        // Each PLaMo line that answered becomes its comment's translation; one that failed is
        // translated by the batch model alone (the subtitle prompt's one-line task, on the
        // batch's slot, with the stream's context).
        const gemmaAlone = async (plan: PlamoPlan): Promise<string | undefined> => {
          const maxTokens = subtitleMaxTokens(plan.line);
          const reply = await deps.client.chat({
            ...subtitlePrompt({
              source: plan.line,
              sourceLang: plan.lang,
              previous: [],
              context: scope.text,
              glossary: [],
            }),
            model: deps.model,
            slot,
            temperature: 0,
            cachePrompt: true,
            maxTokens,
            templateKwargs: { enable_thinking: false },
            signal,
          });
          if (!reply.ok) return undefined;
          const ja = parseSubtitleLine(reply.value, maxTokens, plan.line);
          return ja.ok ? ja.value : undefined;
        };
        const translations = await Promise.all(
          plans.map(async (plan, i) => {
            if (plan === undefined) return undefined;
            const reply = plamoReplies[i];
            if (reply?.ok === true) {
              const ja = parsePlamoLine(reply.value, plan.request.maxTokens, plan.line);
              if (ja.ok) return ja.value;
            }
            return gemmaAlone(plan);
          }),
        );
        const reply: BatchReply = parsed.ok
          ? Ok(
              parsed.value.map((item, i) => {
                const ja = translations[i];
                return item !== undefined && ja !== undefined ? { ...item, ja } : item;
              }),
            )
          : parsed;
        // Then Clef judges the comments without a cue that the model called abusive: none of the
        // batch is shown before it answers, so an abusive verdict never shows ahead of Clef's.
        // Not when the first call found Clef unreachable or silent: the batch would hold its slot
        // for a second timeout (R55).
        const reachable = judged.ok || judged.error.internalCode !== 'network_failed';
        const late = cues.map(
          (cue, i) =>
            !cue &&
            asks[i] === true &&
            judge.mode === 'clef' &&
            reachable &&
            reply.ok &&
            reply.value[i]?.category === 'abusive',
        );
        const rejudged = await abusiveScores(
          texts.filter((_text, i) => late[i]),
          signal,
        );
        const early = spread(cued, judged);
        const after = spread(late, rejudged);
        finish(
          controller,
          batch,
          keys,
          guesses,
          {
            cues,
            allowed,
            asked: cued.map((cue, i) => cue || late[i] === true),
            scores: early.map((score, i) => score ?? after[i]),
          },
          reply,
        );
      },
      (error: AppError) =>
        finish(
          controller,
          batch,
          keys,
          guesses,
          { cues, allowed, asked: cued, scores: [] },
          Err(error),
        ),
    );
  }

  /**
   * An `exclusive` ended: its slot goes to the batches that waited (R36), then to the next
   * waiting `exclusive`.
   */
  function release(controller: AbortController): void {
    if (!held.delete(controller)) return;
    batchesFirst = true;
    batcher.flush();
    pump();
    deliver();
  }
  function exclusive<T>(
    fn: (slot: number, signal: AbortSignal) => Promise<T>,
    key?: string,
    { spare = false }: Readonly<{ spare?: boolean }> = {},
  ): Promise<T> {
    const controller = new AbortController();
    return new Promise<T>((resolve) => {
      const begin = (slot: number, cancelled: boolean): void => {
        if (cancelled) controller.abort();
        else held.set(controller, slot);
        const done = fn(slot, controller.signal);
        resolve(done);
        launch(
          async () => {
            await done;
            release(controller);
          },
          () => release(controller),
        );
      };
      if (disposed) {
        begin(FIRST_COMMENT_SLOT, true);
        return;
      }
      const replaced = key === undefined ? -1 : waiting.findIndex((entry) => entry.key === key);
      const earlier = waiting[replaced];
      if (earlier === undefined) waiting.push({ key, spare, begin });
      else {
        // The newer call keeps the place in line; the older one ends without a slot.
        waiting[replaced] = { key, spare, begin };
        earlier.begin(FIRST_COMMENT_SLOT, true);
      }
      pump();
      deliver();
    });
  }

  /** The channel's records in the window now, and their mark. */
  function recordsOf(site: Site, channel: string, windowMinutes: SummaryWindow) {
    const owner = channels.get(keyOf(site, channel));
    const records = (owner?.store ?? newStore()).since(windowMinutes * MINUTE);
    return { records, mark: { revision: owner?.revision ?? 0, count: records.length } };
  }
  /**
   * Makes the summary and keeps it under the mark of the records it read last (when its slot
   * was given), unless it was made without the model's answer. It never rejects, and it leaves
   * `summarizing` however it ends, so a failed run never pins its key.
   */
  async function makeSummary(
    site: Site,
    channel: string,
    key: string,
    windowMinutes: SummaryWindow,
  ): Promise<Result<Summary>> {
    let answered = true;
    let mark: Mark | undefined;
    const settled = await capture(
      () =>
        summarize(
          { client: deps.client, model: deps.model },
          () => {
            const read = recordsOf(site, channel, windowMinutes);
            mark = read.mark;
            return read.records;
          },
          windowMinutes,
          deps.now,
          async <T>(
            fn: (slot: number, signal: AbortSignal) => Promise<Result<T>>,
          ): Promise<Result<T>> => {
            // One summary of the channel waits at a time, whatever its window.
            const reply = await exclusive(fn, keyOf(site, channel));
            if (!reply.ok) answered = false;
            return reply;
          },
        ),
      'unexpected_failure',
    );
    summarizing.delete(key);
    if (disposed) return Err(failure('operation_cancelled'));
    if (!settled.ok) return settled;
    const made = settled.value;
    if (made.ok && answered && mark !== undefined)
      summaries.set(key, { mark, summary: made.value });
    return made;
  }

  return {
    exclusive,
    guessGenre: (input) =>
      exclusive(
        async (slot, signal): Promise<Result<StreamGenre>> => {
          const replied = await deps.client.chat({
            ...genrePrompt(input),
            model: deps.model,
            slot,
            temperature: 0,
            templateKwargs: { enable_thinking: false },
            maxTokens: GENRE_MAX_TOKENS,
            signal,
          });
          return replied.ok ? Ok(parseGenre(replied.value.text)) : replied;
        },
        undefined,
        { spare: true },
      ),
    summary(site, channel, windowMinutes) {
      if (disposed) return Promise.resolve(Err(failure('operation_cancelled')));
      const key = `${keyOf(site, channel)}\u0000${windowMinutes}`;
      const pending = summarizing.get(key);
      if (pending !== undefined) return pending;
      const { mark } = recordsOf(site, channel, windowMinutes);
      const known = summaries.get(key);
      if (known?.mark.revision === mark.revision && known.mark.count === mark.count)
        return Promise.resolve(Ok(known.summary));
      const made = makeSummary(site, channel, key, windowMinutes);
      summarizing.set(key, made);
      return made;
    },
    ingest(target, { site, channel, process = true, left = false, comments }) {
      if (disposed) return { accepted: 0, dropped: 0 };
      // Only telling that the chat left the viewer: a channel not kept has nothing waiting, and
      // keeping one for it could evict another.
      if (comments.length === 0 && channels.get(keyOf(site, channel)) === undefined)
        return replyOf(0, 0);
      const droppedBefore = droppedTotal;
      // A new channel may evict the least recently processed one and drop its waiting comments.
      const owner = channelFor(site, channel, process);
      if (owner === undefined) {
        // Comments only to be stored, and every kept channel busy or recently processed: they
        // stay unstored, counted for the channel (R53, R55) and answered as dropped.
        const key = keyOf(site, channel);
        unkept.set(key, (unkept.get(key) ?? 0) + comments.length);
        droppedTotal += comments.length;
        return replyOf(0, comments.length);
      }
      if (comments.length > 0) owner.ingestedAt = deps.now();
      if (process && comments.length > 0) owner.processedAt = deps.now();
      ingesting = true;
      // The frame's chat left the viewer: what only it shows and still waits is stored (R49).
      if (left) stash(owner, target);
      let accepted = 0;
      for (const comment of comments) {
        const known = owner.seen.get(comment.id);
        if (known && !(process && known.stored)) {
          // Another frame (popout, second tab, reloaded iframe) shows it too: answer there as
          // well. One only storing it is not a frame the comment waits for (R50): its own leaving
          // must not keep the comment from being stored when the others leave.
          if (known.annotation) {
            post(target, known.annotation);
            if (!known.targets.has(frameKey(target)))
              remember((known.answered ??= new Map()), target);
          } else if (process) {
            addTarget(known, target);
            if (comment.held === true) known.held = true;
          }
          continue;
        }
        accepted += 1;
        if (known) {
          // Stored while its chat was not in front, now shown in front: processed from now on.
          known.stored = false;
          owner.stored -= 1;
          // Its record waits for the model from now on.
          if (owner.live) {
            bump(owner);
            owner.store.update(comment.id, { state: 'pending' });
          }
          known.receivedAt = deps.now();
          known.held = comment.held === true;
          addTarget(known, target);
          admit(known);
          continue;
        }
        const entry: Entry = {
          comment,
          channel: owner,
          text: hasText(comment.text) ? normalizeComment(comment.text) : '',
          receivedAt: deps.now(),
          held: process && comment.held === true,
          targets: new Map([[frameKey(target), target]]),
          stored: false,
          copypasta: false,
        };
        owner.seen.set(comment.id, entry);
        if (process) admit(entry);
        else keep(entry);
      }
      // A slot is free: start now rather than waiting for the batch window.
      if (busy() < allowed()) batcher.flush();
      // Every comment of the message waits now, so `batchOrder` sees all of them.
      pump();
      ingesting = false;
      deliver();
      return replyOf(accepted, droppedTotal - droppedBefore);
    },
    store: (site, channel) => channels.get(keyOf(site, channel))?.store ?? newStore(),
    hidden: (site, channel) =>
      (channels.get(keyOf(site, channel))?.hidden.values() ?? [])
        .filter((item) => item.verdict !== 'ok')
        .map((item) =>
          item.verdict === undefined ? item.record : { ...item.record, verdict: item.verdict },
        ),
    review(site, channel, id, verdict) {
      if (disposed) return Promise.resolve(Err(failure('operation_cancelled')));
      const owner = channels.get(keyOf(site, channel));
      const item = owner?.hidden.get(id);
      if (owner === undefined || item === undefined)
        return Promise.resolve(Err(failure('resource_missing')));
      if (item.answer !== undefined) return item.answer;
      // Saved for the streamer: the verdict applies in every stream of theirs.
      const answer = reviewed(
        feedback.record({
          ...item.record,
          channel: scopeOf(owner).owner,
          verdict,
          at: deps.now(),
        }),
      );
      for (const judged of verdict === 'ok' ? restore(owner, item.entry.text) : [item]) {
        judged.verdict = verdict;
        judged.answer = answer;
      }
      bump(owner);
      hiddenChanged(owner);
      return answer;
    },
    clearVerdicts() {
      for (const owner of channels.values()) {
        let cleared = false;
        for (const item of owner.hidden.values()) {
          if (item.verdict !== 'correct') continue;
          delete item.verdict;
          delete item.answer;
          cleared = true;
        }
        if (cleared) hiddenChanged(owner);
      }
    },
    stats(site, channel) {
      const key = keyOf(site, channel);
      const owner = channels.get(key);
      const latencyP50Ms = median(owner?.latencies ?? []);
      return {
        records: owner?.store.size() ?? 0,
        stored: owner?.stored ?? 0,
        pending: owner?.pending ?? 0,
        dropped: owner?.dropped ?? 0,
        unstored: owner?.unstored ?? unkept.get(key) ?? 0,
        failed: owner?.failed ?? 0,
        cached: owner?.cached ?? 0,
        trivial: owner?.trivial ?? 0,
        expired: owner?.expired ?? 0,
        clefSkipped: owner?.clefSkipped ?? 0,
        judge: judge.mode,
        ...(latencyP50Ms === undefined ? {} : { latencyP50Ms }),
        ...(lastError === undefined ? {} : { lastError }),
        ...(judgeError === undefined ? {} : { judgeError }),
      };
    },
    setServerSlots(totalSlots) {
      if (disposed) return;
      const spare = commentConcurrencyFor(totalSlots);
      concurrency = Math.min(requested ?? spare, spare);
      if (busy() < allowed()) batcher.flush();
      pump();
      deliver();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      subtitles?.dispose();
      for (const controller of running.keys()) controller.abort();
      running.clear();
      started.clear();
      for (const controller of held.keys()) controller.abort();
      held.clear();
      // Waiting summaries run at once with an aborted signal, so their callers get an answer.
      const unstarted = waiting;
      waiting = [];
      for (const entry of unstarted) entry.begin(FIRST_COMMENT_SLOT, true);
      summaries.clear();
      summarizing.clear();
      inFlight.clear();
      batcher.dispose();
      backlog = [];
      queued = 0;
      for (const owner of channels.values()) {
        owner.live = false;
        owner.store.clear();
        owner.seen.clear();
        owner.hidden.clear();
        owner.languages.clear();
        deps.onHiddenChange?.(owner.site, owner.channel, 0);
      }
      channels.clear();
      unkept.clear();
      textCache.clear();
      outbox.clear();
    },
  };
}
