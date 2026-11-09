import { z } from 'zod/mini';
import { capture, Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import type { StorageArea } from '@chrome-toolbox/extension-core';
import { MAX_SELECTION, type PageCommand } from './protocol.ts';
import {
  defaultPageSettings,
  isNever,
  pageSettingsStore,
  siteOf,
  type PageSettings,
  type Site,
} from './settings.ts';

/** The page script as WXT builds `entrypoints/page.content.ts` (`registration: 'runtime'`). */
export const PAGE_SCRIPT = 'content-scripts/page.js';
/** The page script's registration for the always translated sites. */
export const ALWAYS_SCRIPT_ID = 'page-always';
/** The context menu item 「選択範囲を翻訳」. */
export const MENU_ID = 'translate-selection';
/** The shortcut 「選択範囲を翻訳」 (`Alt+Shift+L`, the manifest's `commands`). */
export const COMMAND_ID = 'translate-selection';
/**
 * Session storage key of the always pattern the popup asked for, until Chrome grants it. Chrome
 * closes the popup when it shows the permission prompt (adoption: Page translator foundation),
 * and the service worker may stop while the prompt waits, so the request outlives both.
 */
const ASKED_KEY = 'pageAlwaysAsked';
/**
 * How long the popup's request waits for Chrome's grant. Answering the prompt takes seconds; a
 * request the viewer denied must not stay open, or a later grant of the same host made another
 * way (the options page's llama.cpp address, Chrome's site access menu) would add it to the
 * always list and take it off the never list.
 */
export const ASKED_FOR_MS = 2 * 60_000;
/** The waiting request: the site's pattern and when it was asked (`now`, ms since the epoch). */
const askedSchema = z.strictObject({ pattern: z.string(), at: z.number() });

/** The part of `chrome.scripting` the background uses; tests pass a fake with this shape. */
export type ScriptingApi = {
  executeScript(injection: {
    target: { tabId: number; frameIds: number[] };
    files: string[];
  }): Promise<unknown>;
};

/**
 * Injects the page script into the tab's top frame. Chrome refuses a page the extension may not
 * script (`chrome://`, the Web Store, a tab without the `activeTab` grant or a host permission,
 * a closed tab): that is `page_restricted`.
 */
export async function injectPage(api: ScriptingApi, tabId: number): Promise<Result<void>> {
  const injected = await capture(
    () => api.executeScript({ target: { tabId, frameIds: [0] }, files: [PAGE_SCRIPT] }),
    'page_restricted',
  );
  return injected.ok ? Ok(undefined) : injected;
}

/** The page script's registration for the always sites (`matches`), as Chrome takes it. */
export type AlwaysScript = Readonly<{
  id: string;
  matches: string[];
  js: string[];
  runAt: 'document_idle';
  allFrames: boolean;
  persistAcrossSessions: boolean;
}>;
/** What Chrome tells of a registered script. */
type RegisteredScript = Readonly<{ id: string; matches?: readonly string[] | undefined }>;

/** The extension APIs the control uses; tests pass a fake with this shape. */
export type ControlApi = {
  scripting: ScriptingApi & {
    registerContentScripts(scripts: AlwaysScript[]): Promise<void>;
    updateContentScripts(scripts: AlwaysScript[]): Promise<void>;
    unregisterContentScripts(filter: { ids: string[] }): Promise<void>;
    getRegisteredContentScripts(filter: { ids: string[] }): Promise<readonly RegisteredScript[]>;
  };
  tabs: {
    sendMessage(tabId: number, message: unknown, options: { frameId: number }): Promise<unknown>;
  };
  permissions: { contains(permissions: { origins: string[] }): Promise<boolean> };
  storage: { local: StorageArea; session: StorageArea & { remove(key: string): Promise<void> } };
};

/** What the background does to tabs and to the always registration. */
export type Control = {
  /**
   * Translates the tab: the page script goes into its top frame and hears `translate`. A site of
   * the never list is `page_excluded` and gets nothing.
   */
  start(this: void, tabId: number, url: string | undefined): Promise<Result<void>>;
  /** Tells the tab's page script to restore the original text; a tab without one has none. */
  restore(this: void, tabId: number): Promise<Result<void>>;
  /**
   * Translates the selection, on any site, never-listed ones too: the page script goes into the
   * top frame and hears `selection` with the context menu's text (none from the shortcut).
   */
  selection(this: void, tabId: number, text: string | undefined): Promise<Result<void>>;
  /**
   * Registers the page script for the always sites that are not excluded and whose permission
   * Chrome holds, and removes the registration when no site is left. Calls run one at a time.
   */
  syncAlways(this: void): Promise<Result<void>>;
  /** Drops from the always list the sites whose permission was removed (`origins`). */
  forget(this: void, origins: readonly string[]): Promise<Result<void>>;
  /**
   * The popup asks to always translate the site of `pattern` (a `siteOf` pattern) before it shows
   * Chrome's prompt: the site is added at once when Chrome already grants it, else on `granted`.
   */
  ask(this: void, pattern: string): Promise<Result<void>>;
  /**
   * Chrome granted `origins`: the site the popup asked for, if among them and asked for at most
   * `ASKED_FOR_MS` ago, is added. An older request is dropped instead.
   */
  granted(this: void, origins: readonly string[]): Promise<Result<void>>;
};

/** The registration for `matches`: top frames, once the page has loaded, kept across restarts. */
const alwaysScript = (matches: string[]): AlwaysScript => ({
  id: ALWAYS_SCRIPT_ID,
  matches,
  js: [PAGE_SCRIPT],
  runAt: 'document_idle',
  allFrames: false,
  persistAcrossSessions: true,
});
const sameSites = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((pattern) => right.includes(pattern));
/** `text` within MAX_SELECTION UTF-16 units; a character the limit would split is left out. */
function cutSelection(text: string): string {
  if (text.length <= MAX_SELECTION) return text;
  const last = text.charCodeAt(MAX_SELECTION - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_SELECTION - 1 : MAX_SELECTION);
}

/**
 * `now` is the wall clock (ms since the epoch): a request outlives the service worker that took
 * it, so a clock that restarts with it would not do.
 */
export function createControl(
  api: ControlApi,
  { now = (): number => Date.now() }: { now?: () => number } = {},
): Control {
  const store = pageSettingsStore(api.storage.local);

  /**
   * The page settings. As for the translator, a stored record that is no page settings counts as
   * the defaults until valid ones are saved; storage that cannot be read fails.
   */
  async function settings(): Promise<Result<PageSettings>> {
    const loaded = await store.load();
    if (!loaded.ok && loaded.error.internalCode === 'response_invalid')
      return Ok(defaultPageSettings);
    return loaded;
  }
  async function tell(tabId: number, command: PageCommand): Promise<Result<void>> {
    const told = await capture(
      () => api.tabs.sendMessage(tabId, { type: 'page/command', payload: command }, { frameId: 0 }),
      'ipc_failed',
    );
    return told.ok ? Ok(undefined) : told;
  }
  /** The page script goes into the top frame first: it must be there to hear `command`. */
  async function injectAndTell(tabId: number, command: PageCommand): Promise<Result<void>> {
    const injected = await injectPage(api.scripting, tabId);
    return injected.ok ? tell(tabId, command) : injected;
  }
  const holds = (pattern: string): Promise<Result<boolean>> =>
    capture(() => api.permissions.contains({ origins: [pattern] }), 'unexpected_failure');

  async function start(tabId: number, url: string | undefined): Promise<Result<void>> {
    // A page that is no site (`chrome://`, a file) is on no list, and a tab whose URL the popup
    // could not read lacks the button's grant: Chrome decides by refusing the injection or not.
    const site = url === undefined ? undefined : siteOf(url);
    if (site?.ok === true) {
      const loaded = await settings();
      if (!loaded.ok) return loaded;
      if (isNever(site.value.host, loaded.value.never)) return Err(failure('page_excluded'));
    }
    return injectAndTell(tabId, { action: 'translate' });
  }

  async function restore(tabId: number): Promise<Result<void>> {
    const told = await tell(tabId, { action: 'restore' });
    // Delivery fails when no page script runs in the top frame (never translated, reloaded or
    // closed since): no translation shows there, so nothing is to restore.
    return told.ok || told.error.internalCode === 'ipc_failed' ? Ok(undefined) : told;
  }

  /** Aligns Chrome's registration with the settings it reads now. */
  async function align(): Promise<Result<void>> {
    const loaded = await settings();
    if (!loaded.ok) return loaded;
    const { always, never } = loaded.value;
    const matches: string[] = [];
    for (const pattern of new Set(always)) {
      const site = siteOf(pattern);
      // An entry that is no site's pattern (storage edited by hand) matches no site.
      if (!site.ok || site.value.pattern !== pattern || isNever(site.value.host, never)) continue;
      const held = await holds(pattern);
      if (!held.ok) return held;
      if (held.value) matches.push(pattern);
    }
    const found = await capture(
      () => api.scripting.getRegisteredContentScripts({ ids: [ALWAYS_SCRIPT_ID] }),
      'unexpected_failure',
    );
    if (!found.ok) return found;
    const registered = found.value.find((script) => script.id === ALWAYS_SCRIPT_ID);
    if (matches.length === 0)
      return registered === undefined
        ? Ok(undefined)
        : capture(
            () => api.scripting.unregisterContentScripts({ ids: [ALWAYS_SCRIPT_ID] }),
            'unexpected_failure',
          );
    if (registered === undefined)
      return capture(
        () => api.scripting.registerContentScripts([alwaysScript(matches)]),
        'unexpected_failure',
      );
    if (sameSites(registered.matches ?? [], matches)) return Ok(undefined);
    return capture(
      () => api.scripting.updateContentScripts([alwaysScript(matches)]),
      'unexpected_failure',
    );
  }
  // Two alignments at once would both find nothing registered and register twice, which Chrome
  // refuses. One runs at a time; the calls made before the next one starts share it, since it
  // reads the settings when it starts.
  let chain: Promise<unknown> = Promise.resolve();
  let next: Promise<Result<void>> | undefined;
  function syncAlways(): Promise<Result<void>> {
    if (next !== undefined) return next;
    const turn = chain.then(() => {
      next = undefined;
      return align();
    });
    next = turn;
    chain = capture(() => turn, 'unexpected_failure');
    return turn;
  }

  async function forget(origins: readonly string[]): Promise<Result<void>> {
    const loaded = await settings();
    if (!loaded.ok) return loaded;
    const always = loaded.value.always.filter((pattern) => !origins.includes(pattern));
    if (always.length === loaded.value.always.length) return Ok(undefined);
    const saved = await store.save({ ...loaded.value, always });
    return saved.ok ? Ok(undefined) : saved;
  }

  /**
   * The asked site joins the always list and leaves the never list (its own entry; a parent
   * domain's entry stays and keeps it excluded), and the request is done.
   */
  async function join(site: Site): Promise<Result<void>> {
    const loaded = await settings();
    if (!loaded.ok) return loaded;
    const { always, never } = loaded.value;
    const saved = await store.save({
      ...loaded.value,
      always: always.includes(site.pattern) ? always : [...always, site.pattern],
      never: never.filter((host) => host !== site.host),
    });
    if (!saved.ok) return saved;
    return capture(() => api.storage.session.remove(ASKED_KEY), 'storage_failed');
  }
  async function ask(pattern: string): Promise<Result<void>> {
    const site = siteOf(pattern);
    // Only one site's pattern: a wildcard or a page would let the script into other pages.
    if (!site.ok || site.value.pattern !== pattern) return Err(failure('input_invalid'));
    const asked = await capture(
      () => api.storage.session.set({ [ASKED_KEY]: { pattern, at: now() } }),
      'storage_failed',
    );
    if (!asked.ok) return asked;
    const held = await holds(pattern);
    if (!held.ok) return held;
    return held.value ? join(site.value) : Ok(undefined);
  }
  async function granted(origins: readonly string[]): Promise<Result<void>> {
    const stored = await capture(() => api.storage.session.get(ASKED_KEY), 'storage_failed');
    if (!stored.ok) return stored;
    const asked = askedSchema.safeParse(stored.value[ASKED_KEY]);
    if (!asked.success) return Ok(undefined);
    const { pattern, at } = asked.data;
    // Too old: the viewer denied or left the prompt. The request is dropped, whatever was granted.
    if (now() - at > ASKED_FOR_MS)
      return capture(() => api.storage.session.remove(ASKED_KEY), 'storage_failed');
    // Another grant (a LAN llama.cpp host from the options page) adds no site; the request waits.
    if (!origins.includes(pattern)) return Ok(undefined);
    const site = siteOf(pattern);
    return site.ok ? join(site.value) : site;
  }

  return {
    start,
    restore,
    selection: (tabId, text) =>
      injectAndTell(
        tabId,
        text === undefined
          ? { action: 'selection' }
          : { action: 'selection', text: cutSelection(text) },
      ),
    syncAlways,
    forget,
    ask,
    granted,
  };
}
