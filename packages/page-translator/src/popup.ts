import { browser } from 'wxt/browser';
import { capture, captureSync, Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import { hostPattern, settingsStore, type StorageArea } from '@chrome-toolbox/extension-core';
import {
  pageProtocol,
  PROGRESS_PORT,
  progressSchema,
  type DisplayMode,
  type Progress,
} from './protocol.ts';
import {
  defaultPageSettings,
  excludedBy,
  pageSettingsStore,
  type PageSettings,
  type PageSettingsStore,
  type Site,
} from './settings.ts';

type Listeners<L> = { addListener(listener: L): void; removeListener(listener: L): void };
/** The popup's end of `tabs.connect(tabId, { name: PROGRESS_PORT })`. */
export type ProgressConnection = {
  onMessage: Listeners<(message: unknown) => void>;
  onDisconnect: Listeners<() => void>;
  disconnect(): void;
};

/** The extension APIs that change the site lists (the popup, the options page). */
export type SiteApi = {
  storage: { local: StorageArea };
  permissions: {
    request(permissions: { origins: string[] }): Promise<boolean>;
    remove(permissions: { origins: string[] }): Promise<boolean>;
  };
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    /** Its `host_permissions` are the manifest's own hosts, which Chrome refuses to take back. */
    getManifest(): { manifest_version: number; host_permissions?: string[] | undefined };
  };
};
/** The extension APIs the popup uses; tests pass a fake with this shape. */
export type PopupApi = SiteApi & {
  tabs: {
    query(queryInfo: {
      active: boolean;
      currentWindow: boolean;
    }): Promise<readonly { id?: number | undefined; url?: string | undefined }[]>;
    connect(tabId: number, connectInfo: { name: string; frameId: number }): ProgressConnection;
  };
  runtime: { openOptionsPage(): Promise<void> };
};

/** The tab the toolbar button was pressed on; `url` when `activeTab` lets the popup read it. */
export type ActiveTab = Readonly<{ id: number; url: string | undefined }>;

/**
 * What excludes a site: the never entry (`excludedBy`), and whether it is a parent domain's,
 * which covers other sites too.
 */
export type Exclusion = Readonly<{ entry: string; parent: boolean }>;
/** The never list's host name for `site`: without the root's trailing dot, as the options page saves it. */
const hostOf = (site: Site): string => site.host.replace(/\.$/u, '');
/** What in `never` excludes `site`, if anything. */
export function exclusionOf(site: Site, never: readonly string[]): Exclusion | undefined {
  const entry = excludedBy(site.host, never);
  return entry === undefined ? undefined : { entry, parent: entry !== hostOf(site) };
}

/**
 * How the popup and the options page change the always and never lists. They change only the
 * site's own entries, never a parent domain's, which covers other sites too (P29).
 */
export type SiteSwitches = {
  /**
   * On: the background hears which site to add (`page/always`) and Chrome is asked for the site's
   * permission, both before anything is awaited: Chrome shows its prompt only while the click
   * lasts, and closes the popup as it does. The background adds the site, and takes its own entry
   * off the never list, once Chrome grants it; the popup never writes the always list itself. A
   * refused prompt is `host_permission_denied`. A site a parent domain's entry of `never` (the
   * list the caller shows) excludes is `page_excluded` at once: nothing is sent or asked.
   * Off: the site leaves the always list and its permission is given back, unless llama.cpp is
   * reached through that host or the manifest grants it.
   */
  setAlways(this: void, site: Site, on: boolean, never: readonly string[]): Promise<Result<void>>;
  /**
   * On: the site joins the never list and leaves the always list (its permission given back as
   * for always off). Off: the site's own entry goes; a parent domain's stays.
   */
  setNever(this: void, site: Site, on: boolean): Promise<Result<void>>;
};

/** Everything the popup does goes through this port; it opens nothing until `watch`. */
export type PopupPort = SiteSwitches & {
  activeTab(this: void): Promise<Result<ActiveTab>>;
  /** Translate the tab (`page/start`): the background injects the page script and tells it. */
  start(this: void, tab: ActiveTab): Promise<Result<void>>;
  /** Put the tab's original text back (`page/restore`). */
  restore(this: void, tab: ActiveTab): Promise<Result<void>>;
  /**
   * Follows the progress of the page script in the tab's top frame, at once and on each change;
   * `undefined` when there is none (not injected, or the page was left). Returns the port's end.
   */
  watch(
    this: void,
    tabId: number,
    onProgress: (progress: Progress | undefined) => void,
  ): () => void;
  /** The page settings (`pageSettingsOf`). */
  settings: PageSettingsStore;
  /** Shows translations the `mode` way in every tab. */
  setMode(this: void, mode: DisplayMode): Promise<Result<void>>;
  openOptions(this: void): Promise<Result<void>>;
};

/**
 * The page settings in `area`. As for the background, a stored record that is no page settings
 * reads as the defaults until valid ones are saved.
 */
export function pageSettingsOf(area: StorageArea): PageSettingsStore {
  const store = pageSettingsStore(area);
  return {
    load: async (): Promise<Result<PageSettings>> => {
      const loaded = await store.load();
      return !loaded.ok && loaded.error.internalCode === 'response_invalid'
        ? Ok(defaultPageSettings)
        : loaded;
    },
    save: store.save,
  };
}

/**
 * Writes `change` of the settings stored now, not of a copy read earlier: the fields the caller
 * leaves alone keep what the background or another page saved meanwhile. Returns both sides.
 */
export async function updatePageSettings(
  store: PageSettingsStore,
  change: (settings: PageSettings) => PageSettings,
): Promise<Result<Readonly<{ before: PageSettings; after: PageSettings }>>> {
  const loaded = await store.load();
  if (!loaded.ok) return loaded;
  const saved = await store.save(change(loaded.value));
  return saved.ok ? Ok({ before: loaded.value, after: saved.value }) : saved;
}

const done = (result: Result<unknown>): Result<void> => (result.ok ? Ok(undefined) : result);

/** The always and never switches on `api`, writing the page settings of `store`. */
export function siteSwitches(api: SiteApi, store: PageSettingsStore): SiteSwitches {
  const send = (message: unknown): Promise<unknown> => api.runtime.sendMessage(message);
  const llama = settingsStore(api.storage.local);

  /**
   * Gives the site's host permission back. The host llama.cpp is reached through keeps it, or the
   * translations would stop; Chrome refuses to take back the manifest's own hosts.
   */
  async function release(pattern: string): Promise<Result<void>> {
    const settings = await llama.load();
    if (!settings.ok) return settings;
    const server = hostPattern(settings.value.llamaBaseUrl);
    const required = api.runtime.getManifest().host_permissions ?? [];
    if ((server.ok && server.value === pattern) || required.includes(pattern)) return Ok(undefined);
    return done(
      await capture(() => api.permissions.remove({ origins: [pattern] }), 'unexpected_failure'),
    );
  }

  async function askAlways(site: Site, never: readonly string[]): Promise<Result<void>> {
    // Lifting a parent domain's exclusion would change other sites: no prompt, no grant.
    if (exclusionOf(site, never)?.parent === true) return Err(failure('page_excluded'));
    // Both calls are made before the first `await`, while the viewer's click lasts.
    const told = pageProtocol.send(send, 'page/always', { pattern: site.pattern });
    const asked = capture(
      () => api.permissions.request({ origins: [site.pattern] }),
      'host_permission_denied',
    );
    const [sent, granted] = await Promise.all([told, asked]);
    if (!granted.ok) return granted;
    if (!granted.value) return Err(failure('host_permission_denied'));
    return done(sent);
  }

  /** Writes `change`; the site's permission goes back when `change` took it off the always list. */
  async function write(
    site: Site,
    change: (settings: PageSettings) => PageSettings,
  ): Promise<Result<void>> {
    const updated = await updatePageSettings(store, change);
    if (!updated.ok) return updated;
    const { before, after } = updated.value;
    return before.always.includes(site.pattern) && !after.always.includes(site.pattern)
      ? release(site.pattern)
      : Ok(undefined);
  }
  const withoutSite = (site: Site, always: readonly string[]): string[] =>
    always.filter((pattern) => pattern !== site.pattern);

  function setNever(site: Site, on: boolean): Promise<Result<void>> {
    const host = hostOf(site);
    if (!on)
      return write(site, (settings) => ({
        ...settings,
        never: settings.never.filter((entry) => entry !== host),
      }));
    return write(site, (settings) => ({
      ...settings,
      never: settings.never.includes(host) ? settings.never : [...settings.never, host],
      always: withoutSite(site, settings.always),
    }));
  }

  return {
    setAlways: (site, on, never) =>
      on
        ? askAlways(site, never)
        : write(site, (settings) => ({ ...settings, always: withoutSite(site, settings.always) })),
    setNever,
  };
}

/** The popup's adapter: the active tab, the background, the tab's page script and the settings. */
export function popupPort(api: PopupApi = browser): PopupPort {
  const send = (message: unknown): Promise<unknown> => api.runtime.sendMessage(message);
  const settings = pageSettingsOf(api.storage.local);

  async function activeTab(): Promise<Result<ActiveTab>> {
    const tabs = await capture(
      () => api.tabs.query({ active: true, currentWindow: true }),
      'resource_missing',
    );
    if (!tabs.ok) return tabs;
    const [tab] = tabs.value;
    if (tab?.id === undefined) return Err(failure('resource_missing'));
    return Ok({ id: tab.id, url: tab.url });
  }

  function watch(tabId: number, onProgress: (progress: Progress | undefined) => void): () => void {
    // Chrome refuses a port to a tab that is gone; a tab without a page script closes it at once.
    const connected = captureSync(
      () => api.tabs.connect(tabId, { name: PROGRESS_PORT, frameId: 0 }),
      'ipc_failed',
    );
    if (!connected.ok) {
      onProgress(undefined);
      return () => undefined;
    }
    const port = connected.value;
    let open = true;
    function onMessage(message: unknown): void {
      const progress = progressSchema.safeParse(message);
      if (progress.success) onProgress(progress.data);
    }
    function letGo(): void {
      open = false;
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
    }
    function onDisconnect(): void {
      letGo();
      onProgress(undefined);
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    return () => {
      if (!open) return;
      letGo();
      port.disconnect();
    };
  }

  return {
    ...siteSwitches(api, settings),
    activeTab,
    start: async (tab): Promise<Result<void>> =>
      done(
        await pageProtocol.send(send, 'page/start', {
          tabId: tab.id,
          ...(tab.url === undefined ? {} : { url: tab.url }),
        }),
      ),
    restore: async (tab): Promise<Result<void>> =>
      done(await pageProtocol.send(send, 'page/restore', { tabId: tab.id })),
    watch,
    settings,
    setMode: async (mode): Promise<Result<void>> =>
      done(await updatePageSettings(settings, (current) => ({ ...current, mode }))),
    openOptions: async (): Promise<Result<void>> =>
      done(await capture(() => api.runtime.openOptionsPage(), 'unexpected_failure')),
  };
}
