import type { Timers } from '@chrome-toolbox/extension-core';
import type { LiveLine } from '../protocol.ts';
import type { DisplayMode } from '../settings.ts';
import type { OverlayView } from './overlay.ts';

/**
 * A line goes away 6,000 ms after its last update; while a line waits for its translation, the
 * previous one shows dimmed for at most 3,000 ms.
 */
export const LIVE_VIEW_LIMITS = { holdMs: 6_000, dimMs: 3_000 } as const;

export type LiveView = {
  /** Shows the line: a new sentence, or the same sentence (`sentenceId`) updated. */
  upsert(this: void, line: LiveLine): void;
  /** The line on screen, if any. */
  current(this: void): LiveLine | undefined;
  /** The translation to show dimmed under the current line, while it waits for its own. */
  dimmed(this: void): string | undefined;
  /** Shows nothing and stops the timer, without `onChange`. */
  reset(this: void): void;
};

/** Pending without a translation: what is shown in the Japanese row is not its own. */
const waits = (line: LiveLine): boolean => line.state === 'pending' && line.ja === undefined;

/**
 * The line the audio path shows: the latest sentence, replaced by its own updates (it grows, and
 * its translation comes) and cleared `holdMs` after its last update. An update of an older sentence
 * (another id, ended earlier) never covers a newer one; its translation only counts as the
 * previous one. While the current line waits for its translation, the latest translation (of an
 * earlier sentence, or of this one before it grew) shows dimmed, for at most 3,000 ms from when it
 * began waiting. One timer, set again on every update, serves both. `onChange` follows every change
 * of what shows.
 */
export function createLiveView({
  holdMs,
  timers,
  onChange,
  now = () => performance.now(),
}: {
  holdMs: number;
  timers: Timers;
  onChange: () => void;
  /** A clock in ms for the deadlines (tests pass the fake one). */
  now?: () => number;
}): LiveView {
  let line: LiveLine | undefined;
  /** The latest translation that came. */
  let translation: string | undefined;
  let updatedAt = 0;
  /** When the current line began waiting, while it still shows another line's translation. */
  let waitingSince: number | undefined;
  let timer: number | undefined;

  function arm(): void {
    if (timer !== undefined) timers.clear(timer);
    const due =
      waitingSince === undefined ? updatedAt + holdMs : waitingSince + LIVE_VIEW_LIMITS.dimMs;
    timer = timers.set(fire, Math.max(0, due - now()));
  }
  function clear(): void {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
    line = undefined;
    translation = undefined;
    waitingSince = undefined;
  }
  function fire(): void {
    timer = undefined;
    if (waitingSince !== undefined && now() < updatedAt + holdMs) {
      // The dim is over; the line stays until its hold ends.
      waitingSince = undefined;
      arm();
    } else clear();
    onChange();
  }

  return {
    upsert(next) {
      const shown = line;
      if (
        shown !== undefined &&
        next.sentenceId !== shown.sentenceId &&
        next.endedAt < shown.endedAt
      ) {
        if (next.ja === undefined) return;
        translation = next.ja;
        if (waitingSince !== undefined) onChange();
        return;
      }
      const at = now();
      const stillWaiting =
        shown !== undefined && shown.sentenceId === next.sentenceId && waits(shown);
      line = next;
      updatedAt = at;
      if (!waits(next)) waitingSince = undefined;
      else if (!stillWaiting) waitingSince = at;
      if (next.ja !== undefined) translation = next.ja;
      arm();
      onChange();
    },
    current: () => line,
    dimmed: () => (waitingSince === undefined ? undefined : translation),
    reset: clear,
  };
}

/** What the overlay shows for the live view under `display`. */
export function liveLineView(view: LiveView, display: DisplayMode): OverlayView {
  const line = view.current();
  if (line === undefined) return { display };
  const dimmed = line.ja === undefined ? view.dimmed() : undefined;
  return {
    display,
    lang: line.lang,
    source: line.source,
    ...(line.ja !== undefined
      ? { ja: line.ja }
      : dimmed !== undefined
        ? { ja: dimmed, jaDim: true }
        : {}),
    endedAt: line.endedAt,
  };
}
