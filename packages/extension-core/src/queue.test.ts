import { describe, expect, it, vi } from 'vitest';
import { Ok, type Result } from '@chrome-toolbox/contracts';
import { createQueue } from './queue.ts';

type Gate = { task: (signal: AbortSignal) => Promise<Result<number>>; open: () => void };
const gate = (value: number): Gate => {
  let open = (): void => {};
  const released = new Promise<void>((resolve) => {
    open = resolve;
  });
  return {
    task: async (): Promise<Result<number>> => {
      await released;
      return Ok(value);
    },
    open: () => open(),
  };
};
const code = (result: Result<unknown>): string => (result.ok ? 'ok' : result.error.internalCode);

describe('bounded inference queue', () => {
  it.each([
    { concurrency: 1, tasks: 3, active: 1, pending: 2 },
    { concurrency: 2, tasks: 3, active: 2, pending: 1 },
    { concurrency: 3, tasks: 2, active: 2, pending: 0 },
  ])(
    'runs $concurrency at a time ($tasks tasks)',
    async ({ concurrency, tasks, active, pending }) => {
      const queue = createQueue({ concurrency, maxPending: 8 });
      const gates = Array.from({ length: tasks }, (_, index) => gate(index));
      const results = gates.map((entry) => queue.run(entry.task));
      expect(queue.size()).toEqual({ active, pending });
      for (const entry of gates) entry.open();
      expect((await Promise.all(results)).map((result) => result.ok && result.value)).toEqual(
        gates.map((_, index) => index),
      );
      expect(queue.size()).toEqual({ active: 0, pending: 0 });
    },
  );

  it('returns queue_full instead of growing past maxPending', async () => {
    const queue = createQueue({ concurrency: 1, maxPending: 1 });
    const running = gate(1);
    const first = queue.run(running.task);
    const second = queue.run(gate(2).task);
    expect(code(await queue.run(gate(3).task))).toBe('queue_full');
    queue.clear();
    running.open();
    expect(code(await first)).toBe('ok');
    expect(code(await second)).toBe('operation_cancelled');
  });

  it.each([
    { name: 'already aborted', abortBefore: true },
    { name: 'aborted while waiting', abortBefore: false },
  ])('cancels a pending task $name and releases its abort listener', async ({ abortBefore }) => {
    const queue = createQueue({ concurrency: 1, maxPending: 4 });
    const running = gate(1);
    const first = queue.run(running.task);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    if (abortBefore) controller.abort();
    const task = vi.fn<Gate['task']>(gate(2).task);
    const pending = queue.run(task, controller.signal);
    if (!abortBefore) controller.abort();
    expect(code(await pending)).toBe('operation_cancelled');
    expect(queue.size().pending).toBe(0);
    expect(remove.mock.calls.length).toBe(add.mock.calls.length);
    running.open();
    expect(code(await first)).toBe('ok');
    expect(task).not.toHaveBeenCalled();
  });

  it('removes the abort listener when a waiting task starts', async () => {
    const queue = createQueue({ concurrency: 1, maxPending: 4 });
    const running = gate(1);
    const first = queue.run(running.task);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const waiting = gate(2);
    const second = queue.run(waiting.task, controller.signal);
    running.open();
    await first;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    waiting.open();
    expect(code(await second)).toBe('ok');
  });

  it('normalizes a throwing task and keeps serving later work', async () => {
    const queue = createQueue();
    const broken = queue.run(() => Promise.reject(new Error('sdk failure')));
    const later = gate(5);
    const next = queue.run(later.task);
    expect(code(await broken)).toBe('unexpected_failure');
    expect(queue.size()).toEqual({ active: 1, pending: 0 });
    later.open();
    expect(await next).toEqual(Ok(5));
  });
});
