import {
  PAGE_UNIT_CHARS,
  pageTokensValid,
  type PageToken,
  type Timers,
} from '@chrome-toolbox/extension-core';
import { needsPageTranslation } from '../language.ts';

/** One request item: `key` (`JSON.stringify(tokens)`) dedupes and caches it. */
export type RequestUnit = Readonly<{ key: string; tokens: readonly PageToken[] }>;

/**
 * A paragraph to translate: the text and inline elements of `block` between two of its
 * boundaries (a block element, `<br>` or an editable element).
 * - `tokens` are its text tokens, markers and spaces in document order.
 * - `nodes` are the text nodes it rewrites, in document order, with their `data` at the scan in
 *   `originals`. Text nodes of only whitespace are never rewritten, so they are not here.
 * - `nodes[i]` belongs to the text token `pieceOf[i]` (0-based among the `text` tokens, as
 *   `readPagePieces` returns their translations). Text nodes with no marker between them (an
 *   `<img>`, a `<wbr>`, a comment or a framework's adjacent text nodes) make one text token, so
 *   one index can hold several nodes: its translation goes into the first of them, and each
 *   later one is written only its own leading and trailing whitespace (P23).
 * - `last` is the paragraph's last node among the children of its parent (`block`, or the shadow
 *   root whose host is `block`), whatever it is: a text node, a link, a `<code>`, an `<img>` or
 *   an inline element without words. A side-by-side translation goes right after it. The
 *   segments a paragraph falls back to share it.
 * - `units` is normally `[tokens]`. A text-only paragraph longer than `PAGE_UNIT_CHARS` is sent
 *   as text-only units cut at sentence ends; their translations are joined back into one.
 */
export type Segment = Readonly<{
  id: number;
  block: Element;
  nodes: readonly Text[];
  originals: readonly string[];
  pieceOf: readonly number[];
  last: ChildNode;
  tokens: readonly PageToken[];
  units: readonly RequestUnit[];
}>;

/** Elements that stay inside a paragraph, as markers around their words (decided by tag). */
export const INLINE_TAGS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'big',
  'cite',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'ins',
  'label',
  'mark',
  'q',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
]);
/** Elements a paragraph keeps as they are, in place (`<kN/>`). */
const KEEP_TAGS: ReadonlySet<string> = new Set(['code', 'kbd', 'samp', 'var', 'tt']);
/** This extension's own elements: the side-by-side translation and the overlay. */
const OWN_TAGS: ReadonlySet<string> = new Set(['pt-ja', 'pt-overlay']);
/**
 * Elements a paragraph steps over: images and the word break (no words), inline icons, the
 * elements a page never shows, and this extension's own. The text on both sides of one stays
 * one text token.
 */
const IGNORED_TAGS: ReadonlySet<string> = new Set([
  'img',
  'picture',
  'wbr',
  'svg',
  'script',
  'style',
  'noscript',
  'template',
  ...OWN_TAGS,
]);
/** Elements whose whole subtree is never translated. */
const SKIPPED_TAGS: ReadonlySet<string> = new Set([
  'head',
  'input',
  'textarea',
  'select',
  'option',
  'optgroup',
  'datalist',
  'code',
  'pre',
  'kbd',
  'samp',
  'var',
  'tt',
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'math',
  'iframe',
  'object',
  'embed',
  'canvas',
  'video',
  'audio',
  'pt-ja',
  'pt-overlay',
]);
/** `contenteditable` values that make an element editable (`false` and others do not). */
const EDITABLE_VALUES: ReadonlySet<string> = new Set(['', 'true', 'plaintext-only']);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_FRAGMENT_NODE = 11;
const SHOW_ELEMENT = 1;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;
/** Scanning time of one slice, in milliseconds, before it yields to the page. */
const SLICE_MS = 8;

const isElement = (node: Node): node is Element => node.nodeType === ELEMENT_NODE;
const isText = (node: Node): node is Text => node.nodeType === TEXT_NODE;
const isShadowRoot = (node: Node): node is ShadowRoot =>
  node.nodeType === DOCUMENT_FRAGMENT_NODE && 'host' in node;

/** The element above `element`, from a shadow root's top to its host. */
function parentOf(element: Element): Element | undefined {
  const parent = element.parentNode;
  if (parent === null) return undefined;
  if (isElement(parent)) return parent;
  return isShadowRoot(parent) ? parent.host : undefined;
}

const isIconFont = (name: string): boolean =>
  name === 'material-icons' ||
  name === 'google-symbols' ||
  name.startsWith('material-icons-') ||
  name.startsWith('material-symbols-');
function iconFont(element: Element): boolean {
  for (const name of element.classList) if (isIconFont(name)) return true;
  return false;
}
const editable = (element: Element): boolean => {
  const value = element.getAttribute('contenteditable');
  return value !== null && EDITABLE_VALUES.has(value.trim().toLowerCase());
};
/** Whether an element under `element` is editable (one query: the subtree of a kept element). */
const holdsEditable = (element: Element): boolean => {
  for (const inner of element.querySelectorAll('[contenteditable]'))
    if (editable(inner)) return true;
  return false;
};
const notranslate = (element: Element): boolean => element.classList.contains('notranslate');

/** Whether `element` closes its whole subtree to translation, by itself. */
const closedHere = (element: Element): boolean =>
  SKIPPED_TAGS.has(element.localName) ||
  notranslate(element) ||
  iconFont(element) ||
  editable(element);

/** What `element`'s own `translate` attribute says; `undefined` when it inherits. */
function translateSays(element: Element): boolean | undefined {
  const value = element.getAttribute('translate')?.trim().toLowerCase();
  if (value === 'no') return false;
  return value === 'yes' || value === '' ? true : undefined;
}

/** Whether the nearest `translate` attribute (from `element` up) says `no`. */
function translateOff(element: Element): boolean {
  for (let at: Element | undefined = element; at !== undefined; at = parentOf(at)) {
    const says = translateSays(at);
    if (says !== undefined) return !says;
  }
  return false;
}

/** Whether `element` or an element above it closes its subtree to translation. */
function closedAbove(element: Element): boolean {
  if (element.ownerDocument.designMode === 'on') return true;
  for (let at: Element | undefined = element; at !== undefined; at = parentOf(at))
    if (closedHere(at)) return true;
  return false;
}

/**
 * Whether `element`'s text is not translated: one of the skipped elements (form fields, code,
 * scripts, embedded content, this extension's own), an editable element, the class
 * `notranslate` or an icon font class, or inside one of those (through shadow roots too); or
 * the nearest `translate` attribute says `no` (a `translate="yes"` inside it is translated).
 */
export function isSkipped(element: Element): boolean {
  return closedAbove(element) || translateOff(element);
}

/** Whether a child of `element` ends a paragraph inside it, so it cannot be one marker. */
function holdsBoundary(element: Element): boolean {
  for (const child of element.children) if (roleOf(child) === 'boundary') return true;
  return false;
}

type Role = 'boundary' | 'ignore' | 'keep' | 'inline';

/**
 * What an element is inside a paragraph, by its tag (the CSS `display` is never read: it would
 * force a layout):
 * - `boundary`: `<br>`, an editable element (P24: its text is never read, and the words on each
 *   side keep their order), a block (any tag not listed above), or an inline element holding
 *   one of those, which is then a block of its own that the scanner enters;
 * - `ignore`: stepped over (`IGNORED_TAGS`, inline icon fonts);
 * - `keep`: kept in place (`KEEP_TAGS`, and inline elements marked `notranslate` or
 *   `translate="no"`: "a name that stays as it is"), unless something editable is inside: its
 *   text would go out with the request, so it is a boundary like an editable element;
 * - `inline`: a marker around its words.
 */
function roleOf(element: Element): Role {
  const tag = element.localName;
  if (tag === 'br' || editable(element)) return 'boundary';
  if (IGNORED_TAGS.has(tag)) return 'ignore';
  if (KEEP_TAGS.has(tag)) return holdsEditable(element) ? 'boundary' : 'keep';
  if (!INLINE_TAGS.has(tag) || holdsBoundary(element)) return 'boundary';
  if (iconFont(element)) return 'ignore';
  if (notranslate(element) || translateSays(element) === false)
    return holdsEditable(element) ? 'boundary' : 'keep';
  return 'inline';
}

/** Whether the scanner makes paragraphs of `element`'s children. */
const isBlock = (element: Element): boolean =>
  element.localName !== 'br' && roleOf(element) === 'boundary';

type Piece =
  | Readonly<{ t: 'text'; node: Text }>
  | Readonly<{ t: 'open' }>
  | Readonly<{ t: 'close' }>
  | Readonly<{ t: 'keep'; text: string }>;

const WORD = /\S/u;
const squash = (text: string): string => text.replace(/\s+/gu, ' ').trim();
/** Whether pieces hold words to translate or to keep: an inline element without is no marker. */
const holdsWords = (pieces: readonly Piece[]): boolean =>
  pieces.some(
    (piece) =>
      piece.t === 'keep' ||
      piece.t === 'open' ||
      (piece.t === 'text' && WORD.test(piece.node.data)),
  );

/**
 * Adds the pieces of `node` to `out`, in document order; false when `node` is a boundary, which
 * adds nothing. Comments and the like hold no words: the text around them stays one.
 */
function addPieces(node: ChildNode, out: Piece[]): boolean {
  if (isText(node)) {
    out.push({ t: 'text', node });
    return true;
  }
  if (!isElement(node)) return true;
  switch (roleOf(node)) {
    case 'boundary':
      return false;
    case 'ignore':
      return true;
    case 'keep':
      out.push({ t: 'keep', text: squash(node.textContent ?? '') });
      return true;
    case 'inline': {
      // An inline element holds no boundary (`roleOf`), so every child adds its pieces.
      const inner: Piece[] = [];
      for (const child of node.childNodes) addPieces(child, inner);
      const marked = holdsWords(inner);
      if (marked) out.push({ t: 'open' });
      for (const piece of inner) out.push(piece);
      if (marked) out.push({ t: 'close' });
      return true;
    }
  }
}

/** A text token and the nodes with words that make it. */
type Run = Readonly<{ text: string; nodes: readonly Text[] }>;

/**
 * The tokens of one paragraph. Text nodes with no marker between them are one text token,
 * whitespace collapsed and trimmed; whitespace that stood next to a marker is a `space` token
 * (none at the paragraph's ends), so the model reads `Roll <1>backward</1> to`.
 */
function tokensOf(pieces: readonly Piece[]): { tokens: PageToken[]; runs: Run[] } {
  const tokens: PageToken[] = [];
  const runs: Run[] = [];
  const open: number[] = [];
  let opened = 0;
  let kept = 0;
  let space = false;
  let run: Text[] = [];
  const putSpace = (): void => {
    if (space && tokens.length > 0) tokens.push({ t: 'space' });
    space = false;
  };
  const endRun = (): void => {
    if (run.length === 0) return;
    const raw = run.map((node) => node.data).join('');
    const nodes = run.filter((node) => WORD.test(node.data));
    run = [];
    const text = squash(raw);
    if (text === '') {
      space = true;
      return;
    }
    if (/^\s/u.test(raw)) space = true;
    putSpace();
    tokens.push({ t: 'text', text });
    runs.push({ text, nodes });
    space = /\s$/u.test(raw);
  };
  for (const piece of pieces) {
    if (piece.t === 'text') {
      run.push(piece.node);
      continue;
    }
    endRun();
    putSpace();
    switch (piece.t) {
      case 'open':
        opened += 1;
        open.push(opened);
        tokens.push({ t: 'open', n: opened });
        break;
      case 'close':
        tokens.push({ t: 'close', n: open.pop() ?? 0 });
        break;
      case 'keep':
        kept += 1;
        tokens.push({ t: 'keep', n: kept, text: piece.text });
        break;
    }
  }
  endRun();
  return { tokens, runs };
}

/** Unicode code points: what `PAGE_UNIT_CHARS` counts. */
function codePoints(text: string): number {
  let count = 0;
  for (const _point of text) count += 1;
  return count;
}

/** Where a sentence ends: `.`, `!`, `?` or `…` and a space, or `。`, `！`, `？`. */
const SENTENCE_END = /[.!?…]+["'”’)\]]*\s+|[。！？]+[」』”’)\]]*\s*/gu;

/**
 * A sentence longer than a unit, cut at the last space that fits, or at the limit. Its code
 * points are split once and the cuts move forward, so a long text costs linear time.
 */
function cutLong(sentence: string): string[] {
  const points = Array.from(sentence);
  // The trailing whitespace does not count: it is trimmed from the unit.
  let length = points.length;
  while (length > 0 && /\s/u.test(points[length - 1] ?? '')) length -= 1;
  const parts: string[] = [];
  let start = 0;
  while (length - start > PAGE_UNIT_CHARS) {
    let space = start + PAGE_UNIT_CHARS - 1;
    while (space > start && points[space] !== ' ') space -= 1;
    const cut = space > start ? space + 1 : start + PAGE_UNIT_CHARS;
    parts.push(points.slice(start, cut).join(''));
    start = cut;
  }
  parts.push(points.slice(start).join(''));
  return parts;
}

/** `text` in pieces of whole sentences, each at most `PAGE_UNIT_CHARS` long. */
function sentenceUnits(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    sentences.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) sentences.push(text.slice(start));
  const units: string[] = [];
  let current = '';
  // Code points of `current`, its trailing space included.
  let size = 0;
  for (const piece of sentences.flatMap(cutLong)) {
    if (size > 0 && size + codePoints(piece.trimEnd()) > PAGE_UNIT_CHARS) {
      units.push(current.trim());
      current = '';
      size = 0;
    }
    current += piece;
    size += codePoints(piece);
  }
  if (current.trim() !== '') units.push(current.trim());
  return units;
}

const unitOf = (tokens: readonly PageToken[]): RequestUnit => ({
  key: JSON.stringify(tokens),
  tokens,
});

function unitsOf(tokens: readonly PageToken[]): RequestUnit[] {
  const [only] = tokens;
  if (tokens.length !== 1 || only?.t !== 'text' || codePoints(only.text) <= PAGE_UNIT_CHARS)
    return [unitOf(tokens)];
  return sentenceUnits(only.text).map((text) => unitOf([{ t: 'text', text }]));
}

/** A paragraph's pieces, its block and its last node (`Segment.last`). */
type Paragraph = Readonly<{ pieces: readonly Piece[]; block: Element; last: ChildNode }>;

/** The segment of `tokens`, or `undefined` when its words need no translating. */
function segmentOf(
  paragraph: Paragraph,
  tokens: readonly PageToken[],
  runs: readonly Run[],
  hint: string | undefined,
  nextId: () => number,
): Segment | undefined {
  if (!needsPageTranslation(runs.map((run) => run.text).join(' '), hint)) return undefined;
  const nodes: Text[] = [];
  const pieceOf: number[] = [];
  for (const [i, run] of runs.entries())
    for (const node of run.nodes) {
      nodes.push(node);
      pieceOf.push(i);
    }
  return {
    id: nextId(),
    block: paragraph.block,
    nodes,
    originals: nodes.map((node) => node.data),
    pieceOf,
    last: paragraph.last,
    tokens,
    units: unitsOf(tokens),
  };
}

/**
 * The segments of one paragraph: one rich segment, or, when its tokens cannot be one unit (more
 * than `PAGE_MARKERS_MAX` markers, more than `PAGE_UNIT_CHARS` characters of text, a kept
 * element too long), one text-only segment per text token.
 */
function paragraphSegments(
  paragraph: Paragraph,
  hint: string | undefined,
  nextId: () => number,
): Segment[] {
  const { tokens, runs } = tokensOf(paragraph.pieces);
  if (runs.length === 0) return [];
  if (pageTokensValid(tokens)) {
    const segment = segmentOf(paragraph, tokens, runs, hint, nextId);
    return segment === undefined ? [] : [segment];
  }
  return runs.flatMap(
    (run) => segmentOf(paragraph, [{ t: 'text', text: run.text }], [run], hint, nextId) ?? [],
  );
}

/** The segments of `parent`'s children, which belong to `block` (a shadow root's to its host). */
function segmentsIn(
  parent: ParentNode,
  block: Element,
  hint: string | undefined,
  nextId: () => number,
): Segment[] {
  const segments: Segment[] = [];
  let pieces: Piece[] = [];
  let last: ChildNode | undefined;
  const end = (): void => {
    if (last !== undefined)
      for (const segment of paragraphSegments({ pieces, block, last }, hint, nextId))
        segments.push(segment);
    pieces = [];
    last = undefined;
  };
  for (const child of parent.childNodes) {
    if (!addPieces(child, pieces)) {
      end();
      continue;
    }
    // A side-by-side translation already there is not the paragraph's.
    if (!isElement(child) || !OWN_TAGS.has(child.localName)) last = child;
  }
  end();
  return segments;
}

/**
 * The paragraphs of `block`'s own children: each run of text nodes and inline elements (those
 * holding no block) between two boundaries (a block element, or `<br>`), in document order.
 * Nothing when `block` is skipped (`isSkipped`) or a paragraph's words need no translating
 * (`needsPageTranslation`, with the page's language `hint`).
 */
export function segmentsOf(
  block: Element,
  hint: string | undefined,
  nextId: () => number,
): Segment[] {
  return isSkipped(block) ? [] : segmentsIn(block, block, hint, nextId);
}

export type ScannerOptions = Readonly<{
  root: Element | ShadowRoot;
  hint: string | undefined;
  nextId: () => number;
  timers: Timers;
  now: () => number;
  /** Longest a slice works before it yields to the page (default 8 ms). */
  sliceMs?: number;
  /** The segments each slice found, in document order; not called for a slice with none. */
  onSegments: (segments: Segment[]) => void;
  /** An open shadow root met on the way, which the scanner then scans too. */
  onShadowRoot: (root: ShadowRoot) => void;
  onDone: () => void;
}>;

/**
 * Walks the elements under `root` (skipping the subtrees `isSkipped` closes) and makes the
 * paragraphs of every block element (`segmentsOf`), in slices of at most `sliceMs`: the first
 * slice runs at once, the next after `timers.set(…, 0)`. Open shadow roots are reported and
 * scanned where they stand; closed ones cannot be seen. `cancel` stops it without `onDone`.
 */
export function createScanner(options: ScannerOptions): { cancel(): void } {
  const { root, hint, nextId, timers, now, onSegments, onShadowRoot, onDone } = options;
  const sliceMs = options.sliceMs ?? SLICE_MS;
  const doc = root.ownerDocument;
  const accept = (node: Node): number =>
    isElement(node) && closedHere(node) ? FILTER_REJECT : FILTER_ACCEPT;
  // Depth first: a shadow root is walked before the rest of its host's subtree.
  const walkers: TreeWalker[] = [];
  let found: Segment[] = [];
  let timer: number | undefined;
  let stopped = false;

  const enterShadow = (host: Element, shadow: ShadowRoot): void => {
    if (!translateOff(host))
      for (const segment of segmentsIn(shadow, host, hint, nextId)) found.push(segment);
    walkers.push(doc.createTreeWalker(shadow, SHOW_ELEMENT, accept));
  };
  const visit = (element: Element): void => {
    if (isBlock(element) && !translateOff(element))
      for (const segment of segmentsIn(element, element, hint, nextId)) found.push(segment);
    const shadow = element.shadowRoot;
    if (shadow === null) return;
    onShadowRoot(shadow);
    enterShadow(element, shadow);
  };

  const step = (): void => {
    timer = undefined;
    const started = now();
    for (let walker = walkers.at(-1); walker !== undefined; walker = walkers.at(-1)) {
      const next = walker.nextNode();
      if (next === null) {
        walkers.pop();
        continue;
      }
      if (isElement(next)) visit(next);
      if (stopped || now() - started >= sliceMs) break;
    }
    const segments = found;
    found = [];
    if (!stopped && segments.length > 0) onSegments(segments);
    if (stopped) return;
    if (walkers.length > 0) {
      timer = timers.set(step, 0);
      return;
    }
    stopped = true;
    onDone();
  };

  if (isShadowRoot(root)) {
    if (!closedAbove(root.host)) enterShadow(root.host, root);
  } else if (!closedAbove(root)) {
    walkers.push(doc.createTreeWalker(root, SHOW_ELEMENT, accept));
    visit(root);
  }
  step();
  return {
    cancel() {
      stopped = true;
      walkers.length = 0;
      found = [];
      if (timer !== undefined) timers.clear(timer);
      timer = undefined;
    },
  };
}
