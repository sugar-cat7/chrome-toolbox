import { z } from 'zod/mini';
import {
  defineProtocol,
  llmProtocolSpec,
  subtitleLimit,
  type ProtocolHandlers,
} from '@chrome-toolbox/extension-core';
import { SENTENCE_LIMITS } from './captions/sentences.ts';
import { CAPTION_LIMITS, LANGUAGE_CODE, VIDEO_ID } from './captions/tracks.ts';
import { FRONT_REASONS, FRONT_STATES } from './front.ts';
import { pageInfoSchema } from './page-context.ts';
import { DISPLAY_MODES } from './settings.ts';

/** Who a message is for: every receiver drops what is not for it before validating. */
export type Target = 'background' | 'offscreen' | 'panel' | 'content';
const TARGETS: readonly string[] = [
  'background',
  'offscreen',
  'panel',
  'content',
] satisfies Target[];

/**
 * One `subs/translate`: at most 4 sentences of at most 200 characters, after at most 3 previous
 * ones. A Japanese translation is bounded by twice the longest subtitle line (`subtitleLimit` of
 * 200 characters is 416 code points, at most 832 UTF-16 units).
 */
export const TRANSLATE_LIMITS = {
  sentences: 4,
  previous: 3,
  chars: SENTENCE_LIMITS.chars,
  id: 64,
  ja: 1_000,
} as const;

const source = z.string().check(z.minLength(1), z.maxLength(TRANSLATE_LIMITS.chars));
const sentenceId = z.string().check(z.minLength(1), z.maxLength(TRANSLATE_LIMITS.id));

export const translateRequestSchema = z.strictObject({
  videoId: z.string().check(z.regex(VIDEO_ID)),
  /** The caption track's language (BCP 47, as YouTube writes it). */
  sourceLang: z.string().check(z.maxLength(CAPTION_LIMITS.languageCode), z.regex(LANGUAGE_CODE)),
  /** The sources of the sentences just before the first one, oldest first. */
  previous: z.array(source).check(z.maxLength(TRANSLATE_LIMITS.previous)),
  sentences: z
    .array(z.strictObject({ id: sentenceId, source }))
    .check(z.minLength(1), z.maxLength(TRANSLATE_LIMITS.sentences)),
});
export type TranslateRequest = z.infer<typeof translateRequestSchema>;

export const translateResponseSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        id: sentenceId,
        ja: z.optional(z.string().check(z.maxLength(TRANSLATE_LIMITS.ja))),
        state: z.enum(['done', 'failed']),
      }),
    )
    .check(z.maxLength(TRANSLATE_LIMITS.sentences)),
});
export type TranslateResponse = z.infer<typeof translateResponseSchema>;

/** Code points, as `subtitleLimit` counts them. */
function codePoints(text: string): number {
  let count = 0;
  for (const _point of text) count += 1;
  return count;
}

/**
 * A line of the audio path as the overlay shows it: a sentence, again under the same id as it
 * grows and when its translation comes. `endedAt` is when the speech of its last segment ended
 * (`performance.timeOrigin + performance.now()`, ms); `final` once the sentence is closed. A
 * Japanese line carries its source as `ja`.
 */
export const liveLineSchema = z
  .strictObject({
    sentenceId,
    lang: z.string().check(z.maxLength(CAPTION_LIMITS.languageCode), z.regex(LANGUAGE_CODE)),
    source,
    ja: z.optional(z.string().check(z.maxLength(TRANSLATE_LIMITS.ja))),
    state: z.enum(['pending', 'done', 'skipped', 'failed']),
    endedAt: z.number().check(z.nonnegative()),
    final: z.boolean(),
  })
  .check(
    z.refine((line) => line.ja === undefined || codePoints(line.ja) <= subtitleLimit(line.source)),
  );
export type LiveLine = Readonly<z.infer<typeof liveLineSchema>>;

/** A `FrontState` as a watch page reports it (without a reason, the key is left out). */
export const frontStateSchema = z.strictObject({
  state: z.enum(FRONT_STATES),
  reason: z.exactOptional(z.enum(FRONT_REASONS)),
});

/** The messages the service worker answers; each task adds its own. */
export const subtitleProtocolSpec = {
  ...llmProtocolSpec,
  /**
   * From a watch page's top frame: translate caption sentences. The stream context and the
   * glossary come from what the same tab reported with `subs/page`.
   */
  'subs/translate': { request: translateRequestSchema, response: translateResponseSchema },
  /** From a watch page's top frame, on load and after each navigation: what the tab shows. */
  'subs/page': {
    request: z.strictObject({ info: pageInfoSchema }),
    response: z.strictObject({}),
  },
  /** From a watch page's top frame, at the start and on each change: whether it is in front. */
  'subs/front': { request: frontStateSchema, response: z.strictObject({}) },
  /** From a watch page's top frame (the player button): the display mode to save. */
  'subs/display': {
    request: z.strictObject({ mode: z.enum(DISPLAY_MODES) }),
    response: z.strictObject({}),
  },
};
export type SubtitleMessageType = keyof typeof subtitleProtocolSpec;
export type SubtitleProtocolHandlers = ProtocolHandlers<typeof subtitleProtocolSpec>;
export const subtitleProtocol = defineProtocol(subtitleProtocolSpec);

/** The message with its target added; anything that is not an object carries only the target. */
export function addressed(target: Target, message: unknown): { target: Target } {
  return typeof message === 'object' && message !== null ? { ...message, target } : { target };
}

/** Whether `message` names `target`; reads nothing else, so it runs before validation. */
export function isFor(target: Target, message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'target' in message &&
    message.target === target &&
    TARGETS.includes(target)
  );
}
