// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHold,
  HOLDING_ATTRIBUTE,
  MAX_WAIT_MS,
  MAX_WAITING,
  WAIT_ATTRIBUTE,
} from '../../src/hold.ts';

const LINE = 20;
const VIEW = 100;
const waiting = (line: Element): boolean => line.hasAttribute(WAIT_ATTRIBUTE);
/** Lines laid out: neither waiting nor removed by a write (`hidden` stands for `display:none`). */
const shown = (list: Element): Element[] =>
  [...list.children].filter((line) => !waiting(line) && !line.hasAttribute('hidden'));

/**
 * A chat list in a scroller, laid out like Twitch's (lines in the normal flow, newest last): jsdom
 * has no layout, so each shown line is LINE px high, the scroller VIEW px, and scrollTop is
 * clamped to the content as the browser does. `upward`: laid out like YouTube's, the list sits at
 * the bottom of a box of fixed height `upward` px, so a line let in pushes the lines before it up
 * and the scroll height stays.
 */
function chat(
  lines = 0,
  upward?: number,
): {
  scroller: HTMLElement;
  list: HTMLElement;
  add: (n?: number) => HTMLElement[];
} {
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  const list = document.createElement('div');
  scroller.append(list);
  document.body.append(scroller);
  const height = (): number => upward ?? Math.max(VIEW, shown(list).length * LINE);
  let top = 0;
  const clamp = (value: number): number => Math.max(0, Math.min(value, height() - VIEW));
  Object.defineProperties(scroller, {
    scrollHeight: { get: height },
    clientHeight: { get: () => VIEW },
    scrollTop: {
      get: () => clamp(top),
      set: (value: number) => {
        top = clamp(value);
      },
    },
  });
  let next = 0;
  const add = (n = 1): HTMLElement[] =>
    Array.from({ length: n }, () => {
      const line = document.createElement('div');
      next += 1;
      line.id = `line-${next}`;
      // Twitch wraps each line: the annotation is written on the inner element.
      line.append(document.createElement('span'));
      line.getBoundingClientRect = () => {
        const visible = shown(list);
        const index = visible.indexOf(line);
        // Normal flow from the top, or from the bottom of the fixed box.
        const offset = upward === undefined ? 0 : upward - visible.length * LINE;
        return new DOMRect(
          0,
          index < 0 ? 0 : offset + index * LINE - scroller.scrollTop,
          100,
          index < 0 ? 0 : LINE,
        );
      };
      list.append(line);
      return line;
    });
  add(lines);
  return { scroller, list, add };
}
const ids = (lines: readonly Element[]): string[] => lines.map((line) => line.id);

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('createHold', () => {
  it('keeps new lines out of sight until each is answered, in posting order (R52)', () => {
    const hold = createHold();
    const { list, add } = chat();
    const [first, second, third] = add(3);
    if (!first || !second || !third) throw new Error('no lines');
    hold.wait([first, second, third]);
    expect(shown(list)).toEqual([]);
    // The second is answered first: it stays out while the first waits.
    hold.pass([second]);
    expect(ids(shown(list))).toEqual([]);
    // The first is answered: both come in, in one pass; the third still waits.
    hold.pass([first]);
    expect(ids(shown(list))).toEqual(['line-1', 'line-2']);
    expect(hold.size()).toBe(1);
    // An element inside a line (Twitch's message inside its wrapper) answers the line.
    const inner = third.firstElementChild;
    if (!inner) throw new Error('no inner element');
    hold.pass([inner]);
    expect(ids(shown(list))).toEqual(['line-1', 'line-2', 'line-3']);
    expect(hold.size()).toBe(0);
    hold.stop();
  });

  it('lets a line in as it is after 2 s, with the answered lines behind it', () => {
    vi.useFakeTimers();
    const hold = createHold();
    const { list, add } = chat();
    const [first] = add();
    if (!first) throw new Error('no line');
    hold.wait([first]);
    vi.advanceTimersByTime(1000);
    const [second, third] = add(2);
    if (!second || !third) throw new Error('no lines');
    hold.wait([second, third]);
    hold.pass([second]);
    vi.advanceTimersByTime(MAX_WAIT_MS - 1000 - 1);
    expect(ids(shown(list))).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ids(shown(list))).toEqual(['line-1', 'line-2']);
    // The third waits its own 2 s from when it was added.
    vi.advanceTimersByTime(1000 - 1);
    expect(ids(shown(list))).toEqual(['line-1', 'line-2']);
    vi.advanceTimersByTime(1);
    expect(ids(shown(list))).toEqual(['line-1', 'line-2', 'line-3']);
    expect(vi.getTimerCount()).toBe(0);
    hold.stop();
  });

  it('never lets a line the page removed keep the others out', () => {
    const hold = createHold();
    const { list, add } = chat();
    const [gone, kept] = add(2);
    if (!gone || !kept) throw new Error('no lines');
    hold.wait([gone, kept]);
    gone.remove();
    hold.pass([kept]);
    expect(ids(shown(list))).toEqual(['line-2']);
    expect(hold.size()).toBe(0);
    hold.stop();
  });

  it(`holds at most ${MAX_WAITING} lines: past that the oldest comes in`, () => {
    const hold = createHold();
    const { list, add } = chat();
    const lines = add(MAX_WAITING + 1);
    hold.wait(lines.slice(0, MAX_WAITING));
    expect(hold.size()).toBe(MAX_WAITING);
    hold.wait(lines.slice(MAX_WAITING));
    expect(hold.size()).toBe(MAX_WAITING);
    expect(ids(shown(list))).toEqual(['line-1']);
    hold.stop();
  });

  it('keeps the chat at its end when it was there, and never moves it while the viewer reads above', () => {
    const hold = createHold();
    const { scroller, list, add } = chat(10);
    scroller.scrollTop = scroller.scrollHeight;
    expect(scroller.scrollTop).toBe(10 * LINE - VIEW);
    const answered = add(2);
    hold.wait(answered);
    hold.pass(answered);
    // The site follows the lines it adds, not the ones let in later: the hold does.
    expect(scroller.scrollTop).toBe(12 * LINE - VIEW);

    // The viewer scrolled up: lines let in leave what they read where it is.
    scroller.scrollTop = 40;
    const read = shown(list)[3];
    const before = read?.getBoundingClientRect().top;
    const more = add(3);
    hold.wait(more);
    hold.pass(more);
    expect(scroller.scrollTop).toBe(40);
    expect(read?.getBoundingClientRect().top).toBe(before);
    hold.stop();
  });

  it('keeps the line the viewer reads where it was when the list grows upwards (YouTube)', () => {
    const hold = createHold();
    // 20 lines at the bottom of a 1,000 px box; the viewer scrolled up from its end.
    const { scroller, list, add } = chat(20, 1000);
    scroller.scrollTop = 600;
    const read = shown(list)[5];
    const before = read?.getBoundingClientRect().top;
    const more = add(2);
    hold.wait(more);
    hold.pass(more);
    // The lines before moved up by two lines; the scroll followed them.
    expect(scroller.scrollTop).toBe(600 - 2 * LINE);
    expect(read?.getBoundingClientRect().top).toBe(before);
    // At its end nothing moves: the new lines show at the bottom of the box.
    scroller.scrollTop = 1000;
    const last = add();
    hold.wait(last);
    hold.pass(last);
    expect(scroller.scrollTop).toBe(1000 - VIEW);
    hold.stop();
  });

  it('keeps its anchor on a line still laid out when the same message removed the one before', () => {
    const hold = createHold();
    // YouTube's list again; the viewer reads above its end.
    const { scroller, list, add } = chat(20, 1000);
    scroller.scrollTop = 600;
    const lines = shown(list);
    const boundary = lines[19];
    const read = lines[5];
    if (!boundary || !read) throw new Error('no lines');
    const before = read.getBoundingClientRect().top;
    const more = add(3);
    hold.wait(more);
    // One message: a late 消す on the line that came in at its deadline (the line just before
    // the waiting ones), and answers for the waiting lines. The writes come first.
    boundary.setAttribute('hidden', '');
    hold.pass([boundary, ...more]);
    // The removal moved the lines by one line; letting three lines in moved them by none: the
    // anchor is the nearest line still laid out, not the removed one (no box to follow).
    expect(Math.abs((read.getBoundingClientRect().top ?? 0) - before)).toBeLessThanOrEqual(LINE);
    hold.stop();
  });

  it('measures the wait on a monotonic clock: a change of the wall clock lets no line in early', () => {
    vi.useFakeTimers();
    const hold = createHold();
    const { list, add } = chat();
    const [first, second] = add(2);
    if (!first || !second) throw new Error('no lines');
    hold.wait([first, second]);
    // The system clock jumps a minute ahead (a time sync); the page's own clock does not.
    vi.setSystemTime(Date.now() + 60_000);
    hold.pass([second]);
    expect(ids(shown(list))).toEqual([]);
    vi.advanceTimersByTime(MAX_WAIT_MS);
    expect(ids(shown(list))).toEqual(['line-1', 'line-2']);
    hold.stop();
  });

  it('lets every line in at once, and stops its timer on stop', () => {
    vi.useFakeTimers();
    const hold = createHold();
    const { list, add } = chat();
    hold.wait(add(3));
    hold.releaseAll();
    expect(shown(list)).toHaveLength(3);
    hold.wait(add(2));
    expect(vi.getTimerCount()).toBe(1);
    hold.stop();
    expect(shown(list)).toHaveLength(5);
    expect(list.querySelectorAll(`[${WAIT_ATTRIBUTE}]`)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('marks the list while it holds lines, from the first line kept out until all are let in', () => {
    const hold = createHold();
    const { list, add } = chat(2);
    // YouTube slides a new line in by moving the whole list: with the line kept out, the other
    // lines would drop by its height and slide back. The marked list does not move (R52).
    expect(list.hasAttribute(HOLDING_ATTRIBUTE)).toBe(false);
    const [first, second] = add(2);
    if (!first || !second) throw new Error('no lines');
    hold.wait([first]);
    expect(list.hasAttribute(HOLDING_ATTRIBUTE)).toBe(true);
    // Lines answered in turn: the list stays marked, as the next new line is kept out too.
    hold.pass([first]);
    expect(list.hasAttribute(HOLDING_ATTRIBUTE)).toBe(true);
    hold.wait([second]);
    // Holding stops (the viewer turned it off, the chat left the viewer): the site's own
    // animation is back.
    hold.releaseAll();
    expect(list.hasAttribute(HOLDING_ATTRIBUTE)).toBe(false);
    hold.wait(add());
    hold.stop();
    expect(list.hasAttribute(HOLDING_ATTRIBUTE)).toBe(false);
  });
});
