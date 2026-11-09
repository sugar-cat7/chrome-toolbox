import { z } from 'zod/mini';
import { capture, decode, Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import type { StorageArea } from '@chrome-toolbox/extension-core';

/** How the subtitles show: Japanese only, source and Japanese, source only, or nothing. */
export const DISPLAY_MODES = ['ja', 'both', 'source', 'off'] as const;
export type DisplayMode = (typeof DISPLAY_MODES)[number];
export const DISPLAY_LABELS = {
  ja: '日本語',
  both: '併記',
  source: '原語',
  off: 'オフ',
} as const satisfies Record<DisplayMode, string>;

/** The next mode of the player button and the shortcut: ja → both → source → off → ja. */
export function nextDisplay(mode: DisplayMode): DisplayMode {
  const index = DISPLAY_MODES.indexOf(mode);
  return DISPLAY_MODES[(index + 1) % DISPLAY_MODES.length] ?? 'ja';
}

/** Spoken languages the viewer can fix, with their Japanese labels. */
export const SOURCE_LANGUAGES = {
  en: '英語',
  es: 'スペイン語',
  ko: '韓国語',
  id: 'インドネシア語',
  zh: '中国語',
  ja: '日本語',
  pt: 'ポルトガル語',
  fr: 'フランス語',
  de: 'ドイツ語',
  ru: 'ロシア語',
  th: 'タイ語',
  vi: 'ベトナム語',
} as const;
export type SourceLanguageCode = keyof typeof SOURCE_LANGUAGES;
export const SOURCE_LANGUAGE_CODES = [
  'en',
  'es',
  'ko',
  'id',
  'zh',
  'ja',
  'pt',
  'fr',
  'de',
  'ru',
  'th',
  'vi',
] as const satisfies readonly SourceLanguageCode[];
// Fails to compile when a code is missing from the list.
const _everyLanguageListed: SourceLanguageCode extends (typeof SOURCE_LANGUAGE_CODES)[number]
  ? true
  : never = true;
void _everyLanguageListed;

/**
 * Who translates: `gemma` is the extension-core settings' `models.translate`; `plamo` is the
 * fixed `plamo-3-translate-2b`.
 */
export const SUBTITLE_TRANSLATORS = ['gemma', 'plamo'] as const;
export type SubtitleTranslator = (typeof SUBTITLE_TRANSLATORS)[number];
export const TRANSLATOR_LABELS = {
  gemma: 'Gemma（既定）',
  plamo: 'PLaMo 3 Translate 2B（速い・任意）',
} as const satisfies Record<SubtitleTranslator, string>;

export const subtitleSettingsSchema = z.strictObject({
  display: z.enum(DISPLAY_MODES),
  source: z.enum(['auto', 'captions', 'audio']),
  sourceLang: z.union([z.literal('auto'), z.enum(SOURCE_LANGUAGE_CODES)]),
  translator: z.enum(SUBTITLE_TRANSLATORS),
});
export type SubtitleSettings = z.infer<typeof subtitleSettingsSchema>;
export const defaultSubtitleSettings: SubtitleSettings = {
  display: 'both',
  source: 'auto',
  sourceLang: 'auto',
  translator: 'gemma',
};

/** Checks a value of unknown origin (a message) against the schema: `input_invalid` when it fails. */
export function parseSubtitleSettings(value: unknown): Result<SubtitleSettings> {
  const parsed = subtitleSettingsSchema.safeParse(value);
  return parsed.success ? Ok(parsed.data) : Err(failure('input_invalid'));
}

export type SubtitleSettingsStore = {
  load(this: void): Promise<Result<SubtitleSettings>>;
  save(this: void, settings: SubtitleSettings): Promise<Result<SubtitleSettings>>;
};

/** The viewer's subtitle choices; the server URL and models stay in extension-core's settings. */
export function subtitleSettingsStore(area: StorageArea, key = 'subtitles'): SubtitleSettingsStore {
  return {
    load: async (): Promise<Result<SubtitleSettings>> => {
      const stored = await capture(() => area.get(key), 'storage_failed');
      if (!stored.ok) return stored;
      const value = stored.value[key];
      return value === undefined
        ? Ok(defaultSubtitleSettings)
        : decode(subtitleSettingsSchema, value);
    },
    save: async (settings): Promise<Result<SubtitleSettings>> => {
      // The type guards callers; the check guards values that arrive in messages.
      const parsed = parseSubtitleSettings(settings);
      if (!parsed.ok) return parsed;
      const written = await capture(() => area.set({ [key]: parsed.value }), 'storage_failed');
      return written.ok ? Ok(parsed.value) : written;
    },
  };
}

/** What a storage area tells of its changes (`storage.local.onChanged`): each changed key. */
export type StorageChanges = Readonly<Record<string, Readonly<{ newValue?: unknown }>>>;
export type StorageEvents = {
  onChanged: {
    addListener(listener: (changes: StorageChanges) => void): void;
    removeListener(listener: (changes: StorageChanges) => void): void;
  };
};

/**
 * Follows the saved subtitle settings, which any tab, the shortcut or the side panel may change:
 * `onChange` gets them after each change of `key` in `area`, as `load` reads them (the defaults for
 * a removed value, and also for one that does not match, as a reader that cannot load them uses).
 * Returns the removal of the listener.
 */
export function watchSubtitleSettings(
  area: StorageEvents,
  onChange: (settings: SubtitleSettings) => void,
  key = 'subtitles',
): () => void {
  function listener(changes: StorageChanges): void {
    const change = changes[key];
    if (change === undefined) return;
    const value = change.newValue;
    const parsed = value === undefined ? undefined : subtitleSettingsSchema.safeParse(value);
    onChange(parsed?.success === true ? parsed.data : defaultSubtitleSettings);
  }
  area.onChanged.addListener(listener);
  return () => area.onChanged.removeListener(listener);
}
