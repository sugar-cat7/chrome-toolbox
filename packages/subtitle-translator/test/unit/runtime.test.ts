import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
import { subtitleStreamPart, type Fetch } from '@chrome-toolbox/extension-core';
import { glossaryStore } from '../../src/glossary.ts';
import { tabPagesStore } from '../../src/page-context.ts';
import { sidePanelPort, type PanelApi } from '../../src/panel.ts';
import { tabFronts } from '../../src/tab-fronts.ts';
import { defaultSubtitleSettings, subtitleSettingsStore } from '../../src/settings.ts';
import { senderKind, type Sender, startBackground } from '../../src/runtime.ts';
import { addressed, isFor, type SessionState } from '../../src/protocol.ts';

/** `commands.onCommand`, which the fake browser leaves unimplemented. */
function fakeCommands() {
  const listeners = new Set<(command: string) => void>();
  vi.spyOn(fakeBrowser.commands.onCommand, 'addListener').mockImplementation((listener) => {
    listeners.add(listener);
  });
  vi.spyOn(fakeBrowser.commands.onCommand, 'removeListener').mockImplementation((listener) => {
    listeners.delete(listener);
  });
  return {
    /** The viewer presses the shortcut of `command`. */
    press(command: string): void {
      for (const listener of listeners) listener(command);
    },
    listening: () => listeners.size,
  };
}
let commands: ReturnType<typeof fakeCommands>;
beforeEach(() => {
  commands = fakeCommands();
  // No test reaches a real server: a test that needs one stubs fetch itself.
  vi.stubGlobal(
    'fetch',
    vi.fn<Fetch>(async () => new Response('', { status: 503 })),
  );
});
afterEach(() => {
  fakeBrowser.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('extension runtime wiring', () => {
  it('answers status messages from the background and removes its listener on cleanup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        new URL(input).pathname === '/health'
          ? Response.json({ status: 'ok' })
          : Response.json({ data: [{ id: 'stub-model' }] }),
      ),
    );
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    expect(listener).toBeTypeOf('function');
    const reply = await new Promise((resolve) => {
      expect(
        listener?.(
          { type: 'llm/status', payload: { baseUrl: 'http://127.0.0.1:18083' } },
          {
            url: fakeBrowser.runtime.getURL('/sidepanel.html'),
            origin: fakeBrowser.runtime.getURL('/').replace(/\/$/u, ''),
          },
          resolve,
        ),
      ).toBe(true);
    });
    expect(reply).toEqual(Ok({ models: ['stub-model'] }));
    stop();
    expect(fakeBrowser.runtime.onMessage.hasListeners()).toBe(false);
  });

  it('saves the side panel URL in extension storage before asking the background', async () => {
    const send = vi.fn<PanelApi['runtime']['sendMessage']>(async () =>
      Ok({ models: ['stub-model'] }),
    );
    const port = sidePanelPort({
      storage: fakeBrowser.storage,
      permissions: { contains: async () => true, request: async () => false },
      runtime: { sendMessage: send },
    });
    expect(await port.load()).toEqual(Ok('http://127.0.0.1:18083'));
    expect(await port.check('http://127.0.0.1:8081/')).toEqual(Ok({ models: ['stub-model'] }));
    expect(send).toHaveBeenCalledWith({
      type: 'llm/status',
      payload: { baseUrl: 'http://127.0.0.1:8081' },
    });
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({
      settings: {
        llamaBaseUrl: 'http://127.0.0.1:8081',
        models: { translate: 'gemma4-e4b', clef: 'clef-flash', asr: 'gemma4-e4b' },
      },
    });
  });
});

const youtube = 'https://www.youtube.com/watch?v=abcdefghijk';
describe('sender routing', () => {
  it.each([
    {
      sender: 'side panel',
      given: { url: fakeBrowser.runtime.getURL('/sidepanel.html') },
      kind: 'page',
    },
    {
      sender: 'sandboxed extension page',
      given: { url: fakeBrowser.runtime.getURL('/sidepanel.html'), origin: 'null' },
      kind: 'other',
    },
    {
      sender: 'offscreen',
      given: { url: fakeBrowser.runtime.getURL('/offscreen.html') },
      kind: 'offscreen',
    },
    {
      sender: 'offscreen with a query',
      given: { url: `${fakeBrowser.runtime.getURL('/')}offscreen.html?x` },
      kind: 'offscreen',
    },
    {
      sender: 'offscreen with a hash',
      given: { url: `${fakeBrowser.runtime.getURL('/')}offscreen.html#y` },
      kind: 'offscreen',
    },
    {
      sender: 'a page named like offscreen',
      given: { url: `${fakeBrowser.runtime.getURL('/')}offscreen.html.evil.html` },
      kind: 'page',
    },
    {
      sender: 'youtube top frame',
      given: { url: youtube, tab: { id: 3 }, frameId: 0 },
      kind: 'content',
    },
    {
      sender: 'youtube iframe',
      given: { url: youtube, tab: { id: 3 }, frameId: 2 },
      kind: 'other',
    },
    {
      sender: 'example.com tab',
      given: { url: 'https://example.com/', tab: { id: 3 }, frameId: 0 },
      kind: 'other',
    },
    {
      sender: 'lookalike host',
      given: { url: 'https://www.youtube.com.example.com/', tab: { id: 3 }, frameId: 0 },
      kind: 'other',
    },
  ] satisfies { sender: string; given: Sender; kind: string }[])(
    'senderKind: $sender',
    ({ given, kind }) => {
      expect(senderKind(given)).toBe(kind);
    },
  );

  it.each([
    { sender: 'offscreen', url: fakeBrowser.runtime.getURL('/offscreen.html'), frameId: 0 },
    { sender: 'youtube top frame', url: youtube, frameId: 0 },
    { sender: 'a web page', url: 'https://example.com/', frameId: 0 },
  ])(
    'answers sender_forbidden to $sender, also for a malformed message',
    async ({ url, frameId }) => {
      const tab = await fakeBrowser.tabs.create({ url });
      const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
      const stop = startBackground();
      const listener = add.mock.calls[0]?.[0];
      const messages = [
        { type: 'llm/status', payload: { baseUrl: 'http://127.0.0.1:18083' } },
        { type: 'llm/status', payload: { baseUrl: 1 } },
        { type: 'nonsense' },
        'text',
      ];
      for (const message of messages) {
        const reply = await new Promise((resolve) => {
          listener?.(message, { url, frameId, tab }, resolve);
        });
        expect(reply).toMatchObject({ ok: false, error: { internalCode: 'sender_forbidden' } });
      }
      stop();
    },
  );
});

/** llama-server's chat endpoint at the HTTP boundary: every line is translated as `訳:一行`. */
function stubChat(): { model: string; id_slot: number; messages: { content: string }[] }[] {
  const bodies: { model: string; id_slot: number; messages: { content: string }[] }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
      return Response.json({
        choices: [{ message: { content: '訳:一行\n' }, finish_reason: 'stop' }],
      });
    }),
  );
  return bodies;
}
const topFrame = (tab: Browser.tabs.Tab): Browser.runtime.MessageSender => ({
  url: youtube,
  tab,
  frameId: 0,
});
const page = {
  type: 'subs/page',
  payload: {
    info: {
      videoId: 'abcdefghijk',
      streamer: 'UC-fixture',
      title: 'Fixture Quest day 3',
      author: 'Fixture Ch',
      live: false,
      tracks: 2,
    },
  },
};
const translate = (source: string) => ({
  type: 'subs/translate',
  payload: {
    videoId: 'abcdefghijk',
    sourceLang: 'en',
    previous: [],
    sentences: [{ id: '0:a', source }],
  },
});
/** The stream part of a prompt with the page's context and the streamer's glossary. */
const PAGE_PART = subtitleStreamPart({
  context: 'Title: Fixture Quest day 3\nChannel: Fixture Ch',
  glossary: [{ source: 'Fixturo', target: 'Fixturo' }],
});
const saveGlossary = async () => {
  expect(
    await glossaryStore(fakeBrowser.storage.local).save('UC-fixture', [
      { source: 'Fixturo', target: '' },
    ]),
  ).toMatchObject({ ok: true });
};

describe('caption translation routes', () => {
  it('answers subs/translate only for a YouTube top frame and uses that tab page context', async () => {
    const bodies = stubChat();
    await saveGlossary();
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => {
        listener?.(message, sender, resolve);
      });
    const watch = await fakeBrowser.tabs.create({ url: youtube });
    const other = await fakeBrowser.tabs.create({ url: youtube });

    expect(await ask(page, topFrame(watch))).toEqual(Ok({}));
    expect(await ask(translate('Fixturo is here.'), topFrame(watch))).toEqual(
      Ok({ lines: [{ id: '0:a', ja: '訳:一行', state: 'done' }] }),
    );
    // The tab that reported its page gets that page's context and its streamer's glossary.
    expect(bodies[0]).toMatchObject({ model: 'gemma4-e4b', id_slot: 0 });
    expect(bodies[0]?.messages[1]?.content).toContain(PAGE_PART);
    // Another YouTube tab has reported no page: neither.
    expect(await ask(translate('Okay chat.'), topFrame(other))).toMatchObject({ ok: true });
    expect(bodies[1]?.messages[1]?.content).toContain(
      subtitleStreamPart({ context: '', glossary: [] }),
    );
    expect(
      await ask(
        { ...translate('Okay chat.'), payload: { ...translate('x').payload, sentences: [] } },
        topFrame(watch),
      ),
    ).toMatchObject({ ok: false, error: { internalCode: 'input_invalid' } });

    for (const sender of [
      { url: 'https://example.com/', tab: watch, frameId: 0 },
      { url: youtube, tab: watch, frameId: 2 },
      { url: fakeBrowser.runtime.getURL('/sidepanel.html') },
      { url: fakeBrowser.runtime.getURL('/offscreen.html') },
    ] satisfies Browser.runtime.MessageSender[]) {
      for (const message of [page, translate('Fixturo is here.'), { type: 'subs/translate' }]) {
        expect(await ask(message, sender)).toMatchObject({
          ok: false,
          error: { internalCode: 'sender_forbidden' },
        });
      }
    }
    expect(bodies).toHaveLength(2);
    stop();
  });

  it('translates captions with the translator saved in the subtitle settings', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        if (input.endsWith('/v1/models'))
          return Response.json({ data: [{ id: 'gemma4-e4b' }, { id: 'plamo-3-translate-2b' }] });
        bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
        // A made-up translation, not a PLaMo output.
        return Response.json({
          choices: [{ message: { content: '訳P:一行' }, finish_reason: 'stop' }],
        });
      }),
    );
    expect(
      await subtitleSettingsStore(fakeBrowser.storage.local).save({
        ...defaultSubtitleSettings,
        translator: 'plamo',
      }),
    ).toMatchObject({ ok: true });
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => {
        add.mock.calls[0]?.[0]?.(message, sender, resolve);
      });
    const watch = await fakeBrowser.tabs.create({ url: youtube });

    expect(await ask(translate('Okay chat.'), topFrame(watch))).toEqual(
      Ok({ lines: [{ id: '0:a', ja: '訳P:一行', state: 'done' }] }),
    );
    expect(bodies).toEqual([
      expect.objectContaining({ model: 'plamo-3-translate-2b', id_slot: 0 }),
    ]);
    stop();
  });

  it('keeps the tab page across a service worker restart and forgets it when the tab closes', async () => {
    const bodies = stubChat();
    await saveGlossary();
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    // The listener of the service worker started last.
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => {
        add.mock.calls.at(-1)?.[0]?.(message, sender, resolve);
      });
    const watch = await fakeBrowser.tabs.create({ url: youtube });
    const closing = await fakeBrowser.tabs.create({ url: youtube });
    if (watch.id === undefined || closing.id === undefined) throw new Error('no tab id');
    /** What a service worker started now would find for the tab. */
    const stored = (tabId: number) => tabPagesStore(fakeBrowser.storage.session).get(tabId);

    const first = startBackground();
    expect(await ask(page, topFrame(watch))).toEqual(Ok({}));
    expect(await ask(page, topFrame(closing))).toEqual(Ok({}));
    first();
    // A new service worker has nothing in memory: the page comes from storage.session.
    const second = startBackground();
    // Tab updates are listened to only while a tab is captured: a listener would wake the service
    // worker for every tab of every site (S43). Nothing is captured once storage.session is read.
    await vi.waitFor(() => {
      expect(fakeBrowser.tabs.onUpdated.hasListeners()).toBe(false);
    });
    expect(await ask(translate('Fixturo is here.'), topFrame(watch))).toEqual(
      Ok({ lines: [{ id: '0:a', ja: '訳:一行', state: 'done' }] }),
    );
    expect(bodies[0]?.messages[1]?.content).toContain(PAGE_PART);

    // A closed tab is forgotten.
    expect(await stored(closing.id)).toMatchObject({ ok: true, value: { videoId: 'abcdefghijk' } });
    // The fake's tabs.remove looks the tab id up as a window id; the event is what Chrome sends.
    await fakeBrowser.tabs.onRemoved.trigger(closing.id, {
      isWindowClosing: false,
      windowId: closing.windowId,
    });
    await vi.waitFor(async () => {
      expect(await stored(closing.id ?? -1)).toEqual(Ok(undefined));
    });
    expect(await stored(watch.id)).toMatchObject({ ok: true, value: { videoId: 'abcdefghijk' } });
    second();
    expect(fakeBrowser.tabs.onRemoved.hasListeners()).toBe(false);
  });
});

/** Starts the service worker and asks its message listener as `sender` would. */
function background() {
  const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
  const stop = startBackground();
  const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
    new Promise((resolve) => {
      add.mock.calls.at(-1)?.[0]?.(message, sender, resolve);
    });
  return { stop, ask };
}
/** The senders other than a YouTube top frame. */
const strangers = (tab: Browser.tabs.Tab): Browser.runtime.MessageSender[] => [
  { url: 'https://example.com/', tab, frameId: 0 },
  { url: youtube, tab, frameId: 2 },
  { url: fakeBrowser.runtime.getURL('/sidepanel.html') },
  { url: fakeBrowser.runtime.getURL('/offscreen.html') },
];
const display = (mode: unknown) => ({ type: 'subs/display', payload: { mode } });

describe('display and front routes', () => {
  it('saves the display sent by a YouTube top frame and cycles it from the command', async () => {
    const store = subtitleSettingsStore(fakeBrowser.storage.local);
    const saved = { ...defaultSubtitleSettings, translator: 'plamo' } as const;
    expect(await store.save(saved)).toMatchObject({ ok: true });
    const shownAs = async (mode: string) => {
      await vi.waitFor(async () => {
        expect(await store.load()).toEqual(Ok({ ...saved, display: mode }));
      });
    };
    const { stop, ask } = background();
    const watch = await fakeBrowser.tabs.create({ url: youtube });

    expect(await ask(display('ja'), topFrame(watch))).toEqual(Ok({}));
    await shownAs('ja');
    commands.press('cycle-display');
    await shownAs('both');
    // Two quick presses step twice.
    commands.press('cycle-display');
    commands.press('cycle-display');
    await shownAs('off');
    // Another shortcut leaves the display alone.
    commands.press('toggle-audio');
    commands.press('cycle-display');
    await shownAs('ja');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await shownAs('ja');
    expect(await ask(display('dim'), topFrame(watch))).toMatchObject({
      ok: false,
      error: { internalCode: 'input_invalid' },
    });
    await shownAs('ja');
    stop();
    expect(commands.listening()).toBe(0);
  });

  it('refuses subs/display from another site with sender_forbidden', async () => {
    const { stop, ask } = background();
    const watch = await fakeBrowser.tabs.create({ url: youtube });
    // The side panel sends it too (Task 14).
    const panel = fakeBrowser.runtime.getURL('/sidepanel.html');
    for (const sender of strangers(watch).filter(({ url }) => url !== panel)) {
      for (const message of [display('off'), display('dim'), { type: 'subs/display' }]) {
        expect(await ask(message, sender)).toMatchObject({
          ok: false,
          error: { internalCode: 'sender_forbidden' },
        });
      }
    }
    expect(await fakeBrowser.storage.local.get('subtitles')).toEqual({});
    stop();
  });

  it('takes the front of a YouTube top frame, checked, and refuses it from anyone else', async () => {
    const { stop, ask } = background();
    const watch = await fakeBrowser.tabs.create({ url: youtube });
    const front = (payload: unknown) => ({ type: 'subs/front', payload });
    for (const state of [
      { state: 'active' },
      { state: 'pause', reason: 'muted' },
      { state: 'away', reason: 'display-off' },
    ])
      expect(await ask(front(state), topFrame(watch))).toEqual(Ok({}));
    for (const state of [
      { state: 'gone' },
      { state: 'away', reason: 'nap' },
      { state: 'active', since: 0 },
    ])
      expect(await ask(front(state), topFrame(watch))).toMatchObject({
        ok: false,
        error: { internalCode: 'input_invalid' },
      });
    for (const sender of strangers(watch))
      expect(await ask(front({ state: 'active' }), sender)).toMatchObject({
        ok: false,
        error: { internalCode: 'sender_forbidden' },
      });
    stop();
  });

  it('keeps the front of each tab across a service worker restart and forgets it when the tab closes', async () => {
    const watch = await fakeBrowser.tabs.create({ url: youtube });
    const tabId = watch.id ?? -1;
    /** What a service worker started now would find for the tab. */
    const stored = () => tabFronts(fakeBrowser.storage.session).get(tabId);
    const first = background();
    const muted = { state: 'pause', reason: 'muted' } as const;
    expect(await first.ask({ type: 'subs/front', payload: muted }, topFrame(watch))).toEqual(
      Ok({}),
    );
    first.stop();
    expect(await stored()).toEqual(Ok(muted));
    const second = background();
    await fakeBrowser.tabs.onRemoved.trigger(tabId, {
      isWindowClosing: false,
      windowId: watch.windowId,
    });
    await vi.waitFor(async () => {
      expect(await stored()).toEqual(Ok({ state: 'away' }));
    });
    second.stop();
  });
});

describe('addressed messages', () => {
  it('keeps the message and adds the target, which isFor reads before any validation', () => {
    const message = addressed('panel', { type: 'subs/status', payload: { a: 1 } });
    expect(message).toEqual({ type: 'subs/status', payload: { a: 1 }, target: 'panel' });
    expect(isFor('panel', message)).toBe(true);
    expect(isFor('content', message)).toBe(false);
    expect(isFor('panel', { type: 'x' })).toBe(false);
    expect(isFor('panel', null)).toBe(false);
    expect(isFor('panel', 'panel')).toBe(false);
  });
});

/**
 * Puts `mock` in place of a browser method for this test: the fake leaves these unimplemented,
 * and their callback overloads hide the promise form from `vi.spyOn`.
 */
function stub<F extends (...args: never[]) => unknown>(
  target: object,
  key: string,
  mock: Mock<F>,
): Mock<F> {
  const original: unknown = Reflect.get(target, key);
  Reflect.set(target, key, mock);
  onTestFinished(() => {
    Reflect.set(target, key, original);
  });
  return mock;
}
/** Chrome's tab capture, offscreen document and messaging, as the capture uses them. */
function fakeCapture() {
  let open = false;
  vi.stubGlobal(
    'fetch',
    vi.fn<Fetch>(async (input) =>
      new URL(input).pathname === '/props'
        ? Response.json({ total_slots: 3, modalities: { audio: true } })
        : new Response('', { status: 404 }),
    ),
  );
  const streamId = stub(
    fakeBrowser.tabCapture,
    'getMediaStreamId',
    vi.fn<(options: unknown, callback?: (streamId: string) => void) => void>(
      (_options, callback) => {
        callback?.('stream-1');
      },
    ),
  );
  stub(
    fakeBrowser.runtime,
    'getContexts',
    vi.fn<() => Promise<unknown[]>>(async () =>
      open ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [],
    ),
  );
  const create = stub(
    fakeBrowser.offscreen,
    'createDocument',
    vi.fn<(parameters: unknown) => Promise<void>>(async () => {
      open = true;
    }),
  );
  const close = stub(
    fakeBrowser.offscreen,
    'closeDocument',
    vi.fn<() => Promise<void>>(async () => {
      open = false;
    }),
  );
  const toOffscreen = stub(
    fakeBrowser.runtime,
    'sendMessage',
    vi.fn<(message: unknown) => Promise<unknown>>(async () => Ok({})),
  );
  const toTab = stub(
    fakeBrowser.tabs,
    'sendMessage',
    vi.fn<(tabId: number, message: unknown, options: unknown) => Promise<unknown>>(async () =>
      Ok({}),
    ),
  );
  return { stub, streamId, create, close, toOffscreen, toTab };
}
describe('audio capture wiring', () => {
  const offscreenSender = (): Browser.runtime.MessageSender => ({
    url: fakeBrowser.runtime.getURL('/offscreen.html'),
  });
  const line = {
    sentenceId: 'live:1',
    lang: 'en',
    source: 'Okay chat.',
    state: 'pending',
    endedAt: 5,
    final: true,
  };

  it('starts the capture of the watch page in front from the shortcut and routes the offscreen messages to it', async () => {
    const chrome = fakeCapture();
    const { stop, ask } = background();
    const watch = await fakeBrowser.tabs.create({ url: youtube, active: true });
    // The fake answers window queries only once a window has focus.
    const query = chrome.stub(
      fakeBrowser.tabs,
      'query',
      vi.fn<(info: unknown) => Promise<unknown[]>>(async () => [watch]),
    );
    commands.press('toggle-audio');
    await vi.waitFor(() => {
      expect(chrome.toOffscreen).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'audio/start',
          target: 'offscreen',
          payload: expect.objectContaining({ tabId: watch.id, streamId: 'stream-1' }),
        }),
      );
    });
    expect(query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(chrome.streamId).toHaveBeenCalledWith({ targetTabId: watch.id }, expect.any(Function));
    expect(chrome.create).toHaveBeenCalledWith({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: expect.any(String),
    });

    const lines = { type: 'audio/lines', payload: { tabId: watch.id, lines: [line] } };
    expect(await ask(lines, offscreenSender())).toEqual(Ok({}));
    expect(chrome.toTab).toHaveBeenCalledWith(
      watch.id,
      { type: 'subs/lines', payload: { lines: [line] }, target: 'content' },
      { frameId: 0 },
    );
    for (const sender of strangers(watch).slice(0, 3))
      expect(await ask(lines, sender)).toMatchObject({
        ok: false,
        error: { internalCode: 'sender_forbidden' },
      });
    expect(
      await ask({ type: 'audio/lines', payload: { tabId: watch.id } }, offscreenSender()),
    ).toMatchObject({ ok: false, error: { internalCode: 'input_invalid' } });

    expect(
      await ask({ type: 'audio/idle', payload: { tabId: watch.id } }, offscreenSender()),
    ).toEqual(Ok({}));
    await vi.waitFor(() => {
      expect(chrome.close).toHaveBeenCalledTimes(1);
    });
    expect(chrome.toOffscreen).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audio/stop', target: 'offscreen' }),
    );
    expect(await fakeBrowser.storage.session.get('capture')).toEqual({});
    stop();
    expect(fakeBrowser.tabs.onActivated.hasListeners()).toBe(false);
  });

  it('refuses the side panel and watch pages the offscreen messages, and the offscreen document the page ones', async () => {
    fakeCapture();
    const { stop, ask } = background();
    const watch = await fakeBrowser.tabs.create({ url: youtube });
    for (const message of [
      { type: 'audio/status', payload: { tabId: watch.id, status: { state: 'active' } } },
      { type: 'audio/failed', payload: { tabId: watch.id, code: 'audio_unsupported' } },
    ])
      for (const sender of [
        topFrame(watch),
        { url: fakeBrowser.runtime.getURL('/sidepanel.html') },
      ])
        expect(await ask(message, sender)).toMatchObject({
          ok: false,
          error: { internalCode: 'sender_forbidden' },
        });
    expect(await ask(page, offscreenSender())).toMatchObject({
      ok: false,
      error: { internalCode: 'sender_forbidden' },
    });
    stop();
  });
});

describe('toolbar icon (S46)', () => {
  /** A watch page of the `youtube` URL as its top frame reports it. */
  const pageOf = (live: boolean, tracks: number) => ({
    type: 'subs/page',
    payload: { info: { ...page.payload.info, live, tracks } },
  });

  it('opens the side panel before anything is awaited and starts the audio of a live watch page, then stops it on the next click', async () => {
    const chrome = fakeCapture();
    const open = chrome.stub(
      fakeBrowser.sidePanel,
      'open',
      vi.fn<(options: unknown) => Promise<void>>(async () => undefined),
    );
    const behavior = chrome.stub(
      fakeBrowser.sidePanel,
      'setPanelBehavior',
      vi.fn<(behavior: unknown) => Promise<void>>(async () => undefined),
    );
    const clicks = vi.spyOn(fakeBrowser.action.onClicked, 'addListener');
    const { stop, ask } = background();
    // The icon no longer opens the panel by itself: the click handler does.
    expect(behavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
    const watch = await fakeBrowser.tabs.create({ url: youtube });
    expect(await ask(pageOf(true, 0), topFrame(watch))).toEqual(Ok({}));
    const click = clicks.mock.calls.at(-1)?.[0];
    click?.(watch);
    // In the click's own turn, while Chrome still holds the gesture.
    expect(open).toHaveBeenCalledWith({ tabId: watch.id });
    await vi.waitFor(() => {
      expect(chrome.toOffscreen).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'audio/start', target: 'offscreen' }),
      );
    });
    click?.(watch);
    expect(open).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => {
      expect(chrome.close).toHaveBeenCalledTimes(1);
    });
    stop();
    expect(fakeBrowser.action.onClicked.hasListeners()).toBe(false);
  });

  it('only opens the side panel on a watch page with caption tracks', async () => {
    const chrome = fakeCapture();
    const open = chrome.stub(
      fakeBrowser.sidePanel,
      'open',
      vi.fn<(options: unknown) => Promise<void>>(async () => undefined),
    );
    const clicks = vi.spyOn(fakeBrowser.action.onClicked, 'addListener');
    const { stop, ask } = background();
    const watch = await fakeBrowser.tabs.create({ url: youtube });
    expect(await ask(pageOf(false, 2), topFrame(watch))).toEqual(Ok({}));
    clicks.mock.calls.at(-1)?.[0]?.(watch);
    expect(open).toHaveBeenCalledWith({ tabId: watch.id });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chrome.streamId).not.toHaveBeenCalled();
    expect(chrome.create).not.toHaveBeenCalled();
    stop();
  });
});

describe('side panel routes (Task 14)', () => {
  const panelUrl = fakeBrowser.runtime.getURL('/sidepanel.html');
  const panelSender = (): Browser.runtime.MessageSender => ({ url: panelUrl });
  const tabState = (tabId: number | undefined) => ({ type: 'subs/tab-state', payload: { tabId } });
  const patch = (fields: unknown) => ({ type: 'subs/settings', payload: { patch: fields } });
  const typeOf = (message: unknown): unknown =>
    typeof message === 'object' && message !== null && 'type' in message ? message.type : undefined;
  /** How many times the service worker told the side panel to ask again. */
  const told = (send: Mock<(message: unknown) => Promise<unknown>>): number =>
    send.mock.calls.filter(
      ([message]) => isFor('panel', message) && typeOf(message) === 'subs/state-changed',
    ).length;

  it('answers the state of a tab from what its watch page reported', async () => {
    const { stop, ask } = background();
    const watch = await fakeBrowser.tabs.create({ url: youtube });
    const other = await fakeBrowser.tabs.create({ url: 'https://example.com/' });
    expect(await ask(page, topFrame(watch))).toEqual(Ok({}));
    const muted = { state: 'pause', reason: 'muted' } as const;
    expect(await ask({ type: 'subs/front', payload: muted }, topFrame(watch))).toEqual(Ok({}));
    expect(await ask(tabState(watch.id), panelSender())).toEqual(
      Ok({
        tabId: watch.id,
        page: page.payload.info,
        source: 'captions',
        front: muted,
        translator: { chosen: 'gemma' },
      }),
    );
    // A tab without a watch page: no page, and away like any tab that reported nothing.
    expect(await ask(tabState(other.id), panelSender())).toEqual(
      Ok({
        tabId: other.id,
        source: 'none',
        front: { state: 'away' },
        translator: { chosen: 'gemma' },
      }),
    );
    // With the audio chosen as the source, a tab that is not captured has none.
    await subtitleSettingsStore(fakeBrowser.storage.local).save({
      ...defaultSubtitleSettings,
      source: 'audio',
      translator: 'plamo',
    });
    expect(await ask(tabState(watch.id), panelSender())).toMatchObject({
      ok: true,
      value: { source: 'none', translator: { chosen: 'plamo' } },
    });
    expect(await ask(tabState(undefined), panelSender())).toMatchObject({
      ok: false,
      error: { internalCode: 'input_invalid' },
    });
    stop();
  });

  it('gives the status of the caption translator with its lines translated by Gemma', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<Fetch>(async (input) =>
        input.endsWith('/v1/models')
          ? Response.json({ data: [{ id: 'gemma4-e4b' }] })
          : Response.json({
              choices: [{ message: { content: '訳:一行\n' }, finish_reason: 'stop' }],
            }),
      ),
    );
    await subtitleSettingsStore(fakeBrowser.storage.local).save({
      ...defaultSubtitleSettings,
      translator: 'plamo',
    });
    const { stop, ask } = background();
    const watch = await fakeBrowser.tabs.create({ url: youtube });
    expect(await ask(translate('Okay chat.'), topFrame(watch))).toEqual(
      Ok({ lines: [{ id: '0:a', ja: '訳:一行', state: 'done' }] }),
    );
    expect(await ask(tabState(watch.id), panelSender())).toMatchObject({
      ok: true,
      value: {
        translator: {
          chosen: 'plamo',
          fallback: { latest: 'not_listed', lines: { not_listed: 1, refused: 0, language: 0 } },
        },
      },
    });
    stop();
  });

  it("reads the captured tab's session from the offscreen document, stops it from the panel and tells the panel", async () => {
    const chrome = fakeCapture();
    const { stop, ask } = background();
    const watch = await fakeBrowser.tabs.create({ url: youtube, active: true });
    const other = await fakeBrowser.tabs.create({ url: youtube });
    const session: SessionState = {
      tabId: watch.id ?? -1,
      startedAt: 5,
      front: { state: 'active' },
      stats: { segments: 3, silent: 1, dropped: 0, expired: 0, skipped: 0, failed: 0, lang: 'en' },
      translator: { chosen: 'gemma' },
    };
    chrome.toOffscreen.mockImplementation(async (message) =>
      Ok(typeOf(message) === 'audio/state' ? session : {}),
    );
    chrome.stub(
      fakeBrowser.tabs,
      'query',
      vi.fn<(info: unknown) => Promise<unknown[]>>(async () => [watch]),
    );
    expect(await ask(page, topFrame(watch))).toEqual(Ok({}));
    // A watch page that reported its page: the panel asks again.
    expect(told(chrome.toOffscreen)).toBe(1);
    commands.press('toggle-audio');
    // The start began and ended.
    await vi.waitFor(() => {
      expect(told(chrome.toOffscreen)).toBe(3);
    });
    expect(await ask(tabState(watch.id), panelSender())).toEqual(
      Ok({
        tabId: watch.id,
        page: page.payload.info,
        source: 'audio',
        front: { state: 'away' },
        session,
        translator: { chosen: 'gemma' },
      }),
    );
    // Another tab is not the captured one: nothing stops.
    expect(await ask({ type: 'subs/stop', payload: { tabId: other.id } }, panelSender())).toEqual(
      Ok({}),
    );
    expect(chrome.close).not.toHaveBeenCalled();
    expect(await ask({ type: 'subs/stop', payload: { tabId: watch.id } }, panelSender())).toEqual(
      Ok({}),
    );
    expect(chrome.close).toHaveBeenCalledOnce();
    expect(told(chrome.toOffscreen)).toBe(4);
    expect(await ask(tabState(watch.id), panelSender())).toEqual(
      Ok({
        tabId: watch.id,
        page: page.payload.info,
        source: 'captions',
        front: { state: 'away' },
        translator: { chosen: 'gemma' },
      }),
    );
    stop();
  });

  it('answers the tab state at once while its capture is starting, and tells the panel when it started', async () => {
    const chrome = fakeCapture();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A router that loads the speech model takes its time to answer /props.
    vi.stubGlobal(
      'fetch',
      vi.fn<Fetch>(async (input) => {
        if (new URL(input).pathname !== '/props') return new Response('', { status: 404 });
        await held;
        return Response.json({ total_slots: 3, modalities: { audio: true } });
      }),
    );
    const { stop, ask } = background();
    const watch = await fakeBrowser.tabs.create({ url: youtube, active: true });
    chrome.stub(
      fakeBrowser.tabs,
      'query',
      vi.fn<(info: unknown) => Promise<unknown[]>>(async () => [watch]),
    );
    expect(await ask(page, topFrame(watch))).toEqual(Ok({}));
    commands.press('toggle-audio');
    // The start began: the panel was told.
    await vi.waitFor(() => {
      expect(told(chrome.toOffscreen)).toBe(2);
    });
    const late = new Promise((resolve) => {
      setTimeout(() => resolve('late'), 0);
    });
    expect(await Promise.race([ask(tabState(watch.id), panelSender()), late])).toEqual(
      Ok({
        tabId: watch.id,
        page: page.payload.info,
        source: 'captions',
        front: { state: 'away' },
        starting: true,
        translator: { chosen: 'gemma' },
      }),
    );
    release();
    await vi.waitFor(() => {
      expect(told(chrome.toOffscreen)).toBe(3);
    });
    expect(await ask(tabState(watch.id), panelSender())).toMatchObject({
      ok: true,
      value: { source: 'audio' },
    });
    expect(await ask(tabState(watch.id), panelSender())).not.toMatchObject({
      value: { starting: true },
    });
    stop();
  });

  it('tells whether the server takes audio input for models.asr and lists PLaMo', async () => {
    const asked: string[] = [];
    let server: { audio?: boolean; models?: string[] } = {
      audio: false,
      models: ['gemma4-e4b', 'plamo-3-translate-2b'],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn<Fetch>(async (input) => {
        const url = new URL(input);
        asked.push(`${url.pathname}${url.search}`);
        if (url.pathname === '/props' && server.audio !== undefined)
          return Response.json({ total_slots: 3, modalities: { audio: server.audio } });
        if (url.pathname === '/v1/models' && server.models !== undefined)
          return Response.json({ data: server.models.map((id) => ({ id })) });
        return new Response('', { status: 503 });
      }),
    );
    const { stop, ask } = background();
    const capability = { type: 'subs/capability', payload: {} };
    expect(await ask(capability, panelSender())).toEqual(Ok({ audio: false, plamo: true }));
    expect([...asked].sort()).toEqual(['/props?model=gemma4-e4b', '/v1/models']);
    server = { audio: true, models: ['gemma4-e4b'] };
    expect(await ask(capability, panelSender())).toEqual(Ok({ audio: true, plamo: false }));
    // A server that answers neither: both unknown.
    server = {};
    expect(await ask(capability, panelSender())).toEqual(Ok({}));
    stop();
  });

  it('saves only the fields the panel changed, over a display a watch page changed meanwhile', async () => {
    const store = subtitleSettingsStore(fakeBrowser.storage.local);
    const { stop, ask } = background();
    const watch = await fakeBrowser.tabs.create({ url: youtube });
    expect(await ask(display('off'), topFrame(watch))).toEqual(Ok({}));
    expect(await ask(patch({ source: 'audio' }), panelSender())).toEqual(Ok({}));
    expect(await store.load()).toEqual(
      Ok({ ...defaultSubtitleSettings, display: 'off', source: 'audio' }),
    );
    expect(await ask(patch({ sourceLang: 'ko', translator: 'plamo' }), panelSender())).toEqual(
      Ok({}),
    );
    // The panel's display goes through the same queue as the player button's.
    expect(await ask(display('ja'), panelSender())).toEqual(Ok({}));
    const saved = { display: 'ja', source: 'audio', sourceLang: 'ko', translator: 'plamo' };
    expect(await store.load()).toEqual(Ok(saved));
    // The display is not a field of the patch, and every value is checked.
    for (const fields of [{ display: 'off' }, { source: 'tv' }, { sourceLang: 'xx' }])
      expect(await ask(patch(fields), panelSender())).toMatchObject({
        ok: false,
        error: { internalCode: 'input_invalid' },
      });
    expect(await store.load()).toEqual(Ok(saved));
    stop();
  });

  it('takes the side panel routes only from extension pages', async () => {
    const { stop, ask } = background();
    const watch = await fakeBrowser.tabs.create({ url: youtube });
    const messages = [
      tabState(watch.id),
      { type: 'subs/capability', payload: {} },
      patch({ source: 'audio' }),
      { type: 'subs/stop', payload: { tabId: watch.id } },
    ];
    for (const sender of [
      topFrame(watch),
      ...strangers(watch).filter(({ url }) => url !== panelUrl),
    ])
      for (const message of messages)
        expect(await ask(message, sender)).toMatchObject({
          ok: false,
          error: { internalCode: 'sender_forbidden' },
        });
    expect(await fakeBrowser.storage.local.get('subtitles')).toEqual({});
    stop();
  });
});
