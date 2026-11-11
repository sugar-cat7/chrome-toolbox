import { capture, launch } from '@chrome-toolbox/contracts';
import type { Timers } from '@chrome-toolbox/extension-core';

/**
 * The element that holds the tooltip and the selection bubble, in its open shadow root: like
 * `<pt-ja>`, a custom element name nobody defines.
 */
export const OVERLAY_TAG = 'pt-overlay';
/**
 * - `hoverDelayMs`: how long the pointer rests on a translated paragraph before its tooltip shows;
 * - `tooltipChars`: the longest tooltip, in code points (a longer one is cut and ends with `…`).
 */
export const OVERLAY_TIMING = { hoverDelayMs: 300, tooltipChars: 300 } as const;

/** Space between a box and what it points at, and between a box and the screen's edge (px). */
const GAP = 8;
const MARGIN = 8;
/** The width of the line around a hovered paragraph (px). */
const FRAME = 2;

const LABELS = {
  loading: '翻訳中…',
  copy: 'コピー',
  copied: 'コピーしました',
  close: '閉じる',
  bubble: '選択範囲の翻訳',
} as const;

/**
 * The overlay's look. The host only holds a fixed corner of the screen, above everything and
 * letting the pointer through, `!important` against page rules that reach it; the boxes inside
 * are out of the page's CSS. Only the bubble takes the pointer.
 */
const STYLE = `:host {
  all: initial !important;
  display: block !important;
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 0 !important;
  height: 0 !important;
  overflow: visible !important;
  z-index: 2147483647 !important;
  pointer-events: none !important;
}
.frame, .tip, .bubble {
  position: absolute;
  box-sizing: border-box;
}
/* The host has no width: a box takes its text's width, up to its maximum. */
.tip, .bubble {
  width: max-content;
}
.frame {
  border: 2px solid #3a7afe;
  border-radius: 4px;
}
.tip {
  max-width: min(360px, calc(100vw - 16px));
  padding: 6px 10px;
  border-radius: 6px;
  background: #1f2328;
  color: #fff;
  font: 13px/1.5 system-ui, sans-serif;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  box-shadow: 0 2px 8px rgb(0 0 0 / 25%);
}
.bubble {
  pointer-events: auto;
  max-width: min(420px, calc(100vw - 16px));
  max-height: 50vh;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  background: #fff;
  color: #1f2328;
  font: 14px/1.6 system-ui, sans-serif;
  box-shadow: 0 4px 16px rgb(0 0 0 / 20%);
}
.text {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.note {
  margin: 6px 0 0;
  color: #59636e;
  font-size: 12px;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 8px;
}
button {
  padding: 2px 10px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  background: #f6f8fa;
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}`;

/** A box on the screen, in viewport coordinates (`getBoundingClientRect`). */
export type Rect = Pick<DOMRectReadOnly, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>;
type Size = Readonly<{ width: number; height: number }>;
type Spot = Readonly<{ left: number; top: number }>;

/**
 * Where a box of `size` goes for `anchor` on a screen of `view`: under it, or above it when the
 * bottom has no room (at the bottom edge when neither side has), centred on it and kept inside
 * the screen's left and right edges (at the left edge when it is wider than the screen).
 */
export function placeNear(anchor: Rect, size: Size, view: Size): Spot {
  const centred = anchor.left + anchor.width / 2 - size.width / 2;
  const left = Math.max(MARGIN, Math.min(centred, view.width - size.width - MARGIN));
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - size.height;
  if (below + size.height <= view.height - MARGIN) return { left, top: below };
  if (above >= MARGIN) return { left, top: above };
  return { left, top: Math.max(MARGIN, view.height - size.height - MARGIN) };
}

/** What the selection bubble shows; `note` goes under a translation and is not copied. */
export type BubbleState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'done'; text: string; note?: string }>
  | Readonly<{ kind: 'message'; text: string }>;

export type Overlay = {
  /**
   * After `hoverDelayMs`, frames the paragraph at `rect` with a 2 px line and shows `text` (at
   * most `tooltipChars`) next to it. A new call replaces the one before.
   */
  tooltip(rect: Rect, text: string): void;
  /** Takes the tooltip away, or drops it before it shows. */
  hideTooltip(): void;
  /**
   * Shows the bubble next to the selection at `rect`, or shows `state` in the bubble already
   * there: 「コピー」 (a translation, when the page has a clipboard) and 「閉じる」. Escape, a
   * click outside it and 「閉じる」 close it.
   */
  bubble(rect: Rect, state: BubbleState): void;
  /** Whether the bubble shows (the viewer has not closed it). */
  bubbleShown(): boolean;
  /** Takes everything away; the overlay can show again later. */
  dispose(): void;
};

/** `text`, at most `limit` code points long: a longer one is cut and ends with `…`. */
function cut(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length <= limit ? text : `${points.slice(0, limit - 1).join('')}…`;
}

/**
 * The page script's tooltip and selection bubble, in a `<pt-overlay>` at the end of the html
 * element. It is on the page, and listens to it (Escape, a click outside the bubble), only while
 * it shows something.
 */
export function createOverlay(doc: Document, timers: Timers): Overlay {
  let made: Readonly<{ host: HTMLElement; root: ShadowRoot }> | undefined;
  let frame: HTMLElement | undefined;
  let tip: HTMLElement | undefined;
  let card: HTMLElement | undefined;
  let pending: number | undefined;
  let listening = false;

  function listen(on: boolean): void {
    if (on === listening) return;
    listening = on;
    if (on) {
      doc.addEventListener('keydown', onKey, { capture: true });
      doc.addEventListener('pointerdown', onPointer, { capture: true, passive: true });
    } else {
      doc.removeEventListener('keydown', onKey, { capture: true });
      doc.removeEventListener('pointerdown', onPointer, { capture: true });
    }
  }

  /** The shadow root, its host put at the end of the html element first. */
  function shown(): ShadowRoot {
    if (made === undefined) {
      const host = doc.createElement(OVERLAY_TAG);
      const root = host.attachShadow({ mode: 'open' });
      const style = doc.createElement('style');
      style.textContent = STYLE;
      root.append(style);
      made = { host, root };
    }
    if (!made.host.isConnected) doc.documentElement.append(made.host);
    listen(true);
    return made.root;
  }

  /** Off the page once it shows nothing. */
  function settle(): void {
    if (tip !== undefined || card !== undefined) return;
    made?.host.remove();
    listen(false);
  }

  /** Puts `element` by `anchor`, measured as it is now. */
  function put(element: HTMLElement, anchor: Rect): void {
    const { width, height } = element.getBoundingClientRect();
    const view = doc.defaultView;
    const spot = placeNear(
      anchor,
      { width, height },
      { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 },
    );
    element.style.left = `${spot.left}px`;
    element.style.top = `${spot.top}px`;
  }

  function showTooltip(rect: Rect, text: string): void {
    const root = shown();
    frame = doc.createElement('div');
    frame.className = 'frame';
    frame.style.left = `${rect.left - FRAME}px`;
    frame.style.top = `${rect.top - FRAME}px`;
    frame.style.width = `${rect.width + 2 * FRAME}px`;
    frame.style.height = `${rect.height + 2 * FRAME}px`;
    tip = doc.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'tooltip');
    tip.textContent = cut(text, OVERLAY_TIMING.tooltipChars);
    root.append(frame, tip);
    put(tip, rect);
  }

  function hideTooltip(): void {
    if (pending !== undefined) timers.clear(pending);
    pending = undefined;
    frame?.remove();
    tip?.remove();
    frame = undefined;
    tip = undefined;
    settle();
  }

  function closeBubble(): void {
    card?.remove();
    card = undefined;
    settle();
  }

  function button(label: string, onClick: (button: HTMLButtonElement) => void): HTMLButtonElement {
    const element = doc.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.addEventListener('click', () => onClick(element));
    return element;
  }

  /** 「コピー」: puts `text` on the clipboard and says so. */
  function copyButton(clipboard: Clipboard, text: string): HTMLButtonElement {
    return button(LABELS.copy, (element) => {
      launch(
        async () => {
          const copied = await capture(() => clipboard.writeText(text), 'unexpected_failure');
          // Refused (the page lost focus): the label stays, and another press tries again.
          if (copied.ok) element.textContent = LABELS.copied;
        },
        () => undefined,
      );
    });
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    hideTooltip();
    closeBubble();
  }

  function onPointer(event: Event): void {
    if (card !== undefined && !event.composedPath().includes(card)) closeBubble();
  }

  return {
    tooltip(rect, text) {
      hideTooltip();
      pending = timers.set(() => {
        pending = undefined;
        showTooltip(rect, text);
      }, OVERLAY_TIMING.hoverDelayMs);
    },

    hideTooltip,

    bubble(rect, state) {
      card?.remove();
      const root = shown();
      const next = doc.createElement('div');
      next.className = 'bubble';
      next.setAttribute('role', 'dialog');
      next.setAttribute('aria-label', LABELS.bubble);
      const body = doc.createElement('p');
      body.className = 'text';
      body.lang = 'ja';
      body.textContent = state.kind === 'loading' ? LABELS.loading : state.text;
      next.append(body);
      const actions = doc.createElement('div');
      actions.className = 'actions';
      if (state.kind === 'done') {
        if (state.note !== undefined) {
          const note = doc.createElement('p');
          note.className = 'note';
          note.textContent = state.note;
          next.append(note);
        }
        // `navigator.clipboard` is missing where the page is no secure context (http).
        const clipboard = doc.defaultView?.navigator.clipboard;
        if (clipboard !== undefined) actions.append(copyButton(clipboard, state.text));
      }
      actions.append(button(LABELS.close, closeBubble));
      next.append(actions);
      root.append(next);
      card = next;
      put(next, rect);
    },

    bubbleShown: () => card !== undefined,

    dispose() {
      hideTooltip();
      closeBubble();
    },
  };
}
