import { browser } from 'wxt/browser';
import { Err, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  connectionPort,
  settingsStore,
  type ConnectionPort,
  type HostPermissions,
  type Settings,
  type SettingsStore,
} from '@chrome-toolbox/extension-core';
import {
  pageSettingsOf,
  siteSwitches,
  updatePageSettings,
  type SiteApi,
  type SiteSwitches,
} from './popup.ts';
import { normalizeHost, type PageSettings, type PageSettingsStore } from './settings.ts';

/** The extension APIs the options page uses; tests pass a fake with this shape. */
export type OptionsApi = SiteApi & { permissions: HostPermissions };

/** What the options page saves with 「保存」: the fields it owns, nothing else. */
export type Choices = Readonly<{
  translator: PageSettings['translator'];
  /** Gemma's model name, the shared settings' `models.translate`. */
  model: string;
  /**
   * Host names (`readHosts`); none when the viewer did not edit the list, which keeps what is
   * stored (the popup may have changed it while the page was open).
   */
  never?: readonly string[];
}>;
/** Both settings as saved. */
export type Saved = Readonly<{ page: PageSettings; settings: Settings }>;

export type OptionsPort = Readonly<{
  /** The llama.cpp URL, checked through the service worker (the shared `ConnectionPanel`). */
  connection: ConnectionPort;
  /** The shared llama.cpp settings (URL and model names). */
  settings: SettingsStore;
  /** The page settings (`pageSettingsOf`). */
  pageSettings: PageSettingsStore;
  /**
   * Writes `choices` onto the settings stored now: the always list, the display mode and the URL
   * keep what the background, the popup or the connection check saved meanwhile.
   */
  save(this: void, choices: Choices): Promise<Result<Saved>>;
  /** Only to take a site off (`false`): adding one needs the popup's site (`SiteSwitches`). */
  setAlways: SiteSwitches['setAlways'];
}>;

/**
 * The never list as typed: one host name per line (`normalizeHost`: a URL gives its host),
 * blank lines skipped, each host once. The first line that is no host name is the error.
 */
export function readHosts(text: string): Result<string[], Readonly<{ line: string }>> {
  const hosts: string[] = [];
  for (const typed of text.split('\n')) {
    const line = typed.trim();
    if (line === '') continue;
    const host = normalizeHost(line);
    if (!host.ok) return Err({ line });
    if (!hosts.includes(host.value)) hosts.push(host.value);
  }
  return Ok(hosts);
}

/** Options page adapter: settings in extension storage, inference through the service worker. */
export function optionsPort(api: OptionsApi = browser): OptionsPort {
  const settings = settingsStore(api.storage.local);
  const pageSettings = pageSettingsOf(api.storage.local);
  return {
    connection: connectionPort({
      settings,
      permissions: api.permissions,
      send: (message) => api.runtime.sendMessage(message),
    }),
    settings,
    pageSettings,
    save: async ({ translator, model, never }): Promise<Result<Saved>> => {
      const page = await updatePageSettings(pageSettings, (current) => ({
        ...current,
        translator,
        ...(never === undefined ? {} : { never: [...never] }),
      }));
      if (!page.ok) return page;
      const current = await settings.load();
      if (!current.ok) return current;
      const saved = await settings.save({
        ...current.value,
        models: { ...current.value.models, translate: model },
      });
      return saved.ok ? Ok({ page: page.value.after, settings: saved.value }) : saved;
    },
    setAlways: siteSwitches(api, pageSettings).setAlways,
  };
}
