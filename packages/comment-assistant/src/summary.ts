import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  cutByMaxTokens,
  parseSummary,
  summaryLimits,
  summaryLine,
  summaryPrompt,
  type CommentRecord,
  type LlamaClient,
  type SummaryInput,
  type SummaryReply,
  type SummaryText,
} from '@chrome-toolbox/extension-core';
import { normalizeComment } from './fastpath.ts';
import { HIDDEN_CATEGORIES } from './feedback.ts';
import type { Summary, SummaryWindow } from './protocol.ts';

const MINUTE = 60_000;
/**
 * Bounds of a summary (R32). The input lines total at most 2,400 characters: with the system
 * turn and 256 reply tokens that fits one llama-server slot of 4,096 tokens (`--parallel 3`,
 * ctx 12,288, R39). Up to 40 questions always fit, since a line is at most 60 characters.
 */
export const summaryBounds = {
  inputChars: 2400,
  questions: 40,
  perPeak: 8,
  peaks: 3,
  important: 5,
} as const;

/** The model a summary asks: the client and the model name a llama.cpp router needs. */
export type SummaryModel = Readonly<{ client: LlamaClient; model: string }>;
/**
 * Runs `fn` on a free comment slot of llama-server (`CommentPipeline.exclusive`), with a signal
 * that aborts when the pipeline goes away.
 */
export type SlotRunner = <T>(
  fn: (slot: number, signal: AbortSignal) => Promise<Result<T>>,
) => Promise<Result<T>>;

const minuteOf = (at: number): number => Math.floor(at / MINUTE) * MINUTE;
const inWindow = (
  records: readonly CommentRecord[],
  now: number,
  windowMinutes: number,
): CommentRecord[] => records.filter((record) => record.at >= now - windowMinutes * MINUTE);
/**
 * The text a summary reads: the translation, or the comment as written (Japanese, untranslated,
 * or stored while its chat was not in front).
 */
const textOf = (record: CommentRecord): string => record.translation ?? record.text;
/** Emoji and marks alone say nothing a summary could use. */
const hasText = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);
/**
 * A comment the chat shows: answered (not pending or failed) and not abusive, spam, spoiler or a
 * genre category (`HIDDEN_CATEGORIES`, R62), or stored while its chat was not in front (R44),
 * which has no category and reads as chat.
 */
const usable = (record: CommentRecord): boolean =>
  (record.state === 'done' || record.state === 'skipped' || record.state === 'stored') &&
  (record.category === undefined || !HIDDEN_CATEGORIES.has(record.category)) &&
  hasText(textOf(record));

/** The text a record is grouped by (`normalizeComment` of `textOf`). */
type KeyOf = (record: CommentRecord) => string;
/** `normalizeComment` of each record's text, worked out once per record for one request. */
function keysOf(): KeyOf {
  const keys = new Map<CommentRecord, string>();
  return (record) => {
    let key = keys.get(record);
    if (key === undefined) {
      key = normalizeComment(textOf(record));
      keys.set(record, key);
    }
    return key;
  };
}

/** Comments of one normalized text: the newest one's text, how many, and when the newest came. */
type Group = { key: string; text: string; count: number; newest: number; order: number };
/** Groups by `normalizeComment` of the text, the most written first, then the newest. */
function groups(records: readonly CommentRecord[], keyOf: KeyOf): Group[] {
  const byKey = new Map<string, Group>();
  records.forEach((record, order) => {
    const text = textOf(record);
    const key = keyOf(record);
    const known = byKey.get(key);
    if (known === undefined) {
      byKey.set(key, { key, text, count: 1, newest: record.at, order });
      return;
    }
    known.count += 1;
    if (record.at >= known.newest) Object.assign(known, { text, newest: record.at, order });
  });
  return [...byKey.values()].sort(
    (a, b) => b.count - a.count || b.newest - a.newest || b.order - a.order,
  );
}
const asText = ({ text, count }: Group): SummaryText => ({ text, count });
const lineLength = (label: string, item: SummaryText): number =>
  Array.from(summaryLine(label, item)).length;
/** The shortest line there can be: a two-character label and a one-character text (`C1 "a"`). */
const SHORTEST_LINE = lineLength('C1', { text: 'a', count: 1 });
/** Abusive comments and spam (a raid, copypasta) say nothing about how lively the chat is. */
const lively = (record: CommentRecord): boolean =>
  record.category !== 'abusive' && record.category !== 'spam';

/**
 * The three busiest minutes of the window by comment count (every stored comment but abusive
 * ones and spam), in time order; `minute` is the minute's start. A tie goes to the newer minute.
 */
export function peaksOf(
  records: readonly CommentRecord[],
  now: number,
  windowMinutes: number,
): { minute: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const record of inWindow(records, now, windowMinutes)) {
    if (!lively(record)) continue;
    const minute = minuteOf(record.at);
    counts.set(minute, (counts.get(minute) ?? 0) + 1);
  }
  return [...counts]
    .sort(([minuteA, countA], [minuteB, countB]) => countB - countA || minuteB - minuteA)
    .slice(0, summaryBounds.peaks)
    .map(([minute, count]) => ({ minute, count }))
    .sort((a, b) => a.minute - b.minute);
}

/** The input lines for `peaks` of the window's `records` (see `summaryInput`). */
function inputOf(
  records: readonly CommentRecord[],
  peaks: readonly { minute: number }[],
  windowMinutes: number,
  keyOf: KeyOf,
): SummaryInput {
  const chat = records.filter(usable);
  const questions = groups(
    chat.filter((record) => record.category === 'question'),
    keyOf,
  )
    .slice(0, summaryBounds.questions)
    .map(asText);
  let used = questions.reduce((sum, question, i) => sum + lineLength(`Q${i + 1}`, question), 0);
  /** No line fits any more: the rest is not looked at. */
  const full = (): boolean => summaryBounds.inputChars - used < SHORTEST_LINE;
  /** Adds the line when it fits the budget; a longer one is skipped so a shorter one may fit. */
  const fits = (label: string, item: SummaryText): boolean => {
    const length = lineLength(label, item);
    if (used + length > summaryBounds.inputChars) return false;
    used += length;
    return true;
  };
  const rest = chat.filter((record) => record.category !== 'question');
  const listed = new Set<string>();
  const bursts = peaks.map((peak, k) => {
    const texts: SummaryText[] = [];
    const minute = rest.filter((record) => minuteOf(record.at) === peak.minute);
    for (const group of groups(minute, keyOf).slice(0, summaryBounds.perPeak)) {
      if (full()) break;
      if (!fits(`P${k + 1}`, asText(group))) continue;
      texts.push(asText(group));
      listed.add(group.key);
    }
    return texts;
  });
  const others: SummaryText[] = [];
  for (const group of groups(rest, keyOf)) {
    if (full()) break;
    if (listed.has(group.key) || !fits(`C${others.length + 1}`, asText(group))) continue;
    others.push(asText(group));
  }
  return { windowMinutes, questions, peaks: bursts, others };
}

/**
 * The lines a summary gives the model, from the window's comments that the chat shows (not
 * abusive, spam, spoiler or a genre category) and that were answered (done or skipped) or only stored (R44), as the
 * viewer reads them (the translation; Japanese and stored comments as written, stored ones as
 * chat). The same text (`normalizeComment`) is one
 * line with its count. First the questions (the 40 most asked), then up to 8 texts of each busy
 * minute (`peaksOf`), then the rest, the most written first and on a tie the newest; the lines
 * total at most 2,400 characters, and a text already under a burst is not repeated.
 */
export function summaryInput(
  records: readonly CommentRecord[],
  now: number,
  windowMinutes: number,
): SummaryInput {
  const recent = inWindow(records, now, windowMinutes);
  return inputOf(recent, peaksOf(recent, now, windowMinutes), windowMinutes, keysOf());
}

/** Languages of the comments, the most used first (then by code); `und` (no text) is left out. */
function languagesOf(records: readonly CommentRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const { lang } of records) if (lang !== 'und') counts.set(lang, (counts.get(lang) ?? 0) + 1);
  return [...counts]
    .sort(([langA, countA], [langB, countB]) => countB - countA || langA.localeCompare(langB))
    .map(([lang]) => lang);
}

/** The newest important comments the chat shows, each text once. */
function importantOf(records: readonly CommentRecord[], keyOf: KeyOf): Summary['important'] {
  const seen = new Set<string>();
  const important: { author: string; text: string; at: number }[] = [];
  const newestFirst = records
    .map((record, order) => ({ record, order }))
    .filter(({ record }) => record.category === 'important' && usable(record))
    .sort((a, b) => b.record.at - a.record.at || b.order - a.order);
  for (const { record } of newestFirst) {
    const key = keyOf(record);
    if (seen.has(key)) continue;
    seen.add(key);
    important.push({ author: record.author, text: textOf(record), at: record.at });
    if (important.length === summaryBounds.important) break;
  }
  return important;
}

/** Asks the model on `slot`; a reply without one usable line is `response_invalid`. */
async function ask(
  { client, model }: SummaryModel,
  input: SummaryInput,
  slot: number,
  signal: AbortSignal,
): Promise<Result<SummaryReply>> {
  const replied = await client.chat({
    ...summaryPrompt(input),
    model,
    slot,
    temperature: 0,
    templateKwargs: { enable_thinking: false },
    maxTokens: summaryLimits.maxTokens,
    signal,
  });
  if (!replied.ok) return replied;
  const reply = parseSummary(replied.value.text, input, {
    cut: cutByMaxTokens(replied.value, summaryLimits.maxTokens),
  });
  const said = reply.topics.length + reply.questions.length + reply.peaks.filter(Boolean).length;
  return said === 0 ? Err(failure('response_invalid')) : Ok(reply);
}

/** The counted summary with the model's topics, merged questions and burst headings. */
function withReply(counted: Summary, input: SummaryInput, reply: SummaryReply): Summary {
  const named = new Set(reply.questions.flatMap((question) => question.ids));
  // Questions the model left out keep their own line, so it cannot drop a frequent one; lines
  // that read the same are one question.
  const counts = new Map<string, number>();
  for (const { text, count } of [
    ...reply.questions,
    ...input.questions.filter((_question, i) => !named.has(i + 1)),
  ])
    counts.set(text, (counts.get(text) ?? 0) + count);
  const questions = [...counts]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, summaryLimits.questions);
  return {
    ...counted,
    topics: [...reply.topics],
    questions,
    peaks: counted.peaks.map((peak, k) => {
      const label = reply.peaks[k];
      return label === undefined ? peak : { ...peak, label };
    }),
  };
}

/** What a summary counts and the lines it would give the model. */
type Parts = Readonly<{ counted: Summary; input: SummaryInput }>;
function partsOf(
  records: readonly CommentRecord[],
  now: number,
  windowMinutes: SummaryWindow,
): Parts {
  const start = now - windowMinutes * MINUTE;
  const recent = inWindow(records, now, windowMinutes);
  const peaks = peaksOf(recent, now, windowMinutes);
  const keyOf = keysOf();
  const input = inputOf(recent, peaks, windowMinutes, keyOf);
  const counted: Summary = {
    windowMinutes,
    total: recent.length,
    languages: languagesOf(recent),
    from: recent.reduce((oldest, record) => Math.min(oldest, record.at), recent[0]?.at ?? start),
    generatedAt: now,
    topics: [],
    questions: input.questions.slice(0, summaryLimits.questions).map(({ text, count }) => ({
      text,
      count,
    })),
    peaks,
    important: importantOf(recent, keyOf),
    unprocessed: recent.filter((record) => record.state === 'stored').length,
  };
  return { counted, input };
}
const hasLines = (input: SummaryInput): boolean =>
  input.questions.length + input.others.length + input.peaks.flat().length > 0;

/**
 * Summarizes the last `windowMinutes` of the comments `read` gives. The counted parts come from
 * the stored comments: how many (`total`) in which languages, `from` (the oldest), the busiest
 * minutes, the newest important comments and how many were only stored while their chat was not
 * in front (`unprocessed`, R44: counted, but neither translated nor classified). The model, asked once through `run` on a comment
 * slot, adds topics, merges similar questions and heads each busy minute. The comments are read
 * again (at `now()`) when the slot is given, which may be seconds after the request, so the
 * summary covers what arrived meanwhile.
 *
 * When there is nothing to summarize the model is not asked. When the model fails or answers
 * nothing usable, the summary has the counted parts, the questions unmerged and `modelFailed`.
 * When `run` gives the slot up before the model is asked (an aborted signal: a newer request
 * took its place, or the pipeline went away), the counted parts come back without it.
 */
export async function summarize(
  model: SummaryModel,
  read: () => readonly CommentRecord[],
  windowMinutes: SummaryWindow,
  now: () => number,
  run: SlotRunner,
): Promise<Result<Summary>> {
  const records = read();
  const asked = now();
  // The parts are worked out once per request (R45): here when the model has nothing to read
  // (the lines come only from comments the chat shows), else once the slot is given.
  if (!inWindow(records, asked, windowMinutes).some(usable))
    return Ok(partsOf(records, asked, windowMinutes).counted);
  const latest: { parts?: Parts } = {};
  const reply = await run(async (slot, signal): Promise<Result<SummaryReply | undefined>> => {
    if (signal.aborted) return Err(failure('operation_cancelled'));
    const parts = partsOf(read(), now(), windowMinutes);
    latest.parts = parts;
    return hasLines(parts.input) ? ask(model, parts.input, slot, signal) : Ok(undefined);
  });
  // Given up before the comments were read again: the comments of the request, at the request's
  // time, but as they are after the wait (the store updates a record in place when the pipeline
  // answers it meanwhile).
  const used = latest.parts ?? partsOf(records, asked, windowMinutes);
  if (reply.ok)
    return Ok(
      reply.value === undefined ? used.counted : withReply(used.counted, used.input, reply.value),
    );
  if (reply.error.internalCode === 'operation_cancelled') return Ok(used.counted);
  return Ok({ ...used.counted, modelFailed: true });
}
