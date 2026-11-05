import { browser } from 'wxt/browser';
import { decode, launch } from '@chrome-toolbox/contracts';
import { applyAnnotations, clearDisplay, injectStyles, refreshAnnotations } from './display.ts';
import {
  defaultFilterSettings,
  filterKey,
  filterSettingsSchema,
  filterStore,
  settingsOf,
  type FilterSettings,
} from './filters.ts';
import { createHold } from './hold.ts';
import {
  annotationsMessageSchema,
  commentProtocol,
  messageType,
  pingMessageSchema,
  streamInfoMessageSchema,
  type Annotation,
  type PingReply,
  type RawComment,
} from './protocol.ts';
import { observeComments } from './sites/observe.ts';
import type { Site, SiteAdapter } from './sites/types.ts';
import { ownerOf, streamOf, type StreamInfo } from './stream-context.ts';

/**
 * Annotations kept for comments shown again: a list the site re-rendered (Top chat ↔ Live
 * chat) and new filter settings. YouTube keeps a few hundred lines on screen.
 */
const MAX_REMEMBERED = 1000;

/** Unreadable or removed settings fall back to the defaults. */
function filtersOf(value: unknown): FilterSettings {
  if (value === undefined) return defaultFilterSettings;
  const decoded = decode(filterSettingsSchema, value);
  return decoded.ok ? settingsOf(decoded.value) : defaultFilterSettings;
}
/** The Navigation API of the page's window, where the browser has it. */
function navigationOf(doc: Document): EventTarget | undefined {
  const view = doc.defaultView;
  return view !== null && 'navigation' in view && view.navigation instanceof EventTarget
    ? view.navigation
    : undefined;
}

export type ChatOptions = Readonly<{
  /** Asked before each send: the extension may have been reloaded or removed. */
  isInvalid?: () => boolean;
  /** Delivers a message to the service worker (`runtime.sendMessage`). */
  send?: (message: unknown) => Promise<unknown>;
  /**
   * Where same-document navigations are announced (`navigatesuccess`), for adapters that follow
   * the History API (Twitch); the window's Navigation API by default.
   */
  navigation?: EventTarget;
}>;

/** Fire-and-forget: tells the service worker which stream this frame shows, or that it left. */
function reportStream(
  deliver: (message: unknown) => Promise<unknown>,
  payload: Readonly<{
    site: Site;
    partition?: string;
    streamer?: string | undefined;
    title?: string | undefined;
  }>,
): void {
  launch(
    async () => {
      // A refused report changes nothing on the page: the chat keeps the filters it has.
      await commentProtocol.send(deliver, 'comments/context', payload);
    },
    () => undefined,
  );
}

/**
 * Runs the chat display on one page: reads comments with `adapter`, sends them to the service
 * worker ('comments/ingest', processed only while the chat is in front of the viewer, R44), and
 * shows the annotations it sends back under the filter settings
 * of the stream's streamer (drawn by the style `startPage` injects). A line the page adds while
 * the chat is in front comes in only once it is judged (R52, `createHold`), unless the filters
 * turn that off or the last ingest reply says llama.cpp is unreachable (or the ingest failed): then
 * lines come in as posted, and those waiting come in at once. Leaving the viewer, a new container,
 * another channel and stopping let every waiting line in. It reports the stream
 * ('comments/context') on start, when the page shows new stream info and when the channel
 * changes; the streamer comes from the page or, in the live chat frame, from the service worker
 * ('comments/stream-info'). Returns the cleanup of every observer, listener and timer; it also
 * takes the display off the comments (original text back, `data-ca-*` attributes removed).
 */
export function startChat(
  adapter: SiteAdapter,
  doc: Document,
  {
    isInvalid = () => false,
    send: deliver = (message) => browser.runtime.sendMessage(message),
    navigation: announced,
  }: ChatOptions = {},
): () => void {
  // Only a site that follows the History API listens; YouTube restarts on its own event.
  const navigation = adapter.followsHistory ? (announced ?? navigationOf(doc)) : undefined;
  const store = filterStore(browser.storage.local);
  let channel = adapter.channel(doc);
  /** The streamer of the channel's stream, once the page or the service worker named it. */
  let streamer: string | undefined;
  let filters = defaultFilterSettings;
  /** What the page showed about the channel's stream so far; a later read only adds to it. */
  let shown: StreamInfo = {};
  /** The title the service worker told (the live chat frame's page shows none). */
  let told: string | undefined;
  /** The last report sent, so an unchanged one is not sent again. */
  let reported: string | undefined;
  /** Stops waiting for the page to show the channel's title. */
  let stopWaiting: (() => void) | undefined;
  /** Newest last; the oldest is dropped past MAX_REMEMBERED. */
  const remembered = new Map<string, Annotation>();
  /** The chat list as observeComments watches it (not looked up for each batch, R45). */
  let list: Element | null = null;
  let stopped = false;
  /** New lines kept out of sight until judged (R52). */
  const hold = createHold();
  /**
   * The latest ingest reply said llama.cpp could not be reached (`lastError: network_failed`),
   * or the ingest itself failed: no line waits for a judgement until a reply says otherwise.
   */
  let failing = false;

  /** The streamer, or the stream while the streamer is unknown: the filters' key. */
  const owner = (): string | undefined =>
    channel === undefined
      ? undefined
      : ownerOf({ partition: channel, ...(streamer ? { streamer } : {}) });
  const key = (): string | undefined => {
    const current = owner();
    return current === undefined ? undefined : filterKey(adapter.site, current);
  };
  function refresh(): void {
    if (list) refreshAnnotations(list, adapter, (id) => remembered.get(id), filters);
  }
  /**
   * Shows annotations at once. Waiting for the page's next change of the list saved no layout:
   * YouTube's list and the test chat force their layout while posting a line, before any
   * MutationObserver callback (R51). Lines waiting for them come in in the same turn, after
   * their attributes are written: a concealed line is never seen as written (R52). The hold
   * reads the chat's scroll after the writes, so a line they removed is no anchor (R59).
   */
  function show(annotations: readonly Annotation[]): void {
    if (list && annotations.length > 0)
      hold.pass(applyAnnotations(list, adapter, annotations, filters));
  }
  /**
   * Marks the comments whose lines wait for their judgement: the service worker takes them
   * first while they can still be judged in time (R57). Lines on screen when the chat came back
   * never wait (R44).
   */
  function marked(comments: readonly RawComment[]): RawComment[] {
    if (!list || hold.size() === 0) return [...comments];
    const root = list;
    return comments.map((comment) => {
      const message = adapter.messageElement(root, comment.id);
      return message && hold.waits(message) ? { ...comment, held: true } : comment;
    });
  }
  /** Whether a new line waits for its judgement (R52). */
  function holding(): boolean {
    return filters.holdUntilJudged && !failing && channel !== undefined && !isInvalid();
  }
  /** Follows what an ingest reply tells: a failing server lets the waiting lines in. */
  function setFailing(next: boolean): void {
    if (next && !failing) hold.releaseAll();
    failing = next;
  }
  /** New filter settings: lines stop waiting when the viewer turned it off. */
  function apply(next: FilterSettings): void {
    filters = next;
    if (!filters.holdUntilJudged) hold.releaseAll();
    refresh();
  }
  function load(): void {
    const wanted = owner();
    if (wanted === undefined) return;
    const wantedKey = key();
    launch(
      async () => {
        const loaded = await store.load(adapter.site, wanted);
        // Stopped, or the channel or streamer changed while loading: the newer load decides.
        if (stopped || key() !== wantedKey) return;
        // Unreadable settings leave the defaults in place.
        apply(loaded.ok ? loaded.value : defaultFilterSettings);
      },
      () => undefined,
    );
  }
  /** A streamer named for the channel's stream: its filters apply from now on. */
  function takeStreamer(next: string | undefined): void {
    if (next === undefined || next === streamer) return;
    streamer = next;
    load();
  }
  /**
   * Reports the channel's stream when what the page shows about it changed. A read that finds
   * nothing (the page is moving to the next video) keeps what was shown.
   */
  function report(): void {
    if (stopped || channel === undefined || isInvalid()) return;
    const read = adapter.streamInfo?.(doc, channel);
    shown = {
      streamer: read?.streamer ?? shown.streamer,
      title: read?.title ?? shown.title,
    };
    takeStreamer(shown.streamer);
    const payload = {
      site: adapter.site,
      partition: channel,
      ...(shown.streamer === undefined ? {} : { streamer: shown.streamer }),
      ...(shown.title === undefined ? {} : { title: shown.title }),
    };
    const json = JSON.stringify(payload);
    if (json === reported) return;
    reported = json;
    reportStream(deliver, payload);
  }
  /**
   * While the page does not show the channel's title yet (YouTube's metadata and Twitch's
   * stream information arrive after the navigation), waits for it and reports it then.
   */
  function awaitTitle(): void {
    stopWaiting?.();
    stopWaiting = undefined;
    if (stopped || channel === undefined || shown.title !== undefined) return;
    stopWaiting = adapter.watchStreamInfo?.(doc, channel, report);
  }
  /**
   * Follows a channel change (Twitch moves between channels without a reload). The channel left
   * is told as left (R49): its comments still waiting for the model are stored, not processed
   * after the viewer moved on.
   */
  function follow(): void {
    const current = adapter.channel(doc);
    if (current === channel) return;
    // The lines waiting belong to the channel left.
    hold.releaseAll();
    if (channel !== undefined && !isInvalid()) send(channel, [], false, true);
    channel = current;
    streamer = undefined;
    shown = {};
    told = undefined;
    reported = undefined;
    remembered.clear();
    filters = defaultFilterSettings;
    if (channel === undefined) {
      awaitTitle();
      if (!isInvalid()) reportStream(deliver, { site: adapter.site });
      return;
    }
    // A streamer the page names loads its filters; otherwise the stream's own key does.
    report();
    if (streamer === undefined) load();
    awaitTitle();
  }
  function remember(annotation: Annotation): void {
    remembered.delete(annotation.id);
    remembered.set(annotation.id, annotation);
    if (remembered.size <= MAX_REMEMBERED) return;
    const [oldest] = remembered.keys();
    if (oldest !== undefined) remembered.delete(oldest);
  }
  function send(target: string, comments: RawComment[], process: boolean, left = false): void {
    // What this frame knows about the stream travels with its comments.
    const title = shown.title ?? told;
    launch(
      async () => {
        const sent = await commentProtocol.send(deliver, 'comments/ingest', {
          site: adapter.site,
          channel: target,
          ...(streamer === undefined ? {} : { streamer }),
          ...(title === undefined ? {} : { title }),
          process,
          ...(left ? { left } : {}),
          comments,
        });
        if (stopped) return;
        // A refused or failed ingest leaves these comments in the original, as the pipeline
        // does for comments it drops; the side panel reports the connection state. Lines do not
        // wait for answers that will not come (R52): only an outage (a failed ingest, or
        // llama.cpp unreachable) stops the wait; one batch answered badly does not.
        setFailing(!sent.ok || sent.value.lastError === 'network_failed');
      },
      () => undefined,
    );
  }
  /**
   * Comments read from the page; `process` false for comments only to be stored (R44): the chat
   * is not in front of the viewer, or they are off screen.
   */
  function onBatch(comments: RawComment[], process: boolean): void {
    if (isInvalid()) {
      hold.releaseAll();
      return;
    }
    // A site that changes pages without a reload (Twitch) moved to another channel.
    follow();
    if (channel === undefined) {
      hold.releaseAll();
      return;
    }
    // The title may render after the chat: a cheap re-read that reports only a change.
    report();
    const known: Annotation[] = [];
    const fresh: RawComment[] = [];
    for (const comment of comments) {
      const annotation = remembered.get(comment.id);
      if (annotation) known.push(annotation);
      else fresh.push(comment);
    }
    // Re-rendered lines already answered are shown at once, without a round trip.
    show(known);
    // observeComments keeps a batch within one ingest message.
    if (fresh.length > 0) send(channel, process ? marked(fresh) : fresh, process);
  }
  /**
   * The chat left the viewer: the service worker stores the comments still waiting for the model
   * that only this frame shows (R49).
   */
  function onLeave(): void {
    // Lines left waiting are not processed now: they come in as they are.
    hold.releaseAll(false);
    if (isInvalid()) return;
    follow();
    if (channel !== undefined) send(channel, [], false, true);
  }
  /**
   * The service worker's annotations for comments this frame sent, and the streamer it learned
   * for a stream (the live chat frame's own video knows none).
   */
  function onMessage(message: unknown): undefined {
    if (stopped) return undefined;
    const type = messageType(message);
    if (type === 'comments/annotations') {
      const decoded = annotationsMessageSchema.safeParse(message);
      if (!decoded.success) return undefined;
      for (const annotation of decoded.data.payload) remember(annotation);
      show(decoded.data.payload);
      return undefined;
    }
    if (type !== 'comments/stream-info') return undefined;
    const stream = streamInfoMessageSchema.safeParse(message);
    if (
      stream.success &&
      channel !== undefined &&
      stream.data.payload.site === adapter.site &&
      stream.data.payload.partition === streamOf(channel)
    ) {
      told = stream.data.payload.title ?? told;
      takeStreamer(stream.data.payload.streamer);
    }
    return undefined;
  }
  function onStorageChanged(changes: Record<string, { newValue?: unknown }>): void {
    const watched = key();
    if (watched === undefined || !Object.hasOwn(changes, watched)) return;
    apply(filtersOf(changes[watched]?.newValue));
  }
  function onNavigate(): void {
    follow();
  }

  browser.runtime.onMessage.addListener(onMessage);
  browser.storage.local.onChanged.addListener(onStorageChanged);
  navigation?.addEventListener('navigatesuccess', onNavigate);
  report();
  if (streamer === undefined) load();
  awaitTitle();
  const stopObserving = observeComments(adapter, doc, onBatch, onLeave, {
    onContainer(found) {
      // The lines waiting were in the list replaced.
      hold.releaseAll(false);
      list = found;
    },
    onAdmit(lines) {
      if (holding()) hold.wait(lines);
    },
    onSkip(lines) {
      hold.pass(lines);
    },
  });
  return () => {
    stopped = true;
    stopObserving();
    hold.stop();
    stopWaiting?.();
    navigation?.removeEventListener('navigatesuccess', onNavigate);
    browser.runtime.onMessage.removeListener(onMessage);
    browser.storage.local.onChanged.removeListener(onStorageChanged);
    const root = adapter.container(doc);
    if (root) clearDisplay(root);
    remembered.clear();
  };
}

/**
 * Runs the chat display for whichever adapter matches the page's URL, and again after each of
 * YouTube's in-page navigations (`yt-navigate-finish`): a watch page gets the comments adapter,
 * other YouTube pages get nothing (no observers, no style). The style is injected once while
 * an adapter runs and stays across restarts. The page answers the service worker's
 * 'comments/ping' (asked of the top frame when the side panel wants the tab's stream) with the
 * partition it shows, and reports leaving a stream page. Returns the cleanup.
 */
export function startPage(
  doc: Document,
  adapters: readonly SiteAdapter[],
  options: ChatOptions = {},
): () => void {
  const {
    isInvalid = () => false,
    send: deliver = (message) => browser.runtime.sendMessage(message),
  } = options;
  let running: SiteAdapter | undefined;
  let stopChat: (() => void) | undefined;
  let removeStyles: (() => void) | undefined;
  function start(): void {
    stopChat?.();
    stopChat = undefined;
    const url = URL.parse(doc.URL);
    const adapter = url ? adapters.find((candidate) => candidate.matches(url)) : undefined;
    const left = running;
    running = adapter;
    if (!adapter) {
      removeStyles?.();
      removeStyles = undefined;
      // A stream page became another page (YouTube home): the side panel should know.
      if (left !== undefined && !isInvalid()) reportStream(deliver, { site: left.site });
      return;
    }
    removeStyles ??= injectStyles(doc);
    stopChat = startChat(adapter, doc, options);
  }
  // Each navigation may change the video, or leave or reach a watch page.
  function onNavigate(): void {
    start();
  }
  /** Answers which stream this page shows; other messages are not for this listener. */
  function onPing(
    message: unknown,
    _sender: unknown,
    sendResponse: (reply: PingReply) => void,
  ): undefined {
    if (messageType(message) !== 'comments/ping' || !pingMessageSchema.safeParse(message).success)
      return undefined;
    const partition = running?.channel(doc);
    if (running === undefined || partition === undefined) {
      sendResponse({});
      return undefined;
    }
    // With what the page shows, so a restarted service worker learns the stream again.
    const info = running.streamInfo?.(doc, partition);
    sendResponse({
      site: running.site,
      partition,
      ...(info?.streamer === undefined ? {} : { streamer: info.streamer }),
      ...(info?.title === undefined ? {} : { title: info.title }),
    });
    return undefined;
  }
  start();
  doc.addEventListener('yt-navigate-finish', onNavigate);
  browser.runtime.onMessage.addListener(onPing);
  return () => {
    doc.removeEventListener('yt-navigate-finish', onNavigate);
    browser.runtime.onMessage.removeListener(onPing);
    stopChat?.();
    stopChat = undefined;
    running = undefined;
    removeStyles?.();
    removeStyles = undefined;
  };
}
