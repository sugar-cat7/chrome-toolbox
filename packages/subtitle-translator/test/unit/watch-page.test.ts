// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
import type { Cue } from '../../src/captions/tracks.ts';
import { AUDIO_HINT_MESSAGE, NO_SOURCE_MESSAGE } from '../../src/overlay/source.ts';
import { defaultSubtitleSettings, type DisplayMode } from '../../src/settings.ts';
import { startWatchPage } from '../../src/watch-page.ts';
import { fakeVideo } from './video.ts';
import { fakeViewport } from './viewport.ts';

const VIDEO = 'fixture-v01';
const OTHER = 'fixture-v02';
const VIDEO_INFO = {
  videoId: VIDEO,
  channelId: 'UCfixture000000000000000',
  author: 'Fixture Ch',
  title: 'Fixture Quest day 3',
  live: false,
};
const track = (languageCode: string, kind: 'asr' | 'manual') => ({
  languageCode,
  kind,
  baseUrl: `/api/timedtext?v=${VIDEO}&lang=${languageCode}`,
  name: languageCode,
  vssId: `${kind === 'asr' ? 'a' : ''}.${languageCode}`,
});
const TRACKS = [track('ja', 'manual'), track('en', 'asr')];
/** Six made-up sentences, one every 3 s, each 1.5 s long. */
const CUES: Cue[] = [
  'Okay chat.',
  'We are going in.',
  'Wish me luck.',
  'That was close.',
  'One more try.',
  'We did it.',
].map((text, i) => ({ startMs: i * 3000, endMs: i * 3000 + 1500, text }));

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const fromBridge = (data: Record<string, unknown>) =>
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { source: 'st-bridge', ...data },
      source: window,
      origin: location.origin,
    }),
  );
const tellVideo = (video: Record<string, unknown> = VIDEO_INFO, tracks: unknown[] = TRACKS) =>
  fromBridge({ type: 'video', video, tracks });
const tellCues = (over: Record<string, unknown> = {}) =>
  fromBridge({
    type: 'cues',
    videoId: VIDEO,
    languageCode: 'en',
    kind: 'asr',
    cues: CUES,
    ...over,
  });
/** Made-up sentences enough for three batches, one every 3 s. */
const MANY: Cue[] = Array.from({ length: 12 }, (_, i) => ({
  startMs: i * 3000,
  endMs: i * 3000 + 1500,
  text: `Fixture line ${i + 1}.`,
}));
/** The background saves the display the viewer chose; every tab sees the change. */
const saveDisplay = async (display: DisplayMode) => {
  await fakeBrowser.storage.local.set({ subtitles: { ...defaultSubtitleSettings, display } });
  await settle();
};
const navigate = (url: string) => {
  history.pushState({}, '', url);
  document.dispatchEvent(new CustomEvent('yt-navigate-finish'));
};

type Sent = { type: string; payload: Record<string, unknown>; target: unknown };
const isSent = (message: unknown): message is Sent =>
  typeof message === 'object' &&
  message !== null &&
  'type' in message &&
  typeof message.type === 'string' &&
  'payload' in message &&
  typeof message.payload === 'object' &&
  message.payload !== null &&
  'target' in message;

/** The service worker: `subs/page` answers at once, each `subs/translate` when the test says. */
function backend() {
  const sent: Sent[] = [];
  const waiting: { sentences: { id: string; source: string }[]; answer: (v: unknown) => void }[] =
    [];
  const send = vi.fn<(message: unknown) => Promise<unknown>>(async (message) => {
    if (!isSent(message)) return Ok({});
    sent.push(message);
    if (message.type !== 'subs/translate') return Ok({});
    const sentences = Array.isArray(message.payload.sentences) ? message.payload.sentences : [];
    return new Promise((answer) => {
      waiting.push({ sentences, answer });
    });
  });
  return {
    send,
    sent,
    of: (type: string) => sent.filter((message) => message.type === type),
    /** The sentences of each translation request so far. */
    asked: () => waiting.map(({ sentences }) => sentences.map(({ source }) => source)),
    /** Translates every sentence of request `n`. */
    async answer(n: number) {
      const call = waiting[n];
      call?.answer(
        Ok({
          lines: call.sentences.map(({ id, source }) => ({
            id,
            ja: `訳:${source}`,
            state: 'done',
          })),
        }),
      );
      await settle();
    },
  };
}

function addPlayer() {
  const player = document.createElement('div');
  player.id = 'movie_player';
  const playback = fakeVideo();
  player.append(playback.video);
  document.body.append(player);
  return { player, ...playback };
}

/** The overlay's rows on screen (its shadow root is open in tests). */
function overlay(player: Element) {
  const host = player.querySelector('[data-st-overlay]');
  const root = host?.shadowRoot;
  const visible = (element: Element | null): boolean => {
    for (let node = element; node && node !== host; node = node.parentElement)
      if (node instanceof HTMLElement && node.hidden) return false;
    return element !== null;
  };
  return {
    host,
    rows: () =>
      [...(root?.querySelectorAll('[data-row]') ?? [])]
        .filter(visible)
        .map((row) => row.textContent),
    /** The parts of the pill on screen (the display, then the message), if it shows. */
    pill: () => {
      const pill = root?.querySelector('[data-pill]') ?? null;
      return visible(pill)
        ? [...(pill?.children ?? [])].filter(visible).map((part) => part.textContent)
        : undefined;
    },
    button: () => {
      const pill = root?.querySelector('[data-pill]');
      return pill instanceof HTMLButtonElement ? pill : undefined;
    },
  };
}

let posted: MockInstance<Window['postMessage']>;
let viewport: ReturnType<typeof fakeViewport>;
let stop: (() => void) | undefined;
const posts = () =>
  posted.mock.calls.map(([message]): unknown => message).filter((message) => message !== null);

async function start({ url = `/watch?v=${VIDEO}` }: { url?: string } = {}) {
  history.pushState({}, '', url);
  const page = addPlayer();
  const server = backend();
  stop = startWatchPage(window, { send: server.send, mode: 'open' });
  await settle();
  return { ...page, server, shown: () => overlay(page.player) };
}

beforeEach(() => {
  posted = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
  viewport = fakeViewport();
});
afterEach(() => {
  stop?.();
  stop = undefined;
  fakeBrowser.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.head.replaceChildren();
});

describe('watch page', () => {
  it('asks the bridge for the chosen track and reports the page', async () => {
    const { server } = await start();
    expect(posts()).toEqual([{ source: 'st-content', type: 'ready' }]);
    tellVideo();
    await settle();
    expect(posts()).toEqual([
      { source: 'st-content', type: 'ready' },
      { source: 'st-content', type: 'load-track', languageCode: 'en' },
    ]);
    expect(server.of('subs/page')).toEqual([
      {
        type: 'subs/page',
        target: 'background',
        payload: {
          info: {
            videoId: VIDEO,
            streamer: VIDEO_INFO.channelId,
            title: VIDEO_INFO.title,
            author: VIDEO_INFO.author,
            live: false,
            tracks: 2,
          },
        },
      },
    ]);
    // The bridge posts the video again on `ready` and after its own navigation event.
    tellVideo();
    await settle();
    expect(server.of('subs/page')).toHaveLength(1);
    expect(posts()).toHaveLength(2);
  });

  it('draws the line at the playback position and its translation when it comes', async () => {
    const { player, server, shown, play, frame } = await start();
    tellVideo();
    tellCues();
    await settle();
    play();
    frame(500);
    await settle();
    expect(shown().rows()).toEqual(['Okay chat.']);
    expect(server.of('subs/translate')).toEqual([
      {
        type: 'subs/translate',
        target: 'background',
        payload: expect.objectContaining({ videoId: VIDEO, sourceLang: 'en', previous: [] }),
      },
    ]);
    expect(server.asked()).toEqual([
      ['Okay chat.', 'We are going in.', 'Wish me luck.', 'That was close.'],
    ]);
    expect(player.hasAttribute('data-st-on')).toBe(true);
    await server.answer(0);
    expect(shown().rows()).toEqual(['Okay chat.', '訳:Okay chat.']);
    frame(2_000);
    expect(shown().rows()).toEqual([]);
    frame(3_100);
    expect(shown().rows()).toEqual(['We are going in.', '訳:We are going in.']);
  });

  it('sends no batch while the video is paused, and goes on when it plays again', async () => {
    const { server, play, pause, frame } = await start();
    tellVideo();
    tellCues();
    await settle();
    play();
    frame(0);
    await settle();
    expect(server.asked()).toHaveLength(1);
    pause();
    await server.answer(0);
    expect(server.asked()).toHaveLength(1);
    play();
    await settle();
    expect(server.asked()).toEqual([
      ['Okay chat.', 'We are going in.', 'Wish me luck.', 'That was close.'],
      ['One more try.', 'We did it.'],
    ]);
  });

  it('uses cues the bridge sent before the video, without asking for the track', async () => {
    const { server, play, frame } = await start();
    tellCues();
    tellVideo();
    await settle();
    expect(posts()).toEqual([{ source: 'st-content', type: 'ready' }]);
    play();
    frame(0);
    await settle();
    expect(server.asked()).toHaveLength(1);
  });

  it.each([
    { name: 'another language', over: { languageCode: 'ja', kind: 'manual' } },
    { name: 'another kind', over: { kind: 'manual' } },
    { name: 'another video', over: { videoId: OTHER } },
  ])('ignores the cues of $name', async ({ over }) => {
    const { server, shown, play, frame } = await start();
    tellVideo();
    tellCues(over);
    await settle();
    play();
    frame(500);
    await settle();
    expect(server.of('subs/translate')).toEqual([]);
    expect(shown().rows()).toEqual([]);
  });

  it.each([
    {
      name: 'a video without caption tracks',
      setting: 'auto',
      video: VIDEO_INFO,
      tracks: [],
      message: NO_SOURCE_MESSAGE,
    },
    {
      name: 'a live stream',
      setting: 'auto',
      video: { ...VIDEO_INFO, live: true },
      tracks: TRACKS,
      message: NO_SOURCE_MESSAGE,
    },
    {
      name: 'the audio source setting',
      setting: 'audio',
      video: VIDEO_INFO,
      tracks: TRACKS,
      message: AUDIO_HINT_MESSAGE,
    },
  ] as const)(
    'shows how to start speech subtitles and sends no translation: $name',
    async ({ setting, video, tracks, message }) => {
      await fakeBrowser.storage.local.set({
        subtitles: { ...defaultSubtitleSettings, source: setting },
      });
      const { player, server, shown, play, frame } = await start();
      tellVideo(video, [...tracks]);
      tellCues();
      await settle();
      play();
      frame(500);
      frame(3_100);
      await settle();
      expect(shown().pill()).toEqual(['字幕: 併記', message]);
      expect(shown().rows()).toEqual([]);
      expect(player.hasAttribute('data-st-on')).toBe(false);
      expect(posts()).toEqual([{ source: 'st-content', type: 'ready' }]);
      // Besides the front, which the speech subtitles follow too, only the page is reported.
      expect(
        server.sent.filter((sent) => sent.type !== 'subs/front').map((sent) => sent.type),
      ).toEqual(['subs/page']);
    },
  );

  it('starts over after a navigation, and an answer for the previous video is not drawn', async () => {
    const { player, server, shown, play, frame } = await start();
    tellVideo();
    tellCues();
    await settle();
    play();
    frame(500);
    await settle();
    const before = shown().host;
    navigate(`/watch?v=${OTHER}`);
    await settle();
    expect(posts().slice(-1)).toEqual([{ source: 'st-content', type: 'ready' }]);
    expect(shown().host).not.toBe(before);
    expect(before?.isConnected).toBe(false);
    await server.answer(0);
    expect(shown().rows()).toEqual([]);
    tellVideo({ ...VIDEO_INFO, videoId: OTHER });
    await settle();
    expect(server.of('subs/page').map((sent) => sent.payload)).toEqual([
      expect.objectContaining({ info: expect.objectContaining({ videoId: VIDEO }) }),
      expect.objectContaining({ info: expect.objectContaining({ videoId: OTHER }) }),
    ]);
    frame(3_100);
    expect(shown().rows()).toEqual([]);
    expect(player.querySelectorAll('[data-st-overlay]')).toHaveLength(1);
  });

  it('leaves pages other than /watch and /live/ alone, and starts on a /live/ page', async () => {
    const { player } = await start({ url: '/feed/subscriptions' });
    expect(posts()).toEqual([]);
    expect(player.querySelector('[data-st-overlay]')).toBeNull();
    navigate(`/live/${VIDEO}`);
    await settle();
    expect(posts()).toEqual([{ source: 'st-content', type: 'ready' }]);
    expect(player.querySelector('[data-st-overlay]')).not.toBeNull();
    navigate('/');
    expect(player.querySelector('[data-st-overlay]')).toBeNull();
  });

  it('waits for the next navigation when the page has no player video', async () => {
    history.pushState({}, '', `/watch?v=${VIDEO}`);
    const server = backend();
    stop = startWatchPage(window, { send: server.send, mode: 'open' });
    await settle();
    expect(posts()).toEqual([]);
    addPlayer();
    navigate(`/watch?v=${VIDEO}`);
    await settle();
    expect(posts()).toEqual([{ source: 'st-content', type: 'ready' }]);
  });

  it('tells the caption feeder whether the page is active, at start and on each change', async () => {
    const { server, play, pause, frame, mute, visibility } = await start();
    const fronts = () => server.of('subs/front').map((sent) => sent.payload);
    // Reported as soon as the page is followed: the video has not started.
    expect(fronts()).toEqual([{ state: 'pause', reason: 'paused' }]);
    tellVideo();
    tellCues({ cues: MANY });
    await settle();
    play();
    frame(0);
    await settle();
    expect(server.asked()).toHaveLength(1);
    // Muted, the frames go on but nothing more is sent; the answer in flight is still drawn.
    mute(true);
    await server.answer(0);
    frame(100);
    await settle();
    expect(server.asked()).toHaveLength(1);
    mute(false);
    await settle();
    expect(server.asked()).toHaveLength(2);
    visibility('hidden');
    await server.answer(1);
    expect(server.asked()).toHaveLength(2);
    visibility('visible');
    await settle();
    expect(server.asked()).toHaveLength(3);
    pause();
    await settle();
    expect(fronts()).toEqual([
      { state: 'pause', reason: 'paused' },
      { state: 'active' },
      { state: 'pause', reason: 'muted' },
      { state: 'active' },
      { state: 'away', reason: 'hidden' },
      { state: 'active' },
      { state: 'pause', reason: 'paused' },
    ]);
  });

  it('sends nothing while the player is off screen', async () => {
    const { player, server, play, frame } = await start();
    tellVideo();
    tellCues();
    await settle();
    viewport.report(player, { width: 0, height: 0, isIntersecting: false });
    play();
    frame(0);
    await settle();
    expect(server.asked()).toEqual([]);
    viewport.report(player, { width: 1280, height: 200 });
    await settle();
    expect(server.asked()).toHaveLength(1);
    expect(server.of('subs/front').map((sent) => sent.payload)).toEqual([
      { state: 'pause', reason: 'paused' },
      { state: 'away', reason: 'offscreen' },
      { state: 'active' },
    ]);
  });

  it('cycles the display from the player button and follows the saved display', async () => {
    const { server, shown, play, frame } = await start();
    tellVideo();
    tellCues();
    await settle();
    play();
    frame(500);
    await server.answer(0);
    expect(shown().rows()).toEqual(['Okay chat.', '訳:Okay chat.']);
    expect(shown().pill()).toEqual(['字幕: 併記']);
    shown().button()?.click();
    await settle();
    expect(server.of('subs/display')).toEqual([
      { type: 'subs/display', target: 'background', payload: { mode: 'source' } },
    ]);
    // The display changes when the background has saved it, as in every other tab.
    expect(shown().pill()).toEqual(['字幕: 併記']);
    await saveDisplay('source');
    expect(shown().rows()).toEqual(['Okay chat.']);
    expect(shown().pill()).toEqual(['字幕: 原語']);
    await saveDisplay('off');
    expect(shown().rows()).toEqual([]);
    expect(shown().pill()).toEqual(['字幕: オフ']);
    expect(server.of('subs/front').at(-1)?.payload).toEqual({
      state: 'away',
      reason: 'display-off',
    });
    shown().button()?.click();
    await settle();
    expect(server.of('subs/display').at(-1)?.payload).toEqual({ mode: 'ja' });
    await saveDisplay('ja');
    expect(shown().rows()).toEqual(['訳:Okay chat.']);
    expect(server.of('subs/front').at(-1)?.payload).toEqual({ state: 'active' });
  });

  it('shows the line at once when the display comes back on while paused', async () => {
    await fakeBrowser.storage.local.set({
      subtitles: { ...defaultSubtitleSettings, display: 'off' },
    });
    const { server, shown, play, pause, frame } = await start();
    tellVideo();
    tellCues();
    await settle();
    play();
    frame(500);
    pause();
    await settle();
    expect(shown().rows()).toEqual([]);
    await saveDisplay('both');
    expect(shown().rows()).toEqual(['Okay chat.']);
    expect(server.of('subs/translate')).toEqual([]);
  });

  it('clears the line when an ad starts, and keeps it while paused', async () => {
    const { player, server, shown, play, pause, frame } = await start();
    tellVideo();
    tellCues();
    await settle();
    play();
    frame(500);
    await settle();
    expect(shown().rows()).toEqual(['Okay chat.']);
    pause();
    await settle();
    expect(shown().rows()).toEqual(['Okay chat.']);
    play();
    player.classList.add('ad-showing');
    await settle();
    expect(shown().rows()).toEqual([]);
    // An answer that comes during the ad is kept for later, not drawn over the ad.
    await server.answer(0);
    expect(shown().rows()).toEqual([]);
    player.classList.remove('ad-showing');
    await settle();
    frame(3_100);
    expect(shown().rows()).toEqual(['We are going in.', '訳:We are going in.']);
  });

  it('draws the line at the video position when an ad ends while the video is paused', async () => {
    const { player, server, shown, play, pause, seek, frame } = await start();
    tellVideo();
    tellCues();
    await settle();
    play();
    frame(500);
    await server.answer(0);
    player.classList.add('ad-showing');
    await settle();
    expect(shown().rows()).toEqual([]);
    // The ad ends on a paused video moved on: no frame comes to draw it.
    pause();
    seek(3_100);
    player.classList.remove('ad-showing');
    await settle();
    expect(shown().rows()).toEqual(['We are going in.', '訳:We are going in.']);
  });

  it('reports the player away when the page leaves the video', async () => {
    const { server, play } = await start();
    play();
    await settle();
    navigate('/feed/subscriptions');
    await settle();
    expect(server.of('subs/front').map((sent) => sent.payload)).toEqual([
      { state: 'pause', reason: 'paused' },
      { state: 'active' },
      { state: 'away', reason: 'offscreen' },
    ]);
  });

  it('removes the overlay and stops listening on cleanup', async () => {
    const { player, server, play, pause, frame } = await start();
    tellVideo();
    tellCues();
    await settle();
    play();
    frame(500);
    await settle();
    stop?.();
    stop = undefined;
    expect(player.querySelector('[data-st-overlay]')).toBeNull();
    expect(player.hasAttribute('data-st-on')).toBe(false);
    const sent = server.sent.length;
    const before = posts().length;
    tellVideo({ ...VIDEO_INFO, videoId: OTHER });
    navigate(`/watch?v=${OTHER}`);
    await server.answer(0);
    frame(3_100);
    await saveDisplay('off');
    pause();
    await settle();
    expect(server.sent).toHaveLength(sent);
    expect(posts()).toHaveLength(before);
    expect(player.querySelector('[data-st-overlay]')).toBeNull();
  });
});
