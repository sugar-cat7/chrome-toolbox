import { afterEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
import {
  DISPLAY_MODES,
  defaultSubtitleSettings,
  nextDisplay,
  POSITION_LIMITS,
  SOURCE_LANGUAGES,
  SOURCE_LANGUAGE_CODES,
  SUBTITLE_TRANSLATORS,
  parseSubtitleSettings,
  subtitleSettingsStore,
  TRANSLATOR_LABELS,
  watchSubtitleSettings,
} from '../../src/settings.ts';

afterEach(() => fakeBrowser.reset());

describe('subtitle settings', () => {
  it.each([
    { from: 'ja', to: 'both' },
    { from: 'both', to: 'source' },
    { from: 'source', to: 'off' },
    { from: 'off', to: 'ja' },
  ] as const)('nextDisplay($from)', ({ from, to }) => {
    expect(nextDisplay(from)).toBe(to);
  });

  it('lists the modes, languages and translators', () => {
    expect(DISPLAY_MODES).toEqual(['ja', 'both', 'source', 'off']);
    expect(SOURCE_LANGUAGE_CODES).toEqual(Object.keys(SOURCE_LANGUAGES));
    expect(SOURCE_LANGUAGE_CODES).toHaveLength(12);
    expect(SUBTITLE_TRANSLATORS).toEqual(['gemma', 'plamo']);
    expect(Object.keys(TRANSLATOR_LABELS)).toEqual(['gemma', 'plamo']);
  });

  it('loads the defaults and round-trips saved subtitle settings', async () => {
    const store = subtitleSettingsStore(fakeBrowser.storage.local);
    expect(await store.load()).toEqual(
      Ok({
        display: 'both',
        source: 'auto',
        sourceLang: 'auto',
        translator: 'plamo',
        position: 0,
      }),
    );
    const next = {
      ...defaultSubtitleSettings,
      sourceLang: 'ko',
      translator: 'gemma',
      position: -12.5,
    } as const;
    expect(await store.save(next)).toEqual(Ok(next));
    expect(await subtitleSettingsStore(fakeBrowser.storage.local).load()).toEqual(Ok(next));
  });

  it('reads settings saved before position existed with the default offset', async () => {
    const legacy = {
      display: 'ja',
      source: 'audio',
      sourceLang: 'ko',
      translator: 'plamo',
    } as const;
    const store = subtitleSettingsStore(fakeBrowser.storage.local);
    await fakeBrowser.storage.local.set({ subtitles: legacy });
    expect(await store.load()).toEqual(Ok({ ...legacy, position: 0 }));
    // The watcher migrates them the same way, not to the defaults.
    const seen: unknown[] = [];
    const unwatch = watchSubtitleSettings(fakeBrowser.storage.local, (settings) => {
      seen.push(settings);
    });
    await fakeBrowser.storage.local.set({ subtitles: { ...legacy, display: 'off' } });
    unwatch();
    expect(seen).toEqual([{ ...legacy, display: 'off', position: 0 }]);
  });

  it('reads a legacy gemma translator as plamo, but keeps a current one', async () => {
    const store = subtitleSettingsStore(fakeBrowser.storage.local);
    // Saved while Gemma was the default and before `position` existed: 'gemma' was the
    // default, not a choice, so the record reads as the current default 'plamo'.
    await fakeBrowser.storage.local.set({
      subtitles: {
        display: 'ja',
        source: 'auto',
        sourceLang: 'auto',
        translator: 'gemma',
      },
    });
    expect(await store.load()).toEqual(Ok({ ...defaultSubtitleSettings, display: 'ja' }));
    // A legacy record that already says 'plamo' stays 'plamo'.
    await fakeBrowser.storage.local.set({
      subtitles: {
        display: 'both',
        source: 'auto',
        sourceLang: 'en',
        translator: 'plamo',
      },
    });
    expect(await store.load()).toEqual(
      Ok({
        display: 'both',
        source: 'auto',
        sourceLang: 'en',
        translator: 'plamo',
        position: 0,
      }),
    );
    // A current record (with `position`) keeps an explicit 'gemma' choice.
    await fakeBrowser.storage.local.set({
      subtitles: { ...defaultSubtitleSettings, translator: 'gemma' },
    });
    expect(await store.load()).toEqual(Ok({ ...defaultSubtitleSettings, translator: 'gemma' }));
  });

  it.each([
    { position: POSITION_LIMITS.min, ok: true },
    { position: 0, ok: true },
    { position: POSITION_LIMITS.max, ok: true },
    { position: 12.5, ok: true },
    { position: POSITION_LIMITS.min - 1, ok: false },
    { position: POSITION_LIMITS.max + 1, ok: false },
    { position: 'up', ok: false },
  ])('position $position is accepted: $ok', ({ position, ok }) => {
    const value: unknown = { ...defaultSubtitleSettings, position };
    expect(parseSubtitleSettings(value).ok).toBe(ok);
  });

  it('follows the saved settings, with the defaults for a removed or unreadable value', async () => {
    const seen: unknown[] = [];
    const unwatch = watchSubtitleSettings(fakeBrowser.storage.local, (settings) => {
      seen.push(settings);
    });
    const area = fakeBrowser.storage.local;
    await area.set({ subtitles: { ...defaultSubtitleSettings, display: 'ja' }, settings: {} });
    await area.set({ settings: { llamaBaseUrl: 'http://127.0.0.1:18083' } });
    await area.set({ subtitles: { display: 'dim' } });
    await area.remove('subtitles');
    unwatch();
    await area.set({ subtitles: { ...defaultSubtitleSettings, display: 'off' } });
    expect(seen).toEqual([
      { ...defaultSubtitleSettings, display: 'ja' },
      defaultSubtitleSettings,
      defaultSubtitleSettings,
    ]);
  });

  it('rejects an unknown source language with input_invalid', () => {
    const value: unknown = { ...defaultSubtitleSettings, sourceLang: 'xx' };
    expect(parseSubtitleSettings(value)).toMatchObject({
      ok: false,
      error: { internalCode: 'input_invalid' },
    });
    expect(parseSubtitleSettings({ ...defaultSubtitleSettings, sourceLang: 'ko' }).ok).toBe(true);
  });

  it('fails to load a stored record that does not match', async () => {
    await fakeBrowser.storage.local.set({ subtitles: { display: 'both' } });
    const store = subtitleSettingsStore(fakeBrowser.storage.local);
    expect(await store.load()).toMatchObject({ ok: false });
  });
});
