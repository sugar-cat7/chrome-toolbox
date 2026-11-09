import { z } from 'zod/mini';
import { createLruCache, type StorageArea } from '@chrome-toolbox/extension-core';
import { PAGE_LIMITS } from './limits.ts';
import { TAB_STATE_MAX, tabSessionStore, type TabSessionStore } from './tab-session.ts';

/** Characters kept of what a page names; defined in limits.ts for the MAIN-world bridge. */
export { PAGE_LIMITS };

/** A too-long value is cut, not refused. */
const cut = (max: number) =>
  z.pipe(
    z.string(),
    z.transform((text) => text.slice(0, max)),
  );

/**
 * What the watch page shows about its video. `streamer` is the glossary's key: the player
 * response's `videoDetails.channelId`.
 */
export const pageInfoSchema = z.strictObject({
  videoId: z.string().check(z.regex(/^[\w-]{11}$/u)),
  streamer: z.optional(cut(PAGE_LIMITS.streamer)),
  title: z.optional(cut(PAGE_LIMITS.title)),
  author: z.optional(cut(PAGE_LIMITS.author)),
  live: z.boolean(),
  tracks: z.int().check(z.minimum(0), z.maximum(200)),
});
export type PageInfo = z.infer<typeof pageInfoSchema>;

/** The lines of a video's context that prompts carry; a missing part is left out. */
export function contextText({ title, author }: Pick<PageInfo, 'title' | 'author'>): string {
  return [
    ...(title === undefined ? [] : [`Title: ${title}`]),
    ...(author === undefined ? [] : [`Channel: ${author}`]),
  ].join('\n');
}

/** A short key for a context text (32-bit FNV-1a, 8 hex digits). */
export function contextHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export type TabPages = {
  report(this: void, tabId: number, info: PageInfo): { changed: boolean };
  get(this: void, tabId: number): PageInfo | undefined;
  forget(this: void, tabId: number): void;
};

const same = (a: PageInfo, b: PageInfo): boolean =>
  a.videoId === b.videoId &&
  a.streamer === b.streamer &&
  a.title === b.title &&
  a.author === b.author &&
  a.live === b.live &&
  a.tracks === b.tracks;

/** Tabs whose page info the service worker keeps. */
export const TAB_PAGES_MAX = TAB_STATE_MAX;

/** The page info of the most recent tabs. */
export function createTabPages(max = TAB_PAGES_MAX): TabPages {
  const pages = createLruCache<number, PageInfo>({ max });
  return {
    report(tabId, info) {
      const before = pages.get(tabId);
      pages.set(tabId, info);
      return { changed: before === undefined || !same(before, info) };
    },
    get: (tabId) => pages.get(tabId),
    forget: (tabId) => pages.delete(tabId),
  };
}

/** The `storage.session` key of the tab pages. */
const SESSION_KEY = 'subs:pages';

export type TabPageStore = TabSessionStore<PageInfo>;

/**
 * The page info of the 16 tabs reported last, kept in memory and in `storage.session`
 * (`tabSessionStore`), so that the batches after a service worker restart still have their
 * context and glossary.
 */
export function tabPagesStore(area: StorageArea, max = TAB_PAGES_MAX): TabPageStore {
  return tabSessionStore({ area, key: SESSION_KEY, schema: pageInfoSchema, max });
}
