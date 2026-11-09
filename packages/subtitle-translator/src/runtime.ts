import { browser, type Browser } from 'wxt/browser';
import { capture, Err, failure, launch, Ok, type Result } from '@chrome-toolbox/contracts';
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
import { tabPagesStore, type PageInfo, type TabPageStore } from './page-context.ts';
import {
  nextDisplay,
  subtitleSettingsStore,
  type DisplayMode,
  type SubtitleSettings,
  type SubtitleSettingsStore,
} from './settings.ts';
import {
  subtitleProtocol,
  type SubtitleMessageType,
  type SubtitleProtocolHandlers,
  type TranslateRequest,
  type TranslateResponse,
} from './protocol.ts';
import { createSessions, type Sessions } from './sessions.ts';
import { tabFronts, type TabFronts } from './tab-fronts.ts';
import {
  CAPTION_CACHE_ENTRIES,
  createSubtitleTranslator,
  type CaptionCacheEntry,
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
  content: ['subs/page', 'subs/translate', 'subs/front', 'subs/display'],
  offscreen: ['audio/lines', 'audio/status', 'audio/idle', 'audio/failed'],
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
  subtitles,
  glossary,
  fetch,
}: {
  settings: SettingsStore;
  subtitles: SubtitleSettingsStore;
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
  const cache = createLruCache<string, CaptionCacheEntry>({ max: CAPTION_CACHE_ENTRIES });
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
          subtitles: subtitles.load,
          glossary: glossary.load,
          cache,
        }),
      };
    }
    return active.translator.translate(request, page);
  }
  return { translate, dispose: () => queue.clear() };
}

/** The shortcut (`commands` in wxt.config.ts) that steps the display: ja → both → source → off. */
const CYCLE_DISPLAY = 'cycle-display';
/** The shortcut that starts or stops the speech subtitles of the tab in front. */
const TOGGLE_AUDIO = 'toggle-audio';
/** Shown by Chrome where it lists the extension's offscreen document (UI text is Japanese). */
const OFFSCREEN_JUSTIFICATION = 'タブの音声を取り込み、話している内容を字幕にします。';

/** The service worker's audio capture over Chrome's tab capture and offscreen document. */
function audioSessions({
  pages,
  fronts,
  subtitles,
  fetch,
}: {
  pages: TabPageStore;
  fronts: TabFronts;
  subtitles: SubtitleSettingsStore;
  fetch: Fetch;
}): Sessions {
  return createSessions({
    tabCapture: {
      getMediaStreamId: (targetTabId, done) => {
        // The callback form, so that runtime.lastError tells why no id came.
        browser.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
          done(streamId, browser.runtime.lastError?.message);
        });
      },
    },
    offscreen: {
      has: async (): Promise<Result<boolean>> => {
        const contexts = await capture(
          () => browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }),
          'capture_failed',
        );
        return contexts.ok ? Ok(contexts.value.length > 0) : contexts;
      },
      create: () =>
        capture(
          () =>
            browser.offscreen.createDocument({
              url: 'offscreen.html',
              reasons: ['USER_MEDIA'],
              justification: OFFSCREEN_JUSTIFICATION,
            }),
          'capture_failed',
        ),
      close: () => capture(() => browser.offscreen.closeDocument(), 'capture_failed'),
    },
    session: browser.storage.session,
    storage: browser.storage.local,
    send: (message) => browser.runtime.sendMessage(message),
    tabs: browser.tabs,
    settings: settingsStore(browser.storage.local),
    subtitles,
    glossary: glossaryStore(browser.storage.local),
    pages,
    fronts,
    fetch,
    now: () => Date.now(),
  });
}

/**
 * Saves the display mode in the subtitle settings, which every tab follows. One change at a time:
 * two quick presses of the shortcut step twice.
 */
function displaySwitch(subtitles: SubtitleSettingsStore): {
  change(this: void, next: (mode: DisplayMode) => DisplayMode): Promise<Result<SubtitleSettings>>;
  dispose(this: void): void;
} {
  const queue = createQueue({ concurrency: 1, maxPending: 4 });
  return {
    change: (next) =>
      queue.run(async (): Promise<Result<SubtitleSettings>> => {
        const loaded = await subtitles.load();
        if (!loaded.ok) return loaded;
        return subtitles.save({ ...loaded.value, display: next(loaded.value.display) });
      }),
    dispose: () => queue.clear(),
  };
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
  // Whether each watch page has its video in front (16 tabs), also in storage.session: the capture
  // (Task 13) follows its changes with `fronts.onFront`, the side panel (Task 14) reads it.
  const fronts = tabFronts(browser.storage.session);
  const subtitles = subtitleSettingsStore(browser.storage.local);
  const display = displaySwitch(subtitles);
  // The tab whose audio is captured (one at a time), kept in storage.session too.
  const sessions = audioSessions({ pages, fronts, subtitles, fetch: fetcher });
  const captions = captionTranslation({
    settings: settingsStore(browser.storage.local),
    subtitles,
    glossary: glossaryStore(browser.storage.local),
    fetch: fetcher,
  });
  /** The handlers for one message; the content routes answer for the sender's tab. */
  function handlersFor(sender: Sender): SubtitleProtocolHandlers {
    const tabId = sender.tab?.id;
    /** An empty answer once `done` succeeded. */
    const answer = async (done: Promise<Result<void>>): Promise<Result<Record<string, never>>> => {
      const result = await done;
      return result.ok ? Ok({}) : result;
    };
    return {
      ...llm,
      'subs/page': async ({ info }): Promise<Result<Record<string, never>>> => {
        if (tabId === undefined) return forbidden();
        // A new video in the captured tab resets the pipeline with its context.
        return answer(sessions.page(tabId, info));
      },
      'audio/lines': ({ tabId: captured, lines }) => answer(sessions.lines(captured, lines)),
      'audio/status': ({ tabId: captured, status }) => answer(sessions.status(captured, status)),
      'audio/idle': ({ tabId: captured }) => answer(sessions.idle(captured)),
      'audio/failed': ({ tabId: captured, code }) => answer(sessions.failed(captured, code)),
      'subs/translate': async (request): Promise<Result<TranslateResponse>> => {
        if (tabId === undefined) return forbidden();
        const page = await pages.get(tabId);
        return page.ok ? captions.translate(request, page.value) : page;
      },
      'subs/front': async (front): Promise<Result<Record<string, never>>> => {
        if (tabId === undefined) return forbidden();
        const kept = await fronts.report(tabId, front);
        return kept.ok ? Ok({}) : kept;
      },
      'subs/display': async ({ mode }): Promise<Result<Record<string, never>>> => {
        const saved = await display.change(() => mode);
        return saved.ok ? Ok({}) : saved;
      },
    };
  }
  /**
   * The display shortcut (a failed save leaves the display as it was, for the next press) and the
   * audio shortcut (a failed start is shown on the tab's pill).
   */
  function onCommand(command: string): void {
    if (command === CYCLE_DISPLAY)
      launch(
        async () => {
          await display.change(nextDisplay);
        },
        () => undefined,
      );
    else if (command === TOGGLE_AUDIO)
      launch(
        async () => {
          await sessions.toggle();
        },
        () => undefined,
      );
  }
  /**
   * The toolbar icon (S46). The side panel opens in the click's own turn, before anything is
   * awaited, while Chrome still counts the click as the viewer's gesture; then the click starts or
   * stops the tab's speech subtitles, or does nothing more (sessions.ts).
   */
  function onAction(tab: Browser.tabs.Tab): void {
    const tabId = tab.id;
    if (tabId === undefined) return;
    launch(
      () => browser.sidePanel.open({ tabId }),
      () => undefined,
    );
    launch(
      async () => {
        await sessions.action({ id: tabId, url: tab.url });
      },
      () => undefined,
    );
  }
  /**
   * A closed tab's page and front are forgotten. The result is not used: an entry that stays ages
   * out, and a translation uses a page only for the video it names. Tab updates are followed only
   * for a captured tab (sessions.ts): a listener would wake the service worker for every tab of
   * every site; a tab's next `subs/page` replaces its page (S43).
   */
  function onTabRemoved(tabId: number): void {
    launch(
      async () => {
        await Promise.all([pages.forget(tabId), fronts.forget(tabId)]);
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
  browser.commands.onCommand.addListener(onCommand);
  browser.action.onClicked.addListener(onAction);
  // The click handler opens the panel: `openPanelOnActionClick` would open it without invoking
  // the tab, so no capture could start from the icon (Task 13 Step 0). A failure leaves the panel
  // reachable from Chrome's side panel menu.
  launch(
    () => browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }),
    () => undefined,
  );
  return () => {
    browser.runtime.onMessage.removeListener(onMessage);
    browser.tabs.onRemoved.removeListener(onTabRemoved);
    browser.commands.onCommand.removeListener(onCommand);
    browser.action.onClicked.removeListener(onAction);
    queue.clear();
    captions.dispose();
    display.dispose();
    sessions.dispose();
  };
}
