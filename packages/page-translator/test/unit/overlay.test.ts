// @vitest-environment jsdom
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemTimers } from '@chrome-toolbox/extension-core';
import {
  createOverlay,
  OVERLAY_TAG,
  OVERLAY_TIMING,
  placeNear,
  type Overlay,
} from '../../src/content/overlay.ts';
import { fingerprint } from './fingerprint.ts';

let overlay: Overlay | undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  overlay?.dispose();
  overlay = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
  document.body.replaceChildren();
});

/** `value`, failing the test when it is missing. */
function must<T>(value: T | null | undefined): T {
  assert.exists(value);
  return value;
}

function open(): Overlay {
  overlay = createOverlay(document, systemTimers);
  return overlay;
}

/** The overlay element, when it is on the page. */
const hostOf = (): Element | undefined =>
  [...document.documentElement.children].find((child) => child.localName === OVERLAY_TAG);
const shadow = (): ShadowRoot => must(must(hostOf()).shadowRoot);
const tip = (): Element | null => hostOf()?.shadowRoot?.querySelector('[role="tooltip"]') ?? null;
const card = (): HTMLElement | null =>
  hostOf()?.shadowRoot?.querySelector<HTMLElement>('[role="dialog"]') ?? null;
const buttons = (): string[] =>
  [...(card()?.querySelectorAll('button') ?? [])].map((button) => button.textContent);
function button(label: string): HTMLButtonElement {
  return must(
    [...(card()?.querySelectorAll('button') ?? [])].find((found) => found.textContent === label),
  );
}

const paragraph = new DOMRect(100, 200, 300, 40);
const selection = new DOMRect(120, 300, 80, 20);

describe('placeNear', () => {
  const view = { width: 1000, height: 800 };
  const size = { width: 200, height: 100 };
  it.each([
    {
      name: 'under the anchor, centred on it',
      anchor: new DOMRect(400, 100, 100, 20),
      spot: { left: 350, top: 128 },
    },
    {
      name: 'above the anchor when the bottom has no room',
      anchor: new DOMRect(400, 700, 100, 20),
      spot: { left: 350, top: 592 },
    },
    {
      name: 'inside the left edge',
      anchor: new DOMRect(0, 100, 40, 20),
      spot: { left: 8, top: 128 },
    },
    {
      name: 'inside the right edge',
      anchor: new DOMRect(960, 100, 40, 20),
      spot: { left: 792, top: 128 },
    },
    {
      name: 'at the bottom edge when neither side has room',
      anchor: new DOMRect(400, 50, 100, 700),
      spot: { left: 350, top: 692 },
    },
  ])('places a box $name', ({ anchor, spot }) => {
    expect(placeNear(anchor, size, view)).toEqual(spot);
  });

  it('keeps a box wider than the screen at its left edge', () => {
    expect(placeNear(new DOMRect(400, 100, 100, 20), { width: 1200, height: 100 }, view)).toEqual({
      left: 8,
      top: 128,
    });
  });
});

describe('createOverlay', () => {
  it('is on the page, as the last child of the html element, only while it shows something', () => {
    const before = fingerprint(document.documentElement);
    const ui = open();
    expect(hostOf()).toBeUndefined();
    ui.tooltip(paragraph, '原文：Roll backward.');
    vi.advanceTimersByTime(OVERLAY_TIMING.hoverDelayMs);
    expect(document.documentElement.lastElementChild).toBe(hostOf());
    const style = must(shadow().querySelector('style')).textContent;
    expect(style).toMatch(/:host \{[^}]*position: fixed !important/u);
    expect(style).toMatch(/:host \{[^}]*z-index: 2147483647 !important/u);
    expect(style).toMatch(/:host \{[^}]*pointer-events: none !important/u);
    ui.bubble(selection, { kind: 'message', text: '翻訳する文を選択してください' });
    ui.hideTooltip();
    expect(hostOf()).toBeDefined();
    ui.dispose();
    expect(hostOf()).toBeUndefined();
    expect(fingerprint(document.documentElement)).toBe(before);
  });

  it('shows the tooltip after the hover delay, at most 300 characters, framing the paragraph', () => {
    const ui = open();
    ui.tooltip(paragraph, `原文：${'word '.repeat(100)}`);
    vi.advanceTimersByTime(OVERLAY_TIMING.hoverDelayMs - 1);
    expect(hostOf()).toBeUndefined();
    vi.advanceTimersByTime(1);
    const text = must(must(tip()).textContent);
    expect(Array.from(text)).toHaveLength(OVERLAY_TIMING.tooltipChars);
    expect(text.startsWith('原文：word word')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    const frame = must(shadow().querySelector<HTMLElement>('.frame'));
    expect({
      left: frame.style.left,
      top: frame.style.top,
      width: frame.style.width,
      height: frame.style.height,
    }).toEqual({ left: '98px', top: '198px', width: '304px', height: '44px' });
    const style = must(shadow().querySelector('style')).textContent;
    expect(style).toMatch(/\.frame \{[^}]*border: 2px solid/u);
    // The host has no width: without its own, the tooltip would wrap at every word.
    expect(style).toMatch(/\.tip, \.bubble \{[^}]*width: max-content/u);
    // Under the paragraph: the tooltip of no size here sits at its centre, 8 px below it.
    expect(must(tip()).getAttribute('style')).toBe('left: 250px; top: 248px;');
  });

  it('drops a tooltip hidden before its delay', () => {
    const ui = open();
    ui.tooltip(paragraph, '原文：Roll backward.');
    vi.advanceTimersByTime(OVERLAY_TIMING.hoverDelayMs - 1);
    ui.hideTooltip();
    vi.advanceTimersByTime(10_000);
    expect(hostOf()).toBeUndefined();
  });

  it('places the bubble by its measured size, above the selection when the bottom has no room', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 200, 100),
    );
    const ui = open();
    ui.bubble(new DOMRect(500, window.innerHeight - 40, 100, 20), {
      kind: 'done',
      text: '後ろに転がる',
    });
    const bubble = must(card());
    expect({ left: bubble.style.left, top: bubble.style.top }).toEqual({
      left: '450px',
      top: `${window.innerHeight - 40 - 8 - 100}px`,
    });
    expect(must(shadow().querySelector('style')).textContent).toMatch(
      /\.bubble \{[^}]*pointer-events: auto/u,
    );
  });

  it.each([
    { name: 'loading', state: { kind: 'loading' } as const, text: '翻訳中…', copy: false },
    {
      name: 'a message',
      state: { kind: 'message', text: '選択した文は日本語です' } as const,
      text: '選択した文は日本語です',
      copy: false,
    },
    {
      name: 'a translation',
      state: { kind: 'done', text: '後ろに転がる' } as const,
      text: '後ろに転がる',
      copy: true,
    },
  ])('shows $name in the bubble', ({ state, text, copy }) => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve()) },
    });
    const ui = open();
    ui.bubble(selection, state);
    expect(must(card()).textContent).toContain(text);
    expect(buttons()).toEqual(copy ? ['コピー', '閉じる'] : ['閉じる']);
    expect(ui.bubbleShown()).toBe(true);
  });

  it('copies the translation without its note and says so', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const ui = open();
    ui.bubble(selection, {
      kind: 'done',
      text: '後ろに転がる',
      note: '（先頭の 2,000 文字だけを訳しました）',
    });
    expect(must(card()).textContent).toContain('（先頭の 2,000 文字だけを訳しました）');
    button('コピー').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith('後ろに転がる');
    expect(buttons()).toEqual(['コピーしました', '閉じる']);
  });

  it('offers no copy without a clipboard', () => {
    const ui = open();
    ui.bubble(selection, { kind: 'done', text: '後ろに転がる' });
    expect(buttons()).toEqual(['閉じる']);
  });

  it.each([
    {
      name: 'Escape',
      close: (): void => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      },
    },
    {
      name: 'a click outside',
      close: (): void => {
        document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      },
    },
    { name: '閉じる', close: (): void => button('閉じる').click() },
  ])('closes the bubble on $name and leaves nothing behind', ({ close }) => {
    document.body.innerHTML = '<p>Roll backward.</p>';
    const before = fingerprint(document.documentElement);
    const ui = open();
    ui.bubble(selection, { kind: 'done', text: '後ろに転がる' });
    expect(fingerprint(document.documentElement)).not.toBe(before);
    close();
    expect(ui.bubbleShown()).toBe(false);
    expect(fingerprint(document.documentElement)).toBe(before);
  });

  it('keeps the bubble on a click inside it and on other keys', () => {
    const ui = open();
    ui.bubble(selection, { kind: 'done', text: '後ろに転がる' });
    must(card()).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(ui.bubbleShown()).toBe(true);
  });

  it('hides the tooltip on Escape', () => {
    const ui = open();
    ui.tooltip(paragraph, '原文：Roll backward.');
    vi.advanceTimersByTime(OVERLAY_TIMING.hoverDelayMs);
    expect(tip()).not.toBeNull();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(hostOf()).toBeUndefined();
  });

  it('listens to the page only while it shows something', () => {
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    const ui = open();
    expect(added).not.toHaveBeenCalled();
    ui.bubble(selection, { kind: 'loading' });
    ui.tooltip(paragraph, '原文：Roll backward.');
    expect(added.mock.calls.length).toBeGreaterThan(0);
    ui.dispose();
    vi.advanceTimersByTime(10_000);
    expect(hostOf()).toBeUndefined();
    expect(removed.mock.calls.map(([type]) => type).toSorted()).toEqual(
      added.mock.calls.map(([type]) => type).toSorted(),
    );
  });
});
