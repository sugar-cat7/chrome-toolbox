import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
import { panelPort, type PanelApi } from '../../src/panel.ts';
import { stateChangedSchema, type TabState } from '../../src/protocol.ts';
import { defaultSubtitleSettings, subtitleSettingsStore } from '../../src/settings.ts';

afterEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

/** An extension event the test fires itself. */
function fakeEvent<A extends unknown[]>() {
  const listeners = new Set<(...args: A) => void>();
  return {
    addListener: (listener: (...args: A) => void): void => {
      listeners.add(listener);
    },
    removeListener: (listener: (...args: A) => void): void => {
      listeners.delete(listener);
    },
    count: () => listeners.size,
    fire(...args: A): void {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}
const typeOf = (message: unknown): unknown =>
  typeof message === 'object' && message !== null && 'type' in message ? message.type : undefined;

const TAB: TabState = {
  tabId: 7,
  source: 'none',
  front: { state: 'away' },
  translator: { chosen: 'gemma' },
};
const STATE_CHANGED = { type: 'subs/state-changed', payload: {}, target: 'panel' };

/**
 * The side panel's extension APIs: storage is WXT's fake, the active tab of the window is 7 (or
 * none), and the service worker answers the tab state, the capability and `{}` otherwise.
 */
function fakeApi() {
  const sent: unknown[] = [];
  const events = {
    message: fakeEvent<[unknown]>(),
    activated: fakeEvent<[]>(),
    updated: fakeEvent<[number, { status?: string | undefined }]>(),
  };
  const shown: { tab: number | undefined } = { tab: 7 };
  const api: PanelApi = {
    storage: { local: fakeBrowser.storage.local },
    permissions: { contains: async () => true, request: async () => true },
    runtime: {
      sendMessage: async (message) => {
        sent.push(message);
        if (typeOf(message) === 'subs/tab-state') return Ok(TAB);
        if (typeOf(message) === 'subs/capability') return Ok({ audio: true });
        return Ok({});
      },
      onMessage: events.message,
    },
    tabs: {
      query: async () => [shown.tab === undefined ? {} : { id: shown.tab }],
      onActivated: events.activated,
      onUpdated: events.updated,
    },
  };
  return { api, sent, events, shown };
}

describe('side panel port', () => {
  it('registers nothing until watch is called and removes what watch added', () => {
    const { api, events } = fakeApi();
    const port = panelPort(api);
    const counts = () => [events.message.count(), events.activated.count(), events.updated.count()];
    expect(counts()).toEqual([0, 0, 0]);
    expect(fakeBrowser.storage.local.onChanged.hasListeners()).toBe(false);
    const stop = port.watch(() => undefined);
    expect(counts()).toEqual([1, 1, 1]);
    stop();
    expect(counts()).toEqual([0, 0, 0]);
  });

  it('asks the service worker about the active tab of its window, addressed to the background', async () => {
    const { api, sent } = fakeApi();
    const port = panelPort(api);
    expect(await port.tabState()).toEqual(Ok(TAB));
    expect(await port.capability()).toEqual(Ok({ audio: true, plamo: undefined }));
    expect(await port.display('ja')).toEqual(Ok(undefined));
    expect(await port.saveSubtitles({ source: 'audio' })).toEqual(Ok(undefined));
    // The tab it shows is the one it stops.
    expect(await port.stopAudio()).toEqual(Ok(undefined));
    expect(sent).toEqual([
      { type: 'subs/tab-state', payload: { tabId: 7 }, target: 'background' },
      { type: 'subs/capability', payload: {}, target: 'background' },
      { type: 'subs/display', payload: { mode: 'ja' }, target: 'background' },
      { type: 'subs/settings', payload: { patch: { source: 'audio' } }, target: 'background' },
      { type: 'subs/stop', payload: { tabId: 7 }, target: 'background' },
    ]);
  });

  it('shows no tab and stops nothing in a window without an active tab', async () => {
    const { api, sent, shown } = fakeApi();
    shown.tab = undefined;
    const port = panelPort(api);
    expect(await port.tabState()).toEqual(Ok(undefined));
    expect(await port.stopAudio()).toEqual(Ok(undefined));
    expect(sent).toEqual([]);
  });

  it('calls changed when another tab becomes active, the shown tab finishes loading or the service worker says so', async () => {
    const { api, events } = fakeApi();
    const port = panelPort(api);
    await port.tabState();
    const changed = vi.fn<() => void>();
    const stop = port.watch(changed);
    events.activated.fire();
    expect(changed).toHaveBeenCalledTimes(1);
    // Another tab's load and the shown tab's start of a load do not count.
    events.updated.fire(8, { status: 'complete' });
    events.updated.fire(7, { status: 'loading' });
    expect(changed).toHaveBeenCalledTimes(1);
    events.updated.fire(7, { status: 'complete' });
    expect(changed).toHaveBeenCalledTimes(2);
    events.message.fire(STATE_CHANGED);
    expect(changed).toHaveBeenCalledTimes(3);
    // Addressed to the panel, but not a state change.
    events.message.fire({ ...STATE_CHANGED, payload: { tabId: 7 } });
    events.message.fire({ type: 'subs/lines', payload: {}, target: 'panel' });
    expect(changed).toHaveBeenCalledTimes(3);
    stop();
    events.message.fire(STATE_CHANGED);
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('ignores runtime messages that are not addressed to the panel before decoding them', () => {
    const { api, events } = fakeApi();
    const decode = vi.spyOn(stateChangedSchema, 'safeParse');
    const changed = vi.fn<() => void>();
    const stop = panelPort(api).watch(changed);
    const read: PropertyKey[] = [];
    /** The message, with every property the panel reads or looks for written down. */
    const watched = (message: object): object =>
      new Proxy(message, {
        get(target, key, receiver) {
          read.push(key);
          return Reflect.get(target, key, receiver);
        },
        has(target, key) {
          read.push(key);
          return Reflect.has(target, key);
        },
      });
    // What the watch pages send to the service worker reaches every extension page too.
    for (const target of ['background', 'offscreen', 'content'])
      events.message.fire(watched({ ...STATE_CHANGED, target }));
    events.message.fire(watched({ type: 'subs/state-changed', payload: {} }));
    events.message.fire('subs/state-changed');
    events.message.fire(null);
    expect(decode).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(new Set(read)).toEqual(new Set(['target']));
    stop();
  });

  it('follows the saved subtitle settings only while asked to', async () => {
    const { api } = fakeApi();
    const port = panelPort(api);
    const followed = vi.fn<(settings: unknown) => void>();
    const stop = port.followSubtitles(followed);
    const store = subtitleSettingsStore(fakeBrowser.storage.local);
    await store.save({ ...defaultSubtitleSettings, display: 'off' });
    expect(followed).toHaveBeenCalledWith({ ...defaultSubtitleSettings, display: 'off' });
    stop();
    expect(fakeBrowser.storage.local.onChanged.hasListeners()).toBe(false);
    await store.save(defaultSubtitleSettings);
    expect(followed).toHaveBeenCalledOnce();
  });
});
