import { browser } from 'wxt/browser';
import { capture, decode, Err, failure, launch, Ok, type Result } from '@chrome-toolbox/contracts';
import {
  createClefJudge,
  createLanguageDetector,
  createLlamaClient,
  createLruCache,
  createQueue,
  llmHandlers,
  settingsStore,
  type ChatReply,
  type ChatRequest,
  type Fetch,
  type LlamaClient,
  type Queue,
  type Settings,
  type SettingsStore,
} from '@chrome-toolbox/extension-core';
import { createHiddenBadge } from './badge.ts';
import { createFeedbackStore, type FeedbackStore } from './feedback.ts';
import { SPOILER_NOTES_KEY, spoilerNotesOf } from './filters.ts';
import { createGenreBook, genreOf, type GenreBook, type GenreSource } from './genre.ts';
import {
  createCommentPipeline,
  MAX_COMMENT_CONCURRENCY,
  type CommentPipeline,
  type IngestReply,
  type Target,
} from './pipeline.ts';
import {
  commentProtocol,
  pingReplySchema,
  type Annotation,
  type CommentProtocolHandlers,
  type CommentStats,
  type HiddenEntry,
  type GenreView,
  type Summary,
} from './protocol.ts';
import type { Site } from './sites/types.ts';
import {
  createStreamContexts,
  streamCategoriesOf,
  type StreamContext,
  type StreamContexts,
  type StreamInfo,
} from './stream-context.ts';

/** Frames remembered as told their streamer (a few tabs × frames). */
const TOLD_FRAMES = 64;
/** A 3-comment batch may generate 512 tokens at about 37 tokens/s; a router's cold model load took 13 s live. */
const COMMENT_TIMEOUT_MS = 30_000;

/** Fire-and-forget: a frame that navigated or reloaded has no receiver and needs no annotation. */
function sendAnnotations(target: Target, annotations: Annotation[]): void {
  const message = { type: 'comments/annotations', payload: annotations };
  launch(
    async () => {
      await browser.tabs.sendMessage(target.tabId, message, { frameId: target.frameId });
    },
    () => undefined,
  );
}

type CommentPipelines = {
  current(this: void): Promise<Result<CommentPipeline>>;
  /** Error code of the latest failed read of the saved feedback, until a read succeeds. */
  feedbackError(this: void): string | undefined;
  /** The saved settings changed: the next `current()` reloads them. */
  reload(this: void): void;
  dispose(this: void): void;
};

/** Builds the comment pipeline from the saved settings on first use and again when they change. */
function commentPipelines({
  settings,
  feedback,
  context,
  fetch,
  queue,
  clefQueue,
  onHiddenChange,
}: {
  settings: SettingsStore;
  /** The viewer's verdicts on hidden comments, shared by every pipeline the settings build. */
  feedback: FeedbackStore;
  /** The stream context of a channel (streamer, title, spoiler targets, genre). */
  context: (site: Site, channel: string) => StreamContext;
  fetch: Fetch;
  queue: Queue;
  /** Clef has its own queue so its requests run while the translate call does. */
  clefQueue: Queue;
  /** A channel's hidden comments without a verdict (the toolbar badge, R54). */
  onHiddenChange: (site: Site, channel: string, count: number) => void;
}): CommentPipelines {
  // LanguageDetector is exposed to windows only (Translator and Language Detector APIs IDL,
  // `[Exposed=Window]`), so the service worker always uses the script guess.
  const detector = createLanguageDetector(undefined);
  let loading: Promise<Result<Settings>> | undefined;
  /** The pipeline of the current settings and the abort of its slot-count request. */
  type Active = { key: string; pipeline: CommentPipeline; probe: AbortController };
  let active: Active | undefined;
  let disposed = false;
  function retire(): void {
    active?.probe.abort();
    active?.pipeline.dispose();
    active = undefined;
  }
  function build(
    key: string,
    { llamaBaseUrl: baseUrl, models }: Settings,
    verdicts: FeedbackStore,
  ): Active {
    const client = createLlamaClient({ baseUrl, fetch, queue, timeoutMs: COMMENT_TIMEOUT_MS });
    const probe = new AbortController();
    /**
     * The server's slot count: being asked, known, not answered (llama.cpp down or a router still
     * loading), or asked again after that (R53).
     */
    let slots: 'asking' | 'known' | 'failed' | 'again' = 'asking';
    // Batches start serial; a server with 3 or more slots gets one batch per spare slot, keeping
    // one for subtitles. Without an answer (old server, router still loading) they stay serial.
    function askSlots(): void {
      launch(
        async () => {
          const props = await client.props({ model: models.translate, signal: probe.signal });
          if (props.ok) {
            slots = 'known';
            pipeline.setServerSlots(props.value.totalSlots);
          } else if (slots === 'asking') slots = 'failed';
        },
        () => undefined,
      );
    }
    // A pipeline built while llama.cpp was down asks once more after the first answered chat.
    const answering: LlamaClient = {
      ...client,
      chat: async (request: ChatRequest): Promise<Result<ChatReply>> => {
        const reply = await client.chat(request);
        if (reply.ok && slots === 'failed') {
          slots = 'again';
          askSlots();
        }
        return reply;
      },
    };
    const pipeline = createCommentPipeline({
      client: answering,
      model: models.translate,
      judge: createClefJudge({ baseUrl, model: models.clef, fetch, queue: clefQueue }),
      detector,
      context,
      feedback: verdicts,
      emit: sendAnnotations,
      onHiddenChange,
      now: () => Date.now(),
    });
    askSlots();
    return { key, pipeline, probe };
  }
  let feedbackError: string | undefined;
  async function current(): Promise<Result<CommentPipeline>> {
    if (disposed) return Err(failure('operation_cancelled'));
    // Unread saved verdicts do not stop comment processing: the store is session-only until a
    // later call reads them (bounded by the store), and stats report the failure.
    const read = await feedback.load();
    feedbackError = read.ok ? undefined : read.error.internalCode;
    if (disposed) return Err(failure('operation_cancelled'));
    const pending = (loading ??= settings.load());
    const loaded = await pending;
    // The settings changed while they were loading: use the newer ones.
    if (pending !== loading) return current();
    if (disposed) return Err(failure('operation_cancelled'));
    if (!loaded.ok) {
      loading = undefined;
      return loaded;
    }
    const { llamaBaseUrl, models } = loaded.value;
    const key = JSON.stringify([llamaBaseUrl, models.translate, models.clef]);
    if (active?.key !== key) {
      retire();
      active = build(key, loaded.value, feedback);
    }
    return Ok(active.pipeline);
  }
  return {
    current,
    feedbackError: () => feedbackError,
    reload: () => {
      loading = undefined;
    },
    dispose: () => {
      disposed = true;
      loading = undefined;
      retire();
    },
  };
}

/**
 * Routes only extension pages may use: they read the viewer's chat summary, read or change the
 * viewer's verdicts, or ask which stream a tab shows.
 */
type PageRoute =
  | 'comments/stream'
  | 'comments/genre'
  | 'comments/summary'
  | 'comments/hidden'
  | 'comments/feedback'
  | 'comments/export'
  | 'comments/feedback/clear';
/** Routes whose answer depends on the sending frame. */
type FrameRoute = 'comments/ingest' | 'comments/context';

/** The part of `runtime.MessageSender` that names the sending page and frame. */
type Sender = Readonly<{
  tab?: Readonly<{ id?: number | undefined }> | undefined;
  frameId?: number | undefined;
  url?: string | undefined;
  /** `'null'` for an opaque origin (a sandboxed page). */
  origin?: string | undefined;
}>;

/**
 * Whether the sender is one of this extension's pages (the side panel, also when opened as a
 * tab): its URL is under this extension's base URL and its origin is not opaque (a sandboxed
 * page). A content script's sender is the web page it runs in.
 */
function fromExtensionPage(sender: Sender): boolean {
  return sender.origin !== 'null' && (sender.url?.startsWith(browser.runtime.getURL('/')) ?? false);
}

/**
 * A stream as pages are told it: without the spoiler note, the genre and the relaxations, which
 * only prompts need.
 */
const publicStream = ({ site, partition, streamer, title }: StreamContext): StreamContext => ({
  site,
  partition,
  ...(streamer === undefined ? {} : { streamer }),
  ...(title === undefined ? {} : { title }),
});

/**
 * Fire-and-forget to every frame of a tab, or to one frame of it: a frame without a receiver
 * needs nothing.
 */
function sendToTab(tabId: number, message: unknown, frameId?: number): void {
  launch(
    async () => {
      if (frameId === undefined) await browser.tabs.sendMessage(tabId, message);
      else await browser.tabs.sendMessage(tabId, message, { frameId });
    },
    () => undefined,
  );
}
/** Tells open extension pages (the side panel) that a tab's stream changed. */
function announceStreamChange(): void {
  // Rejects when no extension page listens: there is nothing to tell then.
  launch(
    async () => {
      await browser.runtime.sendMessage({ type: 'comments/stream-changed' });
    },
    () => undefined,
  );
}
/**
 * The stream a tab's top frame shows (partition, streamer, title, and what decides its genre),
 * if it has one.
 */
async function streamOfTab(
  tabId: number,
): Promise<Result<StreamInfo & { site: Site; partition: string }>> {
  const answer = await capture(
    () => browser.tabs.sendMessage(tabId, { type: 'comments/ping' }, { frameId: 0 }),
    'resource_missing',
  );
  if (!answer.ok) return answer;
  const reply = decode(pingReplySchema, answer.value);
  if (!reply.ok) return reply;
  const { site, partition, ...info } = reply.value;
  return site === undefined || partition === undefined
    ? Err(failure('resource_missing'))
    : Ok({ site, partition, ...info });
}
/** What decides the genre (R63) among what a page reported; undefined without its title. */
const genreSourceOf = ({ title, game, tags, rules }: StreamInfo): GenreSource | undefined =>
  title === undefined
    ? undefined
    : {
        title,
        ...(game === undefined ? {} : { game }),
        ...(tags === undefined ? {} : { tags }),
        ...(rules === undefined ? {} : { rules }),
      };

/**
 * Every stream's genre (R63): kept in `book`, applied to the stream contexts (which the batch
 * prompts read), and guessed once by the model for a stream nothing else decides.
 */
function streamGenres(
  book: GenreBook,
  contexts: StreamContexts,
): {
  /** Applies the stream's kept genre to its context; returns whether the context changed. */
  apply(this: void, site: Site, partition: string): boolean;
  /**
   * What the page shows decides the genre again; returns whether the genre, its reason or the
   * relaxations changed.
   */
  observe(this: void, site: Site, partition: string, source: GenreSource): boolean;
  /** The genre as the side panel shows it, with the stream categories on for `context`. */
  info(this: void, context: StreamContext): GenreView;
} {
  function apply(site: Site, partition: string): boolean {
    const kept = genreOf(book.get(site, partition));
    if (kept === undefined) return false;
    const { genre, relaxations } = kept;
    return contexts.classify(site, partition, { genre, relaxations }).changed;
  }
  return {
    apply,
    observe(site, partition, source) {
      const changed = book.observe(site, partition, source);
      return apply(site, partition) || changed;
    },
    info(context) {
      const record = book.get(context.site, context.partition);
      const kept = genreOf(record);
      return {
        genre: kept?.genre ?? 'other',
        reason: kept?.reason ?? 'none',
        detected: record?.genre ?? 'other',
        detectedReason: record?.reason ?? 'none',
        categories: streamCategoriesOf(context),
      };
    },
  };
}

/**
 * The viewer's spoiler notes (one per stream, R30), read once from extension storage and
 * followed through `storage.onChanged`.
 */
function spoilerNotes(contexts: StreamContexts): {
  context(this: void, site: Site, channel: string): StreamContext;
  /** Reads the saved notes unless they are known; resolves once they are. */
  load(this: void): Promise<Result<void>>;
  /** The saved notes changed (the side panel saved one). */
  changed(this: void, value: unknown): void;
} {
  let reading: Promise<Result<void>> | undefined;
  async function read(): Promise<Result<void>> {
    const stored = await capture(
      () => browser.storage.local.get(SPOILER_NOTES_KEY),
      'storage_failed',
    );
    reading = undefined;
    // A change saved while reading is newer than what was read.
    if (contexts.notesKnown()) return Ok(undefined);
    // Unreadable notes count as none; a later change of them is followed.
    contexts.setNotes(spoilerNotesOf(stored.ok ? stored.value[SPOILER_NOTES_KEY] : undefined));
    return Ok(undefined);
  }
  function load(): Promise<Result<void>> {
    if (contexts.notesKnown()) return Promise.resolve(Ok(undefined));
    reading ??= read();
    return reading;
  }
  return {
    context(site, channel) {
      // The pipeline asks synchronously: the notes join the prompts once they are read.
      if (!contexts.notesKnown() && reading === undefined)
        launch(
          async () => void (await load()),
          () => undefined,
        );
      return contexts.get(site, channel);
    },
    load,
    changed(value) {
      contexts.setNotes(spoilerNotesOf(value));
    },
  };
}

/** Registers the service worker's message router and comment pipeline; returns their cleanup. */
export function startBackground(): () => void {
  // The comment pipeline bounds its own batches in flight (1 unless the server has spare slots);
  // a full queue answers queue_full instead of growing. Clef and the translation model are
  // separate llama.cpp processes, so each has a queue.
  const queue = createQueue({ concurrency: MAX_COMMENT_CONCURRENCY, maxPending: 16 });
  const clefQueue = createQueue({ concurrency: 1, maxPending: 16 });
  const fetcher: Fetch = (input, init) => fetch(input, init);
  // Verdicts stay in extension storage until newer ones replace them or the viewer clears them.
  const feedback = createFeedbackStore({ area: browser.storage.local });
  // What pages reported about their streams (streamer, title) and the streams' spoiler notes.
  const contexts = createStreamContexts();
  const notes = spoilerNotes(contexts);
  // Every stream's genre, kept in extension storage across service worker restarts (R63).
  const book = createGenreBook(browser.storage.local);
  const genres = streamGenres(book, contexts);
  /** Frames already told their stream's streamer after an ingest without it. */
  const told = createLruCache<string, true>({ max: TOLD_FRAMES });
  // The toolbar badge counts each tab's removed comments without a verdict (R54).
  const badge = createHiddenBadge((tabId, text) => {
    // A closed tab has no badge to set.
    launch(
      async () => {
        await browser.action.setBadgeText({ tabId, text });
      },
      () => undefined,
    );
  });
  const pipelines = commentPipelines({
    settings: settingsStore(browser.storage.local),
    feedback,
    context: notes.context,
    fetch: fetcher,
    queue,
    clefQueue,
    onHiddenChange: badge.counted,
  });
  /**
   * The stream's one genre guess (R63 step 5), when nothing on its page decided the genre; asked
   * for a chat in front of the viewer only (R44), and never waited for: the batches go on with
   * the genre known until the answer comes.
   */
  function guessGenre(site: Site, partition: string, title: string | undefined): void {
    const input = book.guessInput(site, partition, title);
    if (input === undefined) return;
    launch(
      async () => {
        const pipeline = await pipelines.current();
        if (!pipeline.ok) return;
        const guessed = await pipeline.value.guessGenre(input);
        // No answer (llama.cpp down): nothing is kept, and a later service worker may ask again.
        if (!guessed.ok) return;
        const kept = book.guessed(site, partition, guessed.value, input);
        if (genres.apply(site, partition) || kept) announceStreamChange();
      },
      () => undefined,
    );
  }
  const handlers: Omit<CommentProtocolHandlers, FrameRoute | PageRoute> = {
    ...llmHandlers({ fetch: fetcher, queue }),
    'comments/stats': async ({ site, channel }): Promise<Result<CommentStats>> => {
      const pipeline = await pipelines.current();
      if (!pipeline.ok) return pipeline;
      const feedbackError = pipelines.feedbackError();
      return Ok({
        ...pipeline.value.stats(site, channel),
        ...(feedbackError === undefined ? {} : { feedbackError }),
      });
    },
  };
  /**
   * Summaries, hidden comments and verdicts are the viewer's: only extension pages may ask for
   * them.
   */
  const pageHandlers: Pick<CommentProtocolHandlers, PageRoute> = {
    // The side panel asks by hand and on its own 2-minute timer; the service worker keeps none.
    'comments/summary': async ({ site, channel, windowMinutes }): Promise<Result<Summary>> => {
      const pipeline = await pipelines.current();
      return pipeline.ok ? pipeline.value.summary(site, channel, windowMinutes) : pipeline;
    },
    'comments/stream': async ({
      tabId,
    }): Promise<Result<{ stream?: StreamContext; genre?: GenreView }>> => {
      // The tab's top frame is asked each time: a tab that navigated away answers nothing.
      const shown = await streamOfTab(tabId);
      if (!shown.ok) return Ok({});
      const { site, partition, ...info } = shown.value;
      // What the page shows is the newest (and all there is after a service worker restart).
      const { context: reported, changed } = contexts.report(site, partition, info);
      if (changed && reported.streamer !== undefined)
        sendToTab(tabId, { type: 'comments/stream-info', payload: publicStream(reported) });
      const loaded = await book.load();
      if (!loaded.ok) return loaded;
      const source = genreSourceOf(info);
      if (source === undefined) genres.apply(site, partition);
      else genres.observe(site, partition, source);
      // The categories count the stream's spoiler note (R64).
      const noted = await notes.load();
      if (!noted.ok) return noted;
      const context = contexts.get(site, partition);
      return Ok({ stream: publicStream(context), genre: genres.info(context) });
    },
    'comments/genre': async ({
      site,
      partition,
      genre,
    }): Promise<Result<{ persisted: boolean }>> => {
      const loaded = await book.load();
      if (!loaded.ok) return loaded;
      const chosen = await book.choose(site, partition, genre);
      if (!chosen.ok) return chosen;
      genres.apply(site, partition);
      announceStreamChange();
      return chosen;
    },
    'comments/hidden': async ({ site, channel }): Promise<Result<HiddenEntry[]>> => {
      const pipeline = await pipelines.current();
      return pipeline.ok ? Ok(pipeline.value.hidden(site, channel)) : pipeline;
    },
    'comments/feedback': async ({
      site,
      channel,
      id,
      verdict,
    }): Promise<Result<{ persisted: boolean }>> => {
      const pipeline = await pipelines.current();
      return pipeline.ok ? pipeline.value.review(site, channel, id, verdict) : pipeline;
    },
    'comments/export': async (): Promise<Result<{ jsonl: string }>> => {
      // An export without the saved verdicts would look complete while it is not.
      const read = await feedback.load();
      return read.ok ? Ok({ jsonl: feedback.export() }) : read;
    },
    'comments/feedback/clear': async (): Promise<Result<Record<string, never>>> => {
      const cleared = await feedback.clear();
      if (!cleared.ok) return cleared;
      // The streams' kept genres and the viewer's choices go too (the README's privacy note);
      // the pages shown now are detected again as they report.
      const loaded = await book.load();
      if (!loaded.ok) return loaded;
      const forgotten = await book.clear();
      if (!forgotten.ok) return forgotten;
      announceStreamChange();
      // The hidden lists forget their confirmations too: those comments can be judged again.
      const pipeline = await pipelines.current();
      if (pipeline.ok) pipeline.value.clearVerdicts();
      return Ok({});
    },
  };
  const forbidden = (): Promise<Result<never>> => Promise.resolve(Err(failure('sender_forbidden')));
  const contentHandlers: Pick<CommentProtocolHandlers, PageRoute> = {
    'comments/stream': forbidden,
    'comments/genre': forbidden,
    'comments/summary': forbidden,
    'comments/hidden': forbidden,
    'comments/feedback': forbidden,
    'comments/export': forbidden,
    'comments/feedback/clear': forbidden,
  };
  function onMessage(
    message: unknown,
    sender: Sender,
    sendResponse: (response: unknown) => void,
  ): true {
    const route = commentProtocol.route({
      ...handlers,
      // A content script's sender is the web page; the side panel's is an extension page.
      ...(fromExtensionPage(sender) ? pageHandlers : contentHandlers),
      // A frame reports its stream: remembered for the stream, told to every frame of the tab
      // (the chat frame learns the streamer) and, when it changed, to the side panel.
      'comments/context': async ({
        site,
        partition,
        streamer,
        title,
        game,
        tags,
        rules,
      }): Promise<Result<Record<string, never>>> => {
        const tabId = sender.tab?.id;
        if (tabId === undefined || sender.frameId === undefined || fromExtensionPage(sender))
          return Err(failure('input_invalid'));
        // The top frame names the tab's stream, or that it left one: the badge follows.
        if (sender.frameId === 0) badge.shows(tabId, site, partition);
        if (partition === undefined) {
          if (sender.frameId === 0) announceStreamChange();
          return Ok({});
        }
        const { context, changed } = contexts.report(site, partition, {
          ...(streamer === undefined ? {} : { streamer }),
          ...(title === undefined ? {} : { title }),
        });
        // A page that shows the title shows what decides the genre (R63): detected again.
        const loaded = await book.load();
        if (!loaded.ok) return loaded;
        const source = genreSourceOf({ title, game, tags, rules });
        const detected = source !== undefined && genres.observe(site, partition, source);
        // The stream's spoiler note is read before the frame's comments are judged.
        const noted = await notes.load();
        if (!noted.ok) return noted;
        if (context.streamer !== undefined)
          sendToTab(tabId, { type: 'comments/stream-info', payload: publicStream(context) });
        if (changed || detected) announceStreamChange();
        return Ok({});
      },
      // Annotations return to the frame that sent the comments, so ingest needs the sender.
      'comments/ingest': async ({
        site,
        channel,
        streamer,
        title,
        process,
        left,
        comments,
      }): Promise<Result<IngestReply>> => {
        const tabId = sender.tab?.id;
        if (tabId === undefined || sender.frameId === undefined)
          return Err(failure('input_invalid'));
        // After a service worker restart the tab's comments name its stream for the badge.
        if (!badge.knows(tabId)) badge.shows(tabId, site, channel);
        // The frame's view of its stream: after a service worker restart it is all there is.
        const { context, changed } = contexts.report(site, channel, {
          ...(streamer === undefined ? {} : { streamer }),
          ...(title === undefined ? {} : { title }),
        });
        if (changed) announceStreamChange();
        // A frame that does not know the streamer the service worker knows (a popout opened
        // before its watch page) is told once, so it uses the streamer's filters.
        if (streamer === undefined && context.streamer !== undefined) {
          const key = `${tabId}:${sender.frameId}:${site}:${context.partition}:${context.streamer}`;
          if (told.get(key) === undefined) {
            told.set(key, true);
            sendToTab(
              tabId,
              { type: 'comments/stream-info', payload: publicStream(context) },
              sender.frameId,
            );
          }
        }
        const pipeline = await pipelines.current();
        if (!pipeline.ok) return pipeline;
        // The stream's spoiler note joins the prompts from the first batch on.
        const noted = await notes.load();
        if (!noted.ok) return noted;
        // So does its kept genre (after a restart or an eviction too); a stream no page described
        // (a popout alone) is detected from its title (R63).
        const loaded = await book.load();
        if (!loaded.ok) return loaded;
        const described =
          book.get(site, channel) !== undefined || context.title === undefined
            ? genres.apply(site, channel)
            : genres.observe(site, channel, { title: context.title });
        if (described) announceStreamChange();
        // Only a chat in front of the viewer may ask for the stream's one guess (R44).
        if (process !== false && left !== true && comments.length > 0)
          guessGenre(site, channel, context.title);
        // `process: false`: the comments are only stored (R44); `left`: the frame's chat left
        // the viewer, so the waiting comments only it shows are stored too (R49).
        return Ok(
          pipeline.value.ingest(
            { tabId, frameId: sender.frameId },
            { site, channel, process, left, comments },
          ),
        );
      },
    });
    launch(
      async () => {
        sendResponse(await route(message));
      },
      (error) => sendResponse(Err(error)),
    );
    // Keeps the channel open for the asynchronous sendResponse.
    return true;
  }
  function onStorageChanged(changes: Record<string, { newValue?: unknown }>): void {
    if (Object.hasOwn(changes, 'settings')) pipelines.reload();
    // The side panel saved a stream's spoiler note.
    if (Object.hasOwn(changes, SPOILER_NOTES_KEY))
      notes.changed(changes[SPOILER_NOTES_KEY]?.newValue);
  }
  /**
   * A badged tab finished loading a page (a full navigation, a reload, a History API move): its
   * top frame names its stream again, and a page without one (no content script there, or `{}`)
   * empties the badge (R54). Chrome keeps a tab's badge across navigations. A tab the badge does
   * not know (the service worker restarted) is asked only when Chrome still shows a badge on it.
   */
  function onTabUpdated(tabId: number, change: { status?: string | undefined }): void {
    if (change.status !== 'complete') return;
    launch(
      async () => {
        if (!badge.knows(tabId)) {
          const text = await capture(
            () => browser.action.getBadgeText({ tabId }),
            'unexpected_failure',
          );
          if (!text.ok || text.value === '') return;
        }
        const shown = await streamOfTab(tabId);
        if (shown.ok) badge.shows(tabId, shown.value.site, shown.value.partition);
        else badge.leaves(tabId);
      },
      () => undefined,
    );
  }
  browser.runtime.onMessage.addListener(onMessage);
  browser.storage.local.onChanged.addListener(onStorageChanged);
  browser.tabs.onUpdated.addListener(onTabUpdated);
  return () => {
    browser.runtime.onMessage.removeListener(onMessage);
    browser.storage.local.onChanged.removeListener(onStorageChanged);
    browser.tabs.onUpdated.removeListener(onTabUpdated);
    pipelines.dispose();
    contexts.clear();
    queue.clear();
    clefQueue.clear();
  };
}
