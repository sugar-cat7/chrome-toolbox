import { type Result } from '@chrome-toolbox/contracts';
import { createLruCache } from './bounded.ts';

/** A session-owned memo: successful values expire from completion time; failures are never cached. */
export function createRelayMemo<T>(now: () => number) {
  const cache = createLruCache<string, { value: T; expires: number }>({ max: 500 });
  const pending = new Map<string, Promise<Result<T>>>();
  let generation = 0;
  return {
    run(key: string, operation: () => Promise<Result<T>>): Promise<Result<T>> {
      const hit = cache.get(key);
      if (hit && hit.expires > now()) return Promise.resolve({ ok: true, value: hit.value });
      cache.delete(key);
      const running = pending.get(key);
      if (running) return running;
      const version = generation;
      const promise = execute();
      pending.set(key, promise);
      async function execute(): Promise<Result<T>> {
        const result = await operation();
        if (generation === version) {
          pending.delete(key);
          if (result.ok) cache.set(key, { value: result.value, expires: now() + 600_000 });
        }
        return result;
      }
      return promise;
    },
    clear(): void {
      generation += 1;
      cache.clear();
      pending.clear();
    },
  };
}
