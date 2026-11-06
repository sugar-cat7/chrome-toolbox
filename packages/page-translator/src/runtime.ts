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
import { injectPage, type ScriptingApi } from './control.ts';
import { pageProtocol, type PageProtocolHandlers } from './protocol.ts';

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

/**
 * `chrome.scripting` for `injectPage`. WXT types `files` as the built scripts' public paths
 * (`/content-scripts/page.js`); Chrome reads a path from the extension root with or without the
 * leading slash, and PAGE_SCRIPT has none.
 */
const scripting: ScriptingApi = {
  executeScript: ({ target, files }) =>
    browser.scripting.executeScript({ target, files: files as ScriptPublicPath[] }),
};

/** Routes only this extension's pages may use: they let the extension into a tab. */
type PageRoute = 'page/start';

/** Registers the service worker's message router and returns its cleanup. */
export function startBackground(): () => void {
  // One inference at a time; a full queue answers queue_full instead of growing.
  const queue = createQueue({ concurrency: 1, maxPending: 16 });
  const handlers: Omit<PageProtocolHandlers, PageRoute> = llmHandlers({
    fetch: (input, init) => fetch(input, init),
    queue,
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
  const forbidden = (): Promise<Result<never>> => Promise.resolve(Err(failure('sender_forbidden')));
  const otherHandlers: Pick<PageProtocolHandlers, PageRoute> = { 'page/start': forbidden };
  const routes = {
    page: pageProtocol.route({ ...handlers, ...pageHandlers }),
    other: pageProtocol.route({ ...handlers, ...otherHandlers }),
  };
  function onMessage(
    message: unknown,
    sender: Sender,
    sendResponse: (response: unknown) => void,
  ): true {
    const route = senderKind(sender) === 'page' ? routes.page : routes.other;
    launch(
      async () => {
        sendResponse(await route(message));
      },
      (error) => sendResponse(Err(error)),
    );
    // Keeps the channel open for the asynchronous sendResponse.
    return true;
  }
  browser.runtime.onMessage.addListener(onMessage);
  return () => {
    browser.runtime.onMessage.removeListener(onMessage);
    queue.clear();
  };
}
