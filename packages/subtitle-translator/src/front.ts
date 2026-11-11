import type { DisplayMode } from './settings.ts';

export const FRONT_STATES = ['active', 'pause', 'away'] as const;
export const FRONT_REASONS = [
  'paused',
  'muted',
  'hidden',
  'offscreen',
  'ad',
  'display-off',
] as const;

/**
 * Whether the viewer has the video in front (R44): `active` processes; `pause` (paused, ended or
 * muted) reads no new audio and sends no new translation but finishes what waits; `away` (a hidden
 * or left page, the player off screen, an ad, the display off) drops what waits. `reason` says why
 * it is not active.
 */
export type FrontState = Readonly<{
  state: (typeof FRONT_STATES)[number];
  reason?: (typeof FRONT_REASONS)[number];
}>;

export type FrontWatch = {
  /** Reads the display mode again (it was saved anew). */
  displayChanged(this: void): void;
  /** Removes every listener and observer; `onChange` is not called any more. */
  stop(this: void): void;
};

/** The video events after which it may be paused, ended, muted or playing; `waiting` is not one. */
const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'emptied', 'volumechange'] as const;

const same = (a: FrontState | undefined, b: FrontState): boolean =>
  a?.state === b.state && a.reason === b.reason;

/**
 * Follows whether the watch page has its video in front of the viewer. `away` when the tab is
 * hidden or the page was left (`pagehide`, until a `pageshow` brings it back), the player is not
 * on screen (an intersection of zero area counts as off screen; the player counts as on screen
 * until the observer first tells), YouTube shows an ad (`#movie_player.ad-showing`) or the display
 * is `off`; otherwise `pause` when the video is paused or ended, or muted (`muted` or a volume of
 * 0); otherwise `active`. Buffering does not count. `onChange` gets the state at the start and then
 * each change of state or reason. Driven by events and observers only: no timer, no polling.
 */
export function watchFront({
  doc,
  player,
  video,
  display,
  onChange,
}: {
  doc: Document;
  /** YouTube's `#movie_player`. */
  player: HTMLElement;
  video: HTMLVideoElement;
  display: () => DisplayMode;
  onChange: (state: FrontState) => void;
}): FrontWatch {
  const win = doc.defaultView;
  let left = false;
  let onScreen = true;
  let reported: FrontState | undefined;
  let stopped = false;

  function current(): FrontState {
    if (left || doc.visibilityState === 'hidden') return { state: 'away', reason: 'hidden' };
    if (!onScreen) return { state: 'away', reason: 'offscreen' };
    if (player.classList.contains('ad-showing')) return { state: 'away', reason: 'ad' };
    if (display() === 'off') return { state: 'away', reason: 'display-off' };
    if (video.paused || video.ended) return { state: 'pause', reason: 'paused' };
    if (video.muted || video.volume === 0) return { state: 'pause', reason: 'muted' };
    return { state: 'active' };
  }
  function update(): void {
    if (stopped) return;
    const next = current();
    if (same(reported, next)) return;
    reported = next;
    onChange(next);
  }
  function onPageHide(): void {
    left = true;
    update();
  }
  function onPageShow(): void {
    left = false;
    update();
  }
  function onIntersection(entries: IntersectionObserverEntry[]): void {
    const entry = entries.at(-1);
    if (entry === undefined) return;
    const { width, height } = entry.intersectionRect;
    onScreen = entry.isIntersecting && width * height > 0;
    update();
  }

  const classes = new MutationObserver(update);
  classes.observe(player, { attributes: true, attributeFilter: ['class'] });
  const screen = new IntersectionObserver(onIntersection);
  screen.observe(player);
  for (const type of MEDIA_EVENTS) video.addEventListener(type, update);
  doc.addEventListener('visibilitychange', update);
  win?.addEventListener('pagehide', onPageHide);
  win?.addEventListener('pageshow', onPageShow);
  update();

  return {
    displayChanged: update,
    stop() {
      if (stopped) return;
      stopped = true;
      classes.disconnect();
      screen.disconnect();
      for (const type of MEDIA_EVENTS) video.removeEventListener(type, update);
      doc.removeEventListener('visibilitychange', update);
      win?.removeEventListener('pagehide', onPageHide);
      win?.removeEventListener('pageshow', onPageShow);
    },
  };
}
