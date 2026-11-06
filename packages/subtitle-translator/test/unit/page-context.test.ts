import { afterEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { decode, Ok } from '@chrome-toolbox/contracts';
import {
  contextHash,
  contextText,
  createTabPages,
  PAGE_LIMITS,
  pageInfoSchema,
  tabPagesStore,
  type PageInfo,
} from '../../src/page-context.ts';

const info = (over: Partial<PageInfo> = {}): PageInfo => ({
  videoId: 'abcdefghijk',
  live: false,
  tracks: 0,
  ...over,
});

describe('page context', () => {
  it.each([
    {
      info: { title: 'Fixture Quest day 3', author: 'Fixture Ch' },
      text: 'Title: Fixture Quest day 3\nChannel: Fixture Ch',
    },
    { info: { title: 'Fixture Quest day 3' }, text: 'Title: Fixture Quest day 3' },
    { info: {}, text: '' },
  ])('contextText $text', ({ info: given, text }) => {
    expect(contextText(info(given))).toBe(text);
  });

  it('hashes with 32-bit FNV-1a in 8 hex digits', () => {
    expect(contextHash('')).toBe('811c9dc5');
    expect(contextHash('a')).toBe('e40c292c');
  });

  it('validates the page info and cuts long values', () => {
    const long = decode(
      pageInfoSchema,
      info({ title: 't'.repeat(300), author: 'a'.repeat(300), streamer: 's'.repeat(300) }),
    );
    expect(long).toMatchObject({ ok: true });
    if (!long.ok) return;
    expect(long.value.title).toHaveLength(PAGE_LIMITS.title);
    expect(long.value.author).toHaveLength(PAGE_LIMITS.author);
    expect(long.value.streamer).toHaveLength(PAGE_LIMITS.streamer);
  });

  it.each([
    { name: 'short video id', value: { ...info(), videoId: 'abc' } },
    { name: 'too many tracks', value: { ...info(), tracks: 201 } },
    { name: 'extra key', value: { ...info(), extra: 1 } },
  ])('rejects $name', ({ value }) => {
    expect(decode(pageInfoSchema, value).ok).toBe(false);
  });

  it('keeps page info for the 16 most recent tabs and reports changes', () => {
    const pages = createTabPages();
    expect(pages.report(0, info())).toEqual({ changed: true });
    expect(pages.report(0, info())).toEqual({ changed: false });
    expect(pages.report(0, info({ live: true }))).toEqual({ changed: true });
    for (let tab = 1; tab <= 16; tab += 1) pages.report(tab, info());
    expect(pages.get(0)).toBeUndefined();
    expect(pages.get(16)).toEqual(info());
    pages.forget(16);
    expect(pages.get(16)).toBeUndefined();
  });
});

describe('tab pages kept in storage.session', () => {
  afterEach(() => {
    fakeBrowser.reset();
  });
  const session = () => fakeBrowser.storage.session;
  const shown = info({ streamer: 'UC-fixture', title: 'Fixture Quest day 3' });

  it('reads a tab page back in a new store, as a restarted service worker does', async () => {
    const pages = tabPagesStore(session());
    expect(await pages.report(3, info({ title: 'Fixture Quest day 2' }))).toEqual(Ok(undefined));
    // The tab's next report replaces the first.
    expect(await pages.report(3, shown)).toEqual(Ok(undefined));
    const restarted = tabPagesStore(session());
    expect(await restarted.get(3)).toEqual(Ok(shown));
    expect(await restarted.get(4)).toEqual(Ok(undefined));
  });

  it('keeps the 16 tabs reported last in the session', async () => {
    const pages = tabPagesStore(session());
    const titled = (tab: number) => info({ title: `Fixture ${tab}` });
    for (let tab = 0; tab < 16; tab += 1) await pages.report(tab, titled(tab));
    // Reported again, tab 0 is the newest: tab 1 is the oldest when tab 16 comes.
    await pages.report(0, titled(0));
    await pages.report(16, titled(16));
    // The session holds one list under `subs:pages`.
    const { 'subs:pages': list } = await session().get('subs:pages');
    expect(list).toHaveLength(16);
    const restarted = tabPagesStore(session());
    expect(await restarted.get(1)).toEqual(Ok(undefined));
    for (const tab of [0, 2, 15, 16]) expect(await restarted.get(tab)).toEqual(Ok(titled(tab)));
  });

  it('forgets a closed tab', async () => {
    const pages = tabPagesStore(session());
    for (const tab of [1, 2]) await pages.report(tab, shown);
    expect(await pages.forget(1)).toEqual(Ok(undefined));
    for (const store of [pages, tabPagesStore(session())]) {
      expect(await store.get(1)).toEqual(Ok(undefined));
      expect(await store.get(2)).toEqual(Ok(shown));
    }
  });

  it('reads an unreadable session value as no pages and replaces it on the next report', async () => {
    await session().set({ 'subs:pages': [{ tabId: 'x' }] });
    const pages = tabPagesStore(session());
    expect(await pages.get(1)).toEqual(Ok(undefined));
    expect(await pages.report(1, shown)).toEqual(Ok(undefined));
    expect(await tabPagesStore(session()).get(1)).toEqual(Ok(shown));
  });

  it('returns storage_failed when the session cannot be read, and still answers from memory', async () => {
    const pages = tabPagesStore({
      get: () => Promise.reject(new Error('gone')),
      set: async () => undefined,
    });
    const failed = { ok: false, error: { internalCode: 'storage_failed' } };
    expect(await pages.get(1)).toMatchObject(failed);
    expect(await pages.report(1, shown)).toMatchObject(failed);
    expect(await pages.get(1)).toEqual(Ok(shown));
  });
});
