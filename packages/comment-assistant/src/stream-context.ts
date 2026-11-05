import { createLruCache } from '@chrome-toolbox/extension-core';
import type { Site } from './sites/types.ts';

/** Streams the service worker remembers, the most recent first. */
export const MAX_STREAMS = 16;
/** Characters of a streamer key read from a page (a YouTube handle or channel id, a login). */
export const MAX_STREAMER = 128;
/** Characters of a stream title read from a page; it goes into every batch prompt. */
export const MAX_TITLE = 200;
/**
 * A YouTube video's comments are their own store partition, `<videoId>#comments`, in the
 * stream `<videoId>` of its chat (and chat replay).
 */
export const COMMENTS_SUFFIX = '#comments';

/** What a page shows about its stream; either may be missing. */
export type StreamInfo = Readonly<{ streamer?: string | undefined; title?: string | undefined }>;
/**
 * One stream: its site, its partition (`<videoId>` on YouTube, the channel login on Twitch),
 * the streamer and title a page reported, and the stream's spoiler note from the side panel.
 */
export type StreamContext = Readonly<{
  site: Site;
  partition: string;
  streamer?: string | undefined;
  title?: string | undefined;
  spoilerNote?: string | undefined;
}>;

/** The stream a store partition belongs to: the part before `#` (`<videoId>#comments` → `<videoId>`). */
export const streamOf = (partition: string): string => partition.split('#', 1)[0] ?? partition;
/** The partitions of one stream: on YouTube its chat and its video comments. */
export const partitionsOf = (context: Pick<StreamContext, 'site' | 'partition'>): string[] => {
  const stream = streamOf(context.partition);
  return context.site === 'youtube' ? [stream, `${stream}${COMMENTS_SUFFIX}`] : [stream];
};
/**
 * The key a stream's filters and feedback (allowlist, corrections, threshold) are kept under:
 * its streamer, so they follow the streamer from stream to stream, or while the streamer is
 * unknown (a popout without its watch page), the stream itself.
 */
export const ownerOf = (context: Pick<StreamContext, 'partition' | 'streamer'>): string =>
  context.streamer ?? streamOf(context.partition);

/**
 * The stream context as batch prompts carry it (in the per-channel user turn, never in the
 * fixed system turn): the title for names and the viewer's spoiler targets. Empty when neither
 * is known.
 */
export function contextText(context: StreamContext): string {
  return [
    ...(context.title === undefined ? [] : [`Title: ${context.title}`]),
    ...(context.spoilerNote === undefined ? [] : [`Spoiler targets: ${context.spoilerNote}`]),
  ].join('\n');
}

/** A short key for a context text (32-bit FNV-1a, 8 hex digits); the text cache keys by it. */
export function contextHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export type StreamContexts = {
  /**
   * Merges what a page reported about the stream of `partition` (a missing field keeps what is
   * known) and returns the stream's context and whether it changed.
   */
  report(
    this: void,
    site: Site,
    partition: string,
    info: StreamInfo,
  ): { context: StreamContext; changed: boolean };
  /**
   * The context of the stream `partition` belongs to, with the stream's spoiler note when one is
   * known. An unknown stream gets one with neither streamer nor title, which is not kept.
   */
  get(this: void, site: Site, partition: string): StreamContext;
  /** Whether the saved spoiler notes were given (`setNotes`) since the start or `clear`. */
  notesKnown(this: void): boolean;
  /** Every stream's spoiler note, keyed `<site>:<stream>` (as `spoilerNotesOf` reads them). */
  setNotes(this: void, notes: ReadonlyMap<string, string>): void;
  clear(this: void): void;
};

type Known = { streamer?: string; title?: string };

/**
 * The streams pages reported (the newest `MAX_STREAMS`) and the viewer's spoiler notes, which
 * belong to one stream each (R30). The live chat frame knows only its video; the watch page,
 * in the same or another tab, names the streamer and title of that video here.
 */
export function createStreamContexts(): StreamContexts {
  const streams = createLruCache<string, Known>({ max: MAX_STREAMS });
  let notes: ReadonlyMap<string, string> | undefined;
  const keyOf = (site: Site, name: string): string => `${site}:${name}`;
  function contextOf(site: Site, stream: string, known: Known | undefined): StreamContext {
    const base: StreamContext = { site, partition: stream, ...known };
    const note = notes?.get(keyOf(site, stream));
    return note ? { ...base, spoilerNote: note } : base;
  }
  return {
    report(site, partition, info) {
      const stream = streamOf(partition);
      const key = keyOf(site, stream);
      const before = streams.get(key);
      const after: Known = {
        ...before,
        ...(info.streamer === undefined ? {} : { streamer: info.streamer }),
        ...(info.title === undefined ? {} : { title: info.title }),
      };
      streams.set(key, after);
      const changed =
        before === undefined || before.streamer !== after.streamer || before.title !== after.title;
      return { context: contextOf(site, stream, after), changed };
    },
    get(site, partition) {
      const stream = streamOf(partition);
      return contextOf(site, stream, streams.get(keyOf(site, stream)));
    },
    notesKnown: () => notes !== undefined,
    setNotes(next) {
      notes = next;
    },
    clear() {
      streams.clear();
      notes = undefined;
    },
  };
}
