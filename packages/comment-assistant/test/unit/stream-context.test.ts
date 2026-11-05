// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  contextHash,
  contextText,
  createStreamContexts,
  MAX_STREAMS,
  MAX_TITLE,
  ownerOf,
  streamOf,
} from '../../src/stream-context.ts';
import { createTwitchChat } from '../../src/sites/twitch-chat.ts';
import { youtubeComments } from '../../src/sites/youtube-comments.ts';
import { youtubeLiveChat } from '../../src/sites/youtube-live-chat.ts';

function load(location: string, fixture: string): Document {
  window.history.replaceState(null, '', location);
  const html = readFileSync(path.join(import.meta.dirname, `../fixtures/${fixture}.html`), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.replaceChild(
    document.importNode(parsed.documentElement, true),
    document.documentElement,
  );
  return document;
}
const flexy = (doc: Document): Element => {
  const element = doc.querySelector('ytd-watch-flexy');
  if (!element) throw new Error('fixture changed');
  return element;
};
const ownerLink = (doc: Document): Element => {
  const element = doc.querySelector('ytd-video-owner-renderer > a');
  if (!element) throw new Error('fixture changed');
  return element;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stream info read from the page', () => {
  it('reads the streamer handle and the title from the watch page once it shows the video', () => {
    const doc = load('/watch?v=fixture0001', 'youtube-comments');
    expect(youtubeComments.streamInfo?.(doc, 'fixture0001#comments')).toEqual({
      streamer: '@FixtureStreamer',
      title: 'Fixture Quest Part 3: the frozen bridge',
    });
  });

  it('reads nothing while the metadata still belongs to the previous video', () => {
    // YouTube changes the URL first and the metadata (with video-id) about a second later.
    const doc = load('/watch?v=fixture0002', 'youtube-comments');
    expect(youtubeComments.streamInfo?.(doc, 'fixture0002#comments')).toBeUndefined();
    flexy(doc).setAttribute('video-id', 'fixture0002');
    expect(youtubeComments.streamInfo?.(doc, 'fixture0002#comments')).toMatchObject({
      streamer: '@FixtureStreamer',
    });
  });

  it.each([
    { href: '/channel/UCfixture000000000000001', streamer: 'UCfixture000000000000001' },
    { href: '/@%E3%83%95%E3%82%A3%E3%82%AF%E3%82%B9%E3%83%81%E3%83%A3', streamer: '@フィクスチャ' },
    { href: '/@bad%E3', streamer: '@bad%E3' },
    { href: '/user/legacyname', streamer: undefined },
    { href: 'https://example.com/@elsewhere', streamer: undefined },
  ])('takes the streamer from the owner link $href', ({ href, streamer }) => {
    const doc = load('/watch?v=fixture0001', 'youtube-comments');
    ownerLink(doc).setAttribute('href', href);
    const info = youtubeComments.streamInfo?.(doc, 'fixture0001#comments');
    expect(info?.streamer).toBe(streamer);
    expect(info?.title).toBe('Fixture Quest Part 3: the frozen bridge');
  });

  it('cuts a long title', () => {
    const doc = load('/watch?v=fixture0001', 'youtube-comments');
    const heading = doc.querySelector('ytd-watch-metadata #title h1 yt-formatted-string');
    if (heading) heading.textContent = `  ${'long title '.repeat(60)}  `;
    const title = youtubeComments.streamInfo?.(doc, 'fixture0001#comments')?.title ?? '';
    expect(title.length).toBe(MAX_TITLE);
    expect(title.startsWith('long title long')).toBe(true);
  });

  it('calls back once the watch page shows the metadata of its video, then stops by itself', async () => {
    const doc = load('/watch?v=fixture0002', 'youtube-comments');
    const ready = vi.fn<() => void>();
    const stop = youtubeComments.watchStreamInfo?.(doc, 'fixture0002#comments', ready);
    flexy(doc).setAttribute('hidden-action', '');
    // Another video's metadata (a navigation in between) is not this session's.
    flexy(doc).setAttribute('video-id', 'fixture0009');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ready).not.toHaveBeenCalled();
    flexy(doc).setAttribute('video-id', 'fixture0002');
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    flexy(doc).setAttribute('video-id', 'fixture0003');
    flexy(doc).setAttribute('video-id', 'fixture0002');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ready).toHaveBeenCalledTimes(1);
    stop?.();
  });

  it('stops watching the watch page when the session stops first', async () => {
    const doc = load('/watch?v=fixture0002', 'youtube-comments');
    const ready = vi.fn<() => void>();
    const stop = youtubeComments.watchStreamInfo?.(doc, 'fixture0002#comments', ready);
    stop?.();
    flexy(doc).setAttribute('video-id', 'fixture0002');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ready).not.toHaveBeenCalled();
  });

  it('names the Twitch channel as the streamer and reads its stream title', () => {
    const doc = load('/fixturechannel', 'twitch-chat');
    expect(createTwitchChat('s1').streamInfo?.(doc, 'fixturechannel')).toEqual({
      streamer: 'fixturechannel',
      title: 'Fixture speedrun night: any% practice',
    });
    doc.querySelector('[data-a-target="stream-title"]')?.remove();
    expect(createTwitchChat('s1').streamInfo?.(doc, 'fixturechannel')).toEqual({
      streamer: 'fixturechannel',
    });
  });

  it("takes no Twitch title while the stream information still shows another channel's", () => {
    // In-app navigation changes the URL before Twitch renders the new channel's section.
    const doc = load('/secondchannel', 'twitch-chat');
    const twitch = createTwitchChat('s1');
    expect(twitch.streamInfo?.(doc, 'secondchannel')).toEqual({ streamer: 'secondchannel' });
    doc.querySelector('#live-channel-stream-information a')?.setAttribute('href', '/SecondChannel');
    expect(twitch.streamInfo?.(doc, 'secondchannel')).toEqual({
      streamer: 'secondchannel',
      title: 'Fixture speedrun night: any% practice',
    });
  });

  it('watches only the Twitch stream information until it shows the channel, then stops', async () => {
    const doc = load('/secondchannel', 'twitch-chat');
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    const ready = vi.fn<() => void>();
    const stop = createTwitchChat('s1').watchStreamInfo?.(doc, 'secondchannel', ready);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0]?.[0]).toBe(doc.querySelector('#live-channel-stream-information'));
    // The old channel's title changes: still not this channel's section.
    const title = doc.querySelector('[data-a-target="stream-title"]');
    if (title) title.textContent = 'Fixture speedrun night: still the first channel';
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ready).not.toHaveBeenCalled();
    // Twitch renders the new channel: its link and its title.
    doc.querySelector('#live-channel-stream-information a')?.setAttribute('href', '/secondchannel');
    if (title) title.textContent = 'Fixture marathon: second channel';
    await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    if (title) title.textContent = 'Fixture marathon: renamed';
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ready).toHaveBeenCalledTimes(1);
    stop?.();
    // Nothing to watch where the page has no stream information (a channel's videos page).
    doc.querySelector('#live-channel-stream-information')?.remove();
    observe.mockClear();
    const none = createTwitchChat('s1').watchStreamInfo?.(doc, 'secondchannel', ready);
    expect(observe).not.toHaveBeenCalled();
    none?.();
  });

  it('leaves the live chat frame without page stream info (the service worker knows it)', () => {
    expect(youtubeLiveChat.streamInfo).toBeUndefined();
  });
});

describe('stream keys and prompt context', () => {
  it.each([
    { partition: 'fixture0001', stream: 'fixture0001' },
    { partition: 'fixture0001#comments', stream: 'fixture0001' },
    { partition: 'fixturechannel', stream: 'fixturechannel' },
  ])('puts partition $partition in stream $stream', ({ partition, stream }) => {
    expect(streamOf(partition)).toBe(stream);
  });

  it('keys filters and feedback by the streamer, or by the stream while it is unknown', () => {
    expect(ownerOf({ partition: 'fixture0001#comments', streamer: '@FixtureStreamer' })).toBe(
      '@FixtureStreamer',
    );
    expect(ownerOf({ partition: 'fixture0001#comments' })).toBe('fixture0001');
  });

  it('writes the title and the spoiler targets for the prompt, nothing when unknown', () => {
    const base = { site: 'youtube', partition: 'fixture0001' } as const;
    expect(contextText(base)).toBe('');
    expect(
      contextText({ ...base, title: 'Fixture Quest Part 3', spoilerNote: 'past chapter 2' }),
    ).toBe('Title: Fixture Quest Part 3\nSpoiler targets: past chapter 2');
    expect(contextText({ ...base, spoilerNote: 'past chapter 2' })).toBe(
      'Spoiler targets: past chapter 2',
    );
  });

  it('hashes a context to a short stable key', () => {
    const a = contextHash('Title: Fixture Quest Part 3');
    expect(a).toMatch(/^[0-9a-f]{8}$/u);
    expect(contextHash('Title: Fixture Quest Part 3')).toBe(a);
    expect(contextHash('Title: Fixture Quest Part 4')).not.toBe(a);
    expect(contextHash('')).toMatch(/^[0-9a-f]{8}$/u);
  });
});

describe('createStreamContexts', () => {
  it('merges what the pages report and resolves a video comment partition to its stream', () => {
    const contexts = createStreamContexts();
    expect(contexts.get('youtube', 'fixture0001')).toEqual({
      site: 'youtube',
      partition: 'fixture0001',
    });
    // The live chat frame knows only the video; the watch page adds streamer and title.
    expect(contexts.report('youtube', 'fixture0001', {}).changed).toBe(true);
    expect(contexts.report('youtube', 'fixture0001', {}).changed).toBe(false);
    const reported = contexts.report('youtube', 'fixture0001#comments', {
      streamer: '@FixtureStreamer',
      title: 'Fixture Quest Part 3',
    });
    expect(reported).toEqual({
      changed: true,
      context: {
        site: 'youtube',
        partition: 'fixture0001',
        streamer: '@FixtureStreamer',
        title: 'Fixture Quest Part 3',
      },
    });
    // A later report without the metadata keeps what is known.
    expect(contexts.report('youtube', 'fixture0001', {}).changed).toBe(false);
    expect(contexts.get('youtube', 'fixture0001#comments')).toEqual(reported.context);
    expect(contexts.get('twitch', 'fixture0001')).toEqual({
      site: 'twitch',
      partition: 'fixture0001',
    });
  });

  it(`keeps the ${MAX_STREAMS} most recent streams`, () => {
    const contexts = createStreamContexts();
    for (let i = 0; i <= MAX_STREAMS; i += 1)
      contexts.report('youtube', `video${i}`, { streamer: `@streamer${i}` });
    expect(contexts.get('youtube', 'video0').streamer).toBeUndefined();
    expect(contexts.get('youtube', 'video1').streamer).toBe('@streamer1');
    expect(contexts.get('youtube', `video${MAX_STREAMS}`).streamer).toBe(`@streamer${MAX_STREAMS}`);
  });

  it("adds each stream's own spoiler note, not its streamer's (R30)", () => {
    const contexts = createStreamContexts();
    contexts.report('youtube', 'fixture0001', { streamer: '@FixtureStreamer' });
    contexts.report('youtube', 'fixture0002', { streamer: '@FixtureStreamer' });
    expect(contexts.notesKnown()).toBe(false);
    contexts.setNotes(
      new Map([
        ['youtube:fixture0001', 'past chapter 2'],
        ['twitch:fixturechannel', 'any% route'],
      ]),
    );
    expect(contexts.notesKnown()).toBe(true);
    expect(contexts.get('youtube', 'fixture0001#comments').spoilerNote).toBe('past chapter 2');
    // Another stream of the same streamer starts without one.
    expect(contexts.get('youtube', 'fixture0002')).not.toHaveProperty('spoilerNote');
    expect(contexts.get('twitch', 'fixturechannel').spoilerNote).toBe('any% route');
    contexts.clear();
    expect(contexts.notesKnown()).toBe(false);
    expect(contexts.get('youtube', 'fixture0001')).toEqual({
      site: 'youtube',
      partition: 'fixture0001',
    });
  });
});
