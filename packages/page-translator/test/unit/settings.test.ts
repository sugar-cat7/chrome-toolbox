import { afterEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
import {
  defaultPageSettings,
  PAGE_SETTINGS_LIMITS,
  pageSettingsSchema,
  pageSettingsStore,
  type PageSettings,
} from '../../src/settings.ts';

afterEach(() => fakeBrowser.reset());

const site = (n: number): string => `https://site${n}.fixture.test/*`;
const host = (n: number): string => `site${n}.fixture.test`;

describe('page settings', () => {
  it('loads page settings with defaults and rejects an unknown translator', async () => {
    const store = pageSettingsStore(fakeBrowser.storage.local);
    expect(await store.load()).toEqual(
      Ok({ v: 1, mode: 'replace', translator: 'gemma', always: [], never: [] }),
    );
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
      v: 1,
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
    { name: 'another version', extra: { v: 2 } },
    { name: 'an unknown mode', extra: { mode: 'side' } },
  ])('refuses $name', async ({ extra }) => {
    const store = pageSettingsStore(fakeBrowser.storage.local);
    expect(await store.save({ ...defaultPageSettings, ...extra } as never)).toMatchObject({
      ok: false,
      error: { internalCode: 'input_invalid' },
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
