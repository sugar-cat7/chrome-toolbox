import * as z from 'zod/mini';
import { commentCategorySchema } from './stream-categories.ts';

export const commentLimits = {
  batcher: { maxItems: 3, maxWaitMs: 500, maxBuffered: 200 },
  store: { maxItems: 5000, maxAgeMs: 30 * 60_000 },
  lruMax: 2000,
} as const;

export const commentRecordSchema = z.strictObject({
  id: z.string(),
  site: z.enum(['youtube', 'twitch']),
  channel: z.string(),
  author: z.string(),
  text: z.string(),
  lang: z.string(),
  at: z.number(),
  translation: z.optional(z.string()),
  category: z.optional(commentCategorySchema),
  abusive: z.optional(z.number()),
  /**
   * `stored`: read while its chat was not in front of the viewer and kept without the model or
   * Clef (no translation or category); it may be processed later and updated in place.
   */
  state: z.enum(['pending', 'done', 'skipped', 'failed', 'stored']),
});
export type CommentRecord = z.infer<typeof commentRecordSchema>;
export type CommentPatch = Partial<
  Pick<CommentRecord, 'lang' | 'translation' | 'category' | 'abusive' | 'state'>
>;

export type CommentStore = {
  /** Adds unseen ids and returns only the records that were added and survived pruning. */
  add(this: void, records: CommentRecord[]): CommentRecord[];
  update(this: void, id: string, patch: CommentPatch): CommentRecord | undefined;
  /** Records whose `at` falls within the last `ms` milliseconds, oldest first. */
  since(this: void, ms: number): CommentRecord[];
  size(this: void): number;
  clear(this: void): void;
};

export function createCommentStore({
  maxItems,
  maxAgeMs,
  now,
}: {
  maxItems: number;
  maxAgeMs: number;
  now: () => number;
}): CommentStore {
  // Insertion-ordered ring-ish queue: `head` marks the first live entry so pruning is amortized O(1).
  // `key` is `at` clamped to be non-decreasing, so an out-of-order record is expired no earlier than
  // its predecessors; the queue prefix is therefore always the next to expire.
  type Entry = { record: CommentRecord; key: number };
  let order: Entry[] = [];
  let head = 0;
  let lastKey = Number.NEGATIVE_INFINITY;
  const byId = new Map<string, CommentRecord>();
  const drop = (entry: Entry): void => {
    byId.delete(entry.record.id);
    head += 1;
  };
  const prune = (): void => {
    const oldest = now() - maxAgeMs;
    while (head < order.length && (order[head] as Entry).key < oldest) drop(order[head] as Entry);
    while (order.length - head > maxItems) drop(order[head] as Entry);
    if (head > 32 && head * 2 > order.length) {
      order = order.slice(head);
      head = 0;
    }
  };
  return {
    add(records) {
      const added: CommentRecord[] = [];
      for (const record of records) {
        if (byId.has(record.id)) continue;
        const stored = { ...record };
        lastKey = Math.max(lastKey, stored.at);
        byId.set(stored.id, stored);
        order.push({ record: stored, key: lastKey });
        added.push(stored);
      }
      prune();
      return added.filter((record) => byId.get(record.id) === record);
    },
    update(id, patch) {
      const record = byId.get(id);
      if (!record) return undefined;
      for (const key of ['lang', 'translation', 'category', 'abusive', 'state'] as const) {
        const value = patch[key];
        if (value !== undefined) Object.assign(record, { [key]: value });
      }
      return record;
    },
    since(ms) {
      const from = now() - ms;
      const recent: CommentRecord[] = [];
      for (let i = head; i < order.length; i += 1) {
        const { record } = order[i] as Entry;
        if (record.at >= from) recent.push(record);
      }
      return recent;
    },
    size: () => order.length - head,
    clear() {
      order = [];
      head = 0;
      lastKey = Number.NEGATIVE_INFINITY;
      byId.clear();
    },
  };
}
