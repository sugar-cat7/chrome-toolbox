import {
  Err,
  failure,
  launch,
  Ok,
  rawChatCommentSchema,
  type RawChatComment,
  type RelayComment,
  type RelayCounters,
  type Result,
} from '@chrome-toolbox/contracts';
import { createLruCache, systemTimers, type Timers } from './bounded.ts';
import { needsTranslation, scriptLanguageGuess } from './language.ts';
import type { LlamaClient } from './llm.ts';
import {
  parsePlamoLine,
  PLAMO_TRANSLATE_MODEL,
  plamoLanguage,
  plamoTranslateRequest,
} from './plamo.ts';
import { createQueue } from './queue.ts';
import { createRelayMemo } from './relay-cache.ts';
import { isAbusive, type ToxicityJudge } from './toxicity.ts';

export type { RelayComment, RelayCounters } from '@chrome-toolbox/contracts';

/** Initial design thresholds, inclusive at the boundary. */
export const RELAY_THRESHOLDS = { mild: 0.9, normal: 0.8, strict: 0.7 } as const;

export type RelayConfiguration = Readonly<{
  sessionId: string;
  judge: ToxicityJudge;
  plamo: LlamaClient;
  threshold: number;
  translate: boolean;
  sourceLang?: string;
  /** Cache identities include the endpoint/model/revision or external connection session. */
  clefRevision?: string;
  plamoRevision?: string;
  /** Use 0 for a managed server; omit for the external scheduler. */
  plamoSlot?: number;
}>;
export type RelayOptions = RelayConfiguration &
  Readonly<{
    publish(this: void, comments: RelayComment[]): void;
    now(this: void): number;
    timers?: Timers;
    onStatus?(this: void, counters: RelayCounters): void;
  }>;
export type RelayInput = Readonly<{
  sessionId: string;
  batchId: string;
  site: 'youtube' | 'twitch';
  channel: string;
  comments: readonly RawChatComment[];
}>;
export type RelayIngestAck = Readonly<{ batchId: string; accepted: number; dropped: number }>;
export type RelayPipeline = {
  /** Acknowledges bounded admission, independently of later inference/publication. */
  ingest(this: void, input: RelayInput): Promise<Result<RelayIngestAck>>;
  status(this: void): RelayCounters;
  /** Starts a fresh generation; also serves as manual recovery after an unavailable model. */
  reset(this: void, configuration?: Partial<RelayConfiguration>): void;
  dispose(this: void): void;
};

type Entry = Readonly<{
  raw: RawChatComment;
  site: RelayInput['site'];
  channel: string;
  receivedAt: number;
  admission: object;
}>;
type Batch = Readonly<{
  generation: number;
  config: RelayConfiguration;
  controller: AbortController;
  deadlineAt: number;
}>;
type Translation = Pick<RelayComment, 'translation' | 'translationState' | 'translator'>;
const original = (translationState: Translation['translationState']): Translation => ({
  translation: null,
  translationState,
  translator: null,
});
const emptyCounters = (): RelayCounters => ({
  accepted: 0,
  dropped: 0,
  published: 0,
  filtered: 0,
  failed: 0,
});

/** Settles cancellation even if an adapter answers late; the adapter must abort its underlying I/O. */
function cancellable<T>(
  operation: () => Promise<Result<T>>,
  signal: AbortSignal,
): Promise<Result<T>> {
  if (signal.aborted) return Promise.resolve(Err(failure('operation_cancelled')));
  return new Promise((resolve) => {
    const finish = (result: Result<T>): void => {
      signal.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = (): void => finish(Err(failure('operation_cancelled')));
    signal.addEventListener('abort', abort, { once: true });
    launch(
      async () => {
        finish(await operation());
      },
      (error) => finish(Err(error)),
    );
  });
}

/** Portable, fail-closed relay; at most one batch of three and one active call per model. */
export function createRelayPipeline(options: RelayOptions): RelayPipeline {
  const { now, publish, onStatus, timers = systemTimers } = options;
  let config: RelayConfiguration = { ...options };
  let counters = emptyCounters();
  let generation = 0;
  let disposed = false;
  let sequence = 0;
  let waiting: Entry[] = [];
  let active: Batch | undefined;
  let waitingTimer: number | undefined;
  let deadlineTimer: number | undefined;
  let clefUntil = 0;
  let plamoUntil = 0;
  const dedupe = createLruCache<string, true>({ max: 2000 });
  const probabilities = createRelayMemo<number>(now);
  const translations = createRelayMemo<Translation>(now);
  const clefQueue = createQueue({ concurrency: 1, maxPending: 3 });
  const plamoQueue = createQueue({ concurrency: 1, maxPending: 3 });
  const current = (batch: Batch): boolean => !disposed && batch.generation === generation;
  const live = (batch: Batch): boolean =>
    current(batch) && !batch.controller.signal.aborted && now() < batch.deadlineAt;
  const count = (key: keyof RelayCounters, amount = 1): void => {
    if (!amount) return;
    counters = { ...counters, [key]: Math.min(Number.MAX_SAFE_INTEGER, counters[key] + amount) };
    onStatus?.({ ...counters });
  };
  const clearWaitingTimer = (): void => {
    if (waitingTimer !== undefined) timers.clear(waitingTimer);
    waitingTimer = undefined;
  };
  const discardWaiting = (): void => {
    const length = waiting.length;
    waiting = [];
    clearWaitingTimer();
    count('dropped', length);
  };
  const expireWaiting = (): void => {
    let expired = 0;
    while (waiting[0] && now() - waiting[0].receivedAt > 8000) {
      waiting.shift();
      expired += 1;
    }
    count('dropped', expired);
  };
  const armWaiting = (): void => {
    clearWaitingTimer();
    const oldest = waiting[0];
    if (!oldest) return;
    // No polling or idle window timer: availability flushes immediately (within the 500 ms window).
    waitingTimer = timers.set(
      () => {
        waitingTimer = undefined;
        expireWaiting();
        pump();
      },
      Math.max(1, oldest.receivedAt + 8001 - now()),
    );
  };
  const suppressClef = (batch: Batch, unavailable: boolean): void => {
    if (!current(batch)) return;
    clefUntil = unavailable ? Number.POSITIVE_INFINITY : now() + 30_000;
    discardWaiting();
  };
  function probability(entry: Entry, batch: Batch): Promise<Result<number>> {
    const key = JSON.stringify([
      batch.config.sessionId,
      batch.config.clefRevision ?? 'clef-flash',
      entry.raw.text,
    ]);
    return probabilities.run(key, () =>
      clefQueue.run(async (signal): Promise<Result<number>> => {
        if (clefUntil > now()) return Err(failure('operation_cancelled'));
        const judged =
          batch.config.judge.mode === 'clef'
            ? await cancellable(() => batch.config.judge.judge([entry.raw.text], signal), signal)
            : Err(failure('clef_unavailable'));
        if (!current(batch)) return Err(failure('operation_cancelled'));
        const value = judged.ok ? judged.value[0] : undefined;
        if (
          !judged.ok ||
          judged.value.length !== 1 ||
          value === undefined ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > 1
        ) {
          suppressClef(batch, !judged.ok && judged.error.internalCode === 'clef_unavailable');
          return judged.ok ? Err(failure('response_invalid')) : judged;
        }
        return Ok(value);
      }, batch.controller.signal),
    );
  }
  async function translation(entry: Entry, batch: Batch): Promise<Result<Translation>> {
    if (!batch.config.translate) return Ok(original('disabled'));
    const guess = scriptLanguageGuess(entry.raw.text);
    if (!needsTranslation(guess, 'ja')) return Ok(original('unnecessary'));
    const explicit = batch.config.sourceLang !== undefined && batch.config.sourceLang !== 'auto';
    const sourceLang = explicit
      ? (batch.config.sourceLang ?? 'auto')
      : guess.lang.startsWith('und') || guess.lang === 'zh'
        ? 'auto'
        : guess.lang;
    const language = plamoLanguage(sourceLang);
    if (
      language.kind === 'unsupported' ||
      (explicit && language.kind === 'omit' && sourceLang !== 'zh')
    )
      return Ok(original('unsupported'));
    if (plamoUntil > now()) return Err(failure('network_failed'));
    const request = plamoTranslateRequest({
      line: entry.raw.text,
      sourceLang,
      previous: [],
      glossary: [],
      slot: batch.config.plamoSlot,
    });
    if (!request.ok) return request;
    const key = JSON.stringify([
      batch.config.sessionId,
      entry.raw.text,
      sourceLang,
      batch.config.plamoRevision ?? PLAMO_TRANSLATE_MODEL,
    ]);
    const translated = await translations.run(key, () =>
      plamoQueue.run(async (signal): Promise<Result<Translation>> => {
        if (plamoUntil > now()) return Err(failure('operation_cancelled'));
        const result = await cancellable(
          () => batch.config.plamo.chat({ ...request.value, signal }),
          signal,
        );
        if (!current(batch)) return Err(failure('operation_cancelled'));
        const parsed = result.ok
          ? parsePlamoLine(result.value, request.value.maxTokens, entry.raw.text)
          : result;
        if (!parsed.ok || parsed.value.length > 2000) {
          plamoUntil = now() + 30_000;
          return parsed.ok ? Err(failure('response_invalid')) : parsed;
        }
        return Ok({
          translation: parsed.value,
          translationState: 'translated',
          translator: PLAMO_TRANSLATE_MODEL,
        });
      }, batch.controller.signal),
    );
    return translated;
  }
  async function process(entry: Entry, batch: Batch): Promise<Result<RelayComment | undefined>> {
    const judged = await probability(entry, batch);
    if (!live(batch)) return Err(failure('operation_cancelled'));
    if (!judged.ok) return judged;
    if (isAbusive(judged.value, batch.config.threshold)) {
      count('filtered');
      return Ok(undefined);
    }
    const translated = await translation(entry, batch);
    if (!live(batch)) return Err(failure('operation_cancelled'));
    if (!translated.ok) count('failed');
    return Ok({
      v: 1,
      sessionId: batch.config.sessionId,
      id: entry.raw.id,
      seq: 0,
      site: entry.site,
      channel: entry.channel,
      author: entry.raw.author,
      original: entry.raw.text,
      ...(translated.ok ? translated.value : original('failed')),
      at: entry.raw.at,
      receivedAt: entry.receivedAt,
      publishedAt: now(),
      filter: { verdict: 'allowed', probability: judged.value },
    });
  }
  async function run(entries: Entry[], batch: Batch): Promise<Result<void>> {
    const results = await Promise.all(entries.map((entry) => process(entry, batch)));
    if (!current(batch)) return Ok(undefined);
    const allowed: RelayComment[] = [];
    if (live(batch))
      for (const result of results) {
        if (!result.ok)
          count(result.error.internalCode === 'operation_cancelled' ? 'dropped' : 'failed');
        else if (result.value) allowed.push(result.value);
      }
    if (!live(batch)) count('dropped', entries.length);
    if (deadlineTimer !== undefined) timers.clear(deadlineTimer);
    deadlineTimer = undefined;
    // Publish only after every verdict/translation settles, preserving input order across batches.
    if (allowed.length) {
      const comments = allowed.map((comment) => ({
        ...comment,
        seq: ++sequence,
        publishedAt: now(),
      }));
      publish(comments);
      count('published', comments.length);
    }
    active = undefined;
    pump();
    return Ok(undefined);
  }
  function pump(): void {
    expireWaiting();
    if (!active && !disposed && waiting.length) {
      const entries = waiting.splice(0, 3);
      const batch: Batch = {
        generation,
        config,
        controller: new AbortController(),
        // A conservative batch deadline includes admission waiting for every member.
        deadlineAt: Math.min(...entries.map((entry) => entry.receivedAt)) + 30_000,
      };
      active = batch;
      clearWaitingTimer();
      deadlineTimer = timers.set(
        () => {
          batch.controller.abort();
        },
        Math.max(0, batch.deadlineAt - now()),
      );
      const recover = (): void => {
        if (!current(batch)) return;
        batch.controller.abort();
        if (deadlineTimer !== undefined) timers.clear(deadlineTimer);
        deadlineTimer = undefined;
        active = undefined;
        count('failed', entries.length);
        suppressClef(batch, false);
      };
      launch(async () => {
        const result = await run(entries, batch);
        if (!result.ok) recover();
      }, recover);
    }
    armWaiting();
  }
  function reset(next: Partial<RelayConfiguration> = {}): void {
    generation += 1;
    active?.controller.abort();
    active = undefined;
    clearWaitingTimer();
    if (deadlineTimer !== undefined) timers.clear(deadlineTimer);
    deadlineTimer = undefined;
    waiting = [];
    dedupe.clear();
    probabilities.clear();
    translations.clear();
    clefQueue.clear();
    plamoQueue.clear();
    clefUntil = 0;
    plamoUntil = 0;
    sequence = 0;
    config = { ...config, ...next };
    counters = emptyCounters();
    onStatus?.({ ...counters });
  }
  return {
    async ingest(input): Promise<Result<RelayIngestAck>> {
      if (!Number.isFinite(config.threshold) || config.threshold < 0 || config.threshold > 1)
        return Err(failure('input_invalid'));
      let accepted = 0;
      let dropped = 0;
      const admission = {};
      expireWaiting();
      for (const raw of input.comments) {
        const key = JSON.stringify([input.site, input.channel, raw.id]);
        if (
          disposed ||
          input.sessionId !== config.sessionId ||
          raw.text.trim() === '' ||
          !rawChatCommentSchema.safeParse(raw).success ||
          dedupe.get(key)
        ) {
          dropped += 1;
          count('dropped');
          continue;
        }
        dedupe.set(key, true);
        if (clefUntil > now()) {
          dropped += 1;
          count('dropped');
          continue;
        }
        waiting.push({
          raw: { ...raw },
          site: input.site,
          channel: input.channel,
          receivedAt: now(),
          admission,
        });
        accepted += 1;
        count('accepted');
        if (waiting.length > 64) {
          const removed = waiting.shift();
          if (removed?.admission === admission) {
            accepted -= 1;
            dropped += 1;
          }
          count('dropped');
        }
        if (!active && waiting.length >= 3) pump();
      }
      pump();
      return Ok({ batchId: input.batchId, accepted, dropped });
    },
    status: () => ({ ...counters }),
    reset(next) {
      if (!disposed) reset(next);
    },
    dispose() {
      if (!disposed) {
        reset();
        disposed = true;
      }
    },
  };
}
