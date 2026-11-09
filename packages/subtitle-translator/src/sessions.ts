import { z } from 'zod/mini';
import { capture, Err, failure, launch, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  createLlamaClient,
  createQueue,
  type Fetch,
  type SettingsStore,
  type StorageArea,
} from '@chrome-toolbox/extension-core';
import type { FrontState } from './front.ts';
import { toPromptGlossary, type GlossaryEntry, type GlossaryStore } from './glossary.ts';
import { AUDIO_FAILED_MESSAGE, AUDIO_UNSUPPORTED_MESSAGE } from './overlay/source.ts';
import { contextText, type PageInfo, type TabPageStore } from './page-context.ts';
import {
  addressed,
  contentProtocol,
  offscreenProtocol,
  type AudioFailure,
  type AudioStatus,
  type LiveConfigMessage,
  type LiveLine,
} from './protocol.ts';
import type { StorageChanges, StorageEvents, SubtitleSettingsStore } from './settings.ts';
import { UNKNOWN_FRONT, type TabFronts } from './tab-fronts.ts';

/** The `storage.session` key of the captured tab, which outlives a stopped service worker. */
export const CAPTURE_KEY = 'capture';
const recordSchema = z.strictObject({
  tabId: z.int().check(z.nonnegative()),
  startedAt: z.number(),
});
/** The captured tab and when its capture started (`now`). */
export type CaptureRecord = Readonly<z.infer<typeof recordSchema>>;
export type StopReason = 'user' | 'tab-closed' | 'left-site' | 'idle' | 'replaced' | 'failed';

/** A router that loads the speech model again answers `/props` within 13 s (measured). */
const PROPS_TIMEOUT_MS = 15_000;
const YOUTUBE_ORIGIN = 'https://www.youtube.com/';
/** A page of www.youtube.com that plays one video: `/watch` and `/live/<id>`. */
const WATCH_PAGE = /^https:\/\/www\.youtube\.com\/(?:watch(?:[?#]|$)|live\/)/u;
/** What `getMediaStreamId` says when the extension was not invoked on the tab (Task 13 Step 0). */
const NOT_INVOKED = 'has not been invoked';
/**
 * The front of a captured tab that is not the active tab of its window: Chrome keeps a captured
 * page `visible`, so its watch page cannot tell (Task 13 Step 0).
 */
export const AWAY_HIDDEN: FrontState = { state: 'away', reason: 'hidden' };

type Event<L> = { addListener(listener: L): void; removeListener(listener: L): void };
/** The part of `chrome.tabs` the capture uses. */
export type SessionTabs = {
  get(this: void, tabId: number): Promise<Readonly<{ active: boolean }>>;
  query(
    this: void,
    info: { active: true; lastFocusedWindow: true },
  ): Promise<readonly Readonly<{ id?: number | undefined; url?: string | undefined }>[]>;
  sendMessage(
    this: void,
    tabId: number,
    message: unknown,
    options: { frameId: number },
  ): Promise<unknown>;
  onRemoved: Event<(tabId: number) => void>;
  onUpdated: Event<
    (
      tabId: number,
      changeInfo: Readonly<{ status?: string | undefined }>,
      tab: Readonly<{ url?: string | undefined }>,
    ) => void
  >;
  onActivated: Event<(info: Readonly<{ tabId: number; windowId: number }>) => void>;
};
/**
 * `chrome.tabCapture.getMediaStreamId` in its callback form: `error` is `runtime.lastError`'s
 * message, which tells a tab the extension was not invoked on.
 */
export type TabCaptureApi = {
  getMediaStreamId(
    this: void,
    targetTabId: number,
    done: (streamId: string | undefined, error: string | undefined) => void,
  ): void;
};
/** The offscreen document (reason `USER_MEDIA`). */
export type OffscreenDocument = {
  has(this: void): Promise<Result<boolean>>;
  create(this: void): Promise<Result<void>>;
  close(this: void): Promise<Result<void>>;
};

export type SessionsDeps = Readonly<{
  tabCapture: TabCaptureApi;
  offscreen: OffscreenDocument;
  /** `chrome.storage.session`. */
  session: StorageArea & { remove(key: string): Promise<void> };
  /** `chrome.storage.local`'s changes: the settings and the glossary. */
  storage: StorageEvents;
  /** Delivers a message to the offscreen document (`runtime.sendMessage`); the target is added. */
  send: (message: unknown) => Promise<unknown>;
  tabs: SessionTabs;
  settings: SettingsStore;
  subtitles: SubtitleSettingsStore;
  glossary: Pick<GlossaryStore, 'load'>;
  pages: TabPageStore;
  fronts: TabFronts;
  fetch: Fetch;
  now: () => number;
}>;

export type Sessions = {
  /**
   * Captures the tab's audio, after stopping another tab's capture (`replaced`). Asks the server
   * for its audio projector first: without one, `audio_unsupported`, and no stream id or offscreen
   * document is taken (S7). Without `streamId` (the shortcut) it takes one for the tab:
   * `capture_not_invoked` when the extension was not invoked on it.
   */
  start(this: void, tabId: number, streamId?: string): Promise<Result<void>>;
  /** Stops the tab's capture, if it is the captured one; tells its page unless it closed. */
  stop(this: void, tabId: number, reason: StopReason): Promise<Result<void>>;
  /** The captured tab, once what a restart left is known. */
  current(this: void): Promise<Result<CaptureRecord | undefined>>;
  /**
   * Keeps what a watch page reported (`subs/page`). In the captured tab a new video resets the
   * pipeline, and the context goes to the offscreen document with the tab's status.
   */
  page(this: void, tabId: number, info: PageInfo): Promise<Result<void>>;
  /** From the offscreen document: lines for the captured tab's top frame. */
  lines(this: void, tabId: number, lines: readonly LiveLine[]): Promise<Result<void>>;
  /** From the offscreen document: the capture's status for the captured tab's pill. */
  status(this: void, tabId: number, status: AudioStatus): Promise<Result<void>>;
  /** From the offscreen document: nothing processed for 10 minutes. */
  idle(this: void, tabId: number): Promise<Result<void>>;
  /** From the offscreen document: the server lost its audio projector. */
  failed(this: void, tabId: number, code: AudioFailure): Promise<Result<void>>;
  /** The `toggle-audio` shortcut: stops the tab in front if captured, else starts a watch page. */
  toggle(this: void): Promise<Result<void>>;
  /** Removes every listener; waiting operations are cancelled. */
  dispose(this: void): void;
};

/** The captured tab as the service worker follows it. */
type Captured = {
  readonly tabId: number;
  readonly startedAt: number;
  /** What its watch page reported last. */
  front: FrontState;
  /** Whether it is the active tab of its window. */
  active: boolean;
  /** The front sent to the offscreen document last; unknown after a restart. */
  sent: FrontState | undefined;
};

const same = (a: FrontState | undefined, b: FrontState): boolean =>
  a?.state === b.state && a.reason === b.reason;
/** The front the capture follows: away while its tab is not the active one. */
const effective = (at: Captured): FrontState =>
  at.front.state === 'away' || at.active ? at.front : AWAY_HIDDEN;
const SETTING_KEYS: readonly string[] = ['settings', 'subtitles'];
const changesConfig = (changes: StorageChanges): boolean =>
  Object.keys(changes).some((key) => SETTING_KEYS.includes(key) || key.startsWith('glossary:'));

/**
 * The service worker's audio capture: one tab at a time, in the offscreen document. It stops when
 * the tab closes (`tab-closed`), leaves www.youtube.com (`left-site`: a load whose URL is not on
 * it, or hidden; `activeTab` lets the captured tab's URL show), after 10 minutes without processing
 * (`idle`), when another tab starts (`replaced`), when the server loses its projector (`failed`) or
 * on the viewer's stop (`user`). A YouTube SPA navigation keeps it and gives the pipeline the new
 * video's context.
 *
 * The captured tab's front (`fronts.onFront`) goes to the offscreen document on each change; while
 * the tab is not the active tab of its window it is `away`, because Chrome keeps a captured page
 * `visible`. The capture is kept in `storage.session` and found again with the offscreen document
 * after a service worker restart. Tab updates and activations are listened to only while a tab is
 * captured (and from the service worker's start until the session says whether one is): each would
 * wake the service worker for every tab of every site. Starts and stops run one at a time.
 */
export function createSessions({
  tabCapture,
  offscreen,
  session,
  storage,
  send,
  tabs,
  settings,
  subtitles,
  glossary,
  pages,
  fronts,
  fetch,
  now,
}: SessionsDeps): Sessions {
  const queue = createQueue({ concurrency: 1, maxPending: 32 });
  let captured: Captured | undefined;
  let listening = false;
  let disposed = false;

  const toOffscreen = (message: unknown): Promise<unknown> => send(addressed('offscreen', message));
  const toPage =
    (tabId: number) =>
    (message: unknown): Promise<unknown> =>
      tabs.sendMessage(tabId, addressed('content', message), { frameId: 0 });
  /** Runs `task` in turn; its result is not needed (an event has no one to answer). */
  function run(task: () => Promise<Result<unknown>>): void {
    launch(
      async () => {
        await queue.run(task);
      },
      () => undefined,
    );
  }

  async function activeOf(tabId: number): Promise<Result<boolean>> {
    const tab = await capture(() => tabs.get(tabId), 'unexpected_failure');
    return tab.ok ? Ok(tab.value.active) : tab;
  }

  async function readRecord(): Promise<Result<CaptureRecord | undefined>> {
    const stored = await capture(() => session.get(CAPTURE_KEY), 'storage_failed');
    if (!stored.ok) return stored;
    const record = recordSchema.safeParse(stored.value[CAPTURE_KEY]);
    return Ok(record.success ? record.data : undefined);
  }

  async function liveConfig(page: PageInfo | undefined): Promise<Result<LiveConfigMessage>> {
    const chosen = await subtitles.load();
    if (!chosen.ok) return chosen;
    const entries =
      page?.streamer === undefined ? Ok<GlossaryEntry[]>([]) : await glossary.load(page.streamer);
    if (!entries.ok) return entries;
    const { display, sourceLang, translator } = chosen.value;
    return Ok({
      display,
      sourceLang,
      context: page === undefined ? '' : contextText(page),
      glossary: toPromptGlossary(entries.value),
      translator,
    });
  }

  async function mediaStreamId(tabId: number): Promise<Result<string>> {
    const asked = await capture(
      () =>
        new Promise<Result<string>>((resolve) => {
          tabCapture.getMediaStreamId(tabId, (streamId, error) => {
            if (error === undefined && streamId !== undefined && streamId !== '')
              resolve(Ok(streamId));
            else
              resolve(
                Err(
                  failure(
                    error?.includes(NOT_INVOKED) === true
                      ? 'capture_not_invoked'
                      : 'capture_failed',
                  ),
                ),
              );
          });
        }),
      'capture_failed',
    );
    return asked.ok ? asked.value : asked;
  }

  /**
   * Sends the captured tab's front when it changed since the last one sent; one that was not
   * delivered is sent again on the next change.
   */
  function follow(at: Captured): void {
    const front = effective(at);
    if (same(at.sent, front)) return;
    at.sent = front;
    launch(
      async () => {
        const sent = await offscreenProtocol.send(toOffscreen, 'audio/front', { front });
        if (!sent.ok && at.sent === front) at.sent = undefined;
      },
      () => {
        if (at.sent === front) at.sent = undefined;
      },
    );
  }

  function listen(on: boolean): void {
    if (on === listening || (on && disposed)) return;
    listening = on;
    if (on) {
      tabs.onUpdated.addListener(onUpdated);
      tabs.onActivated.addListener(onActivated);
    } else {
      tabs.onUpdated.removeListener(onUpdated);
      tabs.onActivated.removeListener(onActivated);
    }
  }

  async function stopNow(tabId: number, reason: StopReason): Promise<Result<void>> {
    if (captured?.tabId !== tabId) return Ok(undefined);
    captured = undefined;
    listen(false);
    // Closing the document ends the capture even when it cannot answer.
    await offscreenProtocol.send(toOffscreen, 'audio/stop', {});
    const open = await offscreen.has();
    const closed = open.ok && !open.value ? Ok(undefined) : await offscreen.close();
    const removed = await capture(() => session.remove(CAPTURE_KEY), 'storage_failed');
    if (reason !== 'tab-closed') {
      const status: AudioStatus =
        reason === 'failed'
          ? { state: 'error', message: AUDIO_UNSUPPORTED_MESSAGE }
          : { state: 'stopped' };
      // The page may be gone (another site): the capture is stopped all the same.
      await contentProtocol.send(toPage(tabId), 'subs/status', { status });
    }
    return closed.ok ? removed : closed;
  }

  async function startNow(tabId: number, streamId: string | undefined): Promise<Result<void>> {
    if (captured?.tabId === tabId) return Ok(undefined);
    const loaded = await settings.load();
    if (!loaded.ok) return loaded;
    const { llamaBaseUrl: baseUrl, models } = loaded.value;
    // The router loads the speech model now, before a stream id that expires within 10 s.
    const props = await createLlamaClient({ baseUrl, fetch, timeoutMs: PROPS_TIMEOUT_MS }).props({
      model: models.asr,
    });
    if (!props.ok) return props;
    if (props.value.audio === false) return Err(failure('audio_unsupported'));
    const page = await pages.get(tabId);
    if (!page.ok) return page;
    const config = await liveConfig(page.value);
    if (!config.ok) return config;
    // Another tab's capture ends only now: a start refused above leaves it running.
    if (captured !== undefined) {
      const replaced = await stopNow(captured.tabId, 'replaced');
      if (!replaced.ok) return replaced;
    }
    const id = streamId === undefined ? await mediaStreamId(tabId) : Ok(streamId);
    if (!id.ok) return id;
    const open = await offscreen.has();
    if (!open.ok) return open;
    if (!open.value) {
      const created = await offscreen.create();
      if (!created.ok) return created;
    }
    const started = await offscreenProtocol.send(toOffscreen, 'audio/start', {
      tabId,
      streamId: id.value,
      settings: { baseUrl, models },
      config: config.value,
    });
    if (!started.ok) {
      const closed = await offscreen.close();
      return closed.ok ? started : closed;
    }
    const record: CaptureRecord = { tabId, startedAt: now() };
    const written = await capture(() => session.set({ [CAPTURE_KEY]: record }), 'storage_failed');
    if (!written.ok) {
      await offscreenProtocol.send(toOffscreen, 'audio/stop', {});
      const closed = await offscreen.close();
      return closed.ok ? written : closed;
    }
    const [front, active] = await Promise.all([fronts.get(tabId), activeOf(tabId)]);
    const at: Captured = {
      ...record,
      // A tab that reported nothing processes nothing.
      front: front.ok ? front.value : UNKNOWN_FRONT,
      active: active.ok && active.value,
      sent: undefined,
    };
    captured = at;
    listen(true);
    follow(at);
    return Ok(undefined);
  }

  function onRemoved(tabId: number): void {
    run(() => stopNow(tabId, 'tab-closed'));
  }
  function onUpdated(
    tabId: number,
    changeInfo: Readonly<{ status?: string | undefined }>,
    tab: Readonly<{ url?: string | undefined }>,
  ): void {
    if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
    if (tab.url?.startsWith(YOUTUBE_ORIGIN) === true) return;
    run(() => stopNow(tabId, 'left-site'));
  }
  function onActivated(): void {
    launch(
      async () => {
        await recovery;
        const at = captured;
        if (at === undefined) return;
        const active = await activeOf(at.tabId);
        if (!active.ok || captured !== at) return;
        at.active = active.value;
        follow(at);
      },
      () => undefined,
    );
  }
  function onFront(tabId: number, front: FrontState): void {
    launch(
      async () => {
        await recovery;
        const at = captured;
        if (at?.tabId !== tabId) return;
        at.front = front;
        follow(at);
      },
      () => undefined,
    );
  }
  function onStorage(changes: StorageChanges): void {
    if (!changesConfig(changes)) return;
    launch(
      async () => {
        await recovery;
        const at = captured;
        if (at === undefined) return;
        const page = await pages.get(at.tabId);
        const config = await liveConfig(page.ok ? page.value : undefined);
        if (!config.ok || captured !== at) return;
        await offscreenProtocol.send(toOffscreen, 'audio/config', { config: config.value });
      },
      () => undefined,
    );
  }

  // Registered at once, so the event that woke a service worker still reaches it; tab updates and
  // activations are kept only if a capture is found.
  tabs.onRemoved.addListener(onRemoved);
  listen(true);
  const unsubscribe = fronts.onFront(onFront);
  storage.onChanged.addListener(onStorage);
  const recovery = queue.run(async (): Promise<Result<void>> => {
    const record = await readRecord();
    const open = await offscreen.has();
    const document = open.ok && open.value;
    const kept = record.ok ? record.value : undefined;
    if (kept !== undefined && document) {
      const [front, active] = await Promise.all([fronts.get(kept.tabId), activeOf(kept.tabId)]);
      captured = {
        ...kept,
        front: front.ok ? front.value : UNKNOWN_FRONT,
        active: active.ok && active.value,
        sent: undefined,
      };
      return Ok(undefined);
    }
    listen(false);
    if (kept !== undefined) {
      const removed = await capture(() => session.remove(CAPTURE_KEY), 'storage_failed');
      if (!removed.ok) return removed;
    }
    // A document without a capture (the worker stopped mid-start) holds nothing worth keeping.
    return document ? offscreen.close() : Ok(undefined);
  });

  return {
    start: (tabId, streamId) => queue.run(() => startNow(tabId, streamId)),
    stop: (tabId, reason) => queue.run(() => stopNow(tabId, reason)),
    current: () =>
      queue.run(async (): Promise<Result<CaptureRecord | undefined>> =>
        Ok(
          captured === undefined
            ? undefined
            : { tabId: captured.tabId, startedAt: captured.startedAt },
        ),
      ),
    async page(tabId, info): Promise<Result<void>> {
      const before = await pages.get(tabId);
      const kept = await pages.report(tabId, info);
      if (!kept.ok) return kept;
      await recovery;
      const at = captured;
      if (at?.tabId !== tabId) return Ok(undefined);
      if (!before.ok || before.value?.videoId !== info.videoId) {
        const reset = await offscreenProtocol.send(toOffscreen, 'audio/reset', {});
        if (!reset.ok) return reset;
      }
      const config = await liveConfig(info);
      if (!config.ok) return config;
      const sent = await offscreenProtocol.send(toOffscreen, 'audio/config', {
        config: config.value,
      });
      if (!sent.ok) return sent;
      // A page that loaded anew learns that its tab's audio is the source.
      await contentProtocol.send(toPage(tabId), 'subs/status', {
        status: { state: effective(at).state },
      });
      return Ok(undefined);
    },
    async lines(tabId, lines): Promise<Result<void>> {
      await recovery;
      if (captured?.tabId !== tabId) return Ok(undefined);
      // A page that is not listening (still loading) gets the next lines.
      await contentProtocol.send(toPage(tabId), 'subs/lines', { lines: [...lines] });
      return Ok(undefined);
    },
    async status(tabId, status): Promise<Result<void>> {
      await recovery;
      if (captured?.tabId !== tabId) return Ok(undefined);
      await contentProtocol.send(toPage(tabId), 'subs/status', { status });
      return Ok(undefined);
    },
    idle: (tabId) => queue.run(() => stopNow(tabId, 'idle')),
    // The one failure that stops a capture is a lost projector (`AUDIO_FAILURES`).
    failed: (tabId) => queue.run(() => stopNow(tabId, 'failed')),
    async toggle(): Promise<Result<void>> {
      const listed = await capture(
        () => tabs.query({ active: true, lastFocusedWindow: true }),
        'unexpected_failure',
      );
      if (!listed.ok) return listed;
      const [tab] = listed.value;
      const tabId = tab?.id;
      if (tabId === undefined) return Ok(undefined);
      return queue.run(async (): Promise<Result<void>> => {
        if (captured?.tabId === tabId) return stopNow(tabId, 'user');
        // The shortcut invoked the extension on the tab: `activeTab` shows its URL.
        if (tab?.url === undefined || !WATCH_PAGE.test(tab.url)) return Ok(undefined);
        const started = await startNow(tabId, undefined);
        if (!started.ok) {
          const message =
            started.error.internalCode === 'audio_unsupported'
              ? AUDIO_UNSUPPORTED_MESSAGE
              : AUDIO_FAILED_MESSAGE;
          await contentProtocol.send(toPage(tabId), 'subs/status', {
            status: { state: 'error', message },
          });
        }
        return started;
      });
    },
    dispose() {
      disposed = true;
      listen(false);
      tabs.onRemoved.removeListener(onRemoved);
      unsubscribe();
      storage.onChanged.removeListener(onStorage);
      queue.clear();
    },
  };
}
