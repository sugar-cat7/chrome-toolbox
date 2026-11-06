import { capture, captureSync, launch, Ok, type Result } from '@chrome-toolbox/contracts';
import type { Timers } from '@chrome-toolbox/extension-core';
import { BRIDGE_SOURCE, postToPage, readContentMessage, type CuesMessage } from './messages.ts';
import {
  CAPTION_LIMITS,
  LANGUAGE_CODE,
  listTracks,
  parseJson3,
  readVideo,
  VIDEO_ID,
  type CaptionTrack,
  type VideoInfo,
} from './tracks.ts';

/** How long the bridge waits for a track it asked the player for before putting CC back. */
export const LOAD_TIMEOUT_MS = 10_000;
/** The longest timedtext body the bridge reads (UTF-16 units); a longer one is left alone. */
export const MAX_BODY_LENGTH = 8_000_000;
/** Tracks remembered as posted in one visit (video, language, kind), the oldest forgotten first. */
const POSTED_KEYS = 64;
/** The player's own record of the viewer's CC choice (localStorage), put back after a load. */
const PERSISTENCE_KEY = 'yt-player-caption-persistence';
const CAPTION_KEYS = ['yt-player-caption-sticky-language', PERSISTENCE_KEY];
const LOADING = 'data-st-loading';
const HIDE_RULE = `#movie_player[${LOADING}] .ytp-caption-window-container { display: none !important; }`;

/** The page window as the bridge uses it; tests pass jsdom's window with fakes. */
export type BridgeWindow = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly XMLHttpRequest: { readonly prototype: XMLHttpRequest };
  readonly document: Document;
  readonly location: Readonly<{ origin: string; href: string }>;
  readonly localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
};

/** The part of YouTube's `#movie_player` API the bridge calls. */
type Player = {
  getPlayerResponse(): unknown;
  getOption(module: 'captions', option: 'track'): unknown;
  setOption(module: 'captions', option: 'track', value: unknown): void;
};
const isPlayer = (value: unknown): value is Player =>
  typeof value === 'object' &&
  value !== null &&
  'getPlayerResponse' in value &&
  typeof value.getPlayerResponse === 'function' &&
  'getOption' in value &&
  typeof value.getOption === 'function' &&
  'setOption' in value &&
  typeof value.setOption === 'function';

type TrackKey = Readonly<{ videoId: string; languageCode: string; kind: CaptionTrack['kind'] }>;
const keyOf = ({ videoId, languageCode, kind }: TrackKey): string =>
  `${videoId}\u0000${languageCode}\u0000${kind}`;

/** Runs page code that may throw; whether it ran. Nothing of it reaches the page's own calls. */
const attempt = (run: () => void): boolean => captureSync(run, 'unexpected_failure').ok;

/** The URL a fetch was called with. */
function requestUrl(input: unknown): string | undefined {
  if (typeof input === 'string') return input;
  if (typeof input !== 'object' || input === null) return undefined;
  if ('url' in input && typeof input.url === 'string') return input.url;
  return 'href' in input && typeof input.href === 'string' ? input.href : undefined;
}

/** A track the player shows in another language than the track's (`translationLanguage`). */
const translated = (track: object): boolean =>
  'translationLanguage' in track &&
  track.translationLanguage !== undefined &&
  track.translationLanguage !== null;

/** The body as text, or undefined once it passes `MAX_BODY_LENGTH` (the rest is not read). */
async function boundedText(response: Response): Promise<Result<string | undefined>> {
  const reader = response.body?.getReader();
  if (!reader) return Ok('');
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const chunk = await capture(() => reader.read(), 'network_failed');
    if (!chunk.ok) return chunk;
    if (chunk.value.done) return Ok(text + decoder.decode());
    text += decoder.decode(chunk.value.value, { stream: true });
    if (text.length > MAX_BODY_LENGTH) {
      // Not awaited: cancelling one branch of a cloned body settles only when the page's branch
      // is cancelled too.
      launch(
        () => reader.cancel(),
        () => undefined,
      );
      return Ok(undefined);
    }
  }
}

/** Whether the saved persistence key says the viewer keeps CC on (`{"data":"true",…}`). */
function remembersOn(saved: ReadonlyMap<string, string | null>): boolean {
  const raw = saved.get(PERSISTENCE_KEY);
  if (raw === undefined || raw === null) return false;
  const parsed = captureSync((): unknown => JSON.parse(raw), 'input_invalid');
  return (
    parsed.ok &&
    typeof parsed.value === 'object' &&
    parsed.value !== null &&
    'data' in parsed.value &&
    (parsed.value.data === 'true' || parsed.value.data === true)
  );
}

/**
 * Wraps the page's `fetch` and `XMLHttpRequest` to read the player's own json3 timedtext responses
 * (`/api/timedtext` on the page's origin, never a translation), and posts the video and cues to the
 * isolated content script. The originals are kept and called first; the page gets every response
 * as it was. On `load-track` it has the player fetch a track (`setOption`), hiding YouTube's
 * captions meanwhile, then puts the viewer's CC back. A visit (from one `yt-navigate-start` to the
 * next) posts each track once and drives the player at most once per track. Returns the
 * uninstaller (tests only).
 */
export function installBridge(
  win: BridgeWindow,
  {
    timers = { set: (fn, ms) => Number(setTimeout(fn, ms)), clear: (id) => clearTimeout(id) },
  }: {
    timers?: Timers;
  } = {},
): () => void {
  /** Tracks posted in this visit: the player can request one twice around a navigation. */
  const posted = new Set<string>();
  /** Tracks this visit had the player fetch: each once, whatever the outcome (S41). */
  const tried = new Set<string>();
  let held: CuesMessage | undefined;
  let loading: { key: string; timer: number; restore: () => void } | undefined;
  /** Waiting for the player to turn on the CC the viewer keeps on, before driving it. */
  let waiting: number | undefined;
  let style: HTMLStyleElement | undefined;

  const player = (): Player | undefined => {
    const element = win.document.getElementById('movie_player');
    return isPlayer(element) ? element : undefined;
  };
  const current = (): { player: Player; video: VideoInfo; tracks: CaptionTrack[] } | undefined => {
    const found = player();
    if (!found) return undefined;
    const response = captureSync(() => found.getPlayerResponse(), 'response_invalid');
    if (!response.ok) return undefined;
    const video = readVideo(response.value);
    const tracks = listTracks(response.value);
    return video.ok
      ? { player: found, video: video.value, tracks: tracks.ok ? tracks.value : [] }
      : undefined;
  };

  function postVideo(): VideoInfo | undefined {
    const now = current();
    if (now)
      postToPage(win, {
        source: BRIDGE_SOURCE,
        type: 'video',
        video: now.video,
        tracks: now.tracks,
      });
    return now?.video;
  }

  function timedtext(url: string): TrackKey | undefined {
    const parsed = URL.parse(url, win.location.href);
    if (parsed?.origin !== win.location.origin || parsed.pathname !== '/api/timedtext')
      return undefined;
    const query = parsed.searchParams;
    const videoId = query.get('v') ?? '';
    const languageCode = query.get('lang') ?? '';
    if (query.has('tlang') || query.get('fmt') !== 'json3') return undefined;
    if (!VIDEO_ID.test(videoId) || languageCode.length > CAPTION_LIMITS.languageCode)
      return undefined;
    if (!LANGUAGE_CODE.test(languageCode)) return undefined;
    return { videoId, languageCode, kind: query.get('kind') === 'asr' ? 'asr' : 'manual' };
  }

  function finish(): void {
    const done = loading;
    if (!done) return;
    loading = undefined;
    timers.clear(done.timer);
    done.restore();
  }

  /** A timedtext response arrived; `body` is undefined when it cannot be read as text. */
  function onResponse(track: TrackKey, body: string | undefined): void {
    const key = keyOf(track);
    const asked = loading?.key === key;
    // Restore after the player has handled the response it asked for.
    if (loading && asked) {
      timers.clear(loading.timer);
      loading.timer = timers.set(finish, 0);
    }
    if (body === undefined || body.length > MAX_BODY_LENGTH) return;
    if (posted.has(key) && !asked) return;
    const json = captureSync((): unknown => JSON.parse(body), 'input_invalid');
    const cues = json.ok ? parseJson3(json.value) : json;
    if (!cues.ok) return;
    posted.add(key);
    const oldest = posted.size > POSTED_KEYS ? posted.values().next() : undefined;
    if (oldest && !oldest.done) posted.delete(oldest.value);
    held = { source: BRIDGE_SOURCE, type: 'cues', ...track, cues: cues.value };
    postToPage(win, held);
  }

  const originalFetch = win.fetch;
  function fetch(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const pending: Promise<Response> = Reflect.apply(originalFetch, this, [input, init]);
    const url = requestUrl(input);
    const track = url === undefined ? undefined : timedtext(url);
    if (track === undefined) return pending;
    // Cloned in the first reaction, before the page can read the body.
    const copy = pending.then((response) => (response.ok ? response.clone() : undefined));
    launch(
      async () => {
        const response = await capture(() => copy, 'network_failed');
        // A failed fetch brings no response; an error status is a response without a body.
        if (!response.ok) return;
        const copied = response.value;
        const body = copied && (await boundedText(copied));
        onResponse(track, body?.ok ? body.value : undefined);
      },
      () => undefined,
    );
    return pending;
  }
  win.fetch = fetch;

  const prototype = win.XMLHttpRequest.prototype;
  // Kept by reference and called with the request as `this`.
  const originalOpen: XMLHttpRequest['open'] = Reflect.get(prototype, 'open');
  const requests = new WeakMap<XMLHttpRequest, TrackKey>();
  function onLoad(this: XMLHttpRequest): void {
    const track = requests.get(this);
    if (!track) return;
    // `responseText` throws for other response types.
    const readable = this.responseType === '' || this.responseType === 'text';
    onResponse(track, this.status === 200 && readable ? this.responseText : undefined);
  }
  function open(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]): void {
    Reflect.apply(originalOpen, this, [method, url, ...rest]);
    const track = timedtext(String(url));
    if (track === undefined) {
      requests.delete(this);
      return;
    }
    if (!requests.has(this)) this.addEventListener('load', onLoad);
    requests.set(this, track);
  }
  prototype.open = open;

  /** The localStorage value of each CC key (null when absent); undefined if storage is closed. */
  function savedKeys(): Map<string, string | null> | undefined {
    const saved = new Map<string, string | null>();
    for (const key of CAPTION_KEYS) {
      const value = captureSync(() => win.localStorage.getItem(key), 'storage_failed');
      if (!value.ok) return undefined;
      saved.set(key, value.value);
    }
    return saved;
  }
  function putBack(saved: ReadonlyMap<string, string | null>): void {
    for (const [key, value] of saved)
      attempt(() =>
        value === null ? win.localStorage.removeItem(key) : win.localStorage.setItem(key, value),
      );
  }
  function hide(on: boolean): void {
    const element = win.document.getElementById('movie_player');
    if (on && !style) {
      style = win.document.createElement('style');
      style.textContent = HIDE_RULE;
      (win.document.head ?? win.document.documentElement).append(style);
    }
    element?.toggleAttribute(LOADING, on);
  }

  /** `afterWait`: the wait for the viewer's own CC is over, so the player may be driven now. */
  function loadTrack(languageCode: string, afterWait = false): void {
    const now = current();
    if (!now || now.video.live) return;
    const target =
      now.tracks.find((track) => track.kind === 'manual' && track.languageCode === languageCode) ??
      now.tracks.find((track) => track.kind === 'asr' && track.languageCode === languageCode);
    if (!target) return;
    const key = keyOf({ videoId: now.video.videoId, languageCode, kind: target.kind });
    if (held && keyOf(held) === key) {
      if (!afterWait) postToPage(win, held);
      return;
    }
    if (loading || waiting !== undefined || tried.has(key)) return;
    const read = captureSync(() => now.player.getOption('captions', 'track'), 'response_invalid');
    const before =
      read.ok && typeof read.value === 'object' && read.value !== null ? read.value : {};
    const on = 'languageCode' in before && typeof before.languageCode === 'string';
    const shown =
      on &&
      before.languageCode === languageCode &&
      ('kind' in before && before.kind === 'asr') === (target.kind === 'asr') &&
      !translated(before);
    // The player does not fetch a track that is already on again.
    if (shown) return;
    const keys = savedKeys();
    // On a full load the player may not have turned on the CC the viewer keeps on yet; driving it
    // now would turn this video's CC off on restore. Its own request is posted as usual meanwhile.
    if (!afterWait && !on && keys && remembersOn(keys)) {
      waiting = timers.set(() => {
        waiting = undefined;
        loadTrack(languageCode, true);
      }, LOAD_TIMEOUT_MS);
      return;
    }
    tried.add(key);
    hide(true);
    const ask = target.kind === 'asr' ? { languageCode, kind: 'asr' } : { languageCode };
    const restore = () => {
      attempt(() => now.player.setOption('captions', 'track', on ? before : {}));
      if (keys) putBack(keys);
      hide(false);
    };
    if (!attempt(() => now.player.setOption('captions', 'track', ask))) {
      restore();
      return;
    }
    loading = { key, timer: timers.set(finish, LOAD_TIMEOUT_MS), restore };
  }

  function onMessage(event: MessageEvent): void {
    const message = readContentMessage(event, win);
    if (message?.type === 'load-track') loadTrack(message.languageCode);
    if (message?.type !== 'ready') return;
    const video = postVideo();
    if (held && held.videoId === video?.videoId) postToPage(win, held);
  }
  const onNavigateFinish = (): void => {
    postVideo();
  };
  /** A new visit: put CC back before the next video's player reads the viewer's setting. */
  function onNavigateStart(): void {
    finish();
    if (waiting !== undefined) timers.clear(waiting);
    waiting = undefined;
    posted.clear();
    tried.clear();
  }
  win.addEventListener('message', onMessage);
  win.document.addEventListener('yt-navigate-start', onNavigateStart);
  win.document.addEventListener('yt-navigate-finish', onNavigateFinish);
  postVideo();

  return () => {
    win.fetch = originalFetch;
    prototype.open = originalOpen;
    win.removeEventListener('message', onMessage);
    win.document.removeEventListener('yt-navigate-start', onNavigateStart);
    win.document.removeEventListener('yt-navigate-finish', onNavigateFinish);
    onNavigateStart();
    style?.remove();
  };
}
