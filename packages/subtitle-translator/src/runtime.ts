import { browser } from 'wxt/browser';
import { Err, failure, launch, type Result } from '@chrome-toolbox/contracts';
import {
  connectionPort,
  createQueue,
  llmHandlers,
  llmProtocol,
  settingsStore,
  type ConnectionPort,
  type HostPermissions,
  type ProtocolHandlers,
  type StorageArea,
} from '@chrome-toolbox/extension-core';
import { subtitleProtocolSpec } from './protocol.ts';

/** The extension APIs a side panel uses; tests pass a fake with this shape. */
export type PanelApi = {
  storage: { local: StorageArea };
  permissions: HostPermissions;
  runtime: { sendMessage(message: unknown): Promise<unknown> };
};

/** Side panel adapter: settings in extension storage, inference through the service worker. */
export function sidePanelPort(api: PanelApi = browser): ConnectionPort {
  return connectionPort({
    settings: settingsStore(api.storage.local),
    permissions: api.permissions,
    send: (message) => api.runtime.sendMessage(message),
  });
}

/** The part of `runtime.MessageSender` that names the sending page and frame. */
export type Sender = Readonly<{
  tab?: Readonly<{ id?: number | undefined }> | undefined;
  frameId?: number | undefined;
  url?: string | undefined;
  /** `'null'` for an opaque origin (a sandboxed page). */
  origin?: string | undefined;
}>;
export type SenderKind = 'page' | 'content' | 'offscreen' | 'other';

const YOUTUBE_ORIGIN = 'https://www.youtube.com/';

/**
 * Who sent a message: the offscreen document, another page of this extension (the side panel),
 * the top frame of a YouTube tab (the content script), or anyone else. An opaque origin (a
 * sandboxed extension page) is `other`.
 */
export function senderKind(sender: Sender): SenderKind {
  const url = sender.url ?? '';
  if (sender.origin !== 'null' && url.startsWith(browser.runtime.getURL('/'))) {
    return url === `${browser.runtime.getURL('/')}offscreen.html` ? 'offscreen' : 'page';
  }
  const topFrame = sender.frameId === 0 && sender.tab?.id !== undefined;
  return topFrame && url.startsWith(YOUTUBE_ORIGIN) ? 'content' : 'other';
}

type Handlers = ProtocolHandlers<typeof subtitleProtocolSpec>;
const forbidden = (): Promise<Result<never>> => Promise.resolve(Err(failure('sender_forbidden')));

/** The messages each kind of sender may send; a message not in its table is `sender_forbidden`. */
function routesFor(kind: SenderKind, handlers: Handlers): Handlers {
  const nothing: Handlers = { 'llm/status': forbidden };
  const tables: Record<SenderKind, Handlers> = {
    page: handlers,
    content: nothing,
    offscreen: nothing,
    other: nothing,
  };
  return tables[kind];
}

/** Registers the service worker's message router and returns its cleanup. */
export function startBackground(): () => void {
  // One inference at a time; a full queue answers queue_full instead of growing.
  const queue = createQueue({ concurrency: 1, maxPending: 16 });
  const handlers = llmHandlers({ fetch: (input, init) => fetch(input, init), queue });
  const routes = {
    page: llmProtocol.route(routesFor('page', handlers)),
    content: llmProtocol.route(routesFor('content', handlers)),
    offscreen: llmProtocol.route(routesFor('offscreen', handlers)),
    other: llmProtocol.route(routesFor('other', handlers)),
  } satisfies Record<SenderKind, unknown>;
  function onMessage(
    message: unknown,
    sender: Sender,
    sendResponse: (response: unknown) => void,
  ): true {
    launch(
      async () => {
        sendResponse(await routes[senderKind(sender)](message));
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
