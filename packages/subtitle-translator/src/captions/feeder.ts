import { Err, launch, type Result } from '@chrome-toolbox/contracts';
import type { Timers } from '@chrome-toolbox/extension-core';
import { TRANSLATE_LIMITS, type TranslateRequest, type TranslateResponse } from '../protocol.ts';
import type { DisplayMode } from '../settings.ts';
import type { Sentence } from './sentences.ts';
import { isJapanese } from './tracks.ts';

/**
 * The prefetch range runs from 2 s before the position to 60 s after it; a move of 2 s or more
 * from the last position is a seek; a failed sentence is sent once more after 5 s; translations
 * more than 10 minutes from the position are dropped.
 */
export const FEEDER_LIMITS = {
  behindMs: 2_000,
  aheadMs: 60_000,
  seekMs: 2_000,
  retryMs: 5_000,
  keepMs: 600_000,
} as const;

/** A caption sentence as the overlay shows it: untranslated (`pending`), translated or failed. */
export type TranslatedLine = Readonly<{
  id: string;
  startMs: number;
  endMs: number;
  source: string;
  ja?: string;
  state: 'pending' | 'done' | 'failed';
}>;

export type CaptionFeeder = {
  /** The playback position in ms, read on every video frame while playing in front. */
  position(this: void, ms: number): void;
  /** Whether the page plays in front of the viewer; nothing is sent while it does not. */
  front(this: void, on: boolean): void;
  dispose(this: void): void;
};

/**
 * What became of a sentence that was asked for: in a request, failed once and waiting for its
 * retry, free to be sent once more, translated, or failed twice. A sentence without one was not
 * asked for (or was forgotten).
 */
type Progress =
  | Readonly<{ kind: 'sending' }>
  | Readonly<{ kind: 'waiting' }>
  | Readonly<{ kind: 'again' }>
  | Readonly<{ kind: 'done'; ja: string }>
  | Readonly<{ kind: 'failed' }>;
type Item = Readonly<{ index: number; sentence: Sentence; attempt: 1 | 2 }>;
type Batch = Readonly<{ items: readonly Item[] }>;

/**
 * Drives the translation of one video's caption track from the watch page: it holds the
 * sentences and their translations, shows each sentence as it comes into range, and asks the
 * service worker (which keeps no state) for the next untranslated ones. `sentences` are in time
 * order, as `toSentences` gives them.
 *
 * In the range around the position, the next untranslated sentences are sent in time order, 4 at
 * a time, one request at a time; the next goes when the answer comes. Nothing is sent while the
 * page is not in front, the display is `source` or `off`, or the track is Japanese (its sentences
 * are shown as their own translation). With the display `off`, nothing is shown either.
 */
export function createCaptionFeeder({
  videoId,
  sentences,
  sourceLang,
  display,
  request,
  onLines,
  timers,
}: {
  /** The video the sentences belong to (`subs/translate` names it). */
  videoId: string;
  sentences: readonly Sentence[];
  sourceLang: string;
  display: () => DisplayMode;
  request: (batch: TranslateRequest) => Promise<Result<TranslateResponse>>;
  onLines: (lines: TranslatedLine[]) => void;
  timers: Timers;
}): CaptionFeeder {
  const { behindMs, aheadMs, seekMs, retryMs, keepMs } = FEEDER_LIMITS;
  const japanese = isJapanese(sourceLang);
  // The latest end among the sentences up to each index: sentences can overlap, and this keeps
  // the first one still in range findable by bisection.
  const reach: number[] = [];
  let latest = Number.NEGATIVE_INFINITY;
  for (const { endMs } of sentences) {
    latest = Math.max(latest, endMs);
    reach.push(latest);
  }
  const progress = new Map<number, Progress>();
  const retries = new Set<number>();
  /** The last position; undefined until the first. */
  let at: number | undefined;
  /** The sentences before this index in range were shown since the last seek. */
  let shownUntil = 0;
  /** The next position shows the whole range again: nothing was shown while the display was off. */
  let stale = true;
  let inFront = true;
  let inFlight: Batch | undefined;
  let disposed = false;

  /** The first index for which `test` holds, `test` holding from some index to the end. */
  function firstWhere(test: (index: number) => boolean): number {
    let low = 0;
    let high = sentences.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (test(middle)) high = middle;
      else low = middle + 1;
    }
    return low;
  }
  const overlaps = (sentence: Sentence, ms: number, before: number, after: number): boolean =>
    sentence.endMs >= ms - before && sentence.startMs <= ms + after;
  /** The first sentence that may be in the prefetch range around `ms`. */
  const rangeStart = (ms: number): number =>
    firstWhere((index) => (reach[index] ?? 0) >= ms - behindMs);
  /** The first sentence after the prefetch range around `ms`. */
  const rangeEnd = (ms: number): number =>
    firstWhere((index) => (sentences[index]?.startMs ?? Number.POSITIVE_INFINITY) > ms + aheadMs);
  /** The sentence at `index` when it is in the prefetch range around `ms`. */
  function inRange(index: number, ms: number): Sentence | undefined {
    const sentence = sentences[index];
    return sentence !== undefined && overlaps(sentence, ms, behindMs, aheadMs)
      ? sentence
      : undefined;
  }

  function lineOf(index: number, { id, startMs, endMs, source }: Sentence): TranslatedLine {
    if (japanese) return { id, startMs, endMs, source, ja: source, state: 'done' };
    const state = progress.get(index);
    if (state?.kind === 'done') return { id, startMs, endMs, source, ja: state.ja, state: 'done' };
    return { id, startMs, endMs, source, state: state?.kind === 'failed' ? 'failed' : 'pending' };
  }

  /**
   * Shows the sentences in range not shown yet; after a seek, all of them again. Called on every
   * frame, it does nothing more than two bisections until a sentence comes into range.
   */
  function show(ms: number, again: boolean): void {
    const end = rangeEnd(ms);
    const start = again ? rangeStart(ms) : Math.max(rangeStart(ms), shownUntil);
    shownUntil = again ? end : Math.max(shownUntil, end);
    if (start >= end) return;
    const lines: TranslatedLine[] = [];
    for (let index = start; index < end; index += 1) {
      const sentence = inRange(index, ms);
      if (sentence !== undefined) lines.push(lineOf(index, sentence));
    }
    if (lines.length > 0) onLines(lines);
  }

  function translating(): boolean {
    const mode = display();
    return inFront && !japanese && mode !== 'off' && mode !== 'source';
  }

  /** Forgets what is known of sentences more than 10 minutes from `ms` (not those being sent). */
  function prune(ms: number): void {
    for (const [index, state] of progress) {
      const sentence = sentences[index];
      if (state.kind === 'sending') continue;
      if (sentence === undefined || !overlaps(sentence, ms, keepMs, keepMs)) progress.delete(index);
    }
  }

  /** Lets the sentences that failed once be sent again after 5 s. */
  function retryLater(indexes: readonly number[]): void {
    const timer = timers.set(() => {
      retries.delete(timer);
      for (const index of indexes)
        if (progress.get(index)?.kind === 'waiting') progress.set(index, { kind: 'again' });
      pump();
    }, retryMs);
    retries.add(timer);
  }

  /** An answer: kept for sentences within 10 minutes of the position (it may have moved). */
  function settle(batch: Batch, result: Result<TranslateResponse>): void {
    if (inFlight !== batch) return;
    inFlight = undefined;
    const answers = new Map(result.ok ? result.value.lines.map((line) => [line.id, line]) : []);
    const ms = at ?? 0;
    const changed: TranslatedLine[] = [];
    const failedOnce: number[] = [];
    for (const { index, sentence, attempt } of batch.items) {
      if (!overlaps(sentence, ms, keepMs, keepMs)) {
        progress.delete(index);
        continue;
      }
      const answer = answers.get(sentence.id);
      if (answer?.state === 'done' && answer.ja !== undefined)
        progress.set(index, { kind: 'done', ja: answer.ja });
      else if (attempt === 1) {
        progress.set(index, { kind: 'waiting' });
        failedOnce.push(index);
        continue;
      } else progress.set(index, { kind: 'failed' });
      changed.push(lineOf(index, sentence));
    }
    if (failedOnce.length > 0) retryLater(failedOnce);
    if (changed.length > 0) onLines(changed);
    pump();
  }

  /** Sends the next untranslated sentences in range, when nothing else is being sent. */
  function pump(): void {
    if (disposed || inFlight !== undefined || at === undefined || !translating()) return;
    const ms = at;
    // Made only when there is something to send: with everything in range translated, this runs
    // on every frame.
    let items: Item[] | undefined;
    const end = rangeEnd(ms);
    for (let index = rangeStart(ms); index < end; index += 1) {
      const sentence = inRange(index, ms);
      const state = progress.get(index);
      if (sentence === undefined || (state !== undefined && state.kind !== 'again')) continue;
      items ??= [];
      items.push({ index, sentence, attempt: state === undefined ? 1 : 2 });
      if (items.length === TRANSLATE_LIMITS.sentences) break;
    }
    const head = items?.[0];
    if (items === undefined || head === undefined) return;
    prune(ms);
    for (const { index } of items) progress.set(index, { kind: 'sending' });
    const batch: Batch = { items };
    inFlight = batch;
    const previous = sentences
      .slice(Math.max(0, head.index - TRANSLATE_LIMITS.previous), head.index)
      .map((sentence) => sentence.source);
    const payload: TranslateRequest = {
      videoId,
      sourceLang,
      previous,
      sentences: items.map(({ sentence }) => ({ id: sentence.id, source: sentence.source })),
    };
    launch(
      async () => {
        settle(batch, await request(payload));
      },
      (error) => settle(batch, Err(error)),
    );
  }

  return {
    position(ms) {
      if (disposed) return;
      const seeked = at === undefined || Math.abs(ms - at) >= seekMs;
      at = ms;
      if (display() === 'off') {
        stale = true;
        return;
      }
      show(ms, seeked || stale);
      stale = false;
      pump();
    },
    front(on) {
      if (disposed) return;
      inFront = on;
      pump();
    },
    dispose() {
      disposed = true;
      inFlight = undefined;
      for (const timer of retries) timers.clear(timer);
      retries.clear();
      progress.clear();
    },
  };
}
