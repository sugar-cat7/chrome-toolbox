import type { TranslatedLine } from '../captions/feeder.ts';

export type Timeline = {
  /** Adds the lines, or replaces those with the same id. */
  upsert(this: void, lines: readonly TranslatedLine[]): void;
  /** The line to show at the position, if any. */
  at(this: void, positionMs: number): TranslatedLine | undefined;
  /** Forgets the lines farther than `keepMs` from the position. */
  prune(this: void, positionMs: number): void;
  reset(this: void): void;
  size(this: void): number;
};

/**
 * The caption lines the overlay shows, kept in an array in the order of their start, which is
 * bisected on every video frame. A line shows from its start until just before its end; where
 * lines overlap, the one that started last shows. A line's id carries its start (`toSentences`),
 * so a line replaced keeps its place. Only lines within `keepMs` of the position are kept, once
 * `prune` is called.
 */
export function createTimeline({ keepMs }: { keepMs: number }): Timeline {
  let lines: TranslatedLine[] = [];

  /** The index of the first line that starts after `ms`. */
  function after(ms: number): number {
    let low = 0;
    let high = lines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((lines[middle]?.startMs ?? Number.POSITIVE_INFINITY) > ms) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  function upsertOne(line: TranslatedLine): void {
    const end = after(line.startMs);
    for (let index = end - 1; index >= 0; index -= 1) {
      const known = lines[index];
      if (known === undefined || known.startMs !== line.startMs) break;
      if (known.id === line.id) {
        lines[index] = line;
        return;
      }
    }
    lines.splice(end, 0, line);
  }

  return {
    upsert(added) {
      for (const line of added) upsertOne(line);
    },
    at(ms) {
      const line = lines[after(ms) - 1];
      return line !== undefined && ms < line.endMs ? line : undefined;
    },
    prune(ms) {
      const kept = lines.filter((line) => line.endMs >= ms - keepMs && line.startMs <= ms + keepMs);
      if (kept.length < lines.length) lines = kept;
    },
    reset() {
      lines = [];
    },
    size: () => lines.length,
  };
}
