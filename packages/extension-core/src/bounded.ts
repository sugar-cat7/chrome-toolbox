export type Timers = { set(fn: () => void, ms: number): number; clear(id: number): void };

export const systemTimers: Timers = {
  set: (fn, ms) => Number(globalThis.setTimeout(fn, ms)),
  clear: (id) => globalThis.clearTimeout(id),
};

export type LruCache<K, V> = {
  get(this: void, key: K): V | undefined;
  set(this: void, key: K, value: V): void;
  /** Removes the key, if present, without `onEvict`. */
  delete(this: void, key: K): void;
  size(this: void): number;
  clear(this: void): void;
};

// A Map iterates in insertion order, so re-inserting on access keeps the oldest-used key first.
/** `onEvict` receives each entry dropped by the `max` cap or by `clear()` (not one replaced by `set`). */
export function createLruCache<K, V>({
  max,
  onEvict,
}: {
  max: number;
  onEvict?: (key: K, value: V) => void;
}): LruCache<K, V> {
  const entries = new Map<K, V>();
  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key) as V;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > max) {
        const oldest = entries.entries().next();
        if (oldest.done) return;
        const [oldestKey, oldestValue] = oldest.value;
        entries.delete(oldestKey);
        onEvict?.(oldestKey, oldestValue);
      }
    },
    delete(key) {
      entries.delete(key);
    },
    size: () => entries.size,
    clear() {
      const removed = [...entries];
      entries.clear();
      for (const [key, value] of removed) onEvict?.(key, value);
    },
  };
}

export type Batcher<T> = {
  push(this: void, item: T): { dropped: T[] };
  /** Emits the buffered items now instead of at the end of the window; a no-op when empty. */
  flush(this: void): void;
  dispose(this: void): void;
};

export function createBatcher<T>({
  maxItems,
  maxWaitMs,
  maxBuffered,
  flush,
  timers = systemTimers,
}: {
  maxItems: number;
  maxWaitMs: number;
  maxBuffered: number;
  flush: (items: T[]) => void;
  timers?: Timers;
}): Batcher<T> {
  let buffer: T[] = [];
  let timer: number | undefined;
  let disposed = false;
  const stop = (): void => {
    if (timer === undefined) return;
    timers.clear(timer);
    timer = undefined;
  };
  const emit = (): void => {
    stop();
    if (!buffer.length) return;
    const items = buffer;
    buffer = [];
    flush(items);
  };
  return {
    // After dispose the batcher is inert: the item is handed back as dropped and no timer is armed.
    push(item) {
      if (disposed) return { dropped: [item] };
      buffer.push(item);
      const dropped =
        buffer.length > maxBuffered ? buffer.splice(0, buffer.length - maxBuffered) : [];
      if (buffer.length >= maxItems) emit();
      else if (buffer.length && timer === undefined) {
        timer = timers.set(() => {
          timer = undefined;
          emit();
        }, maxWaitMs);
      }
      return { dropped };
    },
    flush() {
      if (!disposed) emit();
    },
    dispose() {
      disposed = true;
      stop();
      buffer = [];
    },
  };
}
