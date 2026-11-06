import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
import { subtitleStreamPart } from '@chrome-toolbox/extension-core';
import { glossaryStore } from '../../src/glossary.ts';
import {
  senderKind,
  type Sender,
  sidePanelPort,
  startBackground,
  type PanelApi,
} from '../../src/runtime.ts';
import { addressed, isFor } from '../../src/protocol.ts';

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

describe('caption translation routes', () => {
  it('answers subs/translate only for a YouTube top frame and uses that tab page context', async () => {
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
    expect(
      await glossaryStore(fakeBrowser.storage.local).save('UC-fixture', [
        { source: 'Fixturo', target: '' },
      ]),
    ).toMatchObject({ ok: true });
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => {
        listener?.(message, sender, resolve);
      });
    const watch = await fakeBrowser.tabs.create({ url: youtube });
    const other = await fakeBrowser.tabs.create({ url: youtube });
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

    expect(await ask(page, topFrame(watch))).toEqual(Ok({}));
    expect(await ask(translate('Fixturo is here.'), topFrame(watch))).toEqual(
      Ok({ lines: [{ id: '0:a', ja: '訳:一行', state: 'done' }] }),
    );
    // The tab that reported its page gets that page's context and its streamer's glossary.
    expect(bodies[0]).toMatchObject({ model: 'gemma4-e4b', id_slot: 0 });
    expect(bodies[0]?.messages[1]?.content).toContain(
      subtitleStreamPart({
        context: 'Title: Fixture Quest day 3\nChannel: Fixture Ch',
        glossary: [{ source: 'Fixturo', target: 'Fixturo' }],
      }),
    );
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
