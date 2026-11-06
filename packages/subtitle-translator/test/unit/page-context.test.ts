import { describe, expect, it } from 'vitest';
import { decode } from '@chrome-toolbox/contracts';
import {
  contextHash,
  contextText,
  createTabPages,
  PAGE_LIMITS,
  pageInfoSchema,
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
