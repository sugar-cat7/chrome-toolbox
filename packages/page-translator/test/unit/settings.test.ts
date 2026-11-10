import { afterEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
import {
  defaultPageSettings,
  excludedBy,
  isAlways,
  isNever,
  normalizeHost,
  PAGE_SETTINGS_LIMITS,
  pageSettingsSchema,
  pageSettingsStore,
  siteOf,
  type PageSettings,
} from '../../src/settings.ts';

afterEach(() => fakeBrowser.reset());

const site = (n: number): string => `https://site${n}.fixture.test/*`;
const host = (n: number): string => `site${n}.fixture.test`;

describe('page settings', () => {
  it('loads page settings with defaults and rejects an unknown translator', async () => {
    const store = pageSettingsStore(fakeBrowser.storage.local);
    expect(await store.load()).toEqual(Ok(defaultPageSettings));
    expect(defaultPageSettings).toEqual({
      v: 2,
      mode: 'replace',
      translator: 'plamo',
      always: [],
      never: [],
    });
    const other = await store.save({ ...defaultPageSettings, translator: 'other' } as never);
    expect(other).toMatchObject({ ok: false, error: { internalCode: 'input_invalid' } });
    // Nothing was written.
    expect(await fakeBrowser.storage.local.get('page')).toEqual({});
    // A stored record with an unknown translator does not load either.
    await fakeBrowser.storage.local.set({ page: { ...defaultPageSettings, translator: 'other' } });
    expect(await store.load()).toMatchObject({ ok: false });
  });

  it('round-trips saved settings under the page key, apart from the shared settings', async () => {
    const store = pageSettingsStore(fakeBrowser.storage.local);
    const next: PageSettings = {
      v: 2,
      mode: 'pair',
      translator: 'plamo',
      always: ['https://wiki.fixture.test/*'],
      never: ['bank.fixture.test'],
    };
    expect(await store.save(next)).toEqual(Ok(next));
    expect(await fakeBrowser.storage.local.get(null)).toEqual({ page: next });
    expect(await pageSettingsStore(fakeBrowser.storage.local).load()).toEqual(Ok(next));
  });

  it.each([
    { name: 'a PLaMo model name (P5)', extra: { plamoModel: 'plamo-3-translate-2b' } },
    { name: 'another version', extra: { v: 3 } },
    { name: 'an unknown mode', extra: { mode: 'side' } },
  ])('refuses $name', async ({ extra }) => {
    const store = pageSettingsStore(fakeBrowser.storage.local);
    expect(await store.save({ ...defaultPageSettings, ...extra } as never)).toMatchObject({
      ok: false,
      error: { internalCode: 'input_invalid' },
    });
  });

  it.each([
    // Version 1 shipped while Gemma was the default: a stored `gemma` is that default, not a
    // choice, so it reads PLaMo. A stored `plamo` stays PLaMo.
    { name: 'Gemma', translator: 'gemma' },
    { name: 'PLaMo', translator: 'plamo' },
  ] as const)('reads a version 1 record’s $name translator as PLaMo', async ({ translator }) => {
    const store = pageSettingsStore(fakeBrowser.storage.local);
    await fakeBrowser.storage.local.set({
      page: {
        v: 1,
        mode: 'pair',
        translator,
        always: [site(0)],
        never: [host(0)],
      },
    });
    expect(await store.load()).toEqual(
      Ok({ v: 2, mode: 'pair', translator: 'plamo', always: [site(0)], never: [host(0)] }),
    );
  });

  it('keeps the translator a version 2 record chose: Gemma picked after migrating stays', async () => {
    const store = pageSettingsStore(fakeBrowser.storage.local);
    await fakeBrowser.storage.local.set({
      page: { v: 2, mode: 'replace', translator: 'gemma', always: [], never: [] },
    });
    const kept: PageSettings = {
      v: 2,
      mode: 'replace',
      translator: 'gemma',
      always: [],
      never: [],
    };
    expect(await store.load()).toEqual(Ok(kept));
    // Saved again, it is still version 2 with Gemma.
    expect(await store.save(kept)).toEqual(Ok(kept));
    expect(await fakeBrowser.storage.local.get('page')).toEqual({ page: kept });
  });

  it('writes version 2: a migrated record saved again keeps PLaMo and gains the version', async () => {
    const store = pageSettingsStore(fakeBrowser.storage.local);
    await fakeBrowser.storage.local.set({
      page: { v: 1, mode: 'replace', translator: 'gemma', always: [], never: [] },
    });
    const loaded = await store.load();
    expect(loaded).toEqual(
      Ok({ v: 2, mode: 'replace', translator: 'plamo', always: [], never: [] }),
    );
    if (!loaded.ok) return;
    const saved = { ...loaded.value, mode: 'pair' as const };
    expect(await store.save(saved)).toEqual(Ok(saved));
    expect(await fakeBrowser.storage.local.get('page')).toEqual({ page: saved });
    // A version 1 record passed to save is written migrated too.
    expect(
      await store.save({ v: 1, mode: 'replace', translator: 'gemma', always: [], never: [] }),
    ).toEqual(Ok({ v: 2, mode: 'replace', translator: 'plamo', always: [], never: [] }));
    expect(await fakeBrowser.storage.local.get('page')).toEqual({
      page: { v: 2, mode: 'replace', translator: 'plamo', always: [], never: [] },
    });
  });

  it('bounds the always and never lists', () => {
    const { always, never } = PAGE_SETTINGS_LIMITS;
    expect({ always, never }).toEqual({ always: 200, never: 500 });
    const list = (count: number, of: (n: number) => string): string[] =>
      Array.from({ length: count }, (_, n) => of(n));
    const parse = (settings: Partial<PageSettings>): boolean =>
      pageSettingsSchema.safeParse({ ...defaultPageSettings, ...settings }).success;
    expect(parse({ always: list(always, site), never: list(never, host) })).toBe(true);
    expect(parse({ always: list(always + 1, site) })).toBe(false);
    expect(parse({ never: list(never + 1, host) })).toBe(false);
    // A pattern holds a host name of at most 253 characters; anything longer is no site.
    expect(parse({ always: [`https://${'a'.repeat(254)}/*`] })).toBe(false);
    expect(parse({ never: ['a'.repeat(254)] })).toBe(false);
  });
});

describe('sites', () => {
  /** A refused result with internal code `code`. */
  const refused = (code: string) => ({ ok: false, error: { internalCode: code } });
  it.each([
    {
      url: 'https://wiki.fixture.test/a?b#c',
      site: Ok({ host: 'wiki.fixture.test', pattern: 'https://wiki.fixture.test/*' }),
    },
    {
      url: 'http://192.168.1.10:8080/',
      site: Ok({ host: '192.168.1.10', pattern: 'http://192.168.1.10/*' }),
    },
    // The host is lower case, as Chrome matches it; the user name and password are no part of it.
    {
      url: 'https://reader:secret@Wiki.Fixture.TEST/A',
      site: Ok({ host: 'wiki.fixture.test', pattern: 'https://wiki.fixture.test/*' }),
    },
    // A pattern is a site of its own (the popup sends the pattern it got from siteOf).
    {
      url: 'https://wiki.fixture.test/*',
      site: Ok({ host: 'wiki.fixture.test', pattern: 'https://wiki.fixture.test/*' }),
    },
    { url: 'chrome://settings', site: refused('page_restricted') },
    { url: 'file:///tmp/a.html', site: refused('page_restricted') },
    { url: 'chrome-extension://test-extension-id/popup.html', site: refused('page_restricted') },
    { url: 'not a url', site: refused('page_restricted') },
  ])('siteOf($url)', ({ url, site }) => {
    expect(siteOf(url)).toMatchObject(site);
  });

  it.each([
    { host: 'bank.example.com', never: ['example.com'], excluded: true },
    { host: 'www.bank.example.com', never: ['bank.example.com'], excluded: true },
    { host: 'notbank.example.com', never: ['bank.example.com'], excluded: false },
    { host: 'bank.example.com', never: ['bank.example.com'], excluded: true },
    { host: 'example.com', never: ['bank.example.com'], excluded: false },
    { host: 'bank.example.com', never: [], excluded: false },
    // A fully qualified name (a trailing dot) is the same host.
    { host: 'bank.example.com.', never: ['bank.example.com'], excluded: true },
  ])('isNever($host, $never)', ({ host, never, excluded }) => {
    expect(isNever(host, never)).toBe(excluded);
  });

  it.each([
    { host: 'a.fixture.test', never: [], entry: undefined },
    { host: 'a.fixture.test', never: ['bank.example'], entry: undefined },
    { host: 'a.fixture.test', never: ['bank.example', 'a.fixture.test'], entry: 'a.fixture.test' },
    { host: 'a.fixture.test.', never: ['a.fixture.test'], entry: 'a.fixture.test' },
    { host: 'a.fixture.test', never: ['fixture.test'], entry: 'fixture.test' },
    // Taking the host's own entry off would leave the parent's in force: the parent's is named.
    { host: 'a.fixture.test', never: ['a.fixture.test', 'fixture.test'], entry: 'fixture.test' },
    { host: 'b.a.fixture.test', never: ['test', 'a.fixture.test'], entry: 'test' },
    // A name that only ends with the entry's letters is another site.
    { host: 'afixture.test', never: ['fixture.test'], entry: undefined },
  ])('excludedBy($host, $never) is $entry', ({ host, never, entry }) => {
    expect(excludedBy(host, never)).toBe(entry);
  });

  it.each([
    { url: 'https://wiki.fixture.test/a', always: ['https://wiki.fixture.test/*'], on: true },
    // A pattern names one scheme and one host: no other scheme, no subdomain.
    { url: 'http://wiki.fixture.test/a', always: ['https://wiki.fixture.test/*'], on: false },
    { url: 'https://www.wiki.fixture.test/', always: ['https://wiki.fixture.test/*'], on: false },
    { url: 'chrome://settings', always: ['https://wiki.fixture.test/*'], on: false },
    { url: 'https://wiki.fixture.test/a', always: [], on: false },
  ])('isAlways($url, $always)', ({ url, always, on }) => {
    expect(isAlways(url, always)).toBe(on);
  });

  it.each([
    { input: 'bank.fixture.test', host: Ok('bank.fixture.test') },
    { input: '  Bank.Fixture.TEST  ', host: Ok('bank.fixture.test') },
    { input: 'https://bank.fixture.test/', host: Ok('bank.fixture.test') },
    { input: 'http://bank.fixture.test', host: Ok('bank.fixture.test') },
    { input: 'https://bank.fixture.test/login?next=1#top', host: Ok('bank.fixture.test') },
    { input: 'bank.fixture.test:8443', host: Ok('bank.fixture.test') },
    { input: 'bank.fixture.test.', host: Ok('bank.fixture.test') },
    { input: '192.168.1.10', host: Ok('192.168.1.10') },
    { input: '', host: refused('input_invalid') },
    { input: '   ', host: refused('input_invalid') },
    { input: 'https://bad host/', host: refused('input_invalid') },
    { input: '*.fixture.test', host: refused('input_invalid') },
    { input: 'ftp://bank.fixture.test/', host: refused('input_invalid') },
    { input: 'bank..fixture.test', host: refused('input_invalid') },
    { input: `${'a'.repeat(250)}.test`, host: refused('input_invalid') },
  ])('normalizeHost($input)', ({ input, host }) => {
    expect(normalizeHost(input)).toMatchObject(host);
  });
});
