import { systemTimers, type PageToken, type Timers } from '@chrome-toolbox/extension-core';
import type { DisplayMode } from '../protocol.ts';
import type { Segment } from './segment.ts';

/**
 * The element that shows a side-by-side translation (`pair`). The name is a custom element
 * nobody defines (the isolated world has no `customElements`), which may still take a shadow
 * root.
 */
export const PAIR_TAG = 'pt-ja';
/** Nodes one slice of `setMode` or `restore` touches by default. */
const SLICE_NODES = 500;
/** Longest text `originalText` gives, in code points. */
const ORIGINAL_CHARS = 300;
/** Weak references kept before the first sweep for the ones whose node was collected. */
const SWEEP_MIN = 1024;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_FRAGMENT_NODE = 11;
const DOCUMENT_POSITION_FOLLOWING = 4;

/** A side-by-side translation: a smaller block with a line on its left (mock B's `.tr`). */
const PAIR_STYLE = `:host {
  display: block;
  margin: 2px 0 10px;
  padding-left: 8px;
  border-left: 3px solid #3a7afe;
  font-size: 0.9em;
  color: inherit;
}`;

/**
 * Where an offset in a text node goes when its text changes length: the start and the end stay
 * the start and the end, and a place in between keeps its relative position.
 */
export function mapOffset(offset: number, oldLength: number, newLength: number): number {
  if (offset <= 0) return 0;
  if (offset >= oldLength) return newLength;
  return Math.round((offset * newLength) / oldLength);
}

export type Writer = {
  /**
   * Shows the translation of `segment`, one piece per text token (`readPagePieces`), and keeps
   * the original text to put back. False, writing nothing, when the pieces do not match the
   * text tokens or the page changed one of its nodes since the scan (`originals`): the caller
   * makes the paragraph again.
   * - `replace`: each text node gets its own leading whitespace, its piece and its own trailing
   *   whitespace. When several nodes make one text token (`pieceOf`), the first gets the piece
   *   and the others only their own whitespace. An empty piece keeps the node's text, so a link
   *   never empties.
   * - `pair`: the text stays; a `<pt-ja>` box with the translation goes right after the
   *   paragraph's `last` node (never inside a link), after the boxes of the segments before it
   *   that share that node.
   * A selection whose end is in a rewritten node keeps its relative place there (`mapOffset`).
   */
  write(segment: Segment, pieces: readonly string[], mode: DisplayMode): boolean;
  /** Shows every written paragraph the other way, in slices. */
  setMode(mode: DisplayMode): void;
  /**
   * Puts the original text back in every node that still holds what this writer wrote (the page's
   * own later value stays), removes every `<pt-ja>` and forgets everything at once. With `sliced`,
   * `sliceNodes` nodes at a time: the first slice at once, the next ones after
   * `timers.set(…, 0)`; without, all of it now (`pagehide`). `done` runs after the last slice.
   */
  restore(options: Readonly<{ sliced: boolean; done?: () => void }>): void;
  /**
   * Who changed `node` last: `ours` when it holds what this writer wrote, `page` when the page
   * changed it since (its record is dropped: the page's value stays from now on), `unknown`
   * when this writer holds no record of it.
   */
  changed(node: Text): 'ours' | 'page' | 'unknown';
  /** The original text of the translated paragraphs of the block `element`, for a tooltip. */
  originalText(element: Element): string | undefined;
  /**
   * The translated paragraph holding `node`: one of its text nodes, an element inside it, or its
   * block (then the block's first translated paragraph).
   */
  segmentOf(node: Node): Segment | undefined;
  /** Translated paragraphs whose original text this writer holds. */
  size(): number;
};

/** A paragraph this writer wrote, while it holds the originals of its nodes. */
type Paragraph = {
  readonly segment: Segment;
  /** What each node of the segment holds in `replace`. */
  readonly replaced: readonly string[];
  /** What its `<pt-ja>` box shows. */
  readonly translation: string;
  mode: DisplayMode;
  box: HTMLElement | undefined;
  /** Its nodes whose record points here; at 0 the paragraph is retired. */
  held: number;
  /** Replaced by a later write, given back to the page, or restored. */
  retired: boolean;
};

/** A text node's record: its text before this writer's first write, and what it left there. */
type Entry = {
  readonly original: string;
  written: string;
  readonly paragraph: Paragraph;
  readonly ref: WeakRef<Text>;
};

/**
 * The records. Nodes are held weakly: one the page removed and dropped is collected with its
 * record, and its reference is swept on the way. A paragraph is held by its block while it is
 * on the page, and otherwise only through its nodes' records.
 */
type Records = {
  texts: WeakMap<Text, Entry>;
  refs: Set<WeakRef<Text>>;
  paragraphs: Set<WeakRef<Paragraph>>;
  byBlock: WeakMap<Element, readonly Paragraph[]>;
};

const emptyRecords = (): Records => ({
  texts: new WeakMap(),
  refs: new Set(),
  paragraphs: new Set(),
  byBlock: new WeakMap(),
});

const isElement = (node: Node): node is Element => node.nodeType === ELEMENT_NODE;
const isText = (node: Node): node is Text => node.nodeType === TEXT_NODE;
const isShadowRoot = (node: Node): node is ShadowRoot =>
  node.nodeType === DOCUMENT_FRAGMENT_NODE && 'host' in node;

const leadOf = (text: string): string => text.slice(0, text.length - text.trimStart().length);
const trailOf = (text: string): string => text.slice(text.trimEnd().length);

/** Whether `a` comes before `b` in document order. */
const precedes = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & DOCUMENT_POSITION_FOLLOWING) !== 0;
/** The node a paragraph starts from in document order. */
const startOf = (paragraph: Paragraph): Node =>
  paragraph.segment.nodes[0] ?? paragraph.segment.last;
const inOrder = (paragraphs: readonly Paragraph[]): Paragraph[] =>
  paragraphs.toSorted((a, b) => {
    if (startOf(a) === startOf(b)) return 0;
    return precedes(startOf(a), startOf(b)) ? -1 : 1;
  });

/** The node above `node`, from a shadow root's top to its host. */
function upOf(node: Node): Node | null {
  const parent = node.parentNode;
  return parent !== null && isShadowRoot(parent) ? parent.host : parent;
}

/**
 * Whether `child`, a child of the parent of the paragraph's `last`, lies in the paragraph: from
 * the child holding its first text node to `last`.
 */
function spans(segment: Segment, child: Node): boolean {
  const { last } = segment;
  const parent = last.parentNode;
  if (parent === null || child.parentNode !== parent) return false;
  if (child === last) return true;
  let first: Node | null = segment.nodes[0] ?? null;
  while (first !== null && first.parentNode !== parent) first = first.parentNode;
  if (first === null) return false;
  return child === first || (precedes(first, child) && precedes(child, last));
}

/** The words of tokens as the page shows them: texts, kept elements and spaces. */
function plainText(tokens: readonly PageToken[]): string {
  let text = '';
  for (const token of tokens) {
    if (token.t === 'text' || token.t === 'keep') text += token.text;
    else if (token.t === 'space') text += ' ';
  }
  return text;
}

/** `text`, at most `limit` code points long: a longer one is cut and ends with `…`. */
function cut(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit ? text : `${points.slice(0, limit - 1).join('')}…`;
}

type Ends = Readonly<{
  anchorNode: Node;
  anchorOffset: number;
  focusNode: Node;
  focusOffset: number;
}>;

function endsOf(selection: Selection): Ends | undefined {
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (anchorNode === null || focusNode === null) return undefined;
  return { anchorNode, anchorOffset, focusNode, focusOffset };
}

/** Sets a text node's `data` (nothing when it already holds it). */
type Setter = (node: Text, data: string) => void;

/**
 * Runs `change`, which sets text nodes' data through its setter, then puts each end of the
 * selection that was in one of those nodes back at the same relative place (`mapOffset`):
 * setting `data` moves it to the node's start. The other end stays where it is.
 */
function keepSelection(doc: Document, change: (set: Setter) => void): void {
  const selection = doc.getSelection();
  const ends = selection === null ? undefined : endsOf(selection);
  const moved = new Map<Node, Readonly<{ node: Text; length: number }>>();
  change((node, data) => {
    if (node.data === data) return;
    if (ends !== undefined && (node === ends.anchorNode || node === ends.focusNode))
      if (!moved.has(node)) moved.set(node, { node, length: node.length });
    node.data = data;
  });
  if (selection === null || ends === undefined || moved.size === 0) return;
  const now = endsOf(selection);
  if (now === undefined) return;
  const anchor = moved.get(ends.anchorNode);
  const focus = moved.get(ends.focusNode);
  selection.setBaseAndExtent(
    anchor?.node ?? now.anchorNode,
    anchor === undefined
      ? now.anchorOffset
      : mapOffset(ends.anchorOffset, anchor.length, anchor.node.length),
    focus?.node ?? now.focusNode,
    focus === undefined
      ? now.focusOffset
      : mapOffset(ends.focusOffset, focus.length, focus.node.length),
  );
}

/** One part of a sliced job: it touches some nodes through the setter and says how many. */
type Step = (set: Setter) => number;
type Job = Readonly<{ finish(): void; cancel(): void }>;

/**
 * Writes translations into a document's text nodes and takes them back out (`Writer`). It
 * changes only text nodes' `data` and its own `<pt-ja>` elements.
 */
export function createWriter(
  doc: Document,
  options: Readonly<{ timers?: Timers; sliceNodes?: number }> = {},
): Writer {
  const timers = options.timers ?? systemTimers;
  const sliceNodes = Math.max(1, options.sliceNodes ?? SLICE_NODES);
  /** Each `<pt-ja>` box's paragraph. */
  const owners = new WeakMap<Element, Paragraph>();
  let records = emptyRecords();
  let sweepAt = SWEEP_MIN;
  let restoring: Job | undefined;
  let switching: Job | undefined;

  /**
   * Runs `steps` in slices of `sliceNodes` nodes (all of them now unless `sliced`): the first
   * slice at once, each next one after `timers.set(…, 0)`, then `done`. `finish` runs the rest
   * now; `cancel` drops it, without `done`.
   */
  function startJob(steps: readonly Step[], sliced: boolean, done: () => void): Job {
    let next = 0;
    let timer: number | undefined;
    let over = false;
    const run = (budget: number): void =>
      keepSelection(doc, (set) => {
        for (let used = 0; next < steps.length && used < budget; next += 1)
          used += Math.max(1, steps[next]?.(set) ?? 0);
      });
    const end = (): void => {
      over = true;
      done();
    };
    const slice = (): void => {
      timer = undefined;
      run(sliced ? sliceNodes : Number.POSITIVE_INFINITY);
      if (next < steps.length) timer = timers.set(slice, 0);
      else end();
    };
    const stop = (): void => {
      if (timer !== undefined) timers.clear(timer);
      timer = undefined;
    };
    slice();
    return {
      finish() {
        if (over) return;
        stop();
        run(Number.POSITIVE_INFINITY);
        end();
      },
      cancel() {
        over = true;
        stop();
      },
    };
  }

  /** The paragraphs still held, sweeping the collected and retired ones on the way. */
  function live(): Paragraph[] {
    const found: Paragraph[] = [];
    for (const ref of records.paragraphs) {
      const paragraph = ref.deref();
      if (paragraph === undefined || paragraph.retired) records.paragraphs.delete(ref);
      else found.push(paragraph);
    }
    return found;
  }

  /** Sweeps the references to collected nodes once they have doubled since the last sweep. */
  function sweep(): void {
    const { refs, paragraphs } = records;
    if (refs.size + paragraphs.size < sweepAt) return;
    for (const ref of refs) if (ref.deref() === undefined) refs.delete(ref);
    live();
    sweepAt = Math.max(SWEEP_MIN, 2 * (refs.size + paragraphs.size));
  }

  function hide(paragraph: Paragraph): void {
    paragraph.box?.remove();
    paragraph.box = undefined;
  }

  /** Puts the `<pt-ja>` box of `paragraph` after its `last`, behind the boxes of the segments before it there. */
  function show(paragraph: Paragraph): void {
    const box = doc.createElement(PAIR_TAG);
    const style = doc.createElement('style');
    style.textContent = PAIR_STYLE;
    const text = doc.createElement('div');
    text.lang = 'ja';
    text.textContent = paragraph.translation;
    box.attachShadow({ mode: 'open' }).append(style, text);
    const { last } = paragraph.segment;
    let at: ChildNode = last;
    for (let next = at.nextSibling; next !== null && isElement(next); next = at.nextSibling) {
      const owner = owners.get(next);
      if (owner?.segment.last !== last || !precedes(startOf(owner), startOf(paragraph))) break;
      at = next;
    }
    at.after(box);
    owners.set(box, paragraph);
    paragraph.box = box;
  }

  /** Stops showing `paragraph`; its nodes' records stay, so `restore` still puts them back. */
  function retire(paragraph: Paragraph): void {
    if (paragraph.retired) return;
    paragraph.retired = true;
    hide(paragraph);
    const { block } = paragraph.segment;
    const others = (records.byBlock.get(block) ?? []).filter((other) => other !== paragraph);
    if (others.length > 0) records.byBlock.set(block, others);
    else records.byBlock.delete(block);
  }

  /** Forgets `node`'s record: the page's value stays. */
  function drop(node: Text, entry: Entry): void {
    records.texts.delete(node);
    records.refs.delete(entry.ref);
    entry.paragraph.held -= 1;
    if (entry.paragraph.held <= 0) retire(entry.paragraph);
  }

  /** Shows `paragraph` as `mode` says, in the nodes that still hold what this writer wrote. */
  const switchStep =
    (paragraph: Paragraph, mode: DisplayMode): Step =>
    (set) => {
      if (paragraph.retired || paragraph.mode === mode) return 1;
      const { nodes } = paragraph.segment;
      for (const [i, node] of nodes.entries()) {
        const entry = records.texts.get(node);
        if (entry?.paragraph !== paragraph) continue;
        if (node.data !== entry.written) {
          drop(node, entry);
          continue;
        }
        set(node, mode === 'replace' ? (paragraph.replaced[i] ?? entry.original) : entry.original);
        entry.written = node.data;
      }
      paragraph.mode = mode;
      if (paragraph.retired) return nodes.length;
      if (mode === 'pair') show(paragraph);
      else hide(paragraph);
      return nodes.length + 1;
    };

  /** The paragraph of `block` that holds `child` (one of its children), or its first one. */
  function paragraphAt(block: Element, child: Node | undefined): Paragraph | undefined {
    const paragraphs = inOrder(records.byBlock.get(block) ?? []);
    if (child === undefined) return paragraphs[0];
    return paragraphs.find((paragraph) => spans(paragraph.segment, child));
  }

  /**
   * What each node of `segment` held before this writer first wrote it, or `undefined` when the
   * page changed one since the scan. A node may still hold this writer's own text: the segment
   * written again, or scanned again over the translation.
   */
  function originalsOf(segment: Segment): string[] | undefined {
    const found: string[] = [];
    for (const [i, node] of segment.nodes.entries()) {
      const scanned = segment.originals[i];
      const entry = records.texts.get(node);
      const ours = entry !== undefined && node.data === entry.written;
      if (node.data !== scanned && !(ours && entry.original === scanned)) return undefined;
      found.push(ours ? entry.original : node.data);
    }
    return found;
  }

  /** What each node holds in `replace` (see `Writer.write`). */
  function replacedOf(
    segment: Segment,
    pieces: readonly string[],
    originals: readonly string[],
  ): string[] {
    const { pieceOf } = segment;
    return segment.nodes.map((_, i) => {
      const index = pieceOf[i] ?? 0;
      const piece = pieces[index] ?? '';
      const original = originals[i] ?? '';
      if (piece.trim() === '') return original;
      const scanned = segment.originals[i] ?? original;
      const first = i === 0 || pieceOf[i - 1] !== index;
      return leadOf(scanned) + (first ? piece : '') + trailOf(scanned);
    });
  }

  return {
    write(segment, pieces, mode) {
      restoring?.finish();
      const { nodes, pieceOf } = segment;
      const texts = segment.tokens.filter((token) => token.t === 'text').length;
      if (pieces.length !== texts || pieceOf.length !== nodes.length) return false;
      const originals = originalsOf(segment);
      if (originals === undefined) return false;
      const paragraph: Paragraph = {
        segment,
        replaced: replacedOf(segment, pieces, originals),
        translation: pieces.join(''),
        mode,
        box: undefined,
        held: 0,
        retired: false,
      };
      keepSelection(doc, (set) => {
        for (const [i, node] of nodes.entries())
          set(node, (mode === 'replace' ? paragraph.replaced[i] : originals[i]) ?? node.data);
      });
      // Earlier paragraphs this one takes nodes from are replaced by it.
      const replaced = new Set<Paragraph>();
      for (const [i, node] of nodes.entries()) {
        const entry = records.texts.get(node);
        if (entry !== undefined) {
          entry.paragraph.held -= 1;
          replaced.add(entry.paragraph);
        }
        const ref = entry?.ref ?? new WeakRef(node);
        records.refs.add(ref);
        records.texts.set(node, {
          original: originals[i] ?? node.data,
          written: node.data,
          paragraph,
          ref,
        });
        paragraph.held += 1;
      }
      for (const earlier of replaced) retire(earlier);
      // So are the block's paragraphs the page took away (it re-rendered them).
      const { block } = segment;
      for (const earlier of records.byBlock.get(block) ?? [])
        if (earlier.segment.nodes.every((node) => !node.isConnected)) retire(earlier);
      records.byBlock.set(block, [...(records.byBlock.get(block) ?? []), paragraph]);
      records.paragraphs.add(new WeakRef(paragraph));
      if (mode === 'pair') show(paragraph);
      sweep();
      return true;
    },

    setMode(mode) {
      restoring?.finish();
      switching?.cancel();
      const steps = live()
        .filter((paragraph) => paragraph.mode !== mode)
        .map((paragraph) => switchStep(paragraph, mode));
      switching = startJob(steps, true, () => undefined);
    },

    restore({ sliced, done }) {
      switching?.cancel();
      restoring?.finish();
      const old = records;
      const paragraphs = live();
      records = emptyRecords();
      sweepAt = SWEEP_MIN;
      const steps: Step[] = [];
      for (const paragraph of paragraphs) {
        paragraph.retired = true;
        if (paragraph.box !== undefined)
          steps.push(() => {
            hide(paragraph);
            return 1;
          });
      }
      for (const ref of old.refs)
        steps.push((set) => {
          const node = ref.deref();
          const entry = node === undefined ? undefined : old.texts.get(node);
          if (node !== undefined && entry !== undefined && node.data === entry.written)
            set(node, entry.original);
          return 1;
        });
      restoring = startJob(steps, sliced, done ?? (() => undefined));
    },

    changed(node) {
      const entry = records.texts.get(node);
      if (entry === undefined) return 'unknown';
      if (node.data === entry.written) return 'ours';
      drop(node, entry);
      return 'page';
    },

    originalText(element) {
      const paragraphs = inOrder(records.byBlock.get(element) ?? []);
      if (paragraphs.length === 0) return undefined;
      let text = '';
      let last: ChildNode | undefined;
      for (const { segment } of paragraphs) {
        // The segments one paragraph fell back to share its last node: one line.
        if (last !== undefined) text += segment.last === last ? ' ' : '\n';
        text += plainText(segment.tokens);
        last = segment.last;
      }
      return cut(text, ORIGINAL_CHARS);
    },

    segmentOf(node) {
      if (isText(node)) {
        const entry = records.texts.get(node);
        if (entry !== undefined && !entry.paragraph.retired) return entry.paragraph.segment;
      }
      let below: Node | undefined;
      for (let at: Node | null = node; at !== null; at = upOf(at)) {
        const found = isElement(at) ? paragraphAt(at, below) : undefined;
        if (found !== undefined) return found.segment;
        below = at;
      }
      return undefined;
    },

    size: () => live().length,
  };
}
