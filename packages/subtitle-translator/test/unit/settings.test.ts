import { afterEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
import {
  DISPLAY_MODES,
  defaultSubtitleSettings,
  nextDisplay,
  SOURCE_LANGUAGES,
  SOURCE_LANGUAGE_CODES,
  SUBTITLE_TRANSLATORS,
  parseSubtitleSettings,
  subtitleSettingsStore,
  TRANSLATOR_LABELS,
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
      Ok({ display: 'both', source: 'auto', sourceLang: 'auto', translator: 'gemma' }),
    );
    const next = { ...defaultSubtitleSettings, sourceLang: 'ko', translator: 'plamo' } as const;
    expect(await store.save(next)).toEqual(Ok(next));
    expect(await subtitleSettingsStore(fakeBrowser.storage.local).load()).toEqual(Ok(next));
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
