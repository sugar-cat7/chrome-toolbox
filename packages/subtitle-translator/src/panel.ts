import { browser } from 'wxt/browser';
import { capture, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  connectionPort,
  settingsStore,
  type ConnectionPort,
  type HostPermissions,
  type SettingsStore,
  type StorageArea,
} from '@chrome-toolbox/extension-core';
import { glossaryStore, type GlossaryStore } from './glossary.ts';
import {
  addressed,
  isFor,
  stateChangedSchema,
  subtitleProtocol,
  type TabState,
} from './protocol.ts';
import {
  subtitleSettingsStore,
  watchSubtitleSettings,
  type DisplayMode,
  type StorageEvents,
  type SubtitleSettings,
  type SubtitleSettingsStore,
} from './settings.ts';

/** An extension event as the side panel uses it: add and remove one listener. */
type PanelEvent<Listener> = {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
};
/** The extension APIs a side panel uses; tests pass a fake with this shape. */
export type PanelApi = {
  storage: { local: StorageArea & { remove(keys: string[]): Promise<void> } & StorageEvents };
  permissions: HostPermissions;
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: PanelEvent<(message: unknown) => void>;
  };
  tabs: {
    query(queryInfo: {
      active: boolean;
      currentWindow: boolean;
    }): Promise<readonly { id?: number | undefined }[]>;
    onActivated: PanelEvent<() => void>;
    onUpdated: PanelEvent<(tabId: number, changeInfo: { status?: string | undefined }) => void>;
  };
};

/** Side panel adapter: settings in extension storage, inference through the service worker. */
export function sidePanelPort(
  api: { storage: { local: StorageArea }; permissions: HostPermissions } & {
    runtime: Pick<PanelApi['runtime'], 'sendMessage'>;
  } = browser,
): ConnectionPort {
  return connectionPort({
    settings: settingsStore(api.storage.local),
    permissions: api.permissions,
    send: (message) => api.runtime.sendMessage(addressed('background', message)),
  });
}

/** What the server can do for the subtitles; undefined when it did not tell. */
export type Capability = Readonly<{ audio: boolean | undefined; plamo: boolean | undefined }>;

/** Everything the side panel does goes through this port; it registers nothing until asked. */
export type PanelPort = {
  connection: ConnectionPort;
  /** extension-core's settings: the panel edits `models.translate` and `models.asr`. */
  settings: SettingsStore;
  /** Read only: the panel saves the display with `display` and its other fields with `saveSubtitles`. */
  subtitles: Pick<SubtitleSettingsStore, 'load'>;
  /** Saves the display mode through the service worker's queue (`subs/display`). */
  display(this: void, mode: DisplayMode): Promise<Result<void>>;
  /** Saves only the changed fields, over the latest settings, in the service worker (`subs/settings`). */
  saveSubtitles(
    this: void,
    patch: Partial<Omit<SubtitleSettings, 'display'>>,
  ): Promise<Result<void>>;
  /** The glossary per streamer, which only the side panel writes. */
  glossary: GlossaryStore;
  /** The state of the active tab of this window; undefined when the window has none. */
  tabState(this: void): Promise<Result<TabState | undefined>>;
  /** Whether the server takes audio input (`models.asr`) and lists PLaMo. */
  capability(this: void): Promise<Result<Capability>>;
  /** Stops the capture of the tab the panel shows (`Sessions.stop(tabId, 'user')`). */
  stopAudio(this: void): Promise<Result<void>>;
  /**
   * Calls `changed` when another tab becomes active, the shown tab finishes loading, or the
   * service worker tells the panel that a state changed (`subs/state-changed`); returns the
   * removal of every listener it added.
   */
  watch(this: void, changed: () => void): () => void;
  /**
   * Calls `changed` with the subtitle settings after each change saved anywhere (the player
   * button, the shortcut, the panel); returns the removal of its listener.
   */
  followSubtitles(this: void, changed: (settings: SubtitleSettings) => void): () => void;
};

export function panelPort(api: PanelApi = browser): PanelPort {
  const send = (message: unknown): Promise<unknown> =>
    api.runtime.sendMessage(addressed('background', message));
  /** The tab the panel shows: its own loads count and other tabs' do not; it is the one stopped. */
  let shownTab: number | undefined;
  const done = (result: Result<unknown>): Result<void> => (result.ok ? Ok(undefined) : result);
  return {
    connection: sidePanelPort(api),
    settings: settingsStore(api.storage.local),
    subtitles: { load: subtitleSettingsStore(api.storage.local).load },
    display: async (mode): Promise<Result<void>> =>
      done(await subtitleProtocol.send(send, 'subs/display', { mode })),
    saveSubtitles: async (patch): Promise<Result<void>> =>
      done(await subtitleProtocol.send(send, 'subs/settings', { patch })),
    glossary: glossaryStore(api.storage.local),
    async tabState(): Promise<Result<TabState | undefined>> {
      const tabs = await capture(
        () => api.tabs.query({ active: true, currentWindow: true }),
        'ipc_failed',
      );
      if (!tabs.ok) return tabs;
      const [tab] = tabs.value;
      shownTab = tab?.id;
      if (tab?.id === undefined) return Ok(undefined);
      return subtitleProtocol.send(send, 'subs/tab-state', { tabId: tab.id });
    },
    async capability(): Promise<Result<Capability>> {
      const answer = await subtitleProtocol.send(send, 'subs/capability', {});
      return answer.ok ? Ok({ audio: answer.value.audio, plamo: answer.value.plamo }) : answer;
    },
    async stopAudio(): Promise<Result<void>> {
      if (shownTab === undefined) return Ok(undefined);
      return done(await subtitleProtocol.send(send, 'subs/stop', { tabId: shownTab }));
    },
    watch(changed) {
      function onActivated(): void {
        changed();
      }
      function onUpdated(tabId: number, changeInfo: { status?: string | undefined }): void {
        if (tabId === shownTab && changeInfo.status === 'complete') changed();
      }
      // Every message the watch pages send to the service worker reaches extension pages too:
      // the target is read first, and only what is for the panel is decoded.
      function onMessage(message: unknown): void {
        if (!isFor('panel', message)) return;
        if (stateChangedSchema.safeParse(message).success) changed();
      }
      api.tabs.onActivated.addListener(onActivated);
      api.tabs.onUpdated.addListener(onUpdated);
      api.runtime.onMessage.addListener(onMessage);
      return () => {
        api.tabs.onActivated.removeListener(onActivated);
        api.tabs.onUpdated.removeListener(onUpdated);
        api.runtime.onMessage.removeListener(onMessage);
      };
    },
    followSubtitles: (changed) => watchSubtitleSettings(api.storage.local, changed),
  };
}
