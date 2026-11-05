/**
 * Marks a chat line kept out of sight until it is judged (R52); the injected style gives it
 * `display:none`, so it takes no room in the chat.
 */
export const WAIT_ATTRIBUTE = 'data-ca-wait';
/**
 * Marks the chat list while it holds lines; the injected style keeps it from moving. YouTube
 * slides a new line in by moving its whole list down by the line's height and back, measured
 * before a line can be kept out: the other lines would drop and slide back (seen live on
 * 2026-11-02). Lines let in come in without the slide.
 */
export const HOLDING_ATTRIBUTE = 'data-ca-holding';
/** Longest a line stays out, from when the page added it; then it comes in as it is. */
export const MAX_WAIT_MS = 2000;
/** Lines kept out at most; past that the oldest comes in. */
export const MAX_WAITING = 300;
/** A chat scrolled to within this distance of its end counts as at its end. */
const END_SLACK_PX = 8;
/** How far up from an element its line (a child of the chat list) may be: Twitch wraps lines. */
const MAX_DEPTH = 4;
/** Lines walked back from the first line let in to find one already shown. */
const MAX_ANCHOR_STEPS = MAX_WAITING;
const SCROLLS = /^(?:auto|scroll|overlay)$/u;

type Waiting = { deadline: number; passed: boolean };
/** The chat's scroll as read before lines come in. */
type Scroll = Readonly<{
  scroller?: Element;
  atEnd?: boolean;
  /** The nearest line shown before the first one let in, and its top then. */
  anchor?: Element | undefined;
  top?: number | undefined;
}>;

export type Hold = Readonly<{
  /**
   * Keeps lines the page just added to the chat out of sight until each is judged. They come in
   * in posting order (the order given): a line answered early waits for every line before it.
   */
  wait(this: void, lines: readonly Element[]): void;
  /**
   * Lines judged (their annotation is written) or never to be (no comment in them): each comes in
   * once every line before it did, all in one pass. An element may be a line or inside one.
   */
  pass(this: void, elements: Iterable<Element>): void;
  /** Whether `element` is a waiting line, or inside one. */
  waits(this: void, element: Element): boolean;
  /**
   * Lets every waiting line in at once and unmarks the list: holding stops until the next `wait`.
   * `follow` false leaves the scroll alone: the chat left the viewer, or its lines are gone.
   */
  releaseAll(this: void, follow?: boolean): void;
  /** The number of lines kept out. */
  size(this: void): number;
  /** Lets every line in, without scrolling, and stops the timer. */
  stop(this: void): void;
}>;

/** The element the chat scrolls in: the nearest ancestor of `list` that scrolls. */
function scrollerOf(list: Element): Element | undefined {
  const view = list.ownerDocument.defaultView;
  for (let element = list.parentElement; element; element = element.parentElement)
    if (view && SCROLLS.test(view.getComputedStyle(element).overflowY)) return element;
  return list.ownerDocument.scrollingElement ?? undefined;
}

/**
 * Keeps new chat lines out of sight until they are judged (R52): the site's own elements, marked
 * `WAIT_ATTRIBUTE`, never copies. Lines come in in posting order: when judged, after
 * `MAX_WAIT_MS` (as they are; a later annotation still applies), when more than `MAX_WAITING`
 * wait (the oldest), or all at once. A line the page removed never keeps the others out. Lines
 * let in grow the chat where the site did not scroll for them: a chat that was at its end before
 * is scrolled to its end again, and one the viewer scrolled up keeps the line they read where it
 * was (YouTube's list grows upwards). From the first line kept out until every line is let in at
 * once (`releaseAll`), the list is marked `HOLDING_ATTRIBUTE`. One timer, for the oldest line's
 * deadline; deadlines are on the page's monotonic clock (`performance.now()`), so a change of
 * the system time lets no line in early or late.
 */
export function createHold(now: () => number = () => performance.now()): Hold {
  /** In posting order, the oldest first. */
  const waiting = new Map<Element, Waiting>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The last list seen and the element it scrolls in, found once per list. */
  let scrolls: { list: Element; scroller: Element | undefined } | undefined;
  /** The list marked `HOLDING_ATTRIBUTE`. */
  let marked: Element | undefined;

  function scrollerFor(line: Element): Element | undefined {
    const list = line.parentElement;
    if (!list) return undefined;
    if (scrolls?.list !== list || scrolls.scroller?.isConnected === false)
      scrolls = { list, scroller: scrollerOf(list) };
    return scrolls.scroller;
  }
  /**
   * The nearest line before `line` that is laid out and stays so: what the viewer reads stays
   * put by it. Not a waiting line, not one of the lines `written` in this pass (a late 消す may
   * just have removed it), and not one without a box (`display:none`, a zero rect).
   */
  function shownBefore(line: Element, written: ReadonlySet<Element>): Element | undefined {
    let steps = 0;
    for (let other = line.previousElementSibling; other; other = other.previousElementSibling) {
      if (!other.hasAttribute(WAIT_ATTRIBUTE) && !written.has(other)) {
        const box = other.getBoundingClientRect();
        if (box.width > 0 || box.height > 0) return other;
      }
      steps += 1;
      if (steps >= MAX_ANCHOR_STEPS) return undefined;
    }
    return undefined;
  }
  /**
   * Reads the chat once before `lines` come in (with `follow`), after the annotations of the
   * pass are written: whether it is at its end, or where the line the viewer reads is.
   */
  function measure(
    lines: readonly Element[],
    follow: boolean,
    written: ReadonlySet<Element> = new Set(),
  ): Scroll {
    const first = lines.find((line) => line.isConnected);
    const scroller = follow && first ? scrollerFor(first) : undefined;
    if (scroller === undefined) return {};
    const atEnd =
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= END_SLACK_PX;
    const anchor = !atEnd && first ? shownBefore(first, written) : undefined;
    return { scroller, atEnd, anchor, top: anchor?.getBoundingClientRect().top };
  }
  /** Takes `WAIT_ATTRIBUTE` off `lines`, then scrolls once as `scroll` says. */
  function letIn(lines: readonly Element[], { scroller, atEnd, anchor, top }: Scroll): void {
    for (const line of lines) line.removeAttribute(WAIT_ATTRIBUTE);
    if (scroller === undefined) return;
    if (atEnd === true) {
      scroller.scrollTop = scroller.scrollHeight;
      return;
    }
    if (anchor === undefined || top === undefined || !anchor.isConnected) return;
    const moved = anchor.getBoundingClientRect().top - top;
    if (moved !== 0) scroller.scrollTop += moved;
  }
  function arm(): void {
    if (timer !== undefined) return;
    const [oldest] = waiting.values();
    if (oldest === undefined) return;
    timer = setTimeout(onTimer, Math.max(0, oldest.deadline - now()));
  }
  function onTimer(): void {
    timer = undefined;
    release(0);
  }
  /**
   * Takes out, from the oldest, every line judged, past its deadline or removed, and before them
   * the `forced` oldest; stops at the first line that must still wait.
   */
  function due(forced: number): Element[] {
    const at = now();
    const lines: Element[] = [];
    for (const [line, entry] of waiting) {
      if (lines.length >= forced && !entry.passed && entry.deadline > at && line.isConnected) break;
      lines.push(line);
    }
    for (const line of lines) waiting.delete(line);
    return lines;
  }
  /** Lets in the lines `due` gives, in one pass; `written` are the lines this pass wrote. */
  function release(forced: number, written?: ReadonlySet<Element>): void {
    const lines = due(forced);
    if (lines.length > 0) letIn(lines, measure(lines, true, written));
    arm();
  }
  /** The waiting line `element` is, or is inside. */
  function lineOf(element: Element): Waiting | undefined {
    let current: Element | null = element;
    for (let depth = 0; current && depth <= MAX_DEPTH; depth += 1) {
      const entry = waiting.get(current);
      if (entry) return entry;
      current = current.parentElement;
    }
    return undefined;
  }
  /** Elements written in a pass and the lines holding them (a few levels up). */
  function linesOf(elements: Iterable<Element>): Set<Element> {
    const lines = new Set<Element>();
    for (const element of elements) {
      let current: Element | null = element;
      for (let depth = 0; current && depth <= MAX_DEPTH; depth += 1) {
        lines.add(current);
        current = current.parentElement;
      }
    }
    return lines;
  }
  function releaseAll(follow = true): void {
    clearTimeout(timer);
    timer = undefined;
    const lines = [...waiting.keys()];
    waiting.clear();
    if (lines.length > 0) letIn(lines, measure(lines, follow));
    marked?.removeAttribute(HOLDING_ATTRIBUTE);
    marked = undefined;
  }

  return {
    wait(lines) {
      const list = lines[0]?.parentElement;
      if (list && list !== marked) {
        marked?.removeAttribute(HOLDING_ATTRIBUTE);
        list.setAttribute(HOLDING_ATTRIBUTE, '');
        marked = list;
      }
      const deadline = now() + MAX_WAIT_MS;
      for (const line of lines) {
        if (waiting.has(line)) continue;
        line.setAttribute(WAIT_ATTRIBUTE, '');
        waiting.set(line, { deadline, passed: false });
      }
      if (waiting.size > MAX_WAITING) release(waiting.size - MAX_WAITING);
      else arm();
    },
    pass(elements) {
      if (waiting.size === 0) return;
      const written = [...elements];
      let changed = false;
      for (const element of written) {
        const entry = lineOf(element);
        if (entry === undefined || entry.passed) continue;
        entry.passed = true;
        changed = true;
      }
      if (changed) release(0, linesOf(written));
    },
    waits: (element) => waiting.size > 0 && lineOf(element) !== undefined,
    releaseAll,
    size: () => waiting.size,
    stop() {
      releaseAll(false);
      scrolls = undefined;
    },
  };
}
