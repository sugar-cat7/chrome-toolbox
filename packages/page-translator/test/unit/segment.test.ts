// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, assert, describe, expect, it } from 'vitest';
import {
  pageTokensValid,
  pageUnitSource,
  type PageToken,
  type Timers,
} from '@chrome-toolbox/extension-core';
import { pageLangHint } from '../../src/language.ts';
import {
  containerOf,
  createScanner,
  INLINE_TAGS,
  isSkipped,
  scanCursor,
  segmentsOf,
  type RequestUnit,
  type Segment,
} from '../../src/content/segment.ts';

afterEach(() => {
  document.body.replaceChildren();
});

/** `value`, failing the test when it is missing. */
function must<T>(value: T | null | undefined): T {
  assert.exists(value);
  return value;
}

const ids = (): (() => number) => {
  let id = 0;
  return () => ++id;
};

/** `html` in a fresh container on the test page. */
function mount(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.append(container);
  return container;
}

/** The segments of every element under `root` (and of `root`), as if each one were a block. */
const everySegment = (root: Element): Segment[] =>
  [root, ...root.querySelectorAll('*')].flatMap((element) => segmentsOf(element, undefined, ids()));

/** Timers whose callbacks run only when the test says so. */
function manualTimers(): { timers: Timers; delays: number[]; runNext(): boolean } {
  let next = 1;
  const pending = new Map<number, () => void>();
  const delays: number[] = [];
  return {
    timers: {
      set: (fn, ms) => {
        delays.push(ms);
        pending.set(next, fn);
        return next++;
      },
      clear: (id) => void pending.delete(id),
    },
    delays,
    runNext() {
      const first = pending.entries().next();
      if (first.done === true) return false;
      const [id, fn] = first.value;
      pending.delete(id);
      fn();
      return true;
    },
  };
}

type Scan = { segments: Segment[]; calls: number; shadowRoots: ShadowRoot[]; done: boolean };

/** Runs a scanner over `root` to the end (the clock never moves, so one slice). */
function scan(root: Element | ShadowRoot, hint?: string): Scan {
  const clock = manualTimers();
  const result: Scan = { segments: [], calls: 0, shadowRoots: [], done: false };
  createScanner({
    root,
    hint,
    nextId: ids(),
    timers: clock.timers,
    now: () => 0,
    onSegments: (segments) => {
      result.calls += 1;
      result.segments.push(...segments);
    },
    onShadowRoot: (shadow) => result.shadowRoots.push(shadow),
    onDone: () => {
      result.done = true;
    },
  });
  while (clock.runNext());
  return result;
}

const source = (segment: Segment): string => pageUnitSource(segment.tokens).text;
/** The text of a text-only unit. */
function unitText(unit: RequestUnit): string {
  const [token] = unit.tokens;
  return unit.tokens.length === 1 && token?.t === 'text' ? token.text : '';
}
const data = (segment: Segment): string[] => segment.nodes.map((node) => node.data);

/**
 * What every segment promises its writer: `originals` are the scanned `data` of `nodes`, each
 * text token has at least one node (`pieceOf`, in order), and every unit can be sent.
 */
function expectWellFormed(segment: Segment): void {
  const texts = segment.tokens.filter((token) => token.t === 'text');
  expect(segment.originals).toEqual(data(segment));
  expect(segment.pieceOf).toHaveLength(segment.nodes.length);
  expect([...new Set(segment.pieceOf)]).toEqual(texts.map((_, i) => i));
  expect(segment.pieceOf).toEqual(segment.pieceOf.toSorted((a, b) => a - b));
  expect(segment.units.length).toBeGreaterThan(0);
  for (const unit of segment.units) {
    expect(pageTokensValid(unit.tokens)).toBe(true);
    expect(unit.key).toBe(JSON.stringify(unit.tokens));
  }
  // `last` is a child of the block (or of its shadow root), at or after the last rewritten node.
  expect([segment.block, segment.block.shadowRoot]).toContain(segment.last.parentNode);
  const lastText = must(segment.nodes.at(-1));
  const atOrAfter =
    segment.last.contains(lastText) ||
    (segment.last.compareDocumentPosition(lastText) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
  expect(atOrAfter).toBe(true);
}

describe('segmentsOf and the scanner', () => {
  it.each([
    { name: 'input', html: '<p><input value="Search"></p>' },
    { name: 'textarea の初期値', html: '<textarea>Default text here</textarea>' },
    { name: 'value のない option', html: '<select><option>Easy mode</option></select>' },
    { name: 'pre と code', html: '<pre>let x = 1;</pre><p><code>run()</code></p>' },
    { name: 'kbd と samp', html: '<kbd>Ctrl</kbd><samp>Error found</samp>' },
    { name: 'svg の text', html: '<svg><text>Boss HP</text></svg>' },
    { name: 'translate=no', html: '<div translate="no"><p>Brand Name Here</p></div>' },
    { name: 'notranslate', html: '<p class="notranslate">Keep this phrase</p>' },
    { name: 'contenteditable', html: '<div contenteditable="true">Type your notes</div>' },
    { name: 'アイコンフォント', html: '<p><span class="material-icons">search</span></p>' },
    { name: 'script と style', html: '<script>var hello = 1</script><style>.a{}</style>' },
    { name: '日本語', html: '<p>推奨レベルは150以上です。</p>' },
  ])('makes no segment for $name', ({ html }) => {
    const root = mount(html);
    expect(everySegment(root)).toEqual([]);
    const scanned = scan(root);
    expect(scanned.segments).toEqual([]);
    expect(scanned.done).toBe(true);
  });

  it('translates translate="yes" inside translate="no"', () => {
    const root = mount('<div translate="no"><p translate="yes">Read this part</p></div>');
    expect(scan(root).segments.map(source)).toEqual(['Read this part']);
    expect(everySegment(root).map(source)).toEqual(['Read this part']);
  });

  it('makes one rich segment of a paragraph with a link and inline code', () => {
    const root = mount('<p>Click <a href="/dl">here</a> to <code>run()</code>.</p>');
    const segments = scan(root).segments;
    expect(segments).toHaveLength(1);
    const segment = must(segments[0]);
    expect(segment.block).toBe(root.querySelector('p'));
    // The spaces next to a marker stay (P19), so the model reads words, not "Click<1>here".
    expect(segment.tokens).toEqual([
      { t: 'text', text: 'Click' },
      { t: 'space' },
      { t: 'open', n: 1 },
      { t: 'text', text: 'here' },
      { t: 'close', n: 1 },
      { t: 'space' },
      { t: 'text', text: 'to' },
      { t: 'space' },
      { t: 'keep', n: 1, text: 'run()' },
      { t: 'text', text: '.' },
    ] satisfies PageToken[]);
    expect(segment.nodes).toHaveLength(4);
    expect(segment.originals).toEqual(['Click ', 'here', ' to ', '.']);
    expect(segment.pieceOf).toEqual([0, 1, 2, 3]);
    expect(segment.units).toEqual([
      { key: JSON.stringify(segment.tokens), tokens: segment.tokens },
    ]);
    expectWellFormed(segment);
  });

  it.each([
    // P19: a text node's edge whitespace next to a marker is a space token, on either side.
    {
      name: 'spaces outside a link',
      html: '<p>Roll <a>backward</a> to dodge.</p>',
      source: 'Roll <1>backward</1> to dodge.',
      data: ['Roll ', 'backward', ' to dodge.'],
      pieceOf: [0, 1, 2],
    },
    {
      name: 'spaces inside a link',
      html: '<p>Roll<a> backward </a>to dodge.</p>',
      source: 'Roll<1> backward </1>to dodge.',
      data: ['Roll', ' backward ', 'to dodge.'],
      pieceOf: [0, 1, 2],
    },
    {
      name: 'no space at a link',
      html: '<p>Roll<a>backward</a>to dodge.</p>',
      source: 'Roll<1>backward</1>to dodge.',
      data: ['Roll', 'backward', 'to dodge.'],
      pieceOf: [0, 1, 2],
    },
    {
      name: 'a whitespace-only node between two links',
      html: '<p><a>Fire</a> <a>Ice</a></p>',
      source: '<1>Fire</1> <2>Ice</2>',
      data: ['Fire', 'Ice'],
      pieceOf: [0, 1],
    },
    {
      name: 'edge whitespace of the paragraph',
      html: '<p>\n  Roll <a>backward</a>  \n</p>',
      source: 'Roll <1>backward</1>',
      data: ['\n  Roll ', 'backward'],
      pieceOf: [0, 1],
    },
    // P20: text nodes with no marker between them are one text token over all their nodes.
    {
      name: 'an image between two text nodes',
      html: '<p>A<img src="/a.png" alt="">B</p>',
      source: 'AB',
      data: ['A', 'B'],
      pieceOf: [0, 0],
    },
    {
      name: 'a word break opportunity',
      html: '<p>long<wbr>word</p>',
      source: 'longword',
      data: ['long', 'word'],
      pieceOf: [0, 0],
    },
    {
      name: 'a comment',
      html: '<p>a<!--c-->b</p>',
      source: 'ab',
      data: ['a', 'b'],
      pieceOf: [0, 0],
    },
    {
      name: 'a comment after a link',
      html: '<p>Equip the <em>Ring</em> now<!-- note -->, then fight.</p>',
      source: 'Equip the <1>Ring</1> now, then fight.',
      data: ['Equip the ', 'Ring', ' now', ', then fight.'],
      pieceOf: [0, 1, 2, 2],
    },
    {
      name: 'an icon-font element, which is no marker',
      html: '<p>Open the <span class="material-icons">map</span> menu.</p>',
      source: 'Open the menu.',
      data: ['Open the ', ' menu.'],
      pieceOf: [0, 0],
    },
    {
      name: 'an empty inline element, which is no marker',
      html: '<p><i class="icon-map"></i> Open the <b></b>map</p>',
      source: 'Open the map',
      data: [' Open the ', 'map'],
      pieceOf: [0, 0],
    },
    {
      name: 'an icon inside a link',
      html: '<p>Get the <a href="/m"><svg></svg> map pack</a> now.</p>',
      source: 'Get the <1> map pack</1> now.',
      data: ['Get the ', ' map pack', ' now.'],
      pieceOf: [0, 1, 2],
    },
    // A name the page marks as not to translate stays in its place, like code.
    {
      name: 'a translate="no" name',
      html: '<p>Equip the <span translate="no">Moonblade</span> first.</p>',
      source: 'Equip the <k1/> first.',
      data: ['Equip the ', ' first.'],
      pieceOf: [0, 1],
    },
    {
      name: 'a notranslate name',
      html: '<p>Use the <span class="notranslate">Moonblade</span> now.</p>',
      source: 'Use the <k1/> now.',
      data: ['Use the ', ' now.'],
      pieceOf: [0, 1],
    },
    // P25: this extension's own elements are stepped over, never a boundary.
    {
      name: 'a side-by-side translation inside the paragraph',
      html: '<p>Before <pt-ja></pt-ja>after the pair.</p>',
      source: 'Before after the pair.',
      data: ['Before ', 'after the pair.'],
      pieceOf: [0, 0],
    },
  ])('tokens of a paragraph: $name', ({ html, source: text, data: texts, pieceOf }) => {
    const segments = scan(mount(html)).segments;
    expect(segments).toHaveLength(1);
    const segment = must(segments[0]);
    expect(source(segment)).toBe(text);
    expect(data(segment)).toEqual(texts);
    expect(segment.pieceOf).toEqual(pieceOf);
    expectWellFormed(segment);
  });

  it('joins adjacent text nodes a framework left into one text token', () => {
    const root = mount('<p></p>');
    must(root.querySelector('p')).append('Collect three ', 'shards', ' to open the gate.');
    const segments = scan(root).segments;
    expect(segments).toHaveLength(1);
    const segment = must(segments[0]);
    expect(segment.tokens).toEqual([{ t: 'text', text: 'Collect three shards to open the gate.' }]);
    expect(segment.pieceOf).toEqual([0, 0, 0]);
    expectWellFormed(segment);
  });

  // P24: editable text is never read or sent; an editable element ends the paragraph on each
  // side, so the words around it keep their order.
  it.each([
    {
      name: 'an editable inline element',
      html: '<p>Use the <span contenteditable="true">typed text</span> field now.</p>',
      sources: ['Use the', 'field now.'],
    },
    {
      name: 'editable code',
      html: '<p>Run <code contenteditable="true">typed text</code> now.</p>',
      sources: ['Run', 'now.'],
    },
    {
      name: 'kept code holding an editable element',
      html: '<p>Press <kbd><span contenteditable="">typed text</span></kbd> now.</p>',
      sources: ['Press', 'now.'],
    },
    {
      name: 'a translate="no" name holding an editable element',
      html: '<p>Equip the <span translate="no">Moon <b contenteditable="true">typed text</b></span> now.</p>',
      sources: ['Equip the', 'now.'],
    },
    {
      name: 'a notranslate name holding an editable element',
      html: '<p>Equip the <span class="notranslate">Moon <b contenteditable="true">typed text</b></span> now.</p>',
      sources: ['Equip the', 'now.'],
    },
    {
      name: 'a translate="no" name with an editable element under an icon',
      html: '<p>Equip the <span translate="no">Moon<svg><foreignObject><div contenteditable="true">typed text</div></foreignObject></svg></span> now.</p>',
      sources: ['Equip the', 'now.'],
    },
  ])('never reads editable text: $name', ({ html, sources }) => {
    const segments = scan(mount(html)).segments;
    expect(segments.map(source)).toEqual(sources);
    for (const segment of segments) {
      expectWellFormed(segment);
      for (const unit of segment.units) expect(unit.key).not.toContain('typed');
    }
  });

  // P25: Task 5 puts the side-by-side translation after `last`, a child of the paragraph's parent.
  it.each([
    {
      name: 'text',
      html: '<p>Roll <a href="/r">backward</a> to dodge.</p>',
      last: (p: Element) => p.lastChild,
    },
    {
      name: 'a link',
      html: '<p>Read the <a href="/g">full guide</a></p>',
      last: (p: Element) => p.querySelector('a'),
    },
    {
      name: 'code',
      html: '<p>Run <code>start()</code></p>',
      last: (p: Element) => p.querySelector('code'),
    },
    {
      name: 'an image',
      html: '<p>Lightning damage <img src="/bolt.png" alt=""></p>',
      last: (p: Element) => p.querySelector('img'),
    },
    {
      name: 'an inline element without words',
      html: '<p>Open the map <i class="icon-map"></i></p>',
      last: (p: Element) => p.querySelector('i'),
    },
    {
      name: 'a side-by-side translation already there',
      html: '<p>Open the map<pt-ja></pt-ja></p>',
      last: (p: Element) => p.firstChild,
    },
  ])('ends a paragraph at its last node: $name', ({ html, last }) => {
    const paragraph = must(mount(html).querySelector('p'));
    const segments = scan(paragraph).segments;
    expect(segments).toHaveLength(1);
    expect(must(segments[0]).last).toBe(must(last(paragraph)));
  });

  it('ends each paragraph of a block before its line break', () => {
    const paragraph = must(mount('<p>Line one<br>Line two <b>here</b><br></p>').querySelector('p'));
    const segments = scan(paragraph).segments;
    expect(segments.map((segment) => segment.last)).toEqual([
      paragraph.firstChild,
      paragraph.querySelector('b'),
    ]);
  });

  it('splits a paragraph at br and keeps a nested inline element', () => {
    const root = mount('<p>Line one<br><a>Read <b>more</b></a></p>');
    const segments = scan(root).segments;
    expect(segments.map((segment) => segment.block)).toEqual([
      root.querySelector('p'),
      root.querySelector('p'),
    ]);
    expect(segments.map((segment) => segment.tokens)).toEqual([
      [{ t: 'text', text: 'Line one' }],
      [
        { t: 'open', n: 1 },
        { t: 'text', text: 'Read' },
        { t: 'space' },
        { t: 'open', n: 2 },
        { t: 'text', text: 'more' },
        { t: 'close', n: 2 },
        { t: 'close', n: 1 },
      ],
    ]);
    for (const segment of segments) expectWellFormed(segment);
  });

  it('keeps 12 markers in one segment', () => {
    const links = Array.from({ length: 12 }, (_, i) => `<a href="/g${i + 1}">Guide ${i + 1}</a>`);
    const segments = scan(mount(`<p>${links.join(', ')}</p>`)).segments;
    expect(segments).toHaveLength(1);
    expect(must(segments[0]).tokens.filter((token) => token.t === 'open')).toHaveLength(12);
    for (const segment of segments) expectWellFormed(segment);
  });

  it('falls back to one segment per text node beyond 12 markers', () => {
    const links = Array.from({ length: 13 }, (_, i) => `<a href="/g${i + 1}">Guide ${i + 1}</a>`);
    const segments = scan(mount(`<p>${links.join(', ')}</p>`)).segments;
    // The separators have no letters, so only the links' words become segments.
    expect(segments.map(source)).toEqual(Array.from({ length: 13 }, (_, i) => `Guide ${i + 1}`));
    for (const segment of segments) expectWellFormed(segment);
  });

  it('falls back to one segment per text token when the text passes 400 characters', () => {
    const half = 'The tide rises when the bells ring in the hall. '.repeat(5).trim();
    const root = mount(`<p>${half} <a href="/tide">tide</a> ${half}</p>`);
    const segments = scan(root).segments;
    expect(segments.map(source)).toEqual([half, 'tide', half]);
    for (const segment of segments) expectWellFormed(segment);
  });

  it('falls back to one segment per text token when kept code is too long to send', () => {
    const code = 'x'.repeat(201);
    const root = mount(`<p>Run <code>${code}</code> in the console.</p>`);
    expect(scan(root).segments.map(source)).toEqual(['Run', 'in the console.']);
  });

  it('splits a long text node into units at sentence ends', () => {
    // Ten sentences of 89 characters, 899 with the spaces between them.
    const sentence = (i: number): string =>
      `Sentence ${i} tells how the tide rose over the old choir hall while all the singers kept on.`;
    const text = Array.from({ length: 10 }, (_, i) => sentence(i)).join(' ');
    expect(Array.from(text)).toHaveLength(899);
    const root = mount(`<p>${text}</p>`);
    const segments = scan(root).segments;
    expect(segments).toHaveLength(1);
    const segment = must(segments[0]);
    expect(segment.nodes).toHaveLength(1);
    expect(segment.tokens).toEqual([{ t: 'text', text }]);
    expect(segment.units).toHaveLength(3);
    const texts = segment.units.map(unitText);
    for (const unit of texts) {
      expect(Array.from(unit).length).toBeLessThanOrEqual(400);
      expect(unit).toMatch(/^Sentence \d .*\.$/u);
    }
    expect(texts.join(' ')).toBe(text);
    expectWellFormed(segment);
  });

  it('cuts a sentence longer than a unit at a space', () => {
    const text = `${'word '.repeat(150)}end.`;
    const segment = must(scan(mount(`<p>${text}</p>`)).segments[0]);
    const texts = segment.units.map(unitText);
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.join(' ')).toBe(text);
    expectWellFormed(segment);
  });

  it.each([
    { name: 'words', text: 'word '.repeat(20_000).trim() },
    { name: 'no spaces', text: 'x'.repeat(100_000) },
  ])('cuts 100,000 characters without a sentence end in linear time ($name)', ({ text }) => {
    const paragraph = must(mount('<p></p>').querySelector('p'));
    paragraph.append(text);
    const started = performance.now();
    const segments = segmentsOf(paragraph, undefined, ids());
    const elapsed = performance.now() - started;
    expect(segments).toHaveLength(1);
    const segment = must(segments[0]);
    expect(segment.units).toHaveLength(250);
    expect(segment.units.map(unitText).join(text.includes(' ') ? ' ' : '')).toBe(text);
    expect(elapsed).toBeLessThan(50);
  });

  it('treats an inline element holding a block as a container', () => {
    const root = mount('<a href="/c"><div>Card title</div><div>Card body text</div></a>');
    const segments = scan(root).segments;
    expect(segments.map(source)).toEqual(['Card title', 'Card body text']);
    expect(segments.map((segment) => segment.block)).toEqual([...root.querySelectorAll('div')]);
  });

  it('makes a container of an inline element holding a line break', () => {
    const root = mount('<p>Before <b>Note:<br>after the break</b> end of line</p>');
    const segments = scan(root).segments;
    expect(segments.map(source)).toEqual(['Before', 'end of line', 'Note:', 'after the break']);
    expect(segments.map((segment) => segment.block.localName)).toEqual(['p', 'p', 'b', 'b']);
  });

  it('reads kanji-only text by the page language', () => {
    const root = mount('<p>東京大阪</p>');
    expect(scan(root, 'ja').segments).toEqual([]);
    expect(scan(root, 'zh-cn').segments.map(source)).toEqual(['東京大阪']);
  });

  it('reports and scans open shadow roots, not closed ones', () => {
    const root = mount('<div id="open"></div><section id="closed"></section>');
    const open = must(root.querySelector('#open')).attachShadow({ mode: 'open' });
    const closed = must(root.querySelector('#closed')).attachShadow({ mode: 'closed' });
    open.innerHTML = '<p>Open shadow paragraph</p>';
    closed.innerHTML = '<p>Closed shadow paragraph</p>';
    const scanned = scan(root);
    expect(scanned.segments.map(source)).toEqual(['Open shadow paragraph']);
    expect(scanned.shadowRoots).toEqual([open]);
    expect(scan(open).segments.map(source)).toEqual(['Open shadow paragraph']);
  });

  it('scans the text at the top of a shadow root as a paragraph of its host', () => {
    const root = mount('<span id="host"></span>');
    const host = must(root.querySelector('#host'));
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = 'Rendered <b>inside</b> the shadow';
    const segments = scan(root).segments;
    expect(segments.map(source)).toEqual(['Rendered <1>inside</1> the shadow']);
    expect(must(segments[0]).block).toBe(host);
    expect(must(segments[0]).last).toBe(shadow.lastChild);
  });

  it('scans 2,000 paragraphs in slices of at most sliceMs', () => {
    const root = mount(
      Array.from({ length: 2000 }, (_, i) => `<p>Paragraph ${i} of the guide.</p>`).join(''),
    );
    const clock = manualTimers();
    // Hundredths of a millisecond: each paragraph takes 0.01 ms.
    let ticks = 0;
    let id = 0;
    let sliceStart = 0;
    const slices: { ticks: number; segments: number }[] = [];
    let done = false;
    createScanner({
      root,
      hint: undefined,
      nextId: () => {
        ticks += 1;
        return ++id;
      },
      timers: clock.timers,
      now: () => ticks / 100,
      onSegments: (segments) =>
        slices.push({ ticks: ticks - sliceStart, segments: segments.length }),
      onShadowRoot: () => undefined,
      onDone: () => {
        done = true;
      },
    });
    do {
      sliceStart = ticks;
    } while (clock.runNext());
    expect(done).toBe(true);
    expect(slices.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...slices.map((slice) => slice.ticks))).toBeLessThanOrEqual(800);
    expect(slices.reduce((sum, slice) => sum + slice.segments, 0)).toBe(2000);
    expect(new Set(clock.delays)).toEqual(new Set([0]));
  });

  it('stops calling back once cancelled', () => {
    const root = mount(
      Array.from({ length: 50 }, (_, i) => `<p>Paragraph ${i} of the guide.</p>`).join(''),
    );
    const clock = manualTimers();
    let ticks = 0;
    let calls = 0;
    let done = false;
    const scanner = createScanner({
      root,
      hint: undefined,
      nextId: () => ++ticks,
      timers: clock.timers,
      now: () => ticks,
      sliceMs: 10,
      onSegments: () => {
        calls += 1;
      },
      onShadowRoot: () => undefined,
      onDone: () => {
        done = true;
      },
    });
    expect(calls).toBe(1);
    scanner.cancel();
    expect(clock.runNext()).toBe(false);
    expect(calls).toBe(1);
    expect(done).toBe(false);
  });

  it('scans one block of 2,000 lines in slices of at most sliceMs', () => {
    // One block: its paragraphs used to be made in one go, whatever their number.
    const root = mount(
      `<div>${Array.from({ length: 2000 }, (_, i) => `Line ${i} of the guide.`).join('<br>')}</div>`,
    );
    const clock = manualTimers();
    let ticks = 0;
    let id = 0;
    let sliceStart = 0;
    const slices: { ticks: number; segments: Segment[] }[] = [];
    createScanner({
      root,
      hint: undefined,
      nextId: () => {
        ticks += 1;
        return ++id;
      },
      timers: clock.timers,
      now: () => ticks / 100,
      onSegments: (segments) => slices.push({ ticks: ticks - sliceStart, segments }),
      onShadowRoot: () => undefined,
      onDone: () => undefined,
    });
    do {
      sliceStart = ticks;
    } while (clock.runNext());
    // Each slice stops at 8 ms, 800 lines, also inside the one block.
    expect(slices.map((slice) => slice.ticks)).toEqual([800, 800, 400]);
    const segments = slices.flatMap((slice) => slice.segments);
    expect(segments.map(source)).toEqual(
      Array.from({ length: 2000 }, (_, i) => `Line ${i} of the guide.`),
    );
    for (const segment of segments) expectWellFormed(segment);
  });
});

describe('the scan cursor and containerOf', () => {
  /** Every segment `cursor` makes, and the containers it announced, in order. */
  function drain(options: { root: Element | ShadowRoot; shallow?: boolean }): {
    segments: Segment[];
    containers: (Element | ShadowRoot)[];
  } {
    const containers: (Element | ShadowRoot)[] = [];
    const segments: Segment[] = [];
    const cursor = scanCursor({
      ...options,
      hint: undefined,
      nextId: ids(),
      onShadowRoot: () => undefined,
      onContainer: (container) => containers.push(container),
    });
    while (cursor.step(segments));
    return { segments, containers };
  }

  it('reads only the root’s own paragraphs when shallow', () => {
    const root = mount(
      '<div id="box">Intro text here<p>Nested paragraph text</p>Outro words here</div>',
    );
    const box = must(root.querySelector('#box'));
    expect(drain({ root: box, shallow: true }).segments.map(source)).toEqual([
      'Intro text here',
      'Outro words here',
    ]);
    expect(drain({ root: box }).segments.map(source)).toEqual([
      'Intro text here',
      'Outro words here',
      'Nested paragraph text',
    ]);
  });

  it('announces each container before it reads its children', () => {
    const root = mount('<div id="box">Top line<section><p>Inner text</p></section></div>');
    const box = must(root.querySelector('#box'));
    const host = must(root.querySelector('p'));
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = 'Shadow words here';
    const { segments, containers } = drain({ root: box });
    expect(containers).toEqual([box, must(root.querySelector('section')), host, shadow]);
    expect(segments.map(source)).toEqual(['Top line', 'Inner text', 'Shadow words here']);
    expect(drain({ root: shadow, shallow: true }).segments.map(source)).toEqual([
      'Shadow words here',
    ]);
  });

  it('reads nothing of a skipped root', () => {
    const root = mount('<div class="notranslate">Keep this phrase</div>');
    const box = must(root.firstElementChild);
    expect(drain({ root: box, shallow: true })).toEqual({ segments: [], containers: [] });
  });

  it.each([
    { name: 'a text in a list item', pick: (li: Element) => li.firstChild, expected: 'li' },
    {
      name: 'a text in a link',
      pick: (li: Element) => li.querySelector('a')?.firstChild,
      expected: 'li',
    },
    { name: 'a link', pick: (li: Element) => li.querySelector('a'), expected: 'li' },
    { name: 'the list item itself', pick: (li: Element) => li, expected: 'li' },
    {
      name: 'a span holding a block',
      pick: (li: Element) => li.querySelector('#wrap'),
      expected: 'span',
    },
    {
      name: 'a text in a block in a span',
      pick: (li: Element) => li.querySelector('#inner')?.firstChild,
      expected: 'div',
    },
  ])('containerOf($name)', ({ pick, expected }) => {
    const root = mount(
      '<ul><li>Read the <a href="/g">guide</a> first. <span id="wrap"><div id="inner">Block</div></span></li></ul>',
    );
    const item = must(root.querySelector('li'));
    const container = containerOf(must(pick(item)));
    expect(container instanceof Element ? container.localName : container).toBe(expected);
  });

  it('gives the shadow root as the container of the text at its top', () => {
    const root = mount('<div id="host"></div>');
    const shadow = must(root.querySelector('#host')).attachShadow({ mode: 'open' });
    shadow.innerHTML = 'Rendered <b>inside</b> the shadow';
    expect(containerOf(must(shadow.firstChild))).toBe(shadow);
    expect(containerOf(must(shadow.querySelector('b')))).toBe(shadow);
    expect(containerOf(document.createTextNode('Detached text'))).toBeUndefined();
  });
});

describe('isSkipped', () => {
  it.each([
    { html: '<p translate="NO"><b>x</b></p>', skipped: true },
    { html: '<p translate="no"><b translate="">x</b></p>', skipped: false },
    { html: '<p translate="no"><b translate="maybe">x</b></p>', skipped: true },
    { html: '<p class="material-symbols-outlined"><b>x</b></p>', skipped: true },
    { html: '<p class="material-icons-round"><b>x</b></p>', skipped: true },
    { html: '<p class="google-symbols"><b>x</b></p>', skipped: true },
    { html: '<p class="material-iconsx"><b>x</b></p>', skipped: false },
    { html: '<p contenteditable="plaintext-only"><b>x</b></p>', skipped: true },
    { html: '<p contenteditable="false"><b>x</b></p>', skipped: false },
    { html: '<p contenteditable=""><b>x</b></p>', skipped: true },
    { html: '<p class="notranslate"><b translate="yes">x</b></p>', skipped: true },
    { html: '<pre><b>x</b></pre>', skipped: true },
    { html: '<p><b>x</b></p>', skipped: false },
  ])('isSkipped(<b> in $html) is $skipped', ({ html, skipped }) => {
    expect(isSkipped(must(mount(html).querySelector('b')))).toBe(skipped);
  });

  it('skips the inside of a skipped shadow host', () => {
    const host = must(mount('<div translate="no"></div>').querySelector('div'));
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<p>Inside</p>';
    expect(isSkipped(must(shadow.querySelector('p')))).toBe(true);
  });

  it('lists the inline tags of a paragraph', () => {
    expect([...INLINE_TAGS].toSorted()).toEqual(
      'a abbr b bdi bdo big cite data del dfn em font i ins label mark q s small span strong sub sup time u'.split(
        ' ',
      ),
    );
  });
});

describe('the article fixture', () => {
  const html = readFileSync(path.join(import.meta.dirname, 'fixtures/article.html'), 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');

  it('becomes paragraphs that can all be sent, skipping code, forms and Japanese', () => {
    const scanned = scan(doc.body, pageLangHint(doc));
    expect(scanned.done).toBe(true);
    for (const segment of scanned.segments) expectWellFormed(segment);
    expect(scanned.segments.map(source)).toEqual([
      '<1>Home</1> | <2>Bosses</2> | <3>Items</3> | <4>Maps</4>',
      'Search',
      'Vesper the Tidebound',
      'Vesper the Tidebound is the third boss of the <1>Sunken Choir</1>. She guards the <k1/> lantern and attacks with waves of cold water.',
      'Boss overview',
      'Recommended level',
      'Weakness',
      'Lightning damage',
      'Drops',
      '<1>Tide Pearl</1>, <2>Choir Bell</2>',
      'Strategy',
      'Phase 2 begins at 50% HP. Roll <1>backward</1> to dodge the light attack, then press <k1/> to counter.',
      'Equip the <1>Stormglass Ring</1> before the fight, because her heavy attack drains your stamina.',
      'Stay near the <1>pillars</1> during the flood.',
      'Use <k1/> macros only on PC.',
      'Break the four bells to stop her healing song.',
      'Hold jump to reach the upper ledge with the Featherstep Boots.',
      'Patch notes:',
      'Version 1.3 lowered her health.',
      'Version 1.4 fixed the ledge glitch.',
      'Lore',
      expect.stringMatching(/^The Sunken Choir was once .* the bay never freezes\.$/u),
      'Next boss',
      'The Hollow Organist waits in the bell tower.',
      'Comments',
      '<1>Difficulty</1>',
      'Post comment',
      'Fan wiki made for testing. Contact: <1>editors@wiki.fixture.test</1>',
    ]);
    const lore = scanned.segments.find((segment) => source(segment).startsWith('The Sunken'));
    expect(must(lore).units).toHaveLength(2);
  });
});
