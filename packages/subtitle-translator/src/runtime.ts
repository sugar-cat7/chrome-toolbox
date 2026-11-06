import { browser } from 'wxt/browser';
import { Err, failure, launch, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  connectionPort,
  createLlamaClient,
  createLruCache,
  createQueue,
  llmHandlers,
  settingsStore,
  type ConnectionPort,
  type Fetch,
  type HostPermissions,
  type SettingsStore,
  type StorageArea,
} from '@chrome-toolbox/extension-core';
import { glossaryStore, type GlossaryStore } from './glossary.ts';
import { tabPagesStore, type PageInfo } from './page-context.ts';
import {
  subtitleProtocol,
  type SubtitleMessageType,
  type SubtitleProtocolHandlers,
  type TranslateRequest,
  type TranslateResponse,
} from './protocol.ts';
import {
  CAPTION_CACHE_ENTRIES,
  createSubtitleTranslator,
  type CaptionTranslator,
} from './translate.ts';

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

/** `offscreen.html`, alone or followed by a query or a hash (not by more path). */
const isOffscreenPath = (path: string): boolean => /^offscreen\.html(?:[?#]|$)/u.test(path);

const YOUTUBE_ORIGIN = 'https://www.youtube.com/';

/**
 * Who sent a message: the offscreen document, another page of this extension (the side panel),
 * the top frame of a YouTube tab (the content script), or anyone else. An opaque origin (a
 * sandboxed extension page) is `other`.
 */
export function senderKind(sender: Sender): SenderKind {
  const url = sender.url ?? '';
  if (sender.origin !== 'null' && url.startsWith(browser.runtime.getURL('/'))) {
    return isOffscreenPath(url.slice(browser.runtime.getURL('/').length)) ? 'offscreen' : 'page';
  }
  const topFrame = sender.frameId === 0 && sender.tab?.id !== undefined;
  return topFrame && url.startsWith(YOUTUBE_ORIGIN) ? 'content' : 'other';
}

/**
 * The messages each kind of sender may send. Any other message, valid or not, gets
 * `sender_forbidden` before it is validated.
 */
const ROUTES = {
  page: ['llm/status'],
  content: ['subs/page', 'subs/translate'],
  offscreen: [],
  other: [],
} as const satisfies Record<SenderKind, readonly SubtitleMessageType[]>;

/** Whether `message` names one of `types`; reads nothing else, so it runs before validation. */
function names(message: unknown, types: readonly string[]): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    typeof message.type === 'string' &&
    types.includes(message.type)
  );
}

const forbidden = (): Promise<Result<never>> => Promise.resolve(Err(failure('sender_forbidden')));

/**
 * A caption request may wait out a router that reloads the model (13 s measured): prefetch is
 * not in a hurry.
 */
const CAPTION_TIMEOUT_MS = 15_000;

/**
 * Translates caption sentences with the saved settings. The translator is made again when the
 * server changes; the cache and the queue (one request at a time, at most 4 waiting) stay.
 */
function captionTranslation({
  settings,
  glossary,
  fetch,
}: {
  settings: SettingsStore;
  glossary: GlossaryStore;
  fetch: Fetch;
}): {
  translate(
    this: void,
    request: TranslateRequest,
    page: PageInfo | undefined,
  ): Promise<Result<TranslateResponse>>;
  /** Cancels the waiting requests. */
  dispose(this: void): void;
} {
  const queue = createQueue({ concurrency: 1, maxPending: 4 });
  const cache = createLruCache<string, string>({ max: CAPTION_CACHE_ENTRIES });
  let active: { baseUrl: string; translator: CaptionTranslator } | undefined;
  async function translate(
    request: TranslateRequest,
    page: PageInfo | undefined,
  ): Promise<Result<TranslateResponse>> {
    const loaded = await settings.load();
    if (!loaded.ok) return loaded;
    const baseUrl = loaded.value.llamaBaseUrl;
    if (active?.baseUrl !== baseUrl) {
      const client = createLlamaClient({ baseUrl, fetch, queue, timeoutMs: CAPTION_TIMEOUT_MS });
      active = {
        baseUrl,
        translator: createSubtitleTranslator({
          client,
          settings: settings.load,
          glossary: glossary.load,
          cache,
        }),
      };
    }
    return active.translator.translate(request, page);
  }
  return { translate, dispose: () => queue.clear() };
}

/** Registers the service worker's message router and returns its cleanup. */
export function startBackground(): () => void {
  // One inference at a time; a full queue answers queue_full instead of growing.
  const queue = createQueue({ concurrency: 1, maxPending: 16 });
  const fetcher: Fetch = (input, init) => fetch(input, init);
  const llm = llmHandlers({ fetch: fetcher, queue });
  // What each watch page last reported (16 tabs): the context and glossary of its captions. Kept
  // in storage.session too, so the batches after a service worker restart still have them.
  const pages = tabPagesStore(browser.storage.session);
  const captions = captionTranslation({
    settings: settingsStore(browser.storage.local),
    glossary: glossaryStore(browser.storage.local),
    fetch: fetcher,
  });
  /** The handlers for one message; the content routes answer for the sender's tab. */
  function handlersFor(sender: Sender): SubtitleProtocolHandlers {
    const tabId = sender.tab?.id;
    return {
      ...llm,
      'subs/page': async ({ info }): Promise<Result<Record<string, never>>> => {
        if (tabId === undefined) return forbidden();
        const kept = await pages.report(tabId, info);
        return kept.ok ? Ok({}) : kept;
      },
      'subs/translate': async (request): Promise<Result<TranslateResponse>> => {
        if (tabId === undefined) return forbidden();
        const page = await pages.get(tabId);
        return page.ok ? captions.translate(request, page.value) : page;
      },
    };
  }
  /**
   * A closed tab's page is forgotten. The result is not used: an entry that stays ages out, and a
   * translation uses a page only for the video it names. Tab updates are not followed: without a
   * host permission Chrome leaves their URL out, and a listener would wake the service worker for
   * every tab of every site; a tab's next `subs/page` replaces its page (S43).
   */
  function onTabRemoved(tabId: number): void {
    launch(
      async () => {
        await pages.forget(tabId);
      },
      () => undefined,
    );
  }
  function onMessage(
    message: unknown,
    sender: Sender,
    sendResponse: (response: unknown) => void,
  ): true {
    launch(
      async () => {
        sendResponse(
          names(message, ROUTES[senderKind(sender)])
            ? await subtitleProtocol.route(handlersFor(sender))(message)
            : await forbidden(),
        );
      },
      (error) => sendResponse(Err(error)),
    );
    // Keeps the channel open for the asynchronous sendResponse.
    return true;
  }
  browser.runtime.onMessage.addListener(onMessage);
  browser.tabs.onRemoved.addListener(onTabRemoved);
  return () => {
    browser.runtime.onMessage.removeListener(onMessage);
    browser.tabs.onRemoved.removeListener(onTabRemoved);
    queue.clear();
    captions.dispose();
  };
}
