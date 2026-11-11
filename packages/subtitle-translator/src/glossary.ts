import { z } from 'zod/mini';
import { capture, decode, Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import type { StorageArea } from '@chrome-toolbox/extension-core';

/** Entries per streamer, characters of a source or target, and streamers kept. */
export const GLOSSARY_LIMITS = { entries: 50, chars: 32, streamers: 100 } as const;

export const glossaryEntrySchema = z.strictObject({
  source: z.string().check(z.minLength(1), z.maxLength(GLOSSARY_LIMITS.chars)),
  /** An empty target keeps the source as it is (a name that is not translated). */
  target: z.string().check(z.maxLength(GLOSSARY_LIMITS.chars)),
});
export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>;
const entriesSchema = z.array(glossaryEntrySchema).check(z.maxLength(GLOSSARY_LIMITS.entries));
const indexSchema = z.array(z.string());

const INDEX_KEY = 'glossary:index';
const keyOf = (streamer: string): string => `glossary:${streamer}`;

export type GlossaryStore = {
  load(this: void, streamer: string): Promise<Result<GlossaryEntry[]>>;
  save(this: void, streamer: string, entries: GlossaryEntry[]): Promise<Result<GlossaryEntry[]>>;
};

/** Trims, and keeps the later of entries with the same source (at its own place). */
function normalize(entries: readonly GlossaryEntry[]): GlossaryEntry[] {
  const trimmed = entries.map(({ source, target }) => ({
    source: source.trim(),
    target: target.trim(),
  }));
  return trimmed.filter(
    ({ source }, index) => !trimmed.slice(index + 1).some((later) => later.source === source),
  );
}

/** The viewer's glossary per streamer, kept for the 100 streamers saved last. */
export function glossaryStore(
  area: StorageArea & { remove(keys: string[]): Promise<void> },
): GlossaryStore {
  return {
    load: async (streamer): Promise<Result<GlossaryEntry[]>> => {
      const key = keyOf(streamer);
      const stored = await capture(() => area.get(key), 'storage_failed');
      if (!stored.ok) return stored;
      const value = stored.value[key];
      return value === undefined ? Ok([]) : decode(entriesSchema, value);
    },
    save: async (streamer, entries): Promise<Result<GlossaryEntry[]>> => {
      const parsed = entriesSchema.safeParse(normalize(entries));
      if (streamer === '' || !parsed.success) return Err(failure('input_invalid'));
      // Checked after trimming: padding does not count toward a limit that saves would pass.
      const kept = parsed.data;
      const read = await capture(() => area.get(INDEX_KEY), 'storage_failed');
      if (!read.ok) return read;
      const known = read.value[INDEX_KEY];
      const index = known === undefined ? Ok<string[]>([]) : decode(indexSchema, known);
      if (!index.ok) return index;
      const order = [...index.value.filter((name) => name !== streamer), streamer];
      const dropped = order.splice(0, Math.max(0, order.length - GLOSSARY_LIMITS.streamers));
      const written = await capture(
        () => area.set({ [keyOf(streamer)]: kept, [INDEX_KEY]: order }),
        'storage_failed',
      );
      if (!written.ok) return written;
      if (dropped.length > 0) {
        const removed = await capture(() => area.remove(dropped.map(keyOf)), 'storage_failed');
        if (!removed.ok) return removed;
      }
      return Ok(kept);
    },
  };
}

/** The glossary as a prompt takes it: an empty target becomes the source itself. */
export function toPromptGlossary(entries: readonly GlossaryEntry[]): GlossaryEntry[] {
  return entries.map(({ source, target }) => ({ source, target: target === '' ? source : target }));
}
