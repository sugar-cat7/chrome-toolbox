// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  mountOverlay,
  type OverlayHandle,
  type OverlayView,
  type PillState,
} from '../../src/overlay/overlay.ts';
import { NO_SOURCE_MESSAGE } from '../../src/overlay/source.ts';

const HIDE_RULE = '#movie_player[data-st-on] .ytp-caption-window-container { display: none }';

let mounted: OverlayHandle | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  document.body.replaceChildren();
  document.head.replaceChildren();
});

function setup({ now = () => 0 }: { now?: () => number } = {}) {
  const player = document.createElement('div');
  player.id = 'movie_player';
  document.body.append(player);
  const overlay = mountOverlay(player, { mode: 'open', now });
  mounted = overlay;
  const host = player.querySelector('[data-st-overlay]');
  const root = host?.shadowRoot;
  if (!(host instanceof HTMLElement) || !root) throw new Error('no overlay');
  const visible = (element: Element | null): boolean => {
    for (let node = element; node && node !== host; node = node.parentElement)
      if (node instanceof HTMLElement && node.hidden) return false;
    return element !== null;
  };
  return {
    player,
    host,
    root,
    overlay,
    /** The text of each row on screen, top first. */
    rows: () =>
      [...root.querySelectorAll('[data-row]')].filter(visible).map((row) => row.textContent ?? ''),
    row: (name: 'source' | 'ja') => root.querySelector(`[data-row="${name}"]`),
    pill: () => root.querySelector('[data-pill]'),
    pillVisible: () => visible(root.querySelector('[data-pill]')),
  };
}

const captions: PillState = { source: 'captions', state: 'active', display: 'both' };

describe('subtitle overlay', () => {
  it.each([
    { display: 'both', lang: 'en', rows: ['Okay chat', 'よしチャット'] },
    { display: 'ja', lang: 'en', rows: ['よしチャット'] },
    { display: 'source', lang: 'en', rows: ['Okay chat'] },
    { display: 'off', lang: 'en', rows: [] },
    { display: 'both', lang: 'ja', rows: ['よし行くぞ'] },
    { display: 'ja', lang: 'ja', rows: ['よし行くぞ'] },
  ] as const)('overlay renders $display for $lang', ({ display, lang, rows }) => {
    const { overlay, rows: shown } = setup();
    const view: OverlayView =
      lang === 'ja'
        ? { display, lang, source: 'よし行くぞ', ja: 'よし行くぞ' }
        : { display, lang, source: 'Okay chat', ja: 'よしチャット' };
    overlay.render(view);
    expect(shown()).toEqual(rows);
  });

  it('puts the source line small on top and the Japanese line large below', () => {
    const { root, overlay, row } = setup();
    overlay.render({ display: 'both', lang: 'en', source: 'Okay chat', ja: 'よしチャット' });
    const rows = [...root.querySelectorAll('[data-row]')];
    expect(rows).toEqual([row('source'), row('ja')]);
    expect(row('source')?.getAttribute('lang')).toBe('en');
    expect(row('ja')?.getAttribute('lang')).toBe('ja');
    const css = root.querySelector('style')?.textContent ?? '';
    expect(css).toContain('font-size: max(14px, 3.2cqh)');
    expect(css).toContain('font-size: max(18px, 4.6cqh)');
    expect(css).toContain('container-type: size');
  });

  it('shows a Japanese source alone in the Japanese row', () => {
    const { overlay, rows, row } = setup();
    overlay.render({ display: 'both', lang: 'ja-JP', source: 'よし行くぞ' });
    expect(rows()).toEqual(['よし行くぞ']);
    expect(row('ja')?.textContent).toBe('よし行くぞ');
  });

  it('shows only the source while the translation is pending', () => {
    const { overlay, rows } = setup();
    overlay.render({ display: 'both', lang: 'en', source: 'Okay chat' });
    expect(rows()).toEqual(['Okay chat']);
    overlay.render({ display: 'ja', lang: 'en', source: 'Okay chat' });
    expect(rows()).toEqual([]);
  });

  it('dims a Japanese line that belongs to the previous sentence', () => {
    const { overlay, rows, row } = setup();
    overlay.render({ display: 'both', lang: 'en', source: 'Next', ja: '前の訳', jaDim: true });
    expect(rows()).toEqual(['Next', '前の訳']);
    expect(row('ja')?.hasAttribute('data-dim')).toBe(true);
    overlay.render({ display: 'both', lang: 'en', source: 'Next', ja: '次の訳' });
    expect(row('ja')?.hasAttribute('data-dim')).toBe(false);
  });

  it('skips DOM writes when the same view is rendered twice', () => {
    const { player, root, overlay } = setup();
    const view: OverlayView = {
      display: 'both',
      lang: 'en',
      source: 'Okay chat',
      ja: 'よしチャット',
      endedAt: 0,
    };
    overlay.status(captions);
    overlay.render(view);
    const observer = new MutationObserver(() => undefined);
    const options = { subtree: true, childList: true, characterData: true, attributes: true };
    observer.observe(root, options);
    observer.observe(player, options);
    observer.observe(document.head, options);
    overlay.render({ ...view });
    overlay.status({ ...captions });
    expect(observer.takeRecords()).toEqual([]);
    observer.disconnect();
  });

  it('writes text, not markup', () => {
    const { root, overlay, rows } = setup();
    overlay.render({ display: 'both', lang: 'en', source: '<img src=x>', ja: '<b>訳</b>' });
    overlay.status({ ...captions, message: '<i>note</i>' });
    expect(rows()).toEqual(['<img src=x>', '<b>訳</b>']);
    expect(root.querySelector('img, b, i')).toBeNull();
  });

  it('writes the pill message as text', () => {
    const { overlay, pill, pillVisible } = setup();
    overlay.status({
      source: 'none',
      state: 'stopped',
      display: 'both',
      message: NO_SOURCE_MESSAGE,
    });
    expect(pill()?.textContent).toBe('字幕なし・Alt+Shift+S で音声字幕');
    expect(pillVisible()).toBe(true);
    expect(pill()?.getAttribute('data-state')).toBe('stopped');
    overlay.status(captions);
    expect(pillVisible()).toBe(false);
  });

  it('keeps the pill while the display is off', () => {
    const { overlay, pillVisible } = setup();
    overlay.status({ ...captions, display: 'off', message: NO_SOURCE_MESSAGE });
    overlay.render({ display: 'off', lang: 'en', source: 'Okay chat' });
    expect(pillVisible()).toBe(true);
  });

  it("hides YouTube's own captions only while subtitles show", () => {
    const { player, overlay } = setup();
    const rules = () =>
      [...document.querySelectorAll('style')].filter((style) => style.textContent === HIDE_RULE);
    expect(rules()).toHaveLength(1);
    overlay.render({ display: 'both', source: 'Okay chat' });
    expect(player.hasAttribute('data-st-on')).toBe(false);
    overlay.status(captions);
    expect(player.hasAttribute('data-st-on')).toBe(true);
    overlay.render({ display: 'off' });
    expect(player.hasAttribute('data-st-on')).toBe(false);
    overlay.render({ display: 'ja' });
    expect(player.hasAttribute('data-st-on')).toBe(true);
    overlay.status({ source: 'none', state: 'stopped', display: 'ja', message: NO_SOURCE_MESSAGE });
    expect(player.hasAttribute('data-st-on')).toBe(false);
    overlay.status(captions);
    overlay.unmount();
    mounted = undefined;
    expect(player.hasAttribute('data-st-on')).toBe(false);
    expect(player.querySelector('[data-st-overlay]')).toBeNull();
    expect(rules()).toHaveLength(0);
  });

  it('writes how long after the speech ended an audio line was shown', () => {
    let now = 10_000;
    const { host, overlay } = setup({ now: () => now });
    overlay.render({ display: 'both', lang: 'en', source: 'Okay chat', endedAt: 9_400 });
    expect(host.getAttribute('data-st-latency')).toBe('600');
    now = 11_000;
    overlay.render({ display: 'both', lang: 'en', source: 'Okay chat', endedAt: 9_400 });
    expect(host.getAttribute('data-st-latency')).toBe('600');
    overlay.render({
      display: 'both',
      lang: 'en',
      source: 'Okay chat',
      ja: 'よしチャット',
      endedAt: 9_400,
    });
    expect(host.getAttribute('data-st-latency')).toBe('1600');
    now = 13_000;
    const next = { display: 'both', lang: 'en', source: 'Next', endedAt: 12_900 } as const;
    overlay.render({ ...next, ja: 'よしチャット', jaDim: true });
    expect(host.getAttribute('data-st-latency')).toBe('100');
    // The dimmed line of the previous sentence going away shows nothing new.
    now = 16_000;
    overlay.render(next);
    expect(host.getAttribute('data-st-latency')).toBe('100');
  });

  it('writes no latency for caption lines', () => {
    const { host, overlay } = setup();
    overlay.render({ display: 'both', lang: 'en', source: 'Okay chat', ja: 'よしチャット' });
    expect(host.hasAttribute('data-st-latency')).toBe(false);
  });

  it('mounts a closed shadow root unless told otherwise', () => {
    const player = document.createElement('div');
    document.body.append(player);
    mounted = mountOverlay(player);
    const host = player.querySelector('[data-st-overlay]');
    expect(host).not.toBeNull();
    expect(host?.shadowRoot).toBeNull();
  });
});
