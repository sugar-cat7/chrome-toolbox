// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mountOverlay,
  type OverlayHandle,
  type OverlayView,
  type PillState,
} from '../../src/overlay/overlay.ts';
import { NO_SOURCE_MESSAGE } from '../../src/overlay/source.ts';
import type { DisplayMode } from '../../src/settings.ts';

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
  const onDisplay = vi.fn<(mode: DisplayMode) => void>();
  const overlay = mountOverlay(player, { mode: 'open', now, onDisplay });
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
    /** The parts of the pill on screen: the display, then the message if any. */
    pillText: () =>
      [...root.querySelectorAll('[data-pill] > *')]
        .filter(visible)
        .map((part) => part.textContent ?? ''),
    onDisplay,
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

  it('writes the pill message as text, after the display', () => {
    const { overlay, pill, pillVisible, pillText } = setup();
    overlay.status({
      source: 'none',
      state: 'stopped',
      display: 'both',
      message: NO_SOURCE_MESSAGE,
    });
    expect(pillText()).toEqual(['字幕: 併記', '字幕なし・Alt+Shift+S で音声字幕']);
    expect(pillVisible()).toBe(true);
    expect(pill()?.getAttribute('data-state')).toBe('stopped');
    overlay.status(captions);
    expect(pillVisible()).toBe(true);
    expect(pillText()).toEqual(['字幕: 併記']);
    expect(pill()?.getAttribute('data-state')).toBe('active');
  });

  it('describes the button with the message while there is one', () => {
    const { root, overlay, pill } = setup();
    overlay.status({ ...captions, message: NO_SOURCE_MESSAGE });
    const described = pill()?.getAttribute('aria-describedby') ?? '';
    expect(root.getElementById(described)?.textContent).toBe(NO_SOURCE_MESSAGE);
    overlay.status(captions);
    expect(pill()?.hasAttribute('aria-describedby')).toBe(false);
  });

  it('shows no pill until it has a state', () => {
    const { overlay, pillVisible } = setup();
    overlay.render({ display: 'both', lang: 'en', source: 'Okay chat' });
    expect(pillVisible()).toBe(false);
    overlay.status({ ...captions, state: 'pause' });
    expect(pillVisible()).toBe(true);
  });

  it('keeps the pill while the display is off, so the viewer can turn it back on', () => {
    const { overlay, pillVisible, pillText } = setup();
    overlay.status({ ...captions, state: 'away', display: 'off' });
    overlay.render({ display: 'off', lang: 'en', source: 'Okay chat' });
    expect(pillVisible()).toBe(true);
    expect(pillText()).toEqual(['字幕: オフ']);
  });

  it.each([
    { display: 'ja', label: '日本語', next: 'both' },
    { display: 'both', label: '併記', next: 'source' },
    { display: 'source', label: '原語', next: 'off' },
    { display: 'off', label: 'オフ', next: 'ja' },
  ] as const)('cycles the display from the player button: $display', ({ display, label, next }) => {
    const { overlay, pill, pillText, onDisplay } = setup();
    overlay.status({ ...captions, display });
    const button = pill();
    if (!(button instanceof HTMLButtonElement)) throw new Error('no button');
    expect(button.type).toBe('button');
    expect(pillText()).toEqual([`字幕: ${label}`]);
    expect(button.getAttribute('aria-label')).toBe(`字幕の表示を切り替え（今は${label}）`);
    button.click();
    expect(onDisplay.mock.calls).toEqual([[next]]);
  });

  it('keeps clicks, double clicks and the keys of the button from the player', () => {
    const { player, overlay, pill, onDisplay } = setup();
    overlay.status(captions);
    const button = pill();
    if (!(button instanceof HTMLButtonElement)) throw new Error('no button');
    const reached: string[] = [];
    for (const type of ['click', 'dblclick', 'keydown'])
      player.addEventListener(type, (event) => {
        reached.push(event instanceof KeyboardEvent ? `${type}:${event.key}` : type);
      });
    button.click();
    button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, composed: true }));
    for (const key of [' ', 'Enter', 'k'])
      button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }));
    // Space and Enter press the button; YouTube's other keys still reach the player.
    expect(reached).toEqual(['keydown:k']);
    expect(onDisplay).toHaveBeenCalledTimes(1);
    // A press of the mouse does not take the focus, which would keep Space from the player.
    const press = new MouseEvent('mousedown', { bubbles: true, composed: true, cancelable: true });
    button.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  it('shows the button only with the player controls or with the focus', () => {
    const { root } = setup();
    const css = (root.querySelector('style')?.textContent ?? '').replace(/\s+/gu, ' ');
    expect(css).toContain(
      ':host-context(#movie_player:not(.ytp-autohide)) .pill, .pill:focus { opacity: 1; pointer-events: auto; }',
    );
    expect(css).not.toContain(':hover');
    expect(css).toMatch(/\.pill \{[^}]*opacity: 0;[^}]*pointer-events: none;/u);
    // Only the button takes the pointer: the rest of the overlay lets every click through.
    expect(css).toMatch(/:host \{[^}]*pointer-events: none;/u);
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
