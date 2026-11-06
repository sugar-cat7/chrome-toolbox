import { contextHash } from '../page-context.ts';
import { cutText, type Cue } from './tracks.ts';

/**
 * Where cues join into one sentence: a gap of 700 ms ends it, and so does reaching 6,000 ms or
 * 200 characters (a `subs/translate` sentence carries at most 200).
 */
export const SENTENCE_LIMITS = { gapMs: 700, spanMs: 6_000, chars: 200 } as const;

/** What is translated and shown as one line; `id` is `${startMs}:${contextHash(source)}`. */
export type Sentence = Readonly<{ id: string; startMs: number; endMs: number; source: string }>;

type Span = { startMs: number; endMs: number; text: string };

/** A sentence-ending mark, then any closing quotes or brackets. */
const SENTENCE_END = /[.?!。？！][”’"')\]」』]*$/u;

/**
 * A trimmed text cut into pieces of at most 200 UTF-16 units: at the last space that fits, or at
 * 200 when there is none (never between the halves of a surrogate pair).
 */
function pieces(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > SENTENCE_LIMITS.chars) {
    const head = cutText(rest, SENTENCE_LIMITS.chars);
    const space = head.lastIndexOf(' ');
    const cut = space > 0 ? space : head.length;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  out.push(rest);
  return out;
}

/**
 * A cue as spans of at most 200 characters, its time shared among them by length; none for a cue
 * of only spaces (a page can post one).
 */
function spansOf(cue: Cue): Span[] {
  const trimmed = cue.text.trim();
  if (trimmed === '') return [];
  const texts = pieces(trimmed);
  const total = texts.reduce((sum, text) => sum + text.length, 0);
  const duration = cue.endMs - cue.startMs;
  let done = 0;
  return texts.map((text) => {
    const startMs = cue.startMs + Math.round((duration * done) / total);
    done += text.length;
    const endMs = cue.startMs + Math.round((duration * done) / total);
    return { startMs, endMs, text };
  });
}

/**
 * The sentences of a track's cues, in time order. Cues join with a space; a sentence ends after a
 * cue that ends with `.?!。？！` (closing quotes or brackets may follow), before a cue that starts
 * 700 ms or more after it ends, once it spans 6,000 ms, and before a cue that would take it past
 * 200 characters (so a sentence that reaches 200 ends there). Each cue is trimmed first, and one
 * longer than 200 characters is cut into pieces, at spaces where it can be.
 */
export function toSentences(cues: readonly Cue[]): Sentence[] {
  const sentences: Sentence[] = [];
  let current: Span | undefined;
  const close = (): void => {
    if (current === undefined) return;
    const { startMs, endMs, text } = current;
    sentences.push({ id: `${startMs}:${contextHash(text)}`, startMs, endMs, source: text });
    current = undefined;
  };
  const ordered = [...cues].sort((a, b) => a.startMs - b.startMs);
  for (const span of ordered.flatMap(spansOf)) {
    if (
      current !== undefined &&
      (span.startMs - current.endMs >= SENTENCE_LIMITS.gapMs ||
        current.text.length + 1 + span.text.length > SENTENCE_LIMITS.chars)
    )
      close();
    current =
      current === undefined
        ? { ...span }
        : {
            startMs: current.startMs,
            endMs: Math.max(current.endMs, span.endMs),
            text: `${current.text} ${span.text}`,
          };
    if (
      SENTENCE_END.test(current.text) ||
      current.endMs - current.startMs >= SENTENCE_LIMITS.spanMs
    )
      close();
  }
  close();
  return sentences;
}
