import { z } from 'zod/mini';
import { capture, captureSync, Ok, type Result } from '@chrome-toolbox/contracts';
import { createLruCache, createQueue, type StorageArea } from '@chrome-toolbox/extension-core';
import { PAGE_LIMITS } from './limits.ts';

/** Characters kept of what a page names; defined in limits.ts for the MAIN-world bridge. */
export { PAGE_LIMITS };

/** A YouTube video id. */
const VIDEO_ID = /^[\w-]{11}$/u;

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
  videoId: z.string().check(z.regex(VIDEO_ID)),
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
export const TAB_PAGES_MAX = 16;

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

/** The video a YouTube watch or live URL shows; undefined for any other page or URL. */
export function videoOfUrl(url: string): string | undefined {
  const parsed = captureSync(() => new URL(url), 'input_invalid');
  if (!parsed.ok || parsed.value.origin !== 'https://www.youtube.com') return undefined;
  const { pathname, searchParams } = parsed.value;
  const id =
    pathname === '/watch' ? searchParams.get('v') : /^\/live\/([^/]+)/u.exec(pathname)?.[1];
  return id !== null && id !== undefined && VIDEO_ID.test(id) ? id : undefined;
}

/** The `storage.session` key of the tab pages: `{ tabId, info }`, the oldest first. */
const SESSION_KEY = 'subs:pages';
const sessionSchema = z.array(
  z.strictObject({ tabId: z.int().check(z.nonnegative()), info: pageInfoSchema }),
);
type Entry = { tabId: number; info: PageInfo };

export type TabPageStore = {
  /** Keeps what the tab shows, in memory and in the session. */
  report(this: void, tabId: number, info: PageInfo): Promise<Result<void>>;
  /** What the tab showed: from memory, or from the session when a restart emptied the memory. */
  get(this: void, tabId: number): Promise<Result<PageInfo | undefined>>;
  /** Forgets a tab that closed. */
  forget(this: void, tabId: number): Promise<Result<void>>;
  /** The tab shows `videoId`, or no video: its page is forgotten unless it is that video's. */
  shows(this: void, tabId: number, videoId: string | undefined): Promise<Result<void>>;
};

/**
 * The page info of the 16 tabs reported last, kept in memory and in `storage.session`, which
 * outlives a stopped service worker (and ends with the browser session). The session holds one
 * list, read and written whole, one operation at a time so that none undoes another; an
 * unreadable list counts as empty and the next report replaces it.
 */
export function tabPagesStore(area: StorageArea, max = TAB_PAGES_MAX): TabPageStore {
  const memory = createTabPages(max);
  const queue = createQueue({ concurrency: 1, maxPending: 64 });
  async function read(): Promise<Result<Entry[]>> {
    const stored = await capture(() => area.get(SESSION_KEY), 'storage_failed');
    if (!stored.ok) return stored;
    const parsed = sessionSchema.safeParse(stored.value[SESSION_KEY]);
    return Ok(parsed.success ? parsed.data.slice(-max) : []);
  }
  /** Writes `change` of the stored list, unless it gives undefined (nothing to change). */
  function update(change: (entries: Entry[]) => Entry[] | undefined): Promise<Result<void>> {
    return queue.run(async (): Promise<Result<void>> => {
      const entries = await read();
      if (!entries.ok) return entries;
      const next = change(entries.value);
      if (next === undefined) return Ok(undefined);
      return capture(() => area.set({ [SESSION_KEY]: next.slice(-max) }), 'storage_failed');
    });
  }
  const without = (entries: Entry[], tabId: number): Entry[] =>
    entries.filter((entry) => entry.tabId !== tabId);
  return {
    report(tabId, info) {
      memory.report(tabId, info);
      return update((entries) => [...without(entries, tabId), { tabId, info }]);
    },
    async get(tabId): Promise<Result<PageInfo | undefined>> {
      const known = memory.get(tabId);
      if (known !== undefined) return Ok(known);
      // Behind the writes queued before it, so a forgotten tab does not come back.
      return queue.run(async (): Promise<Result<PageInfo | undefined>> => {
        const entries = await read();
        if (!entries.ok) return entries;
        // A report that came while this waited is newer than the session.
        const newer = memory.get(tabId);
        if (newer !== undefined) return Ok(newer);
        const stored = entries.value.find((entry) => entry.tabId === tabId)?.info;
        if (stored !== undefined) memory.report(tabId, stored);
        return Ok(stored);
      });
    },
    forget(tabId) {
      memory.forget(tabId);
      return update((entries) =>
        entries.some((entry) => entry.tabId === tabId) ? without(entries, tabId) : undefined,
      );
    },
    shows(tabId, videoId) {
      if (memory.get(tabId)?.videoId !== videoId) memory.forget(tabId);
      return update((entries) =>
        entries.some((entry) => entry.tabId === tabId && entry.info.videoId !== videoId)
          ? without(entries, tabId)
          : undefined,
      );
    },
  };
}
