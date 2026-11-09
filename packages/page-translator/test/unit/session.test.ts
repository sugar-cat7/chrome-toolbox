// @vitest-environment jsdom
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContentScriptContext } from 'wxt/utils/content-script-context';
import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import { systemTimers, type Timers } from '@chrome-toolbox/extension-core';
import { extensionGone, runInjection } from '../../src/content/claim.ts';
import { OVERLAY_TAG, OVERLAY_TIMING } from '../../src/content/overlay.ts';
import { startSession, type ProgressPort, type SessionApi } from '../../src/content/session.ts';
import {
  MAX_SELECTION,
  progressSchema,
  translateRequestSchema,
  type PageCommand,
  type Progress,
  type TranslateReply,
  type TranslateRequest,
} from '../../src/protocol.ts';
import { defaultPageSettings, type PageSettings } from '../../src/settings.ts';
import { fingerprint } from './fingerprint.ts';
import {
  installIntersection,
  restorePage,
  setVisibility,
  type FakeIntersection,
} from './intersection.ts';

/** What the fake server puts before each text it translates. */
const TRANSLATED = '訳:';
/** The bubble's note under a translation of a selection that was cut. */
const CUT_NOTE = '（先頭の 2,000 文字だけを訳しました）';
/** The popup's progress comes at most this often. */
const PROGRESS_MS = 250;
/** jsdom's location (vitest.config.ts): a made-up wiki. */
const SITE = 'https://wiki.fixture.test/*';
const HOST = 'wiki.fixture.test';

let io: FakeIntersection;
let stop: (() => void) | undefined;
/** WXT contexts a test made: each listens on the document for the copy after it. */
const contexts: ContentScriptContext[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  io = installIntersection();
  document.title = 'Made-up Guide';
  // jsdom has no layout: a selection's box is made up here.
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(100, 120, 80, 20),
  });
});

afterEach(() => {
  stop?.();
  stop = undefined;
  for (const ctx of contexts.splice(0)) ctx.abort();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restorePage();
  Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

/** `value`, failing the test when it is missing. */
function must<T>(value: T | null | undefined): T {
  assert.exists(value);
  return value;
}

/** Lets the session go on: scans, the observer's reports, requests and their answers. */
async function settle(ms = 100): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

const textsOf = (request: TranslateRequest): string[] =>
  request.units.flatMap((unit) =>
    unit.tokens.flatMap((token) => (token.t === 'text' ? [token.text] : [])),
  );
/** A working server's answer: every text token as `訳:<text>`. */
const replyTo = (request: TranslateRequest): Result<TranslateReply> =>
  Ok({
    results: request.units.map((unit) => ({
      id: unit.id,
      pieces: unit.tokens.flatMap((token) =>
        token.t === 'text' ? [`${TRANSLATED}${token.text}`] : [],
      ),
    })),
    translator: 'gemma',
  });

type Events<L> = Readonly<{
  listeners: Set<L>;
  api: { addListener(listener: L): void; removeListener(listener: L): void };
}>;
function events<L>(): Events<L> {
  const listeners = new Set<L>();
  return {
    listeners,
    api: {
      addListener: (listener) => void listeners.add(listener),
      removeListener: (listener) => void listeners.delete(listener),
    },
  };
}

type MessageListener = Parameters<SessionApi['runtime']['onMessage']['addListener']>[0];
type ConnectListener = Parameters<SessionApi['runtime']['onConnect']['addListener']>[0];
type ChangeListener = Parameters<SessionApi['storage']['local']['onChanged']['addListener']>[0];

type FakePort = ProgressPort & {
  posted: Progress[];
  /** The popup closed: the port's other end is gone. */
  close(): void;
  disconnected: boolean;
};

type Fake = {
  api: SessionApi;
  /** Every message the page script sent, in order. */
  sent: { type: string; payload: unknown }[];
  /** `page/translate` requests, in order. */
  requests(): TranslateRequest[];
  /** The page requests the server holds until `release`. */
  held: (() => void)[];
  /** Whether the server holds page requests (not selection ones) until `release`. */
  hold: boolean;
  /** The server's answer to a translation request. */
  reply: (request: TranslateRequest) => Result<TranslateReply>;
  messages: Events<MessageListener>;
  connects: Events<ConnectListener>;
  changes: Events<ChangeListener>;
  /** Sends the page script a command; returns its answer. */
  command(payload: PageCommand): unknown;
  /** Opens the popup's progress port. */
  connect(name?: string): FakePort;
  /** Stores new page settings (the popup or the options page saved them). */
  save(settings: PageSettings): void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The extension APIs the page script uses, with a server that translates at once. */
function fakeApi(page?: PageSettings): Fake {
  const messages = events<MessageListener>();
  const connects = events<ConnectListener>();
  const changes = events<ChangeListener>();
  const stored: Record<string, unknown> = page === undefined ? {} : { page };
  const fake: Fake = {
    api: {
      runtime: {
        sendMessage: (message) => {
          assert(isRecord(message) && typeof message['type'] === 'string');
          const { type, payload } = message;
          fake.sent.push({ type, payload });
          if (type !== 'page/translate') return Promise.resolve(Ok({}));
          const request = translateRequestSchema.parse(payload);
          if (fake.hold && request.purpose === 'page')
            return new Promise((resolve) => {
              fake.held.push(() => resolve(fake.reply(request)));
            });
          return Promise.resolve(fake.reply(request));
        },
        onMessage: messages.api,
        onConnect: connects.api,
      },
      storage: {
        local: {
          get: (key) => Promise.resolve(stored[key] === undefined ? {} : { [key]: stored[key] }),
          onChanged: changes.api,
        },
      },
    },
    sent: [],
    requests: () =>
      fake.sent.flatMap(({ type, payload }) =>
        type === 'page/translate' ? [translateRequestSchema.parse(payload)] : [],
      ),
    held: [],
    hold: false,
    reply: replyTo,
    messages,
    connects,
    changes,
    command(payload) {
      let answer: unknown;
      for (const listener of [...messages.listeners])
        listener({ type: 'page/command', payload }, {}, (response) => {
          answer = response;
        });
      return answer;
    },
    connect(name = 'page-progress') {
      const gone = new Set<() => void>();
      const port: FakePort = {
        name,
        posted: [],
        disconnected: false,
        postMessage: (message) => port.posted.push(progressSchema.parse(message)),
        disconnect: () => {
          port.disconnected = true;
        },
        onDisconnect: {
          addListener: (listener) => void gone.add(listener),
          removeListener: (listener) => void gone.delete(listener),
        },
        close: () => {
          for (const listener of [...gone]) listener();
        },
      };
      for (const listener of [...connects.listeners]) listener(port);
      return port;
    },
    save(settings) {
      const oldValue = stored['page'];
      stored['page'] = settings;
      for (const listener of [...changes.listeners])
        listener({ page: { oldValue, newValue: settings } });
    },
  };
  return fake;
}

function start(fake: Fake, timers?: Timers): void {
  stop = startSession(document, fake.api, timers === undefined ? {} : { timers });
}

/** Timers that know which of theirs are still waiting. */
function countingTimers(): { timers: Timers; waiting: () => number } {
  const live = new Set<number>();
  return {
    timers: {
      set: (fn, ms) => {
        const id = systemTimers.set(() => {
          live.delete(id);
          fn();
        }, ms);
        live.add(id);
        return id;
      },
      clear: (id) => {
        live.delete(id);
        systemTimers.clear(id);
      },
    },
    waiting: () => live.size,
  };
}

/** The event listeners `target` holds now that were added through it since this call. */
function trackListeners(target: EventTarget): () => string[] {
  const live = new Map<string, string>();
  const ids = new Map<unknown, number>();
  const keyOf = (
    type: string,
    listener: unknown,
    options: boolean | EventListenerOptions | undefined,
  ): string => {
    const capture = typeof options === 'boolean' ? options : (options?.capture ?? false);
    if (!ids.has(listener)) ids.set(listener, ids.size);
    return `${type} ${capture} ${String(ids.get(listener))}`;
  };
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
    live.set(keyOf(type, listener, options), type);
    add(type, listener, options);
  });
  vi.spyOn(target, 'removeEventListener').mockImplementation((type, listener, options) => {
    live.delete(keyOf(type, listener, options));
    remove(type, listener, options);
  });
  return () => [...live.values()].toSorted();
}

const overlayHost = (): Element | undefined =>
  [...document.documentElement.children].find((child) => child.localName === OVERLAY_TAG);
const tooltipText = (): string | null | undefined =>
  overlayHost()?.shadowRoot?.querySelector('[role="tooltip"]')?.textContent;
const bubbleText = (): string | null | undefined =>
  overlayHost()?.shadowRoot?.querySelector('[role="dialog"]')?.textContent;

/** A short page of made-up text. */
function article(): HTMLElement[] {
  document.body.innerHTML = `
    <h1 id="title">Made-up Guide</h1>
    <p id="run">Click here to run().</p>
    <p id="roll">Roll backward to dodge the light attack.</p>
    <button type="button" id="post">Post the comment</button>`;
  return ['title', 'run', 'roll', 'post'].map((id) => must(document.getElementById(id)));
}
const lines = (elements: readonly Element[]): (string | null)[] =>
  elements.map((element) => element.textContent);

function hover(element: Element): void {
  element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
}

function select(text: string): void {
  const chosen = document.createElement('p');
  chosen.id = 'chosen';
  chosen.textContent = text;
  document.body.append(chosen);
  const selection = must(document.getSelection());
  if (text === '') selection.removeAllRanges();
  else selection.selectAllChildren(chosen);
}

const always = (extra: Partial<PageSettings> = {}): PageSettings => ({
  ...defaultPageSettings,
  always: [SITE],
  ...extra,
});

describe('startSession', () => {
  it('answers ping and every command at once', async () => {
    const fake = fakeApi();
    start(fake);
    expect(fake.command({ action: 'ping' })).toEqual({ ready: true });
    expect(fake.command({ action: 'restore' })).toEqual({});
    await settle();
    expect(fake.requests()).toEqual([]);
  });

  it('starts on an always site and not on an excluded one', async () => {
    const elements = article();
    const translating = fakeApi(always());
    start(translating);
    await settle();
    // Four short paragraphs: one batch.
    expect(pageRequests(translating).map(textsOf)).toEqual([
      [
        'Made-up Guide',
        'Click here to run().',
        'Roll backward to dodge the light attack.',
        'Post the comment',
      ],
    ]);
    expect(lines(elements)).toEqual([
      `${TRANSLATED}Made-up Guide`,
      `${TRANSLATED}Click here to run().`,
      `${TRANSLATED}Roll backward to dodge the light attack.`,
      `${TRANSLATED}Post the comment`,
    ]);
    stop?.();
    const original = article();
    const excluded = fakeApi(always({ never: [HOST] }));
    start(excluded);
    await settle();
    expect(excluded.requests()).toEqual([]);
    expect(lines(original)).toEqual([
      'Made-up Guide',
      'Click here to run().',
      'Roll backward to dodge the light attack.',
      'Post the comment',
    ]);
  });

  it('restores and stops on the restore command', async () => {
    const elements = article();
    const before = fingerprint(document.documentElement);
    const fake = fakeApi();
    start(fake);
    fake.command({ action: 'translate' });
    await settle();
    expect(lines(elements)[1]).toBe(`${TRANSLATED}Click here to run().`);
    const port = fake.connect();
    expect(port.posted.at(-1)?.state).toBe('on');
    fake.command({ action: 'restore' });
    await settle(PROGRESS_MS * 2);
    expect(fingerprint(document.documentElement)).toBe(before);
    expect(port.posted.map((progress) => progress.state)).toContain('restoring');
    expect(port.posted.at(-1)?.state).toBe('restored');
    // Stopped: the page's later paragraphs stay as they are, and nothing is asked.
    const asked = fake.requests().length;
    document.body.append(Object.assign(document.createElement('p'), { textContent: 'New text.' }));
    await settle(1_000);
    expect(fake.requests()).toHaveLength(asked);
    expect(io.observers.every((observer) => observer.targets().length === 0)).toBe(true);
  });

  it('waits for the restore to end before it translates again (P27)', async () => {
    // More text nodes than one restore slice (500) takes.
    document.body.innerHTML = Array.from(
      { length: 600 },
      (_, n) => `<p>Paragraph ${n} of the made-up guide.</p>`,
    ).join('');
    const before = fingerprint(document.documentElement);
    const fake = fakeApi();
    start(fake);
    fake.command({ action: 'translate' });
    await settle(2_000);
    expect(document.body.firstElementChild?.textContent).toBe(
      `${TRANSLATED}Paragraph 0 of the made-up guide.`,
    );
    const port = fake.connect();
    fake.command({ action: 'restore' });
    const asked = fake.requests().length;
    // A scheduler that starts makes its IntersectionObserver at once.
    const observers = io.observers.length;
    fake.command({ action: 'translate' });
    expect(port.posted.at(-1)?.state).toBe('restoring');
    expect(io.observers).toHaveLength(observers);
    expect(fake.requests()).toHaveLength(asked);
    // Only the first slice ran: the translate waits for the rest.
    expect(fingerprint(document.documentElement)).not.toBe(before);
    let whenAsked: string | undefined;
    fake.reply = (request) => {
      whenAsked ??= fingerprint(document.documentElement);
      return replyTo(request);
    };
    // The next slice ends the restore, and the scheduler starts.
    await vi.advanceTimersByTimeAsync(1);
    expect(io.observers).toHaveLength(observers + 1);
    await settle(2_000);
    expect(fake.requests().length).toBeGreaterThan(asked);
    // The first request after the restore read the whole original page.
    expect(whenAsked).toBe(before);
    expect(document.body.firstElementChild?.textContent).toBe(
      `${TRANSLATED}Paragraph 0 of the made-up guide.`,
    );
  });

  it('translates failed paragraphs again on a second translate', async () => {
    const elements = article();
    const fake = fakeApi();
    fake.reply = () => Err(failure('response_invalid'));
    start(fake);
    fake.command({ action: 'translate' });
    await settle();
    const failed = fake.requests().flatMap(textsOf);
    expect(failed).toContain('Click here to run().');
    expect(lines(elements)[1]).toBe('Click here to run().');
    fake.reply = replyTo;
    fake.command({ action: 'translate' });
    await settle();
    expect(fake.requests().flatMap(textsOf).slice(failed.length)).toContain('Click here to run().');
    expect(lines(elements)[1]).toBe(`${TRANSLATED}Click here to run().`);
  });

  it('cancels the running page batch in the background when the page is hidden', async () => {
    article();
    const fake = fakeApi();
    fake.hold = true;
    start(fake);
    fake.command({ action: 'translate' });
    await settle();
    expect(fake.requests()).toHaveLength(1);
    setVisibility(document, 'hidden');
    expect(fake.sent.at(-1)).toEqual({ type: 'page/cancel', payload: {} });
  });

  it('switches the display when the stored mode changes', async () => {
    const elements = article();
    const fake = fakeApi();
    start(fake);
    fake.command({ action: 'translate' });
    await settle();
    expect(document.querySelector('pt-ja')).toBeNull();
    const port = fake.connect();
    fake.save({ ...defaultPageSettings, mode: 'pair' });
    await settle(PROGRESS_MS * 2);
    expect(lines(elements)[2]).toBe('Roll backward to dodge the light attack.');
    const box = must(document.querySelector('#roll > pt-ja'));
    expect(box.shadowRoot?.textContent).toContain(
      `${TRANSLATED}Roll backward to dodge the light attack.`,
    );
    expect(port.posted.at(-1)?.mode).toBe('pair');
    // Paragraphs written from now on are shown side by side too.
    const added = Object.assign(document.createElement('p'), { id: 'late', textContent: 'Late.' });
    document.body.append(added);
    await settle(1_000);
    expect(added.textContent).toBe('Late.');
    expect(document.querySelector('#late > pt-ja')).not.toBeNull();
  });

  it('restores and stops when the site joins the never list', async () => {
    const elements = article();
    const before = fingerprint(document.documentElement);
    const fake = fakeApi(always());
    start(fake);
    await settle();
    expect(lines(elements)[1]).toBe(`${TRANSLATED}Click here to run().`);
    fake.save(always({ never: [HOST] }));
    await settle();
    expect(fingerprint(document.documentElement)).toBe(before);
    const asked = fake.requests().length;
    await settle(1_000);
    expect(fake.requests()).toHaveLength(asked);
  });

  it('restores the page synchronously on pagehide into the bfcache and frees everything', async () => {
    const view = must(document.defaultView);
    const documentListeners = trackListeners(document);
    const windowListeners = trackListeners(view);
    const elements = article();
    // The text the bubble will translate, chosen before anything starts.
    select('rolling backward');
    const before = fingerprint(document.documentElement);
    const counting = countingTimers();
    const fake = fakeApi();
    start(fake, counting.timers);
    fake.command({ action: 'translate' });
    await settle();
    expect(lines(elements)[1]).toBe(`${TRANSLATED}Click here to run().`);
    const port = fake.connect();
    fake.save({ ...defaultPageSettings, mode: 'pair' });
    // Something waits everywhere: a mode switch, a tooltip, the progress, a bubble.
    hover(must(document.getElementById('post')));
    fake.command({ action: 'selection' });
    expect(overlayHost()).toBeDefined();
    expect(counting.waiting()).toBeGreaterThan(0);
    view.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    // In the same task: the original page, no observer, no timer, no listener.
    expect(fingerprint(document.documentElement)).toBe(before);
    expect(io.observers.every((observer) => observer.targets().length === 0)).toBe(true);
    expect(counting.waiting()).toBe(0);
    expect(documentListeners()).toEqual([]);
    expect(windowListeners()).toEqual(['pageshow']);
    expect(fake.messages.listeners.size).toBe(0);
    expect(fake.connects.listeners.size).toBe(0);
    expect(fake.changes.listeners.size).toBe(0);
    expect(port.disconnected).toBe(true);
    expect(overlayHost()).toBeUndefined();
    // The bubble's answer coming in later shows nothing.
    await settle(1_000);
    expect(overlayHost()).toBeUndefined();
  });

  it('starts again after the bfcache when it was translating', async () => {
    const view = must(document.defaultView);
    const elements = article();
    const fake = fakeApi();
    start(fake);
    fake.command({ action: 'translate' });
    await settle();
    const asked = fake.requests().length;
    view.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    expect(lines(elements)[1]).toBe('Click here to run().');
    view.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await settle();
    expect(fake.requests().length).toBeGreaterThan(asked);
    expect(lines(elements)[1]).toBe(`${TRANSLATED}Click here to run().`);
    expect(fake.command({ action: 'ping' })).toEqual({ ready: true });
  });

  it('stays as it is after the bfcache when it was not translating', async () => {
    const view = must(document.defaultView);
    article();
    const fake = fakeApi();
    start(fake);
    view.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    view.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await settle();
    expect(fake.requests()).toEqual([]);
    expect(fake.command({ action: 'ping' })).toEqual({ ready: true });
  });

  it('shows the original on hover after 300 ms in replace mode only', async () => {
    const elements = article();
    const run = must(elements[1]);
    const fake = fakeApi();
    start(fake);
    fake.command({ action: 'translate' });
    await settle();
    hover(run);
    vi.advanceTimersByTime(OVERLAY_TIMING.hoverDelayMs - 1);
    expect(overlayHost()).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(tooltipText()).toBe('原文：Click here to run().');
    run.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    expect(overlayHost()).toBeUndefined();
    // Scrolling hides it too.
    hover(run);
    vi.advanceTimersByTime(OVERLAY_TIMING.hoverDelayMs);
    expect(overlayHost()).toBeDefined();
    document.dispatchEvent(new Event('scroll'));
    expect(overlayHost()).toBeUndefined();
    // Side by side, the translation shows under the paragraph instead.
    fake.save({ ...defaultPageSettings, mode: 'pair' });
    await settle();
    hover(must(elements[2]));
    vi.advanceTimersByTime(OVERLAY_TIMING.hoverDelayMs * 2);
    expect(overlayHost()).toBeUndefined();
  });

  it('shows the translation of a button on hover side by side (P26)', async () => {
    const elements = article();
    const post = must(elements[3]);
    const fake = fakeApi({ ...defaultPageSettings, mode: 'pair' });
    start(fake);
    fake.command({ action: 'translate' });
    await settle();
    expect(post.textContent).toBe('Post the comment');
    hover(post);
    vi.advanceTimersByTime(OVERLAY_TIMING.hoverDelayMs);
    expect(tooltipText()).toBe(`訳：${TRANSLATED}Post the comment`);
  });

  it('shows no tooltip once the page is restored', async () => {
    const elements = article();
    const fake = fakeApi();
    start(fake);
    fake.command({ action: 'translate' });
    await settle();
    fake.command({ action: 'restore' });
    await settle();
    hover(must(elements[1]));
    vi.advanceTimersByTime(OVERLAY_TIMING.hoverDelayMs * 2);
    expect(overlayHost()).toBeUndefined();
  });

  it.each([
    { name: '選択なし', selection: '', bubble: '翻訳する文を選択してください' },
    { name: '日本語', selection: '後ろに転がる', bubble: '選択した文は日本語です' },
    { name: '英語', selection: 'rolling backward', bubble: '訳:rolling backward' },
  ])('selection bubble: $name', async ({ selection, bubble }) => {
    const fake = fakeApi();
    start(fake);
    select(selection);
    fake.command({ action: 'selection' });
    await settle();
    expect(bubbleText()).toContain(bubble);
  });

  it('asks for the selection at once, apart from the page batch, in text-only units', async () => {
    article();
    const fake = fakeApi();
    fake.hold = true;
    start(fake);
    fake.command({ action: 'translate' });
    await settle();
    expect(fake.requests()).toHaveLength(1);
    const sentence = 'Roll backward to dodge the light attack and wait for the bell. ';
    select(sentence.repeat(20).trim());
    fake.command({ action: 'selection' });
    await settle();
    const selection = fake.requests().filter((request) => request.purpose === 'selection');
    expect(selection).toHaveLength(1);
    const request = must(selection[0]);
    expect(request.units.length).toBeGreaterThan(1);
    for (const unit of request.units) {
      expect(unit.tokens).toHaveLength(1);
      const [token] = unit.tokens;
      assert(token?.t === 'text');
      expect(Array.from(token.text).length).toBeLessThanOrEqual(400);
    }
    expect(request.page).toEqual({ title: 'Made-up Guide', site: HOST });
    const translation = textsOf(request).map((text) => `${TRANSLATED}${text}`);
    expect(bubbleText()).toContain(translation.join(''));
  });

  it.each([
    { name: 'exactly 2,000 characters', length: MAX_SELECTION, cut: false },
    { name: 'cut by the background', length: MAX_SELECTION, cut: true },
    { name: 'cut before a split character', length: MAX_SELECTION - 1, cut: true },
  ])('reads the menu text when the page has no selection: $name', async ({ length, cut }) => {
    const fake = fakeApi();
    start(fake);
    const text = 'Roll backward. '.repeat(200).slice(0, length);
    fake.command({ action: 'selection', text, cut });
    await settle();
    expect(fake.requests().flatMap(textsOf).join(' ')).toBe(text.trim());
    expect(bubbleText()?.includes(CUT_NOTE)).toBe(cut);
  });

  it.each([
    {
      name: 'exactly 2,000 characters',
      text: 'x'.repeat(MAX_SELECTION),
      asked: MAX_SELECTION,
      cut: false,
    },
    {
      name: '2,001 characters',
      text: 'x'.repeat(MAX_SELECTION + 1),
      asked: MAX_SELECTION,
      cut: true,
    },
    {
      name: 'a character split at the limit',
      text: `${'x'.repeat(MAX_SELECTION - 1)}😀`,
      asked: MAX_SELECTION - 1,
      cut: true,
    },
  ])('cuts the page selection to 2,000 characters: $name', async ({ text, asked, cut }) => {
    const fake = fakeApi();
    start(fake);
    select(text);
    fake.command({ action: 'selection' });
    await settle();
    expect(fake.requests().flatMap(textsOf).join('')).toBe('x'.repeat(asked));
    expect(bubbleText()?.includes(CUT_NOTE)).toBe(cut);
  });

  it('cuts a long page selection of sentences at 2,000 characters', async () => {
    const fake = fakeApi();
    start(fake);
    const text = 'Roll backward. '.repeat(200).trim();
    select(text);
    fake.command({ action: 'selection' });
    await settle();
    // The first 2,000 characters end with a space, which the units do not keep.
    expect(fake.requests().flatMap(textsOf).join(' ')).toBe(text.slice(0, MAX_SELECTION).trim());
    expect(bubbleText()).toContain(CUT_NOTE);
  });

  it('says when the selection could not be translated', async () => {
    const fake = fakeApi();
    fake.reply = () => Err(failure('network_failed'));
    start(fake);
    select('rolling backward');
    fake.command({ action: 'selection' });
    await settle();
    expect(bubbleText()).toContain('翻訳できませんでした');
    expect(bubbleText()).not.toContain(CUT_NOTE);
  });

  it('closes the bubble on Escape and leaves no element behind', async () => {
    const fake = fakeApi();
    start(fake);
    select('rolling backward');
    const before = fingerprint(document.documentElement);
    fake.command({ action: 'selection' });
    await settle();
    expect(bubbleText()).toContain('訳:rolling backward');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(fingerprint(document.documentElement)).toBe(before);
  });

  it('does not bring back a bubble closed before its answer', async () => {
    const fake = fakeApi();
    start(fake);
    select('rolling backward');
    fake.command({ action: 'selection' });
    expect(bubbleText()).toContain('翻訳中');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(overlayHost()).toBeUndefined();
  });

  it('sends progress only while the popup port is connected', async () => {
    article();
    const fake = fakeApi();
    fake.hold = true;
    start(fake);
    expect(fake.connect('other').posted).toEqual([]);
    const port = fake.connect();
    expect(port.posted).toHaveLength(1);
    expect(port.posted[0]?.state).toBe('idle');
    fake.command({ action: 'translate' });
    await settle(PROGRESS_MS * 2);
    expect(port.posted.at(-1)).toMatchObject({ state: 'on', waiting: 4 });
    // At most one every 250 ms, the latest one last.
    const count = port.posted.length;
    for (const release of fake.held.splice(0)) release();
    await vi.advanceTimersByTimeAsync(0);
    expect(port.posted.length).toBeLessThanOrEqual(count + 1);
    await settle(PROGRESS_MS * 2);
    expect(port.posted.at(-1)).toMatchObject({ state: 'on', done: 4, waiting: 0 });
    port.close();
    const after = port.posted.length;
    fake.command({ action: 'restore' });
    await settle(PROGRESS_MS * 4);
    expect(port.posted).toHaveLength(after);
  });
});

/** The page requests `fake` was sent. */
function pageRequests(of: Fake): TranslateRequest[] {
  return of.requests().filter((request) => request.purpose === 'page');
}

describe('extensionGone', () => {
  it.each([
    { name: 'has its id', api: { runtime: { id: 'extension-id' } }, gone: false },
    { name: 'has no id', api: { runtime: {} }, gone: true },
    { name: 'has no runtime', api: {}, gone: true },
    {
      name: 'cannot read its id',
      api: {
        runtime: {
          get id(): string {
            throw new Error('Extension context invalidated.');
          },
        },
      },
      gone: true,
    },
  ])('is $gone when the runtime $name', ({ api, gone }) => {
    expect(extensionGone(api)).toBe(gone);
  });
});

describe('runInjection', () => {
  /** The page script's options (page.content.ts) that WXT's context reads. */
  const OPTIONS = { registration: 'runtime', noScriptStartedPostMessage: true } as const;
  /**
   * Injections of the page script into one isolated world (`world`), each with its own WXT
   * context, of an extension whose runtime id is `id` (undefined once it has gone).
   */
  function injector(fake: Fake): {
    inject: () => ContentScriptContext;
    runtime: { id?: string };
    started: () => number;
  } {
    const world = {};
    const runtime: { id?: string } = { id: 'extension-id' };
    let started = 0;
    return {
      runtime,
      started: () => started,
      inject: () => {
        const ctx = new ContentScriptContext('page', OPTIONS);
        contexts.push(ctx);
        runInjection({
          scope: world,
          start: () => {
            started += 1;
            const end = startSession(document, fake.api);
            stop = end;
            return end;
          },
          gone: () => extensionGone({ runtime }),
          onInvalidated: (listener) => {
            ctx.onInvalidated(listener);
          },
        });
        return ctx;
      },
    };
  }

  it('leaves the page to its session when the running extension injects again (P18)', async () => {
    const elements = article();
    const fake = fakeApi();
    const { inject, started } = injector(fake);
    const first = inject();
    fake.command({ action: 'translate' });
    await settle();
    expect(lines(elements)[1]).toBe(`${TRANSLATED}Click here to run().`);
    // The second press: its context ends the first one's, and the first session goes on.
    inject();
    expect(first.signal.aborted).toBe(true);
    expect(started()).toBe(1);
    expect(lines(elements)[1]).toBe(`${TRANSLATED}Click here to run().`);
    expect(fake.messages.listeners.size).toBe(1);
    expect(fake.command({ action: 'ping' })).toEqual({ ready: true });
    const asked = fake.requests().length;
    document.body.append(Object.assign(document.createElement('p'), { textContent: 'Late.' }));
    await settle(1_000);
    expect(fake.requests().length).toBeGreaterThan(asked);
  });

  it('stops and restores the exact page at once when the extension has gone (P28)', async () => {
    const elements = article();
    const before = fingerprint(document.documentElement);
    const fake = fakeApi();
    const { inject, runtime } = injector(fake);
    inject();
    fake.command({ action: 'translate' });
    await settle();
    expect(lines(elements)[1]).toBe(`${TRANSLATED}Click here to run().`);
    // Pressed again before the update: the context that sees the update is the second one's.
    inject();
    // The extension reloads; its new version's copy starts on the page (another isolated world
    // in Chrome), which ends the old copy's context.
    delete runtime.id;
    const asked = fake.requests().length;
    contexts.push(new ContentScriptContext('page', OPTIONS));
    expect(fingerprint(document.documentElement)).toBe(before);
    expect(io.observers.every((observer) => observer.targets().length === 0)).toBe(true);
    expect(fake.messages.listeners.size).toBe(0);
    document.body.append(Object.assign(document.createElement('p'), { textContent: 'Late.' }));
    await settle(1_000);
    expect(fake.requests()).toHaveLength(asked);
  });

  it('lets go of the page even when the ended extension has no runtime left (P28)', async () => {
    const view = must(document.defaultView);
    const documentListeners = trackListeners(document);
    const windowListeners = trackListeners(view);
    const elements = article();
    const before = fingerprint(document.documentElement);
    const fake = fakeApi();
    const { inject, runtime } = injector(fake);
    inject();
    fake.command({ action: 'translate' });
    await settle();
    const port = fake.connect();
    expect(lines(elements)[1]).toBe(`${TRANSLATED}Click here to run().`);
    delete runtime.id;
    const dead = (): void => {
      throw new Error('Extension context invalidated.');
    };
    fake.messages.api.removeListener = dead;
    fake.connects.api.removeListener = dead;
    fake.changes.api.removeListener = dead;
    contexts.push(new ContentScriptContext('page', OPTIONS));
    expect(fingerprint(document.documentElement)).toBe(before);
    // Only the new copy's WXT context still listens, for the copy after it.
    expect(documentListeners()).toEqual([expect.stringMatching(/:wxt:content-script-started$/u)]);
    expect(windowListeners()).toEqual([]);
    // The progress it heard when it connected, and nothing after the end.
    expect(port.posted.map((progress) => progress.state)).toEqual(['on']);
  });
});
