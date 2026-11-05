import { MAX_INGEST_COMMENTS, type RawComment } from '../protocol.ts';
import type { SiteAdapter } from './types.ts';

/**
 * Longest a line waits, while the chat is in front of the viewer, before it is read and sent for
 * processing. A hidden tab throttles timers, so nothing that must happen promptly waits for one:
 * leaving and coming back are handled by their events.
 */
const FLUSH_MS = 250;
/**
 * Lines to be stored (the chat is not in front, or they are off screen) are read and sent at
 * most this often; a hidden tab may run the timer later still (they are only stored).
 */
const STORE_FLUSH_MS = 1000;
/** Delay before checking whether the attached container was replaced. */
const RECHECK_MS = 100;
/**
 * Delay before checking whether a missing container appeared. The scope (Twitch's whole app)
 * may change many times a second; it is not watched again until this check.
 */
const WAIT_RECHECK_MS = 1000;
/**
 * Added elements kept until the next flush, the newest: a batch then fits one ingest message,
 * and older lines are already off screen.
 */
const MAX_PENDING = MAX_INGEST_COMMENTS;
/** Elements waiting to come near the viewport (`nearMargin`), the newest. */
const MAX_WATCHED = MAX_INGEST_COMMENTS;
const ELEMENT_NODE = 1;
/** `Node.DOCUMENT_POSITION_FOLLOWING`: the other node comes later in the page. */
const FOLLOWING = 4;

const isElement = (node: Node): node is Element => node.nodeType === ELEMENT_NODE;
/** Elements in page order. */
const inPageOrder = (elements: Element[]): Element[] =>
  elements.sort((a, b) => (a.compareDocumentPosition(b) & FOLLOWING ? -1 : 1));
/**
 * Whether the viewer sees any of a line: one only touching the edge of the visible area
 * intersects with no area. (The container is judged by `isIntersecting` alone: it has no height
 * while it holds no line, and the observer reports it again only when it leaves the viewport.)
 */
const shows = (entry: IntersectionObserverEntry): boolean =>
  entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;

/** What else the session learns from the observer (R45, R52). */
export type ObserveHooks = Readonly<{
  /** The container now watched, on start and each time it is replaced; null while missing. */
  onContainer?: (container: Element | null) => void;
  /**
   * Children the page just added while the chat is in front, in page order, before they are read
   * and sent for processing at the flush: the session may keep them out of sight until judged.
   * Never for an adapter with `nearMargin`.
   */
  onAdmit?: (lines: readonly Element[]) => void;
  /** Children `onAdmit` reported that the flush did not send: no comment in them, or read before. */
  onSkip?: (lines: readonly Element[]) => void;
}>;

/** A one-time look at which lines are on screen: the lines and those not reported yet. */
type Look = {
  observer: IntersectionObserver;
  lines: Element[];
  left: Set<Element>;
  shown: Set<Element>;
};

/**
 * Reports the comments the page shows, processed only while the chat is in front of the viewer
 * (R44): the page is visible (`visibilityState`, not a hidden tab or minimized window), shown
 * (no `pagehide`), has a viewport (an iframe resized to nothing reports no intersection) and the
 * container intersects it (`IntersectionObserver`: a chat closed, collapsed or scrolled away does
 * not). Then each added child is read and sent for processing (`process` true) in batches at most
 * `FLUSH_MS` apart and of at most `MAX_INGEST_COMMENTS`. Otherwise children are kept, then read
 * and sent for storing only (`process` false) at most `STORE_FLUSH_MS` apart. Leaving the viewer
 * calls `onLeave` at once (the service worker then stores the waiting comments only this frame
 * shows, R49), and the lines waiting for their flush are stored. Coming back, and starting in
 * front, looks once at which children are on screen: every one of them is sent for processing,
 * in page order (the service worker takes the newest first), also one processed or stored
 * before (the session shows an answered one as it is, and the service worker infers none twice),
 * and the rest is stored. An adapter with `nearMargin` (video comments) instead processes each
 * child once it comes that near the viewport while the page is in front, stores none and never
 * calls `onLeave`: it watches a bounded number, none that left the page, and looks at them all
 * again on return.
 *
 * The container gets one childList observer (no attributes, text or subtree); its ancestors get
 * shallow childList observers that notice it being replaced (YouTube's Top chat ↔ Live chat
 * switch) and move both to the new one. While the container is missing, the adapter's scope is
 * watched and checked at most once a second. `hooks` learn the container. The returned function
 * stops everything.
 */
export function observeComments(
  adapter: SiteAdapter,
  doc: Document,
  onBatch: (comments: RawComment[], process: boolean) => void,
  onLeave: () => void = () => undefined,
  { onContainer, onAdmit, onSkip }: ObserveHooks = {},
): () => void {
  const view = doc.defaultView;
  const Observer = view?.MutationObserver ?? MutationObserver;
  const Intersection = view?.IntersectionObserver ?? IntersectionObserver;
  /** Elements sent for processing: read again only by a look. */
  const processed = new WeakSet<Element>();
  /** Elements sent for storing: processed only if a look finds them on screen. */
  const stored = new WeakSet<Element>();
  let container: Element | null = null;
  /** In front: elements waiting for the flush, read then. */
  let pending: Element[] = [];
  /** Elements to be stored, read when they are sent. */
  let away: Element[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let storeTimer: ReturnType<typeof setTimeout> | undefined;
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  /** The container intersects the viewport, as last reported (assumed until then). */
  let onScreen = true;
  /** The page was hidden away (`pagehide`) and not shown again. */
  let gone = false;
  let look: Look | undefined;
  /** `nearMargin`: elements waiting to come near the viewport, oldest first. */
  const watched = new Set<Element>();
  const near =
    adapter.nearMargin === undefined
      ? undefined
      : new Intersection(onNear, { rootMargin: adapter.nearMargin });
  /** Whether the container intersects the viewport; with `nearMargin` each element is watched. */
  const sight = near === undefined ? new Intersection(onScreenChange) : undefined;

  function inFront(): boolean {
    const sized = view === null || (view.innerWidth > 0 && view.innerHeight > 0);
    return !gone && doc.visibilityState === 'visible' && sized && (sight === undefined || onScreen);
  }
  let front = inFront();

  /** Reads the lines not sent yet and marks them `into`; `skipped` gets the others. */
  function read(
    nodes: readonly Element[],
    into: WeakSet<Element>,
    skipped?: Element[],
  ): RawComment[] {
    const comments: RawComment[] = [];
    for (const node of nodes) {
      // Removed before the flush (YouTube trims old lines, Twitch replaces deleted ones).
      if (!node.isConnected || processed.has(node) || stored.has(node)) {
        skipped?.push(node);
        continue;
      }
      into.add(node);
      const comment = adapter.read(node);
      if (comment) comments.push(comment);
      else skipped?.push(node);
    }
    return comments;
  }
  function flush(): void {
    flushTimer = undefined;
    const skipped: Element[] = [];
    const comments = read(pending, processed, skipped);
    pending = [];
    if (skipped.length > 0) onSkip?.(skipped);
    if (comments.length > 0) onBatch(comments, true);
  }
  /** Reads the lines kept for storing and sends them, at most `MAX_INGEST_COMMENTS` a message. */
  function sendStored(): void {
    clearTimeout(storeTimer);
    storeTimer = undefined;
    const comments = read(away, stored);
    away = [];
    for (let start = 0; start < comments.length; start += MAX_INGEST_COMMENTS)
      onBatch(comments.slice(start, start + MAX_INGEST_COMMENTS), false);
  }
  /**
   * Keeps lines for storing. Like the flush, they are read when sent, so a line the page fills
   * in after adding it is read whole.
   */
  function keep(nodes: Iterable<Element>): void {
    for (const node of nodes) away.push(node);
    if (away.length >= MAX_PENDING) sendStored();
    else if (away.length > 0) storeTimer ??= setTimeout(sendStored, STORE_FLUSH_MS);
  }
  /** Elements to process: kept for the flush while in front, otherwise kept for storing. */
  function admit(nodes: readonly Element[]): void {
    if (!front) {
      keep(nodes);
      return;
    }
    for (const node of nodes) pending.push(node);
    if (pending.length > MAX_PENDING) pending = pending.slice(-MAX_PENDING);
    if (pending.length > 0) flushTimer ??= setTimeout(flush, FLUSH_MS);
  }
  /** `nearMargin`: watches elements until they come near the viewport, the newest at most. */
  function watch(nodes: readonly Element[]): void {
    for (const node of nodes) {
      if (processed.has(node) || watched.has(node)) continue;
      watched.add(node);
      near?.observe(node);
    }
    for (const oldest of watched) {
      if (watched.size <= MAX_WATCHED) break;
      watched.delete(oldest);
      near?.unobserve(oldest);
    }
  }
  function onNear(entries: IntersectionObserverEntry[]): void {
    // Not in front: they stay watched and are looked at again on return.
    if (!front) return;
    const close: Element[] = [];
    for (const entry of entries) {
      if (!entry.isIntersecting || !watched.delete(entry.target)) continue;
      near?.unobserve(entry.target);
      close.push(entry.target);
    }
    if (close.length > 0) admit(inPageOrder(close));
  }
  /** Children added to the container (or found in a new one). */
  function queue(nodes: Iterable<Node>): void {
    const elements: Element[] = [];
    for (const node of nodes) if (isElement(node)) elements.push(node);
    if (near) {
      watch(elements);
      return;
    }
    if (front && elements.length > 0) onAdmit?.(elements);
    admit(elements);
  }
  /** `nearMargin`: removed elements are no longer watched. */
  function forget(nodes: Iterable<Node>): void {
    for (const node of nodes) if (isElement(node) && watched.delete(node)) near?.unobserve(node);
  }
  function onItems(records: MutationRecord[]): void {
    for (const record of records) {
      if (near) forget(record.removedNodes);
      queue(record.addedNodes);
    }
  }
  const items = new Observer(onItems);
  const watcher = new Observer(() => {
    if (recheckTimer !== undefined) return;
    const waiting = container === null;
    // While waiting, stop collecting records until the check: it queries the page itself.
    if (waiting) watcher.disconnect();
    recheckTimer = setTimeout(recheck, waiting ? WAIT_RECHECK_MS : RECHECK_MS);
  });

  /** Ends the running look; returns its lines not reported on yet. */
  function endLook(): Element[] {
    const ended = look;
    look = undefined;
    if (ended === undefined) return [];
    ended.observer.disconnect();
    return ended.lines.filter((line) => ended.left.has(line));
  }
  /**
   * Looks once at which of the lines are on screen: every one of them is sent for processing, in
   * page order, and the rest is kept for storing.
   */
  function lookAt(nodes: Iterable<Element>): void {
    endLook();
    const lines = [...nodes];
    if (lines.length === 0) return;
    const observer = new Intersection(onLook);
    look = { observer, lines, left: new Set(lines), shown: new Set() };
    for (const line of lines) observer.observe(line);
  }
  function onLook(entries: IntersectionObserverEntry[], observer: IntersectionObserver): void {
    const current = look;
    // A look that ended may still report.
    if (current === undefined || current.observer !== observer) return;
    for (const entry of entries) {
      if (current.left.delete(entry.target) && shows(entry)) current.shown.add(entry.target);
    }
    if (current.left.size > 0) return;
    endLook();
    const { lines, shown } = current;
    const comments: RawComment[] = [];
    // Also lines processed or stored before (R49): one stored when the chat left is processed
    // now, an answered one is shown by the session as it is, and the service worker infers none
    // twice.
    const visible = lines.filter((line) => shown.has(line) && line.isConnected);
    for (const line of visible.slice(-MAX_INGEST_COMMENTS)) {
      processed.add(line);
      const comment = adapter.read(line);
      if (comment) comments.push(comment);
    }
    if (comments.length > 0) onBatch(comments, true);
    keep(lines.filter((line) => !shown.has(line)));
  }

  /**
   * The chat left the viewer: the service worker is told at once, and lines waiting for their
   * flush, and those a look was still deciding on, are kept for storing. With `nearMargin` they
   * are watched again instead, and leaving is not told (R50): video comments are never stored,
   * so those already with the service worker are answered as usual.
   */
  function leave(): void {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    const waiting = pending;
    pending = [];
    const undecided = endLook();
    if (near) {
      watch(waiting);
      return;
    }
    keep([...undecided, ...waiting]);
    onLeave();
  }
  /**
   * The chat came in front of the viewer: a look decides for its lines, those kept for storing
   * meanwhile included (with `nearMargin`, every watched element is looked at again).
   */
  function enter(): void {
    if (near) {
      for (const node of watched) {
        near.unobserve(node);
        near.observe(node);
      }
      return;
    }
    if (!container) {
      sendStored();
      return;
    }
    clearTimeout(storeTimer);
    storeTimer = undefined;
    away = [];
    lookAt(container.children);
  }
  /** Follows the chat into and out of the viewer's view. */
  function update(): void {
    if (stopped) return;
    const next = inFront();
    if (next === front) return;
    // Lines the page added before the change belong to the mode before it.
    onItems(items.takeRecords());
    front = next;
    if (front) enter();
    else leave();
  }
  function onScreenChange(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) if (entry.target === container) onScreen = entry.isIntersecting;
    update();
  }
  function onVisibility(): void {
    update();
  }
  function onResize(): void {
    update();
  }
  function onPageHide(): void {
    gone = true;
    update();
  }
  function onPageShow(): void {
    gone = false;
    update();
  }

  function attach(found: Element | null): void {
    items.disconnect();
    watcher.disconnect();
    sight?.disconnect();
    near?.disconnect();
    watched.clear();
    endLook();
    container = found;
    onContainer?.(container);
    if (container) {
      items.observe(container, { childList: true });
      for (let ancestor = container.parentElement; ancestor; ancestor = ancestor.parentElement)
        watcher.observe(ancestor, { childList: true });
      sight?.observe(container);
      if (near) queue(container.children);
      else if (front) lookAt(container.children);
      else keep(container.children);
      return;
    }
    const scope = adapter.scope(doc);
    if (scope) watcher.observe(scope, { childList: true, subtree: true });
    if (doc.body && !scope?.contains(doc.body)) watcher.observe(doc.body, { childList: true });
  }
  function recheck(): void {
    recheckTimer = undefined;
    if (stopped) return;
    const found = adapter.container(doc);
    // Still the same container: the observers stay as they are.
    if (found !== null && found === container && found.isConnected) return;
    // Replaced, gone, found, or still missing (the scope is watched again).
    attach(found);
  }

  doc.addEventListener('visibilitychange', onVisibility);
  view?.addEventListener('resize', onResize);
  view?.addEventListener('pagehide', onPageHide);
  view?.addEventListener('pageshow', onPageShow);
  attach(adapter.container(doc));
  return () => {
    stopped = true;
    items.disconnect();
    watcher.disconnect();
    sight?.disconnect();
    near?.disconnect();
    endLook();
    doc.removeEventListener('visibilitychange', onVisibility);
    view?.removeEventListener('resize', onResize);
    view?.removeEventListener('pagehide', onPageHide);
    view?.removeEventListener('pageshow', onPageShow);
    clearTimeout(flushTimer);
    clearTimeout(storeTimer);
    clearTimeout(recheckTimer);
    pending = [];
    away = [];
    watched.clear();
    container = null;
  };
}
