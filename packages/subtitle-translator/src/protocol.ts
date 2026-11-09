import { z } from 'zod/mini';
import type { InternalErrorCode } from '@chrome-toolbox/contracts';
import {
  defineProtocol,
  llmProtocolSpec,
  settingsSchema,
  subtitleLimit,
  type ProtocolHandlers,
} from '@chrome-toolbox/extension-core';
import { SENTENCE_LIMITS } from './captions/sentences.ts';
import { CAPTION_LIMITS, LANGUAGE_CODE, VIDEO_ID } from './captions/tracks.ts';
import { FRONT_REASONS, FRONT_STATES } from './front.ts';
import { GLOSSARY_LIMITS, glossaryEntrySchema } from './glossary.ts';
import { PAGE_LIMITS } from './limits.ts';
import type { FallbackReason } from './line-translator.ts';
import { pageInfoSchema } from './page-context.ts';
import { DISPLAY_MODES, SOURCE_LANGUAGE_CODES, SUBTITLE_TRANSLATORS } from './settings.ts';

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

const tabIdSchema = z.int().check(z.nonnegative());
const count = z.int().check(z.nonnegative());
const empty = z.strictObject({});

/** Lines in one `audio/lines` or `subs/lines` (the pipeline emits one at a time). */
export const LIVE_LINES_MAX = 8;
const liveLinesSchema = z.array(liveLineSchema).check(z.minLength(1), z.maxLength(LIVE_LINES_MAX));

/** What the pill shows of the audio path; the watch page adds the source and the display. */
export const AUDIO_STATES = ['active', 'pause', 'away', 'stopped', 'error'] as const;
export const audioStatusSchema = z.strictObject({
  state: z.enum(AUDIO_STATES),
  message: z.exactOptional(z.string().check(z.maxLength(100))),
});
export type AudioStatus = Readonly<z.infer<typeof audioStatusSchema>>;

/** Failures after which the capture cannot go on: the server lost its audio projector. */
export const AUDIO_FAILURES = ['audio_unsupported'] as const satisfies readonly InternalErrorCode[];
export type AudioFailure = (typeof AUDIO_FAILURES)[number];

/** A context is the title and channel lines of `contextText`. */
const LIVE_CONTEXT_CHARS =
  'Title: '.length + PAGE_LIMITS.title + '\nChannel: '.length + PAGE_LIMITS.author;
/** A `LiveConfig` (Task 12) as it travels to the offscreen document. */
export const liveConfigSchema = z.strictObject({
  display: z.enum(DISPLAY_MODES),
  sourceLang: z.union([z.literal('auto'), z.enum(SOURCE_LANGUAGE_CODES)]),
  context: z.string().check(z.maxLength(LIVE_CONTEXT_CHARS)),
  glossary: z.array(glossaryEntrySchema).check(z.maxLength(GLOSSARY_LIMITS.entries)),
  translator: z.enum(SUBTITLE_TRANSLATORS),
});
/** A `LiveConfig` as a message carries it. */
export type LiveConfigMessage = z.infer<typeof liveConfigSchema>;
/** The server and models the offscreen document's clients use. */
export const audioSettingsSchema = z.strictObject({
  baseUrl: z.string().check(z.maxLength(2_048)),
  models: settingsSchema.shape.models,
});
export type AudioSettings = z.infer<typeof audioSettingsSchema>;

/** `LiveStats` (Task 12). */
export const liveStatsSchema = z.strictObject({
  segments: count,
  silent: count,
  dropped: count,
  expired: count,
  skipped: count,
  failed: count,
  lang: z.exactOptional(z.string().check(z.maxLength(CAPTION_LIMITS.languageCode))),
  sourceP50Ms: z.exactOptional(z.number()),
  jaP50Ms: z.exactOptional(z.number()),
  jaP95Ms: z.exactOptional(z.number()),
});
const FALLBACK_REASONS = [
  'not_listed',
  'refused',
  'language',
] as const satisfies readonly FallbackReason[];
/** `TranslatorStatus` (Task 8). */
export const translatorStatusSchema = z.strictObject({
  chosen: z.enum(SUBTITLE_TRANSLATORS),
  fallback: z.exactOptional(
    z.strictObject({
      latest: z.enum(FALLBACK_REASONS),
      lines: z.strictObject({ not_listed: count, refused: count, language: count }),
    }),
  ),
});
/** What the offscreen document captures: the tab, since when, its front, the pipeline's stats. */
export const sessionStateSchema = z.strictObject({
  tabId: tabIdSchema,
  startedAt: z.number(),
  front: frontStateSchema,
  stats: liveStatsSchema,
  translator: translatorStatusSchema,
});
export type SessionState = Readonly<z.infer<typeof sessionStateSchema>>;

/**
 * The messages the offscreen document answers, sent by the service worker (target `offscreen`).
 * `audio/start` uses the stream id at once; the capture follows `audio/front` (away until the first).
 */
export const offscreenProtocolSpec = {
  'audio/start': {
    request: z.strictObject({
      tabId: tabIdSchema,
      streamId: z.string().check(z.minLength(1), z.maxLength(256)),
      settings: audioSettingsSchema,
      config: liveConfigSchema,
    }),
    response: empty,
  },
  'audio/config': { request: z.strictObject({ config: liveConfigSchema }), response: empty },
  'audio/front': { request: z.strictObject({ front: frontStateSchema }), response: empty },
  /** A YouTube SPA navigation: the pipeline and the VAD start over. */
  'audio/reset': { request: empty, response: empty },
  'audio/stop': { request: empty, response: empty },
  'audio/state': { request: empty, response: sessionStateSchema },
};
export type OffscreenProtocolHandlers = ProtocolHandlers<typeof offscreenProtocolSpec>;
export const offscreenProtocol = defineProtocol(offscreenProtocolSpec);

/**
 * The messages a watch page's top frame answers, sent by the service worker with
 * `tabs.sendMessage` (target `content`): the lines and the status of its tab's captured audio.
 */
export const contentProtocolSpec = {
  'subs/lines': { request: z.strictObject({ lines: liveLinesSchema }), response: empty },
  'subs/status': { request: z.strictObject({ status: audioStatusSchema }), response: empty },
};
export type ContentProtocolHandlers = ProtocolHandlers<typeof contentProtocolSpec>;
export const contentProtocol = defineProtocol(contentProtocolSpec);

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
  /** From the offscreen document: lines of the captured tab, for its top frame. */
  'audio/lines': {
    request: z.strictObject({ tabId: tabIdSchema, lines: liveLinesSchema }),
    response: empty,
  },
  /** From the offscreen document: the capture's state, for the pill of the captured tab. */
  'audio/status': {
    request: z.strictObject({ tabId: tabIdSchema, status: audioStatusSchema }),
    response: empty,
  },
  /** From the offscreen document: nothing processed for 10 minutes. */
  'audio/idle': { request: z.strictObject({ tabId: tabIdSchema }), response: empty },
  /** From the offscreen document: the capture cannot go on. */
  'audio/failed': {
    request: z.strictObject({ tabId: tabIdSchema, code: z.enum(AUDIO_FAILURES) }),
    response: empty,
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
