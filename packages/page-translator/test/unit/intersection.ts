// IntersectionObserver and page visibility for jsdom, which has neither layout nor an observer:
// the test says what is on screen and whether the page is visible.
import { vi } from 'vitest';

/**
 * Whether `element` is on screen for an observer with this `rootMargin`: `'edge'` intersects with
 * no area (an element of no height, or one touching the edge of the visible area).
 */
export type OnScreen = (element: Element, rootMargin: string) => boolean | 'edge';

export type FakeObserver = Readonly<{
  rootMargin: string;
  /** The elements it observes now. */
  targets: () => Element[];
}>;

export type FakeIntersection = Readonly<{
  /** Every observer made so far, with what it observes now. */
  observers: readonly FakeObserver[];
  /** Decides what is on screen from now on (everything at first); `update` reports it. */
  setOnScreen: (onScreen: OnScreen) => void;
  /** Reports every observed element whose state changed, or that was never reported, at once. */
  update: () => void;
}>;

/**
 * Installs an IntersectionObserver that behaves like the browser's at its edges: an element is
 * reported first at the next update after `observe` (a zero-delay timer, so fake timers drive
 * it), then only when it comes on or goes off screen. `vi.unstubAllGlobals` removes it.
 */
export function installIntersection(): FakeIntersection {
  const observers: (FakeObserver & { deliver: () => void })[] = [];
  let onScreen: OnScreen = () => true;
  let scheduled = false;
  function update(): void {
    scheduled = false;
    for (const observer of [...observers]) observer.deliver();
  }
  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    setTimeout(update, 0);
  }
  const entryOf = (target: Element, state: boolean | 'edge'): IntersectionObserverEntry => {
    const size = state === true ? 10 : 0;
    return {
      target,
      isIntersecting: state !== false,
      intersectionRatio: state === false ? 0 : 1,
      intersectionRect: new DOMRectReadOnly(0, 0, size, size),
      boundingClientRect: new DOMRectReadOnly(0, 0, 10, 10),
      rootBounds: null,
      time: performance.now(),
    };
  };
  class Observer implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin: string;
    readonly scrollMargin = '0px';
    readonly thresholds = [0];
    /** Each observed element and what was last reported for it (nothing yet: undefined). */
    readonly #reported = new Map<Element, boolean | 'edge' | undefined>();
    readonly #callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit = {}) {
      this.#callback = callback;
      this.rootMargin = options.rootMargin ?? '0px';
      const reported = this.#reported;
      const deliver = (): void => {
        const entries: IntersectionObserverEntry[] = [];
        for (const [target, last] of reported) {
          const shown = onScreen(target, this.rootMargin);
          if (shown === last) continue;
          reported.set(target, shown);
          entries.push(entryOf(target, shown));
        }
        if (entries.length > 0) this.#callback(entries, this);
      };
      observers.push({ rootMargin: this.rootMargin, targets: () => [...reported.keys()], deliver });
    }
    observe(target: Element): void {
      if (!this.#reported.has(target)) this.#reported.set(target, undefined);
      schedule();
    }
    unobserve(target: Element): void {
      this.#reported.delete(target);
    }
    disconnect(): void {
      this.#reported.clear();
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', Observer);
  return {
    observers,
    setOnScreen: (next) => {
      onScreen = next;
    },
    update,
  };
}

/** Undoes the property overrides below, newest first. */
const restorers: (() => void)[] = [];
function override(target: object, key: string, descriptor: PropertyDescriptor): void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restorers.push(() => {
    if (own) Object.defineProperty(target, key, own);
    else Reflect.deleteProperty(target, key);
  });
}
/** Gives the document and the window back their own visibility and viewport. */
export function restorePage(): void {
  for (let restore = restorers.pop(); restore; restore = restorers.pop()) restore();
}

/**
 * Sets `document.visibilityState` (and `hidden`) and fires `visibilitychange`, as switching tabs
 * or minimizing the window does. `restorePage` undoes it.
 */
export function setVisibility(doc: Document, state: DocumentVisibilityState): void {
  override(doc, 'visibilityState', { get: () => state });
  override(doc, 'hidden', { get: () => state === 'hidden' });
  doc.dispatchEvent(new Event('visibilitychange'));
}

/**
 * Gives the window a viewport of this size and fires `resize` (an iframe resized to nothing).
 * `restorePage` undoes it.
 */
export function setViewport(view: Window, width: number, height: number): void {
  override(view, 'innerWidth', { value: width });
  override(view, 'innerHeight', { value: height });
  view.dispatchEvent(new Event('resize'));
}
