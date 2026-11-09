import { browser } from 'wxt/browser';
import type { ScriptPublicPath } from 'wxt/utils/inject-script';
import { Err, failure, launch, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  connectionPort,
  createQueue,
  llmHandlers,
  settingsStore,
  type ConnectionPort,
  type HostPermissions,
  type StorageArea,
} from '@chrome-toolbox/extension-core';
import {
  COMMAND_ID,
  createControl,
  MENU_ID,
  PAGE_SCRIPT,
  type ControlApi,
  type ScriptingApi,
} from './control.ts';
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

/** The extension APIs behind the control: the scripting adapter above and Chrome's own. */
function controlApi(): ControlApi {
  return {
    scripting: {
      ...scripting,
      registerContentScripts: (scripts) => browser.scripting.registerContentScripts(scripts),
      updateContentScripts: (scripts) => browser.scripting.updateContentScripts(scripts),
      unregisterContentScripts: (filter) => browser.scripting.unregisterContentScripts(filter),
      getRegisteredContentScripts: (filter) =>
        browser.scripting.getRegisteredContentScripts(filter),
    },
    tabs: {
      sendMessage: (tabId, message, options) => browser.tabs.sendMessage(tabId, message, options),
    },
    permissions: { contains: (permissions) => browser.permissions.contains(permissions) },
    storage: { local: browser.storage.local, session: browser.storage.session },
  };
}

/** The part of `contextMenus.OnClickData` the menu listener reads. */
type MenuClick = Readonly<{ menuItemId: string | number; selectionText?: string | undefined }>;
/** The part of a `tabs.Tab` the listeners read. */
type TabRef = Readonly<{ id?: number | undefined }>;
/** The part of `permissions.Permissions` the permission listeners read. */
type Origins = Readonly<{ origins?: string[] | undefined }>;

/** Routes only this extension's pages may use: they let the extension into a tab. */
type PageRoute = 'page/start' | 'page/restore' | 'page/always';
/** Routes only the page script in a tab's top frame may use: they translate for that tab. */
type ContentRoute = 'page/translate' | 'page/cancel';
/** The storage keys of the settings the translator reads: the shared ones and the page's. */
const SETTINGS_KEYS = ['settings', 'page'] as const;
/** A route's empty answer for a done step. */
const answered = (result: Result<void>): Result<Record<string, never>> =>
  result.ok ? Ok({}) : result;

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
  const control = createControl(controlApi());
  const pageHandlers: Pick<PageProtocolHandlers, PageRoute> = {
    // The popup's tab got `activeTab` from the toolbar button: the page script goes into its top
    // frame and is told to translate, unless the site is on the never list. A second press
    // injects again; the script already there keeps the page (claimPage).
    'page/start': async ({ tabId, url }): Promise<Result<Record<string, never>>> =>
      answered(await control.start(tabId, url)),
    'page/restore': async ({ tabId }): Promise<Result<Record<string, never>>> =>
      answered(await control.restore(tabId)),
    'page/always': async ({ pattern }): Promise<Result<Record<string, never>>> => {
      const asked = await control.ask(pattern);
      if (!asked.ok) return asked;
      return answered(await control.syncAlways());
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
  const notPage: Pick<PageProtocolHandlers, PageRoute> = {
    'page/start': forbidden,
    'page/restore': forbidden,
    'page/always': forbidden,
  };
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
  /**
   * Runs what a browser event asks for, step after step. An event has nobody to answer: a page
   * Chrome lets no extension script shows no bubble, and a registration left behind is aligned
   * again at the next settings change, permission change or service worker start.
   */
  function inBackground(...steps: (() => Promise<Result<void>>)[]): void {
    launch(
      async () => {
        for (const step of steps) void (await step());
      },
      () => undefined,
    );
  }
  /**
   * The options page or the popup saved settings: the next request reads them again, and the
   * always registration follows the page settings' lists.
   */
  function onStorageChanged(changes: Record<string, unknown>): void {
    if (SETTINGS_KEYS.some((key) => Object.hasOwn(changes, key))) translator.reload();
    if (Object.hasOwn(changes, 'page')) inBackground(control.syncAlways);
  }
  /**
   * The context menu item lives as long as the extension's install: Chrome keeps it across
   * service worker restarts. After a browser update it can still be there; Chrome's duplicate-id
   * error is read (lastError) and the existing item stays.
   */
  function onInstalled(): void {
    browser.contextMenus.create(
      { id: MENU_ID, title: '選択範囲を翻訳', contexts: ['selection'] },
      () => browser.runtime.lastError,
    );
  }
  /** 「選択範囲を翻訳」 in the context menu: its text goes along, for a selection in a frame. */
  function onMenuClicked(info: MenuClick, tab?: TabRef): void {
    const tabId = tab?.id;
    if (info.menuItemId !== MENU_ID || tabId === undefined) return;
    inBackground(() => control.selection(tabId, info.selectionText));
  }
  /** The shortcut: the page script reads the selection itself. */
  function onCommand(command: string, tab?: TabRef): void {
    const tabId = tab?.id;
    if (command !== COMMAND_ID || tabId === undefined) return;
    inBackground(() => control.selection(tabId, undefined));
  }
  /** Chrome granted sites: the one the popup asked for joins the always list. */
  function onPermissionsAdded({ origins = [] }: Origins): void {
    inBackground(() => control.granted(origins), control.syncAlways);
  }
  /** The viewer took sites' permissions away: they leave the always list first. */
  function onPermissionsRemoved({ origins = [] }: Origins): void {
    inBackground(() => control.forget(origins), control.syncAlways);
  }
  browser.runtime.onMessage.addListener(onMessage);
  browser.tabs.onRemoved.addListener(onTabRemoved);
  browser.storage.local.onChanged.addListener(onStorageChanged);
  browser.runtime.onInstalled.addListener(onInstalled);
  browser.contextMenus.onClicked.addListener(onMenuClicked);
  browser.commands.onCommand.addListener(onCommand);
  browser.permissions.onAdded.addListener(onPermissionsAdded);
  browser.permissions.onRemoved.addListener(onPermissionsRemoved);
  // Each start aligns the registration: an alignment cut short when the last service worker
  // stopped, or a registration an older version left, is put right.
  inBackground(control.syncAlways);
  return () => {
    browser.runtime.onMessage.removeListener(onMessage);
    browser.tabs.onRemoved.removeListener(onTabRemoved);
    browser.storage.local.onChanged.removeListener(onStorageChanged);
    browser.runtime.onInstalled.removeListener(onInstalled);
    browser.contextMenus.onClicked.removeListener(onMenuClicked);
    browser.commands.onCommand.removeListener(onCommand);
    browser.permissions.onAdded.removeListener(onPermissionsAdded);
    browser.permissions.onRemoved.removeListener(onPermissionsRemoved);
    translator.dispose();
    queue.clear();
  };
}
