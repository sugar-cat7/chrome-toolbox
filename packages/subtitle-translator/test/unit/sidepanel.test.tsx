// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import { PLAMO_LICENSE_URL } from '@chrome-toolbox/extension-core';
import { App } from '../../src/entrypoints/sidepanel/App.tsx';
import { glossaryStore, type GlossaryEntry } from '../../src/glossary.ts';
import type { TranslatorStatus } from '../../src/line-translator.ts';
import type { PageInfo } from '../../src/page-context.ts';
import { panelPort, type PanelApi } from '../../src/panel.ts';
import { subtitleProtocolSpec, type TabState } from '../../src/protocol.ts';
import {
  DISPLAY_MODES,
  defaultSubtitleSettings,
  subtitleSettingsStore,
  type DisplayMode,
} from '../../src/settings.ts';

afterEach(() => {
  cleanup();
  fakeBrowser.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Every name and text below is made up. */
const PAGE: PageInfo = {
  videoId: 'fixture-v01',
  streamer: 'UC-fixture',
  title: 'Fixture Quest day 3',
  author: 'Fixture Ch',
  live: false,
  tracks: 2,
};
const CAPTION_TAB: TabState = {
  tabId: 7,
  page: PAGE,
  source: 'captions',
  front: { state: 'active' },
  translator: { chosen: 'gemma' },
};
/** A captured live stream; `session` is the offscreen translator, `background` the caption one. */
const audioTab = ({
  session = { chosen: 'gemma' },
  background = { chosen: 'gemma' },
}: { session?: TranslatorStatus; background?: TranslatorStatus } = {}): TabState => ({
  tabId: 7,
  page: { ...PAGE, live: true, tracks: 0 },
  source: 'audio',
  front: { state: 'active' },
  session: {
    tabId: 7,
    startedAt: 1,
    front: { state: 'active' },
    stats: {
      segments: 12,
      silent: 2,
      dropped: 1,
      expired: 3,
      skipped: 0,
      failed: 0,
      lang: 'en',
      sourceP50Ms: 640,
      jaP50Ms: 1520,
      jaP95Ms: 2610,
    },
    translator: session,
  },
  translator: background,
});
const DISPLAY_LABELS: Readonly<Record<DisplayMode, string>> = {
  ja: '日本語のみ',
  both: '原語と日本語',
  source: '原語のみ',
  off: 'オフ',
};
const START_GUIDE = 'ツールバーのアイコンか Alt+Shift+S で開始';
const store = () => subtitleSettingsStore(fakeBrowser.storage.local);

type Route = (payload: unknown) => Promise<Result<unknown>>;
type Sent = { type: string; payload: unknown };
const sentOf = (message: unknown): Sent | undefined =>
  typeof message === 'object' &&
  message !== null &&
  'type' in message &&
  typeof message.type === 'string' &&
  'payload' in message
    ? { type: message.type, payload: message.payload }
    : undefined;

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

/**
 * The side panel's extension APIs: storage is WXT's fake (the panel's own writes are recorded),
 * the active tab is 7, and the service worker answers from `routes`. Like the service worker,
 * `subs/display` and `subs/settings` save their fields over the stored settings.
 */
function fakeApi(routes: Partial<Record<string, Route>> = {}) {
  const sent: Sent[] = [];
  const writes: string[] = [];
  const events = {
    message: fakeEvent<[unknown]>(),
    activated: fakeEvent<[]>(),
    updated: fakeEvent<[number, { status?: string | undefined }]>(),
  };
  const defaults: Record<string, Route> = {
    'subs/tab-state': async () => Ok(CAPTION_TAB),
    'subs/capability': async () => Ok({ audio: true, plamo: true }),
    'subs/stop': async () => Ok({}),
    'subs/display': async (payload) => {
      const request = subtitleProtocolSpec['subs/display'].request.safeParse(payload);
      if (!request.success) return Err(failure('input_invalid'));
      const loaded = await store().load();
      if (!loaded.ok) return loaded;
      const saved = await store().save({ ...loaded.value, display: request.data.mode });
      return saved.ok ? Ok({}) : saved;
    },
    'subs/settings': async (payload) => {
      const request = subtitleProtocolSpec['subs/settings'].request.safeParse(payload);
      if (!request.success) return Err(failure('input_invalid'));
      const loaded = await store().load();
      if (!loaded.ok) return loaded;
      const saved = await store().save({ ...loaded.value, ...request.data.patch });
      return saved.ok ? Ok({}) : saved;
    },
  };
  const local = fakeBrowser.storage.local;
  const api: PanelApi = {
    storage: {
      local: {
        get: (key) => local.get(key),
        set: (items) => {
          writes.push(...Object.keys(items));
          return local.set(items);
        },
        remove: (keys) => local.remove(keys),
        onChanged: local.onChanged,
      },
    },
    permissions: { contains: async () => true, request: async () => true },
    runtime: {
      sendMessage: async (message) => {
        const known = sentOf(message);
        if (known === undefined) return Err(failure('input_invalid'));
        sent.push(known);
        const route = routes[known.type] ?? defaults[known.type];
        return route === undefined ? Err(failure('input_invalid')) : route(known.payload);
      },
      onMessage: events.message,
    },
    tabs: {
      query: async () => [{ id: 7 }],
      onActivated: events.activated,
      onUpdated: events.updated,
    },
  };
  return {
    api,
    events,
    writes,
    /** The payloads of the messages of `type`, in the order sent. */
    of: (type: string) => sent.filter((message) => message.type === type).map((m) => m.payload),
  };
}

/** Renders the panel and waits until the tab state and the subtitle settings are shown. */
async function open(api: PanelApi, chosen: DisplayMode = 'both'): Promise<void> {
  render(<App port={panelPort(api)} />);
  await screen.findByRole('radio', { name: DISPLAY_LABELS[chosen], checked: true });
  await screen.findByText('Fixture Quest day 3');
}
const region = (name: string): HTMLElement => screen.getByRole('region', { name });
/** The value next to a row name of the status. */
const statusValue = (name: string): string | null | undefined =>
  within(region('状態')).getByText(name).nextElementSibling?.textContent;

describe('side panel', () => {
  it('stops the captured tab from the button and shows the start guide otherwise', async () => {
    let tab = audioTab();
    const { api, of } = fakeApi({ 'subs/tab-state': async () => Ok(tab) });
    await open(api);
    const audio = region('音声');
    const stop = await within(audio).findByRole('button', { name: '停止' });
    expect(within(audio).queryByText(START_GUIDE)).toBeNull();
    tab = CAPTION_TAB;
    await userEvent.click(stop);
    await vi.waitFor(() => {
      expect(of('subs/stop')).toEqual([{ tabId: 7 }]);
    });
    // Asked again: the tab is not captured, and the panel cannot start it (S46).
    expect(await within(audio).findByText(START_GUIDE)).toBeTruthy();
    expect(within(audio).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /開始/u })).toBeNull();
    expect(of('subs/stop')).toHaveLength(1);
  });

  it('says the capture is starting until the service worker tells the panel it started', async () => {
    let tab: TabState = { ...CAPTION_TAB, starting: true };
    const { api, events } = fakeApi({ 'subs/tab-state': async () => Ok(tab) });
    await open(api);
    const audio = region('音声');
    expect(await within(audio).findByText('開始しています…')).toBeTruthy();
    expect(within(audio).queryByText(START_GUIDE)).toBeNull();
    expect(within(audio).queryByRole('button')).toBeNull();
    tab = audioTab();
    events.message.fire({ type: 'subs/state-changed', payload: {}, target: 'panel' });
    expect(await within(audio).findByRole('button', { name: '停止' })).toBeTruthy();
    expect(within(audio).queryByText('開始しています…')).toBeNull();
  });

  it('explains a missing projector with the llama-server.md guidance', async () => {
    const { api } = fakeApi({ 'subs/capability': async () => Ok({ audio: false }) });
    await open(api);
    expect(
      await within(region('音声')).findByText(
        '音声入力が使えません。llama.cpp のプリセットで mmproj を有効にして、サーバーを再起動してください（docs/llama-server.md）',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('音声入力: 使えます')).toBeNull();
  });

  it('says when the server takes audio input', async () => {
    const { api } = fakeApi();
    await open(api);
    expect(await within(region('音声')).findByText('音声入力: 使えます')).toBeTruthy();
    expect(within(region('音声')).getByText(START_GUIDE)).toBeTruthy();
  });

  it('shows Built with PLaMo and the license link only while PLaMo is chosen', async () => {
    const { api, of } = fakeApi();
    await open(api);
    const gemma = screen.getByRole('radio', { name: 'Gemma（既定）' });
    expect(gemma).toHaveProperty('checked', true);
    expect(screen.queryByText('Built with PLaMo')).toBeNull();
    expect(screen.queryByRole('link', { name: 'PLaMo Community License' })).toBeNull();

    await userEvent.click(
      screen.getByRole('radio', { name: 'PLaMo 3 Translate 2B（速い・任意）' }),
    );
    expect(await screen.findByText('Built with PLaMo')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'PLaMo Community License' });
    expect(link.getAttribute('href')).toBe(PLAMO_LICENSE_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(
      screen.getByText('PLaMo は llama.cpp のサーバーに別に入れます（docs/llama-server.md）'),
    ).toBeTruthy();
    expect(of('subs/settings')).toEqual([{ patch: { translator: 'plamo' } }]);
    await vi.waitFor(async () => {
      expect(await store().load()).toEqual(Ok({ ...defaultSubtitleSettings, translator: 'plamo' }));
    });

    await userEvent.click(gemma);
    await vi.waitFor(() => {
      expect(screen.queryByText('Built with PLaMo')).toBeNull();
    });
    expect(screen.queryByRole('link', { name: 'PLaMo Community License' })).toBeNull();
    expect(of('subs/settings')).toEqual([
      { patch: { translator: 'plamo' } },
      { patch: { translator: 'gemma' } },
    ]);
  });

  /** A caption translator status that must not show on the audio path. */
  const decoy: TranslatorStatus = {
    chosen: 'plamo',
    fallback: { latest: 'language', lines: { not_listed: 4, refused: 0, language: 9 } },
  };
  it.each([
    {
      name: 'サーバーにない',
      capability: { plamo: false },
      texts: ['サーバーに plamo-3-translate-2b がないため、Gemma で訳しています'],
    },
    {
      name: 'サーバーにない（訳した行から）',
      fallback: { latest: 'not_listed', lines: { not_listed: 5, refused: 0, language: 0 } },
      texts: ['サーバーに plamo-3-translate-2b がないため、Gemma で訳しています'],
    },
    {
      name: 'エラー',
      fallback: { latest: 'refused', lines: { not_listed: 0, refused: 3, language: 0 } },
      texts: ['PLaMo がエラーを返した 3 行を Gemma で訳しました'],
    },
    {
      name: '対応していない言語',
      fallback: { latest: 'language', lines: { not_listed: 0, refused: 0, language: 2 } },
      texts: ['PLaMo が対応していない言語の 2 行を Gemma で訳しました'],
    },
    {
      name: '理由が 2 つ（直近を先に）',
      fallback: { latest: 'refused', lines: { not_listed: 0, refused: 1, language: 1 } },
      texts: [
        'PLaMo がエラーを返した 1 行を Gemma で訳しました',
        'PLaMo が対応していない言語の 1 行を Gemma で訳しました',
      ],
    },
    {
      name: '理由が 3 つ（直近を先に）',
      capability: { plamo: false },
      fallback: { latest: 'language', lines: { not_listed: 0, refused: 2, language: 1 } },
      texts: [
        'PLaMo が対応していない言語の 1 行を Gemma で訳しました',
        'サーバーに plamo-3-translate-2b がないため、Gemma で訳しています',
        'PLaMo がエラーを返した 2 行を Gemma で訳しました',
      ],
    },
  ] satisfies {
    name: string;
    capability?: { plamo: boolean };
    fallback?: TranslatorStatus['fallback'];
    texts: string[];
  }[])('says that lines fell back to Gemma: $name', async (row) => {
    await store().save({ ...defaultSubtitleSettings, translator: 'plamo' });
    const session: TranslatorStatus =
      row.fallback === undefined
        ? { chosen: 'plamo' }
        : { chosen: 'plamo', fallback: row.fallback };
    const { api } = fakeApi({
      // The audio path: the offscreen translator's status, not the caption one's.
      'subs/tab-state': async () => Ok(audioTab({ session, background: decoy })),
      'subs/capability': async () => Ok({ audio: true, ...row.capability }),
    });
    await open(api);
    await screen.findByText('音声入力: 使えます');
    const list = await screen.findByRole('list', { name: 'Gemma で訳した行' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(row.texts);
  });

  it('says nothing about Gemma while Gemma is chosen, and uses the caption translator on the caption path', async () => {
    const fallback: TranslatorStatus['fallback'] = {
      latest: 'refused',
      lines: { not_listed: 0, refused: 6, language: 0 },
    };
    const { api } = fakeApi({
      'subs/tab-state': async () =>
        Ok({ ...CAPTION_TAB, translator: { chosen: 'plamo', fallback } }),
      'subs/capability': async () => Ok({ audio: true, plamo: false }),
    });
    await open(api);
    await screen.findByText('音声入力: 使えます');
    expect(screen.queryByRole('list', { name: 'Gemma で訳した行' })).toBeNull();
    await userEvent.click(
      screen.getByRole('radio', { name: 'PLaMo 3 Translate 2B（速い・任意）' }),
    );
    const list = await screen.findByRole('list', { name: 'Gemma で訳した行' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'PLaMo がエラーを返した 6 行を Gemma で訳しました',
      'サーバーに plamo-3-translate-2b がないため、Gemma で訳しています',
    ]);
  });

  it.each(DISPLAY_MODES)('sends the display mode %s with subs/display', async (mode) => {
    const saved = mode === 'both' ? 'ja' : 'both';
    await store().save({ ...defaultSubtitleSettings, display: saved });
    const { api, of, writes } = fakeApi();
    await open(api, saved);
    expect(
      screen.getByText('プレイヤーの右上のボタンか Alt+Shift+J でも切り替えられます'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: DISPLAY_LABELS[mode] }));
    await vi.waitFor(() => {
      expect(of('subs/display')).toEqual([{ mode }]);
    });
    expect(
      await screen.findByRole('radio', { name: DISPLAY_LABELS[mode], checked: true }),
    ).toBeTruthy();
    // Never the whole subtitle settings: the service worker saves the mode over the latest ones.
    expect(of('subs/settings')).toEqual([]);
    expect(writes).not.toContain('subtitles');
  });

  it('saves only the field the viewer changed', async () => {
    const { api, of, writes } = fakeApi();
    await open(api);
    expect(screen.getByRole('radio', { name: '自動' })).toHaveProperty('checked', true);
    // The player button switches the display meanwhile (the service worker saves it).
    await store().save({ ...defaultSubtitleSettings, display: 'off' });
    expect(await screen.findByRole('radio', { name: 'オフ', checked: true })).toBeTruthy();

    await userEvent.click(screen.getByRole('radio', { name: '音声' }));
    await vi.waitFor(() => {
      expect(of('subs/settings')).toEqual([{ patch: { source: 'audio' } }]);
    });
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: '話されている言語' }),
      '韓国語',
    );
    await vi.waitFor(() => {
      expect(of('subs/settings')).toEqual([
        { patch: { source: 'audio' } },
        { patch: { sourceLang: 'ko' } },
      ]);
    });
    await vi.waitFor(async () => {
      expect(await store().load()).toEqual(
        Ok({ ...defaultSubtitleSettings, display: 'off', source: 'audio', sourceLang: 'ko' }),
      );
    });
    expect(of('subs/display')).toEqual([]);
    expect(writes).not.toContain('subtitles');
    expect(screen.getByRole('radio', { name: 'オフ' })).toHaveProperty('checked', true);
  });

  it('adds and removes glossary entries and refuses the 51st', async () => {
    const terms: GlossaryEntry[] = Array.from({ length: 49 }, (_, index) => ({
      source: `Term${index + 1}`,
      target: `用語${index + 1}`,
    }));
    const glossary = glossaryStore(fakeBrowser.storage.local);
    expect(await glossary.save('UC-fixture', terms)).toMatchObject({ ok: true });
    const { api } = fakeApi();
    await open(api);
    const section = region('用語集');
    // The streamer's name heads the glossary.
    expect(within(section).getByRole('heading', { name: 'Fixture Ch' })).toBeTruthy();
    expect(await within(section).findByText('Term49')).toBeTruthy();

    await userEvent.type(within(section).getByLabelText('原文'), 'Fixturo');
    await userEvent.click(within(section).getByRole('button', { name: '追加' }));
    const added = await within(section).findByText('Fixturo');
    expect(added.closest('li')?.textContent).toContain('原文のまま');
    expect(await glossary.load('UC-fixture')).toEqual(
      Ok([...terms, { source: 'Fixturo', target: '' }]),
    );

    await userEvent.type(within(section).getByLabelText('原文'), 'Extra');
    await userEvent.type(within(section).getByLabelText('訳'), '追加分');
    await userEvent.click(within(section).getByRole('button', { name: '追加' }));
    expect(await within(section).findByText('用語集は 50 件までです')).toBeTruthy();
    expect(within(section).queryByText('Extra')).toBeNull();
    expect(await glossary.load('UC-fixture')).toMatchObject({ ok: true, value: { length: 50 } });

    await userEvent.click(within(section).getByRole('button', { name: 'Fixturo を削除' }));
    await vi.waitFor(() => {
      expect(within(section).queryByText('Fixturo')).toBeNull();
    });
    expect(await glossary.load('UC-fixture')).toEqual(Ok(terms));
  });

  it('disables the glossary when the streamer is unknown', async () => {
    const { streamer: _unknown, ...page } = PAGE;
    const { api } = fakeApi({ 'subs/tab-state': async () => Ok({ ...CAPTION_TAB, page }) });
    await open(api);
    const section = region('用語集');
    expect(
      await within(section).findByText('配信者が分からないため、用語集は使えません'),
    ).toBeTruthy();
    expect(within(section).getByLabelText('原文')).toHaveProperty('disabled', true);
    expect(within(section).getByLabelText('訳')).toHaveProperty('disabled', true);
    expect(within(section).getByRole('button', { name: '追加' })).toHaveProperty('disabled', true);
  });

  it('keeps typed model names when the saved settings load late', async () => {
    const { api } = fakeApi();
    const port = panelPort(api);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = port.settings.load;
    render(
      <App
        port={{
          ...port,
          settings: {
            ...port.settings,
            // The first read is late; the one before saving answers at once.
            load: vi
              .fn<typeof load>()
              .mockImplementationOnce(async () => {
                await held;
                return load();
              })
              .mockImplementation(load),
          },
        }}
      />,
    );
    const translate = await screen.findByLabelText('翻訳モデル（Gemma）');
    await userEvent.type(translate, 'gemma4-e2b');
    await act(async () => {
      release();
      await held;
    });
    const asr = screen.getByLabelText('音声認識モデル');
    await vi.waitFor(() => {
      expect(asr).toHaveProperty('value', 'gemma4-e4b');
    });
    expect(translate).toHaveProperty('value', 'gemma4-e2b');
    await userEvent.clear(asr);
    await userEvent.type(asr, 'gemma4-e4b-audio');
    await userEvent.click(screen.getByRole('button', { name: 'モデル名を保存' }));
    expect(await screen.findByText('モデル名を保存しました')).toBeTruthy();
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({
      settings: {
        llamaBaseUrl: 'http://127.0.0.1:18083',
        models: { translate: 'gemma4-e2b', clef: 'clef-flash', asr: 'gemma4-e4b-audio' },
      },
    });
  });

  it('asks for the tab state on open, on tab change and on 更新 only', async () => {
    const { api, events, of } = fakeApi();
    const view = render(<App port={panelPort(api)} />);
    await screen.findByText('Fixture Quest day 3');
    expect(of('subs/tab-state')).toEqual([{ tabId: 7 }]);
    expect(of('subs/capability')).toHaveLength(1);
    // No polling.
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    vi.useRealTimers();
    expect(of('subs/tab-state')).toHaveLength(1);

    events.activated.fire();
    await vi.waitFor(() => {
      expect(of('subs/tab-state')).toHaveLength(2);
    });
    events.updated.fire(99, { status: 'complete' });
    events.updated.fire(7, { status: 'loading' });
    events.message.fire({ type: 'subs/state-changed', payload: {}, target: 'content' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(of('subs/tab-state')).toHaveLength(2);
    events.updated.fire(7, { status: 'complete' });
    await vi.waitFor(() => {
      expect(of('subs/tab-state')).toHaveLength(3);
    });
    events.message.fire({ type: 'subs/state-changed', payload: {}, target: 'panel' });
    await vi.waitFor(() => {
      expect(of('subs/tab-state')).toHaveLength(4);
    });
    // The server is asked about audio and PLaMo only on open and on 更新.
    expect(of('subs/capability')).toHaveLength(1);
    await userEvent.click(within(region('状態')).getByRole('button', { name: '更新' }));
    await vi.waitFor(() => {
      expect(of('subs/tab-state')).toHaveLength(5);
    });
    expect(of('subs/capability')).toHaveLength(2);

    view.unmount();
    expect([events.activated.count(), events.updated.count(), events.message.count()]).toEqual([
      0, 0, 0,
    ]);
    expect(fakeBrowser.storage.local.onChanged.hasListeners()).toBe(false);
  });

  it('shows the source, language, latency and counts of a captured tab', async () => {
    const { api } = fakeApi({ 'subs/tab-state': async () => Ok(audioTab()) });
    await open(api);
    expect(statusValue('字幕の取得元')).toBe('音声認識');
    expect(statusValue('言語')).toBe('英語');
    expect(statusValue('原語の応答（p50）')).toBe('0.6 秒');
    expect(statusValue('日本語の応答（p50 / p95）')).toBe('1.5 秒 / 2.6 秒');
    expect(statusValue('処理しきれず')).toBe('4 件');
    expect(statusValue('無音')).toBe('2 件');
    expect(statusValue('処理')).toBe('処理しています');
  });

  it.each([
    { reason: 'paused', state: 'pause', text: '止まっています（一時停止中）' },
    { reason: 'muted', state: 'pause', text: '止まっています（ミュート）' },
    { reason: 'hidden', state: 'away', text: '止まっています（裏のタブ）' },
    { reason: 'ad', state: 'away', text: '止まっています（広告）' },
    { reason: 'offscreen', state: 'away', text: '止まっています（プレイヤーが画面外）' },
    { reason: 'display-off', state: 'away', text: '止まっています（表示オフ）' },
  ] as const)(
    'says why the shown tab is not processed: $reason',
    async ({ reason, state, text }) => {
      const { api } = fakeApi({
        'subs/tab-state': async () => Ok({ ...CAPTION_TAB, front: { state, reason } }),
      });
      await open(api);
      expect(statusValue('字幕の取得元')).toBe('字幕トラック');
      expect(statusValue('処理')).toBe(text);
      // The caption path has no speech latency or counts.
      expect(within(region('状態')).queryByText('処理しきれず')).toBeNull();
    },
  );

  it('explains a tab without a YouTube video', async () => {
    const { api } = fakeApi({
      'subs/tab-state': async () =>
        Ok({ tabId: 7, source: 'none', front: { state: 'away' }, translator: { chosen: 'gemma' } }),
    });
    render(<App port={panelPort(api)} />);
    expect(await screen.findByText('このタブには YouTube の動画がありません')).toBeTruthy();
    expect(statusValue('字幕の取得元')).toBe('なし');
    expect(
      within(region('用語集')).getByText('配信者が分からないため、用語集は使えません'),
    ).toBeTruthy();
  });
});
