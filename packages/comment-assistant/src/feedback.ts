import { z } from 'zod/mini';
import { capture, decode, Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  ABUSIVE_THRESHOLD,
  commentCategorySchema,
  commentRecordSchema,
  type CommentCategory,
  type CommentCorrection,
  type StorageArea,
} from '@chrome-toolbox/extension-core';
import { normalizeComment } from './fastpath.ts';
import { cut } from './sites/types.ts';
import {
  feedbackVerdictSchema,
  MAX_COMMENT_TEXT,
  verdictSourceSchema,
  type FeedbackVerdict,
  type HiddenEntry,
  type VerdictSource,
} from './protocol.ts';

type Site = HiddenEntry['site'];

export const feedbackLimits = {
  /** Hidden comments kept in memory per channel for review. */
  hiddenPerChannel: 200,
  /** Verdicts kept in extension storage, all channels together. */
  entries: 1000,
  /** Corrections a channel's batch prompt carries by default. */
  corrections: 5,
  /** Characters of one correction in a prompt (YouTube chat's own limit). */
  correctionText: 200,
  /** Characters of a saved translation, so 1,000 verdicts stay far below the 10 MB storage quota. */
  translation: 1000,
} as const;

/** Categories the chat hides or blurs by default; the pipeline keeps these comments for review. */
export const HIDDEN_CATEGORIES: ReadonlySet<CommentCategory> = new Set([
  'abusive',
  'spam',
  'spoiler',
]);

/**
 * The threshold a channel gets once at least `RAISE_AFTER` comments the viewer restored had
 * Clef probabilities averaging the default threshold or more: their mean, but at least
 * `RAISED_THRESHOLD` and at most `MAX_THRESHOLD`, so Clef still flags the clearest abuse.
 */
const RAISE_AFTER = 3;
const RAISED_THRESHOLD = 0.9;
const MAX_THRESHOLD = 0.95;
/** Reads of the saved verdicts: at most this many, at least this far apart. */
const MAX_READS = 3;
const READ_AGAIN_AFTER_MS = 30_000;

export type HiddenLog<T> = {
  /** Adds or refreshes an item as the newest; beyond the cap the oldest goes. */
  add(this: void, id: string, item: T): void;
  get(this: void, id: string): T | undefined;
  /** Oldest first. */
  values(this: void): T[];
  size(this: void): number;
  clear(this: void): void;
};

/** The newest `max` hidden comments of one channel, in memory, keyed by comment id. */
export function createHiddenLog<T>(max: number = feedbackLimits.hiddenPerChannel): HiddenLog<T> {
  const items = new Map<string, T>();
  return {
    add(id, item) {
      items.delete(id);
      items.set(id, item);
      for (const oldest of items.keys()) {
        if (items.size <= max) break;
        items.delete(oldest);
      }
    },
    get: (id) => items.get(id),
    values: () => [...items.values()],
    size: () => items.size,
    clear: () => items.clear(),
  };
}

const feedbackEntrySchema = z.strictObject({
  site: commentRecordSchema.shape.site,
  channel: z.string(),
  text: z.string().check(z.maxLength(MAX_COMMENT_TEXT)),
  translation: z.optional(z.string().check(z.maxLength(feedbackLimits.translation))),
  category: commentCategorySchema,
  abusive: z.optional(z.number().check(z.gte(0), z.lte(1))),
  /** What decided the category (a rule, the model or Clef). */
  source: z.optional(verdictSourceSchema),
  verdict: feedbackVerdictSchema,
  /** When the viewer gave the verdict. */
  at: z.number(),
});
type FeedbackEntry = z.infer<typeof feedbackEntrySchema>;
/** One verdict on a hidden comment; the author is never part of it. */
export type FeedbackInput = Readonly<{
  site: Site;
  channel: string;
  text: string;
  translation?: string | undefined;
  category: CommentCategory;
  abusive?: number | undefined;
  source?: VerdictSource | undefined;
  verdict: FeedbackVerdict;
  at: number;
}>;

export type FeedbackStore = {
  /**
   * Reads the saved verdicts and puts them before the ones given since; Ok once read. Until a
   * read succeeds the store is session-only and writes nothing, so the saved verdicts are never
   * overwritten. A failed read is tried again by a later call: at most 3 reads, 30 s apart, then
   * the session-only verdicts stay.
   */
  load(this: void): Promise<Result<void>>;
  /**
   * Takes a verdict into account at once. The promise settles when the write that saves it
   * ends: verdicts given while a write runs share the next one. `storage_failed` means it is
   * not saved yet (the write failed, or the saved verdicts are not read); the next write that
   * succeeds saves it with the rest.
   */
  record(this: void, input: FeedbackInput): Promise<Result<void>>;
  /** Forgets every verdict, in memory and in storage, with the allowlists and raised thresholds. */
  clear(this: void): Promise<Result<void>>;
  /** Normalized texts (`normalizeComment`) the viewer marked `ok` in the channel. */
  allowlist(this: void, site: Site, channel: string): ReadonlySet<string>;
  /** The channel's `ok` verdicts, newest first and one per text, for its batch prompts. */
  corrections(this: void, site: Site, channel: string, limit?: number): CommentCorrection[];
  /** The channel's Clef threshold: `ABUSIVE_THRESHOLD` unless its restores raised it. */
  threshold(this: void, site: Site, channel: string): number;
  /** One JSON object per line, oldest first: text, translation, category, Clef probability, verdict and time. */
  export(this: void): string;
};

const STORAGE_KEY = 'feedback';
const NOTHING: ReadonlySet<string> = new Set();
type ChannelFeedback = {
  allowlist: Set<string>;
  /** Newest first, one per normalized text. */
  corrections: CommentCorrection[];
  /** Clef probabilities of the restored abusive comments. */
  scores: number[];
  threshold: number;
};

function raisedThreshold(scores: readonly number[]): number {
  if (scores.length < RAISE_AFTER) return ABUSIVE_THRESHOLD;
  // Rounded so three restores at exactly 0.8 count as averaging 0.8.
  const mean =
    Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 1e6) / 1e6;
  if (mean < ABUSIVE_THRESHOLD) return ABUSIVE_THRESHOLD;
  return Math.min(MAX_THRESHOLD, Math.max(RAISED_THRESHOLD, mean));
}

function channelIndex(entries: readonly FeedbackEntry[]): Map<string, ChannelFeedback> {
  const index = new Map<string, ChannelFeedback>();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry === undefined || entry.verdict !== 'ok') continue;
    const key = `${entry.site}:${entry.channel}`;
    const channel: ChannelFeedback = index.get(key) ?? {
      allowlist: new Set(),
      corrections: [],
      scores: [],
      threshold: ABUSIVE_THRESHOLD,
    };
    index.set(key, channel);
    const normalized = normalizeComment(entry.text);
    // A text counts once (its newest verdict), however often its copies were restored.
    if (channel.allowlist.has(normalized)) continue;
    channel.allowlist.add(normalized);
    channel.corrections.push({
      text: cut(entry.text, feedbackLimits.correctionText),
      category: entry.category,
    });
    if (entry.category === 'abusive' && entry.abusive !== undefined)
      channel.scores.push(entry.abusive);
  }
  for (const channel of index.values()) channel.threshold = raisedThreshold(channel.scores);
  return index;
}

/**
 * Verdicts on hidden comments, newest 1,000 of all channels, saved under `feedback` in `area`
 * (`chrome.storage.local`) until newer ones replace them or `clear` removes them; nothing leaves
 * the device. Without an area they last for the session only. Call `load` before relying on
 * the saved verdicts.
 */
export function createFeedbackStore({
  area,
  now = () => Date.now(),
}: { area?: StorageArea; now?: () => number } = {}): FeedbackStore {
  let entries: readonly FeedbackEntry[] = [];
  let index = channelIndex(entries);
  /** The saved verdicts are read, or there are none: a write may replace them. */
  let loaded = area === undefined;
  let reads = 0;
  let lastRead = Number.NEGATIVE_INFINITY;
  let reading: Promise<Result<void>> | undefined;
  /** The latest write, and the one that will take the verdicts given since it started. */
  let last: Promise<Result<void>> = Promise.resolve(Ok(undefined));
  let next: Promise<Result<void>> | undefined;

  async function write(previous: Promise<Result<void>>): Promise<Result<void>> {
    await previous;
    // This write takes every verdict given so far; a later one needs the next write.
    next = undefined;
    if (area === undefined) return Ok(undefined);
    if (!loaded) return Err(failure('storage_failed'));
    const snapshot = entries;
    const written = await capture(() => area.set({ [STORAGE_KEY]: snapshot }), 'storage_failed');
    return written.ok ? Ok(undefined) : written;
  }
  function save(): Promise<Result<void>> {
    if (next !== undefined) return next;
    last = write(last);
    next = last;
    return next;
  }
  const channel = (site: Site, name: string): ChannelFeedback | undefined =>
    index.get(`${site}:${name}`);
  function replace(list: readonly FeedbackEntry[]): void {
    // A new array each time: a write in progress keeps the snapshot it took.
    entries = list.slice(-feedbackLimits.entries);
    index = channelIndex(entries);
  }
  async function read(storage: StorageArea): Promise<Result<void>> {
    const stored = await capture(() => storage.get(STORAGE_KEY), 'storage_failed');
    reading = undefined;
    // Cleared while reading: the saved verdicts are no longer wanted.
    if (loaded) return Ok(undefined);
    if (!stored.ok) return stored;
    const value: unknown = stored.value[STORAGE_KEY];
    const saved = (Array.isArray(value) ? value : []).flatMap((item: unknown) => {
      const entry = decode(feedbackEntrySchema, item);
      return entry.ok ? [entry.value] : [];
    });
    const session = entries;
    replace([...saved, ...session]);
    loaded = true;
    // Verdicts given while the store was session-only are saved with the ones read.
    return session.length === 0 ? Ok(undefined) : save();
  }

  return {
    load() {
      if (loaded) return Promise.resolve(Ok(undefined));
      if (reading !== undefined) return reading;
      if (area === undefined || reads >= MAX_READS || now() - lastRead < READ_AGAIN_AFTER_MS)
        return Promise.resolve(Err(failure('storage_failed')));
      reads += 1;
      lastRead = now();
      reading = read(area);
      return reading;
    },
    clear() {
      replace([]);
      // Nothing saved is wanted any more, so the store may write without having read.
      loaded = true;
      return save();
    },
    record(input) {
      const entry: FeedbackEntry = {
        site: input.site,
        channel: input.channel,
        text: cut(input.text, MAX_COMMENT_TEXT),
        ...(input.translation === undefined
          ? {}
          : { translation: cut(input.translation, feedbackLimits.translation) }),
        category: input.category,
        ...(input.abusive === undefined ? {} : { abusive: input.abusive }),
        ...(input.source === undefined ? {} : { source: input.source }),
        verdict: input.verdict,
        at: input.at,
      };
      replace([...entries, entry]);
      return save();
    },
    allowlist: (site, name) => channel(site, name)?.allowlist ?? NOTHING,
    corrections: (site, name, limit = feedbackLimits.corrections) =>
      (channel(site, name)?.corrections ?? []).slice(0, limit),
    threshold: (site, name) => channel(site, name)?.threshold ?? ABUSIVE_THRESHOLD,
    export: () =>
      entries
        .map(
          (entry) =>
            `${JSON.stringify({
              text: entry.text,
              translation: entry.translation,
              category: entry.category,
              abusive: entry.abusive,
              source: entry.source,
              verdict: entry.verdict,
              at: entry.at,
            })}\n`,
        )
        .join(''),
  };
}
