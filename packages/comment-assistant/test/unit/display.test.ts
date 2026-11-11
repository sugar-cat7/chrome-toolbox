// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { CommentCategory } from '@chrome-toolbox/extension-core';
import {
  applyAnnotations,
  clearDisplay,
  injectStyles,
  refreshAnnotations,
} from '../../src/display.ts';
import {
  defaultFilterSettings,
  filterSettingsSchema,
  modeOf,
  type FilterSettings,
} from '../../src/filters.ts';
import type { Annotation } from '../../src/protocol.ts';
import { createTwitchChat } from '../../src/sites/twitch-chat.ts';
import type { SiteAdapter } from '../../src/sites/types.ts';
import { youtubeComments } from '../../src/sites/youtube-comments.ts';
import { youtubeLiveChat } from '../../src/sites/youtube-live-chat.ts';

function load(name: string): Document {
  const html = readFileSync(path.join(import.meta.dirname, `../fixtures/${name}.html`), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.replaceChild(
    document.importNode(parsed.documentElement, true),
    document.documentElement,
  );
  return document;
}
function rootOf(adapter: SiteAdapter, doc: Document): Element {
  const root = adapter.container(doc);
  if (!root) throw new Error('fixture has no container');
  // Twitch ids are stamped on first read, as observeComments does.
  for (const node of root.children) adapter.read(node);
  return root;
}
const annotation = (
  id: string,
  category: CommentCategory,
  extra: Partial<Annotation> = {},
): Annotation => ({ id, category, state: 'done', ...extra });
const attributes = (element: Element | null | undefined): Record<string, string | null> => ({
  category: element?.getAttribute('data-ca-category') ?? null,
  mode: element?.getAttribute('data-ca-mode') ?? null,
  label: element?.getAttribute('data-ca-label') ?? null,
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe('applyAnnotations', () => {
  it.each([
    { category: 'spam', mode: 'hide', label: 'スパム' },
    { category: 'abusive', mode: 'hide', label: '攻撃的' },
    { category: 'spoiler', mode: 'blur', label: 'ネタバレ' },
    { category: 'question', mode: 'highlight', label: '質問' },
    { category: 'important', mode: 'highlight', label: '重要情報' },
    { category: 'chatter', mode: 'show', label: '雑談' },
    // R62: the genre categories, removed by default and labelled in Japanese.
    { category: 'instruction', mode: 'hide', label: '指示' },
    { category: 'relay', mode: 'hide', label: '他配信の話題' },
    { category: 'ghosting', mode: 'hide', label: 'ゴースティング' },
    { category: 'privacy', mode: 'hide', label: 'プライバシー' },
    { category: 'sensitive', mode: 'hide', label: 'センシティブ' },
  ] as const)('applies $mode to $category by default', ({ category, mode, label }) => {
    const doc = load('youtube-live-chat');
    const root = rootOf(youtubeLiveChat, doc);
    applyAnnotations(
      root,
      youtubeLiveChat,
      [annotation('fixture-live-01', category)],
      defaultFilterSettings,
    );
    expect(attributes(doc.getElementById('fixture-live-01'))).toEqual({ category, mode, label });
  });

  it('shows a comment the viewer marked as fine whatever the filters say', () => {
    const doc = load('youtube-live-chat');
    const root = rootOf(youtubeLiveChat, doc);
    applyAnnotations(
      root,
      youtubeLiveChat,
      [annotation('fixture-live-01', 'spam')],
      defaultFilterSettings,
    );
    expect(doc.getElementById('fixture-live-01')?.getAttribute('data-ca-mode')).toBe('hide');
    applyAnnotations(
      root,
      youtubeLiveChat,
      [annotation('fixture-live-01', 'chatter', { override: 'show' })],
      { ...defaultFilterSettings, modes: { ...defaultFilterSettings.modes, chatter: 'hide' } },
    );
    expect(attributes(doc.getElementById('fixture-live-01'))).toEqual({
      category: 'chatter',
      mode: 'show',
      label: '雑談',
    });
  });

  it('ignores annotations for messages that are no longer shown', () => {
    const doc = load('youtube-live-chat');
    const root = rootOf(youtubeLiveChat, doc);
    expect(() =>
      applyAnnotations(root, youtubeLiveChat, [annotation('gone', 'spam')], defaultFilterSettings),
    ).not.toThrow();
    expect(root.querySelectorAll('[data-ca-mode]')).toHaveLength(0);
  });

  /** The text nodes under `holder`, with whether each sits inside a kept link or mention. */
  const textsOf = (holder: Element, keep: string): { data: string; kept: boolean }[] => {
    const walker = holder.ownerDocument.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
    const texts: { data: string; kept: boolean }[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const kept = node.parentElement?.closest(keep);
      texts.push({ data: node.textContent ?? '', kept: Boolean(kept && holder.contains(kept)) });
    }
    return texts;
  };

  it.each([
    { fixture: 'youtube-live-chat', adapter: youtubeLiveChat, id: 'fixture-live-02', kept: [] },
    {
      fixture: 'youtube-comments',
      adapter: youtubeComments,
      id: 'FixtureThread02',
      kept: ['2:15'],
    },
    {
      fixture: 'twitch-chat',
      adapter: createTwitchChat('s1'),
      id: 's1-2',
      kept: ['@FixtureUserOne'],
    },
    {
      fixture: 'twitch-chat',
      adapter: createTwitchChat('s1'),
      id: 's1-3',
      kept: ['https://example.com/fixture-notes'],
    },
  ])(
    '$fixture $id: translates only plain text, keeps links and mentions, restores exactly',
    ({ fixture, adapter, id, kept }) => {
      const doc = load(fixture);
      const root = rootOf(adapter, doc);
      const message = adapter.messageElement(root, id);
      const holder = message && adapter.textElement(message);
      if (!holder) throw new Error('fixture changed');
      const original = holder.innerHTML;
      const elements = [...holder.querySelectorAll('*')];
      const translated = annotation(id, 'chatter', { translation: '訳した文' });

      applyAnnotations(root, adapter, [translated], defaultFilterSettings);
      const texts = textsOf(holder, adapter.keep);
      // The translation sits in plain text only, once; link and mention text is untouched.
      expect(texts.filter(({ data }) => data === '訳した文')).toEqual([
        { data: '訳した文', kept: false },
      ]);
      expect(texts.filter((text) => text.kept).map(({ data }) => data)).toEqual(kept);
      // Every other plain text is emptied or blank.
      expect(
        texts
          .filter((text) => !text.kept && text.data !== '訳した文')
          .map(({ data }) => data.trim()),
      ).toEqual(texts.filter((text) => !text.kept && text.data !== '訳した文').map(() => ''));
      expect(holder.hasAttribute('data-ca-translated')).toBe(true);
      // Links, emoji images and mention spans stay the same nodes.
      expect([...holder.querySelectorAll('*')]).toEqual(elements);

      applyAnnotations(root, adapter, [translated], {
        ...defaultFilterSettings,
        showOriginal: true,
      });
      expect(holder.innerHTML).toBe(original);
      expect(holder.hasAttribute('data-ca-translated')).toBe(false);

      // Translating again after a restore still keeps the first original.
      applyAnnotations(root, adapter, [translated], defaultFilterSettings);
      applyAnnotations(root, adapter, [translated], { ...defaultFilterSettings, translate: false });
      expect(holder.innerHTML).toBe(original);
    },
  );

  it('leaves a comment of links and mentions only in the original', () => {
    const doc = load('twitch-chat');
    const adapter = createTwitchChat('s1');
    const root = rootOf(adapter, doc);
    const message = adapter.messageElement(root, 's1-2');
    const holder = message && adapter.textElement(message);
    holder?.querySelector('.text-fragment')?.remove();
    const original = holder?.innerHTML;
    applyAnnotations(
      root,
      adapter,
      [annotation('s1-2', 'chatter', { translation: '訳' })],
      defaultFilterSettings,
    );
    expect(holder?.innerHTML).toBe(original);
    expect(holder?.hasAttribute('data-ca-translated')).toBe(false);
  });

  it.each([
    {
      name: 'a mention',
      id: 's1-2',
      translation: '@FixtureUserOne はい、この後すぐ',
      expected: 'はい、この後すぐ',
    },
    {
      name: 'a mention in other letter case',
      id: 's1-2',
      translation: 'はい、 @fixtureuserone この後すぐ',
      expected: 'はい、 この後すぐ',
    },
    {
      name: 'a link',
      id: 's1-3',
      translation: 'メモはここ https://example.com/fixture-notes',
      expected: 'メモはここ',
    },
  ])(
    'takes $name the translation repeats out of it: the kept element shows it once (R38)',
    ({ id, translation, expected }) => {
      const doc = load('twitch-chat');
      const adapter = createTwitchChat('s1');
      const root = rootOf(adapter, doc);
      const message = adapter.messageElement(root, id);
      const holder = message && adapter.textElement(message);
      if (!holder) throw new Error('fixture changed');
      const kept = [...holder.querySelectorAll(adapter.keep)].map((element) => element.textContent);
      applyAnnotations(
        root,
        adapter,
        [annotation(id, 'chatter', { translation })],
        defaultFilterSettings,
      );
      // The kept element is the only copy of its text; the translation fills the plain text.
      expect(
        [...holder.querySelectorAll(adapter.keep)].map((element) => element.textContent),
      ).toEqual(kept);
      expect(
        textsOf(holder, adapter.keep).find(({ kept: inKept, data }) => !inKept && data.trim()),
      ).toEqual({
        data: expected,
        kept: false,
      });
      for (const text of kept) expect(holder.textContent?.split(text ?? '')).toHaveLength(2);
      expect(holder.hasAttribute('data-ca-translated')).toBe(true);
    },
  );

  it.each([
    // Only whole: a kept text never cuts a longer word or number (R40).
    { kept: ['1:00'], translation: '11:00から配信', expected: '11:00から配信' },
    { kept: ['1:00'], translation: '1:00から配信', expected: 'から配信' },
    { kept: ['@Rin'], translation: '@Ring へ', expected: '@Ring へ' },
    { kept: ['@ann'], translation: '@anna へ', expected: '@anna へ' },
    // Two overlapping names: each is taken whole.
    { kept: ['@ann', '@anna'], translation: '@anna と @ann へ', expected: 'と へ' },
    { kept: ['@anna', '@ann'], translation: '@ann と @anna へ', expected: 'と へ' },
    // Regular expression characters in a name are plain characters.
    { kept: ['@a.b(c)*'], translation: '@a.b(c)* はい', expected: 'はい' },
    { kept: ['@a.b(c)*'], translation: '@axb(c)* はい', expected: '@axb(c)* はい' },
    { kept: ['@[x]+'], translation: 'ok @[x]+', expected: 'ok' },
    // Japanese right after a Latin name is a word boundary.
    { kept: ['@FixtureUserOne'], translation: '@FixtureUserOneさん、はい', expected: 'さん、はい' },
  ])(
    'takes the kept $kept out of $translation only where it stands alone',
    ({ kept, translation, expected }) => {
      const doc = load('twitch-chat');
      const adapter = createTwitchChat('s1');
      const root = rootOf(adapter, doc);
      const message = adapter.messageElement(root, 's1-2');
      const holder = message && adapter.textElement(message);
      const mention = holder?.querySelector('.mention-fragment');
      if (!holder || !mention) throw new Error('fixture changed');
      const [first, ...more] = kept;
      mention.textContent = first ?? '';
      for (const text of more) {
        const copy = mention.cloneNode(false);
        copy.textContent = text;
        mention.after(copy);
      }
      applyAnnotations(
        root,
        adapter,
        [annotation('s1-2', 'chatter', { translation })],
        defaultFilterSettings,
      );
      expect(
        textsOf(holder, adapter.keep).find(({ kept: inKept, data }) => !inKept && data.trim()),
      ).toEqual({ data: expected, kept: false });
    },
  );

  it('leaves the original when the translation is nothing but the kept mention (R38)', () => {
    const doc = load('twitch-chat');
    const adapter = createTwitchChat('s1');
    const root = rootOf(adapter, doc);
    const message = adapter.messageElement(root, 's1-2');
    const holder = message && adapter.textElement(message);
    const original = holder?.innerHTML;
    applyAnnotations(
      root,
      adapter,
      [annotation('s1-2', 'chatter', { translation: ' @FixtureUserOne ' })],
      defaultFilterSettings,
    );
    expect(holder?.innerHTML).toBe(original);
    expect(holder?.hasAttribute('data-ca-translated')).toBe(false);
  });

  it.each(['', '   '])('treats the translation %j as none', (translation) => {
    const doc = load('youtube-live-chat');
    const root = rootOf(youtubeLiveChat, doc);
    const holder = doc.querySelector('#fixture-live-01 #message');
    const original = holder?.innerHTML;
    applyAnnotations(
      root,
      youtubeLiveChat,
      [annotation('fixture-live-01', 'chatter', { translation })],
      defaultFilterSettings,
    );
    expect(holder?.innerHTML).toBe(original);
    expect(holder?.hasAttribute('data-ca-translated')).toBe(false);
  });

  it('never overwrites text the site changed after the translation', () => {
    const doc = load('youtube-live-chat');
    const root = rootOf(youtubeLiveChat, doc);
    const holder = doc.querySelector('#fixture-live-01 #message');
    const translated = annotation('fixture-live-01', 'chatter', { translation: '訳' });
    applyAnnotations(root, youtubeLiveChat, [translated], defaultFilterSettings);
    // The site rewrites the line (Twitch shows "message deleted", for instance).
    if (holder?.firstChild) holder.firstChild.textContent = 'rewritten by the site';
    applyAnnotations(root, youtubeLiveChat, [translated], {
      ...defaultFilterSettings,
      showOriginal: true,
    });
    expect(holder?.textContent).toBe('rewritten by the site');
    // The site's new text is the original from then on.
    applyAnnotations(root, youtubeLiveChat, [translated], defaultFilterSettings);
    expect(holder?.textContent).toBe('訳');
    clearDisplay(root);
    expect(holder?.textContent).toBe('rewritten by the site');
  });

  it('clearDisplay takes every attribute and translation off the comments', () => {
    const doc = load('twitch-chat');
    const adapter = createTwitchChat('s1');
    const root = rootOf(adapter, doc);
    const original = root.innerHTML.replaceAll(/ data-ca-id="[^"]*"/gu, '');
    applyAnnotations(
      root,
      adapter,
      [
        annotation('s1-1', 'spam'),
        annotation('s1-3', 'question', { translation: 'メモはここ' }),
        annotation('s1-5', 'spoiler'),
      ],
      defaultFilterSettings,
    );
    adapter.messageElement(root, 's1-1')?.setAttribute('data-ca-revealed', '');
    root.lastElementChild?.setAttribute('data-ca-wait', '');
    clearDisplay(root);
    expect(root.querySelectorAll('*')).not.toHaveLength(0);
    expect(
      [...root.querySelectorAll('*')].flatMap((element) =>
        element.getAttributeNames().filter((name) => name.startsWith('data-ca-')),
      ),
    ).toEqual([]);
    expect(root.innerHTML).toBe(original);
  });

  it('renders a translation as text, never as markup', () => {
    const doc = load('youtube-live-chat');
    const root = rootOf(youtubeLiveChat, doc);
    const markup = '<img src="x" onerror="alert(1)"><b>bold</b>';
    applyAnnotations(
      root,
      youtubeLiveChat,
      [annotation('fixture-live-01', 'chatter', { translation: markup })],
      defaultFilterSettings,
    );
    const holder = doc.querySelector('#fixture-live-01 #message');
    expect(holder?.textContent).toBe(markup);
    expect(holder?.querySelector('img, b')).toBeNull();
  });

  it('refreshAnnotations re-applies remembered annotations under new filters', () => {
    const doc = load('twitch-chat');
    const adapter = createTwitchChat('s1');
    const root = rootOf(adapter, doc);
    const remembered = new Map([
      ['s1-1', annotation('s1-1', 'question')],
      ['s1-3', annotation('s1-3', 'spoiler', { translation: 'メモはここ' })],
    ]);
    applyAnnotations(root, adapter, [...remembered.values()], defaultFilterSettings);
    const filters: FilterSettings = {
      ...defaultFilterSettings,
      showOriginal: true,
      modes: { ...defaultFilterSettings.modes, question: 'show', spoiler: 'hide' },
    };
    refreshAnnotations(root, adapter, (id) => remembered.get(id), filters);
    expect(adapter.messageElement(root, 's1-1')?.getAttribute('data-ca-mode')).toBe('show');
    const spoiler = adapter.messageElement(root, 's1-3');
    expect(spoiler?.getAttribute('data-ca-mode')).toBe('hide');
    expect(spoiler && adapter.textElement(spoiler)?.textContent).toBe(
      'notes are here https://example.com/fixture-notes',
    );
    // Lines without an annotation stay untouched.
    expect(adapter.messageElement(root, 's1-2')?.hasAttribute('data-ca-mode')).toBe(false);
  });
});

describe('display cost (R45)', () => {
  it('marks only concealed lines with data-ca-conceal, and takes it off when they are shown', () => {
    const doc = load('youtube-live-chat');
    const root = rootOf(youtubeLiveChat, doc);
    const filters: FilterSettings = {
      ...defaultFilterSettings,
      modes: {
        ...defaultFilterSettings.modes,
        spam: 'hide',
        spoiler: 'blur',
        question: 'highlight',
      },
    };
    applyAnnotations(
      root,
      youtubeLiveChat,
      [
        annotation('fixture-live-01', 'spam'),
        annotation('fixture-live-02', 'spoiler'),
        annotation('fixture-live-03', 'question'),
        annotation('fixture-live-05', 'chatter'),
      ],
      filters,
    );
    const conceal = (id: string): string | null | undefined =>
      doc.getElementById(id)?.getAttribute('data-ca-conceal');
    expect(
      ['fixture-live-01', 'fixture-live-02', 'fixture-live-03', 'fixture-live-05'].map(conceal),
    ).toEqual(['hide', 'blur', null, null]);
    applyAnnotations(
      root,
      youtubeLiveChat,
      [annotation('fixture-live-02', 'chatter', { override: 'show' })],
      filters,
    );
    expect(conceal('fixture-live-02')).toBeNull();
    expect(doc.getElementById('fixture-live-02')?.getAttribute('data-ca-mode')).toBe('show');
  });

  it("conceals a line as a labelled bar of its colour, and styles a line's children only through data-ca-conceal", () => {
    const doc = load('youtube-live-chat');
    onTestFinished(injectStyles(doc));
    const rules = (doc.querySelector('style')?.textContent ?? '').split('\n');
    // A filter on many lines saturates rendering (926 ms/s of main thread at 50 lines a second),
    // and a blurred text shadow took the GPU process 1.39 times what shown lines took: a concealed
    // line is a bar of its category's colour with a label (R51).
    expect(rules.filter((rule) => /filter\s*:|text-shadow/u.test(rule))).toEqual([]);
    const blurred = rules.filter((rule) => rule.startsWith('[data-ca-conceal="blur"]'));
    expect(blurred).toEqual([
      expect.stringMatching(
        /^\[data-ca-conceal="blur"\]:not\(\[data-ca-revealed\]\)\{position:relative;background:var\(--ca-color\)!important;cursor:pointer\}$/u,
      ),
      // Hidden children keep the line's height, are not hit-tested (a click lands on the line)
      // and leave the accessibility tree: text, images, badges and link underlines alike.
      '[data-ca-conceal="blur"]:not([data-ca-revealed])>*{visibility:hidden!important}',
      expect.stringMatching(
        /^\[data-ca-conceal="blur"\]:not\(\[data-ca-revealed\]\)::before\{content:"伏せたコメント（" attr\(data-ca-label\) "）· クリックで表示";/u,
      ),
    ]);
    // The label lies over the bar out of the flow: concealing and revealing never change the
    // line's height. It is drawn in its bar's own opaque ink, whatever the page's colours.
    expect(blurred[2]?.slice(blurred[2].indexOf(';') + 1, -1)).toBe(
      'position:absolute;inset:0;display:flex;align-items:center;padding:2px 4px;font-size:12px;color:var(--ca-ink)!important;cursor:pointer;overflow:hidden;white-space:nowrap',
    );
    // Writing data-ca-mode on every annotated line then restyles no line's children.
    const selectors = rules.map((rule) => rule.slice(0, rule.indexOf('{')));
    const reaching = selectors.filter((selector) =>
      /[> ]|::/u.test(selector.replace(/\[[^\]]*\]/gu, '')),
    );
    expect(reaching.length).toBeGreaterThan(0);
    expect(
      reaching.filter(
        (selector) =>
          !/^\[data-ca-conceal="(?:hide|blur)"\]|^\[data-ca-translated\]/u.test(selector),
      ),
    ).toEqual([]);
  });

  it('removes a line set to 消す from the chat: no box and no label (R54)', () => {
    const doc = load('youtube-live-chat');
    onTestFinished(injectStyles(doc));
    const rules = (doc.querySelector('style')?.textContent ?? '').split('\n');
    // The whole line goes, and nothing stands in for it.
    expect(rules.filter((rule) => rule.startsWith('[data-ca-conceal="hide"]'))).toEqual([
      '[data-ca-conceal="hide"]{display:none!important}',
    ]);
    expect(rules.filter((rule) => rule.includes('非表示'))).toEqual([]);
  });

  it('labels each bar in an opaque ink with at least 4.5:1 contrast, in light and dark pages', () => {
    const doc = load('youtube-live-chat');
    onTestFinished(injectStyles(doc));
    const rules = (doc.querySelector('style')?.textContent ?? '').split('\n');
    /** WCAG 2 relative luminance of `#rrggbb`. */
    const luminance = (hex: string): number => {
      const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => {
        const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string): number => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
    };
    const categories = [
      'abusive',
      'spam',
      'spoiler',
      'question',
      'important',
      'chatter',
      // R62: the genre categories.
      'instruction',
      'relay',
      'ghosting',
      'privacy',
      'sensitive',
    ];
    const inks = categories.map((category) => {
      const rule = rules.find((line) => line.startsWith(`[data-ca-category="${category}"]{`));
      const color = /--ca-color:(#[\da-f]{6})/u.exec(rule ?? '')?.[1];
      const ink = /--ca-ink:(#[\da-f]{6})/u.exec(rule ?? '')?.[1];
      return { category, color, ink };
    });
    // Both are fixed colours, so the page's light or dark scheme changes neither.
    const hex = /^#[\da-f]{6}$/u;
    expect(
      inks.filter(
        ({ color, ink }) =>
          !hex.test(color ?? '') || !hex.test(ink ?? '') || contrast(color ?? '', ink ?? '') < 4.5,
      ),
    ).toEqual([]);
    expect(inks).toHaveLength(11);
    // Each category its own colour, far enough from every other to tell them apart (at least 60
    // in RGB distance), so a concealed bar says which category it is.
    const rgb = (hex: string): number[] =>
      [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
    const close = inks.flatMap((a, i) =>
      inks.slice(i + 1).flatMap((b) => {
        const [ra, rb] = [rgb(a.color ?? ''), rgb(b.color ?? '')];
        const distance = Math.hypot(...ra.map((value, k) => value - (rb[k] ?? 0)));
        return distance < 60 ? [`${a.category}/${b.category}`] : [];
      }),
    );
    expect(close).toEqual([]);
    // The label shows that ink as it is: no opacity of its own.
    const label = rules.find((rule) =>
      rule.startsWith('[data-ca-conceal="blur"]:not([data-ca-revealed])::before'),
    );
    expect(label).toContain('color:var(--ca-ink)!important');
    expect(label).not.toContain('opacity');
  });

  it('compiles the pattern of each kept text once', () => {
    const doc = load('twitch-chat');
    const adapter = createTwitchChat('s1');
    const root = rootOf(adapter, doc);
    const message = adapter.messageElement(root, 's1-2');
    const mention = message && adapter.textElement(message)?.querySelector('.mention-fragment');
    if (!mention) throw new Error('fixture changed');
    // A name no other test keeps: the compiled patterns outlive a test.
    mention.textContent = '@PatternProbeViewer';
    const sources: string[] = [];
    vi.stubGlobal(
      'RegExp',
      class extends RegExp {
        constructor(pattern: string | RegExp, flags?: string) {
          super(pattern, flags);
          sources.push(String(pattern));
        }
      },
    );
    for (const translation of [
      '@PatternProbeViewer はい',
      '@PatternProbeViewer そう',
      'はい @PatternProbeViewer',
    ]) {
      applyAnnotations(
        root,
        adapter,
        [annotation('s1-2', 'chatter', { translation })],
        defaultFilterSettings,
      );
      // The kept mention shows its name once, the translation without it.
      expect(adapter.textElement(message)?.textContent?.split('@PatternProbeViewer')).toHaveLength(
        2,
      );
    }
    expect(sources.filter((source) => source.includes('PatternProbeViewer'))).toHaveLength(1);
  });
});

describe('injectStyles', () => {
  it('adds one style element and reveals a concealed comment on click until cleanup', () => {
    const doc = load('youtube-live-chat');
    const root = rootOf(youtubeLiveChat, doc);
    const stop = injectStyles(doc);
    expect(doc.querySelectorAll('style')).toHaveLength(1);
    const css = doc.querySelector('style')?.textContent ?? '';
    expect(css).not.toContain('非表示');
    // A line waiting for its judgement takes no room until it comes in (R52).
    expect(css.split('\n')).toContain('[data-ca-wait]{display:none!important}');
    // ... and the list holding it does not slide (YouTube moves its list to slide a line in).
    expect(css.split('\n')).toContain('[data-ca-holding]{transform:none!important}');
    applyAnnotations(
      root,
      youtubeLiveChat,
      [annotation('fixture-live-01', 'spam'), annotation('fixture-live-03', 'spoiler')],
      defaultFilterSettings,
    );
    const hidden = doc.getElementById('fixture-live-01');
    const blurred = doc.getElementById('fixture-live-03');
    hidden?.querySelector('#message')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    blurred?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // A removed line (消す) is not revealed in the chat: the side panel puts it back (R54).
    expect(hidden?.getAttribute('data-ca-conceal')).toBe('hide');
    expect(hidden?.hasAttribute('data-ca-revealed')).toBe(false);
    expect(blurred?.hasAttribute('data-ca-revealed')).toBe(true);

    stop();
    expect(doc.querySelectorAll('style')).toHaveLength(0);
    const later = doc.getElementById('fixture-live-05');
    applyAnnotations(
      root,
      youtubeLiveChat,
      [annotation('fixture-live-05', 'spoiler')],
      defaultFilterSettings,
    );
    later?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(later?.hasAttribute('data-ca-revealed')).toBe(false);
  });
});

describe('filter settings', () => {
  it('stores only what the viewer chose: no mode until then (R31)', () => {
    expect(defaultFilterSettings).toEqual({
      translate: true,
      showOriginal: false,
      modes: {},
      holdUntilJudged: true,
      strength: 'normal',
    });
    expect(filterSettingsSchema.safeParse(defaultFilterSettings).success).toBe(true);
    // A partial mode list is valid; a mode that is no mode is not.
    expect(
      filterSettingsSchema.safeParse({ ...defaultFilterSettings, modes: { spam: 'hide' } }).success,
    ).toBe(true);
    expect(
      filterSettingsSchema.safeParse({ ...defaultFilterSettings, modes: { spam: 'x' } }).success,
    ).toBe(false);
    // Settings saved before this change listed every category; they stay readable.
    expect(
      filterSettingsSchema.safeParse({
        translate: true,
        showOriginal: false,
        modes: {
          abusive: 'blur',
          spam: 'hide',
          spoiler: 'blur',
          question: 'highlight',
          important: 'highlight',
          chatter: 'show',
        },
      }).success,
    ).toBe(true);
  });

  it.each([
    { category: 'abusive', mode: 'hide' },
    { category: 'spam', mode: 'hide' },
    { category: 'spoiler', mode: 'blur' },
    { category: 'question', mode: 'highlight' },
    { category: 'important', mode: 'highlight' },
    { category: 'chatter', mode: 'show' },
  ] as const)(
    'shows $category as $mode by default: abusive and spam are removed from the chat (R54)',
    ({ category, mode }) => {
      expect(modeOf(defaultFilterSettings, category)).toBe(mode);
    },
  );

  it("keeps the viewer's own spam mode", () => {
    const doc = load('youtube-live-chat');
    const root = rootOf(youtubeLiveChat, doc);
    for (const mode of ['show', 'highlight', 'blur', 'hide'] as const) {
      applyAnnotations(root, youtubeLiveChat, [annotation('fixture-live-01', 'spam')], {
        ...defaultFilterSettings,
        modes: { spam: mode },
      });
      expect(doc.getElementById('fixture-live-01')?.getAttribute('data-ca-mode')).toBe(mode);
    }
  });
});
