// What the background's control needs from Chrome, in memory: the registry of registered content
// scripts, the granted sites, the tab messages, and the events WXT's fake browser leaves out.
import { vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ControlApi } from '../../src/control.ts';
import { pageCommandMessageSchema } from '../../src/protocol.ts';

/** A registered content script as the extension gave it to Chrome. */
export type Registered = Readonly<{
  id: string;
  matches?: string[] | undefined;
  js?: string[] | undefined;
  runAt?: string | undefined;
  allFrames?: boolean | undefined;
  persistAcrossSessions?: boolean | undefined;
}>;

/** The in-memory Chrome: synchronous, so the same calls back the fake API and the fake browser. */
type Memory = Readonly<{
  /** Registered scripts by id. */
  registry: Map<string, Registered>;
  /** The sites Chrome grants (`permissions.contains`). */
  granted: Set<string>;
  /** Every message sent to a tab, as `[tabId, message, options]`. */
  sent: unknown[][];
  /** The calls in order: `inject <tabId>` and `send <tabId> <action>`. */
  log: string[];
  inject(this: void, tabId: number): void;
  send(this: void, tabId: number, message: unknown, options: unknown): void;
  contains(this: void, origins: readonly string[]): boolean;
  /** Fails as Chrome does on a taken id; registers nothing then. */
  register(this: void, scripts: readonly Registered[]): void;
  /** Fails as Chrome does on an unknown id; given fields replace the registered ones. */
  update(this: void, scripts: readonly Registered[]): void;
  unregister(this: void, ids: readonly string[]): void;
  registered(this: void, ids: readonly string[]): Registered[];
}>;

function memory(granted: readonly string[]): Memory {
  const registry = new Map<string, Registered>();
  const sites = new Set(granted);
  const sent: unknown[][] = [];
  const log: string[] = [];
  return {
    registry,
    granted: sites,
    sent,
    log,
    inject: (tabId) => {
      log.push(`inject ${tabId}`);
    },
    send: (tabId, message, options) => {
      sent.push([tabId, message, options]);
      const command = pageCommandMessageSchema.safeParse(message);
      log.push(`send ${tabId} ${command.success ? command.data.payload.action : '?'}`);
    },
    contains: (origins) => origins.every((origin) => sites.has(origin)),
    register: (scripts) => {
      for (const script of scripts)
        if (registry.has(script.id)) throw new Error(`Duplicate script ID '${script.id}'`);
      for (const script of scripts) registry.set(script.id, script);
    },
    update: (scripts) => {
      for (const script of scripts) {
        const known = registry.get(script.id);
        if (known === undefined) throw new Error(`Script with ID '${script.id}' does not exist`);
        registry.set(script.id, { ...known, ...script });
      }
    },
    unregister: (ids) => {
      for (const id of ids) {
        if (!registry.has(id)) throw new Error(`Nonexistent script ID '${id}'`);
        registry.delete(id);
      }
    },
    registered: (ids) => [...registry.values()].filter((script) => ids.includes(script.id)),
  };
}

export type FakeChrome = Omit<
  Memory,
  'inject' | 'send' | 'contains' | 'register' | 'update' | 'unregister' | 'registered'
> & {
  api: ControlApi;
};

/** A fake `ControlApi`: storage is WXT's fake browser's, the rest is in memory. */
export function fakeChrome(granted: readonly string[] = []): FakeChrome {
  const chrome = memory(granted);
  const api: ControlApi = {
    scripting: {
      executeScript: async ({ target }) => chrome.inject(target.tabId),
      registerContentScripts: async (scripts) => chrome.register(scripts),
      updateContentScripts: async (scripts) => chrome.update(scripts),
      unregisterContentScripts: async ({ ids }) => chrome.unregister(ids),
      getRegisteredContentScripts: async ({ ids }) => chrome.registered(ids),
    },
    tabs: { sendMessage: async (tabId, message, options) => chrome.send(tabId, message, options) },
    permissions: { contains: async ({ origins }) => chrome.contains(origins) },
    storage: { local: fakeBrowser.storage.local, session: fakeBrowser.storage.session },
  };
  const { registry, granted: sites, sent, log } = chrome;
  return { api, registry, granted: sites, sent, log };
}

/** A browser event that keeps its listeners and calls them as Chrome would (`trigger`). */
export type Triggerable<A extends unknown[]> = { trigger(...args: A): Promise<void> };
type EventLike<A extends unknown[]> = {
  addListener(callback: (...args: A) => void): void;
  removeListener(callback: (...args: A) => void): void;
  hasListeners(): boolean;
};
/** Makes an event WXT's fake browser leaves out keep its listeners; restored with the mocks. */
function triggerable<A extends unknown[]>(event: EventLike<A>): Triggerable<A> {
  const listeners = new Set<(...args: A) => void>();
  vi.spyOn(event, 'addListener').mockImplementation((callback) => {
    listeners.add(callback);
  });
  vi.spyOn(event, 'removeListener').mockImplementation((callback) => {
    listeners.delete(callback);
  });
  vi.spyOn(event, 'hasListeners').mockImplementation(() => listeners.size > 0);
  return {
    trigger: async (...args) => {
      for (const listener of listeners) listener(...args);
      await Promise.resolve();
    },
  };
}

/** The part of a tab the tests give the listeners. */
type TabRef = { id?: number | undefined; url?: string | undefined } | undefined;
export type FakeBackground = Omit<FakeChrome, 'api'> & {
  menuClicked: Triggerable<
    [{ menuItemId: string | number; selectionText?: string | undefined }, TabRef]
  >;
  command: Triggerable<[string, TabRef]>;
  permissionsAdded: Triggerable<[{ origins?: string[] | undefined }]>;
  permissionsRemoved: Triggerable<[{ origins?: string[] | undefined }]>;
  /** The context menu items created, by `contextMenus.create`. */
  menus: unknown[];
};

/**
 * Puts the in-memory Chrome under WXT's fake browser for `startBackground`: the script registry,
 * the granted sites, the tab messages, the context menu and the events the fake leaves out. The
 * fake browser's calls answer at once; the background awaits what they return.
 */
export function fakeBackground(granted: readonly string[] = []): FakeBackground {
  const chrome = memory(granted);
  const menus: unknown[] = [];
  const { scripting, tabs, permissions, contextMenus } = fakeBrowser;
  vi.spyOn(scripting, 'executeScript').mockImplementation((injection) => {
    chrome.inject(injection.target.tabId);
  });
  vi.spyOn(scripting, 'registerContentScripts').mockImplementation((scripts) => {
    chrome.register(scripts);
  });
  vi.spyOn(scripting, 'updateContentScripts').mockImplementation((scripts) => {
    chrome.update(scripts);
  });
  vi.spyOn(scripting, 'unregisterContentScripts').mockImplementation((filter) => {
    chrome.unregister(filter?.ids ?? []);
  });
  vi.spyOn(scripting, 'getRegisteredContentScripts').mockImplementation((filter) =>
    chrome.registered(filter?.ids ?? []),
  );
  vi.spyOn(tabs, 'sendMessage').mockImplementation((tabId, message, options) => {
    chrome.send(tabId, message, options);
  });
  vi.spyOn(permissions, 'contains').mockImplementation((asked) =>
    chrome.contains(asked.origins ?? []),
  );
  vi.spyOn(contextMenus, 'create').mockImplementation((properties) => {
    menus.push(properties);
    return properties.id ?? '';
  });
  const { registry, granted: sites, sent, log } = chrome;
  return {
    registry,
    granted: sites,
    sent,
    log,
    menus,
    menuClicked: triggerable(contextMenus.onClicked),
    command: triggerable(fakeBrowser.commands.onCommand),
    permissionsAdded: triggerable(permissions.onAdded),
    permissionsRemoved: triggerable(permissions.onRemoved),
  };
}
