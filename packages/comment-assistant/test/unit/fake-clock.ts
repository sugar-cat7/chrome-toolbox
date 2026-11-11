// A clock the test advances by hand: Timers plus `now`, for the pipeline and its helpers.
import type { Timers } from '@chrome-toolbox/extension-core';

export type FakeClock = {
  timers: Timers;
  now: () => number;
  /** Moves the time on by `ms` and runs every timer due by then. */
  advance(ms: number): void;
  /** Timers set and not yet run or cleared. */
  active(): number;
};

/** Fake clock starting at `start`. */
export const fakeClock = (start: number): FakeClock => {
  let time = start;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set: (fn, ms) => {
        const id = nextId++;
        pending.set(id, { at: time + ms, fn });
        return id;
      },
      clear: (id) => void pending.delete(id),
    },
    now: () => time,
    advance(ms) {
      time += ms;
      for (const [id, entry] of [...pending]) {
        if (entry.at > time) continue;
        pending.delete(id);
        entry.fn();
      }
    },
    active: () => pending.size,
  };
};
