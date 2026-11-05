import { z } from 'zod/mini';
import { capture, decode, Ok, type Result } from '@chrome-toolbox/contracts';
import { parseBaseUrl } from './llm.ts';

export const settingsSchema = z.strictObject({
  llamaBaseUrl: z.string(),
  /** Model names sent to a llama.cpp router, which needs `model` on every request. */
  models: z.strictObject({ translate: z.string(), clef: z.string(), asr: z.string() }),
});
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  llamaBaseUrl: 'http://127.0.0.1:18083',
  models: { translate: 'gemma4-e4b', clef: 'clef-flash', asr: 'gemma4-e4b' },
};
// Settings saved before models existed held only the URL.
const legacySettingsSchema = z.strictObject({ llamaBaseUrl: z.string() });

/** The subset of chrome.storage.StorageArea the settings store needs. */
export type StorageArea = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};
export type SettingsStore = {
  load(this: void): Promise<Result<Settings>>;
  save(this: void, settings: Settings): Promise<Result<Settings>>;
};

export function settingsStore(area: StorageArea, key = 'settings'): SettingsStore {
  return {
    load: async (): Promise<Result<Settings>> => {
      const stored = await capture(() => area.get(key), 'storage_failed');
      if (!stored.ok) return stored;
      const value = stored.value[key];
      if (value === undefined) return Ok(defaultSettings);
      const legacy = decode(legacySettingsSchema, value);
      return legacy.ok
        ? Ok({ ...legacy.value, models: defaultSettings.models })
        : decode(settingsSchema, value);
    },
    save: async (settings: Settings): Promise<Result<Settings>> => {
      const baseUrl = parseBaseUrl(settings.llamaBaseUrl);
      if (!baseUrl.ok) return baseUrl;
      const normalized = { ...settings, llamaBaseUrl: baseUrl.value };
      const written = await capture(() => area.set({ [key]: normalized }), 'storage_failed');
      return written.ok ? Ok(normalized) : written;
    },
  };
}
