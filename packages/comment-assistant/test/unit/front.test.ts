// @vitest-environment jsdom
// The page reader, the chat session and the pipeline together (R44, R49): only a chat leaving the
// viewer stores comments still waiting for the model, and only those no other frame shows.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { z } from 'zod/mini';
import { Ok } from '@chrome-toolbox/contracts';
import {
  COMMENT_CATEGORY_CODES,
  createLanguageDetector,
  createLlamaClient,
  createQueue,
  llmCategoryJudge,
  type Fetch,
} from '@chrome-toolbox/extension-core';
import { startChat } from '../../src/chat.ts';
import { createCommentPipeline, type CommentPipeline, type Target } from '../../src/pipeline.ts';
import { commentProtocolSpec, type Annotation } from '../../src/protocol.ts';
import { youtubeComments } from '../../src/sites/youtube-comments.ts';
import { youtubeLiveChat } from '../../src/sites/youtube-live-chat.ts';
import {
  installIntersection,
  restorePage,
  setVisibility,
  type FakeIntersection,
} from './intersection.ts';

const FLUSH = 600;
const STORE_FLUSH = 1100;
const CHANNEL = 'fixture0001';
/** The fixture's lines (the fourth has no text: answered at once) and four more of ours. */
const FIXTURE_IDS = [1, 2, 3, 4, 5, 6].map((n) => `fixture-live-0${n}`);
const EXTRA_IDS = ['x1', 'x2', 'x3', 'x4'];
const LINE_IDS = [...FIXTURE_IDS, ...EXTRA_IDS];
const html = readFileSync(
  path.join(import.meta.dirname, '../fixtures/youtube-live-chat.html'),
  'utf8',
);
/** The fixture chat with our four lines appended: nine need the model. */
function chatOf(doc: Document): Document {
  for (const id of EXTRA_IDS)
    doc.querySelector('#items')?.append(line(doc, id, `made-up line ${id} for the test`));
  return doc;
}
/** The live chat popout of `CHANNEL` in the test document. */
function loadChat(): Document {
  window.history.replaceState(null, '', `/live_chat?is_popout=1&v=${CHANNEL}`);
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.replaceChild(
    document.importNode(parsed.documentElement, true),
    document.documentElement,
  );
  return chatOf(document);
}
const commentsHtml = readFileSync(
  path.join(import.meta.dirname, '../fixtures/youtube-comments.html'),
  'utf8',
);
const ingestSchema = z.strictObject({
  type: z.literal('comments/ingest'),
  payload: commentProtocolSpec['comments/ingest'].request,
});

/**
 * llama.cpp at the HTTP boundary: holds every chat request until `open`, then answers each
 * comment as translated chatter.
 */
function heldServer() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const fetch: Fetch = async (_input, init) => {
    await opened;
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      messages: { content: string }[];
    };
    const lines = (body.messages[1]?.content ?? '')
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { id: number; translate: boolean; text: string });
    const content = lines
      .map(
        (line) =>
          `${line.id}\t${COMMENT_CATEGORY_CODES.chatter}${line.translate ? `\t訳:${line.text}` : ''}\n`,
      )
      .join('');
    return Response.json({ choices: [{ message: { content } }] });
  };
  return { fetch, open: () => open() };
}

/**
 * A service worker with the real pipeline: content frames' ingest messages go to it with their
 * frame, and its annotations come back as the runtime message every chat session listens to.
 */
function serviceWorker(fetch: Fetch): {
  pipeline: CommentPipeline;
  frame: (target: Target) => (message: unknown) => Promise<unknown>;
} {
  const pipeline = createCommentPipeline({
    client: createLlamaClient({
      baseUrl: 'http://127.0.0.1:18083',
      fetch,
      queue: createQueue({ concurrency: 4, maxPending: 16 }),
    }),
    model: 'gemma4-e4b',
    judge: llmCategoryJudge,
    detector: createLanguageDetector(undefined),
    context: (site, partition) => ({ site, partition }),
    emit: (_target: Target, annotations: Annotation[]) => {
      // The service worker sends annotations fire-and-forget.
      fakeBrowser.runtime.onMessage
        .trigger({ type: 'comments/annotations', payload: annotations }, {}, () => undefined)
        .catch(() => undefined);
    },
    now: () => Date.now(),
    staleAfterMs: 60_000,
  });
  return {
    pipeline,
    frame: (target) => async (message) => {
      const ingest = ingestSchema.safeParse(message);
      return Ok(ingest.success ? pipeline.ingest(target, ingest.data.payload) : {});
    },
  };
}
const statesOf = (pipeline: CommentPipeline, channel = CHANNEL): Record<string, string> =>
  Object.fromEntries(
    pipeline
      .store('youtube', channel)
      .since(3_600_000)
      .map((record) => [record.id, record.state]),
  );
const modesOf = (doc: Document, ids: readonly string[]): (string | null)[] =>
  ids.map((id) => doc.getElementById(id)?.getAttribute('data-ca-mode') ?? null);
/** A chat line as YouTube adds it. */
const line = (doc: Document, id: string, text: string): Element => {
  const element = doc.createElement('yt-live-chat-text-message-renderer');
  element.id = id;
  const author = doc.createElement('span');
  author.id = 'author-name';
  author.textContent = '@sample-viewer';
  const body = doc.createElement('span');
  body.id = 'message';
  body.textContent = text;
  element.append(author, body);
  return element;
};

let io: FakeIntersection;
beforeEach(() => {
  io = installIntersection();
});
afterEach(() => {
  fakeBrowser.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  restorePage();
});

describe('only a chat leaving the viewer stores waiting comments (R49)', () => {
  it('processes every line on screen of a chat that starts in front, storing only those above it', async () => {
    vi.useFakeTimers();
    const server = heldServer();
    const { pipeline, frame } = serviceWorker(server.fetch);
    const doc = loadChat();
    // The first two lines are scrolled above the visible part of the list.
    io.setOnScreen((element) => !FIXTURE_IDS.slice(0, 2).includes(element.id));
    const stop = startChat(youtubeLiveChat, doc, { send: frame({ tabId: 1, frameId: 0 }) });
    await vi.advanceTimersByTimeAsync(STORE_FLUSH);
    // The model holds the newest three; four more lines on screen wait for it.
    expect(statesOf(pipeline)).toEqual({
      'fixture-live-01': 'stored',
      'fixture-live-02': 'stored',
      'fixture-live-04': 'skipped',
    });
    expect(pipeline.stats('youtube', CHANNEL)).toMatchObject({ pending: 7, stored: 2 });
    server.open();
    await vi.waitFor(() => expect(modesOf(doc, LINE_IDS.slice(2))).toEqual(Array(8).fill('show')));
    expect(modesOf(doc, FIXTURE_IDS.slice(0, 2))).toEqual([null, null]);
    expect(pipeline.stats('youtube', CHANNEL)).toMatchObject({ pending: 0, stored: 2 });
    stop();
  });

  it('keeps the waiting comments of a chat in front when its list is replaced (Top chat ↔ Live chat)', async () => {
    vi.useFakeTimers();
    const server = heldServer();
    const { pipeline, frame } = serviceWorker(server.fetch);
    const doc = loadChat();
    const stop = startChat(youtubeLiveChat, doc, { send: frame({ tabId: 1, frameId: 0 }) });
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(pipeline.stats('youtube', CHANNEL).pending).toBe(9);

    // The new list holds the same lines, one older line above the screen and a new one.
    const list = doc.querySelector('yt-live-chat-item-list-renderer');
    const copy = list?.cloneNode(true);
    if (!list || !(copy instanceof Element)) throw new Error('fixture changed');
    const items = copy.querySelector('#items');
    items?.prepend(line(doc, 'older', 'an older line above the screen'));
    items?.append(line(doc, 'newer', 'a new line'));
    io.setOnScreen((element) => element.id !== 'older');
    list.replaceWith(copy);
    // The new list is found within 100 ms; its lines above the screen are stored a second later.
    await vi.advanceTimersByTimeAsync(STORE_FLUSH + 200);
    expect(statesOf(pipeline)).toEqual({ 'fixture-live-04': 'skipped', older: 'stored' });
    expect(pipeline.stats('youtube', CHANNEL)).toMatchObject({ pending: 10, stored: 1 });
    server.open();
    await vi.waitFor(() => expect(pipeline.stats('youtube', CHANNEL).pending).toBe(0));
    expect(modesOf(doc, [...LINE_IDS, 'newer'])).toEqual(Array(11).fill('show'));
    expect(modesOf(doc, ['older'])).toEqual([null]);
    stop();
  });

  it('does not store the waiting comments of a chat in front when another frame of the stream is hidden', async () => {
    vi.useFakeTimers();
    const server = heldServer();
    const { pipeline, frame } = serviceWorker(server.fetch);
    const front = loadChat();
    const stopFront = startChat(youtubeLiveChat, front, { send: frame({ tabId: 1, frameId: 0 }) });
    await vi.advanceTimersByTimeAsync(FLUSH);
    // The same stream in a popout of another tab, with one line the first frame has not shown.
    const popout = chatOf(new DOMParser().parseFromString(html, 'text/html'));
    popout.querySelector('#items')?.append(line(popout, 'popout-only', 'only in the popout'));
    setVisibility(popout, 'visible');
    const stopPopout = startChat({ ...youtubeLiveChat, channel: () => CHANNEL }, popout, {
      send: frame({ tabId: 2, frameId: 0 }),
    });
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(pipeline.stats('youtube', CHANNEL).pending).toBe(10);

    // The popout's tab goes to the background: only its own waiting line is stored.
    setVisibility(popout, 'hidden');
    await vi.advanceTimersByTimeAsync(STORE_FLUSH);
    expect(statesOf(pipeline)).toEqual({ 'fixture-live-04': 'skipped', 'popout-only': 'stored' });
    server.open();
    await vi.waitFor(() => expect(pipeline.stats('youtube', CHANNEL).pending).toBe(0));
    expect(modesOf(front, LINE_IDS)).toEqual(Array(10).fill('show'));
    expect(pipeline.stats('youtube', CHANNEL).stored).toBe(1);
    stopPopout();
    stopFront();
  });

  it('processes again the lines on screen that were stored during a short switch to another tab', async () => {
    vi.useFakeTimers();
    const server = heldServer();
    const { pipeline, frame } = serviceWorker(server.fetch);
    const doc = loadChat();
    const stop = startChat(youtubeLiveChat, doc, { send: frame({ tabId: 1, frameId: 0 }) });
    await vi.advanceTimersByTimeAsync(FLUSH);
    // The newest three are with the model; six wait when the viewer switches tabs for 10 ms.
    setVisibility(doc, 'hidden');
    await vi.advanceTimersByTimeAsync(10);
    expect(pipeline.stats('youtube', CHANNEL)).toMatchObject({ pending: 3, stored: 6 });
    setVisibility(doc, 'visible');
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(pipeline.stats('youtube', CHANNEL).pending).toBe(9);
    server.open();
    await vi.waitFor(() => expect(modesOf(doc, LINE_IDS)).toEqual(Array(10).fill('show')));
    const states = statesOf(pipeline);
    expect(LINE_IDS.map((id) => states[id])).toEqual(
      LINE_IDS.map((id) => (id === 'fixture-live-04' ? 'skipped' : 'done')),
    );
    stop();
  });
  it('counts as stored only what is still stored after three short switches to another tab (R50)', async () => {
    vi.useFakeTimers();
    const server = heldServer();
    const { pipeline, frame } = serviceWorker(server.fetch);
    const doc = loadChat();
    const stop = startChat(youtubeLiveChat, doc, { send: frame({ tabId: 1, frameId: 0 }) });
    await vi.advanceTimersByTimeAsync(FLUSH);
    const storedRecords = (): number =>
      Object.values(statesOf(pipeline)).filter((state) => state === 'stored').length;
    for (let round = 0; round < 3; round += 1) {
      setVisibility(doc, 'hidden');
      await vi.advanceTimersByTimeAsync(10);
      expect([pipeline.stats('youtube', CHANNEL).stored, storedRecords()]).toEqual([6, 6]);
      setVisibility(doc, 'visible');
      await vi.advanceTimersByTimeAsync(FLUSH);
      expect([pipeline.stats('youtube', CHANNEL).stored, storedRecords()]).toEqual([0, 0]);
    }
    server.open();
    await vi.waitFor(() => expect(modesOf(doc, LINE_IDS)).toEqual(Array(10).fill('show')));
    expect([pipeline.stats('youtube', CHANNEL).stored, storedRecords()]).toEqual([0, 0]);
    stop();
  });

  it('answers after the return a video comment that was waiting for the model when the page was hidden (R50)', async () => {
    vi.useFakeTimers();
    const server = heldServer();
    const { pipeline, frame } = serviceWorker(server.fetch);
    window.history.replaceState(null, '', `/watch?v=${CHANNEL}`);
    const parsed = new DOMParser().parseFromString(commentsHtml, 'text/html');
    document.replaceChild(
      document.importNode(parsed.documentElement, true),
      document.documentElement,
    );
    // Every thread is within a viewport height of the screen.
    io.setOnScreen((_element, rootMargin) => rootMargin === '100% 0px');
    const stop = startChat(youtubeComments, document, { send: frame({ tabId: 1, frameId: 0 }) });
    await vi.advanceTimersByTimeAsync(FLUSH);
    const channel = `${CHANNEL}#comments`;
    // Three threads are with the model, the fourth waits for it.
    expect(pipeline.stats('youtube', channel).pending).toBe(4);
    setVisibility(document, 'hidden');
    await vi.advanceTimersByTimeAsync(10);
    setVisibility(document, 'visible');
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(pipeline.stats('youtube', channel)).toMatchObject({ pending: 4, stored: 0 });
    server.open();
    await vi.waitFor(() => expect(pipeline.stats('youtube', channel).pending).toBe(0));
    expect(Object.values(statesOf(pipeline, channel))).toEqual(Array(4).fill('done'));
    const threads = [...document.querySelectorAll('ytd-comment-thread-renderer')];
    expect(threads.map((thread) => thread.getAttribute('data-ca-mode'))).toEqual(
      Array(4).fill('show'),
    );
    stop();
  });
});
