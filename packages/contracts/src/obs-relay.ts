import { z } from 'zod/mini';
import { rawChatCommentSchema } from './chat.ts';

/** Translation outcome; a missing translation never conceals why the original was retained. */
export const relayTranslationStateSchema = z.enum([
  'translated',
  'disabled',
  'unnecessary',
  'unsupported',
  'failed',
]);
const milliseconds = z.int().check(z.nonnegative());
const translationLength = z.superRefine<string>((text, context) => {
  if (text.length > 2000)
    context.addIssue({ code: 'too_big', origin: 'string', maximum: 2000, inclusive: true });
});

/** Only fully judged, allowed comments cross the publication port. Native assigns final seq/time. */
export const relayCommentSchema = z.strictObject({
  v: z.literal(1),
  sessionId: z.uuid(),
  id: rawChatCommentSchema.shape.id,
  seq: z.int().check(z.nonnegative()),
  site: z.enum(['youtube', 'twitch']),
  channel: z.string().check(z.minLength(1), z.maxLength(256)),
  author: rawChatCommentSchema.shape.author,
  original: rawChatCommentSchema.shape.text,
  translation: z.nullable(z.string().check(translationLength)),
  translationState: relayTranslationStateSchema,
  at: milliseconds,
  receivedAt: milliseconds,
  publishedAt: milliseconds,
  filter: z.strictObject({
    verdict: z.literal('allowed'),
    probability: z.number().check(z.gte(0), z.lte(1)),
  }),
  translator: z.nullable(z.literal('plamo-3-translate-2b')),
});
export type RelayComment = Readonly<z.infer<typeof relayCommentSchema>>;

/** Accepted counts admissions; dropped counts loss, filtered counts verdicts, failed counts model failures. */
export const relayCountersSchema = z.strictObject({
  accepted: z.int().check(z.nonnegative()),
  dropped: z.int().check(z.nonnegative()),
  published: z.int().check(z.nonnegative()),
  filtered: z.int().check(z.nonnegative()),
  failed: z.int().check(z.nonnegative()),
});
export type RelayCounters = Readonly<z.infer<typeof relayCountersSchema>>;
