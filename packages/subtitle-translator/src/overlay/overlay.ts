import { isJapanese } from '../captions/tracks.ts';
import type { DisplayMode } from '../settings.ts';
import type { SubtitleSource } from './source.ts';

/**
 * What the overlay shows. `lang` is the language of `source` (the caption track's or the
 * speech's): a Japanese source is shown in the Japanese row, alone. `jaDim` marks `ja` as the
 * previous sentence's translation, shown dimmed while this one waits for its own. `endedAt` is set
 * on the audio path only: when the speech of the line ended (`performance.timeOrigin +
 * performance.now()`, ms).
 */
export type OverlayView = Readonly<{
  display: DisplayMode;
  source?: string;
  ja?: string;
  lang?: string;
  jaDim?: boolean;
  endedAt?: number;
}>;

/**
 * The pill: a small label at the top right of the overlay. It shows `message` (as text) when there
 * is one and is hidden otherwise; Task 10 turns it into the display toggle.
 */
export type PillState = Readonly<{
  source: SubtitleSource;
  state: 'active' | 'pause' | 'away' | 'stopped' | 'error';
  display: DisplayMode;
  message?: string;
  latencyMs?: number;
}>;

export type OverlayHandle = {
  render(this: void, view: OverlayView): void;
  status(this: void, pill: PillState): void;
  unmount(this: void): void;
};

/** On the player while the overlay shows subtitles: YouTube's own captions are hidden then. */
const ON = 'data-st-on';
const PAGE_STYLE = `#movie_player[${ON}] .ytp-caption-window-container { display: none }`;
const PAGE_STYLE_MARK = 'data-st-style';

/**
 * Inside the shadow root, so the page's styles do not reach it and it reaches nothing of the
 * page. The host covers the player and is the size container: text follows the player's height.
 * It lets every click through to the player.
 */
const STYLE = `
:host {
  all: initial;
  position: absolute;
  inset: 0;
  z-index: 40;
  pointer-events: none;
  container-type: size;
}
[hidden] { display: none !important; }
.lines {
  position: absolute;
  left: 4%;
  right: 4%;
  bottom: max(54px, 9cqh);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25em;
  text-align: center;
}
.row {
  max-width: 100%;
  padding: 0.1em 0.45em;
  border-radius: 0.25em;
  background: rgb(8 8 8 / 0.75);
  color: #fff;
  font-family: Roboto, 'Noto Sans JP', 'Hiragino Sans', sans-serif;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.source { font-size: max(14px, 3.2cqh); }
.ja { font-size: max(18px, 4.6cqh); font-weight: 500; }
.ja[data-dim] { opacity: 0.55; }
.pill {
  position: absolute;
  top: 12px;
  right: 12px;
  max-width: 60%;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgb(8 8 8 / 0.7);
  color: #fff;
  font: 500 13px / 1.4 Roboto, 'Noto Sans JP', 'Hiragino Sans', sans-serif;
}
.pill[data-state='error'] { background: rgb(150 30 30 / 0.85); }
`;

type Rows = { source: string; ja: string; dim: boolean };

/** The text of each row under the display mode; an empty row is hidden. */
function rowsOf(view: OverlayView): Rows {
  const japanese = view.lang !== undefined && isJapanese(view.lang);
  const source = view.source ?? '';
  const ja = view.ja ?? '';
  // Japanese speech or a Japanese track needs no translation: its source is the Japanese row.
  const own = source === '' ? ja : source;
  const dim = !japanese && ja !== '' && view.jaDim === true;
  switch (view.display) {
    case 'off':
      return { source: '', ja: '', dim: false };
    case 'source':
      return { source, ja: '', dim: false };
    case 'ja':
      return japanese ? { source: '', ja: own, dim: false } : { source: '', ja, dim };
    case 'both':
      return japanese ? { source: '', ja: own, dim: false } : { source, ja, dim };
  }
}

/**
 * Draws the subtitles over `player` (YouTube's `#movie_player`) in a shadow root (closed unless
 * `mode` says otherwise; tests read an open one): the source line small on top, the Japanese line
 * large below. Text is written as text, and only what changed is written: rendering the same view
 * on every video frame touches nothing. While the display is not `off` and the pill names a
 * source, the player carries `data-st-on`, which the one style added to the page uses to hide
 * YouTube's own captions. When a view with `endedAt` brings a new line on screen, the host's
 * `data-st-latency` gets how long after the speech ended it was shown (ms, by `now`).
 */
export function mountOverlay(
  player: HTMLElement,
  {
    mode = 'closed',
    now = () => performance.timeOrigin + performance.now(),
  }: { mode?: ShadowRootMode; now?: () => number } = {},
): OverlayHandle {
  const doc = player.ownerDocument;
  const element = (className: string): HTMLDivElement => {
    const made = doc.createElement('div');
    made.className = className;
    made.hidden = true;
    return made;
  };
  const host = doc.createElement('div');
  host.setAttribute('data-st-overlay', '');
  const root = host.attachShadow({ mode });
  const style = doc.createElement('style');
  style.textContent = STYLE;
  const lines = element('lines');
  const sourceRow = element('row source');
  sourceRow.setAttribute('data-row', 'source');
  const jaRow = element('row ja');
  jaRow.setAttribute('data-row', 'ja');
  jaRow.lang = 'ja';
  lines.append(sourceRow, jaRow);
  const pill = element('pill');
  pill.setAttribute('data-pill', '');
  root.append(style, lines, pill);
  player.append(host);

  let pageStyle: HTMLStyleElement | undefined;
  if (!doc.querySelector(`style[${PAGE_STYLE_MARK}]`)) {
    pageStyle = doc.createElement('style');
    pageStyle.setAttribute(PAGE_STYLE_MARK, '');
    pageStyle.textContent = PAGE_STYLE;
    (doc.head ?? doc.documentElement).append(pageStyle);
  }

  const shown: Rows & { lang: string } = { source: '', ja: '', dim: false, lang: '' };
  let display: DisplayMode = 'off';
  let source: SubtitleSource | undefined;
  let on = false;
  let pillText = '';
  let pillState = '';

  const hide = (target: HTMLElement, hidden: boolean): void => {
    if (target.hidden !== hidden) target.hidden = hidden;
  };
  function write(row: HTMLElement, text: string): void {
    row.textContent = text;
    hide(row, text === '');
  }
  function follow(): void {
    const next = display !== 'off' && (source === 'captions' || source === 'audio');
    if (next === on) return;
    on = next;
    player.toggleAttribute(ON, on);
  }

  return {
    render(view) {
      const rows = rowsOf(view);
      const fresh =
        (rows.source !== '' && rows.source !== shown.source) ||
        (rows.ja !== '' && !rows.dim && (rows.ja !== shown.ja || shown.dim));
      display = view.display;
      hide(lines, view.display === 'off');
      if (rows.source !== shown.source) write(sourceRow, rows.source);
      if (rows.ja !== shown.ja) write(jaRow, rows.ja);
      if (rows.dim !== shown.dim) jaRow.toggleAttribute('data-dim', rows.dim);
      const lang = view.lang ?? '';
      if (lang !== shown.lang) {
        if (lang === '') sourceRow.removeAttribute('lang');
        else sourceRow.setAttribute('lang', lang);
      }
      Object.assign(shown, rows, { lang });
      if (fresh && view.endedAt !== undefined)
        host.setAttribute('data-st-latency', String(Math.round(now() - view.endedAt)));
      follow();
    },
    status(next) {
      source = next.source;
      const text = next.message ?? '';
      if (text !== pillText) {
        pill.textContent = text;
        pillText = text;
      }
      hide(pill, text === '');
      if (next.state !== pillState) {
        pill.setAttribute('data-state', next.state);
        pillState = next.state;
      }
      follow();
    },
    unmount() {
      host.remove();
      pageStyle?.remove();
      if (on) player.removeAttribute(ON);
      on = false;
    },
  };
}
