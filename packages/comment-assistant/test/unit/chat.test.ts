// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { z } from 'zod/mini';
import { Err, failure, Ok } from '@chrome-toolbox/contracts';
import { startChat, startPage } from '../../src/chat.ts';
import { defaultFilterSettings, filterKey } from '../../src/filters.ts';
import {
  annotationsMessageSchema,
  commentProtocolSpec,
  MAX_INGEST_COMMENTS,
  messageType,
  pingMessageSchema,
  streamInfoMessageSchema,
  type Annotation,
} from '../../src/protocol.ts';
import { createTwitchChat } from '../../src/sites/twitch-chat.ts';
import { youtubeComments } from '../../src/sites/youtube-comments.ts';
import { youtubeLiveChat } from '../../src/sites/youtube-live-chat.ts';
import { installIntersection, restorePage, setVisibility } from './intersection.ts';

const FLUSH = 600;
function load(location: string, fixture = 'youtube-live-chat'): Document {
  window.history.replaceState(null, '', location);
  const html = readFileSync(path.join(import.meta.dirname, `../fixtures/${fixture}.html`), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.replaceChild(
    document.importNode(parsed.documentElement, true),
    document.documentElement,
  );
  return document;
}
/** What the service worker accepts as 'comments/ingest'. */
const ingestSchema = z.strictObject({
  type: z.literal('comments/ingest'),
  payload: commentProtocolSpec['comments/ingest'].request,
});
type Ingest = z.infer<typeof ingestSchema>;
/** What the service worker accepts as 'comments/context'. */
const contextSchema = z.strictObject({
  type: z.literal('comments/context'),
  payload: commentProtocolSpec['comments/context'].request,
});
type Context = z.infer<typeof contextSchema>['payload'];
/**
 * The service worker: records each ingest and context message (failing on any message it would
 * refuse).
 */
function stubWorker(): {
  sent: Ingest[];
  contexts: Context[];
  send: (message: unknown) => Promise<unknown>;
} {
  const sent: Ingest[] = [];
  const contexts: Context[] = [];
  return {
    sent,
    contexts,
    send: (message) => {
      const context = contextSchema.safeParse(message);
      if (context.success) {
        contexts.push(context.data.payload);
        return Promise.resolve(Ok({}));
      }
      const ingest = ingestSchema.parse(message);
      sent.push(ingest);
      return Promise.resolve(Ok({ accepted: ingest.payload.comments.length, dropped: 0 }));
    },
  };
}
/** The service worker names the streamer of a stream to every frame of the tab. */
const tellStream = async (payload: Record<string, string>): Promise<void> => {
  const replies = await fakeBrowser.runtime.onMessage.trigger(
    { type: 'comments/stream-info', payload },
    {},
    () => undefined,
  );
  // Fire-and-forget: the content script never answers it.
  expect(replies.every((reply) => reply === undefined)).toBe(true);
};
const annotate = async (payload: Annotation[]): Promise<void> => {
  const message = { type: 'comments/annotations', payload };
  const replies = await fakeBrowser.runtime.onMessage.trigger(message, {}, () => undefined);
  // Annotations are fire-and-forget: the content script never answers.
  expect(replies.every((reply) => reply === undefined)).toBe(true);
};
const line = (id: string): HTMLElement | null => document.getElementById(id);
const caAttributes = (doc: Document): string[] =>
  [...doc.querySelectorAll('*')].flatMap((element) =>
    element.getAttributeNames().filter((name) => name.startsWith('data-ca-')),
  );

beforeEach(() => {
  installIntersection();
});
afterEach(() => {
  fakeBrowser.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restorePage();
});

describe('startChat', () => {
  it('sends the comments it reads and shows the annotations under the channel filters', async () => {
    vi.useFakeTimers();
    const { sent, send } = stubWorker();
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('comments/ingest');
    expect(sent[0]?.payload.site).toBe('youtube');
    expect(sent[0]?.payload.channel).toBe('fixture0001');
    expect(sent[0]?.payload.comments.map(({ id }) => id)).toEqual([
      'fixture-live-01',
      'fixture-live-02',
      'fixture-live-03',
      'fixture-live-04',
      'fixture-live-05',
      'fixture-live-06',
    ]);

    await annotate([
      {
        id: 'fixture-live-01',
        category: 'question',
        state: 'done',
        translation: '今日は何のゲーム？',
      },
      { id: 'fixture-live-03', category: 'spam', state: 'done' },
    ]);
    expect(line('fixture-live-01')?.getAttribute('data-ca-mode')).toBe('highlight');
    expect(line('fixture-live-01')?.querySelector('#message')?.textContent).toBe(
      '今日は何のゲーム？',
    );
    // Spam is removed from the chat by default (R54).
    expect(line('fixture-live-03')?.getAttribute('data-ca-mode')).toBe('hide');

    // The side panel saves this channel's filters: the chat follows at once.
    await fakeBrowser.storage.local.set({
      [filterKey('youtube', 'fixture0001')]: {
        ...defaultFilterSettings,
        showOriginal: true,
        modes: { ...defaultFilterSettings.modes, spam: 'show' },
      },
    });
    expect(line('fixture-live-03')?.getAttribute('data-ca-mode')).toBe('show');
    expect(line('fixture-live-01')?.querySelector('#message')?.textContent).toBe(
      'What game is this stream playing today?',
    );

    // Unreadable settings fall back to the defaults.
    await fakeBrowser.storage.local.set({ [filterKey('youtube', 'fixture0001')]: { modes: 'x' } });
    expect(line('fixture-live-03')?.getAttribute('data-ca-mode')).toBe('hide');

    stop();
    // The display comes off: original text back and no data-ca-* attribute left.
    expect(line('fixture-live-01')?.querySelector('#message')?.textContent).toBe(
      'What game is this stream playing today?',
    );
    expect(caAttributes(doc)).toEqual([]);
    await annotate([{ id: 'fixture-live-02', category: 'spam', state: 'done' }]);
    expect(line('fixture-live-02')?.hasAttribute('data-ca-mode')).toBe(false);
  });

  it('keeps an explicit 伏せる of a versioned record that lists every category (R56)', async () => {
    vi.useFakeTimers();
    const { send } = stubWorker();
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    const modes = {
      abusive: 'blur',
      spam: 'blur',
      spoiler: 'blur',
      question: 'show',
      important: 'highlight',
      chatter: 'show',
    } as const;
    await fakeBrowser.storage.local.set({
      [filterKey('youtube', 'fixture0001')]: { v: 2, ...defaultFilterSettings, modes },
    });
    await annotate([{ id: 'fixture-live-01', category: 'abusive', state: 'done' }]);
    expect(line('fixture-live-01')?.getAttribute('data-ca-mode')).toBe('blur');
    // Without a version the same record reads as saved before Task 5d: abusive is removed.
    await fakeBrowser.storage.local.set({
      [filterKey('youtube', 'fixture0001')]: { ...defaultFilterSettings, modes },
    });
    expect(line('fixture-live-01')?.getAttribute('data-ca-mode')).toBe('hide');
    stop();
  });

  it('sends comments read while the page is hidden for storing only, and tells when it leaves the viewer (R44, R49)', async () => {
    vi.useFakeTimers();
    const { sent, send } = stubWorker();
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(sent.map(({ payload }) => [payload.process, payload.comments.length])).toEqual([
      [true, 6],
    ]);
    // Leaving is a message of its own: the service worker then stores the comments still
    // waiting that only this frame shows.
    setVisibility(doc, 'hidden');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.at(-1)?.payload).toEqual({
      site: 'youtube',
      channel: 'fixture0001',
      process: false,
      left: true,
      comments: [],
    });
    const template = line('fixture-live-01')?.cloneNode(true);
    if (!(template instanceof Element)) throw new Error('fixture changed');
    template.id = 'while-hidden';
    youtubeLiveChat.container(doc)?.append(template);
    await vi.advanceTimersByTimeAsync(1100);
    expect(sent.at(-1)?.payload).toMatchObject({
      process: false,
      comments: [{ id: 'while-hidden' }],
    });
    expect(sent.at(-1)?.payload).not.toHaveProperty('left');
    expect(sent).toHaveLength(3);
    stop();
  });

  it('applies saved filters on start and shows a re-rendered list without asking again', async () => {
    vi.useFakeTimers();
    const { sent, send } = stubWorker();
    await fakeBrowser.storage.local.set({
      [filterKey('youtube', 'fixture0001')]: {
        ...defaultFilterSettings,
        modes: { ...defaultFilterSettings.modes, question: 'hide' },
      },
    });
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    await annotate([{ id: 'fixture-live-01', category: 'question', state: 'done' }]);
    expect(line('fixture-live-01')?.getAttribute('data-ca-mode')).toBe('hide');

    // Top chat ↔ Live chat: YouTube renders the same lines in a new list.
    const list = doc.querySelector('yt-live-chat-item-list-renderer');
    const copy = list?.cloneNode(true);
    if (!list || !(copy instanceof Element)) throw new Error('fixture changed');
    for (const element of copy.querySelectorAll('[data-ca-mode]'))
      for (const name of element.getAttributeNames())
        if (name.startsWith('data-ca-')) element.removeAttribute(name);
    list.replaceWith(copy);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(line('fixture-live-01')?.getAttribute('data-ca-mode')).toBe('hide');
    // Only the lines without an annotation are sent again.
    expect(sent.at(-1)?.payload.comments.map(({ id }) => id)).toEqual([
      'fixture-live-02',
      'fixture-live-03',
      'fixture-live-04',
      'fixture-live-05',
      'fixture-live-06',
    ]);
    stop();
  });

  it('sends the newest of a long backlog within the ingest limit and nothing without a channel', async () => {
    vi.useFakeTimers();
    const { sent, send } = stubWorker();
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const items = youtubeLiveChat.container(doc);
    const template = line('fixture-live-01');
    for (let index = 0; index < 1200; index += 1) {
      const copy = template?.cloneNode(true);
      if (copy instanceof Element) {
        copy.id = `bulk-${index}`;
        items?.append(copy);
      }
    }
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(sent).toHaveLength(1);
    const ids = sent[0]?.payload.comments.map(({ id }) => id);
    expect(ids).toHaveLength(MAX_INGEST_COMMENTS);
    expect([ids?.at(0), ids?.at(-1)]).toEqual(['bulk-200', 'bulk-1199']);
    stop();

    const other = load('/live_chat?continuation=opaque');
    const stopOther = startChat(youtubeLiveChat, other, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(sent).toHaveLength(1);
    stopOther();
  });

  it('follows a site that changes channels without a reload (Twitch)', async () => {
    vi.useFakeTimers();
    const { sent, send } = stubWorker();
    await fakeBrowser.storage.local.set({
      [filterKey('twitch', 'secondchannel')]: {
        ...defaultFilterSettings,
        modes: { ...defaultFilterSettings.modes, chatter: 'hide' },
      },
    });
    const doc = load('/firstchannel', 'twitch-chat');
    const twitch = createTwitchChat('s1');
    const stop = startChat(twitch, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(sent.map(({ payload }) => payload.channel)).toEqual(['firstchannel']);

    window.history.replaceState(null, '', '/secondchannel');
    const container = twitch.container(doc);
    const wrapper = container?.lastElementChild?.cloneNode(true);
    if (!(wrapper instanceof Element)) throw new Error('fixture changed');
    wrapper.querySelector('[data-ca-id]')?.removeAttribute('data-ca-id');
    container?.append(wrapper);
    await vi.advanceTimersByTimeAsync(FLUSH);
    // The first channel's chat left the viewer (R49), then the second one's comments are sent.
    expect(sent.map(({ payload }) => [payload.channel, payload.left ?? false])).toEqual([
      ['firstchannel', false],
      ['firstchannel', true],
      ['secondchannel', false],
    ]);
    expect(sent[2]?.payload.comments.map(({ id }) => id)).toEqual(['s1-6']);
    // The second channel's own filter settings apply.
    await annotate([{ id: 's1-6', category: 'chatter', state: 'done' }]);
    expect(twitch.messageElement(container ?? doc.body, 's1-6')?.getAttribute('data-ca-mode')).toBe(
      'hide',
    );
    stop();
  });

  it('reports the watch page stream once its metadata shows the video and keys filters by the streamer', async () => {
    vi.useFakeTimers();
    const { contexts, sent, send } = stubWorker();
    await fakeBrowser.storage.local.set({
      [filterKey('youtube', '@FixtureStreamer')]: {
        ...defaultFilterSettings,
        modes: { ...defaultFilterSettings.modes, spam: 'show' },
      },
    });
    // YouTube changed the URL; the metadata still shows the previous video (fixture0001).
    const doc = load('/watch?v=fixture0002', 'youtube-comments');
    const navigation = new EventTarget();
    const stop = startPage(doc, [youtubeLiveChat, youtubeComments], { send, navigation });
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(contexts).toEqual([{ site: 'youtube', partition: 'fixture0002#comments' }]);
    expect(sent.map(({ payload }) => payload.channel)).toEqual(['fixture0002#comments']);
    await annotate([{ id: 'FixtureThread01', category: 'spam', state: 'done' }]);
    const thread = youtubeComments.messageElement(
      youtubeComments.container(doc) ?? doc.body,
      'FixtureThread01',
    );
    expect(thread?.getAttribute('data-ca-mode')).toBe('hide');

    doc.querySelector('ytd-watch-flexy')?.setAttribute('video-id', 'fixture0002');
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(contexts.at(-1)).toEqual({
      site: 'youtube',
      partition: 'fixture0002#comments',
      streamer: '@FixtureStreamer',
      title: 'Fixture Quest Part 3: the frozen bridge',
    });
    // The streamer's own filters apply from now on.
    await vi.waitFor(() => expect(thread?.getAttribute('data-ca-mode')).toBe('show'));
    // Neither a repeated attribute change nor a History API navigation reports it again: YouTube
    // restarts on yt-navigate-finish.
    doc.querySelector('ytd-watch-flexy')?.setAttribute('video-id', 'fixture0002');
    window.history.replaceState(null, '', '/watch?v=fixture0003');
    navigation.dispatchEvent(new Event('navigatesuccess'));
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(contexts).toHaveLength(2);
    stop();
  });

  it('learns the streamer of a live chat frame from the service worker and uses its filters', async () => {
    vi.useFakeTimers();
    const { contexts, sent, send } = stubWorker();
    await fakeBrowser.storage.local.set({
      [filterKey('youtube', '@FixtureStreamer')]: {
        ...defaultFilterSettings,
        modes: { ...defaultFilterSettings.modes, question: 'hide' },
      },
    });
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    // The frame knows only its video.
    expect(contexts).toEqual([{ site: 'youtube', partition: 'fixture0001' }]);
    expect(sent[0]?.payload).not.toHaveProperty('streamer');
    await annotate([{ id: 'fixture-live-01', category: 'question', state: 'done' }]);
    expect(line('fixture-live-01')?.getAttribute('data-ca-mode')).toBe('highlight');

    // Another stream's streamer changes nothing here.
    await tellStream({ site: 'youtube', partition: 'fixture0009', streamer: '@OtherStreamer' });
    await tellStream({ site: 'twitch', partition: 'fixture0001', streamer: 'fixture0001' });
    await vi.advanceTimersByTimeAsync(0);
    expect(line('fixture-live-01')?.getAttribute('data-ca-mode')).toBe('highlight');
    await tellStream({ site: 'youtube', partition: 'fixture0001', streamer: '@FixtureStreamer' });
    await vi.waitFor(() =>
      expect(line('fixture-live-01')?.getAttribute('data-ca-mode')).toBe('hide'),
    );
    // ... and it follows that streamer's filters as they change.
    await fakeBrowser.storage.local.set({
      [filterKey('youtube', '@FixtureStreamer')]: defaultFilterSettings,
    });
    expect(line('fixture-live-01')?.getAttribute('data-ca-mode')).toBe('highlight');
    expect(contexts).toHaveLength(1);
    // Its next comments carry the streamer and title it was told (a restarted service worker
    // learns them again from there).
    await tellStream({
      site: 'youtube',
      partition: 'fixture0001',
      streamer: '@FixtureStreamer',
      title: 'Fixture Quest Part 3',
    });
    const copy = line('fixture-live-02')?.cloneNode(true);
    if (!(copy instanceof Element)) throw new Error('fixture changed');
    copy.id = 'fixture-live-99';
    youtubeLiveChat.container(doc)?.append(copy);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(sent.at(-1)?.payload).toMatchObject({
      channel: 'fixture0001',
      streamer: '@FixtureStreamer',
      title: 'Fixture Quest Part 3',
      comments: [{ id: 'fixture-live-99' }],
    });
    stop();
  });

  it('follows Twitch to another channel and away from channels without waiting for chat', async () => {
    vi.useFakeTimers();
    const { contexts, sent, send } = stubWorker();
    await fakeBrowser.storage.local.set({
      [filterKey('twitch', 'secondchannel')]: {
        ...defaultFilterSettings,
        modes: { ...defaultFilterSettings.modes, chatter: 'hide' },
      },
    });
    const doc = load('/firstchannel', 'twitch-chat');
    const info = doc.querySelector('#live-channel-stream-information a');
    const heading = doc.querySelector('[data-a-target="stream-title"]');
    if (!info || !heading) throw new Error('fixture changed');
    info.setAttribute('href', '/firstchannel');
    const navigation = new EventTarget();
    const twitch = createTwitchChat('s1');
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const stop = startChat(twitch, doc, { send, navigation });
    await vi.advanceTimersByTimeAsync(FLUSH);
    const title = 'Fixture speedrun night: any% practice';
    expect(contexts).toEqual([
      { site: 'twitch', partition: 'firstchannel', streamer: 'firstchannel', title },
    ]);
    // The title was there: nothing waits for it.
    expect(observe.mock.calls.map(([target]) => target)).not.toContain(
      doc.querySelector('#live-channel-stream-information'),
    );
    await annotate([{ id: 's1-1', category: 'chatter', state: 'done' }]);
    const first = twitch.messageElement(twitch.container(doc) ?? doc.body, 's1-1');
    expect(first?.getAttribute('data-ca-mode')).toBe('show');

    // The URL changes first; the stream information still shows the first channel.
    window.history.replaceState(null, '', '/secondchannel');
    navigation.dispatchEvent(new Event('navigatesuccess'));
    await vi.advanceTimersByTimeAsync(0);
    expect(contexts.at(-1)).toEqual({
      site: 'twitch',
      partition: 'secondchannel',
      streamer: 'secondchannel',
    });
    // The first channel's chat left the viewer: its comments still waiting are stored, not
    // processed after the viewer left (R49).
    expect(sent.at(-1)?.payload).toEqual({
      site: 'twitch',
      channel: 'firstchannel',
      streamer: 'firstchannel',
      title,
      process: false,
      left: true,
      comments: [],
    });
    // The new channel's filters are loaded at once, before any of its chat arrives.
    await annotate([{ id: 's1-1', category: 'chatter', state: 'done' }]);
    await vi.waitFor(() => expect(first?.getAttribute('data-ca-mode')).toBe('hide'));
    // Twitch renders the second channel's section: its title is reported once.
    info.setAttribute('href', '/secondchannel');
    heading.textContent = 'Fixture marathon: second channel';
    await vi.advanceTimersByTimeAsync(0);
    expect(contexts.at(-1)).toEqual({
      site: 'twitch',
      partition: 'secondchannel',
      streamer: 'secondchannel',
      title: 'Fixture marathon: second channel',
    });
    const reports = contexts.length;
    heading.textContent = 'Fixture marathon: second channel ';
    await vi.advanceTimersByTimeAsync(0);
    expect(contexts).toHaveLength(reports);

    // A new title shows up with the chat: it is reported once.
    heading.textContent = 'Fixture speedrun night: new route';
    const container = twitch.container(doc);
    const wrapper = container?.lastElementChild?.cloneNode(true);
    if (!(wrapper instanceof Element)) throw new Error('fixture changed');
    wrapper.querySelector('[data-ca-id]')?.removeAttribute('data-ca-id');
    container?.append(wrapper);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(contexts.at(-1)).toMatchObject({ title: 'Fixture speedrun night: new route' });
    expect(sent.at(-1)?.payload).toMatchObject({
      channel: 'secondchannel',
      streamer: 'secondchannel',
      title: 'Fixture speedrun night: new route',
    });
    const count = contexts.length;

    window.history.replaceState(null, '', '/directory/all');
    navigation.dispatchEvent(new Event('navigatesuccess'));
    await vi.advanceTimersByTimeAsync(0);
    expect(contexts.slice(count)).toEqual([{ site: 'twitch' }]);
    expect(sent.at(-1)?.payload).toMatchObject({ channel: 'secondchannel', left: true });
    stop();
    window.history.replaceState(null, '', '/thirdchannel');
    navigation.dispatchEvent(new Event('navigatesuccess'));
    await vi.advanceTimersByTimeAsync(0);
    expect(contexts).toHaveLength(count + 1);
  });

  it('tells the service worker which stream the top frame shows, and when it leaves it', async () => {
    vi.useFakeTimers();
    const { contexts, send } = stubWorker();
    const doc = load('/watch?v=fixture0001', 'youtube-comments');
    const navigate = async (to: string): Promise<void> => {
      window.history.replaceState(null, '', to);
      doc.dispatchEvent(new Event('yt-navigate-finish'));
      await vi.advanceTimersByTimeAsync(FLUSH);
    };
    const ping = async (): Promise<unknown> => {
      const answers: unknown[] = [];
      const replies = await fakeBrowser.runtime.onMessage.trigger(
        { type: 'comments/ping' },
        {},
        (answer) => answers.push(answer),
      );
      // The answer goes through sendResponse at once.
      expect(replies.every((reply) => reply === undefined)).toBe(true);
      return answers;
    };
    const stop = startPage(doc, [youtubeLiveChat, youtubeComments], { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(contexts.at(-1)).toMatchObject({ site: 'youtube', partition: 'fixture0001#comments' });
    // With what the page shows, so a restarted service worker learns the stream again.
    expect(await ping()).toEqual([
      {
        site: 'youtube',
        partition: 'fixture0001#comments',
        streamer: '@FixtureStreamer',
        title: 'Fixture Quest Part 3: the frozen bridge',
      },
    ]);
    await navigate('/');
    expect(contexts.at(-1)).toEqual({ site: 'youtube' });
    expect(await ping()).toEqual([{}]);
    // Not every navigation off a stream page is a new leave.
    const count = contexts.length;
    await navigate('/feed/subscriptions');
    expect(contexts).toHaveLength(count);
    stop();
    expect(await ping()).toEqual([]);
  });

  it('runs only on watch pages across YouTube navigation (home → watch → home), with one style', async () => {
    vi.useFakeTimers();
    const { sent, send } = stubWorker();
    const doc = load('/', 'youtube-comments');
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const navigate = async (to: string): Promise<void> => {
      window.history.replaceState(null, '', to);
      doc.dispatchEvent(new Event('yt-navigate-finish'));
      await vi.advanceTimersByTimeAsync(FLUSH);
    };
    const styles = (): number => doc.querySelectorAll('style').length;
    const stop = startPage(doc, [youtubeLiveChat, youtubeComments], { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    // Home: no observer, no style, nothing sent.
    expect(observe).not.toHaveBeenCalled();
    expect(styles()).toBe(0);
    expect(sent).toEqual([]);

    await navigate('/watch?v=fixture0001');
    expect(styles()).toBe(1);
    expect(sent.map(({ payload }) => [payload.channel, payload.comments.length])).toEqual([
      ['fixture0001#comments', 4],
    ]);
    await annotate([{ id: 'FixtureThread01', category: 'spam', state: 'done' }]);
    expect(caAttributes(doc)).toContain('data-ca-mode');

    // Another video: started again with the same single style.
    await navigate('/watch?v=fixture0002');
    expect(styles()).toBe(1);
    expect(sent.at(-1)?.payload.channel).toBe('fixture0002#comments');

    // Home again: everything stops and the display comes off.
    observe.mockClear();
    await navigate('/');
    expect(styles()).toBe(0);
    expect(caAttributes(doc)).toEqual([]);
    const count = sent.length;
    const contents = youtubeComments.container(doc);
    const thread = contents?.firstElementChild?.cloneNode(true);
    if (thread) contents?.append(thread);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(sent).toHaveLength(count);
    expect(observe).not.toHaveBeenCalled();

    stop();
    await navigate('/watch?v=fixture0001');
    expect(styles()).toBe(0);
    expect(sent).toHaveLength(count);
  });
});

describe('content script cost (R45)', () => {
  /** Hands annotations to the content script without waiting for them to be shown. */
  const deliver = async (payload: Annotation[]): Promise<void> => {
    const replies = await fakeBrowser.runtime.onMessage.trigger(
      { type: 'comments/annotations', payload },
      {},
      () => undefined,
    );
    expect(replies.every((reply) => reply === undefined)).toBe(true);
  };
  const mode = (id: string): string | null => line(id)?.getAttribute('data-ca-mode') ?? null;

  it('writes annotations as they arrive: waiting for the page saved no layout (R51)', async () => {
    vi.useFakeTimers();
    const { send } = stubWorker();
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    // Delivered and written in the same turn, with no timer and no change of the page.
    await deliver([{ id: 'fixture-live-03', category: 'spam', state: 'done' }]);
    expect(mode('fixture-live-03')).toBe('hide');
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it('looks up the chat list once when it attaches, not for each batch or annotation (Twitch)', async () => {
    vi.useFakeTimers();
    const { sent, send } = stubWorker();
    const doc = load('/firstchannel', 'twitch-chat');
    const twitch = createTwitchChat('s1');
    const container = vi.fn<typeof twitch.container>(twitch.container);
    const stop = startChat({ ...twitch, container }, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    const atStart = container.mock.calls.length;
    const list = twitch.container(doc);
    const wrapper = list?.lastElementChild;
    if (!list || !wrapper) throw new Error('fixture changed');
    for (let index = 0; index < 3; index += 1) {
      const copy = wrapper.cloneNode(true);
      if (!(copy instanceof Element)) throw new Error('fixture changed');
      copy.querySelector('[data-ca-id]')?.removeAttribute('data-ca-id');
      list.append(copy);
      await vi.advanceTimersByTimeAsync(FLUSH);
      await annotate([{ id: `s1-${6 + index}`, category: 'question', state: 'done' }]);
    }
    expect(sent.map(({ payload }) => payload.comments.length)).toEqual([5, 1, 1, 1]);
    expect(container).toHaveBeenCalledTimes(atStart);
    expect(twitch.messageElement(list, 's1-8')?.getAttribute('data-ca-mode')).toBe('highlight');
    stop();
  });

  it('decodes only the messages of its own types', async () => {
    vi.useFakeTimers();
    const { send } = stubWorker();
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startPage(doc, [youtubeLiveChat], { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    const decoders = [pingMessageSchema, annotationsMessageSchema, streamInfoMessageSchema].map(
      (schema) => vi.spyOn(schema, 'safeParse'),
    );
    // What other frames send the service worker, and what is no message at all.
    for (const message of [
      { type: 'comments/ingest', payload: { comments: [] } },
      { type: 'comments/context', payload: { site: 'youtube' } },
      'comments/ping',
      null,
    ]) {
      const replies = await fakeBrowser.runtime.onMessage.trigger(message, {}, () => undefined);
      expect(replies.every((reply) => reply === undefined)).toBe(true);
    }
    expect(decoders.map((decoder) => decoder.mock.calls.length)).toEqual([0, 0, 0]);
    const answers: unknown[] = [];
    const replies = await fakeBrowser.runtime.onMessage.trigger(
      { type: 'comments/ping' },
      {},
      (answer) => answers.push(answer),
    );
    expect(replies.every((reply) => reply === undefined)).toBe(true);
    expect(answers).toEqual([{ site: 'youtube', partition: 'fixture0001' }]);
    expect(decoders.map((decoder) => decoder.mock.calls.length)).toEqual([1, 0, 0]);
    stop();
  });
});

describe('a line comes into the chat once it is judged (R52)', () => {
  const WAIT = 'data-ca-wait';
  /** Posts a made-up line at the end of the live chat, as YouTube does. */
  function post(doc: Document, id: string, text = `fixture text ${id}`): HTMLElement {
    const copy = line('fixture-live-01')?.cloneNode(true);
    if (!(copy instanceof HTMLElement)) throw new Error('fixture changed');
    copy.id = id;
    const message = copy.querySelector('#message');
    if (message) message.textContent = text;
    youtubeLiveChat.container(doc)?.append(copy);
    return copy;
  }
  const waits = (id: string): boolean => line(id)?.hasAttribute(WAIT) ?? false;
  /**
   * The attribute changes of `element` in order, as `name` or `-name` for a removal: what the
   * page could paint between them.
   */
  function changesOf(element: Element): string[] {
    const changes: string[] = [];
    new MutationObserver((records) => {
      for (const record of records) {
        const name = record.attributeName ?? '';
        changes.push(element.hasAttribute(name) ? name : `-${name}`);
      }
    }).observe(element, { attributes: true });
    return changes;
  }
  /** A service worker answering each ingest with `reply` (by default what the stub does). */
  function worker(reply?: (ingest: Ingest) => unknown): {
    sent: Ingest[];
    send: (message: unknown) => Promise<unknown>;
  } {
    const stub = stubWorker();
    return {
      sent: stub.sent,
      send: async (message) => {
        const answer = await stub.send(message);
        const last = stub.sent.at(-1);
        return reply && last && messageType(message) === 'comments/ingest' ? reply(last) : answer;
      },
    };
  }

  it('keeps a new line out of sight until its annotation is written: one to remove never shows', async () => {
    vi.useFakeTimers();
    const { sent, send } = worker();
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    // Lines already on screen when the chat starts are shown as they are: none is held, so none
    // is marked and the service worker answers them newest first, as for any chat (R44, R57).
    expect(doc.querySelectorAll(`[${WAIT}]`)).toHaveLength(0);
    expect(sent.at(-1)?.payload.comments).toHaveLength(6);
    expect(sent.at(-1)?.payload.comments.filter((c) => 'held' in c)).toEqual([]);
    const added = post(doc, 'new-01', 'a rude made-up line');
    const changes = changesOf(added);
    // Hidden as the page adds it, before it is read and sent.
    await vi.advanceTimersByTimeAsync(0);
    expect(waits('new-01')).toBe(true);
    await vi.advanceTimersByTimeAsync(FLUSH);
    // Marked held: the service worker answers it among the first while it can still be judged
    // before it comes in (R57).
    expect(sent.at(-1)?.payload.comments.map(({ id, held }) => [id, held])).toEqual([
      ['new-01', true],
    ]);
    expect(waits('new-01')).toBe(true);
    await annotate([{ id: 'new-01', category: 'abusive', state: 'done' }]);
    expect(waits('new-01')).toBe(false);
    // Abusive comments are removed by default (消す, R54): the line was already removed when it
    // came in, in the same turn, so it never showed.
    expect(added.getAttribute('data-ca-conceal')).toBe('hide');
    expect(changes.indexOf('data-ca-conceal')).toBeGreaterThanOrEqual(0);
    expect(changes.indexOf('data-ca-conceal')).toBeLessThan(changes.indexOf(`-${WAIT}`));
    // A spoiler comes in already concealed as a bar.
    const spoiler = post(doc, 'new-02', 'a made-up spoiler');
    const spoilerChanges = changesOf(spoiler);
    await vi.advanceTimersByTimeAsync(FLUSH);
    await annotate([{ id: 'new-02', category: 'spoiler', state: 'done' }]);
    expect(spoiler.getAttribute('data-ca-conceal')).toBe('blur');
    expect(spoilerChanges.indexOf('data-ca-conceal')).toBeLessThan(
      spoilerChanges.indexOf(`-${WAIT}`),
    );
    stop();
  });

  it('keeps a later line out while an earlier one waits, and lets both in together', async () => {
    vi.useFakeTimers();
    const { send } = worker();
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    post(doc, 'new-01');
    post(doc, 'new-02');
    await vi.advanceTimersByTimeAsync(FLUSH);
    await annotate([{ id: 'new-02', category: 'chatter', state: 'done' }]);
    expect([waits('new-01'), waits('new-02')]).toEqual([true, true]);
    expect(line('new-02')?.getAttribute('data-ca-mode')).toBe('show');
    await annotate([{ id: 'new-01', category: 'question', state: 'done' }]);
    expect([waits('new-01'), waits('new-02')]).toEqual([false, false]);
    stop();
  });

  it('lets a line in as the original after 2 s, and writes its annotation when it comes', async () => {
    vi.useFakeTimers();
    const { send } = worker();
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    post(doc, 'new-01', 'a made-up line in English');
    await vi.advanceTimersByTimeAsync(1999);
    expect(waits('new-01')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(waits('new-01')).toBe(false);
    expect(line('new-01')?.hasAttribute('data-ca-mode')).toBe(false);
    await annotate([
      { id: 'new-01', category: 'chatter', state: 'done', translation: '英語の作り話の行' },
    ]);
    expect(line('new-01')?.querySelector('#message')?.textContent).toBe('英語の作り話の行');
    stop();
  });

  it('lets a line answered by rule in at once, and a line holding no comment at its read', async () => {
    vi.useFakeTimers();
    // The service worker answers a stock reaction in the same turn as the ingest (fast path).
    const { send } = worker(async (ingest) => {
      const rule = ingest.payload.comments.filter(({ text }) => text === 'lol');
      if (rule.length > 0)
        await annotate(rule.map(({ id }) => ({ id, category: 'chatter', state: 'done' })));
      return Ok({ accepted: ingest.payload.comments.length, dropped: 0 });
    });
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    post(doc, 'new-01', 'lol');
    const notice = doc.createElement('yt-live-chat-viewer-engagement-message-renderer');
    notice.id = 'new-notice';
    youtubeLiveChat.container(doc)?.append(notice);
    await vi.advanceTimersByTimeAsync(0);
    expect([waits('new-01'), waits('new-notice')]).toEqual([true, true]);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect([waits('new-01'), waits('new-notice')]).toEqual([false, false]);
    expect(line('new-01')?.getAttribute('data-ca-mode')).toBe('show');
    stop();
  });

  it('does not wait when the viewer turned it off, and lets the waiting lines in then', async () => {
    vi.useFakeTimers();
    const { sent, send } = worker();
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    post(doc, 'new-01');
    await vi.advanceTimersByTimeAsync(0);
    expect(waits('new-01')).toBe(true);
    await fakeBrowser.storage.local.set({
      [filterKey('youtube', 'fixture0001')]: { ...defaultFilterSettings, holdUntilJudged: false },
    });
    expect(waits('new-01')).toBe(false);
    post(doc, 'new-02');
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(waits('new-02')).toBe(false);
    // Lines shown as posted are not marked: the newest are answered first, as before.
    expect(sent.at(-1)?.payload.comments.map(({ id, held }) => [id, held])).toEqual([
      ['new-01', undefined],
      ['new-02', undefined],
    ]);
    stop();
  });

  it('does not wait while llama.cpp is unreachable or the ingest fails, and waits again after', async () => {
    vi.useFakeTimers();
    const ok = (ingest: Ingest): unknown =>
      Ok({ accepted: ingest.payload.comments.length, dropped: 0 });
    let answer = ok;
    const { send } = worker((ingest) => answer(ingest));
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    // The latest batch failed to reach llama.cpp (stats `lastError`): the line waiting comes in
    // as soon as the reply tells, and the next ones do not wait.
    answer = (ingest) =>
      Ok({ accepted: ingest.payload.comments.length, dropped: 0, lastError: 'network_failed' });
    post(doc, 'new-01');
    await vi.advanceTimersByTimeAsync(0);
    expect(waits('new-01')).toBe(true);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(waits('new-01')).toBe(false);
    post(doc, 'new-02');
    await vi.advanceTimersByTimeAsync(0);
    expect(waits('new-02')).toBe(false);
    // The server answers again: lines wait from the next reply on.
    answer = ok;
    await vi.advanceTimersByTimeAsync(FLUSH);
    post(doc, 'new-03');
    await vi.advanceTimersByTimeAsync(0);
    expect(waits('new-03')).toBe(true);
    // The ingest route fails (the service worker cannot take comments): no line waits.
    answer = () => Err(failure('ipc_failed'));
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(waits('new-03')).toBe(false);
    post(doc, 'new-04');
    await vi.advanceTimersByTimeAsync(0);
    expect(waits('new-04')).toBe(false);
    stop();
  });

  it('keeps holding when one batch fails without an outage (response_invalid)', async () => {
    vi.useFakeTimers();
    const { send } = worker((ingest) =>
      Ok({ accepted: ingest.payload.comments.length, dropped: 0, lastError: 'response_invalid' }),
    );
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    // The model answered one batch badly; llama.cpp is there: lines still wait for answers.
    post(doc, 'new-01');
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(waits('new-01')).toBe(true);
    post(doc, 'new-02');
    await vi.advanceTimersByTimeAsync(0);
    expect(waits('new-02')).toBe(true);
    stop();
  });

  it('removes a line judged 消す that was on screen when the chat started, without holding it (R44)', async () => {
    vi.useFakeTimers();
    const { sent, send } = worker();
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    // The look sent the lines on screen; they were never held.
    expect(sent.at(-1)?.payload.comments.map(({ id }) => id)).toContain('fixture-live-03');
    expect(waits('fixture-live-03')).toBe(false);
    await annotate([{ id: 'fixture-live-03', category: 'spam', state: 'done' }]);
    // Removed from the chat by default: the whole line, no label in its place (R54).
    expect(line('fixture-live-03')?.getAttribute('data-ca-conceal')).toBe('hide');
    expect(waits('fixture-live-03')).toBe(false);
    stop();
  });

  it('lets the waiting lines in when the chat leaves the viewer, and none waits after stop', async () => {
    vi.useFakeTimers();
    const { send } = worker();
    const doc = load('/live_chat?is_popout=1&v=fixture0001');
    const stop = startChat(youtubeLiveChat, doc, { send });
    await vi.advanceTimersByTimeAsync(FLUSH);
    post(doc, 'new-01');
    await vi.advanceTimersByTimeAsync(0);
    setVisibility(doc, 'hidden');
    expect(waits('new-01')).toBe(false);
    // Lines added while the chat is not in front are only stored: they never wait.
    post(doc, 'new-02');
    await vi.advanceTimersByTimeAsync(0);
    expect(waits('new-02')).toBe(false);
    setVisibility(doc, 'visible');
    await vi.advanceTimersByTimeAsync(FLUSH);
    post(doc, 'new-03');
    await vi.advanceTimersByTimeAsync(0);
    expect(waits('new-03')).toBe(true);
    stop();
    expect(caAttributes(doc)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
