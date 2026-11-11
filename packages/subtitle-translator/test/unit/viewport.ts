import { vi } from 'vitest';

const rect = (width: number, height: number): DOMRectReadOnly => ({
  x: 0,
  y: 0,
  width,
  height,
  top: 0,
  left: 0,
  right: width,
  bottom: height,
  toJSON: () => ({ width, height }),
});

/**
 * `IntersectionObserver`, which jsdom lacks, as a global the test drives: `report(target, area)`
 * tells every observer of `target` how much of it is on screen. Undo with `vi.unstubAllGlobals()`.
 */
export function fakeViewport() {
  const observers = new Set<FakeObserver>();
  class FakeObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly scrollMargin = '0px';
    readonly thresholds = [0];
    readonly targets = new Set<Element>();
    constructor(private readonly callback: IntersectionObserverCallback) {
      observers.add(this);
    }
    observe(target: Element): void {
      this.targets.add(target);
    }
    unobserve(target: Element): void {
      this.targets.delete(target);
    }
    disconnect(): void {
      this.targets.clear();
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
    report(entry: IntersectionObserverEntry): void {
      if (this.targets.has(entry.target)) this.callback([entry], this);
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  return {
    /**
     * Reports the part of `target` on screen. A zero area with `isIntersecting` is an element that
     * only touches the edge of the screen.
     */
    report(
      target: Element,
      {
        width,
        height,
        isIntersecting = width * height > 0,
      }: Readonly<{
        width: number;
        height: number;
        isIntersecting?: boolean;
      }>,
    ): void {
      const entry: IntersectionObserverEntry = {
        target,
        time: 0,
        isIntersecting,
        intersectionRatio: width * height > 0 ? 1 : 0,
        intersectionRect: rect(width, height),
        boundingClientRect: rect(1280, 720),
        rootBounds: rect(1280, 800),
      };
      for (const observer of observers) observer.report(entry);
    },
    /** How many elements are observed, over every observer. */
    observed: () => [...observers].reduce((count, observer) => count + observer.targets.size, 0),
  };
}
