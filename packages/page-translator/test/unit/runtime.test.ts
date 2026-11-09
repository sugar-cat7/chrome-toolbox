import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
import { defaultSettings, PLAMO_TRANSLATE_MODEL } from '@chrome-toolbox/extension-core';
import { STUB_PAGE_PREFIX, STUB_PLAMO_PREFIX } from '@chrome-toolbox/extension-core/testing';
import { claimPage } from '../../src/content/claim.ts';
import { injectPage, PAGE_SCRIPT, type ScriptingApi } from '../../src/control.ts';
import { senderKind, startBackground } from '../../src/runtime.ts';
import { defaultPageSettings } from '../../src/settings.ts';
import { fakeBackground } from './chrome.ts';
import { gate, llama } from './llama.ts';

// The background also listens to the context menu, the shortcut and permission changes, which
// WXT's fake browser leaves out.
beforeEach(() => {
  fakeBackground();
});
afterEach(() => {
  fakeBrowser.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The options page, an extension page; opened in its own tab it also has a tab. */
const options: Browser.runtime.MessageSender = {
  url: 'chrome-extension://test-extension-id/options.html',
  origin: 'chrome-extension://test-extension-id',
};
/** The background's message listener and a way to ask it as a given sender. */
function background(): {
  ask: (message: unknown, sender: Browser.runtime.MessageSender) => Promise<unknown>;
  stop: () => void;
} {
  const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
  const stop = startBackground();
  const listener = add.mock.calls[0]?.[0];
  return {
    ask: (message, sender) => new Promise((resolve) => listener?.(message, sender, resolve)),
    stop,
  };
}
const start = { type: 'page/start', payload: { tabId: 3, url: 'https://wiki.fixture.test/a' } };
/** A page batch of one paragraph, as the page script sends it. */
const translate = {
  type: 'page/translate',
  payload: {
    purpose: 'page',
    units: [{ id: 1, tokens: [{ t: 'text', text: 'Final Boss Guide' }] }],
    page: { title: 'Fixture Wiki', site: 'wiki.fixture.test' },
  },
};
const cancel = { type: 'page/cancel', payload: {} };
const restore = { type: 'page/restore', payload: { tabId: 3 } };
const always = { type: 'page/always', payload: { pattern: 'https://wiki.fixture.test/*' } };
const cancelled = { ok: false, error: { internalCode: 'operation_cancelled' } };

describe('extension runtime wiring', () => {
  it('answers status messages from the background and removes its listeners on cleanup', async () => {
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
          {},
          resolve,
        ),
      ).toBe(true);
    });
    expect(reply).toEqual(Ok({ models: ['stub-model'] }));
    expect(fakeBrowser.tabs.onRemoved.hasListeners()).toBe(true);
    expect(fakeBrowser.storage.local.onChanged.hasListeners()).toBe(true);
    stop();
    expect(fakeBrowser.runtime.onMessage.hasListeners()).toBe(false);
    expect(fakeBrowser.tabs.onRemoved.hasListeners()).toBe(false);
    expect(fakeBrowser.storage.local.onChanged.hasListeners()).toBe(false);
  });

  it.each([
    { name: '設定ページ', sender: options, kind: 'page' },
    {
      name: 'タブで開いた設定ページ',
      sender: { ...options, tab: { id: 5 }, frameId: 0 },
      kind: 'page',
    },
    {
      name: 'トップフレーム',
      sender: { tab: { id: 3 }, frameId: 0, url: 'https://wiki.fixture.test/a' },
      kind: 'content',
    },
    { name: 'iframe', sender: { tab: { id: 3 }, frameId: 7 }, kind: 'other' },
    {
      name: 'サンドボックス',
      sender: { url: 'chrome-extension://test-extension-id/x.html', origin: 'null' },
      kind: 'other',
    },
    {
      name: 'ほかの拡張のページ',
      sender: { url: 'chrome-extension://other-extension-id/options.html' },
      kind: 'other',
    },
    {
      name: '似た名前のホスト',
      sender: { url: 'chrome-extension://test-extension-id.fixture.test/options.html' },
      kind: 'other',
    },
    { name: 'タブもページもない', sender: {}, kind: 'other' },
  ])('senderKind: $name', ({ sender, kind }) => {
    expect(senderKind(sender)).toBe(kind);
  });

  it('answers page/start only from extension pages', async () => {
    const execute = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue(undefined);
    const deliver = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const { ask, stop } = background();
    const tab = await fakeBrowser.tabs.create({ url: 'https://wiki.fixture.test/a' });
    const senders: Browser.runtime.MessageSender[] = [
      // The page script in the tab's top frame, and a script in one of its frames.
      { tab, frameId: 0, url: 'https://wiki.fixture.test/a' },
      { tab, frameId: 7, url: 'https://ads.fixture.test/frame' },
      // A sandboxed page of this extension, and another extension's page.
      { ...options, origin: 'null' },
      { url: 'chrome-extension://other-extension-id/popup.html' },
    ];
    for (const sender of senders)
      expect(await ask(start, sender)).toMatchObject({
        ok: false,
        error: { internalCode: 'sender_forbidden' },
      });
    expect(execute).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();

    expect(await ask(start, options)).toEqual(Ok({}));
    // Chrome gets the script's path from the extension root, as WXT types it (a leading slash).
    expect(execute.mock.calls).toEqual([
      [{ target: { tabId: 3, frameIds: [0] }, files: [`/${PAGE_SCRIPT}`] }],
    ]);
    expect(deliver.mock.calls).toEqual([
      [3, { type: 'page/command', payload: { action: 'translate' } }, { frameId: 0 }],
    ]);
    // The command follows the injection: the script must be there to receive it.
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      deliver.mock.invocationCallOrder[0] ?? 0,
    );
    // The popup sends no URL when the tab has none it may read.
    expect(await ask({ type: 'page/start', payload: { tabId: 4 } }, options)).toEqual(Ok({}));
    stop();
  });

  it('maps a refused injection to page_restricted', async () => {
    const execute = vi
      .spyOn(fakeBrowser.scripting, 'executeScript')
      .mockRejectedValue(new Error('Cannot access a chrome:// URL'));
    const deliver = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const { ask, stop } = background();
    expect(
      await ask({ type: 'page/start', payload: { tabId: 3, url: 'chrome://settings/' } }, options),
    ).toMatchObject({ ok: false, error: { internalCode: 'page_restricted' } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    stop();

    // The Web Store, a page without the tab's activeTab grant and a closed tab are refused alike.
    for (const reason of [
      'The extensions gallery cannot be scripted.',
      'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
      'No tab with id: 3',
    ]) {
      const api: ScriptingApi = { executeScript: () => Promise.reject(new Error(reason)) };
      expect(await injectPage(api, 3)).toMatchObject({
        ok: false,
        error: { internalCode: 'page_restricted' },
      });
    }
  });

  it('claims a page once per isolated world', () => {
    const world = {};
    expect(claimPage(world)).toBe(true);
    expect(claimPage(world)).toBe(false);
    expect(claimPage({})).toBe(true);
    // The mark is the shared symbol, so a script bundled apart finds it too.
    expect(Reflect.has(world, Symbol.for('chrome-toolbox.page-translator'))).toBe(true);
  });
  it.each([
    { route: 'page/translate', sender: 'page', expected: 'sender_forbidden' },
    { route: 'page/translate', sender: 'iframe', expected: 'sender_forbidden' },
    { route: 'page/translate', sender: 'other extension', expected: 'sender_forbidden' },
    { route: 'page/cancel', sender: 'page', expected: 'sender_forbidden' },
    { route: 'page/cancel', sender: 'iframe', expected: 'sender_forbidden' },
    { route: 'page/start', sender: 'content', expected: 'sender_forbidden' },
    { route: 'page/restore', sender: 'content', expected: 'sender_forbidden' },
    { route: 'page/restore', sender: 'iframe', expected: 'sender_forbidden' },
    { route: 'page/restore', sender: 'other extension', expected: 'sender_forbidden' },
    { route: 'page/always', sender: 'content', expected: 'sender_forbidden' },
    { route: 'page/always', sender: 'iframe', expected: 'sender_forbidden' },
    { route: 'page/always', sender: 'other extension', expected: 'sender_forbidden' },
  ] as const)('$route from $sender', async ({ route, sender, expected }) => {
    const server = llama();
    vi.stubGlobal('fetch', vi.fn(server.fetch));
    const { ask, stop } = background();
    const tab = await fakeBrowser.tabs.create({ url: 'https://wiki.fixture.test/a' });
    const senders: Record<typeof sender, Browser.runtime.MessageSender> = {
      page: options,
      iframe: { tab, frameId: 7, url: 'https://ads.fixture.test/frame' },
      'other extension': { url: 'chrome-extension://other-extension-id/popup.html' },
      content: { tab, frameId: 0, url: 'https://wiki.fixture.test/a' },
    };
    const messages = {
      'page/translate': translate,
      'page/cancel': cancel,
      'page/start': start,
      'page/restore': restore,
      'page/always': always,
    };
    expect(await ask(messages[route], senders[sender])).toMatchObject({
      ok: false,
      error: { internalCode: expected },
    });
    expect(server.calls).toEqual([]);
    expect(fakeBrowser.scripting.executeScript).not.toHaveBeenCalled();
    expect(fakeBrowser.tabs.sendMessage).not.toHaveBeenCalled();
    expect(await fakeBrowser.storage.session.get(null)).toEqual({});
    stop();
  });

  it('answers page/start on an excluded site with page_excluded and page/restore with the restore command', async () => {
    const execute = vi.spyOn(fakeBrowser.scripting, 'executeScript').mockResolvedValue(undefined);
    const deliver = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    await fakeBrowser.storage.local.set({
      page: { ...defaultPageSettings, never: ['wiki.fixture.test'] },
    });
    const { ask, stop } = background();
    expect(await ask(start, options)).toMatchObject({
      ok: false,
      error: { internalCode: 'page_excluded' },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(await ask(restore, options)).toEqual(Ok({}));
    expect(deliver.mock.calls).toEqual([
      [3, { type: 'page/command', payload: { action: 'restore' } }, { frameId: 0 }],
    ]);
    stop();
  });

  it("translates for a tab's top frame and stops it on page/cancel and when the tab closes", async () => {
    const held = gate();
    const server = llama({ door: () => held.promise });
    vi.stubGlobal('fetch', server.fetch);
    const { ask, stop } = background();
    const tab = await fakeBrowser.tabs.create({ url: 'https://wiki.fixture.test/a' });
    const other = await fakeBrowser.tabs.create({ url: 'https://wiki.fixture.test/b' });
    const top = (of: typeof tab): Browser.runtime.MessageSender => ({
      tab: of,
      frameId: 0,
      url: 'https://wiki.fixture.test/a',
    });
    // More than 6 units is no batch of the page script.
    const seven = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1,
      tokens: [{ t: 'text', text: 'Final Boss Guide' }],
    }));
    expect(
      await ask(
        { type: 'page/translate', payload: { ...translate.payload, units: seven } },
        top(tab),
      ),
    ).toMatchObject({ ok: false, error: { internalCode: 'input_invalid' } });

    const running = ask(translate, top(tab));
    await vi.waitFor(() => expect(server.chats(defaultSettings.models.translate)).toHaveLength(1));
    // Another tab's page/cancel leaves this tab's batch running.
    expect(await ask(cancel, top(other))).toEqual(Ok({}));
    expect(await ask(cancel, top(tab))).toEqual(Ok({}));
    expect(await running).toMatchObject(cancelled);

    const again = ask(translate, top(tab));
    await vi.waitFor(() => expect(server.chats(defaultSettings.models.translate)).toHaveLength(2));
    await fakeBrowser.tabs.onRemoved.trigger(tab.id ?? -1, {
      windowId: tab.windowId ?? -1,
      isWindowClosing: false,
    });
    expect(await again).toMatchObject(cancelled);

    held.open();
    expect(await ask(translate, top(other))).toEqual(
      Ok({
        results: [{ id: 1, pieces: [`${STUB_PAGE_PREFIX}Final Boss Guide`] }],
        translator: 'gemma',
      }),
    );
    stop();
  });

  it('reads the settings again when the shared or the page settings change', async () => {
    const server = llama();
    vi.stubGlobal('fetch', server.fetch);
    const { ask, stop } = background();
    const tab = await fakeBrowser.tabs.create({ url: 'https://wiki.fixture.test/a' });
    const top: Browser.runtime.MessageSender = {
      tab,
      frameId: 0,
      url: 'https://wiki.fixture.test/a',
    };
    expect(await ask(translate, top)).toMatchObject({ ok: true });
    expect(server.chats(defaultSettings.models.translate)).toHaveLength(1);

    await fakeBrowser.storage.local.set({
      settings: {
        ...defaultSettings,
        models: { ...defaultSettings.models, translate: 'gemma4-e2b' },
      },
    });
    expect(await ask(translate, top)).toMatchObject({ ok: true });
    expect(server.chats('gemma4-e2b')).toHaveLength(1);

    await fakeBrowser.storage.local.set({ page: { ...defaultPageSettings, translator: 'plamo' } });
    expect(await ask(translate, top)).toEqual(
      Ok({
        results: [{ id: 1, pieces: [`${STUB_PLAMO_PREFIX}Final Boss Guide`] }],
        translator: 'plamo',
      }),
    );
    expect(server.chats(PLAMO_TRANSLATE_MODEL)).toHaveLength(1);
    stop();
  });
});
