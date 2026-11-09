// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, assert, describe, expect, it } from 'vitest';
import type { Timers } from '@chrome-toolbox/extension-core';
import { createScanner, segmentsOf, type Segment } from '../../src/content/segment.ts';
import { createWriter, mapOffset, PAIR_TAG } from '../../src/content/writer.ts';
import { DISPLAY_MODES } from '../../src/protocol.ts';
import { fingerprint } from './fingerprint.ts';

const article = readFileSync(path.join(import.meta.dirname, 'fixtures/article.html'), 'utf8');

afterEach(() => {
  document.getSelection()?.removeAllRanges();
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

/** The segments under `root` and its open shadow roots, as the scanner finds them. */
function scanAll(root: Element): Segment[] {
  const clock = manualTimers();
  const segments: Segment[] = [];
  createScanner({
    root,
    hint: undefined,
    nextId: ids(),
    timers: clock.timers,
    now: () => 0,
    onSegments: (found) => segments.push(...found),
    onShadowRoot: () => undefined,
    onDone: () => undefined,
  });
  while (clock.runNext());
  return segments;
}

/** The only segment of `block`. */
function only(block: Element): Segment {
  const segments = segmentsOf(block, undefined, ids());
  expect(segments).toHaveLength(1);
  return must(segments[0]);
}

/** A made-up translation of each text token of `segment`. */
const translated = (segment: Segment): string[] =>
  segment.tokens.flatMap((token) => (token.t === 'text' ? [`訳:${token.text}`] : []));

const data = (segment: Segment): string[] => segment.nodes.map((node) => node.data);

/** Every text node under `root` in its light tree, in document order. */
function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode())
    if (node instanceof Text) nodes.push(node);
  return nodes;
}

/** The side-by-side boxes under `root`, in document order. */
const boxesIn = (root: ParentNode): Element[] => [...root.querySelectorAll(PAIR_TAG)];

/** The translation a side-by-side box shows: the text of its shadow root, its style aside. */
const shown = (box: Element): string =>
  [...must(box.shadowRoot).childNodes]
    .filter((node) => node.nodeName !== 'STYLE')
    .map((node) => node.textContent)
    .join('');

/**
 * The segments that get a side-by-side box: not those in or under a button, a summary or a link
 * (P26).
 */
const boxed = (segments: readonly Segment[]): Segment[] =>
  segments.filter((segment) => segment.block.closest('a, button, summary') === null);

/** The article fixture as the test page's body, with a widget in an open shadow root. */
function loadArticle(): ShadowRoot {
  const parsed = new DOMParser().parseFromString(article, 'text/html');
  document.body.replaceWith(document.adoptNode(parsed.body));
  const host = document.createElement('div');
  host.id = 'widget';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<p>Rate this <a href="#rate">guide</a> today\n</p>';
  must(document.querySelector('main')).append(host);
  return shadow;
}

describe('createWriter', () => {
  it.each(DISPLAY_MODES)('restores the exact DOM after %s', (mode) => {
    const shadow = loadArticle();
    const before = fingerprint(document.body);
    const texts = textNodes(document.body);
    const links = [...document.body.querySelectorAll('a')];
    const segments = scanAll(document.body);
    expect(segments.length).toBeGreaterThan(20);
    const writer = createWriter(document);
    for (const segment of segments)
      expect(writer.write(segment, translated(segment), mode)).toBe(true);
    expect(fingerprint(document.body)).not.toBe(before);
    expect(boxesIn(document.body).length + boxesIn(shadow).length).toBe(
      mode === 'pair' ? boxed(segments).length : 0,
    );

    writer.restore({ sliced: false });
    expect(fingerprint(document.body)).toBe(before);
    const after = textNodes(document.body);
    expect(after).toHaveLength(texts.length);
    for (const [i, node] of after.entries()) expect(node).toBe(texts[i]);
    for (const [i, link] of [...document.body.querySelectorAll('a')].entries())
      expect(link).toBe(links[i]);
  });

  it('writes pieces into the text nodes in order and keeps their outer spaces', () => {
    const segment = only(
      must(mount('<p>Click <a href="#go">here</a> to <kbd>R2</kbd>.</p>').firstElementChild),
    );
    expect(data(segment)).toEqual(['Click ', 'here', ' to ', '.']);
    const writer = createWriter(document);
    expect(writer.write(segment, ['ここ', 'を', 'クリックして', '。'], 'replace')).toBe(true);
    expect(data(segment)).toEqual(['ここ ', 'を', ' クリックして ', '。']);
  });

  it('writes a run of text nodes into its first node and keeps the outer spaces of the others', () => {
    const p = must(
      mount('<p>Feather<wbr>step <img src="/boots.png" alt=""> boots <a href="#b">here</a></p>')
        .firstElementChild,
    );
    const segment = only(p);
    expect(data(segment)).toEqual(['Feather', 'step ', ' boots ', 'here']);
    expect(segment.pieceOf).toEqual([0, 0, 0, 1]);
    const writer = createWriter(document);
    expect(writer.write(segment, ['フェザーステップのブーツ', 'ここ'], 'replace')).toBe(true);
    expect(data(segment)).toEqual(['フェザーステップのブーツ', ' ', '  ', 'ここ']);
    writer.restore({ sliced: false });
    expect(data(segment)).toEqual(['Feather', 'step ', ' boots ', 'here']);
  });

  it.each(DISPLAY_MODES)('never empties a link and never moves an element (%s)', (mode) => {
    const p = must(
      mount('<p>Read <a href="/guide">the guide</a> before <em>the fight</em>.</p>')
        .firstElementChild,
    );
    const elements = [...p.children];
    const places = elements.map((element) => [...p.childNodes].indexOf(element));
    const writer = createWriter(document);
    expect(
      writer.write(only(p), ['先に', '手引き', 'を読んでから', '戦い', 'に挑む。'], mode),
    ).toBe(true);
    for (const [i, element] of elements.entries()) {
      expect(element.parentNode).toBe(p);
      expect([...p.childNodes].indexOf(element)).toBe(places[i]);
      expect(element.textContent).not.toBe('');
    }
  });

  it('keeps the text of a node whose translation came back empty', () => {
    const p = must(mount('<p>Phase <a href="#phase-2">2</a> begins now</p>').firstElementChild);
    const writer = createWriter(document);
    expect(writer.write(only(p), ['フェーズ', '', 'が今始まる'], 'replace')).toBe(true);
    expect(must(p.querySelector('a')).textContent).toBe('2');
  });

  it.each(DISPLAY_MODES)(
    'refuses to write when the page changed a node since the scan (%s)',
    (mode) => {
      const p = must(mount('<p>Open the <a href="#map">map</a> now</p>').firstElementChild);
      const segment = only(p);
      const writer = createWriter(document);
      // Pieces that do not match the text tokens are refused too.
      expect(writer.write(segment, ['開く'], mode)).toBe(false);
      must(segment.nodes[1]).data = 'chart';
      expect(writer.write(segment, ['開く', '地図', '今すぐ'], mode)).toBe(false);
      expect(data(segment)).toEqual(['Open the ', 'chart', ' now']);
      expect(boxesIn(p)).toEqual([]);
      expect(writer.size()).toBe(0);
      expect(writer.changed(must(segment.nodes[0]))).toBe('unknown');
    },
  );

  it('keeps the page value on restore when the page rewrote a translated node', () => {
    const root = mount('<p>3 comments</p><p>Reply to the thread</p>');
    const [first, second] = [...root.querySelectorAll('p')].map(only);
    const writer = createWriter(document);
    expect(writer.write(must(first), ['3 件のコメント'], 'replace')).toBe(true);
    expect(writer.write(must(second), ['スレッドに返信'], 'replace')).toBe(true);
    const counted = must(must(first).nodes[0]);
    const replied = must(must(second).nodes[0]);
    counted.data = '4 comments';
    expect(writer.changed(counted)).toBe('page');
    // The record is dropped: the node is the page's from now on.
    expect(writer.changed(counted)).toBe('unknown');
    // A rewrite nobody asked about is kept too.
    replied.data = 'Reply now';
    writer.restore({ sliced: false });
    expect(counted.data).toBe('4 comments');
    expect(replied.data).toBe('Reply now');
  });

  it('drops the box of a paragraph whose every node the page rewrote', () => {
    const p = must(mount('<p>3 comments</p>').firstElementChild);
    const segment = only(p);
    const writer = createWriter(document);
    expect(writer.write(segment, ['3 件のコメント'], 'pair')).toBe(true);
    must(segment.nodes[0]).data = '4 comments';
    expect(writer.changed(must(segment.nodes[0]))).toBe('page');
    expect(boxesIn(p)).toEqual([]);
    expect(writer.size()).toBe(0);
  });

  it.each(DISPLAY_MODES)('reports its own writes as ours (%s)', (mode) => {
    const root = mount('<p>Save the file</p><p>Close the window</p>');
    const [saved, other] = [...root.querySelectorAll('p')].map(only);
    const writer = createWriter(document);
    expect(writer.write(must(saved), ['ファイルを保存'], mode)).toBe(true);
    expect(writer.changed(must(must(saved).nodes[0]))).toBe('ours');
    expect(writer.changed(must(must(other).nodes[0]))).toBe('unknown');
  });

  it('shows the translation below the original in pair mode without changing the text', () => {
    const p = must(mount('<p>Follow the <a href="/river">river</a></p>').firstElementChild);
    const link = must(p.querySelector('a'));
    const text = p.textContent;
    const writer = createWriter(document);
    expect(writer.write(only(p), ['川に沿って', '進む'], 'pair')).toBe(true);
    expect(p.textContent).toBe(text);
    const [box] = boxesIn(p);
    // After the link the paragraph ends with, never inside it.
    expect(p.lastChild).toBe(must(box));
    expect(must(box).previousSibling).toBe(link);
    // The space next to the link is kept, as in the page.
    expect(shown(must(box))).toBe('川に沿って 進む');
  });

  it('shows kept names and code in the box and its spaces, in token order', () => {
    const p = must(
      mount(
        '<p>She guards the <span translate="no">Glimmerdeep</span> lantern, then types <code>/dodge-roll</code> to escape.</p>',
      ).firstElementChild,
    );
    const segment = only(p);
    expect(segment.tokens).toEqual([
      { t: 'text', text: 'She guards the' },
      { t: 'space' },
      { t: 'keep', n: 1, text: 'Glimmerdeep' },
      { t: 'space' },
      { t: 'text', text: 'lantern, then types' },
      { t: 'space' },
      { t: 'keep', n: 2, text: '/dodge-roll' },
      { t: 'space' },
      { t: 'text', text: 'to escape.' },
    ]);
    const writer = createWriter(document);
    expect(
      writer.write(segment, ['彼女が守る', 'ランタン。そして入力する', 'で逃げる。'], 'pair'),
    ).toBe(true);
    const expected = '彼女が守る Glimmerdeep ランタン。そして入力する /dodge-roll で逃げる。';
    expect(shown(must(boxesIn(p)[0]))).toBe(expected);
    expect(writer.translationText(p)).toBe(expected);
  });

  it('gives kept text and spaces in the tooltip of a paragraph with no box, and none twice', () => {
    const button = must(
      mount(
        '<button type="button">Press <kbd>R2</kbd> to block, then <samp>OK</samp> shows</button>',
      ).firstElementChild,
    );
    const writer = createWriter(document);
    // An empty piece leaves no double space.
    expect(writer.write(only(button), ['押す', '', '表示'], 'pair')).toBe(true);
    expect(boxesIn(button)).toEqual([]);
    expect(writer.translationText(button)).toBe('押す R2 OK 表示');
  });

  it('keeps the boxes of one paragraph in document order after its last node', () => {
    const links = Array.from(
      { length: 14 },
      (_, i) => `<a href="#chapter-${i}">Chapter ${i} notes</a>`,
    ).join(' ');
    const p = must(mount(`<p>${links}\n</p>`).firstElementChild);
    // More markers than one unit takes: one text-only segment per link, all ending at the '\n'.
    const segments = segmentsOf(p, undefined, ids());
    expect(segments).toHaveLength(14);
    const last = must(p.lastChild);
    for (const segment of segments) expect(segment.last).toBe(last);
    const writer = createWriter(document);
    // Out of order: 0, 5, 10, 1, 6, 11, …
    for (let i = 0; i < segments.length; i += 1) {
      const segment = must(segments[(i * 5) % segments.length]);
      expect(writer.write(segment, translated(segment), 'pair')).toBe(true);
    }
    expect(boxesIn(p).map(shown)).toEqual(segments.map((segment) => translated(segment).join('')));
    expect(must(boxesIn(p)[0]).previousSibling).toBe(last);
  });

  it('switches replace → pair → replace and still restores the exact DOM', () => {
    const shadow = loadArticle();
    const before = fingerprint(document.body);
    const segments = scanAll(document.body);
    const clock = manualTimers();
    const writer = createWriter(document, { timers: clock.timers, sliceNodes: 10 });
    for (const segment of segments)
      expect(writer.write(segment, translated(segment), 'replace')).toBe(true);
    const replaced = fingerprint(document.body);
    const boxes = (): number => boxesIn(document.body).length + boxesIn(shadow).length;

    writer.setMode('pair');
    // In slices: the first one runs at once, the rest after the page had its turn.
    expect(boxes()).toBeGreaterThan(0);
    expect(boxes()).toBeLessThan(segments.length);
    while (clock.runNext());
    expect(boxes()).toBe(boxed(segments).length);
    for (const segment of segments) expect(data(segment)).toEqual(segment.originals);

    writer.setMode('replace');
    while (clock.runNext());
    expect(boxes()).toBe(0);
    expect(fingerprint(document.body)).toBe(replaced);
    expect(clock.delays.length).toBeGreaterThan(2);
    expect(clock.delays.every((ms) => ms === 0)).toBe(true);

    writer.restore({ sliced: false });
    expect(fingerprint(document.body)).toBe(before);
  });

  it('keeps a selection inside the same nodes across write and restore', () => {
    const root = mount('<p>Click <a href="#go">here</a> to start</p><p>Nothing else</p>');
    const [p, other] = root.querySelectorAll('p');
    const segment = only(must(p));
    const here = must(segment.nodes[1]);
    const rest = must(textNodes(must(other))[0]);
    const selection = must(document.getSelection());
    const writer = createWriter(document);

    selection.setBaseAndExtent(here, 1, rest, 3);
    expect(writer.write(segment, ['クリック', 'ここを押して', '始める'], 'replace')).toBe(true);
    expect([selection.anchorNode, selection.anchorOffset]).toEqual([here, mapOffset(1, 4, 6)]);
    expect([selection.focusNode, selection.focusOffset]).toEqual([rest, 3]);

    writer.restore({ sliced: false });
    expect([selection.anchorNode, selection.anchorOffset]).toEqual([here, mapOffset(2, 6, 4)]);
    expect([selection.focusNode, selection.focusOffset]).toEqual([rest, 3]);

    // Backwards, inside one node.
    selection.setBaseAndExtent(here, 3, here, 1);
    expect(writer.write(segment, ['クリック', 'ここを押して', '始める'], 'replace')).toBe(true);
    expect([selection.anchorNode, selection.anchorOffset]).toEqual([here, mapOffset(3, 4, 6)]);
    expect([selection.focusNode, selection.focusOffset]).toEqual([here, mapOffset(1, 4, 6)]);
  });

  it('restores detached nodes too, in slices of sliceNodes', () => {
    const line = (i: number): string => `Line ${i} of the log`;
    const root = mount(Array.from({ length: 1200 }, (_, i) => `<p>${line(i)}</p>`).join(''));
    const paragraphs = [...root.querySelectorAll('p')];
    const segments = paragraphs.map(only);
    const clock = manualTimers();
    // The default slice: 500 nodes.
    const writer = createWriter(document, { timers: clock.timers });
    for (const segment of segments)
      expect(writer.write(segment, translated(segment), 'replace')).toBe(true);
    for (const p of paragraphs.slice(0, 100)) p.remove();
    const nodes = segments.map((segment) => must(segment.nodes[0]));
    const restored = (): number => nodes.filter((node, i) => node.data === line(i)).length;
    let done = 0;

    writer.restore({ sliced: true, done: () => (done += 1) });
    expect(restored()).toBe(500);
    expect(done).toBe(0);
    expect(writer.size()).toBe(0);
    expect(clock.runNext()).toBe(true);
    expect(restored()).toBe(1000);
    expect(clock.runNext()).toBe(true);
    expect(restored()).toBe(1200);
    expect(done).toBe(1);
    expect(clock.runNext()).toBe(false);
    expect(clock.delays).toEqual([0, 0]);
    expect(paragraphs.slice(0, 100).some((p) => p.isConnected)).toBe(false);
  });

  it('restores everything at once without slices, finishing a sliced restore first', () => {
    const line = (i: number): string => `Entry ${i} of the list`;
    const root = mount(Array.from({ length: 5 }, (_, i) => `<p>${line(i)}</p>`).join(''));
    const segments = [...root.querySelectorAll('p')].map(only);
    const clock = manualTimers();
    const writer = createWriter(document, { timers: clock.timers, sliceNodes: 2 });
    for (const segment of segments) writer.write(segment, translated(segment), 'pair');
    for (const segment of segments) writer.write(segment, translated(segment), 'replace');
    const finished: string[] = [];

    writer.restore({ sliced: true, done: () => finished.push('sliced') });
    expect(finished).toEqual([]);
    // `pagehide` into the bfcache: everything now, in this task.
    writer.restore({ sliced: false, done: () => finished.push('now') });
    expect(finished).toEqual(['sliced', 'now']);
    expect(segments.map((segment) => must(segment.nodes[0]).data)).toEqual(
      segments.map((_, i) => line(i)),
    );
    expect(clock.runNext()).toBe(false);
  });

  it('writes a paragraph again over its own translation', () => {
    const p = must(mount('<p>Open the <a href="#door">door</a></p>').firstElementChild);
    const segment = only(p);
    const writer = createWriter(document);
    expect(writer.write(segment, ['開ける', '扉を'], 'replace')).toBe(true);
    expect(writer.write(segment, ['開ける', '扉を'], 'pair')).toBe(true);
    expect(data(segment)).toEqual(['Open the ', 'door']);
    expect(boxesIn(p)).toHaveLength(1);
    expect(writer.write(segment, ['開ける', '扉を'], 'replace')).toBe(true);
    expect(data(segment)).toEqual(['開ける ', '扉を']);
    expect(boxesIn(p)).toEqual([]);
    expect(writer.size()).toBe(1);
    writer.restore({ sliced: false });
    expect(data(segment)).toEqual(['Open the ', 'door']);
  });

  it('replaces the box of a paragraph the page re-rendered', () => {
    const p = must(mount('<p>Loading the next page</p>').firstElementChild);
    const writer = createWriter(document);
    expect(writer.write(only(p), ['次のページを読み込み中'], 'pair')).toBe(true);
    // The page swaps the text node and leaves the box.
    must(p.firstChild).replaceWith('Loaded the next page');
    expect(boxesIn(p)).toHaveLength(1);
    expect(writer.write(only(p), ['次のページを読み込みました'], 'pair')).toBe(true);
    expect(boxesIn(p).map(shown)).toEqual(['次のページを読み込みました']);
    expect(writer.size()).toBe(1);
  });

  it('finds the translated paragraph of a node and the original text of its block', () => {
    const root = mount(
      '<div id="note">Patch notes:<br>Version 1.3 lowered her health.</div>' +
        '<p id="tip">Roll <a href="#roll">backward</a>, then press <kbd>R2</kbd>.</p>' +
        '<p id="other">Nothing here was written.</p>',
    );
    const note = must(root.querySelector('#note'));
    const tip = must(root.querySelector('#tip'));
    const other = must(root.querySelector('#other'));
    const notes = segmentsOf(note, undefined, ids());
    expect(notes).toHaveLength(2);
    const roll = only(tip);
    const writer = createWriter(document);
    for (const segment of [...notes, roll])
      expect(writer.write(segment, translated(segment), 'replace')).toBe(true);
    expect(writer.size()).toBe(3);

    const link = must(tip.querySelector('a'));
    const kept = must(tip.querySelector('kbd'));
    for (const node of [must(roll.nodes[0]), link, must(link.firstChild), kept, tip])
      expect(writer.segmentOf(node)).toBe(roll);
    expect(writer.segmentOf(note)).toBe(notes[0]);
    expect(writer.segmentOf(must(must(notes[1]).nodes[0]))).toBe(notes[1]);
    expect(writer.segmentOf(other)).toBeUndefined();
    expect(writer.segmentOf(must(other.firstChild))).toBeUndefined();
    expect(writer.originalText(tip)).toBe('Roll backward, then press R2.');
    expect(writer.originalText(note)).toBe('Patch notes:\nVersion 1.3 lowered her health.');
    expect(writer.originalText(other)).toBeUndefined();

    writer.restore({ sliced: false });
    expect(writer.size()).toBe(0);
    expect(writer.segmentOf(tip)).toBeUndefined();
    expect(writer.originalText(tip)).toBeUndefined();
  });

  it('cuts the original text of a block at 300 characters', () => {
    const p = must(mount(`<p>${'Long words go on. '.repeat(30)}</p>`).firstElementChild);
    const segment = only(p);
    const writer = createWriter(document);
    expect(writer.write(segment, translated(segment), 'replace')).toBe(true);
    const text = must(writer.originalText(p));
    expect(Array.from(text)).toHaveLength(300);
    expect(text.startsWith('Long words go on. Long')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
  });

  it('gives back the rest of a paragraph when a later write takes some of its nodes', () => {
    const p = must(
      mount('<p>Feather<wbr>step <img src="/boots.png" alt=""> boots <a href="#b">here</a></p>')
        .firstElementChild,
    );
    const clock = manualTimers();
    const writer = createWriter(document, { timers: clock.timers });
    const first = only(p);
    // Made-up Latin "translations", so the page text scanned again still needs translating.
    expect(writer.write(first, ['Plumapaso botas', 'aqui'], 'replace')).toBe(true);
    const link = must(first.nodes[3]);
    link.data = 'there';
    expect(writer.changed(link)).toBe('page');
    // Scanned again without `release`: 'step ' and ' boots ' hold only whitespace now.
    const again = only(p);
    expect(again.nodes).toEqual([first.nodes[0], link]);
    expect(writer.write(again, ['Plumapaso botas', 'alli'], 'replace')).toBe(true);
    writer.setMode('pair');
    while (clock.runNext());
    expect(p.textContent).toBe('Featherstep  boots there');
    writer.restore({ sliced: false });
    expect(data(first)).toEqual(['Feather', 'step ', ' boots ', 'there']);
  });

  it('tells the original text from what was recorded, not from a scan over the translation', () => {
    const p = must(mount('<p>Open the <a href="#door">door</a> now</p>').firstElementChild);
    const writer = createWriter(document);
    const first = only(p);
    expect(writer.write(first, ['Abre', 'puerta', 'ya'], 'replace')).toBe(true);
    const tail = must(first.nodes[2]);
    tail.data = ' later';
    expect(writer.changed(tail)).toBe('page');
    const again = only(p);
    expect(writer.write(again, ['Abre', 'puerta', 'luego'], 'replace')).toBe(true);
    expect(writer.originalText(p)).toBe('Open the door later');
  });

  it('releases a block: its nodes get their original data back and the other blocks stay', () => {
    const root = mount(
      '<div id="run">Feather<wbr>step <img src="/x.png" alt=""> boots <a href="#b">here</a>' +
        '<br>\n  Second line of the note\n</div>' +
        '<p id="kept">Keep this one translated</p><div id="host">Light words of the host</div>',
    );
    const run = must(root.querySelector('#run'));
    const kept = must(root.querySelector('#kept'));
    const host = must(root.querySelector('#host'));
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = 'Shadow words <b>of the</b> widget';
    const before = { root: fingerprint(root), run: fingerprint(run), shadow: fingerprint(shadow) };
    const segments = scanAll(root);
    expect(segments).toHaveLength(5);
    const writer = createWriter(document);
    // The run (P23 whitespace) replaced, a box in the block and one in the shadow root.
    const modes = ['replace', 'pair', 'replace', 'replace', 'pair'] as const;
    for (const [i, segment] of segments.entries())
      expect(writer.write(segment, translated(segment), modes[i] ?? 'replace')).toBe(true);
    expect(boxesIn(run)).toHaveLength(1);
    expect(boxesIn(shadow)).toHaveLength(1);
    const translatedKept = fingerprint(kept);

    writer.release(run);
    expect(fingerprint(run)).toBe(before.run);
    expect(writer.size()).toBe(3);
    expect(writer.segmentOf(run)).toBeUndefined();
    expect(writer.originalText(run)).toBeUndefined();
    for (const node of textNodes(run)) expect(writer.changed(node)).toBe('unknown');
    expect(fingerprint(kept)).toBe(translatedKept);

    // A shadow root and its host's own children are released apart.
    writer.release(shadow);
    expect(fingerprint(shadow)).toBe(before.shadow);
    expect(writer.size()).toBe(2);
    expect(writer.originalText(host)).toBe('Light words of the host');
    writer.release(host);
    expect(writer.size()).toBe(1);

    writer.restore({ sliced: false });
    expect(fingerprint(root)).toBe(before.root);
  });

  it('styles the box from inside its shadow root, where page CSS cannot reach', () => {
    const p = must(mount('<p>Follow the river</p>').firstElementChild);
    const writer = createWriter(document);
    expect(writer.write(only(p), ['川に沿って進む'], 'pair')).toBe(true);
    const shadow = must(must(boxesIn(p)[0]).shadowRoot);
    const rules = [...must(shadow.querySelector('style')?.sheet).cssRules].filter(
      (rule) => rule instanceof CSSStyleRule,
    );
    const declared = (rule: CSSStyleRule): string[] =>
      Array.from({ length: rule.style.length }, (_, i) => rule.style.item(i));
    // The host only holds its place, against any page rule that reaches it.
    const host = must(rules.find((rule) => rule.selectorText === ':host'));
    expect(
      declared(host).every((name) => /^(?:display|margin|padding|border)(?:-|$)/u.test(name)),
    ).toBe(true);
    for (const { name, value } of [
      { name: 'display', value: 'block' },
      { name: 'margin', value: '0px' },
      { name: 'padding', value: '0px' },
      { name: 'border', value: '0px' },
    ]) {
      expect(host.style.getPropertyValue(name)).toBe(value);
      expect(host.style.getPropertyPriority(name)).toBe('important');
    }
    // The look is on the element inside, which holds the translation.
    const inner = must(rules.find((rule) => rule !== host));
    expect(must(shadow.querySelector(inner.selectorText)).textContent).toBe('川に沿って進む');
    expect(inner.style.getPropertyValue('border-left')).toBe('3px solid rgb(58, 122, 254)');
    expect(inner.style.getPropertyValue('padding-left')).toBe('8px');
    expect(inner.style.getPropertyValue('margin')).toBe('2px 0px 10px');
    expect(inner.style.getPropertyValue('font-size')).toBe('0.9em');
  });

  it.each([
    { name: 'a button', html: '<button type="button">Post the comment</button>' },
    { name: 'a summary', html: '<details><summary>Show the hidden notes</summary></details>' },
    { name: 'a card link', html: '<a class="card" href="/next"><div>Meet the next boss</div></a>' },
  ])('shows no box for a paragraph in $name and keeps its text in pair mode', ({ html }) => {
    const root = mount(html);
    const before = fingerprint(root);
    const [segment, ...rest] = scanAll(root);
    expect(rest).toEqual([]);
    const clock = manualTimers();
    const writer = createWriter(document, { timers: clock.timers });
    expect(writer.write(must(segment), translated(must(segment)), 'pair')).toBe(true);
    expect(fingerprint(root)).toBe(before);
    expect(writer.changed(must(must(segment).nodes[0]))).toBe('ours');
    expect(writer.segmentOf(must(must(segment).nodes[0]))).toBe(segment);
    writer.setMode('replace');
    while (clock.runNext());
    expect(data(must(segment))).toEqual(translated(must(segment)));
    writer.setMode('pair');
    while (clock.runNext());
    expect(fingerprint(root)).toBe(before);
  });

  it('keeps what the page wrote when the display changes', () => {
    const root = mount('<p>Open the <a href="#door">door</a> now</p><p>3 comments</p>');
    const [doorP, countP] = [...root.querySelectorAll('p')];
    const door = only(must(doorP));
    const count = only(must(countP));
    const clock = manualTimers();
    const writer = createWriter(document, { timers: clock.timers });
    expect(writer.write(door, translated(door), 'replace')).toBe(true);
    expect(writer.write(count, translated(count), 'replace')).toBe(true);
    must(door.nodes[2]).data = ' later';
    must(count.nodes[0]).data = '4 comments';
    writer.setMode('pair');
    while (clock.runNext());
    expect(data(door)).toEqual(['Open the ', 'door', ' later']);
    expect(boxesIn(must(doorP))).toHaveLength(1);
    expect(writer.changed(must(door.nodes[2]))).toBe('unknown');
    // Every node of this one is the page's: no box for it.
    expect(must(countP).textContent).toBe('4 comments');
    expect(boxesIn(must(countP))).toEqual([]);
    expect(writer.size()).toBe(1);
  });

  it('cancels a pending display change on restore', () => {
    const root = mount(
      Array.from({ length: 6 }, (_, i) => `<p>Step ${i} of the guide</p>`).join(''),
    );
    const before = fingerprint(root);
    const segments = [...root.querySelectorAll('p')].map(only);
    const clock = manualTimers();
    const writer = createWriter(document, { timers: clock.timers, sliceNodes: 2 });
    for (const segment of segments) writer.write(segment, translated(segment), 'replace');
    writer.setMode('pair');
    expect(boxesIn(root).length).toBeLessThan(segments.length);
    writer.restore({ sliced: false });
    expect(fingerprint(root)).toBe(before);
    expect(clock.runNext()).toBe(false);
    expect(fingerprint(root)).toBe(before);
  });

  it('finishes a sliced restore before a write, which then refuses a paragraph scanned over the translation', () => {
    const line = (i: number): string => `Entry ${i} of the list`;
    const root = mount(Array.from({ length: 5 }, (_, i) => `<p>${line(i)}</p>`).join(''));
    const paragraphs = [...root.querySelectorAll('p')];
    const clock = manualTimers();
    const writer = createWriter(document, { timers: clock.timers, sliceNodes: 2 });
    for (const [i, p] of paragraphs.entries())
      expect(writer.write(only(p), [`Entrada ${i} de la lista`], 'replace')).toBe(true);
    const again = paragraphs.map(only);
    let done = 0;
    writer.restore({ sliced: true, done: () => (done += 1) });
    expect(done).toBe(0);
    expect(writer.write(must(again[4]), ['Entrada'], 'replace')).toBe(false);
    expect(done).toBe(1);
    expect(paragraphs.map((p) => p.textContent)).toEqual(paragraphs.map((_, i) => line(i)));
    expect(clock.runNext()).toBe(false);
  });

  it('gives the translation of a paragraph in a button, whose text pair mode leaves alone', () => {
    const button = must(
      mount('<button type="button"><span>Post</span> the comment</button>').firstElementChild,
    );
    const writer = createWriter(document);
    expect(writer.write(only(button), ['投稿', 'コメントを'], 'pair')).toBe(true);
    expect(button.textContent).toBe('Post the comment');
    expect(boxesIn(button)).toEqual([]);
    // Joined in token order, from the block or from an element inside the paragraph.
    expect(writer.translationText(button)).toBe('投稿 コメントを');
    expect(writer.translationText(must(button.querySelector('span')))).toBe('投稿 コメントを');
  });

  it('gives the translation of replaced paragraphs, joined as the original text is', () => {
    const root = mount(
      '<p id="roll">Roll <a href="#roll">backward</a> to dodge</p>' +
        '<div id="note">Patch notes:<br>Version 1.3 lowered her health.</div>',
    );
    const roll = must(root.querySelector('#roll'));
    const note = must(root.querySelector('#note'));
    const writer = createWriter(document);
    expect(writer.write(only(roll), ['後ろに', '転がって', '避ける'], 'replace')).toBe(true);
    const [notes, version] = segmentsOf(note, undefined, ids());
    expect(writer.write(must(notes), ['パッチノート：'], 'replace')).toBe(true);
    expect(writer.write(must(version), ['バージョン 1.3 で体力が下がった。'], 'replace')).toBe(
      true,
    );
    expect(writer.translationText(roll)).toBe('後ろに 転がって 避ける');
    expect(writer.translationText(must(roll.querySelector('a')))).toBe('後ろに 転がって 避ける');
    expect(writer.translationText(note)).toBe('パッチノート：\nバージョン 1.3 で体力が下がった。');
  });

  it('gives no translation for an element outside any translated paragraph', () => {
    const root = mount('<p id="done">Save the file</p><p id="other">Nothing was written here</p>');
    const done = must(root.querySelector('#done'));
    const writer = createWriter(document);
    expect(writer.write(only(done), ['ファイルを保存'], 'replace')).toBe(true);
    expect(writer.translationText(must(root.querySelector('#other')))).toBeUndefined();
    expect(writer.translationText(root)).toBeUndefined();
    writer.restore({ sliced: false });
    expect(writer.translationText(done)).toBeUndefined();
  });
});

describe('mapOffset', () => {
  it.each([
    { name: '先頭', offset: 0, oldLength: 10, newLength: 4, expected: 0 },
    { name: '末尾', offset: 10, oldLength: 10, newLength: 4, expected: 4 },
    { name: '途中', offset: 5, oldLength: 10, newLength: 4, expected: 2 },
  ])('mapOffset: $name', ({ offset, oldLength, newLength, expected }) => {
    expect(mapOffset(offset, oldLength, newLength)).toBe(expected);
  });
});
