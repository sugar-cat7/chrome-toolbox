import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Err, failure, Ok } from '@chrome-toolbox/contracts';
import { defaultSettings, settingsStore, type Fetch } from '@chrome-toolbox/extension-core';
import { glossaryStore } from '../../src/glossary.ts';
import { AUDIO_FAILED_MESSAGE, AUDIO_UNSUPPORTED_MESSAGE } from '../../src/overlay/source.ts';
import { tabPagesStore, type PageInfo } from '../../src/page-context.ts';
import type { LiveLine } from '../../src/protocol.ts';
import { defaultSubtitleSettings, subtitleSettingsStore } from '../../src/settings.ts';
import { CAPTURE_KEY, createSessions, type Sessions } from '../../src/sessions.ts';
import { tabFronts } from '../../src/tab-fronts.ts';

const WATCH = 'https://www.youtube.com/watch?v=fixture-v01';
const CAPTURED = 7;
const OTHER = 8;
const PAGE: PageInfo = {
  videoId: 'fixture-v01',
  streamer: 'UC-fixture',
  title: 'Fixture Quest day 3',
  author: 'Fixture Ch',
  live: true,
  tracks: 0,
};
const NEXT_PAGE: PageInfo = { ...PAGE, videoId: 'fixture-v02', title: 'Fixture Quest day 4' };
/** What a capture of PAGE runs with, under the default settings and no glossary. */
const CONFIG = {
  display: 'both',
  sourceLang: 'auto',
  context: 'Title: Fixture Quest day 3\nChannel: Fixture Ch',
  glossary: [],
  translator: 'gemma',
};
const SETTINGS = { baseUrl: defaultSettings.llamaBaseUrl, models: defaultSettings.models };
/** What Chrome 156 says when the extension was not invoked on the tab (Task 13 Step 0). */
const NOT_INVOKED =
  'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.';
const LINE: LiveLine = {
  sentenceId: 'live:1',
  lang: 'en',
  source: 'Okay chat.',
  state: 'pending',
  endedAt: 5,
  final: true,
};

type Message = { type: string; payload: unknown; target?: unknown };
const isMessage = (message: unknown): message is Message =>
  typeof message === 'object' &&
  message !== null &&
  'type' in message &&
  typeof message.type === 'string' &&
  'payload' in message;

/** A browser event the test fires itself. */
function event<A extends unknown[]>() {
  const listeners = new Set<(...args: A) => void>();
  return {
    addListener(listener: (...args: A) => void): void {
      listeners.add(listener);
    },
    removeListener(listener: (...args: A) => void): void {
      listeners.delete(listener);
    },
    listening: () => listeners.size > 0,
    fire(...args: A): void {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

/** What the capture record in storage.session holds now. */
const stored = async (): Promise<unknown> =>
  (await fakeBrowser.storage.session.get(CAPTURE_KEY))[CAPTURE_KEY];
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The service worker's surroundings: a llama.cpp router that answers `/props` (with `audio`, or
 * without modalities when undefined), tab capture, the offscreen document, the tabs (CAPTURED in
 * front, both on a watch page) and the stores in the fake storage.
 */
function setup({
  audio = true,
  streamError,
  startError,
}: {
  audio?: boolean | undefined;
  streamError?: string;
  startError?: boolean;
} = {}) {
  const calls: string[] = [];
  const toOffscreen: Message[] = [];
  const toTabs: { tabId: number; frameId: number; message: Message }[] = [];
  const state = {
    audio,
    open: false,
    active: CAPTURED,
    urls: new Map<number, string | undefined>([
      [CAPTURED, WATCH],
      [OTHER, WATCH],
    ]),
  };
  const fetch = vi.fn<Fetch>(async (input) => {
    const url = new URL(input);
    if (url.pathname !== '/props') return new Response('', { status: 404 });
    calls.push(`props:${url.searchParams.get('model')}`);
    return Response.json({
      total_slots: 3,
      ...(state.audio === undefined ? {} : { modalities: { vision: false, audio: state.audio } }),
    });
  });
  const tabs = {
    get: async (tabId: number) => ({ id: tabId, active: state.active === tabId, windowId: 1 }),
    query: async () => [{ id: state.active, url: state.urls.get(state.active) }],
    sendMessage: async (tabId: number, message: unknown, options: { frameId: number }) => {
      if (isMessage(message)) toTabs.push({ tabId, frameId: options.frameId, message });
      return Ok({});
    },
    onRemoved: event<[number]>(),
    onUpdated: event<[number, { status?: string }, { url?: string }]>(),
    onActivated: event<[{ tabId: number; windowId: number }]>(),
  };
  const fronts = tabFronts(fakeBrowser.storage.session);
  const pages = tabPagesStore(fakeBrowser.storage.session);
  const make = (): Sessions =>
    createSessions({
      tabCapture: {
        getMediaStreamId(tabId, done) {
          calls.push(`streamId:${tabId}`);
          setTimeout(() => {
            if (streamError === undefined) done('stream-1', undefined);
            else done(undefined, streamError);
          }, 0);
        },
      },
      offscreen: {
        has: async () => Ok(state.open),
        create: async () => {
          calls.push('create');
          state.open = true;
          return Ok(undefined);
        },
        close: async () => {
          calls.push('close');
          state.open = false;
          return Ok(undefined);
        },
      },
      session: fakeBrowser.storage.session,
      storage: fakeBrowser.storage.local,
      send: async (message) => {
        if (!isMessage(message)) return Ok({});
        calls.push(message.type);
        toOffscreen.push(message);
        return startError === true && message.type === 'audio/start'
          ? Err(failure('capture_failed'))
          : Ok({});
      },
      tabs,
      settings: settingsStore(fakeBrowser.storage.local),
      subtitles: subtitleSettingsStore(fakeBrowser.storage.local),
      glossary: glossaryStore(fakeBrowser.storage.local),
      pages,
      fronts,
      fetch,
      now: () => 1_000,
    });
  return {
    calls,
    state,
    tabs,
    fronts,
    pages,
    make,
    count: (call: string) => calls.filter((made) => made === call).length,
    /** The payloads of the messages of `type` sent to the offscreen document. */
    of: (type: string) =>
      toOffscreen.filter((message) => message.type === type).map(({ payload }) => payload),
    /** Every message the background sent to the offscreen document, as sent. */
    toOffscreen,
    toTabs,
    /** The statuses (`subs/status`) sent to the tab's top frame. */
    statuses: (tabId: number) =>
      toTabs
        .filter((sent) => sent.tabId === tabId && sent.message.type === 'subs/status')
        .map(({ message }) =>
          typeof message.payload === 'object' && message.payload !== null
            ? Reflect.get(message.payload, 'status')
            : undefined,
        ),
  };
}
type Harness = ReturnType<typeof setup>;

/** Sessions capturing CAPTURED, which reported PAGE. */
async function capturing(h: Harness): Promise<Sessions> {
  expect(await h.pages.report(CAPTURED, PAGE)).toEqual(Ok(undefined));
  const sessions = h.make();
  expect(await sessions.start(CAPTURED)).toEqual(Ok(undefined));
  return sessions;
}

let made: Sessions[] = [];
afterEach(() => {
  for (const sessions of made) sessions.dispose();
  made = [];
  fakeBrowser.reset();
  vi.restoreAllMocks();
});
/** Keeps the sessions for the cleanup. */
const kept = (sessions: Sessions): Sessions => {
  made.push(sessions);
  return sessions;
};

describe('starting a capture', () => {
  it('asks the projector before the stream id on the shortcut path', async () => {
    const h = setup();
    kept(await capturing(h));
    expect(h.calls).toEqual([
      'props:gemma4-e4b',
      `streamId:${CAPTURED}`,
      'create',
      'audio/start',
      'audio/front',
    ]);
    expect(h.toOffscreen[0]).toEqual({
      type: 'audio/start',
      target: 'offscreen',
      payload: { tabId: CAPTURED, streamId: 'stream-1', settings: SETTINGS, config: CONFIG },
    });
    expect(await stored()).toEqual({ tabId: CAPTURED, startedAt: 1_000 });
  });

  it('refuses to start without a projector before asking for a stream id or an offscreen document', async () => {
    const h = setup({ audio: false });
    await h.pages.report(CAPTURED, PAGE);
    const sessions = kept(h.make());
    expect(await sessions.start(CAPTURED)).toMatchObject({
      ok: false,
      error: { internalCode: 'audio_unsupported' },
    });
    expect(h.calls).toEqual(['props:gemma4-e4b']);
    expect(await stored()).toBeUndefined();
    expect(await sessions.current()).toEqual(Ok(undefined));
  });

  it('takes a stream id it is given and goes on when the server does not tell its modalities', async () => {
    const h = setup({ audio: undefined });
    await h.pages.report(CAPTURED, PAGE);
    const sessions = kept(h.make());
    expect(await sessions.current()).toEqual(Ok(undefined));
    h.state.open = true;
    expect(await sessions.start(CAPTURED, 'panel-stream')).toEqual(Ok(undefined));
    // An offscreen document already open is used as it is.
    expect(h.calls).toEqual(['props:gemma4-e4b', 'audio/start', 'audio/front']);
    expect(h.of('audio/start')).toEqual([
      { tabId: CAPTURED, streamId: 'panel-stream', settings: SETTINGS, config: CONFIG },
    ]);
  });

  it.each([
    { error: NOT_INVOKED, code: 'capture_not_invoked' },
    { error: 'Cannot capture a tab with an active stream.', code: 'capture_failed' },
  ])('maps the error of getMediaStreamId to $code', async ({ error, code }) => {
    const h = setup({ streamError: error });
    await h.pages.report(CAPTURED, PAGE);
    const sessions = kept(h.make());
    expect(await sessions.start(CAPTURED)).toMatchObject({
      ok: false,
      error: { internalCode: code },
    });
    expect(h.calls).toEqual(['props:gemma4-e4b', `streamId:${CAPTURED}`]);
    expect(await stored()).toBeUndefined();
  });

  it('closes the offscreen document when the capture cannot start in it', async () => {
    const h = setup({ startError: true });
    await h.pages.report(CAPTURED, PAGE);
    const sessions = kept(h.make());
    expect(await sessions.start(CAPTURED)).toMatchObject({
      ok: false,
      error: { internalCode: 'capture_failed' },
    });
    expect(h.calls.slice(-2)).toEqual(['audio/start', 'close']);
    expect(await stored()).toBeUndefined();
    expect(await sessions.current()).toEqual(Ok(undefined));
  });

  it('stops the capture of another tab only right before taking the new stream id', async () => {
    const h = setup();
    const sessions = kept(await capturing(h));
    h.calls.length = 0;
    expect(await sessions.start(OTHER)).toEqual(Ok(undefined));
    expect(h.calls).toEqual([
      'props:gemma4-e4b',
      'audio/stop',
      'close',
      `streamId:${OTHER}`,
      'create',
      'audio/start',
      'audio/front',
    ]);
  });

  it('keeps the capture of a tab when another tab cannot start', async () => {
    const h = setup();
    const sessions = kept(await capturing(h));
    h.state.audio = false;
    expect(await sessions.start(OTHER)).toMatchObject({
      ok: false,
      error: { internalCode: 'audio_unsupported' },
    });
    expect(await sessions.current()).toEqual(Ok({ tabId: CAPTURED, startedAt: 1_000 }));
    expect(h.count('audio/stop')).toBe(0);
    expect(h.count('close')).toBe(0);
    expect(await stored()).toEqual({ tabId: CAPTURED, startedAt: 1_000 });
    expect(h.statuses(CAPTURED)).toEqual([]);
  });

  it('starts the capture with the streamer glossary and the saved subtitle settings', async () => {
    const h = setup();
    await glossaryStore(fakeBrowser.storage.local).save('UC-fixture', [
      { source: 'Fixturo', target: '' },
    ]);
    await subtitleSettingsStore(fakeBrowser.storage.local).save({
      ...defaultSubtitleSettings,
      sourceLang: 'en',
      translator: 'plamo',
    });
    kept(await capturing(h));
    expect(h.of('audio/start')).toEqual([
      expect.objectContaining({
        config: {
          ...CONFIG,
          sourceLang: 'en',
          translator: 'plamo',
          glossary: [{ source: 'Fixturo', target: 'Fixturo' }],
        },
      }),
    ]);
  });
});

describe('stopping a capture', () => {
  /** What sets off each stop; an event answers nothing, a call its result. */
  const stops: Record<string, (h: Harness, sessions: Sessions) => Promise<unknown>> = {
    removed: async (h) => h.tabs.onRemoved.fire(CAPTURED),
    'left-site': async (h) =>
      h.tabs.onUpdated.fire(CAPTURED, { status: 'loading' }, { url: 'https://example.com/' }),
    'url-hidden': async (h) => h.tabs.onUpdated.fire(CAPTURED, { status: 'complete' }, {}),
    idle: (_h, sessions) => sessions.idle(CAPTURED),
    failed: (_h, sessions) => sessions.failed(CAPTURED, 'audio_unsupported'),
    user: (_h, sessions) => sessions.stop(CAPTURED, 'user'),
    'start:other': (_h, sessions) => sessions.start(OTHER),
  };
  it.each([
    { name: 'タブを閉じた', event: 'removed', told: [] },
    { name: 'サイトの外へ移動', event: 'left-site', told: [{ state: 'stopped' }] },
    { name: 'URL が見えない', event: 'url-hidden', told: [{ state: 'stopped' }] },
    { name: '10 分処理していない', event: 'idle', told: [{ state: 'stopped' }] },
    { name: '別のタブで開始', event: 'start:other', told: [{ state: 'stopped' }] },
    {
      name: '取得中に投影器がなくなった',
      event: 'failed',
      told: [{ state: 'error', message: AUDIO_UNSUPPORTED_MESSAGE }],
    },
    { name: '利用者が止めた', event: 'user', told: [{ state: 'stopped' }] },
  ])('stops the capture when $name', async ({ event, told }) => {
    const h = setup();
    const sessions = kept(await capturing(h));
    const result = await stops[event]?.(h, sessions);
    expect(result ?? Ok(undefined)).toEqual(Ok(undefined));
    await vi.waitFor(() => {
      expect(h.count('close')).toBe(1);
    });
    expect(h.count('audio/stop')).toBe(1);
    expect(await stored()).toEqual(
      event === 'start:other' ? { tabId: OTHER, startedAt: 1_000 } : undefined,
    );
    expect(await sessions.current()).toEqual(
      Ok(event === 'start:other' ? { tabId: OTHER, startedAt: 1_000 } : undefined),
    );
    expect(h.statuses(CAPTURED)).toEqual(told);
  });

  it('ignores the stop conditions of a tab it does not capture', async () => {
    const h = setup();
    const sessions = kept(await capturing(h));
    h.tabs.onRemoved.fire(OTHER);
    h.tabs.onUpdated.fire(OTHER, { status: 'loading' }, {});
    expect(await sessions.idle(OTHER)).toEqual(Ok(undefined));
    expect(await sessions.failed(OTHER, 'audio_unsupported')).toEqual(Ok(undefined));
    expect(await sessions.stop(OTHER, 'user')).toEqual(Ok(undefined));
    expect(await sessions.current()).toEqual(Ok({ tabId: CAPTURED, startedAt: 1_000 }));
    expect(h.count('audio/stop')).toBe(0);
  });

  it('listens to tab updates and activations only while capturing', async () => {
    const h = setup();
    await h.pages.report(CAPTURED, PAGE);
    const sessions = h.make();
    expect(await sessions.current()).toEqual(Ok(undefined));
    expect(h.tabs.onUpdated.listening()).toBe(false);
    expect(h.tabs.onActivated.listening()).toBe(false);
    expect(await sessions.start(CAPTURED)).toEqual(Ok(undefined));
    expect(h.tabs.onUpdated.listening()).toBe(true);
    expect(h.tabs.onActivated.listening()).toBe(true);
    expect(await sessions.stop(CAPTURED, 'user')).toEqual(Ok(undefined));
    expect(h.tabs.onUpdated.listening()).toBe(false);
    expect(h.tabs.onActivated.listening()).toBe(false);
    sessions.dispose();
    expect(h.tabs.onRemoved.listening()).toBe(false);
  });

  it('recovers the captured tab from storage.session after a service worker restart', async () => {
    const h = setup();
    const first = await capturing(h);
    first.dispose();
    expect(h.tabs.onRemoved.listening()).toBe(false);
    // A new service worker: nothing in memory, the offscreen document still open.
    const second = kept(h.make());
    expect(await second.current()).toEqual(Ok({ tabId: CAPTURED, startedAt: 1_000 }));
    expect(h.tabs.onUpdated.listening()).toBe(true);
    h.tabs.onRemoved.fire(CAPTURED);
    await vi.waitFor(() => {
      expect(h.count('close')).toBe(1);
    });
    expect(h.count('audio/stop')).toBe(1);
    expect(await stored()).toBeUndefined();
    expect(h.tabs.onUpdated.listening()).toBe(false);
  });

  it('forgets a capture whose offscreen document is gone, and closes one left without a capture', async () => {
    const h = setup();
    const first = await capturing(h);
    first.dispose();
    h.state.open = false;
    const second = kept(h.make());
    expect(await second.current()).toEqual(Ok(undefined));
    expect(await stored()).toBeUndefined();
    expect(h.tabs.onUpdated.listening()).toBe(false);
    second.dispose();

    h.state.open = true;
    const third = kept(h.make());
    expect(await third.current()).toEqual(Ok(undefined));
    expect(h.count('close')).toBe(1);
  });
});

describe('following the captured tab', () => {
  it('keeps capturing across YouTube SPA navigation and resets the pipeline with the new context', async () => {
    const h = setup();
    const sessions = kept(await capturing(h));
    h.tabs.onUpdated.fire(
      CAPTURED,
      { status: 'loading' },
      { url: 'https://www.youtube.com/watch?v=fixture-v02' },
    );
    // Other changes of the tab (audible, title) say nothing about the site.
    h.tabs.onUpdated.fire(CAPTURED, {}, {});
    expect(await sessions.page(CAPTURED, NEXT_PAGE)).toEqual(Ok(undefined));
    expect(h.calls.slice(-2)).toEqual(['audio/reset', 'audio/config']);
    expect(h.of('audio/config')).toEqual([
      { config: { ...CONFIG, context: 'Title: Fixture Quest day 4\nChannel: Fixture Ch' } },
    ]);
    expect(await h.pages.get(CAPTURED)).toEqual(Ok(NEXT_PAGE));
    // The same video reported again (a reload): the context only.
    expect(await sessions.page(CAPTURED, NEXT_PAGE)).toEqual(Ok(undefined));
    expect(h.count('audio/reset')).toBe(1);
    expect(h.count('audio/config')).toBe(2);
    // The page learns that its tab is captured.
    expect(h.statuses(CAPTURED)).toEqual([{ state: 'away' }, { state: 'away' }]);
    // Another tab's page changes nothing of the capture.
    expect(await sessions.page(OTHER, PAGE)).toEqual(Ok(undefined));
    expect(await h.pages.get(OTHER)).toEqual(Ok(PAGE));
    expect(h.count('audio/config')).toBe(2);
    expect(await sessions.current()).toEqual(Ok({ tabId: CAPTURED, startedAt: 1_000 }));
    expect(h.count('audio/stop')).toBe(0);
  });

  it('sends the current front on start, away for a tab that reported none', async () => {
    const h = setup();
    const sessions = kept(await capturing(h));
    expect(h.of('audio/front')).toEqual([{ front: { state: 'away' } }]);
    expect(await sessions.stop(CAPTURED, 'user')).toEqual(Ok(undefined));
    // A tab in front that reported its video playing.
    expect(await h.fronts.report(OTHER, { state: 'active' })).toEqual(Ok(undefined));
    h.state.active = OTHER;
    expect(await sessions.start(OTHER)).toEqual(Ok(undefined));
    expect(h.of('audio/front')).toEqual([
      { front: { state: 'away' } },
      { front: { state: 'active' } },
    ]);
  });

  it('forwards front changes of the captured tab only', async () => {
    const h = setup();
    kept(await capturing(h));
    expect(await h.fronts.report(OTHER, { state: 'active' })).toEqual(Ok(undefined));
    expect(await h.fronts.report(CAPTURED, { state: 'active' })).toEqual(Ok(undefined));
    await vi.waitFor(() => {
      expect(h.of('audio/front')).toHaveLength(2);
    });
    expect(await h.fronts.report(CAPTURED, { state: 'pause', reason: 'paused' })).toEqual(
      Ok(undefined),
    );
    expect(await h.fronts.report(OTHER, { state: 'away', reason: 'hidden' })).toEqual(
      Ok(undefined),
    );
    await vi.waitFor(() => {
      expect(h.of('audio/front')).toHaveLength(3);
    });
    await settle();
    expect(h.of('audio/front')).toEqual([
      { front: { state: 'away' } },
      { front: { state: 'active' } },
      { front: { state: 'pause', reason: 'paused' } },
    ]);
  });

  it('forwards away while the captured tab is in the background, where Chrome keeps it visible', async () => {
    const h = setup();
    expect(await h.fronts.report(CAPTURED, { state: 'active' })).toEqual(Ok(undefined));
    kept(await capturing(h));
    h.state.active = OTHER;
    h.tabs.onActivated.fire({ tabId: OTHER, windowId: 1 });
    await vi.waitFor(() => {
      expect(h.of('audio/front')).toHaveLength(2);
    });
    // The page still reports itself in front; only its own pause shows once it is back.
    expect(await h.fronts.report(CAPTURED, { state: 'pause', reason: 'paused' })).toEqual(
      Ok(undefined),
    );
    await settle();
    h.state.active = CAPTURED;
    h.tabs.onActivated.fire({ tabId: CAPTURED, windowId: 1 });
    await vi.waitFor(() => {
      expect(h.of('audio/front')).toHaveLength(3);
    });
    expect(h.of('audio/front')).toEqual([
      { front: { state: 'active' } },
      { front: { state: 'away', reason: 'hidden' } },
      { front: { state: 'pause', reason: 'paused' } },
    ]);
  });

  it('sends the new context when the settings or the glossary change while capturing', async () => {
    const h = setup();
    const sessions = kept(await capturing(h));
    await glossaryStore(fakeBrowser.storage.local).save('UC-fixture', [
      { source: 'Fixturo', target: '' },
    ]);
    const glossary = [{ source: 'Fixturo', target: 'Fixturo' }];
    await vi.waitFor(() => {
      expect(h.of('audio/config').at(-1)).toEqual({ config: { ...CONFIG, glossary } });
    });
    await subtitleSettingsStore(fakeBrowser.storage.local).save({
      ...defaultSubtitleSettings,
      display: 'ja',
      translator: 'plamo',
    });
    await vi.waitFor(() => {
      expect(h.of('audio/config').at(-1)).toEqual({
        config: { ...CONFIG, glossary, display: 'ja', translator: 'plamo' },
      });
    });
    expect(await sessions.stop(CAPTURED, 'user')).toEqual(Ok(undefined));
    const sent = h.count('audio/config');
    await subtitleSettingsStore(fakeBrowser.storage.local).save(defaultSubtitleSettings);
    await settle();
    await settle();
    expect(h.count('audio/config')).toBe(sent);
  });

  it('forwards the lines and the status of the capture to the top frame of the captured tab only', async () => {
    const h = setup();
    const sessions = kept(await capturing(h));
    expect(await sessions.lines(CAPTURED, [LINE])).toEqual(Ok(undefined));
    expect(await sessions.lines(OTHER, [LINE])).toEqual(Ok(undefined));
    expect(await sessions.status(CAPTURED, { state: 'active' })).toEqual(Ok(undefined));
    expect(await sessions.status(OTHER, { state: 'active' })).toEqual(Ok(undefined));
    expect(h.toTabs).toEqual([
      {
        tabId: CAPTURED,
        frameId: 0,
        message: { type: 'subs/lines', payload: { lines: [LINE] }, target: 'content' },
      },
      {
        tabId: CAPTURED,
        frameId: 0,
        message: {
          type: 'subs/status',
          payload: { status: { state: 'active' } },
          target: 'content',
        },
      },
    ]);
  });
});

describe('the toggle-audio shortcut', () => {
  it('starts the watch page in front and stops it on the next press', async () => {
    const h = setup();
    await h.pages.report(CAPTURED, PAGE);
    const sessions = kept(h.make());
    expect(await sessions.toggle()).toEqual(Ok(undefined));
    expect(await sessions.current()).toEqual(Ok({ tabId: CAPTURED, startedAt: 1_000 }));
    expect(await sessions.toggle()).toEqual(Ok(undefined));
    expect(await sessions.current()).toEqual(Ok(undefined));
    expect(h.statuses(CAPTURED)).toEqual([{ state: 'stopped' }]);
    expect(h.count('audio/stop')).toBe(1);
  });

  it.each([
    { name: 'YouTube outside a watch page', url: 'https://www.youtube.com/feed/subscriptions' },
    { name: 'another site', url: 'https://example.com/watch?v=fixture-v01' },
    { name: 'a tab whose URL is hidden', url: undefined },
  ])('starts nothing on $name', async ({ url }) => {
    const h = setup();
    h.state.urls.set(CAPTURED, url);
    const sessions = kept(h.make());
    expect(await sessions.toggle()).toEqual(Ok(undefined));
    expect(h.calls).toEqual([]);
    expect(await sessions.current()).toEqual(Ok(undefined));
  });

  it.each([
    { name: 'without a projector', setting: { audio: false }, message: AUDIO_UNSUPPORTED_MESSAGE },
    {
      name: 'when the tab cannot be captured',
      setting: { streamError: 'Cannot capture a tab with an active stream.' },
      message: AUDIO_FAILED_MESSAGE,
    },
  ])('tells the watch page why the audio did not start $name', async ({ setting, message }) => {
    const h = setup(setting);
    await h.pages.report(CAPTURED, PAGE);
    const sessions = kept(h.make());
    expect(await sessions.toggle()).toMatchObject({ ok: false });
    expect(h.statuses(CAPTURED)).toEqual([{ state: 'error', message }]);
  });
});
