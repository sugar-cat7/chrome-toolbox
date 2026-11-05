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
import {
  filterStore,
  spoilerNoteStore,
  type FilterStore,
  type SpoilerNoteStore,
} from './filters.ts';
import {
  commentProtocol,
  messageType,
  streamChangedMessageSchema,
  type CommentStats,
  type FeedbackVerdict,
  type HiddenEntry,
  type Summary,
  type SummaryWindow,
} from './protocol.ts';
import { partitionsOf, type StreamContext } from './stream-context.ts';

/** An extension event as the side panel uses it: add and remove one listener. */
type PanelEvent<Listener> = {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
};
/** The extension APIs a side panel uses; tests pass a fake with this shape. */
export type PanelApi = {
  storage: { local: StorageArea };
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
  api: Pick<PanelApi, 'storage' | 'permissions'> & {
    runtime: Pick<PanelApi['runtime'], 'sendMessage'>;
  } = browser,
): ConnectionPort {
  return connectionPort({
    settings: settingsStore(api.storage.local),
    permissions: api.permissions,
    send: (message) => api.runtime.sendMessage(message),
  });
}

/** Everything the side panel does goes through this port; it registers nothing until `watch`. */
export type PanelPort = {
  connection: ConnectionPort;
  /** The llama.cpp settings (model names) in extension storage. */
  settings: SettingsStore;
  /** Filter settings per streamer in extension storage; the chat follows them as they change. */
  filters: FilterStore;
  /** Spoiler targets per stream (R30); the stream's batch prompts carry them. */
  notes: SpoilerNoteStore;
  /** The stream the active tab of this window shows; undefined when it shows none. */
  stream(this: void): Promise<Result<StreamContext | undefined>>;
  /**
   * Calls `changed` when another tab becomes active, the shown tab finishes loading, or a page
   * reports a change of its stream; returns the removal of every listener it added.
   */
  watch(this: void, changed: () => void): () => void;
  /** The stream's hidden comments (on YouTube its chat and its video comments), newest first. */
  hidden(this: void, stream: StreamContext): Promise<Result<HiddenEntry[]>>;
  /** The viewer's verdict on one hidden comment; `persisted: false` means it is saved later. */
  review(
    this: void,
    entry: HiddenEntry,
    verdict: FeedbackVerdict,
  ): Promise<Result<{ persisted: boolean }>>;
  /** Every saved verdict as JSONL. */
  exportFeedback(this: void): Promise<Result<string>>;
  /** Forgets every verdict (allowlists, corrections and raised thresholds too). */
  clearFeedback(this: void): Promise<Result<void>>;
  /** Counters and the abuse judge in use (Clef or the model) for the stream's chat. */
  stats(this: void, stream: StreamContext): Promise<Result<CommentStats>>;
  /** A summary of the stream's chat over the last `windowMinutes`, made now. */
  summary(
    this: void,
    stream: StreamContext,
    windowMinutes: SummaryWindow,
  ): Promise<Result<Summary>>;
};

export function panelPort(api: PanelApi = browser): PanelPort {
  const send = (message: unknown): Promise<unknown> => api.runtime.sendMessage(message);
  /** The tab whose stream the panel shows, so its own loads count and other tabs' do not. */
  let shownTab: number | undefined;
  return {
    connection: sidePanelPort(api),
    settings: settingsStore(api.storage.local),
    filters: filterStore(api.storage.local),
    notes: spoilerNoteStore(api.storage.local),
    async stream(): Promise<Result<StreamContext | undefined>> {
      const tabs = await capture(
        () => api.tabs.query({ active: true, currentWindow: true }),
        'ipc_failed',
      );
      if (!tabs.ok) return tabs;
      const [tab] = tabs.value;
      shownTab = tab?.id;
      if (tab?.id === undefined) return Ok(undefined);
      const answer = await commentProtocol.send(send, 'comments/stream', { tabId: tab.id });
      return answer.ok ? Ok(answer.value.stream) : answer;
    },
    watch(changed) {
      function onActivated(): void {
        changed();
      }
      function onUpdated(tabId: number, changeInfo: { status?: string | undefined }): void {
        if (tabId === shownTab && changeInfo.status === 'complete') changed();
      }
      // Content scripts' messages reach extension pages too: only the stream change counts, and
      // only it is decoded.
      function onMessage(message: unknown): void {
        if (messageType(message) !== 'comments/stream-changed') return;
        if (streamChangedMessageSchema.safeParse(message).success) changed();
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
    async hidden(stream): Promise<Result<HiddenEntry[]>> {
      const lists = await Promise.all(
        partitionsOf(stream).map((channel) =>
          commentProtocol.send(send, 'comments/hidden', { site: stream.site, channel }),
        ),
      );
      const entries: HiddenEntry[] = [];
      for (const list of lists) {
        if (!list.ok) return list;
        entries.push(...list.value);
      }
      return Ok(entries.sort((a, b) => b.at - a.at));
    },
    review: (entry, verdict) =>
      commentProtocol.send(send, 'comments/feedback', {
        site: entry.site,
        channel: entry.channel,
        id: entry.id,
        verdict,
      }),
    async exportFeedback(): Promise<Result<string>> {
      const exported = await commentProtocol.send(send, 'comments/export', {});
      return exported.ok ? Ok(exported.value.jsonl) : exported;
    },
    async clearFeedback(): Promise<Result<void>> {
      const cleared = await commentProtocol.send(send, 'comments/feedback/clear', {});
      return cleared.ok ? Ok(undefined) : cleared;
    },
    stats: (stream) =>
      commentProtocol.send(send, 'comments/stats', {
        site: stream.site,
        channel: stream.partition,
      }),
    // The stream's chat: its partition (on YouTube the video id, not its comments).
    summary: (stream, windowMinutes) =>
      commentProtocol.send(send, 'comments/summary', {
        site: stream.site,
        channel: stream.partition,
        windowMinutes,
      }),
  };
}
