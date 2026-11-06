import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
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
    'answers sender_forbidden to $sender for a message not in its table',
    async ({ url, frameId }) => {
      const tab = await fakeBrowser.tabs.create({ url });
      const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
      const stop = startBackground();
      const listener = add.mock.calls[0]?.[0];
      const reply = await new Promise((resolve) => {
        listener?.(
          { type: 'llm/status', payload: { baseUrl: 'http://127.0.0.1:18083' } },
          { url, frameId, tab },
          resolve,
        );
      });
      expect(reply).toMatchObject({ ok: false, error: { internalCode: 'sender_forbidden' } });
      stop();
    },
  );
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
