import { z } from 'zod/mini';
import { capture, Ok, type Result } from '@chrome-toolbox/contracts';
import { createLruCache, createQueue, type StorageArea } from '@chrome-toolbox/extension-core';

/** Tabs whose state the service worker keeps. */
export const TAB_STATE_MAX = 16;

export type TabSessionStore<T> = {
  /** Keeps the tab's value, in memory and in the session. */
  report(this: void, tabId: number, value: T): Promise<Result<void>>;
  /** The tab's value: from memory, or from the session when a restart emptied the memory. */
  get(this: void, tabId: number): Promise<Result<T | undefined>>;
  /** What memory holds for the tab, without reading the session. */
  known(this: void, tabId: number): T | undefined;
  /** Forgets a tab that closed. */
  forget(this: void, tabId: number): Promise<Result<void>>;
};

const listSchema = z.array(
  z.strictObject({ tabId: z.int().check(z.nonnegative()), value: z.unknown() }),
);
type Entry<T> = { tabId: number; value: T };

/**
 * One value for each of the `max` tabs reported last, kept in memory and in `storage.session`
 * under `key`, which outlives a stopped service worker (and ends with the browser session). The
 * session holds one list, `{ tabId, value }` with the oldest first, read and written whole, one
 * operation at a time so that none undoes another; a list that does not match (`schema` for each
 * value) counts as empty, and the next report replaces it.
 */
export function tabSessionStore<T>({
  area,
  key,
  schema,
  max = TAB_STATE_MAX,
}: {
  area: StorageArea;
  key: string;
  schema: z.ZodMiniType<T>;
  max?: number;
}): TabSessionStore<T> {
  const memory = createLruCache<number, T>({ max });
  const queue = createQueue({ concurrency: 1, maxPending: 64 });
  async function read(): Promise<Result<Entry<T>[]>> {
    const stored = await capture(() => area.get(key), 'storage_failed');
    if (!stored.ok) return stored;
    const list = listSchema.safeParse(stored.value[key]);
    if (!list.success) return Ok([]);
    const entries: Entry<T>[] = [];
    for (const { tabId, value } of list.data.slice(-max)) {
      const parsed = schema.safeParse(value);
      if (!parsed.success) return Ok([]);
      entries.push({ tabId, value: parsed.data });
    }
    return Ok(entries);
  }
  /** Writes `change` of the stored list, unless it gives undefined (nothing to change). */
  function update(change: (entries: Entry<T>[]) => Entry<T>[] | undefined): Promise<Result<void>> {
    return queue.run(async (): Promise<Result<void>> => {
      const entries = await read();
      if (!entries.ok) return entries;
      const next = change(entries.value);
      if (next === undefined) return Ok(undefined);
      return capture(() => area.set({ [key]: next.slice(-max) }), 'storage_failed');
    });
  }
  const without = (entries: Entry<T>[], tabId: number): Entry<T>[] =>
    entries.filter((entry) => entry.tabId !== tabId);
  return {
    report(tabId, value) {
      memory.set(tabId, value);
      return update((entries) => [...without(entries, tabId), { tabId, value }]);
    },
    async get(tabId): Promise<Result<T | undefined>> {
      const known = memory.get(tabId);
      if (known !== undefined) return Ok(known);
      // Behind the writes queued before it, so a forgotten tab does not come back.
      return queue.run(async (): Promise<Result<T | undefined>> => {
        const entries = await read();
        if (!entries.ok) return entries;
        // A report that came while this waited is newer than the session.
        const newer = memory.get(tabId);
        if (newer !== undefined) return Ok(newer);
        const stored = entries.value.find((entry) => entry.tabId === tabId)?.value;
        if (stored !== undefined) memory.set(tabId, stored);
        return Ok(stored);
      });
    },
    known: (tabId) => memory.get(tabId),
    forget(tabId) {
      memory.delete(tabId);
      return update((entries) =>
        entries.some((entry) => entry.tabId === tabId) ? without(entries, tabId) : undefined,
      );
    },
  };
}
