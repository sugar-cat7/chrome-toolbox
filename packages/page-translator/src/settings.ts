import { z } from 'zod/mini';
import { capture, decode, Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import type { StorageArea } from '@chrome-toolbox/extension-core';
import { DISPLAY_MODES, PAGE_TRANSLATORS } from './protocol.ts';

/**
 * - `always`: sites translated as soon as they open, at most this many;
 * - `never`: sites never translated, at most this many;
 * - `host`: the longest host name (DNS: 253 characters).
 */
export const PAGE_SETTINGS_LIMITS = { always: 200, never: 500, host: 253 } as const;
/** The longest `always` entry: `https://`, a host name and `/*`. */
const PATTERN_LENGTH = 'https://'.length + PAGE_SETTINGS_LIMITS.host + '/*'.length;

/**
 * The viewer's page choices, the same in every tab: how translations show (`mode`), who
 * translates (`translator`: `gemma` is the shared settings' `models.translate`, `plamo` the fixed
 * `PLAMO_TRANSLATE_MODEL`, P5), the sites translated as they open (`always`, match patterns) and
 * the sites never translated (`never`, host names). The llama.cpp URL and the models stay in
 * extension-core's settings (key `settings`).
 */
export const pageSettingsSchema = z.strictObject({
  v: z.literal(1),
  mode: z.enum(DISPLAY_MODES),
  translator: z.enum(PAGE_TRANSLATORS),
  always: z
    .array(z.string().check(z.maxLength(PATTERN_LENGTH)))
    .check(z.maxLength(PAGE_SETTINGS_LIMITS.always)),
  never: z
    .array(z.string().check(z.maxLength(PAGE_SETTINGS_LIMITS.host)))
    .check(z.maxLength(PAGE_SETTINGS_LIMITS.never)),
});
export type PageSettings = z.infer<typeof pageSettingsSchema>;
/** Gemma translates until the page bench (Task 3) decides for PLaMo. */
export const defaultPageSettings: PageSettings = {
  v: 1,
  mode: 'replace',
  translator: 'gemma',
  always: [],
  never: [],
};

export type PageSettingsStore = {
  load(this: void): Promise<Result<PageSettings>>;
  save(this: void, settings: PageSettings): Promise<Result<PageSettings>>;
};

/** The page choices in extension storage under `key`; the defaults until something is saved. */
export function pageSettingsStore(area: StorageArea, key = 'page'): PageSettingsStore {
  return {
    load: async (): Promise<Result<PageSettings>> => {
      const stored = await capture(() => area.get(key), 'storage_failed');
      if (!stored.ok) return stored;
      const value = stored.value[key];
      return value === undefined ? Ok(defaultPageSettings) : decode(pageSettingsSchema, value);
    },
    save: async (settings): Promise<Result<PageSettings>> => {
      const parsed = pageSettingsSchema.safeParse(settings);
      if (!parsed.success) return Err(failure('input_invalid'));
      const written = await capture(() => area.set({ [key]: parsed.data }), 'storage_failed');
      return written.ok ? Ok(parsed.data) : written;
    },
  };
}
