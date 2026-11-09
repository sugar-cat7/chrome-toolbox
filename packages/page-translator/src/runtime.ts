import { browser } from 'wxt/browser';
import type { ScriptPublicPath } from 'wxt/utils/inject-script';
import { capture, Err, failure, launch, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  connectionPort,
  createQueue,
  llmHandlers,
  settingsStore,
  type ConnectionPort,
  type HostPermissions,
  type StorageArea,
} from '@chrome-toolbox/extension-core';
import { injectPage, PAGE_SCRIPT, type ScriptingApi } from './control.ts';
import { pageProtocol, type PageProtocolHandlers } from './protocol.ts';
import { pageSettingsStore } from './settings.ts';
import { createPageTranslator } from './translator.ts';

/** The extension APIs the options page uses; tests pass a fake with this shape. */
export type PanelApi = {
  storage: { local: StorageArea };
  permissions: HostPermissions;
  runtime: { sendMessage(message: unknown): Promise<unknown> };
};

/** Options page adapter: settings in extension storage, inference through the service worker. */
export function optionsPort(api: PanelApi = browser): ConnectionPort {
  return connectionPort({
    settings: settingsStore(api.storage.local),
    permissions: api.permissions,
    send: (message) => api.runtime.sendMessage(message),
  });
}

/** The part of `runtime.MessageSender` that names the sending page and frame. */
type Sender = Readonly<{
  tab?: Readonly<{ id?: number | undefined }> | undefined;
  frameId?: number | undefined;
  url?: string | undefined;
  /** `'null'` for an opaque origin (a sandboxed page). */
  origin?: string | undefined;
}>;

/**
 * Who sent a message: one of this extension's pages (`page`: the popup or the options page, also
 * when opened in a tab; its URL is under this extension's base URL and its origin is not opaque,
 * as a sandboxed page's is), the page script in a tab's top frame (`content`), or anything else
 * (`other`: a subframe, a sandboxed page, another extension).
 */
export function senderKind(sender: Sender): 'page' | 'content' | 'other' {
  if (sender.origin !== 'null' && (sender.url?.startsWith(browser.runtime.getURL('/')) ?? false))
    return 'page';
  return sender.tab?.id !== undefined && sender.frameId === 0 ? 'content' : 'other';
}

/** The page script as WXT types the built scripts' paths: from the extension root, with a slash. */
const PAGE_FILE: ScriptPublicPath = `/${PAGE_SCRIPT}`;
/** Whether `file` names a script this background injects. */
const isInjected = (file: string): file is ScriptPublicPath => file === PAGE_FILE;
/**
 * `chrome.scripting` for `injectPage`, whose paths (PAGE_SCRIPT) have no leading slash: Chrome
 * gets each with the slash, as WXT types them. A path that names no injected script is left out,
 * and Chrome refuses an injection without files (injectPage: `page_restricted`).
 */
const scripting: ScriptingApi = {
  executeScript: ({ target, files }) =>
    browser.scripting.executeScript({
      target,
      files: files.map((file) => `/${file}`).filter(isInjected),
    }),
};

/** Routes only this extension's pages may use: they let the extension into a tab. */
type PageRoute = 'page/start';
/** Routes only the page script in a tab's top frame may use: they translate for that tab. */
type ContentRoute = 'page/translate' | 'page/cancel';
/** The storage keys of the settings the translator reads: the shared ones and the page's. */
const SETTINGS_KEYS = ['settings', 'page'] as const;

/** Registers the service worker's message router and returns its cleanup. */
export function startBackground(): () => void {
  // One status check at a time; a full queue answers queue_full instead of growing.
  const queue = createQueue({ concurrency: 1, maxPending: 16 });
  const handlers: Omit<PageProtocolHandlers, PageRoute | ContentRoute> = llmHandlers({
    fetch: (input, init) => fetch(input, init),
    queue,
  });
  const translator = createPageTranslator({
    fetch: (input, init) => fetch(input, init),
    settings: settingsStore(browser.storage.local),
    pageSettings: pageSettingsStore(browser.storage.local),
  });
  const pageHandlers: Pick<PageProtocolHandlers, PageRoute> = {
    // The popup's tab got `activeTab` from the toolbar button: the page script goes into its top
    // frame and is told to translate. A second press injects again; the script already there
    // keeps the page (claimPage).
    'page/start': async ({ tabId }): Promise<Result<Record<string, never>>> => {
      const injected = await injectPage(scripting, tabId);
      if (!injected.ok) return injected;
      const told = await capture(
        () =>
          browser.tabs.sendMessage(
            tabId,
            { type: 'page/command', payload: { action: 'translate' } },
            { frameId: 0 },
          ),
        'ipc_failed',
      );
      return told.ok ? Ok({}) : told;
    },
  };
  /** The page script's routes for the tab it runs in: requests and cancels are that tab's. */
  const contentHandlers = (tabId: number): Pick<PageProtocolHandlers, ContentRoute> => ({
    'page/translate': (request) => translator.translate(tabId, request),
    // The page left the viewer: its batch stops, a selection bubble's request goes on.
    'page/cancel': () => {
      translator.cancel(tabId, 'page');
      return Promise.resolve(Ok({}));
    },
  });
  const forbidden = (): Promise<Result<never>> => Promise.resolve(Err(failure('sender_forbidden')));
  const notPage: Pick<PageProtocolHandlers, PageRoute> = { 'page/start': forbidden };
  const notContent: Pick<PageProtocolHandlers, ContentRoute> = {
    'page/translate': forbidden,
    'page/cancel': forbidden,
  };
  const routes = {
    page: pageProtocol.route({ ...handlers, ...pageHandlers, ...notContent }),
    other: pageProtocol.route({ ...handlers, ...notPage, ...notContent }),
  };
  /** The route for `sender`: a content script's carries the tab it runs in. */
  function routeOf(sender: Sender): (message: unknown) => Promise<Result<unknown>> {
    const kind = senderKind(sender);
    const tabId = sender.tab?.id;
    if (kind !== 'content' || tabId === undefined)
      return kind === 'page' ? routes.page : routes.other;
    return pageProtocol.route({ ...handlers, ...notPage, ...contentHandlers(tabId) });
  }
  function onMessage(
    message: unknown,
    sender: Sender,
    sendResponse: (response: unknown) => void,
  ): true {
    const route = routeOf(sender);
    launch(
      async () => {
        sendResponse(await route(message));
      },
      (error) => sendResponse(Err(error)),
    );
    // Keeps the channel open for the asynchronous sendResponse.
    return true;
  }
  /** A closed tab's requests stop, the page's and the selection's. */
  function onTabRemoved(tabId: number): void {
    translator.cancel(tabId);
  }
  /** The options page or the popup saved settings: the next request reads them again. */
  function onStorageChanged(changes: Record<string, unknown>): void {
    if (SETTINGS_KEYS.some((key) => Object.hasOwn(changes, key))) translator.reload();
  }
  browser.runtime.onMessage.addListener(onMessage);
  browser.tabs.onRemoved.addListener(onTabRemoved);
  browser.storage.local.onChanged.addListener(onStorageChanged);
  return () => {
    browser.runtime.onMessage.removeListener(onMessage);
    browser.tabs.onRemoved.removeListener(onTabRemoved);
    browser.storage.local.onChanged.removeListener(onStorageChanged);
    translator.dispose();
    queue.clear();
  };
}
