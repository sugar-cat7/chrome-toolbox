import { Err, launch, type InternalErrorCode, type Result } from '@chrome-toolbox/contracts';
import {
  createLruCache,
  systemTimers,
  type PageToken,
  type Timers,
} from '@chrome-toolbox/extension-core';
import { pageLangHint } from '../language.ts';
import type { DisplayMode, Progress, TranslateReply, TranslateRequest } from '../protocol.ts';
import { containerOf, INLINE_TAGS, scanCursor, type ScanCursor, type Segment } from './segment.ts';
import type { Writer } from './writer.ts';

/**
 * - `nearMargin`: how near the viewport a block comes before its paragraphs are asked for (half a
 *   screen above and below);
 * - `mutationFlushMs`: how long the page's changes are gathered before they are read;
 * - `retryMs`: the waits before a batch that could not be sent is sent again; `attempts` sends
 *   in all, then its paragraphs fail.
 */
export const PAGE_TIMING = {
  nearMargin: '50% 0px',
  mutationFlushMs: 300,
  retryMs: [5_000, 30_000],
  attempts: 3,
} as const;

/**
 * - `batchUnits`, `batchChars`: one batch, in units and in characters of their text;
 * - `waiting`: units waiting for a batch;
 * - `observedBlocks`: blocks the IntersectionObserver watches (the scan waits at this many);
 * - `tracked`: paragraphs holding (or about to hold) their original text; new ones past it are
 *   not translated (`limit`);
 * - `mutationRoots`: nodes gathered from the page's changes before the whole page is scanned again;
 * - `shadowRoots`: open shadow roots watched for changes;
 * - `cache`: translations kept per page (most recently used).
 */
export const PAGE_LIMITS = {
  batchUnits: 6,
  batchChars: 800,
  waiting: 400,
  observedBlocks: 5_000,
  tracked: 10_000,
  mutationRoots: 500,
  shadowRoots: 200,
  cache: 2_000,
} as const;

/** Longest a scan slice works before it yields to the page, in milliseconds. */
const SLICE_MS = 8;
/** Longest page title sent as context, in UTF-16 code units (a code point is never split). */
const TITLE_LENGTH = 200;
/** Failures of a whole batch that are sent again: the server or the background could not be reached. */
const RETRIED: ReadonlySet<InternalErrorCode> = new Set([
  'network_failed',
  'queue_full',
  'ipc_failed',
  'operation_cancelled',
]);
/** This extension's own elements: their coming and going is no change of the page. */
const OWN_TAGS: ReadonlySet<string> = new Set(['pt-ja', 'pt-overlay']);
const OBSERVE: MutationObserverInit = { childList: true, subtree: true, characterData: true };

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_FRAGMENT_NODE = 11;
const DOCUMENT_POSITION_FOLLOWING = 4;

const isElement = (node: Node): node is Element => node.nodeType === ELEMENT_NODE;
const isText = (node: Node): node is Text => node.nodeType === TEXT_NODE;
const isShadowRoot = (node: Node): node is ShadowRoot =>
  node.nodeType === DOCUMENT_FRAGMENT_NODE && 'host' in node;
const isOwn = (node: Node): boolean => isElement(node) && OWN_TAGS.has(node.localName);

/** The node above `node`, from a shadow root's top to its host. */
const above = (node: Node): Node | null => (isShadowRoot(node) ? node.host : node.parentNode);
/** Whether `node` or a node above it (through shadow roots) is in `set`. */
function insideAny(node: Node | null, set: ReadonlySet<Node>): boolean {
  for (let at = node; at !== null; at = above(at)) if (set.has(at)) return true;
  return false;
}
const inPageOrder = (elements: Element[]): Element[] =>
  elements.sort((a, b) => (a.compareDocumentPosition(b) & DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

/** Unicode code points: what the batch's character limit counts. */
function codePoints(text: string): number {
  let count = 0;
  for (const _point of text) count += 1;
  return count;
}

/** `title`, at most `TITLE_LENGTH` UTF-16 code units long, cut between code points. */
function cutTitle(title: string): string {
  let cut = '';
  for (const point of title) {
    if (cut.length + point.length > TITLE_LENGTH) break;
    cut += point;
  }
  return cut;
}

/** Where a paragraph's nodes are children: its block, or the shadow root whose host is its block. */
type Container = Element | ShadowRoot;

export type SchedulerOptions = Readonly<{
  doc: Document;
  writer: Writer;
  /** Asks the background (`page/translate`); `signal` aborts when the page leaves the viewer. */
  translate: (request: TranslateRequest, signal: AbortSignal) => Promise<Result<TranslateReply>>;
  /** How the page shows translations now. */
  mode: () => DisplayMode;
  timers?: Timers;
  now?: () => number;
  /** The progress, each time it changed after a step of the work. */
  onProgress: (progress: Progress) => void;
}>;

export type Scheduler = {
  /**
   * Starts: scans the page and watches it once it is visible (a hidden page waits for
   * `visibilitychange`). Called again while running, it clears the failures, looks again at the
   * paragraphs near the viewport and scans for what is not taken in yet (a shadow root attached
   * since, paragraphs left out at the limit), leaving what is taken in as it is.
   */
  start(): void;
  /**
   * Stops at once (a second call does nothing): the observers, the timers, the listener and the
   * cache go, and the running request is aborted. The page keeps what was written: restoring it
   * is the writer's. `start` begins again from nothing. The page script calls it on `pagehide`
   * (not on WXT's `ctx.onInvalidated`, P18), and before `writer.restore` (P27).
   */
  stop(): void;
  progress(): Progress;
};

/**
 * A paragraph found on the page: its segment, the translation of each of its units so far, and
 * where it stands (`stale`: the page changed it before its translation was written; the next
 * flush makes it again).
 */
type Paragraph = {
  readonly segment: Segment;
  readonly container: Container;
  pieces: (readonly string[] | undefined)[];
  state: 'pending' | 'done' | 'failed' | 'stale';
  dead: boolean;
  /** In the left-out list: some of its units found the waiting list full. */
  leftOut: boolean;
};

/** A block with paragraphs: whether the IntersectionObserver watches it, and how many are pending. */
type Block = { paragraphs: Paragraph[]; pending: number; observed: boolean };

/** One text to ask for, and the paragraphs that wait for it. */
type Unit = {
  readonly key: string;
  readonly tokens: readonly PageToken[];
  readonly chars: number;
  /** Its text tokens: the pieces a reply must hold. */
  readonly texts: number;
  attempts: number;
  readonly waiters: Set<Paragraph>;
};

/** The batch asked for: at most one at a time. */
type Flight = Readonly<{ units: readonly Unit[]; controller: AbortController }>;

/**
 * What to scan: `root`'s own paragraphs only (`shallow`), or its whole subtree; with `keep`, a
 * container that holds paragraphs already is left as it is (only new ones are taken in).
 */
type ScanRoot = Readonly<{ root: Container; shallow: boolean; keep: boolean }>;
/**
 * One round of scanning: a container is made again once per round, by the first job that meets
 * it; a later job of the same round skips it. A round of one job needs no record of that.
 */
type Round = Readonly<{ claimed: Map<Container, Job> | undefined }>;
type Job = ScanRoot & Readonly<{ round: Round; skip: Set<Container> }>;
type Scanning = Readonly<{ job: Job; cursor: ScanCursor }>;

/**
 * Translates a page's paragraphs as they come near the viewport, while the page is in front of
 * the viewer (R44):
 * - The page is scanned (`scanCursor`) in slices of 8 ms; each block with paragraphs to translate
 *   is watched by one IntersectionObserver (`nearMargin`). A paragraph whose translations are all
 *   in the cache is written at once.
 * - The untranslated units of a block that comes near wait in document order; a text is asked
 *   for once (`key`), and its translation fills every paragraph waiting for it.
 * - One batch at a time (`batchUnits`, `batchChars`), only while the page is visible, of units
 *   whose block is still near. A paragraph is written (`writer.write`) once all its units are
 *   translated; a block whose paragraphs are all done or failed is watched no more.
 * - Hidden: the running batch is aborted (its units wait again, no attempt counted) and nothing
 *   is scanned or sent. Visible again: every watched block is looked at again.
 * - The page's changes (one MutationObserver on the body and up to `shadowRoots` open shadow
 *   roots) are read every `mutationFlushMs`: this writer's own text and `<pt-ja>`/`<pt-overlay>`
 *   are no change; a container whose children or text changed is given back (`writer.release`)
 *   and made again; added elements are scanned; removed blocks are watched and waited for no
 *   more. Past `mutationRoots` changed nodes, the whole page is scanned again.
 * - A batch that could not be sent (`network_failed`, timed out, `queue_full`, `ipc_failed`, or
 *   aborted by the background) is sent again after `retryMs`; after `attempts` its paragraphs
 *   fail (`notice: 'unreachable'`). Any other failure, and a unit that comes back without pieces,
 *   fails its paragraphs at once.
 * - At `tracked` paragraphs no new one is taken (`limit`, cleared when removals make room); at
 *   `observedBlocks` watched blocks the scan waits until one is let go.
 */
export function createScheduler(options: SchedulerOptions): Scheduler {
  const { doc, writer, translate, mode, onProgress } = options;
  const timers = options.timers ?? systemTimers;
  const now = options.now ?? ((): number => performance.now());
  const view = doc.defaultView;

  let running = false;
  /** Scanning and watching have begun (the page was visible once since `start`). */
  let begun = false;
  let hint: string | undefined;
  let io: IntersectionObserver | undefined;
  let mo: MutationObserver | undefined;
  let lastId = 0;
  const nextId = (): number => ++lastId;

  const blocks = new Map<Element, Block>();
  /** Watched blocks near the viewport, as last reported. */
  const near = new Set<Element>();
  /** Blocks with pending paragraphs waiting for the observer to have room. */
  const unwatched = new Set<Element>();
  let watching = 0;
  const waiting = new Map<string, Unit>();
  /**
   * Pending paragraphs of near blocks some of whose units found the waiting list full, in the
   * order they came, from `leftHead`: each refill goes on where the last one stopped.
   */
  let leftOut: Paragraph[] = [];
  let leftHead = 0;
  let flight: Flight | undefined;
  const cache = createLruCache<string, readonly string[]>({ max: PAGE_LIMITS.cache });

  let jobs: Job[] = [];
  let scanning: Scanning | undefined;
  /** Open shadow roots watched for changes, and every one the scan met. */
  const shadows = new Set<ShadowRoot>();
  let met = new WeakSet<ShadowRoot>();
  /** Changes since the last flush: changed nodes, added elements, whether any was removed. */
  let touched = new Set<Node>();
  let added = new Set<Element>();
  let removed = false;
  let overflow = false;

  let scanTimer: number | undefined;
  let flushTimer: number | undefined;
  let retryTimer: number | undefined;

  /**
   * Paragraphs taken in, whatever their state. Each holds its original text in the writer once
   * written, and every one forgotten is given back first (`reset`, `sweep`), so the writer holds
   * exactly the `done` ones: this count is the only one kept, reported as `found` and `tracked`.
   */
  let tracked = 0;
  let done = 0;
  let failed = 0;
  let limit = false;
  let notice: Progress['notice'];
  let translator: Progress['translator'];
  let reported = '';

  const visible = (): boolean => doc.visibilityState === 'visible';
  const blockOf = (container: Container): Element =>
    isShadowRoot(container) ? container.host : container;
  /** The container of a segment's nodes: the shadow root its `last` is in, or its block. */
  function containerOfSegment(segment: Segment): Container {
    const parent = segment.last.parentNode;
    return parent !== null && isShadowRoot(parent) ? parent : segment.block;
  }

  function progress(): Progress {
    return {
      state: running ? 'on' : 'idle',
      mode: mode(),
      found: tracked,
      done,
      waiting: waiting.size + (flight?.units.length ?? 0),
      failed,
      tracked,
      cached: cache.size(),
      limit,
      ...(notice === undefined ? {} : { notice }),
      ...(translator === undefined ? {} : { translator }),
    };
  }
  function emit(): void {
    if (!running) return;
    const next = progress();
    const key = JSON.stringify(next);
    if (key === reported) return;
    reported = key;
    onProgress(next);
  }

  // --- Watching blocks -------------------------------------------------------------------------

  function watch(block: Element, entry: Block): void {
    if (entry.observed || io === undefined) return;
    if (watching >= PAGE_LIMITS.observedBlocks) {
      unwatched.add(block);
      return;
    }
    unwatched.delete(block);
    io.observe(block);
    entry.observed = true;
    watching += 1;
  }

  /** Watches `block` no more; the room goes to a block waiting for it, then to the scan. */
  function unwatch(block: Element, entry: Block): void {
    unwatched.delete(block);
    near.delete(block);
    if (!entry.observed) return;
    io?.unobserve(block);
    entry.observed = false;
    watching -= 1;
    for (const next of unwatched) {
      if (watching >= PAGE_LIMITS.observedBlocks) break;
      unwatched.delete(next);
      const other = blocks.get(next);
      if (other !== undefined && other.pending > 0 && next.isConnected) watch(next, other);
    }
    kickScan();
  }

  /** A block with no pending paragraph is watched no more; one with no paragraph is forgotten. */
  function settle(block: Element, entry: Block): void {
    if (entry.pending > 0) return;
    unwatch(block, entry);
    if (entry.paragraphs.length === 0) blocks.delete(block);
  }

  /** Looks again at every watched block: the observer reports each anew. */
  function relook(): void {
    near.clear();
    if (io === undefined) return;
    for (const [block, entry] of blocks) {
      if (!entry.observed) continue;
      io.unobserve(block);
      io.observe(block);
    }
  }

  // --- Paragraphs --------------------------------------------------------------------------------

  /** Takes `paragraph` out of the units waiting for a batch. */
  function unqueue(paragraph: Paragraph): void {
    for (const unit of paragraph.segment.units) {
      const queued = waiting.get(unit.key);
      if (queued === undefined) continue;
      queued.waiters.delete(paragraph);
      if (queued.waiters.size === 0) waiting.delete(unit.key);
    }
  }

  function leavePending(paragraph: Paragraph, state: 'done' | 'failed' | 'stale'): void {
    paragraph.state = state;
    if (state === 'done') done += 1;
    else if (state === 'failed') failed += 1;
    unqueue(paragraph);
    const { block } = paragraph.segment;
    const entry = blocks.get(block);
    if (entry === undefined) return;
    entry.pending -= 1;
    settle(block, entry);
  }

  /** Forgets `paragraph` (its block's records are the caller's). */
  function kill(paragraph: Paragraph): void {
    paragraph.dead = true;
    tracked -= 1;
    if (paragraph.state === 'done') done -= 1;
    else if (paragraph.state === 'failed') failed -= 1;
    unqueue(paragraph);
  }

  /** Writes `paragraph` once every unit is translated (a split paragraph's units joined). */
  function complete(paragraph: Paragraph): void {
    const { segment } = paragraph;
    const pieces =
      segment.units.length === 1
        ? paragraph.pieces[0]
        : [paragraph.pieces.map((piece) => piece?.[0] ?? '').join('')];
    if (pieces === undefined) return;
    if (writer.write(segment, pieces, mode())) {
      leavePending(paragraph, 'done');
      return;
    }
    // The page changed one of its nodes since the scan: the next flush makes it again.
    leavePending(paragraph, 'stale');
    note(paragraph.container);
  }

  /** Fills `paragraph`'s units of `key`, and writes it when that was the last. */
  function fill(paragraph: Paragraph, key: string, pieces: readonly string[]): void {
    if (paragraph.dead || paragraph.state !== 'pending') return;
    for (const [i, unit] of paragraph.segment.units.entries())
      if (unit.key === key && paragraph.pieces[i] === undefined) paragraph.pieces[i] = pieces;
    if (paragraph.pieces.every((piece) => piece !== undefined)) complete(paragraph);
  }

  /**
   * Puts `paragraph`'s untranslated units in the waiting list (the cache first). False when the
   * list was full for one of them: the paragraph is then in the left-out list.
   */
  function enqueue(paragraph: Paragraph): boolean {
    if (paragraph.dead || paragraph.state !== 'pending') return true;
    let full = false;
    for (const [i, unit] of paragraph.segment.units.entries()) {
      if (paragraph.pieces[i] !== undefined) continue;
      const cached = cache.get(unit.key);
      if (cached !== undefined) {
        paragraph.pieces[i] = cached;
        continue;
      }
      const asked = flight?.units.find((sent) => sent.key === unit.key) ?? waiting.get(unit.key);
      if (asked !== undefined) {
        asked.waiters.add(paragraph);
        continue;
      }
      if (waiting.size >= PAGE_LIMITS.waiting) {
        full = true;
        continue;
      }
      let chars = 0;
      let texts = 0;
      for (const token of unit.tokens)
        if (token.t === 'text') {
          chars += codePoints(token.text);
          texts += 1;
        }
      waiting.set(unit.key, {
        key: unit.key,
        tokens: unit.tokens,
        chars,
        texts,
        attempts: 0,
        waiters: new Set([paragraph]),
      });
    }
    if (full) {
      if (!paragraph.leftOut) {
        paragraph.leftOut = true;
        leftOut.push(paragraph);
      }
      return false;
    }
    if (paragraph.pieces.every((piece) => piece !== undefined)) complete(paragraph);
    return true;
  }

  /** Takes `segment` in, unless its container is another job's this round or the limit is met. */
  function register(segment: Segment, job: Job): void {
    const container = containerOfSegment(segment);
    if (job.skip.has(container)) return;
    if (tracked >= PAGE_LIMITS.tracked) {
      limit = true;
      return;
    }
    const { block } = segment;
    let entry = blocks.get(block);
    if (entry === undefined) {
      entry = { paragraphs: [], pending: 0, observed: false };
      blocks.set(block, entry);
    }
    const paragraph: Paragraph = {
      segment,
      container,
      pieces: segment.units.map(() => undefined),
      state: 'pending',
      dead: false,
      leftOut: false,
    };
    entry.paragraphs.push(paragraph);
    entry.pending += 1;
    tracked += 1;
    // A text translated before (a copy, a block the page drew again) is written at once.
    let all = true;
    for (const [i, unit] of segment.units.entries()) {
      const cached = cache.get(unit.key);
      if (cached === undefined) all = false;
      else paragraph.pieces[i] = cached;
    }
    if (all) {
      complete(paragraph);
      return;
    }
    watch(block, entry);
    if (near.has(block)) enqueue(paragraph);
  }

  /**
   * Gives `container`'s paragraphs back to the page (the writer puts their original text back)
   * and forgets them, before it is read again.
   */
  function reset(container: Container): void {
    const block = blockOf(container);
    const entry = blocks.get(block);
    if (entry !== undefined) {
      const kept: Paragraph[] = [];
      for (const paragraph of entry.paragraphs) {
        if (paragraph.container !== container) {
          kept.push(paragraph);
          continue;
        }
        if (paragraph.state === 'pending') entry.pending -= 1;
        kill(paragraph);
      }
      entry.paragraphs = kept;
      settle(block, entry);
    }
    writer.release(container);
  }

  /** Forgets the blocks the page removed, giving their nodes back. */
  function sweep(): void {
    for (const [block, entry] of blocks) {
      if (block.isConnected) continue;
      const containers = new Set<Container>();
      for (const paragraph of entry.paragraphs) {
        kill(paragraph);
        containers.add(paragraph.container);
      }
      entry.paragraphs = [];
      entry.pending = 0;
      unwatch(block, entry);
      blocks.delete(block);
      for (const container of containers) writer.release(container);
    }
    for (const block of unwatched) if (!block.isConnected) unwatched.delete(block);
    // Room again: paragraphs the page adds from now on are taken in (those left out before wait
    // for a new start, which scans for them).
    limit = tracked >= PAGE_LIMITS.tracked;
  }

  // --- Batches -----------------------------------------------------------------------------------

  /** Whether a paragraph waiting for `unit` is still pending and near the viewport. */
  function wanted(unit: Unit): boolean {
    for (const paragraph of unit.waiters)
      if (!paragraph.dead && paragraph.state === 'pending' && near.has(paragraph.segment.block))
        return true;
    return false;
  }

  /**
   * Puts the left-out paragraphs in the waiting list while it has room, from where the last
   * refill stopped. One no longer pending or near leaves the list: its block coming near again
   * enqueues it again.
   */
  function refill(): void {
    while (waiting.size < PAGE_LIMITS.waiting) {
      const paragraph = leftOut[leftHead];
      if (paragraph === undefined) break;
      const wait =
        !paragraph.dead && paragraph.state === 'pending' && near.has(paragraph.segment.block);
      if (wait && !enqueue(paragraph)) break;
      paragraph.leftOut = false;
      leftHead += 1;
    }
    if (leftHead >= leftOut.length) {
      leftOut = [];
      leftHead = 0;
    } else if (leftHead > PAGE_LIMITS.waiting && 2 * leftHead > leftOut.length) {
      leftOut = leftOut.slice(leftHead);
      leftHead = 0;
    }
  }

  /** Puts `units` back at the head of the waiting list. */
  function requeue(units: readonly Unit[]): void {
    if (units.length === 0) return;
    const rest = [...waiting];
    waiting.clear();
    for (const unit of units) waiting.set(unit.key, unit);
    for (const [key, unit] of rest) if (!waiting.has(key)) waiting.set(key, unit);
  }

  const pageOf = (): TranslateRequest['page'] => ({
    title: cutTitle(doc.title),
    site: view?.location.hostname ?? '',
  });

  /** Sends the next batch when none is out, the page is visible and no retry is waited for. */
  function pump(): void {
    if (!running || !begun || !visible() || flight !== undefined || retryTimer !== undefined)
      return;
    if (waiting.size < PAGE_LIMITS.waiting) refill();
    const units: Unit[] = [];
    let chars = 0;
    for (const [key, unit] of waiting) {
      if (!wanted(unit)) {
        waiting.delete(key);
        continue;
      }
      if (units.length >= PAGE_LIMITS.batchUnits || chars + unit.chars > PAGE_LIMITS.batchChars)
        break;
      units.push(unit);
      chars += unit.chars;
    }
    if (units.length === 0) return;
    for (const unit of units) waiting.delete(unit.key);
    const sent: Flight = { units, controller: new AbortController() };
    flight = sent;
    const request: TranslateRequest = {
      purpose: 'page',
      units: units.map((unit, i) => ({ id: i + 1, tokens: [...unit.tokens] })),
      page: pageOf(),
    };
    launch(
      async () => {
        onReply(sent, await translate(request, sent.controller.signal));
      },
      (error) => onReply(sent, Err(error)),
    );
  }

  /** Fails the paragraphs waiting for `unit`. */
  function failUnit(unit: Unit): void {
    for (const paragraph of unit.waiters)
      if (!paragraph.dead && paragraph.state === 'pending') leavePending(paragraph, 'failed');
  }

  function answered(sent: Flight, reply: TranslateReply): void {
    notice = reply.notice;
    translator = reply.translator;
    const pieces = new Map(reply.results.map((result) => [result.id, result.pieces]));
    for (const [i, unit] of sent.units.entries()) {
      const translated = pieces.get(i + 1);
      // A unit the background could not read back fails alone (P21); failures are not cached.
      if (translated === undefined || translated.length !== unit.texts) {
        failUnit(unit);
        continue;
      }
      cache.set(unit.key, translated);
      for (const paragraph of unit.waiters) fill(paragraph, unit.key, translated);
    }
  }

  /** Counts an attempt for each unit of a batch that could not be sent; waits, or fails them. */
  function retry(sent: Flight): void {
    const back: Unit[] = [];
    let most = 0;
    for (const unit of sent.units) {
      unit.attempts += 1;
      if (unit.attempts >= PAGE_TIMING.attempts) {
        failUnit(unit);
        notice = 'unreachable';
        continue;
      }
      most = Math.max(most, unit.attempts);
      back.push(unit);
    }
    requeue(back);
    if (back.length === 0) return;
    const { retryMs } = PAGE_TIMING;
    retryTimer = timers.set(onRetry, retryMs[Math.min(most, retryMs.length) - 1] ?? retryMs[0]);
  }

  function onReply(sent: Flight, result: Result<TranslateReply>): void {
    // Aborted (hidden, stopped): its units already wait again or are gone.
    if (sent !== flight) return;
    act(() => {
      flight = undefined;
      if (result.ok) answered(sent, result.value);
      else if (RETRIED.has(result.error.internalCode)) retry(sent);
      else for (const unit of sent.units) failUnit(unit);
    });
  }

  function onRetry(): void {
    retryTimer = undefined;
    act(() => undefined);
  }

  // --- Scanning ----------------------------------------------------------------------------------

  const canScan = (): boolean =>
    running && begun && visible() && watching < PAGE_LIMITS.observedBlocks;

  function kickScan(): void {
    if (scanTimer !== undefined || !canScan()) return;
    if (scanning === undefined && jobs.length === 0) return;
    scanTimer = timers.set(scanStep, 0);
  }

  /** Whether paragraphs of `container` are taken in. */
  function holds(container: Container): boolean {
    const entry = blocks.get(blockOf(container));
    return entry?.paragraphs.some((paragraph) => paragraph.container === container) ?? false;
  }

  /**
   * Makes `container` again in `job`'s round (`reset`), unless an earlier job of the round did, or
   * the job keeps the containers that hold paragraphs: then the job skips its segments.
   */
  function claim(job: Job, container: Container): void {
    const { claimed } = job.round;
    const owner = claimed?.get(container);
    if (owner === job) return;
    if (owner !== undefined || (job.keep && holds(container))) {
      job.skip.add(container);
      return;
    }
    claimed?.set(container, job);
    reset(container);
  }

  /** An open shadow root met: watched for changes, up to `shadowRoots` of them. */
  function onShadowRoot(shadow: ShadowRoot): void {
    met.add(shadow);
    if (mo === undefined || shadows.has(shadow) || shadows.size >= PAGE_LIMITS.shadowRoots) return;
    shadows.add(shadow);
    mo.observe(shadow, OBSERVE);
  }

  function nextScan(): Scanning | undefined {
    for (let job = jobs.shift(); job !== undefined; job = jobs.shift()) {
      if (!job.root.isConnected) continue;
      const current = job;
      // A shallow job reads its root only: it is made again here, also when it reads nothing
      // now (skipped, or no block any more). A deep job makes each container it meets again.
      if (current.shallow) claim(current, current.root);
      const cursor = scanCursor({
        root: current.root,
        hint,
        nextId,
        shallow: current.shallow,
        onShadowRoot,
        ...(current.shallow ? {} : { onContainer: (container) => claim(current, container) }),
      });
      return { job: current, cursor };
    }
    return undefined;
  }

  /** One slice of scanning: at most `SLICE_MS`, then the next after `timers.set(…, 0)`. */
  function scanStep(): void {
    scanTimer = undefined;
    if (!canScan()) return;
    act(() => {
      const started = now();
      const out: Segment[] = [];
      while (canScan()) {
        const current = scanning ?? nextScan();
        if (current === undefined) break;
        scanning = current;
        const more = current.cursor.step(out);
        for (const segment of out) register(segment, current.job);
        out.length = 0;
        if (!more) scanning = undefined;
        if (now() - started >= SLICE_MS) break;
      }
    });
    kickScan();
  }

  /** Scans `roots` in one new round. */
  function queue(roots: readonly ScanRoot[]): void {
    const round: Round = { claimed: roots.length > 1 ? new Map() : undefined };
    for (const root of roots) jobs.push({ ...root, round, skip: new Set() });
    if (jobs.length > PAGE_LIMITS.mutationRoots) {
      sweep();
      rescanAll();
      return;
    }
    kickScan();
  }

  /**
   * Scans the whole body again, every container made again, watching it (and the shadow roots it
   * meets) afresh.
   */
  function rescanAll(): void {
    const root = doc.body ?? doc.documentElement;
    // Every paragraph is taken in again: one left out at `tracked` sets the flag again.
    limit = false;
    jobs = [];
    scanning = undefined;
    shadows.clear();
    met = new WeakSet();
    if (mo !== undefined) {
      mo.disconnect();
      mo.observe(root, OBSERVE);
    }
    queue([{ root, shallow: false, keep: false }]);
  }

  // --- The page's changes ------------------------------------------------------------------------

  function armFlush(): void {
    if (flushTimer === undefined && begun && visible())
      flushTimer = timers.set(flush, PAGE_TIMING.mutationFlushMs);
  }

  function gathered(): void {
    if (touched.size + added.size > PAGE_LIMITS.mutationRoots) {
      overflow = true;
      touched = new Set();
      added = new Set();
    }
    armFlush();
  }

  function note(node: Node): void {
    if (!overflow) touched.add(node);
    gathered();
  }

  /** Gathers the page's changes until the flush; this script's own are no change. */
  function absorb(records: readonly MutationRecord[]): void {
    for (const record of records) {
      const { target } = record;
      if (record.type === 'characterData') {
        if (isText(target) && writer.changed(target) !== 'ours') note(target);
        continue;
      }
      let changed = false;
      for (const node of record.addedNodes) {
        if (isOwn(node)) continue;
        changed = true;
        if (isElement(node) && !overflow) added.add(node);
      }
      for (const node of record.removedNodes) {
        if (isOwn(node)) continue;
        changed = true;
        removed = true;
      }
      if (changed) note(target);
    }
  }

  function onMutations(records: MutationRecord[]): void {
    if (running) absorb(records);
  }

  /** The scans the gathered changes need: each changed container alone, and added subtrees. */
  function jobsOf(targets: ReadonlySet<Node>, roots: ReadonlySet<Element>): ScanRoot[] {
    // An element added inside another added one is scanned with it.
    const tops = new Set(
      [...roots].filter((root) => root.isConnected && !insideAny(above(root), roots)),
    );
    const containers = new Set<Container>();
    /** Open shadow roots attached since the scan, found when their host's children changed. */
    const late = new Set<ShadowRoot>();
    for (const target of targets) {
      if (!target.isConnected) continue;
      const container = containerOf(target);
      if (container !== undefined) containers.add(container);
      const shadow = isElement(target) ? target.shadowRoot : null;
      if (shadow !== null && !met.has(shadow)) late.add(shadow);
      // An inline element whose children changed may have become a block or stopped being one:
      // its own paragraphs and those around it are made again.
      if (isElement(target) && INLINE_TAGS.has(target.localName)) {
        containers.add(target);
        const parent = target.parentNode;
        const around = parent === null ? undefined : containerOf(parent);
        if (around !== undefined) containers.add(around);
      }
    }
    const list: ScanRoot[] = [];
    for (const container of containers)
      if (!insideAny(container, tops)) list.push({ root: container, shallow: true, keep: false });
    for (const root of tops) list.push({ root, shallow: false, keep: false });
    for (const shadow of late) {
      if (insideAny(shadow, tops)) continue;
      onShadowRoot(shadow);
      list.push({ root: shadow, shallow: false, keep: false });
    }
    return list;
  }

  /** Reads the changes gathered since the last flush. */
  function flush(): void {
    // Records not delivered yet belong to this flush (the timer is still set: none is armed).
    if (running && mo !== undefined) absorb(mo.takeRecords());
    flushTimer = undefined;
    if (!running || !begun || !visible()) return;
    act(() => {
      const targets = touched;
      const roots = added;
      const swept = removed;
      const full = overflow;
      touched = new Set();
      added = new Set();
      removed = false;
      overflow = false;
      if (full) {
        sweep();
        rescanAll();
        return;
      }
      if (swept) sweep();
      queue(jobsOf(targets, roots));
    });
  }

  /**
   * Runs `fn` (which may change the page's text), then sends the next batch and reports the
   * progress. The page's changes recorded before are gathered first; this script's own, recorded
   * during `fn`, are dropped.
   */
  function act(fn: () => void): void {
    if (!running) return;
    if (mo !== undefined) absorb(mo.takeRecords());
    fn();
    pump();
    mo?.takeRecords();
    emit();
  }

  // --- Visibility ----------------------------------------------------------------------------------

  function begin(): void {
    begun = true;
    hint = pageLangHint(doc);
    const Intersection = view?.IntersectionObserver ?? IntersectionObserver;
    io = new Intersection(onNear, { rootMargin: PAGE_TIMING.nearMargin });
    const Mutation = view?.MutationObserver ?? MutationObserver;
    mo = new Mutation(onMutations);
    rescanAll();
    emit();
  }

  function onNear(entries: IntersectionObserverEntry[]): void {
    if (!running || !begun || !visible()) return;
    act(() => {
      const came: Element[] = [];
      for (const { target, isIntersecting } of entries) {
        const entry = blocks.get(target);
        if (entry === undefined || !entry.observed) continue;
        if (isIntersecting) {
          if (near.has(target)) continue;
          near.add(target);
          came.push(target);
        } else if (near.delete(target))
          for (const paragraph of entry.paragraphs) unqueue(paragraph);
      }
      for (const block of inPageOrder(came))
        for (const paragraph of blocks.get(block)?.paragraphs ?? []) enqueue(paragraph);
    });
  }

  /** The page left the viewer: the batch is aborted (its units wait again) and the work pauses. */
  function hide(): void {
    const sent = flight;
    flight = undefined;
    if (sent !== undefined) {
      sent.controller.abort();
      requeue(sent.units);
    }
    if (scanTimer !== undefined) timers.clear(scanTimer);
    if (flushTimer !== undefined) timers.clear(flushTimer);
    scanTimer = undefined;
    flushTimer = undefined;
  }

  function onVisibility(): void {
    if (!running) return;
    if (!visible()) {
      hide();
      emit();
      return;
    }
    if (!begun) {
      begin();
      return;
    }
    act(() => {
      relook();
      if (touched.size > 0 || added.size > 0 || overflow) armFlush();
      kickScan();
    });
  }

  return {
    start() {
      if (!running) {
        running = true;
        doc.addEventListener('visibilitychange', onVisibility);
        if (visible()) begin();
        else emit();
        return;
      }
      if (!begun) return;
      act(() => {
        for (const [block, entry] of blocks) {
          let again = false;
          for (const paragraph of entry.paragraphs) {
            if (paragraph.dead || paragraph.state !== 'failed') continue;
            paragraph.state = 'pending';
            paragraph.pieces = paragraph.segment.units.map(() => undefined);
            failed -= 1;
            entry.pending += 1;
            again = true;
          }
          if (again) watch(block, entry);
        }
        if (notice === 'unreachable') notice = undefined;
        if (retryTimer !== undefined) timers.clear(retryTimer);
        retryTimer = undefined;
        for (const unit of waiting.values()) unit.attempts = 0;
        relook();
        // What the page added out of the observers' sight (a shadow root attached since) is taken
        // in; what is taken in already stays as it is.
        queue([{ root: doc.body ?? doc.documentElement, shallow: false, keep: true }]);
      });
    },

    stop() {
      if (!running) return;
      running = false;
      begun = false;
      doc.removeEventListener('visibilitychange', onVisibility);
      io?.disconnect();
      mo?.disconnect();
      io = undefined;
      mo = undefined;
      for (const timer of [scanTimer, flushTimer, retryTimer])
        if (timer !== undefined) timers.clear(timer);
      scanTimer = undefined;
      flushTimer = undefined;
      retryTimer = undefined;
      const sent = flight;
      flight = undefined;
      sent?.controller.abort();
      blocks.clear();
      near.clear();
      unwatched.clear();
      waiting.clear();
      jobs = [];
      scanning = undefined;
      shadows.clear();
      met = new WeakSet();
      cache.clear();
      touched = new Set();
      added = new Set();
      removed = false;
      overflow = false;
      leftOut = [];
      leftHead = 0;
      watching = 0;
      done = 0;
      failed = 0;
      tracked = 0;
      limit = false;
      notice = undefined;
      translator = undefined;
      reported = '';
    },

    progress,
  };
}
