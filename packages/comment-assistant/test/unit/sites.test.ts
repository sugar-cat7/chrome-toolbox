// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_COMMENT_TEXT, MAX_INGEST_COMMENTS, type RawComment } from '../../src/protocol.ts';
import { observeComments } from '../../src/sites/observe.ts';
import { createTwitchChat } from '../../src/sites/twitch-chat.ts';
import { byAttribute, ID_ATTRIBUTE, type SiteAdapter } from '../../src/sites/types.ts';
import { youtubeComments } from '../../src/sites/youtube-comments.ts';
import { youtubeLiveChat } from '../../src/sites/youtube-live-chat.ts';
import {
  installIntersection,
  restorePage,
  setViewport,
  setVisibility,
  type FakeIntersection,
} from './intersection.ts';

const twitch = createTwitchChat('s1');
const adapters = {
  'youtube-live-chat': youtubeLiveChat,
  'youtube-comments': youtubeComments,
  'twitch-chat': twitch,
} as const;
type Fixture = keyof typeof adapters;

/** Loads a fixture into the test document at `path` (jsdom keeps its own origin). */
function load(name: Fixture, location = '/'): Document {
  window.history.replaceState(null, '', location);
  const html = readFileSync(path.join(import.meta.dirname, `../fixtures/${name}.html`), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.replaceChild(
    document.importNode(parsed.documentElement, true),
    document.documentElement,
  );
  return document;
}
/** A badge image id Twitch does not have. */
const UNKNOWN_BADGE = '00000000-0000-4000-8000-000000000000';
const readAll = (adapter: SiteAdapter, doc: Document): RawComment[] =>
  [...(adapter.container(doc)?.children ?? [])].flatMap((node) => adapter.read(node) ?? []);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restorePage();
});

describe('site adapters', () => {
  it.each([
    {
      fixture: 'youtube-live-chat',
      site: 'youtube',
      comments: [
        ['fixture-live-01', '@sample-viewer-one', 'What game is this stream playing today?'],
        ['fixture-live-02', '@sample-viewer-two', 'nice jump again'],
        ['fixture-live-03', '@sample-viewer-three', '初見です、よろしくお願いします'],
        // Emoji are images: an emoji-only message has no text and stays out of inference.
        ['fixture-live-04', '@sample-streamer', ''],
        ['fixture-live-05', '@sample-supporter', 'Thanks for the fun stream!'],
        ['fixture-live-06', '@sample-moderator', 'Please keep the chat friendly, everyone.'],
      ],
    },
    {
      fixture: 'youtube-comments',
      site: 'youtube',
      comments: [
        [
          'FixtureThread01',
          '@fixture-commenter-one',
          'This walkthrough finally made the puzzle click for me.',
        ],
        ['FixtureThread02', '@fixture-commenter-two', 'The part at 2:15 is my favorite so good'],
        ['FixtureThread03', '@fixture-commenter-three', '次の動画も楽しみにしています'],
        ['FixtureThread04', '@FixtureStreamer', 'Thanks for watching! Part two goes up next week.'],
      ],
    },
    {
      fixture: 'twitch-chat',
      site: 'twitch',
      comments: [
        ['s1-1', 'FixtureUserOne', 'is the boss fight next?'],
        ['s1-2', 'FixtureUserTwo', '@FixtureUserOne yes, right after this'],
        ['s1-3', 'FixtureUserThree', 'notes are here https://example.com/fixture-notes'],
        ['s1-4', 'FixtureUserFour', 'こんばんは、今日も楽しみです'],
        ['s1-5', 'FixtureUserFive', 'gg'],
      ],
    },
  ] as const)('$fixture adapter reads every fixture message', ({ fixture, site, comments }) => {
    const adapter = adapters[fixture];
    const doc = load(fixture);
    const read = readAll(adapter, doc);
    expect(adapter.site).toBe(site);
    expect(read.map(({ id, author, text }) => [id, author, text])).toEqual(comments);
    expect(read.every(({ at }) => Number.isFinite(at))).toBe(true);
    const root = adapter.container(doc);
    expect(root).not.toBeNull();
    for (const { id, text } of read) {
      const message = root && adapter.messageElement(root, id);
      expect(message).not.toBeNull();
      // Reading again returns the same id: Twitch lines keep the id stamped on first read.
      const again = message && adapter.read(message);
      expect(again?.id).toBe(id);
      const holder = message && adapter.textElement(message);
      expect(holder?.textContent?.replace(/\s+/gu, ' ').trim()).toBe(text);
    }
  });

  it.each([
    {
      fixture: 'twitch-chat',
      // A subscriber badge, the broadcaster, a moderator who is also a bot, a viewer, and a
      // verified (Partner) badge, which is no trusted role (R41).
      roles: {
        's1-1': undefined,
        's1-2': 'owner',
        's1-3': 'moderator',
        's1-4': undefined,
        's1-5': undefined,
      },
    },
    {
      fixture: 'youtube-comments',
      roles: {
        FixtureThread01: undefined,
        FixtureThread02: undefined,
        FixtureThread03: undefined,
        FixtureThread04: 'owner',
      },
    },
    {
      fixture: 'youtube-live-chat',
      // A viewer, a member, a verified channel, the owner, a paid message, a moderator member.
      roles: {
        'fixture-live-01': undefined,
        'fixture-live-02': undefined,
        'fixture-live-03': 'verified',
        'fixture-live-04': 'owner',
        'fixture-live-05': undefined,
        'fixture-live-06': 'moderator',
      },
    },
  ] as const)(
    "$fixture adapter reads each author's role from the badges (R38)",
    ({ fixture, roles }) => {
      // A fresh Twitch adapter numbers the lines from s1-1 again.
      const adapter = fixture === 'twitch-chat' ? createTwitchChat('s1') : adapters[fixture];
      const read = readAll(adapter, load(fixture));
      expect(Object.fromEntries(read.map(({ id, role }) => [id, role]))).toEqual(roles);
      // No role, no key: the message stays as before for everyone else.
      expect(read.filter((comment) => !('role' in comment)).map(({ id }) => id)).toEqual(
        Object.entries(roles).flatMap(([id, role]) => (role === undefined ? [id] : [])),
      );
    },
  );

  it.each([
    // By image id: a Lead Moderator is a moderator; a Verified (Partner) badge is no role (R41).
    { src: '0822047b-65e0-46f2-94a9-d1091d685d33', alt: 'Lead Moderator badge', role: 'moderator' },
    { src: 'd12a2e27-16f6-41d0-ab77-b780518f00a3', alt: 'Verified badge', role: undefined },
    // By alt text when the image id is unknown, in English or Japanese.
    { src: UNKNOWN_BADGE, alt: 'Broadcaster badge', role: 'owner' },
    { src: UNKNOWN_BADGE, alt: 'ストリーマーバッジ', role: 'owner' },
    { src: UNKNOWN_BADGE, alt: 'Moderator badge', role: 'moderator' },
    { src: UNKNOWN_BADGE, alt: 'モデレーターバッジ', role: 'moderator' },
    { src: UNKNOWN_BADGE, alt: 'Lead Moderator badge', role: 'moderator' },
    { src: UNKNOWN_BADGE, alt: 'モデレーター責任者バッジ', role: 'moderator' },
    { src: UNKNOWN_BADGE, alt: 'Verified badge', role: undefined },
    { src: UNKNOWN_BADGE, alt: '認証済みバッジ', role: undefined },
    { src: UNKNOWN_BADGE, alt: 'VIP badge', role: undefined },
  ] as const)('reads the Twitch badge $alt ($src) as $role', ({ src, alt, role }) => {
    const doc = load('twitch-chat');
    // The first line's subscriber badge.
    const [badge] = doc.querySelectorAll('img.chat-badge');
    if (!badge) throw new Error('fixture changed');
    badge.setAttribute('src', `https://static-cdn.jtvnw.net/badges/v1/${src}/1`);
    badge.setAttribute('alt', alt);
    // The other lines keep the fixture's badges.
    expect(readAll(createTwitchChat('s1'), doc).map((comment) => comment.role)).toEqual([
      role,
      'owner',
      'moderator',
      undefined,
      undefined,
    ]);
  });

  it.each([
    ['https://www.youtube.com/live_chat?is_popout=1&v=abc', 'youtube-live-chat'],
    ['https://www.youtube.com/live_chat?continuation=x', 'youtube-live-chat'],
    ['https://www.youtube.com/live_chat_replay?continuation=x', 'youtube-live-chat'],
    ['https://www.youtube.com/watch?v=abc', 'youtube-comments'],
    ['https://www.twitch.tv/somechannel', 'twitch-chat'],
    ['https://www.twitch.tv/popout/somechannel/chat', 'twitch-chat'],
    ['https://www.youtube.com/', undefined],
    ['https://www.youtube.com/@somechannel', undefined],
    ['https://example.com/live_chat', undefined],
  ])('%s is handled by %s', (url, expected) => {
    const matching = Object.entries(adapters)
      .filter(([, adapter]) => adapter.matches(new URL(url)))
      .map(([name]) => name);
    expect(matching).toEqual(expected === undefined ? [] : [expected]);
  });

  it.each([
    {
      fixture: 'youtube-live-chat',
      path: '/live_chat?is_popout=1&v=fixture0001',
      channel: 'fixture0001',
    },
    // Video comments are a partition of their own, apart from the same video's chat replay.
    {
      fixture: 'youtube-comments',
      path: '/watch?v=fixture0002&t=10s',
      channel: 'fixture0002#comments',
    },
    { fixture: 'youtube-comments', path: `/watch?v=${'x'.repeat(100)}`, channel: undefined },
    { fixture: 'twitch-chat', path: '/FixtureChannel', channel: 'fixturechannel' },
    { fixture: 'twitch-chat', path: '/popout/fixturechannel/chat', channel: 'fixturechannel' },
    { fixture: 'twitch-chat', path: '/', channel: undefined },
    { fixture: 'twitch-chat', path: '/directory/all', channel: undefined },
    { fixture: 'twitch-chat', path: '/videos/123456', channel: undefined },
    { fixture: 'twitch-chat', path: '/search?term=x', channel: undefined },
    { fixture: 'twitch-chat', path: '/settings/profile', channel: undefined },
    { fixture: 'twitch-chat', path: '/p/en/about', channel: undefined },
  ] as const)('$fixture at $path is channel $channel', ({ fixture, path, channel }) => {
    expect(adapters[fixture].channel(load(fixture, path))).toBe(channel);
  });

  it('takes the video of the watch page that embeds the live chat iframe', () => {
    const doc = load('youtube-live-chat', '/live_chat?continuation=opaque');
    vi.spyOn(doc, 'referrer', 'get').mockReturnValue('https://www.youtube.com/watch?v=fixture0003');
    expect(youtubeLiveChat.channel(doc)).toBe('fixture0003');
  });

  it('finds a live chat line even when the page has another element with its id first', () => {
    const doc = load('youtube-live-chat');
    const decoy = doc.createElement('div');
    decoy.id = 'fixture-live-01';
    doc.body.prepend(decoy);
    const root = youtubeLiveChat.container(doc);
    expect(doc.getElementById('fixture-live-01')).toBe(decoy);
    const found = root && youtubeLiveChat.messageElement(root, 'fixture-live-01');
    expect(found?.tagName).toBe('YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER');
    expect(found && root.contains(found)).toBe(true);
  });

  it.each(['plain', 'with "quotes" and \\', 'carriage\rreturn', 'form\ffeed', 'line\nfeed'])(
    'byAttribute matches the value %j exactly',
    (value) => {
      const doc = load('twitch-chat');
      const element = doc.createElement('span');
      element.setAttribute(ID_ATTRIBUTE, value);
      doc.body.append(element);
      expect(doc.querySelector(byAttribute(ID_ATTRIBUTE, value))).toBe(element);
      expect(doc.querySelector(byAttribute(ID_ATTRIBUTE, `${value}x`))).toBeNull();
    },
  );

  it('skips a comment whose link carries no usable comment id', () => {
    const doc = load('youtube-comments');
    const [thread] = youtubeComments.container(doc)?.children ?? [];
    const link = thread?.querySelector('[id="published-time-text"] a');
    if (!thread || !link) throw new Error('fixture changed');
    link.setAttribute('href', '/watch?v=fixture0001&lc=bad%20id%22]');
    expect(youtubeComments.read(thread)).toBeUndefined();
    expect(thread.hasAttribute(ID_ATTRIBUTE)).toBe(false);
  });

  it('cuts long text and author names to what the service worker accepts, and skips huge ids', () => {
    const doc = load('youtube-live-chat');
    const [first, second] = youtubeLiveChat.container(doc)?.children ?? [];
    const message = first?.nextElementSibling;
    const text = message?.querySelector('#message');
    const author = message?.querySelector('#author-name')?.firstChild;
    if (!message || !text || !author || !second) throw new Error('fixture changed');
    text.textContent = `${'x'.repeat(MAX_COMMENT_TEXT - 1)}😀 tail`;
    author.textContent = 'n'.repeat(400);
    const read = youtubeLiveChat.read(message);
    expect(read?.text).toHaveLength(MAX_COMMENT_TEXT - 1);
    expect(read?.author).toHaveLength(256);
    message.id = 'i'.repeat(300);
    expect(youtubeLiveChat.read(message)).toBeUndefined();
  });
});

describe('adapter cost (R45)', () => {
  it('reads a live chat line and finds its text by walking its children, never by a scoped #id query', () => {
    const doc = load('youtube-live-chat');
    const lines = [...(youtubeLiveChat.container(doc)?.children ?? [])];
    // What a scoped query finds: the walk finds the same elements.
    const expected = lines.map((line) => line.querySelector('#message'));
    const query = vi.spyOn(Element.prototype, 'querySelector');
    const queryAll = vi.spyOn(Element.prototype, 'querySelectorAll');
    const read = lines.map((line) => youtubeLiveChat.read(line));
    const texts = lines.map((line) =>
      line instanceof HTMLElement ? youtubeLiveChat.textElement(line) : null,
    );
    const selectors = [...query.mock.calls, ...queryAll.mock.calls].map(([selector]) => selector);
    // Every line repeats #message and #author-name: such a query is slow on the live page.
    expect(
      selectors.filter((selector) => /#(?:message|author-name)\b|\[id=/u.test(selector)),
    ).toEqual([]);
    expect(texts).toEqual(expected);
    expect(read.map((comment) => comment?.author)).toEqual([
      undefined,
      '@sample-viewer-one',
      '@sample-viewer-two',
      '@sample-viewer-three',
      '@sample-streamer',
      '@sample-supporter',
      '@sample-moderator',
    ]);
  });

  it('still reads a line whose ids sit deeper than the verified layout, by a query then', () => {
    const doc = load('youtube-live-chat');
    const paid = doc.getElementById('fixture-live-05');
    const chip = paid?.querySelector('yt-live-chat-author-chip');
    if (!paid || !chip) throw new Error('fixture changed');
    // Two more wrappers around the paid message's author chip: 9 levels down.
    for (let wrap = 0; wrap < 2; wrap += 1) {
      const wrapper = doc.createElement('div');
      chip.replaceWith(wrapper);
      wrapper.append(chip);
    }
    expect(youtubeLiveChat.read(paid)?.author).toBe('@sample-supporter');
  });

  it('finds a Twitch line it read by its id without searching the list, and searches for one it no longer holds', () => {
    const doc = load('twitch-chat');
    const chat = createTwitchChat('s1');
    const root = chat.container(doc);
    const wrapper = root?.lastElementChild;
    if (!root || !wrapper) throw new Error('fixture changed');
    const read = readAll(chat, doc);
    const search = vi.spyOn(root, 'querySelector');
    for (const { id } of read)
      expect(chat.messageElement(root, id)?.getAttribute(ID_ATTRIBUTE)).toBe(id);
    expect(search).not.toHaveBeenCalled();
    // A held line that now carries another id is not that comment any more.
    const second = chat.messageElement(root, 's1-2');
    second?.setAttribute(ID_ATTRIBUTE, 'reused');
    expect(chat.messageElement(root, 's1-2')).toBeNull();
    second?.setAttribute(ID_ATTRIBUTE, 's1-2');
    search.mockClear();
    const first = chat.messageElement(root, 's1-1');
    // Many lines later the first one is no longer held: a search still finds it.
    for (let index = 0; index < 600; index += 1) {
      const copy = wrapper.cloneNode(true);
      if (!(copy instanceof Element)) throw new Error('fixture changed');
      copy.querySelector(`[${ID_ATTRIBUTE}]`)?.removeAttribute(ID_ATTRIBUTE);
      root.append(copy);
      chat.read(copy);
    }
    expect(chat.messageElement(root, 's1-1')).toBe(first);
    expect(search).toHaveBeenCalled();
    // A line the page removed is not shown again.
    search.mockClear();
    const last = chat.messageElement(root, 's1-605');
    last?.closest(`[${ID_ATTRIBUTE}]`)?.parentElement?.remove();
    expect(last).not.toBeNull();
    expect(chat.messageElement(root, 's1-605')).toBeNull();
  });
});

describe('observeComments', () => {
  const FLUSH = 600;
  /** Longer than the cadence of comments read while the chat is not in front. */
  const STORE_FLUSH = 1100;
  let io: FakeIntersection;
  beforeEach(() => {
    io = installIntersection();
  });
  /** A live chat line as YouTube adds it: id, #author-name and #message. */
  const message = (doc: Document, id: string, text: string): Element => {
    const line = doc.createElement('yt-live-chat-text-message-renderer');
    line.id = id;
    const author = doc.createElement('span');
    author.id = 'author-name';
    author.textContent = '@sample-viewer';
    const body = doc.createElement('span');
    body.id = 'message';
    body.textContent = text;
    line.append(author, body);
    return line;
  };

  it('tells which list it watches, on start and when the page replaces it (R45)', async () => {
    vi.useFakeTimers();
    const doc = load('youtube-live-chat');
    const lists: (Element | null)[] = [];
    const stop = observeComments(youtubeLiveChat, doc, () => undefined, undefined, {
      onContainer: (list) => lists.push(list),
    });
    const items = youtubeLiveChat.container(doc);
    expect(lists).toEqual([items]);
    await vi.advanceTimersByTimeAsync(FLUSH);
    // Top chat ↔ Live chat: the new list is told.
    const list = doc.querySelector('yt-live-chat-item-list-renderer');
    const copy = list?.cloneNode(true);
    if (!list || !(copy instanceof Element)) throw new Error('fixture changed');
    list.replaceWith(copy);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(lists).toEqual([items, youtubeLiveChat.container(doc)]);
    expect(lists[1]).not.toBe(items);
    stop();
  });

  it('reads existing messages once, reports appended messages once and disconnects on cleanup', async () => {
    vi.useFakeTimers();
    const doc = load('youtube-live-chat');
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const batches: RawComment[][] = [];
    const stop = observeComments(youtubeLiveChat, doc, (comments) => batches.push(comments));
    const items = youtubeLiveChat.container(doc);
    // One childList observer on the container; nothing watches attributes, text or a subtree.
    expect(observe.mock.calls.filter(([target]) => target === items)).toEqual([
      [items, { childList: true }],
    ]);
    expect(observe.mock.calls.every(([, options]) => options?.subtree !== true)).toBe(true);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(batches.map((batch) => batch.length)).toEqual([6]);

    items?.append(
      message(doc, 'appended-1', 'first new line'),
      message(doc, 'appended-2', 'second new line'),
    );
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(batches).toHaveLength(2);
    expect(batches[1]?.map(({ id, text }) => [id, text])).toEqual([
      ['appended-1', 'first new line'],
      ['appended-2', 'second new line'],
    ]);

    stop();
    items?.append(message(doc, 'appended-3', 'after cleanup'));
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(batches).toHaveLength(2);
  });

  it('skips messages removed before the flush and never reports an element twice', async () => {
    vi.useFakeTimers();
    const doc = load('youtube-live-chat');
    const batches: RawComment[][] = [];
    const stop = observeComments(youtubeLiveChat, doc, (comments) => batches.push(comments));
    await vi.advanceTimersByTimeAsync(FLUSH);
    const items = youtubeLiveChat.container(doc);
    const gone = message(doc, 'gone', 'removed at once');
    const moved = items?.firstElementChild?.nextElementSibling;
    items?.append(gone);
    gone.remove();
    // Moving an element already read adds it again; it is not reported twice.
    if (moved) items?.append(moved);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(batches).toHaveLength(1);
    stop();
  });

  it('re-attaches when the chat list is replaced (Top chat ↔ Live chat)', async () => {
    vi.useFakeTimers();
    const doc = load('youtube-live-chat');
    const batches: RawComment[][] = [];
    const stop = observeComments(youtubeLiveChat, doc, (comments) => batches.push(comments));
    await vi.advanceTimersByTimeAsync(FLUSH);
    const oldList = doc.querySelector('yt-live-chat-item-list-renderer');
    const newList = oldList?.cloneNode(true);
    if (!oldList || !newList || !(newList instanceof Element)) throw new Error('fixture changed');
    newList
      .querySelector('#items')
      ?.replaceChildren(message(doc, 'top-1', 'shown in the new list'));
    const oldItems = youtubeLiveChat.container(doc);
    oldList.replaceWith(newList);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(batches.at(-1)?.map(({ id }) => id)).toEqual(['top-1']);

    oldItems?.append(message(doc, 'stale', 'in the detached list'));
    newList.querySelector('#items')?.append(message(doc, 'top-2', 'appended to the new list'));
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(batches.at(-1)?.map(({ id }) => id)).toEqual(['top-2']);
    expect(batches.flat().some(({ id }) => id === 'stale')).toBe(false);
    stop();
  });

  /** Long enough for the once-a-second check while the container is missing, and a flush. */
  const WAIT = 1400;

  it('waits inside the scope for a container that is not rendered yet', async () => {
    vi.useFakeTimers();
    const doc = load('youtube-live-chat');
    const list = doc.querySelector('yt-live-chat-item-list-renderer');
    const parent = list?.parentElement;
    list?.remove();
    const batches: RawComment[][] = [];
    const stop = observeComments(youtubeLiveChat, doc, (comments) => batches.push(comments));
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(batches).toEqual([]);
    if (list) parent?.append(list);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(batches.map((batch) => batch.length)).toEqual([6]);
    stop();
  });

  it('checks for a missing container at most once a second however busy the page is', async () => {
    vi.useFakeTimers();
    const doc = load('twitch-chat');
    const chat = createTwitchChat('s1');
    const room = doc.querySelector('.chat-room__content');
    const parent = room?.parentElement;
    room?.remove();
    const container = vi.fn<SiteAdapter['container']>(chat.container);
    const stop = observeComments({ ...chat, container }, doc, () => undefined);
    const scope = chat.scope(doc);
    // A busy app: 20 changes a second for 3 seconds.
    for (let tick = 0; tick < 60; tick += 1) {
      scope?.append(doc.createElement('div'));
      await vi.advanceTimersByTimeAsync(50);
    }
    // The first look plus one check per second.
    expect(container.mock.calls.length).toBeLessThanOrEqual(4);
    expect(container.mock.calls.length).toBeGreaterThanOrEqual(3);
    if (room) parent?.append(room);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(chat.container(doc)).not.toBeNull();
    stop();
  });

  it('without a scope, watches only the body and attaches when the list appears there', async () => {
    vi.useFakeTimers();
    const doc = load('youtube-live-chat');
    const list = doc.querySelector('yt-live-chat-item-list-renderer');
    list?.remove();
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const batches: RawComment[][] = [];
    const stop = observeComments({ ...youtubeLiveChat, scope: () => null }, doc, (comments) =>
      batches.push(comments),
    );
    expect(observe.mock.calls).toEqual([[doc.body, { childList: true }]]);
    if (list) doc.body.append(list);
    await vi.advanceTimersByTimeAsync(WAIT);
    expect(batches.map((batch) => batch.length)).toEqual([6]);
    stop();
  });

  it('reports nothing for messages added just before it was stopped', async () => {
    vi.useFakeTimers();
    const doc = load('youtube-live-chat');
    const batches: RawComment[][] = [];
    const stop = observeComments(youtubeLiveChat, doc, (comments) => batches.push(comments));
    await vi.advanceTimersByTimeAsync(FLUSH);
    youtubeLiveChat.container(doc)?.append(message(doc, 'late', 'added before the stop'));
    await vi.advanceTimersByTimeAsync(100);
    stop();
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(batches.flat().map(({ id }) => id)).not.toContain('late');
    expect(batches).toHaveLength(1);
  });

  it('re-attaches when Twitch remounts its chat room', async () => {
    vi.useFakeTimers();
    const doc = load('twitch-chat');
    const chat = createTwitchChat('s1');
    const batches: RawComment[][] = [];
    const stop = observeComments(chat, doc, (comments) => batches.push(comments));
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(batches.flat()).toHaveLength(5);
    const oldContainer = chat.container(doc);
    const room = doc.querySelector('.chat-room__content');
    const remounted = room?.cloneNode(true);
    if (!room || !(remounted instanceof Element)) throw new Error('fixture changed');
    const lines = remounted.querySelector('[role="log"]');
    const line = lines?.lastElementChild?.cloneNode(true);
    if (!lines || !(line instanceof Element)) throw new Error('fixture changed');
    line.querySelector(`[${ID_ATTRIBUTE}]`)?.removeAttribute(ID_ATTRIBUTE);
    lines.replaceChildren(line);
    room.replaceWith(remounted);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(batches.at(-1)?.map(({ id }) => id)).toEqual(['s1-6']);
    const another = line.cloneNode(true);
    if (!(another instanceof Element)) throw new Error('fixture changed');
    another.querySelector(`[${ID_ATTRIBUTE}]`)?.removeAttribute(ID_ATTRIBUTE);
    oldContainer?.append(another.cloneNode(true));
    chat.container(doc)?.append(another);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(batches.at(-1)?.map(({ id }) => id)).toEqual(['s1-7']);
    expect(batches.flat()).toHaveLength(7);
    stop();
  });

  it('re-attaches when YouTube re-renders the comment section (sort order)', async () => {
    vi.useFakeTimers();
    const doc = load('youtube-comments', '/watch?v=fixture0001');
    const batches: RawComment[][] = [];
    const stop = observeComments(youtubeComments, doc, (comments) => batches.push(comments));
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(batches.flat()).toHaveLength(4);
    const sections = doc.querySelector('ytd-item-section-renderer#sections');
    const rendered = sections?.cloneNode(true);
    if (!sections || !(rendered instanceof Element)) throw new Error('fixture changed');
    const contents = rendered.querySelector('#contents');
    const thread = contents?.firstElementChild;
    thread
      ?.querySelector('[id="published-time-text"] a')
      ?.setAttribute('href', '/watch?v=fixture0001&lc=FixtureThread09');
    thread?.removeAttribute(ID_ATTRIBUTE);
    if (thread) contents?.replaceChildren(thread);
    sections.replaceWith(rendered);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(batches.at(-1)?.map(({ id }) => id)).toEqual(['FixtureThread09']);
    stop();
  });
  /** What the observer reported: each batch (ids, processed or stored) and each leave. */
  type Seen = [string[], boolean] | 'left';
  const watch = (adapter: SiteAdapter, doc: Document): { seen: Seen[]; stop: () => void } => {
    const seen: Seen[] = [];
    const stop = observeComments(
      adapter,
      doc,
      (comments, process) => seen.push([comments.map(({ id }) => id), process]),
      () => seen.push('left'),
    );
    return { seen, stop };
  };
  const FIXTURE_IDS = [1, 2, 3, 4, 5, 6].map((n) => `fixture-live-0${n}`);

  it('stores what arrives while the tab is hidden and, back in front, processes every line on screen (R44, R49)', async () => {
    vi.useFakeTimers();
    const doc = load('youtube-live-chat');
    const { seen, stop } = watch(youtubeLiveChat, doc);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(seen).toEqual([[FIXTURE_IDS, true]]);
    const items = youtubeLiveChat.container(doc);
    if (!items) throw new Error('fixture changed');

    // The tab goes to the background: leaving is told at once, without waiting for a timer (the
    // pipeline then stores the frame's waiting comments); the line waiting for its flush is
    // stored with what arrives meanwhile, read when they are sent.
    items.append(message(doc, 'p1', 'waiting when hidden'));
    setVisibility(doc, 'hidden');
    expect(seen.at(-1)).toBe('left');
    items.append(message(doc, 'h1', 'first while hidden'), message(doc, 'h2', 'second'));
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(seen).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(STORE_FLUSH);
    expect(seen.at(-1)).toEqual([['p1', 'h1', 'h2'], false]);
    items.append(message(doc, 'h3', 'just before returning'));

    // Back in front: every line on screen is sent for processing, in page order (the pipeline
    // takes the newest first), also one processed before (the session shows an answered one
    // without asking again) and ones stored meanwhile; stored lines off screen stay stored.
    io.setOnScreen(
      (element) => element === items || ['fixture-live-06', 'h2', 'h3'].includes(element.id),
    );
    setVisibility(doc, 'visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toEqual([['fixture-live-06', 'h2', 'h3'], true]);
    await vi.advanceTimersByTimeAsync(STORE_FLUSH);
    // New lines are processed again, wherever they are.
    items.append(message(doc, 'n1', 'new in front'));
    await vi.advanceTimersByTimeAsync(FLUSH);
    // Leaving the page counts as leaving the viewer.
    items.append(message(doc, 'n2', 'last line'));
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(STORE_FLUSH);
    expect(seen).toEqual([
      [FIXTURE_IDS, true],
      'left',
      [['p1', 'h1', 'h2'], false],
      [['fixture-live-06', 'h2', 'h3'], true],
      [['n1'], true],
      'left',
      [['n2'], false],
    ]);
    stop();
  });

  it('treats a chat that is off screen, or in a frame without a viewport, like a hidden tab', async () => {
    vi.useFakeTimers();
    const doc = load('youtube-live-chat');
    const { seen, stop } = watch(youtubeLiveChat, doc);
    await vi.advanceTimersByTimeAsync(FLUSH);
    const items = youtubeLiveChat.container(doc);
    if (!items) throw new Error('fixture changed');

    // The chat is collapsed or scrolled away: the container no longer intersects the viewport.
    io.setOnScreen(() => false);
    io.update();
    expect(seen.at(-1)).toBe('left');
    items.append(message(doc, 'o1', 'while off screen'));
    await vi.advanceTimersByTimeAsync(STORE_FLUSH);
    expect(seen.at(-1)).toEqual([['o1'], false]);
    io.setOnScreen(() => true);
    io.update();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toEqual([[...FIXTURE_IDS, 'o1'], true]);

    // An iframe resized to nothing reports no intersection change, only a resize.
    setViewport(window, 300, 0);
    expect(seen.at(-1)).toBe('left');
    items.append(message(doc, 'z1', 'in a frame of no size'));
    await vi.advanceTimersByTimeAsync(STORE_FLUSH);
    expect(seen.at(-1)).toEqual([['z1'], false]);
    setViewport(window, 300, 400);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toEqual([[...FIXTURE_IDS, 'o1', 'z1'], true]);
    stop();
  });

  it('reads a chat that starts hidden as stored, and one that starts in front by what is on screen, never leaving', async () => {
    vi.useFakeTimers();
    setVisibility(document, 'hidden');
    const hidden = watch(youtubeLiveChat, load('youtube-live-chat'));
    await vi.advanceTimersByTimeAsync(STORE_FLUSH);
    expect(hidden.seen).toEqual([[FIXTURE_IDS, false]]);
    hidden.stop();

    restorePage();
    io.setOnScreen((element) => !['fixture-live-01', 'fixture-live-02'].includes(element.id));
    const shown = watch(youtubeLiveChat, load('youtube-live-chat'));
    await vi.advanceTimersByTimeAsync(STORE_FLUSH);
    // The lines above the screen are stored; the chat in front never says it left.
    expect(shown.seen).toEqual([
      [FIXTURE_IDS.slice(2), true],
      [FIXTURE_IDS.slice(0, 2), false],
    ]);
    shown.stop();
  });

  it('stores the lines a look had not judged yet when the chat leaves meanwhile', async () => {
    vi.useFakeTimers();
    const doc = load('youtube-live-chat');
    const { seen, stop } = watch(youtubeLiveChat, doc);
    // Hidden before the first look reported anything.
    setVisibility(doc, 'hidden');
    await vi.advanceTimersByTimeAsync(STORE_FLUSH);
    expect(seen).toEqual(['left', [FIXTURE_IDS, false]]);
    // Back in front, the lines on screen are processed.
    setVisibility(doc, 'visible');
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(seen.at(-1)).toEqual([FIXTURE_IDS, true]);
    stop();
  });

  it('reads a line stored while away when it is sent, so one the page fills in late is read', async () => {
    vi.useFakeTimers();
    setVisibility(document, 'hidden');
    const doc = load('youtube-live-chat');
    const read: string[] = [];
    const stop = observeComments(youtubeLiveChat, doc, (comments) => {
      for (const comment of comments) read.push(`${comment.id}:${comment.text}`);
    });
    await vi.advanceTimersByTimeAsync(STORE_FLUSH);
    // The page adds the line first and gives it its id and text a moment later.
    const late = message(doc, '', '');
    youtubeLiveChat.container(doc)?.append(late);
    await vi.advanceTimersByTimeAsync(100);
    late.id = 'late';
    const text = late.querySelector('#message');
    if (text) text.textContent = 'filled in late';
    await vi.advanceTimersByTimeAsync(STORE_FLUSH);
    expect(read.at(-1)).toBe('late:filled in late');
    stop();
  });

  it('counts an empty chat list on screen, and a line only touching the edge as off screen', async () => {
    vi.useFakeTimers();
    const doc = load('youtube-live-chat');
    const items = youtubeLiveChat.container(doc);
    if (!items) throw new Error('fixture changed');
    // A chat that has no line yet: the list has no height, so it intersects with no area.
    items.replaceChildren();
    io.setOnScreen((element) => (element === items ? 'edge' : true));
    const { seen, stop } = watch(youtubeLiveChat, doc);
    await vi.advanceTimersByTimeAsync(FLUSH);
    items.append(message(doc, 'first', 'the first line'));
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(seen).toEqual([[['first'], true]]);

    // Back from the background, a line just below the visible area is not on screen.
    setVisibility(doc, 'hidden');
    items.append(message(doc, 'below', 'touching the bottom edge'));
    io.setOnScreen((element) => (element.id === 'below' ? 'edge' : true));
    setVisibility(doc, 'visible');
    await vi.advanceTimersByTimeAsync(STORE_FLUSH);
    expect(seen.slice(1)).toEqual(['left', [['first'], true], [['below'], false]]);
    stop();
  });

  it('stops its intersection observers and page listeners on cleanup', async () => {
    vi.useFakeTimers();
    const doc = load('youtube-live-chat');
    const { seen, stop } = watch(youtubeLiveChat, doc);
    await vi.advanceTimersByTimeAsync(FLUSH);
    stop();
    expect(io.observers.flatMap((observer) => observer.targets())).toEqual([]);
    setVisibility(doc, 'hidden');
    setViewport(window, 0, 0);
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(STORE_FLUSH);
    expect(seen).toHaveLength(1);
  });

  it('keeps watching video threads that came near before the page was hidden, and processes them on return', async () => {
    vi.useFakeTimers();
    const doc = load('youtube-comments', '/watch?v=fixture0001');
    const threads = [
      ...(youtubeComments
        .container(doc)
        ?.querySelectorAll(':scope > ytd-comment-thread-renderer') ?? []),
    ];
    const near = new Set<Element>([threads[0] ?? doc.body]);
    io.setOnScreen((element, rootMargin) => rootMargin === '100% 0px' && near.has(element));
    const { seen, stop } = watch(youtubeComments, doc);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(seen).toEqual([[['FixtureThread01'], true]]);
    // The second thread comes near and the page is hidden before it was sent.
    near.add(threads[1] ?? doc.body);
    io.update();
    setVisibility(doc, 'hidden');
    // One that comes near while hidden waits too. Video comments are never stored, and leaving
    // is not told (R50): threads already with the service worker are answered as usual.
    near.add(threads[2] ?? doc.body);
    io.update();
    await vi.advanceTimersByTimeAsync(STORE_FLUSH);
    expect(seen).toEqual([[['FixtureThread01'], true]]);
    setVisibility(doc, 'visible');
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(seen.at(-1)).toEqual([['FixtureThread02', 'FixtureThread03'], true]);
    stop();
  });

  it('processes a video comment only once it comes within a viewport height, and forgets removed ones', async () => {
    vi.useFakeTimers();
    const doc = load('youtube-comments', '/watch?v=fixture0001');
    const contents = youtubeComments.container(doc);
    const threads = [...(contents?.querySelectorAll(':scope > ytd-comment-thread-renderer') ?? [])];
    expect(threads).toHaveLength(4);
    const near = new Set<Element>([threads[0] ?? doc.body]);
    // Only the observer that looks one viewport height ahead sees the threads; the comment
    // section itself is below the video, off screen.
    io.setOnScreen((element, rootMargin) => rootMargin === '100% 0px' && near.has(element));
    const { seen: batches, stop } = watch(youtubeComments, doc);
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(batches).toEqual([[['FixtureThread01'], true]]);
    const ahead = io.observers.find((observer) => observer.rootMargin === '100% 0px');
    const watched = (): Element[] =>
      (ahead?.targets() ?? []).filter((target) => threads.includes(target));
    expect(watched()).toEqual(threads.slice(1));

    // The viewer scrolls: the third thread comes near; the fourth leaves the page.
    near.add(threads[2] ?? doc.body);
    io.update();
    threads[3]?.remove();
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(batches.at(-1)).toEqual([['FixtureThread03'], true]);
    expect(watched()).toEqual([threads[1]]);

    // However many threads load far from the viewer, a bounded number is watched.
    const template = threads[1];
    for (let i = 0; i < MAX_INGEST_COMMENTS + 200; i += 1) {
      const copy = template?.cloneNode(true);
      if (copy instanceof Element) contents?.append(copy);
    }
    await vi.advanceTimersByTimeAsync(FLUSH);
    expect(ahead?.targets().length).toBeLessThanOrEqual(MAX_INGEST_COMMENTS);
    expect(batches).toHaveLength(2);
    stop();
    expect(ahead?.targets()).toEqual([]);
  });
});
