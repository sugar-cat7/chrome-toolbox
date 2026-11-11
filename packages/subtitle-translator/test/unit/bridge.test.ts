// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { Timers } from '@chrome-toolbox/extension-core';
import { installBridge, LOAD_TIMEOUT_MS, MAX_BODY_LENGTH } from '../../src/captions/bridge.ts';
import { readBridgeMessage } from '../../src/captions/messages.ts';
import { CAPTION_LIMITS, listTracks, parseJson3, readVideo } from '../../src/captions/tracks.ts';

const fixtureText = (name: string): string =>
  readFileSync(path.join(import.meta.dirname, '../fixtures', name), 'utf8');
const JSON3 = fixtureText('timedtext.json3.json');
const PLAYER_RESPONSE: unknown = JSON.parse(fixtureText('player-response.json'));
const CUES = parseJson3(JSON.parse(JSON3));
/** The fixture's player response for another video id. */
const responseFor = (videoId: string): unknown =>
  JSON.parse(fixtureText('player-response.json').replaceAll('fixture-v01', videoId));

const timedtext = (query: string, videoId = 'fixture-v01'): string =>
  `/api/timedtext?v=${videoId}&${query}&fmt=json3&pot=x`;
const loadTrack = (languageCode: string) =>
  fromContent({ source: 'st-content', type: 'load-track', languageCode });
const navigate = () => document.dispatchEvent(new CustomEvent('yt-navigate-start'));
/** The `setOption` calls that turned a track on (not the restores). */
const asked = (calls: unknown[][]) =>
  calls.filter(
    ([, , value]) => typeof value === 'object' && value !== null && 'languageCode' in value,
  );

/** A stand-in for the page's XMLHttpRequest that answers every request with `FakeXhr.body`. */
class FakeXhr extends EventTarget {
  static body = JSON3;
  responseType: XMLHttpRequestResponseType = '';
  status = 0;
  responseText = '';
  open(_method: string, _url: string | URL): void {
    this.status = 0;
  }
  send(): void {
    setTimeout(() => {
      this.status = 200;
      this.responseText = FakeXhr.body;
      this.dispatchEvent(new Event('load'));
    }, 0);
  }
}

/** Timers that run only when the test says so. */
function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const timers: Timers = {
    set(fn, ms) {
      pending.set(next, { fn, ms });
      return next++;
    },
    clear: (id) => {
      pending.delete(id);
    },
  };
  return {
    timers,
    delays: () => [...pending.values()].map(({ ms }) => ms),
    run() {
      const due = [...pending.values()];
      pending.clear();
      for (const { fn } of due) fn();
    },
  };
}

/** A `#movie_player` with the parts of the player API the bridge uses. */
function addPlayer(track: Record<string, unknown> = {}) {
  const element = document.createElement('div');
  element.id = 'movie_player';
  let current = track;
  let response = PLAYER_RESPONSE;
  const api = {
    getPlayerResponse: vi.fn<() => unknown>(() => response),
    getOption: vi.fn<(module: string, option: string) => Record<string, unknown>>(() => current),
    // Like the player: turning a track on remembers it and its language.
    setOption: vi.fn<(module: string, option: string, value: Record<string, unknown>) => void>(
      (_module, _option, value) => {
        current = value;
        const on = typeof value.languageCode === 'string';
        localStorage.setItem('yt-player-caption-persistence', JSON.stringify({ data: String(on) }));
        if (on)
          localStorage.setItem(
            'yt-player-caption-sticky-language',
            JSON.stringify({ data: value.languageCode }),
          );
      },
    ),
  };
  Object.assign(element, api);
  document.body.append(element);
  /** The player moves to another video (an in-app navigation). */
  const show = (next: unknown) => {
    response = next;
  };
  return { element, api, show };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const fromContent = (data: unknown, source: MessageEventSource | null = window) =>
  window.dispatchEvent(new MessageEvent('message', { data, source, origin: location.origin }));

let realFetch: typeof window.fetch;
let realXhr: typeof window.XMLHttpRequest;
let uninstall: (() => void) | undefined;
let posted: MockInstance<Window['postMessage']>;
const posts = (type: string) =>
  posted.mock.calls
    .map(([message]): unknown => message)
    .filter(
      (message): message is Record<string, unknown> =>
        typeof message === 'object' &&
        message !== null &&
        'source' in message &&
        message.source === 'st-bridge' &&
        'type' in message &&
        message.type === type,
    );

beforeEach(() => {
  realFetch = window.fetch;
  realXhr = window.XMLHttpRequest;
  window.fetch = vi.fn<typeof window.fetch>(async () => new Response(JSON3, { status: 200 }));
  Object.defineProperty(window, 'XMLHttpRequest', {
    value: FakeXhr,
    configurable: true,
    writable: true,
  });
  posted = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
  localStorage.clear();
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  window.fetch = realFetch;
  Object.defineProperty(window, 'XMLHttpRequest', {
    value: realXhr,
    configurable: true,
    writable: true,
  });
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.head.replaceChildren();
});

async function pageFetch(url: string): Promise<string> {
  const response = await window.fetch(url);
  return response.text();
}
async function pageXhr(url: string): Promise<string> {
  const xhr = new FakeXhr();
  const loaded = new Promise<string>((resolve) =>
    xhr.addEventListener('load', () => resolve(xhr.responseText)),
  );
  xhr.open('GET', url);
  xhr.send();
  return loaded;
}

describe('player bridge (MAIN world)', () => {
  it.each([
    { transport: 'fetch', request: pageFetch },
    { transport: 'XMLHttpRequest', request: pageXhr },
  ])(
    'passes timedtext responses through unchanged and posts their cues once ($transport)',
    async ({ request }) => {
      uninstall = installBridge(window, { timers: manualTimers().timers });

      expect(await request(timedtext('lang=es&kind=asr'))).toBe(JSON3);
      expect(await request(timedtext('lang=es&kind=asr'))).toBe(JSON3);
      await vi.waitFor(() => expect(posts('cues')).toHaveLength(1));
      await flush();

      expect(posts('cues')).toEqual([
        {
          source: 'st-bridge',
          type: 'cues',
          videoId: 'fixture-v01',
          languageCode: 'es',
          kind: 'asr',
          cues: CUES.ok ? CUES.value : [],
        },
      ]);
      expect(posted.mock.calls[0]?.[1]).toBe(location.origin);
    },
  );

  it.each([
    { name: 'player API', url: '/youtubei/v1/player?key=x' },
    { name: 'similar path', url: '/api/timedtextx?v=fixture-v01&lang=es&fmt=json3' },
    { name: 'other origin', url: `https://example.com${timedtext('lang=es&kind=asr')}` },
    { name: 'translated track', url: timedtext('lang=es&kind=asr&tlang=ja') },
    { name: 'no video id', url: '/api/timedtext?lang=es&fmt=json3' },
    { name: 'another format', url: '/api/timedtext?v=fixture-v01&lang=es&kind=asr&fmt=srv3' },
  ])('ignores responses that are not /api/timedtext: $name', async ({ url }) => {
    uninstall = installBridge(window, { timers: manualTimers().timers });

    expect(await pageFetch(url)).toBe(JSON3);
    expect(await pageXhr(url)).toBe(JSON3);
    await flush();

    expect(posts('cues')).toEqual([]);
  });

  it('posts nothing for a body that is not json3, and the page still gets it', async () => {
    FakeXhr.body = '';
    uninstall = installBridge(window, { timers: manualTimers().timers });

    expect(await pageXhr(timedtext('lang=es&kind=asr'))).toBe('');
    await flush();
    FakeXhr.body = JSON3;

    expect(posts('cues')).toEqual([]);
  });

  it('leaves a body longer than the limit to the player', async () => {
    // Still valid json3: the length alone keeps the bridge from parsing it.
    FakeXhr.body = JSON3 + ' '.repeat(MAX_BODY_LENGTH);
    uninstall = installBridge(window, { timers: manualTimers().timers });

    expect(await pageXhr(timedtext('lang=es&kind=asr'))).toHaveLength(
      JSON3.length + MAX_BODY_LENGTH,
    );
    await flush();
    FakeXhr.body = JSON3;

    expect(posts('cues')).toEqual([]);
  });

  it('leaves a failed page fetch failing as it was', async () => {
    window.fetch = vi.fn<typeof window.fetch>(() => Promise.reject(new TypeError('offline')));
    uninstall = installBridge(window, { timers: manualTimers().timers });

    await expect(window.fetch(timedtext('lang=es&kind=asr'))).rejects.toThrow('offline');
    expect(posts('cues')).toEqual([]);
  });

  it('posts the video and its tracks on yt-navigate-finish and when the content script is ready', () => {
    addPlayer();
    uninstall = installBridge(window, { timers: manualTimers().timers });
    document.dispatchEvent(new CustomEvent('yt-navigate-finish'));
    fromContent({ source: 'st-content', type: 'ready' });

    const video = readVideo(PLAYER_RESPONSE);
    const tracks = listTracks(PLAYER_RESPONSE);
    // Once when installed (the player is already there), once per event and request.
    expect(posts('video')).toHaveLength(3);
    expect(posts('video')[1]).toEqual({
      source: 'st-bridge',
      type: 'video',
      video: video.ok ? video.value : undefined,
      tracks: tracks.ok ? tracks.value : undefined,
    });
  });

  it('makes the player fetch the asked track, hides its captions and restores CC that was off', async () => {
    const persistence = JSON.stringify({ data: 'false', creation: 1 });
    localStorage.setItem('yt-player-caption-persistence', persistence);
    const { element, api } = addPlayer();
    const clock = manualTimers();
    uninstall = installBridge(window, { timers: clock.timers });

    fromContent({ source: 'st-content', type: 'load-track', languageCode: 'es-419' });

    expect(api.setOption).toHaveBeenCalledWith('captions', 'track', { languageCode: 'es-419' });
    expect(element.hasAttribute('data-st-loading')).toBe(true);
    expect(document.querySelector('style')?.textContent).toContain(
      '#movie_player[data-st-loading] .ytp-caption-window-container',
    );
    expect(clock.delays()).toEqual([LOAD_TIMEOUT_MS]);

    // The player's own request for that track.
    await pageXhr(timedtext('lang=es-419'));
    await vi.waitFor(() => expect(posts('cues')).toHaveLength(1));
    expect(posts('cues')[0]).toMatchObject({ languageCode: 'es-419', kind: 'manual' });
    // Put back only after the player's own load handlers have run.
    expect(api.setOption).toHaveBeenCalledTimes(1);
    expect(clock.delays()).toEqual([0]);
    clock.run();

    expect(api.setOption).toHaveBeenLastCalledWith('captions', 'track', {});
    expect(localStorage.getItem('yt-player-caption-persistence')).toBe(persistence);
    expect(localStorage.getItem('yt-player-caption-sticky-language')).toBeNull();
    expect(element.hasAttribute('data-st-loading')).toBe(false);
  });

  it('asks for an auto-generated track by kind and puts back the track the viewer had on', () => {
    const viewer = { languageCode: 'ja', kind: '', vss_id: '.ja' };
    const sticky = JSON.stringify({ data: 'ja', creation: 1 });
    const persistence = JSON.stringify({ data: 'true', creation: 1 });
    localStorage.setItem('yt-player-caption-sticky-language', sticky);
    localStorage.setItem('yt-player-caption-persistence', persistence);
    const { element, api } = addPlayer(viewer);
    const clock = manualTimers();
    uninstall = installBridge(window, { timers: clock.timers });

    fromContent({ source: 'st-content', type: 'load-track', languageCode: 'es' });
    expect(api.setOption).toHaveBeenCalledWith('captions', 'track', {
      languageCode: 'es',
      kind: 'asr',
    });
    // The track never arrives: the bridge gives up after the timeout and restores.
    clock.run();

    expect(element.hasAttribute('data-st-loading')).toBe(false);
    expect(api.setOption).toHaveBeenLastCalledWith('captions', 'track', viewer);
    expect(localStorage.getItem('yt-player-caption-sticky-language')).toBe(sticky);
    expect(localStorage.getItem('yt-player-caption-persistence')).toBe(persistence);
  });

  it('puts CC back when the viewer leaves for another video before the track arrives', () => {
    const { element, api } = addPlayer();
    const clock = manualTimers();
    uninstall = installBridge(window, { timers: clock.timers });

    fromContent({ source: 'st-content', type: 'load-track', languageCode: 'ja' });
    document.dispatchEvent(new CustomEvent('yt-navigate-start'));

    expect(api.setOption).toHaveBeenLastCalledWith('captions', 'track', {});
    expect(localStorage.getItem('yt-player-caption-persistence')).toBeNull();
    expect(element.hasAttribute('data-st-loading')).toBe(false);
    expect(clock.delays()).toEqual([]);
  });

  it('loads the source track again when the viewer comes back to a video with CC off', async () => {
    const { api, show } = addPlayer();
    const clock = manualTimers();
    uninstall = installBridge(window, { timers: clock.timers });

    for (const videoId of ['fixture-v01', 'fixture-v02', 'fixture-v01']) {
      navigate();
      show(responseFor(videoId));
      loadTrack('es');
      await pageXhr(timedtext('lang=es&kind=asr', videoId));
      clock.run();
    }

    expect(posts('cues').map(({ videoId }) => videoId)).toEqual([
      'fixture-v01',
      'fixture-v02',
      'fixture-v01',
    ]);
    expect(asked(api.setOption.mock.calls)).toHaveLength(3);
  });

  it('posts the source track again when the viewer comes back to a video with it on', async () => {
    const { api, show } = addPlayer({ languageCode: 'es', kind: 'asr' });
    uninstall = installBridge(window, { timers: manualTimers().timers });

    for (const videoId of ['fixture-v01', 'fixture-v02', 'fixture-v01']) {
      navigate();
      show(responseFor(videoId));
      // The player fetches the track that is on, sometimes twice in one visit.
      await pageXhr(timedtext('lang=es&kind=asr', videoId));
      await pageXhr(timedtext('lang=es&kind=asr', videoId));
    }
    loadTrack('es');

    expect(posts('cues').map(({ videoId }) => videoId)).toEqual([
      'fixture-v01',
      'fixture-v02',
      'fixture-v01',
      'fixture-v01',
    ]);
    expect(api.setOption).not.toHaveBeenCalled();
  });

  it.each<{ name: string; answer: string | undefined }>([
    { name: 'times out', answer: undefined },
    { name: 'answers with an empty body', answer: '' },
    { name: 'answers with a body that is not json3', answer: '{"wireMagic":"pb3"}' },
  ])(
    'does not drive the player twice for one track in one visit when it $name',
    async ({ answer }) => {
      const { api } = addPlayer();
      const clock = manualTimers();
      uninstall = installBridge(window, { timers: clock.timers });

      loadTrack('es');
      // The content script asks on every video message; the load is still on.
      loadTrack('es');
      if (answer !== undefined) {
        FakeXhr.body = answer;
        await pageXhr(timedtext('lang=es&kind=asr'));
        FakeXhr.body = JSON3;
      }
      clock.run();
      loadTrack('es');

      expect(asked(api.setOption.mock.calls)).toHaveLength(1);
      expect(posts('cues')).toEqual([]);
      expect(clock.delays()).toEqual([]);
    },
  );

  it('waits for the player to turn on the CC the viewer keeps on before driving it', async () => {
    localStorage.setItem('yt-player-caption-persistence', JSON.stringify({ data: 'true' }));
    // The player has not turned the remembered track on yet (a full load).
    const { api } = addPlayer();
    const clock = manualTimers();
    uninstall = installBridge(window, { timers: clock.timers });

    loadTrack('es');
    expect(api.setOption).not.toHaveBeenCalled();
    expect(clock.delays()).toEqual([LOAD_TIMEOUT_MS]);

    // The player's own request for the remembered track is posted as usual.
    await pageXhr(timedtext('lang=es&kind=asr'));
    expect(posts('cues')).toHaveLength(1);
    clock.run();

    expect(api.setOption).not.toHaveBeenCalled();
    expect(posts('cues')).toHaveLength(1);
  });

  it('drops the wait when the viewer leaves for another video', () => {
    localStorage.setItem('yt-player-caption-persistence', JSON.stringify({ data: 'true' }));
    const { api } = addPlayer();
    const clock = manualTimers();
    uninstall = installBridge(window, { timers: clock.timers });

    loadTrack('es');
    navigate();

    expect(clock.delays()).toEqual([]);
    expect(api.setOption).not.toHaveBeenCalled();
  });

  it('posts the asked track even when this visit posted it before', async () => {
    // CC on in the source language, then the viewer switches YouTube's CC to Japanese.
    const { api } = addPlayer({ languageCode: 'es', kind: 'asr' });
    const clock = manualTimers();
    uninstall = installBridge(window, { timers: clock.timers });
    await pageXhr(timedtext('lang=es&kind=asr'));
    api.setOption('captions', 'track', { languageCode: 'ja', kind: '' });
    await pageXhr(timedtext('lang=ja'));
    api.setOption.mockClear();

    loadTrack('es');
    await pageXhr(timedtext('lang=es&kind=asr'));

    expect(asked(api.setOption.mock.calls)).toHaveLength(1);
    expect(posts('cues').map(({ languageCode }) => languageCode)).toEqual(['es', 'ja', 'es']);
  });

  it('drives the player after that wait when its own request never comes', () => {
    localStorage.setItem('yt-player-caption-persistence', JSON.stringify({ data: 'true' }));
    const { api } = addPlayer();
    const clock = manualTimers();
    uninstall = installBridge(window, { timers: clock.timers });

    loadTrack('es');
    clock.run();

    expect(api.setOption).toHaveBeenCalledWith('captions', 'track', {
      languageCode: 'es',
      kind: 'asr',
    });
    expect(clock.delays()).toEqual([LOAD_TIMEOUT_MS]);
  });

  it('stops reading a fetched body at the limit', async () => {
    const chunk = new TextEncoder().encode(' '.repeat(1 << 20));
    let pulls = 0;
    window.fetch = vi.fn<typeof window.fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            // 16 MiB in all, twice the limit.
            pull(controller) {
              pulls += 1;
              if (pulls > 16) controller.close();
              else controller.enqueue(chunk);
            },
          }),
          { status: 200 },
        ),
    );
    addPlayer();
    const clock = manualTimers();
    uninstall = installBridge(window, { timers: clock.timers });
    loadTrack('es');

    // The page does not read its own copy here; the bridge must give up on its copy.
    const response = await window.fetch(timedtext('lang=es&kind=asr'));
    await vi.waitFor(() => expect(clock.delays()).toEqual([0]));

    expect(posts('cues')).toEqual([]);
    expect(pulls).toBeLessThan(MAX_BODY_LENGTH / chunk.length + 4);
    await response.body?.cancel();
  });

  it('does not re-post held cues of another video on ready', async () => {
    const { show } = addPlayer({ languageCode: 'es', kind: 'asr' });
    uninstall = installBridge(window, { timers: manualTimers().timers });
    await pageXhr(timedtext('lang=es&kind=asr'));
    show(responseFor('fixture-v02'));

    fromContent({ source: 'st-content', type: 'ready' });

    expect(posts('cues')).toHaveLength(1);
    expect(posts('video').at(-1)).toMatchObject({ video: { videoId: 'fixture-v02' } });
  });

  it('re-posts cues it holds instead of asking the player again', async () => {
    const { api } = addPlayer({ languageCode: 'es', kind: 'asr' });
    uninstall = installBridge(window, { timers: manualTimers().timers });
    await pageXhr(timedtext('lang=es&kind=asr'));
    await vi.waitFor(() => expect(posts('cues')).toHaveLength(1));

    fromContent({ source: 'st-content', type: 'load-track', languageCode: 'es' });
    fromContent({ source: 'st-content', type: 'ready' });

    expect(api.setOption).not.toHaveBeenCalled();
    expect(posts('cues')).toHaveLength(3);
  });

  it.each([
    {
      name: 'a language without a track',
      data: { source: 'st-content', type: 'load-track', languageCode: 'fr' },
    },
    {
      name: 'a malformed language',
      data: { source: 'st-content', type: 'load-track', languageCode: 'es<' },
    },
    { name: 'another source', data: { source: 'page', type: 'load-track', languageCode: 'es' } },
    {
      name: 'the track already on',
      data: { source: 'st-content', type: 'load-track', languageCode: 'ja' },
    },
  ])('does not touch the player for $name', ({ data }) => {
    const { api } = addPlayer({ languageCode: 'ja', kind: '' });
    uninstall = installBridge(window, { timers: manualTimers().timers });

    fromContent(data);

    expect(api.setOption).not.toHaveBeenCalled();
  });

  it('ignores load-track from another window', () => {
    const { api } = addPlayer();
    uninstall = installBridge(window, { timers: manualTimers().timers });

    fromContent({ source: 'st-content', type: 'load-track', languageCode: 'es' }, null);

    expect(api.setOption).not.toHaveBeenCalled();
  });
});

describe('bridge messages (isolated world)', () => {
  const cue = (index: number) => ({
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    text: `line ${index}`,
  });
  const cuesMessage = (count: number) => ({
    source: 'st-bridge',
    type: 'cues',
    videoId: 'fixture-v01',
    languageCode: 'es',
    kind: 'asr',
    cues: Array.from({ length: count }, (_, index) => cue(index)),
  });
  const event = (data: unknown, over: Partial<Pick<MessageEvent, 'source' | 'origin'>> = {}) => ({
    data,
    source: window,
    origin: location.origin,
    ...over,
  });

  it('drops bridge messages that fail validation on the isolated side', () => {
    expect(readBridgeMessage(event(cuesMessage(CAPTION_LIMITS.cues)), window)).toMatchObject({
      type: 'cues',
    });
    expect(readBridgeMessage(event(cuesMessage(CAPTION_LIMITS.cues + 1)), window)).toBeUndefined();
  });

  it('drops a list longer than the limit without reading its items', () => {
    const reads: string[] = [];
    const cues = new Proxy(cuesMessage(CAPTION_LIMITS.cues + 1).cues, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/u.test(key)) reads.push(key);
        return Reflect.get(target, key, receiver);
      },
    });

    expect(readBridgeMessage(event({ ...cuesMessage(0), cues }), window)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it.each([
    { name: 'another window', input: event(cuesMessage(1), { source: null }) },
    { name: 'another origin', input: event(cuesMessage(1), { origin: 'https://example.com' }) },
    { name: 'another source', input: event({ ...cuesMessage(1), source: 'st-content' }) },
    {
      name: 'a long cue',
      input: event({ ...cuesMessage(0), cues: [{ ...cue(0), text: 'x'.repeat(501) }] }),
    },
    {
      name: 'a cue ending before it starts',
      input: event({ ...cuesMessage(0), cues: [{ startMs: 5, endMs: 4, text: 'x' }] }),
    },
    { name: 'a bad video id', input: event({ ...cuesMessage(1), videoId: 'x' }) },
    {
      name: 'too many tracks',
      input: event({
        source: 'st-bridge',
        type: 'video',
        video: { videoId: 'fixture-v01', live: false },
        tracks: Array.from({ length: CAPTION_LIMITS.tracks + 1 }, () => ({
          languageCode: 'en',
          kind: 'manual',
          baseUrl: 'https://www.youtube.com/api/timedtext?lang=en',
          name: 'English',
          vssId: '.en',
        })),
      }),
    },
  ])('drops a message from $name', ({ input }) => {
    expect(readBridgeMessage(input, window)).toBeUndefined();
  });

  it('accepts the video message the bridge posts', () => {
    const video = readVideo(PLAYER_RESPONSE);
    const tracks = listTracks(PLAYER_RESPONSE);
    const message = {
      source: 'st-bridge',
      type: 'video',
      video: video.ok ? video.value : undefined,
      tracks: tracks.ok ? tracks.value : undefined,
    };

    expect(readBridgeMessage(event(message), window)).toEqual(message);
  });
});
