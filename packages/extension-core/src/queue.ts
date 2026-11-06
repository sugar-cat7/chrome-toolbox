import { capture, Err, failure, type Result } from '@chrome-toolbox/contracts';

export type Task<T> = (signal: AbortSignal) => Promise<Result<T>>;
export type Queue = {
  run<T>(this: void, task: Task<T>, signal?: AbortSignal): Promise<Result<T>>;
  /** Cancels every waiting task; running tasks finish through their own signal. */
  clear(this: void): void;
  size(this: void): Readonly<{ active: number; pending: number }>;
};

// Local inference serves one request at a time on a 20 GB budget. Waiting work is
// bounded so a chat flood degrades to explicit queue_full results, never memory growth.
export function createQueue({ concurrency = 1, maxPending = 32 } = {}): Queue {
  let active = 0;
  const waiting: { start: () => void; cancel: () => void }[] = [];
  const idle = new AbortController().signal;
  const drain = (): void => {
    while (active < concurrency && waiting.length) waiting.shift()?.start();
  };
  async function execute<T>(task: Task<T>, signal: AbortSignal): Promise<Result<T>> {
    active += 1;
    const outcome = await capture(() => task(signal), 'unexpected_failure');
    active -= 1;
    drain();
    return outcome.ok ? outcome.value : outcome;
  }
  function run<T>(task: Task<T>, signal: AbortSignal = idle): Promise<Result<T>> {
    if (signal.aborted) return Promise.resolve(Err(failure('operation_cancelled')));
    if (active < concurrency) return execute(task, signal);
    if (waiting.length >= maxPending) return Promise.resolve(Err(failure('queue_full')));
    return new Promise((resolve) => {
      const entry = {
        start: () => {
          signal.removeEventListener('abort', entry.cancel);
          resolve(execute(task, signal));
        },
        cancel: () => {
          signal.removeEventListener('abort', entry.cancel);
          const index = waiting.indexOf(entry);
          if (index !== -1) waiting.splice(index, 1);
          resolve(Err(failure('operation_cancelled')));
        },
      };
      signal.addEventListener('abort', entry.cancel, { once: true });
      waiting.push(entry);
    });
  }
  return {
    run,
    clear: () => {
      for (const entry of waiting.slice()) entry.cancel();
    },
    size: () => ({ active, pending: waiting.length }),
  };
}
