import { z } from 'zod/mini';
import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import { PAGE_LIMITS } from '../limits.ts';

/**
 * Bounds on what the player gives the bridge and what one bridge message may carry. The video's
 * names are cut like the page context cuts them.
 */
export const CAPTION_LIMITS = {
  tracks: 200,
  cues: 20_000,
  text: 500,
  name: 100,
  vssId: 64,
  baseUrl: 4096,
  languageCode: 35,
  title: PAGE_LIMITS.title,
  author: PAGE_LIMITS.author,
  channelId: PAGE_LIMITS.streamer,
} as const;

/** A BCP 47 tag as YouTube writes caption languages (`en`, `es-419`, `zh-Hans`). */
export const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z\d]{1,8})*$/iu;
export const VIDEO_ID = /^[\w-]{11}$/u;

export type CaptionTrack = Readonly<{
  languageCode: string;
  kind: 'asr' | 'manual';
  baseUrl: string;
  name: string;
  vssId: string;
}>;
export type Cue = Readonly<{ startMs: number; endMs: number; text: string }>;
export type VideoInfo = Readonly<{
  videoId: string;
  channelId?: string;
  author?: string;
  title?: string;
  live: boolean;
}>;

/** At most `max` UTF-16 units, without leaving the first half of a surrogate pair at the end. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const last = head.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

const languageCodeSchema = z
  .string()
  .check(z.maxLength(CAPTION_LIMITS.languageCode), z.regex(LANGUAGE_CODE));
/** YouTube's text: `{ simpleText }`, or `{ runs: [{ text }] }` in older responses. */
const textSchema = z.union([
  z.object({ simpleText: z.string() }),
  z.object({ runs: z.array(z.object({ text: z.string() })) }),
]);
const rawTrackSchema = z.object({
  baseUrl: z.string().check(z.minLength(1), z.maxLength(CAPTION_LIMITS.baseUrl)),
  languageCode: languageCodeSchema,
  kind: z.optional(z.string()),
  name: z.optional(textSchema),
  vssId: z.optional(z.string()),
});
const tracklistSchema = z.object({
  videoDetails: z.object({}),
  captions: z.optional(
    z.object({
      playerCaptionsTracklistRenderer: z.optional(
        z.object({
          captionTracks: z.optional(
            z.array(rawTrackSchema).check(z.maxLength(CAPTION_LIMITS.tracks)),
          ),
        }),
      ),
    }),
  ),
});

const textOf = (text: z.infer<typeof textSchema> | undefined): string =>
  text === undefined
    ? ''
    : 'simpleText' in text
      ? text.simpleText
      : text.runs.map((run) => run.text).join('');

/** `kind` is absent (or empty) on a manual track and `asr` on an auto-generated one. */
const kindOf = (kind: string | undefined): CaptionTrack['kind'] | undefined =>
  kind === 'asr' ? 'asr' : kind === undefined || kind === '' ? 'manual' : undefined;

/**
 * The caption tracks of a player response (`captions.playerCaptionsTracklistRenderer
 * .captionTracks`, at most 200). A response without `captions`, such as a live stream's, has none;
 * one without `videoDetails` or with a malformed track is `input_invalid`. A track of another kind
 * than manual or `asr` is left out.
 */
export function listTracks(playerResponse: unknown): Result<CaptionTrack[]> {
  const parsed = tracklistSchema.safeParse(playerResponse);
  if (!parsed.success) return Err(failure('input_invalid'));
  const raw = parsed.data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return Ok(
    raw.flatMap((track) => {
      const kind = kindOf(track.kind);
      return kind === undefined
        ? []
        : [
            {
              languageCode: track.languageCode,
              kind,
              baseUrl: track.baseUrl,
              name: cutText(textOf(track.name), CAPTION_LIMITS.name),
              vssId: cutText(track.vssId ?? '', CAPTION_LIMITS.vssId),
            },
          ];
    }),
  );
}

const videoSchema = z.object({
  videoDetails: z.object({
    videoId: z.string().check(z.regex(VIDEO_ID)),
    channelId: z.optional(z.string()),
    author: z.optional(z.string()),
    title: z.optional(z.string()),
    isLive: z.optional(z.boolean()),
  }),
});

/** The value cut to `max`, or undefined for an absent or empty one. */
const kept = (value: string | undefined, max: number): string | undefined =>
  value === undefined || value === '' ? undefined : cutText(value, max);

/** The video of a player response, from `videoDetails`; `live` only when `isLive` is true. */
export function readVideo(playerResponse: unknown): Result<VideoInfo> {
  const parsed = videoSchema.safeParse(playerResponse);
  if (!parsed.success) return Err(failure('input_invalid'));
  const details = parsed.data.videoDetails;
  const channelId = kept(details.channelId, CAPTION_LIMITS.channelId);
  const author = kept(details.author, CAPTION_LIMITS.author);
  const title = kept(details.title, CAPTION_LIMITS.title);
  return Ok({
    videoId: details.videoId,
    ...(channelId === undefined ? {} : { channelId }),
    ...(author === undefined ? {} : { author }),
    ...(title === undefined ? {} : { title }),
    live: details.isLive === true,
  });
}

const primary = (languageCode: string): string =>
  (languageCode.split('-')[0] ?? languageCode).toLowerCase();

/** Whether a caption language is Japanese (`ja`, `ja-JP`): such a track is shown as it is. */
export const isJapanese = (languageCode: string): boolean => primary(languageCode) === 'ja';

/**
 * The track to translate. The spoken language is the auto-generated track's, because YouTube
 * generates captions in the language it hears. In order: a manual track in that language (the
 * same code first, then the same primary subtag, so `es-419` serves `es`), the auto-generated
 * track, then, when no track is auto-generated, a Japanese manual track or the first manual one.
 * Translated tracks (`tlang`) are never offered by the player response, so they are never picked.
 */
export function pickSourceTrack(tracks: readonly CaptionTrack[]): CaptionTrack | undefined {
  const manual = tracks.filter((track) => track.kind === 'manual');
  const spoken = tracks.find((track) => track.kind === 'asr');
  if (spoken !== undefined)
    return (
      manual.find((track) => track.languageCode === spoken.languageCode) ??
      manual.find((track) => primary(track.languageCode) === primary(spoken.languageCode)) ??
      spoken
    );
  return manual.find((track) => primary(track.languageCode) === 'ja') ?? manual[0];
}

const json3Schema = z.object({ events: z.array(z.unknown()) });

/** A finite, non-negative number of milliseconds. */
const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * One event's cue, or undefined for an event without text or a malformed one. Plain guards
 * instead of a schema: a long track has some 40,000 events, and this runs on the watch page.
 */
function cueOf(event: unknown): Cue | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  if (!('segs' in event) || !Array.isArray(event.segs)) return undefined;
  if (!('tStartMs' in event) || !isTime(event.tStartMs)) return undefined;
  const duration = 'dDurationMs' in event ? event.dDurationMs : 0;
  if (!isTime(duration)) return undefined;
  let joined = '';
  for (const seg of event.segs) {
    if (typeof seg === 'object' && seg !== null && 'utf8' in seg && typeof seg.utf8 === 'string')
      joined += seg.utf8;
  }
  const text = cutText(joined.replace(/\s*\n\s*/gu, ' ').trim(), CAPTION_LIMITS.text).trimEnd();
  return text === ''
    ? undefined
    : { startMs: event.tStartMs, endMs: event.tStartMs + duration, text };
}

/**
 * Cues of a json3 timedtext body: each event's `segs[].utf8` joined, with line breaks inside a cue
 * turned into spaces and the ends trimmed. Events without text (window definitions, appended `\n`,
 * blanks) and malformed events are skipped. At most 20,000 cues of at most 500 characters.
 */
export function parseJson3(body: unknown): Result<Cue[]> {
  const parsed = json3Schema.safeParse(body);
  if (!parsed.success) return Err(failure('input_invalid'));
  const cues: Cue[] = [];
  for (const event of parsed.data.events) {
    if (cues.length >= CAPTION_LIMITS.cues) break;
    const cue = cueOf(event);
    if (cue) cues.push(cue);
  }
  return Ok(cues);
}
