import { Err, launch, type AppError, type Result } from '@chrome-toolbox/contracts';
import type { AsrClient, AsrLine, Timers } from '@chrome-toolbox/extension-core';
import { SENTENCE_END, separator } from '../captions/sentences.ts';
import { cutText, isKorean } from '../captions/tracks.ts';
import type { GlossaryEntry } from '../glossary.ts';
import type { LineInput } from '../line-translator.ts';
import type { LiveLine } from '../protocol.ts';
import type { DisplayMode, SubtitleSettings, SubtitleTranslator } from '../settings.ts';
import { createLanguageTally } from './language.ts';
import { createLatencyRing } from './latency.ts';
import type { Segment } from './vad.ts';

/**
 * The bounds of the live pipeline (spec §6): what may wait for slot 0, how long after its speech
 * ended a job may still start, where a sentence ends, and what the stats keep.
 */
export const LIVE_LIMITS = {
  asrWaiting: 2,
  translationWaiting: 2,
  asrStartDeadlineMs: 1500,
  translationStartDeadlineMs: 2500,
  sentenceMaxMs: 6000,
  sentenceMaxChars: 200,
  sentenceGapMs: 700,
  contextSentences: 3,
  latencyRing: 200,
  languageWindow: 20,
} as const;

/**
 * What the pipeline reads for each request; `glossary` has been through `toPromptGlossary`, and
 * `sourceLang` is the settings' (`auto`, or the language the viewer fixed). `translator` is not read
 * here: it reaches the offscreen document with `audio/config` and is read by the line translator
 * that `translate` wraps (Task 13).
 */
export type LiveConfig = Readonly<{
  display: DisplayMode;
  sourceLang: SubtitleSettings['sourceLang'];
  context: string;
  glossary: readonly GlossaryEntry[];
  translator: SubtitleTranslator;
}>;

/**
 * What the pipeline did since it was made, for the status:
 * - `segments` pushed; of those, `silent` (recognized without text), `dropped` (thrown away
 *   unrecognized: the oldest of three waiting, by `away` or `reset`, or pushed while away),
 *   `expired` (not started within `asrStartDeadlineMs` of the speech end);
 * - `skipped` translations not run (the oldest of three sentences waiting, not started within
 *   `translationStartDeadlineMs`, or by `away` or `reset`): the sentence stays in its source;
 * - `failed` recognitions and translations the server failed (none aborted here);
 * - `lang`, the language tally's; `sourceP50Ms` from the speech end to its source line, `jaP50Ms`
 *   and `jaP95Ms` to its Japanese line, over the last `latencyRing` of each.
 */
export type LiveStats = Readonly<{
  segments: number;
  silent: number;
  dropped: number;
  expired: number;
  skipped: number;
  failed: number;
  lang?: string;
  sourceP50Ms?: number;
  jaP50Ms?: number;
  jaP95Ms?: number;
}>;

/** The tab's front state as the pipeline follows it (R44). */
export type LiveMode = 'active' | 'pause' | 'away';

export type LivePipeline = {
  /**
   * A closed segment. `endedAt` is when its speech ended on the `now` clock: when it was received,
   * minus `trailingSilenceMs` and `carriedMs` (S45). Its `pcm` is kept until it is recognized or
   * dropped, so the caller passes one it does not reuse (the worklet posts its own copy).
   */
  push(this: void, segment: Segment & { endedAt: number }): void;
  /**
   * Follows the front state; the pipeline starts `active`.
   * - `pause`: what was pushed, and the segment a flush closes, still runs (the caller stops the
   *   input).
   * - `away`: drops what waits, aborts the running request and closes the open sentence; until the
   *   next `active` or `pause`, each pushed segment is dropped.
   * - `active` after `pause` or `away`: the next segment starts a new sentence, because the gap
   *   across the stop is unknown (the VAD is reset on resume) and a muted stream went on meanwhile.
   */
  mode(this: void, kind: LiveMode): void;
  /**
   * For a YouTube SPA navigation: forgets the language, the context and the open sentence (without
   * emitting it), and drops queued work and the running request, which belong to the last video.
   */
  reset(this: void): void;
  stats(this: void): LiveStats;
  /** Aborts the running request; nothing runs or is emitted after it. */
  dispose(this: void): void;
};

/** What a segment that left no text hands to the segment after it. */
type Lead = { broken: boolean; gapMs: number };
const noLead = (): Lead => ({ broken: false, gapMs: 0 });

type AsrJob = Readonly<{
  kind: 'asr';
  /** Jobs are numbered as they are made. */
  order: number;
  endedAt: number;
  pcm: Int16Array;
  durationMs: number;
  gapBeforeMs: number;
  /**
   * Set by the segments just before this one that left no text: `broken` when one was lost
   * unrecognized (its words are missing, so this text does not join the open sentence), and the
   * time of silent ones, which counts toward the gap.
   */
  lead: Lead;
}>;

/** A sentence as last shown; the open one grows as segments join it. */
type Sentence = {
  readonly id: string;
  /** Sentences are numbered as they open. */
  readonly n: number;
  readonly lang: string;
  source: string;
  /** When the speech of its last segment ended. */
  endedAt: number;
  /** Its segments' audio and the gaps between them. */
  spanMs: number;
  final: boolean;
  state: LiveLine['state'];
  ja: string | undefined;
};

/** The translation of a sentence's source as it was when the job was made. */
type TranslationJob = Readonly<{
  kind: 'translation';
  order: number;
  endedAt: number;
  sentence: Sentence;
  source: string;
  previous: readonly string[];
}>;

type Job = AsrJob | TranslationJob;
type Running = Readonly<{ job: Job; controller: AbortController }>;

const startDeadlineOf = (job: Job): number =>
  job.kind === 'asr' ? LIVE_LIMITS.asrStartDeadlineMs : LIVE_LIMITS.translationStartDeadlineMs;

/** The order jobs run in: the older speech end first, a translation first on a tie. */
const runsBefore = (a: Job, b: Job): number =>
  a.endedAt - b.endedAt ||
  (a.kind === b.kind ? 0 : a.kind === 'translation' ? -1 : 1) ||
  a.order - b.order;

const lineOf = (sentence: Sentence): LiveLine => ({
  sentenceId: sentence.id,
  lang: sentence.lang,
  source: sentence.source,
  ...(sentence.ja === undefined ? {} : { ja: sentence.ja }),
  state: sentence.state,
  endedAt: sentence.endedAt,
  final: sentence.final,
});

/**
 * Live subtitles from closed segments of tab audio, on slot 0 (spec §6): each segment is
 * recognized (`asr`), its text shown at once as a source line, joined into a sentence, and the
 * sentence translated (`translate`, which builds its own prompt: S22). One request runs at a time,
 * recognitions and translations in one queue, also when PLaMo translates (S17).
 *
 * What cannot keep up is dropped rather than queued: at most `asrWaiting` segments and
 * `translationWaiting` sentences wait, the oldest going first (a newer version of a sentence
 * replaces its waiting translation), and a job not started within its deadline of its speech end
 * is dropped, as soon as it is late. A recognition that fails is counted and its segment shows
 * nothing (Task 4: a cut can make the model repeat itself, `response_invalid`).
 *
 * A text that does not end with `.?!。？！` leaves its sentence open: the next text joins it and the
 * sentence is shown and translated again under the same id. It closes (`final`) at an end mark,
 * before a text after a gap of `sentenceGapMs` (silent segments in between count) or in another
 * language, after a lost segment, after a stop, or once it spans `sentenceMaxMs` or reaches
 * `sentenceMaxChars`. Japanese lines are not translated; they show their source as `ja`. With the
 * display on `source` (or `off`) nothing is translated. A translation gets the closed sentences in
 * its language among the last `contextSentences` (the only transcript kept) as `previous`.
 */
export function createLivePipeline(deps: {
  asr: AsrClient;
  translate: (input: LineInput & { signal: AbortSignal }) => Promise<Result<string>>;
  config: () => LiveConfig;
  emit: (line: LiveLine) => void;
  /** The clock of `endedAt`, in ms. */
  now: () => number;
  timers: Timers;
  /**
   * Each recognition or translation the server failed (not one aborted here), after it is counted:
   * Task 13 stops the capture on `audio_unsupported`.
   */
  onFailure?: (error: AppError) => void;
}): LivePipeline {
  const { asr, translate, config, emit, now, timers } = deps;
  const tally = createLanguageTally(LIVE_LIMITS.languageWindow);
  const sourceLatency = createLatencyRing(LIVE_LIMITS.latencyRing);
  const jaLatency = createLatencyRing(LIVE_LIMITS.latencyRing);
  const counts = { segments: 0, silent: 0, dropped: 0, expired: 0, skipped: 0, failed: 0 };
  let current: LiveMode = 'active';
  let disposed = false;
  let jobs = 0;
  let sentences = 0;
  /** Waiting segments, in the order they came. */
  let segmentsWaiting: AsrJob[] = [];
  /** Waiting translations, one per sentence. */
  let translationsWaiting: TranslationJob[] = [];
  let running: Running | undefined;
  let expiry: number | undefined;
  /** What the next pushed segment inherits. */
  let lead = noLead();
  let open: Sentence | undefined;
  /** The last closed sentences, oldest first. */
  let closed: Readonly<{ lang: string; source: string }>[] = [];

  const nextOrder = (): number => (jobs += 1);
  const late = (job: Job): boolean => now() - job.endedAt > startDeadlineOf(job);
  const waiting = (): Job[] => [...segmentsWaiting, ...translationsWaiting].sort(runsBefore);

  function remove(job: Job): void {
    if (job.kind === 'asr') segmentsWaiting = segmentsWaiting.filter((other) => other !== job);
    else translationsWaiting = translationsWaiting.filter((other) => other !== job);
  }

  /** Hands what `after` leaves to the segment after it: a waiting one, or the next pushed. */
  function passOn(after: AsrJob, broken: boolean, gapMs: number): void {
    const next = segmentsWaiting.find((job) => job.order > after.order)?.lead ?? lead;
    next.broken ||= broken;
    next.gapMs += gapMs;
  }

  /** A segment gone unrecognized: the text after it does not join the text before it. */
  function lose(job: AsrJob, count: 'dropped' | 'expired' | 'failed'): void {
    counts[count] += 1;
    passOn(job, true, 0);
  }

  function skip(sentence: Sentence): void {
    counts.skipped += 1;
    sentence.state = 'skipped';
  }

  /** Marks the sentence final and keeps its source as context. */
  function close(sentence: Sentence): Sentence {
    sentence.final = true;
    if (open === sentence) open = undefined;
    closed = [...closed, { lang: sentence.lang, source: sentence.source }].slice(
      -LIVE_LIMITS.contextSentences,
    );
    return sentence;
  }

  function expire(job: Job): void {
    if (job.kind === 'asr') lose(job, 'expired');
    else {
      skip(job.sentence);
      emit(lineOf(job.sentence));
    }
  }

  function enqueueTranslation(sentence: Sentence, previous: readonly string[]): void {
    translationsWaiting = [
      ...translationsWaiting,
      {
        kind: 'translation',
        order: nextOrder(),
        endedAt: sentence.endedAt,
        sentence,
        source: sentence.source,
        previous,
      },
    ];
    if (translationsWaiting.length <= LIVE_LIMITS.translationWaiting) return;
    const oldest = translationsWaiting.reduce((a, b) => (b.sentence.n < a.sentence.n ? b : a));
    remove(oldest);
    skip(oldest.sentence);
    emit(lineOf(oldest.sentence));
  }

  /** Shows the sentence as it is now, then has it translated unless it needs none. */
  function show(sentence: Sentence, previous: readonly string[]): void {
    const at = now();
    sourceLatency.record(at - sentence.endedAt);
    // A translation still waiting is of an older version.
    translationsWaiting = translationsWaiting.filter((job) => job.sentence !== sentence);
    if (sentence.lang === 'ja') {
      sentence.state = 'done';
      sentence.ja = sentence.source;
      jaLatency.record(at - sentence.endedAt);
      emit(lineOf(sentence));
      return;
    }
    const { display } = config();
    const translated = display === 'ja' || display === 'both';
    sentence.state = translated ? 'pending' : 'done';
    sentence.ja = undefined;
    emit(lineOf(sentence));
    if (translated) enqueueTranslation(sentence, previous);
  }

  /** A transcript: joins the open sentence or opens one. */
  function heard(job: AsrJob, lang: string, text: string): void {
    tally.observe(lang);
    const gapMs = job.gapBeforeMs + job.lead.gapMs;
    let sentence = open;
    if (sentence !== undefined) {
      const joined = `${sentence.source}${separator(sentence.source, text, isKorean(lang))}${text}`;
      if (
        job.lead.broken ||
        gapMs >= LIVE_LIMITS.sentenceGapMs ||
        sentence.lang !== lang ||
        joined.length > LIVE_LIMITS.sentenceMaxChars
      ) {
        emit(lineOf(close(sentence)));
        sentence = undefined;
      } else {
        sentence.source = joined;
        sentence.endedAt = job.endedAt;
        sentence.spanMs += gapMs + job.durationMs;
      }
    }
    const previous = closed.filter((other) => other.lang === lang).map((other) => other.source);
    if (sentence === undefined) {
      sentences += 1;
      sentence = {
        id: `live:${sentences}`,
        n: sentences,
        lang,
        source: cutText(text, LIVE_LIMITS.sentenceMaxChars),
        endedAt: job.endedAt,
        spanMs: job.durationMs,
        final: false,
        state: 'pending',
        ja: undefined,
      };
      open = sentence;
    }
    if (
      SENTENCE_END.test(sentence.source) ||
      sentence.spanMs >= LIVE_LIMITS.sentenceMaxMs ||
      sentence.source.length >= LIVE_LIMITS.sentenceMaxChars
    )
      close(sentence);
    show(sentence, previous);
  }

  function recognized(job: AsrJob, result: Result<AsrLine>): void {
    if (!result.ok) {
      lose(job, 'failed');
      deps.onFailure?.(result.error);
      return;
    }
    const text = result.value.text.trim();
    if (text !== '') {
      heard(job, result.value.lang, text);
      return;
    }
    // Silence says nothing about the language (S35); its time counts toward the next gap.
    counts.silent += 1;
    passOn(job, job.lead.broken, job.lead.gapMs + job.gapBeforeMs + job.durationMs);
  }

  function translated(job: TranslationJob, result: Result<string>): void {
    const { sentence } = job;
    if (result.ok) {
      sentence.state = 'done';
      sentence.ja = result.value;
      jaLatency.record(now() - job.endedAt);
    } else {
      counts.failed += 1;
      sentence.state = 'failed';
    }
    emit(lineOf(sentence));
    if (!result.ok) deps.onFailure?.(result.error);
  }

  /** Settles the running job, unless `away`, `reset` or `dispose` dropped it meanwhile. */
  function finish(run: Running, settle: () => void): void {
    if (running !== run) return;
    running = undefined;
    settle();
    pump();
  }

  function start(job: Job): void {
    const controller = new AbortController();
    const run: Running = { job, controller };
    const { signal } = controller;
    running = run;
    const fail = (error: AppError): void =>
      finish(run, () =>
        job.kind === 'asr' ? recognized(job, Err(error)) : translated(job, Err(error)),
      );
    launch(async () => {
      const { sourceLang, context, glossary } = config();
      if (job.kind === 'asr') {
        const line = await asr.transcribe(job.pcm, { sourceLang, context, glossary, signal });
        finish(run, () => recognized(job, line));
        return;
      }
      const ja = await translate({
        source: job.source,
        sourceLang: job.sentence.lang,
        previous: job.previous,
        context,
        glossary,
        signal,
      });
      finish(run, () => translated(job, ja));
    }, fail);
  }

  /** Starts the next job unless one runs, dropping those already late at the head. */
  function pump(): void {
    while (!disposed && current !== 'away' && running === undefined) {
      const [job] = waiting();
      if (job === undefined) break;
      remove(job);
      if (late(job)) expire(job);
      else start(job);
    }
    arm();
  }

  /** One timer, for the earliest start deadline of what waits. */
  function arm(): void {
    if (expiry !== undefined) timers.clear(expiry);
    expiry = undefined;
    const due = Math.min(...waiting().map((job) => job.endedAt + startDeadlineOf(job)));
    if (!disposed && Number.isFinite(due)) expiry = timers.set(sweep, Math.max(0, due - now()) + 1);
  }

  function sweep(): void {
    expiry = undefined;
    for (const job of waiting()) {
      if (!late(job)) continue;
      remove(job);
      expire(job);
    }
    pump();
  }

  /** Drops what waits and aborts what runs; returns the sentences whose translation it dropped. */
  function abandon(): Sentence[] {
    const touched = translationsWaiting.map((job) => job.sentence);
    counts.dropped += segmentsWaiting.length;
    segmentsWaiting = [];
    translationsWaiting = [];
    const run = running;
    running = undefined;
    if (run !== undefined) {
      run.controller.abort();
      if (run.job.kind === 'asr') counts.dropped += 1;
      else touched.push(run.job.sentence);
    }
    for (const sentence of touched) skip(sentence);
    lead = noLead();
    arm();
    return touched;
  }

  return {
    push(segment) {
      if (disposed) return;
      counts.segments += 1;
      if (current === 'away') {
        counts.dropped += 1;
        return;
      }
      segmentsWaiting = [
        ...segmentsWaiting,
        {
          kind: 'asr',
          order: nextOrder(),
          endedAt: segment.endedAt,
          pcm: segment.pcm,
          durationMs: segment.durationMs,
          gapBeforeMs: segment.gapBeforeMs,
          lead,
        },
      ];
      lead = noLead();
      const [oldest] = segmentsWaiting;
      if (oldest !== undefined && segmentsWaiting.length > LIVE_LIMITS.asrWaiting) {
        remove(oldest);
        lose(oldest, 'dropped');
      }
      pump();
    },
    mode(kind) {
      if (disposed) return;
      if (kind === 'away') {
        if (current !== 'away') {
          const touched = abandon();
          if (open !== undefined) touched.push(close(open));
          const shown = [...new Set(touched)].sort((a, b) => a.n - b.n);
          for (const sentence of shown) emit(lineOf(sentence));
        }
        current = 'away';
        return;
      }
      if (kind === 'active' && current !== 'active') lead.broken = true;
      current = kind;
      pump();
    },
    reset() {
      if (disposed) return;
      abandon();
      open = undefined;
      closed = [];
      tally.reset();
    },
    stats() {
      const lang = tally.current();
      const sourceP50Ms = sourceLatency.percentile(50);
      const jaP50Ms = jaLatency.percentile(50);
      const jaP95Ms = jaLatency.percentile(95);
      return {
        ...counts,
        ...(lang === undefined ? {} : { lang }),
        ...(sourceP50Ms === undefined ? {} : { sourceP50Ms: Math.round(sourceP50Ms) }),
        ...(jaP50Ms === undefined ? {} : { jaP50Ms: Math.round(jaP50Ms) }),
        ...(jaP95Ms === undefined ? {} : { jaP95Ms: Math.round(jaP95Ms) }),
      };
    },
    dispose() {
      disposed = true;
      running?.controller.abort();
      running = undefined;
      segmentsWaiting = [];
      translationsWaiting = [];
      open = undefined;
      closed = [];
      arm();
    },
  };
}
