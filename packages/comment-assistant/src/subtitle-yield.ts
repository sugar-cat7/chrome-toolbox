// Comments give way to subtitles (user decision 2026-11-06): while the subtitle extension uses
// slot 0, comment requests run one at a time instead of on every spare slot. The extensions never
// message each other, so this asks llama-server (`GET /slots`) whether slot 0 is processing.
import { Err, failure, launch, Ok, type Result } from '@chrome-toolbox/contracts';
import type { SlotState, Timers } from '@chrome-toolbox/extension-core';

/**
 * Ruling S37. `probeTtlMs` is one subtitle tick (1.5 s): at most one probe per tick, and only
 * when a second request would start. `busyWindowMs` is 10 ticks: a probe sees one instant of
 * `is_processing`, and while someone speaks slot 0 is idle about 50–70% of a tick, so 10 idle
 * answers in a row (≈3% for Japanese speech) are needed before two requests run again.
 * `probeTimeoutMs`: `/slots` does no inference and answers in milliseconds; a server that does
 * not answer must not hold the second request back.
 */
export const SUBTITLE_YIELD = {
  busyWindowMs: 15_000,
  probeTtlMs: 1_500,
  probeTimeoutMs: 1_000,
} as const;

export type SubtitleYield = {
  /**
   * The comment requests that may run at once: `concurrency`, or 1 while subtitles use slot 0
   * (seen processing within `busyWindowMs`) or while a fresh probe is awaited.
   */
  limit(this: void, concurrency: number): number;
  /** Aborts the running probe; from then on it never asks and `limit` gives `concurrency`. */
  dispose(this: void): void;
};

/** Whether slot 0 is processing, from a `/slots` answer; `response_invalid` without slot 0. */
export function slotZeroBusy(slots: readonly SlotState[]): Result<boolean> {
  const zero = slots.find((slot) => slot.id === 0);
  return zero === undefined ? Err(failure('response_invalid')) : Ok(zero.processing);
}

export function createSubtitleYield(deps: {
  /** Whether slot 0 is processing. */
  probe: (signal: AbortSignal) => Promise<Result<boolean>>;
  now: () => number;
  timers: Timers;
  /** A probe ended (answered, failed or timed out): waiting work may start now. */
  changed: () => void;
}): SubtitleYield {
  const { busyWindowMs, probeTtlMs, probeTimeoutMs } = SUBTITLE_YIELD;
  let disposed = false;
  let running: { controller: AbortController; timer: number } | undefined;
  /** When the last probe ended, and whether it failed. */
  let answered: { at: number; failed: boolean } | undefined;
  /** When slot 0 was last seen processing. */
  let busyAt: number | undefined;

  /** Records the probe's outcome (`undefined`: failed) once, unless it was superseded. */
  function settle(controller: AbortController, busy: boolean | undefined): void {
    if (disposed || running?.controller !== controller) return;
    deps.timers.clear(running.timer);
    running = undefined;
    const at = deps.now();
    answered = { at, failed: busy === undefined };
    if (busy === true) busyAt = at;
    deps.changed();
  }
  function ask(): void {
    const controller = new AbortController();
    const timer = deps.timers.set(() => {
      controller.abort();
      settle(controller, undefined);
    }, probeTimeoutMs);
    running = { controller, timer };
    launch(
      async () => {
        const result = await deps.probe(controller.signal);
        settle(controller, result.ok ? result.value : undefined);
      },
      () => settle(controller, undefined),
    );
  }
  return {
    limit(concurrency) {
      if (concurrency <= 1 || disposed) return concurrency;
      const now = deps.now();
      if (answered === undefined || now - answered.at >= probeTtlMs) {
        if (running === undefined) ask();
        return 1;
      }
      if (answered.failed) return concurrency;
      return busyAt !== undefined && now - busyAt < busyWindowMs ? 1 : concurrency;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (running === undefined) return;
      deps.timers.clear(running.timer);
      running.controller.abort();
      running = undefined;
    },
  };
}
