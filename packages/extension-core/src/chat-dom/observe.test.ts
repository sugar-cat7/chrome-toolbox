// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawChatComment } from '@chrome-toolbox/contracts';
import { observeComments, youtubeLiveChat, type ChatDomAdapter } from './index.ts';

/** A line with the same minimal structure as the YouTube live chat fixture. */
function message(id: string, text = id): Element {
  const line = document.createElement('yt-live-chat-text-message-renderer');
  line.id = id;
  const author = document.createElement('span');
  author.id = 'author-name';
  author.textContent = 'viewer';
  const body = document.createElement('span');
  body.id = 'message';
  body.textContent = text;
  line.append(author, body);
  return line;
}

/** A new container whose existing children are a snapshot, rather than new arrivals. */
function list(...ids: string[]): Element {
  const renderer = document.createElement('yt-live-chat-item-list-renderer');
  const items = document.createElement('div');
  items.id = 'items';
  items.append(...ids.map((id) => message(id)));
  renderer.append(items);
  return renderer;
}

describe('background chat observation', () => {
  const stops: (() => void)[] = [];
  let app: Element;
  let batches: { comments: RawChatComment[]; process: boolean }[];
  const container = (): Element => {
    const items = youtubeLiveChat.container(document);
    if (!items) throw new Error('Missing chat container');
    return items;
  };
  const start = (
    onContainer?: (items: Element | null) => void,
    adapter: ChatDomAdapter & Readonly<{ nearMargin?: string }> = youtubeLiveChat,
  ): (() => void) => {
    const stop = observeComments(
      adapter,
      document,
      (comments, process) => batches.push({ comments, process }),
      undefined,
      { mode: 'background', ...(onContainer === undefined ? {} : { onContainer }) },
    );
    stops.push(stop);
    return stop;
  };
  const ids = (): string[][] => batches.map(({ comments }) => comments.map(({ id }) => id));

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
    app = document.createElement('yt-live-chat-app');
    app.append(list('old-1', 'old-2'));
    document.body.append(app);
    batches = [];
    // No IntersectionObserver is available in jsdom. Background must never construct one.
    vi.stubGlobal('IntersectionObserver', undefined);
  });
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('ignores the initial snapshot and reads new lines while hidden with no viewport', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.stubGlobal('innerWidth', 0);
    vi.stubGlobal('innerHeight', 0);
    expect(window.innerWidth).toBe(0);
    expect(window.innerHeight).toBe(0);
    const read = vi.spyOn(youtubeLiveChat, 'read');
    start();
    await vi.advanceTimersByTimeAsync(1200);
    expect(batches).toEqual([]);
    expect(read).not.toHaveBeenCalled();

    const old = container().firstElementChild;
    if (!old) throw new Error('Missing snapshot line');
    container().append(old, message('new-1'), message('new-2'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('resize'));
    await vi.advanceTimersByTimeAsync(300);
    expect(ids()).toEqual([['new-1', 'new-2']]);
    expect(batches.every(({ process }) => process)).toBe(true);
  });

  it('reads filled-in lines at flush, skipping removed lines and duplicate elements', async () => {
    start();
    const late = message('', '');
    const removed = message('removed');
    container().append(late, removed);
    await vi.advanceTimersByTimeAsync(100);
    late.id = 'late';
    const text = late.querySelector('#message');
    if (!text) throw new Error('Missing text holder');
    text.textContent = 'filled in late';
    container().append(late);
    removed.remove();
    await vi.advanceTimersByTimeAsync(300);
    expect(ids()).toEqual([['late']]);
    expect(batches[0]?.comments[0]?.text).toBe('filled in late');
    container().append(late);
    await vi.advanceTimersByTimeAsync(300);
    expect(ids()).toEqual([['late']]);
  });

  it('bounds pending lines to the newest 1000', async () => {
    start();
    const lines = Array.from({ length: 1200 }, (_, index) => message(`new-${index}`));
    container().append(...lines);
    await vi.advanceTimersByTimeAsync(300);
    expect(ids()).toEqual([lines.slice(-1000).map((line) => line.id)]);
  });

  it('ignores nearMargin in background without intersection support', async () => {
    start(undefined, { ...youtubeLiveChat, nearMargin: '100% 0px' });
    container().append(message('new'));
    await vi.advanceTimersByTimeAsync(300);
    expect(ids()).toEqual([['new']]);
  });

  it('waits for a missing container without polling after stop', async () => {
    app.replaceChildren();
    const find = vi.fn<(doc: Document) => Element | null>(youtubeLiveChat.container);
    const stop = start(undefined, { ...youtubeLiveChat, container: find });
    // The waiting subtree schedules one check and then disconnects until it runs.
    app.append(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    stop();
    app.append(list('late-old'));
    await vi.advanceTimersByTimeAsync(1500);
    expect(find).toHaveBeenCalledTimes(1);
    expect(batches).toEqual([]);
  });

  it('seeds late and replacement containers without replaying snapshots', async () => {
    app.replaceChildren();
    const containers: (Element | null)[] = [];
    start((items) => containers.push(items));
    app.append(list('late-old'));
    await vi.advanceTimersByTimeAsync(1200);
    expect(containers).toEqual([null, container()]);
    expect(batches).toEqual([]);
    container().append(message('before-replacement'));
    await vi.advanceTimersByTimeAsync(300);
    app.replaceChildren(list('late-old', 'before-replacement'));
    await vi.advanceTimersByTimeAsync(300);
    container().append(message('after-replacement'));
    await vi.advanceTimersByTimeAsync(300);
    expect(ids()).toEqual([['before-replacement'], ['after-replacement']]);
    expect(containers).toHaveLength(3);
  });

  it.each(['stop', 'pagehide'])(
    'disconnects observers, listeners and pending timers on %s',
    async (action) => {
      const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
      const remove = vi.spyOn(window, 'removeEventListener');
      const stop = start();
      disconnect.mockClear();
      container().append(message('pending'));
      container().parentElement?.append(document.createElement('span'));
      // Deliver the mutations so both the flush and the ancestor recheck have timers.
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(2);
      if (action === 'stop') stop();
      else window.dispatchEvent(new Event('pagehide'));
      expect(disconnect).toHaveBeenCalledTimes(2);
      expect(remove).toHaveBeenCalledWith('pagehide', expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
      app.replaceChildren(list('replacement'));
      container().append(message('after-stop'));
      window.dispatchEvent(new Event('pageshow'));
      await vi.advanceTimersByTimeAsync(1500);
      expect(batches).toEqual([]);
      stop();
    },
  );
});
