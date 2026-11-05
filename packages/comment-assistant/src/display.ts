import { createLruCache, type CommentCategory } from '@chrome-toolbox/extension-core';
import { modeOf, type FilterSettings } from './filters.ts';
import { CATEGORY_NAMES } from './labels.ts';
import { HOLDING_ATTRIBUTE, WAIT_ATTRIBUTE } from './hold.ts';
import type { Annotation } from './protocol.ts';
import { ID_ATTRIBUTE, type SiteAdapter } from './sites/types.ts';

/**
 * Each category's colour, and the opaque ink of the label on its bar: black or white, whichever
 * keeps WCAG contrast of at least 4.5:1 with the colour (5.0:1 or more). Both are fixed, so a
 * light or dark page changes neither. The colours differ in hue, so a concealed bar says which
 * category it is (the genre categories, R62: teal, pink, indigo, brown and yellow).
 */
const PALETTE: Readonly<Record<CommentCategory, Readonly<{ color: string; ink: string }>>> = {
  abusive: { color: '#e5484d', ink: '#000000' },
  spam: { color: '#8b8d98', ink: '#000000' },
  spoiler: { color: '#8e4ec6', ink: '#ffffff' },
  question: { color: '#0090ff', ink: '#000000' },
  important: { color: '#f5a524', ink: '#000000' },
  chatter: { color: '#46a758', ink: '#000000' },
  instruction: { color: '#12a594', ink: '#000000' },
  relay: { color: '#d6409f', ink: '#000000' },
  ghosting: { color: '#3e63dd', ink: '#ffffff' },
  privacy: { color: '#ad7f58', ink: '#000000' },
  sensitive: { color: '#ffe629', ink: '#000000' },
};
const TRANSLATED = 'data-ca-translated';
const REVEALED = 'data-ca-revealed';
/**
 * `hide` or `blur`, present only on a concealed line: the rules that reach into a line's children
 * key on it, so writing `data-ca-mode` on every annotated line restyles no line's children (R45).
 */
const CONCEAL = 'data-ca-conceal';
/** A concealed line a click reveals; a removed one (`hide`) has no box to click. */
const CONCEALED = `[${CONCEAL}="blur"]:not([${REVEALED}])`;
// Attribute selectors only, so the rules follow the comments wherever the site renders them.
// The highlight's left border is an inset shadow: it does not shift the line's layout. A removed
// line (`hide`, 消す) leaves the chat whole, with nothing in its place; the side panel lists it
// (R54). A concealed (`blur`) line is a bar of its category's colour with a label in the bar's
// own ink: its children are hidden (`visibility`), so they keep the line's height, are not
// hit-tested (a click lands on the line and reveals it) and leave the accessibility tree; the
// label lies over the bar, out of the flow, so concealing and revealing never move the chat. A
// filter on many lines saturates rendering, and a blurred text shadow took the GPU process 1.4
// times what shown lines took at 50 lines a second (R45, R51). A line waiting for its judgement
// takes no room until it comes in, and the list holding it does not slide (R52).
const CSS = [
  `[${WAIT_ATTRIBUTE}]{display:none!important}`,
  `[${HOLDING_ATTRIBUTE}]{transform:none!important}`,
  ...Object.entries(PALETTE).map(
    ([category, { color, ink }]) =>
      `[data-ca-category="${category}"]{--ca-color:${color};--ca-ink:${ink}}`,
  ),
  '[data-ca-mode="highlight"]{box-shadow:inset 3px 0 0 var(--ca-color)!important;background:color-mix(in srgb,var(--ca-color) 14%,transparent)!important}',
  `[${CONCEAL}="hide"]{display:none!important}`,
  `${CONCEALED}{position:relative;background:var(--ca-color)!important;cursor:pointer}`,
  `${CONCEALED}>*{visibility:hidden!important}`,
  `${CONCEALED}::before{content:"伏せたコメント（" attr(data-ca-label) "）· クリックで表示";position:absolute;inset:0;display:flex;align-items:center;padding:2px 4px;font-size:12px;color:var(--ca-ink)!important;cursor:pointer;overflow:hidden;white-space:nowrap}`,
  `[${TRANSLATED}]::after{content:"（訳）";margin-left:.25em;font-size:.85em;opacity:.6}`,
].join('\n');

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
/** NodeFilter.SHOW_TEXT */
const SHOW_TEXT = 4;
const isText = (node: Node): node is Text => node.nodeType === TEXT_NODE;
const isElement = (target: EventTarget | null): target is Element =>
  target !== null && 'nodeType' in target && target.nodeType === ELEMENT_NODE;
/** Every text node a translation changed: the page's text and what the extension wrote. */
const written = new WeakMap<Text, Readonly<{ original: string; value: string }>>();
/** Every attribute the display puts on the page. */
const ATTRIBUTES = [
  ID_ATTRIBUTE,
  'data-ca-category',
  'data-ca-mode',
  'data-ca-label',
  CONCEAL,
  REVEALED,
  TRANSLATED,
  WAIT_ATTRIBUTE,
  HOLDING_ATTRIBUTE,
] as const;

function textNodes(root: Element): Text[] {
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (isText(node)) nodes.push(node);
  return nodes;
}
/** The comment's plain text: text nodes outside links and mentions (`keep`) and not blank. */
function plainText(holder: HTMLElement, keep: string): Text[] {
  return textNodes(holder).filter((node) => {
    const kept = node.parentElement?.closest(keep);
    return (!kept || !holder.contains(kept)) && originalOf(node).trim() !== '';
  });
}
/** The page's text of a node; a node the site rewrote since the extension wrote it has new text. */
function originalOf(node: Text): string {
  const entry = written.get(node);
  return entry && node.data === entry.value ? entry.original : node.data;
}
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const WORD_CHARACTER = /[\p{L}\p{N}]/u;
const CJK = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
/**
 * What may not stand next to a kept text that starts or ends with `edge`: a letter or digit,
 * except that Japanese or Chinese right next to a Latin name or number is a word boundary
 * (`@nameさん`).
 */
function neighbour(edge: string): string {
  if (!WORD_CHARACTER.test(edge)) return '';
  return CJK.test(edge)
    ? '[\\p{L}\\p{N}]'
    : '(?![\\p{sc=Hira}\\p{sc=Kana}\\p{sc=Han}])[\\p{L}\\p{N}]';
}
/**
 * Compiled kept patterns by kept text: the same names and links come back line after line, and a
 * compile costs about a hundred times a cached match (R45).
 */
const keptPatterns = createLruCache<string, RegExp>({ max: 200 });
/** The kept text, in any letter case, only where it stands alone (`1:00` never cuts `11:00`). */
function keptPattern(text: string): RegExp {
  const known = keptPatterns.get(text);
  if (known !== undefined) return known;
  const points = Array.from(text);
  const before = neighbour(points.at(0) ?? '');
  const after = neighbour(points.at(-1) ?? '');
  // Global: `replace` starts each use from the beginning, so one instance serves every line.
  const pattern = new RegExp(
    `${before === '' ? '' : `(?<!${before})`}${escapeRegExp(text)}${after === '' ? '' : `(?!${after})`}`,
    'giu',
  );
  keptPatterns.set(text, pattern);
  return pattern;
}
/**
 * The translation without the text of the kept links and mentions, which stay on the page next
 * to it (`@name` would show twice, R38), whitespace runs then made one space.
 */
function withoutKept(holder: HTMLElement, keep: string, translation: string): string {
  const kept = [...holder.querySelectorAll(keep)]
    .map((element) => element.textContent.trim())
    .filter((text) => text !== '')
    // The longest first, so a shorter name inside a longer one is never what is taken.
    .toSorted((a, b) => b.length - a.length);
  let text = translation;
  for (const part of kept) text = text.replace(keptPattern(part), ' ');
  return text.replace(/\s+/gu, ' ').trim();
}
/**
 * Puts the translation, without the text of kept links and mentions, in the comment's first
 * plain text node and empties the other plain text nodes; links, mentions, emoji and whitespace
 * stay as they are. The model's output only ever becomes text-node data, never markup.
 */
function translate(holder: HTMLElement, keep: string, translation: string): void {
  const nodes = plainText(holder, keep);
  const shown = withoutKept(holder, keep, translation);
  // Only links or mentions, or a translation of nothing else: the original stays.
  if (nodes.length === 0 || shown === '') {
    restore(holder);
    return;
  }
  nodes.forEach((node, index) => {
    const value = index === 0 ? shown : '';
    written.set(node, { original: originalOf(node), value });
    if (node.data !== value) node.data = value;
  });
  holder.setAttribute(TRANSLATED, '');
}
/** Puts back the page's text in every node the extension still holds as it wrote it. */
function restore(holder: HTMLElement): void {
  for (const node of textNodes(holder)) {
    const entry = written.get(node);
    if (!entry) continue;
    if (node.data === entry.value) node.data = entry.original;
    written.delete(node);
  }
  holder.removeAttribute(TRANSLATED);
}
function set(element: Element, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}
function show(
  message: HTMLElement,
  adapter: SiteAdapter,
  annotation: Annotation,
  filters: FilterSettings,
): void {
  // The viewer marked it as fine (Task 5c): shown whatever the filters say.
  const mode = annotation.override === 'show' ? 'show' : modeOf(filters, annotation.category);
  set(message, ID_ATTRIBUTE, annotation.id);
  set(message, 'data-ca-category', annotation.category);
  set(message, 'data-ca-mode', mode);
  if (mode === 'hide' || mode === 'blur') set(message, CONCEAL, mode);
  else if (message.hasAttribute(CONCEAL)) message.removeAttribute(CONCEAL);
  set(message, 'data-ca-label', CATEGORY_NAMES[annotation.category]);
  const holder = adapter.textElement(message);
  if (!holder) return;
  // An empty translation is no translation.
  const translation = annotation.translation?.trim() ? annotation.translation : undefined;
  if (translation !== undefined && filters.translate && !filters.showOriginal)
    translate(holder, adapter.keep, translation);
  else restore(holder);
}

/**
 * Shows each annotated comment under `root` as the filters say: `data-ca-category`,
 * `data-ca-mode` (show, highlight, blur or hide) and `data-ca-label` on its message element,
 * and its translation in place of the original text. Comments no longer shown are skipped.
 * Returns the message elements written.
 */
export function applyAnnotations(
  root: Element,
  adapter: SiteAdapter,
  annotations: readonly Annotation[],
  filters: FilterSettings,
): HTMLElement[] {
  const written: HTMLElement[] = [];
  for (const annotation of annotations) {
    const message = adapter.messageElement(root, annotation.id);
    if (!message) continue;
    show(message, adapter, annotation, filters);
    written.push(message);
  }
  return written;
}

/** Shows every annotated comment under `root` again, as new filter settings say. */
export function refreshAnnotations(
  root: Element,
  adapter: SiteAdapter,
  annotationOf: (id: string) => Annotation | undefined,
  filters: FilterSettings,
): void {
  for (const message of root.querySelectorAll<HTMLElement>(`[${ID_ATTRIBUTE}]`)) {
    const annotation = annotationOf(message.getAttribute(ID_ATTRIBUTE) ?? '');
    if (annotation) show(message, adapter, annotation, filters);
  }
}

/**
 * Undoes the display under `root`: original text back where the site has not changed it since,
 * and every `data-ca-*` attribute removed (a line waiting for its judgement comes in).
 */
export function clearDisplay(root: ParentNode): void {
  for (const holder of root.querySelectorAll<HTMLElement>(`[${TRANSLATED}]`)) restore(holder);
  for (const element of root.querySelectorAll(ATTRIBUTES.map((name) => `[${name}]`).join(',')))
    for (const name of ATTRIBUTES) element.removeAttribute(name);
}

/**
 * Adds the display rules as one `<style>` and one click listener on the document (capture), so
 * a hidden or blurred comment is revealed by a click wherever the site re-renders its list.
 * Returns their removal.
 */
export function injectStyles(doc: Document): () => void {
  const style = doc.createElement('style');
  style.textContent = CSS;
  (doc.head ?? doc.documentElement).append(style);
  function onClick(event: Event): void {
    const concealed = isElement(event.target) ? event.target.closest(CONCEALED) : null;
    if (!concealed) return;
    // The first click only reveals: the site's own handler (YouTube's menu) does not run.
    event.preventDefault();
    event.stopPropagation();
    concealed.setAttribute(REVEALED, '');
  }
  doc.addEventListener('click', onClick, true);
  return () => {
    style.remove();
    doc.removeEventListener('click', onClick, true);
  };
}
