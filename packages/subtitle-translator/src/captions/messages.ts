import { z } from 'zod/mini';
import { CAPTION_LIMITS, LANGUAGE_CODE, VIDEO_ID } from './tracks.ts';

/**
 * Messages between the MAIN-world bridge (`st-bridge`) and the isolated content script
 * (`st-content`), sent with `window.postMessage(message, location.origin)`. Page scripts can post
 * the same shapes, so each side checks the window and origin and validates everything: at worst a
 * page shows wrong subtitles; it reaches no extension permission.
 */
export const BRIDGE_SOURCE = 'st-bridge';
export const CONTENT_SOURCE = 'st-content';

const bounded = (max: number) => z.string().check(z.maxLength(max));
const languageCode = z
  .string()
  .check(z.maxLength(CAPTION_LIMITS.languageCode), z.regex(LANGUAGE_CODE));
const videoId = z.string().check(z.regex(VIDEO_ID));
const kind = z.enum(['asr', 'manual']);

const trackSchema = z.strictObject({
  languageCode,
  kind,
  baseUrl: bounded(CAPTION_LIMITS.baseUrl),
  name: bounded(CAPTION_LIMITS.name),
  vssId: bounded(CAPTION_LIMITS.vssId),
});
const videoSchema = z.strictObject({
  videoId,
  channelId: z.optional(bounded(CAPTION_LIMITS.channelId)),
  author: z.optional(bounded(CAPTION_LIMITS.author)),
  title: z.optional(bounded(CAPTION_LIMITS.title)),
  live: z.boolean(),
});
const cueSchema = z
  .strictObject({
    startMs: z.number().check(z.minimum(0)),
    endMs: z.number(),
    text: z.string().check(z.minLength(1), z.maxLength(CAPTION_LIMITS.text)),
  })
  .check(z.refine((cue) => cue.endMs >= cue.startMs));

const bridgeMessageSchema = z.discriminatedUnion('type', [
  /** The video and its tracks: on load, after each `yt-navigate-finish` and on `ready`. */
  z.strictObject({
    source: z.literal(BRIDGE_SOURCE),
    type: z.literal('video'),
    video: videoSchema,
    tracks: z.array(trackSchema).check(z.maxLength(CAPTION_LIMITS.tracks)),
  }),
  /** The cues of a track the player fetched: once per video and track, again when asked. */
  z.strictObject({
    source: z.literal(BRIDGE_SOURCE),
    type: z.literal('cues'),
    videoId,
    languageCode,
    kind,
    cues: z.array(cueSchema).check(z.maxLength(CAPTION_LIMITS.cues)),
  }),
]);
export type BridgeMessage = z.infer<typeof bridgeMessageSchema>;
export type CuesMessage = Extract<BridgeMessage, { type: 'cues' }>;

const contentMessageSchema = z.discriminatedUnion('type', [
  /** The content script listens now: the bridge posts the video and the cues it holds again. */
  z.strictObject({ source: z.literal(CONTENT_SOURCE), type: z.literal('ready') }),
  /** Have the player fetch this track (the bridge re-posts the cues instead if it holds them). */
  z.strictObject({
    source: z.literal(CONTENT_SOURCE),
    type: z.literal('load-track'),
    languageCode,
  }),
]);
export type ContentMessage = z.infer<typeof contentMessageSchema>;

/** The parts of a `message` event the readers look at. */
export type MessageLike = Readonly<{ source: unknown; origin: string; data: unknown }>;
type Self = Readonly<{ location: Readonly<{ origin: string }> }>;

/** Whether `data` claims `source`, and no list in it is longer than a message may be. */
function claims(data: unknown, source: string): boolean {
  if (typeof data !== 'object' || data === null || !('source' in data) || data.source !== source)
    return false;
  // Checked before validation, so a page cannot make the reader walk a huge list.
  const cues = 'cues' in data ? data.cues : undefined;
  const tracks = 'tracks' in data ? data.tracks : undefined;
  return (
    !(Array.isArray(cues) && cues.length > CAPTION_LIMITS.cues) &&
    !(Array.isArray(tracks) && tracks.length > CAPTION_LIMITS.tracks)
  );
}

/** A message posted on this window and origin by `source` that passes `schema`. */
function read<T>(
  event: MessageLike,
  self: Self,
  source: string,
  schema: z.ZodMiniType<T>,
): T | undefined {
  if (event.source !== self || event.origin !== self.location.origin) return undefined;
  if (!claims(event.data, source)) return undefined;
  const parsed = schema.safeParse(event.data);
  return parsed.success ? parsed.data : undefined;
}

/** For the isolated content script: a valid bridge message, or undefined to drop it. */
export const readBridgeMessage = (event: MessageLike, self: Self): BridgeMessage | undefined =>
  read(event, self, BRIDGE_SOURCE, bridgeMessageSchema);

/** For the bridge: a valid content-script message, or undefined to drop it. */
export const readContentMessage = (event: MessageLike, self: Self): ContentMessage | undefined =>
  read(event, self, CONTENT_SOURCE, contentMessageSchema);

/** Posts `message` to this window's own origin only. */
export function postToPage(
  self: Self & { postMessage(message: unknown, targetOrigin: string): void },
  message: BridgeMessage | ContentMessage,
): void {
  self.postMessage(message, self.location.origin);
}
