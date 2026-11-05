// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import { App } from '../../src/entrypoints/sidepanel/App.tsx';
import { defaultFilterSettings, filterKey } from '../../src/filters.ts';
import { panelPort, type PanelApi } from '../../src/panel.ts';
import {
  streamChangedMessageSchema,
  summaryWindowSchema,
  type HiddenEntry,
  type Summary,
} from '../../src/protocol.ts';
import type { StreamContext } from '../../src/stream-context.ts';

afterEach(() => {
  cleanup();
  fakeBrowser.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AT = Date.UTC(2026, 9, 28, 12, 34, 56);
const stream = {
  site: 'youtube',
  partition: 'fixture0001',
  streamer: '@FixtureStreamer',
  title: 'Fixture Quest Part 3',
} as const;
const hiddenEntry = (id: string, at: number, extra: Partial<HiddenEntry> = {}): HiddenEntry => ({
  id,
  site: 'youtube',
  channel: 'fixture0001',
  text: `fixture text ${id}`,
  category: 'abusive',
  at,
  ...extra,
});
const MINUTE = 60_000;
/** A summary as the service worker makes it; every text is made up. */
const summaryOf = (windowMinutes: number, extra: Partial<Summary> = {}): Summary => ({
  windowMinutes: summaryWindowSchema.parse(windowMinutes),
  total: 1284,
  languages: ['und-Latn', 'ko', 'ja'],
  from: AT - windowMinutes * MINUTE,
  generatedAt: AT,
  topics: ['ボス戦の攻略', '次回の配信日程'],
  questions: [
    { text: '第2形態の長さ', count: 6 },
    { text: '使っている武器', count: 4 },
  ],
  peaks: [
    { minute: Math.floor(AT / MINUTE) * MINUTE - 4 * MINUTE, count: 30, label: '第1形態の撃破' },
    { minute: Math.floor(AT / MINUTE) * MINUTE - 2 * MINUTE, count: 55 },
  ],
  important: [{ author: 'mod_fixture', text: '次回は土曜 21時（JST）', at: AT - MINUTE }],
  unprocessed: 0,
  ...extra,
});
type Message = { type: string; payload: Record<string, unknown> };
type Listener = (...args: never[]) => void;
/** One extension event: the listeners the panel added and not yet removed. */
const fakeEvent = () => {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addListener: (listener: Listener) => void listeners.add(listener),
    removeListener: (listener: Listener) => void listeners.delete(listener),
  };
};

/**
 * The side panel's extension APIs: storage is WXT's fake, the active tab is 7 and the service
 * worker answers from `routes` (a hidden list that `ok` verdicts shrink, like the pipeline).
 */
function fakeApi(
  routes: Partial<Record<string, (payload: Record<string, unknown>) => Result<unknown>>> = {},
) {
  const sent: Message[] = [];
  let hidden = [
    hiddenEntry('h1', AT - 2000, { translation: '訳:fixture text h1', abusive: 0.87 }),
    hiddenEntry('h2', AT, { category: 'spam' }),
  ];
  const comments = [
    hiddenEntry('c1', AT - 1000, { channel: 'fixture0001#comments', category: 'spoiler' }),
  ];
  const defaults: Record<string, (payload: Record<string, unknown>) => Result<unknown>> = {
    'comments/stream': () => Ok({ stream }),
    'comments/hidden': ({ channel }) => Ok(channel === 'fixture0001' ? hidden : comments),
    'comments/feedback': ({ id, verdict }) => {
      if (verdict === 'ok') hidden = hidden.filter((entry) => entry.id !== id);
      return Ok({ persisted: true });
    },
    'comments/export': () => Ok({ jsonl: '{"text":"fixture text h1","verdict":"ok"}\n' }),
    'comments/feedback/clear': () => Ok({}),
    'comments/summary': ({ windowMinutes }) => Ok(summaryOf(Number(windowMinutes))),
    'comments/stats': () =>
      Ok({
        records: 3,
        stored: 0,
        pending: 0,
        dropped: 0,
        unstored: 0,
        failed: 0,
        cached: 0,
        trivial: 0,
        expired: 0,
        clefSkipped: 0,
        judge: 'clef',
      }),
  };
  const events = {
    message: fakeEvent(),
    activated: fakeEvent(),
    updated: fakeEvent(),
  };
  const api: PanelApi = {
    storage: { local: fakeBrowser.storage.local },
    permissions: { contains: async () => true, request: async () => true },
    runtime: {
      sendMessage: async (message) => {
        const { type, payload } = message as Message;
        sent.push({ type, payload });
        const route = routes[type] ?? defaults[type];
        return route ? route(payload) : Err(failure('input_invalid'));
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
    sent,
    events,
    of: (type: string) => sent.filter((m) => m.type === type),
  };
}

const openTab = async (name: string): Promise<HTMLElement> => {
  await userEvent.click(screen.getByRole('tab', { name }));
  return screen.getByRole('tabpanel');
};

describe('side panel', () => {
  it("shows the active tab's stream with the summary, filter, hidden and settings tabs", async () => {
    const { api, of } = fakeApi();
    render(<App port={panelPort(api)} />);
    expect(await screen.findByText('Fixture Quest Part 3')).toBeTruthy();
    expect(screen.getByText('@FixtureStreamer')).toBeTruthy();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '要約',
      'フィルター',
      '非表示',
      '設定',
    ]);
    expect(of('comments/stream')).toEqual([{ type: 'comments/stream', payload: { tabId: 7 } }]);
    // The panel opens on the summary of the stream's chat.
    expect(await within(screen.getByRole('tabpanel')).findByText('ボス戦の攻略')).toBeTruthy();
  });

  it('summarizes the chat for the chosen window and keeps the last summary when a refresh fails', async () => {
    let failing = false;
    const { api, of } = fakeApi({
      'comments/summary': ({ windowMinutes }) =>
        failing ? Err(failure('network_failed')) : Ok(summaryOf(Number(windowMinutes))),
    });
    render(<App port={panelPort(api)} />);
    const panel = screen.getByRole('tabpanel');
    expect(await within(panel).findByText('ボス戦の攻略')).toBeTruthy();
    expect(of('comments/summary').map((m) => m.payload)).toEqual([
      { site: 'youtube', channel: 'fixture0001', windowMinutes: 15 },
    ]);
    expect(within(panel).getByRole('button', { name: '15分' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // Topics, questions with their counts, bursts with their headings, important comments.
    for (const text of ['次回の配信日程', '第2形態の長さ', '×6', '使っている武器', '×4'])
      expect(within(panel).getByText(text)).toBeTruthy();
    expect(within(panel).getByText('第1形態の撃破')).toBeTruthy();
    expect(within(panel).getByText('30件')).toBeTruthy();
    expect(within(panel).getByText('55件')).toBeTruthy();
    expect(within(panel).getByText('mod_fixture')).toBeTruthy();
    expect(within(panel).getByText('次回は土曜 21時（JST）')).toBeTruthy();
    expect(within(panel).getByText(/対象 1,284件/u).textContent).toContain('韓国語');
    expect(within(panel).getByText(/^最終更新/u)).toBeTruthy();

    await userEvent.click(within(panel).getByRole('button', { name: '30分' }));
    await vi.waitFor(() =>
      expect(of('comments/summary').at(-1)?.payload).toEqual({
        site: 'youtube',
        channel: 'fixture0001',
        windowMinutes: 30,
      }),
    );
    expect(within(panel).getByRole('button', { name: '30分' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    failing = true;
    await userEvent.click(within(panel).getByRole('button', { name: '更新' }));
    expect((await within(panel).findByRole('alert')).textContent).toContain(
      'llama.cpp に接続できません',
    );
    expect(within(panel).getByText('ボス戦の攻略')).toBeTruthy();
    failing = false;
    await userEvent.click(within(panel).getByRole('button', { name: '更新' }));
    await vi.waitFor(() => expect(within(panel).queryByRole('alert')).toBeNull());
  });

  it('says how many minutes the summary covers when the store limit cut the window', async () => {
    const { api } = fakeApi({
      'comments/summary': ({ windowMinutes }) =>
        Ok(summaryOf(Number(windowMinutes), { total: 5000, from: AT - 12 * MINUTE })),
    });
    render(<App port={panelPort(api)} />);
    const panel = screen.getByRole('tabpanel');
    expect((await within(panel).findByText(/対象 5,000件/u)).textContent).toContain(
      '直近 12 分ぶん',
    );
  });

  it('says how many comments of the window stayed untranslated while the chat was not in front (R44)', async () => {
    const { api } = fakeApi({
      'comments/summary': ({ windowMinutes }) =>
        Ok(
          summaryOf(Number(windowMinutes), { unprocessed: Number(windowMinutes) === 5 ? 0 : 1234 }),
        ),
    });
    render(<App port={panelPort(api)} />);
    const panel = screen.getByRole('tabpanel');
    expect(await within(panel).findByText('画面に出ていなかった 1,234 件は未翻訳')).toBeTruthy();
    // None in the window: no note.
    await userEvent.click(within(panel).getByRole('button', { name: '5分' }));
    await vi.waitFor(() => expect(within(panel).queryByText(/未翻訳/u)).toBeNull());
    expect(within(panel).getByText(/対象 1,284件/u)).toBeTruthy();
  });

  it('says when the window has no comments yet, and asks for nothing without a stream', async () => {
    const empty = fakeApi({
      'comments/summary': () =>
        Ok({
          ...summaryOf(15),
          total: 0,
          languages: [],
          topics: [],
          questions: [],
          peaks: [],
          important: [],
        }),
    });
    render(<App port={panelPort(empty.api)} />);
    expect(await screen.findByText('この期間のコメントはまだありません。')).toBeTruthy();
    cleanup();
    const none = fakeApi({ 'comments/stream': () => Ok({}) });
    render(<App port={panelPort(none.api)} />);
    expect(await screen.findByText('このタブには配信がありません')).toBeTruthy();
    expect(screen.getByRole('tabpanel').textContent).toContain('配信を開くと');
    expect(none.of('comments/summary')).toEqual([]);
  });

  it('refreshes every 2 minutes only while auto refresh is on and the panel is visible', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    onTestFinished(() => {
      Reflect.deleteProperty(document, 'visibilityState');
    });
    const show = (state: DocumentVisibilityState): void => {
      visibility = state;
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
    };
    const { api, of } = fakeApi();
    const { unmount } = render(<App port={panelPort(api)} />);
    const panel = screen.getByRole('tabpanel');
    await within(panel).findByText('ボス戦の攻略');
    expect(vi.getTimerCount()).toBe(1);
    const asked = (): number => of('comments/summary').length;
    expect(asked()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(119_999);
    });
    expect(asked()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    await vi.waitFor(() => expect(asked()).toBe(2));

    // A tick asks for the window shown now.
    await userEvent.click(within(panel).getByRole('button', { name: '5分' }));
    await vi.waitFor(() => expect(asked()).toBe(3));
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    await vi.waitFor(() => expect(asked()).toBe(4));
    expect(of('comments/summary').at(-1)?.payload).toEqual({
      site: 'youtube',
      channel: 'fixture0001',
      windowMinutes: 5,
    });

    // Hidden (minimized window): no timer and no requests; visible again: asks at once.
    show('hidden');
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(600_000);
    });
    expect(asked()).toBe(4);
    show('visible');
    expect(vi.getTimerCount()).toBe(1);
    await vi.waitFor(() => expect(asked()).toBe(5));

    // Off: no timer; on again: one.
    const toggle = within(panel).getByRole('checkbox', { name: '自動更新（2分ごと）' });
    await userEvent.click(toggle);
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(600_000);
    });
    expect(asked()).toBe(5);
    await userEvent.click(toggle);
    expect(vi.getTimerCount()).toBe(1);
    // Another tab of the panel and closing it both end the timer.
    await userEvent.click(screen.getByRole('tab', { name: 'フィルター' }));
    expect(vi.getTimerCount()).toBe(0);
    await userEvent.click(screen.getByRole('tab', { name: '要約' }));
    await within(screen.getByRole('tabpanel')).findByText('ボス戦の攻略');
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts no timer while hidden or without a stream', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    onTestFinished(() => {
      Reflect.deleteProperty(document, 'visibilityState');
    });
    render(<App port={panelPort(fakeApi().api)} />);
    await within(screen.getByRole('tabpanel')).findByText('ボス戦の攻略');
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
    Reflect.deleteProperty(document, 'visibilityState');
    render(<App port={panelPort(fakeApi({ 'comments/stream': () => Ok({}) }).api)} />);
    expect(await screen.findByText('このタブには配信がありません')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('says when the model could not summarize the topics, keeping the counted parts', async () => {
    const { api } = fakeApi({
      'comments/summary': ({ windowMinutes }) =>
        Ok(summaryOf(Number(windowMinutes), { topics: [], modelFailed: true })),
    });
    render(<App port={panelPort(api)} />);
    const panel = screen.getByRole('tabpanel');
    expect(
      await within(panel).findByText(
        '話題の要約に失敗しました（件数と盛り上がりは表示しています）',
      ),
    ).toBeTruthy();
    expect(within(panel).getByText('第1形態の撃破')).toBeTruthy();
    expect(within(panel).getByText(/対象 1,284件/u)).toBeTruthy();
  });

  it("saves a filter change for the stream's streamer", async () => {
    const { api } = fakeApi();
    const port = panelPort(api);
    const save = vi.spyOn(port.filters, 'save');
    render(<App port={port} />);
    await screen.findByText('Fixture Quest Part 3');
    const panel = await openTab('フィルター');
    const spoiler = await within(panel).findByLabelText('ネタバレ');
    // Nothing chosen: every category shows its default as the first option.
    expect((spoiler as HTMLSelectElement).value).toBe('');
    expect(within(spoiler).getByRole('option', { name: '既定（伏せる）' })).toBeTruthy();
    // Abusive and spam comments are removed from the chat unless the viewer chooses (R54).
    for (const category of ['スパム・宣伝', '攻撃的（Clef）'])
      expect(
        within(within(panel).getByLabelText(category)).getByRole('option', {
          name: '既定（消す）',
        }),
      ).toBeTruthy();
    expect(
      within(within(panel).getByLabelText('スパム・宣伝')).getByRole('option', { name: '消す' }),
    ).toBeTruthy();
    expect(
      within(within(panel).getByLabelText('質問')).getByRole('option', {
        name: '既定（ハイライト）',
      }),
    ).toBeTruthy();
    await userEvent.selectOptions(spoiler, '消す');
    const expected = {
      ...defaultFilterSettings,
      modes: { ...defaultFilterSettings.modes, spoiler: 'hide' },
    };
    expect(save).toHaveBeenCalledWith('youtube', '@FixtureStreamer', expected);
    expect(await within(panel).findByText('この配信者用に保存しました')).toBeTruthy();
    expect((spoiler as HTMLSelectElement).value).toBe('hide');
    expect(await fakeBrowser.storage.local.get(filterKey('youtube', '@FixtureStreamer'))).toEqual({
      [filterKey('youtube', '@FixtureStreamer')]: { v: 2, ...expected },
    });

    await userEvent.click(within(panel).getByLabelText('原文を表示'));
    expect(save).toHaveBeenLastCalledWith('youtube', '@FixtureStreamer', {
      ...expected,
      showOriginal: true,
    });

    // The default option removes the explicit mode again.
    await userEvent.selectOptions(spoiler, '既定（伏せる）');
    expect(save).toHaveBeenLastCalledWith('youtube', '@FixtureStreamer', {
      ...defaultFilterSettings,
      showOriginal: true,
    });
    expect((spoiler as HTMLSelectElement).value).toBe('');
  });

  it('turns off letting a line in only once it is judged, for the streamer (R52)', async () => {
    const { api } = fakeApi();
    const port = panelPort(api);
    const save = vi.spyOn(port.filters, 'save');
    render(<App port={port} />);
    await screen.findByText('Fixture Quest Part 3');
    const panel = await openTab('フィルター');
    const hold = await within(panel).findByRole('checkbox', {
      name: '判定してから表示する（最大 2 秒）',
    });
    // On unless the viewer turned it off.
    expect((hold as HTMLInputElement).checked).toBe(true);
    await userEvent.click(hold);
    expect(save).toHaveBeenLastCalledWith('youtube', '@FixtureStreamer', {
      ...defaultFilterSettings,
      holdUntilJudged: false,
    });
    expect((hold as HTMLInputElement).checked).toBe(false);
    expect(await within(panel).findByText('この配信者用に保存しました')).toBeTruthy();
    expect(await fakeBrowser.storage.local.get(filterKey('youtube', '@FixtureStreamer'))).toEqual({
      [filterKey('youtube', '@FixtureStreamer')]: {
        v: 2,
        ...defaultFilterSettings,
        holdUntilJudged: false,
      },
    });
  });

  it('saves the spoiler targets for the stream, after a short pause in typing (R30)', async () => {
    const { api } = fakeApi();
    const port = panelPort(api);
    const save = vi.spyOn(port.filters, 'save');
    const saveNote = vi.spyOn(port.notes, 'save');
    render(<App port={port} />);
    await screen.findByText('Fixture Quest Part 3');
    const panel = await openTab('フィルター');
    const note = await within(panel).findByLabelText('ネタバレ対象');
    await userEvent.type(note, 'past the frozen bridge');
    // Not on every key: about half a second after the last one.
    expect(saveNote).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(saveNote).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(saveNote).toHaveBeenCalledWith('youtube', 'fixture0001', 'past the frozen bridge');
    expect(await within(panel).findByText('この配信用に保存しました')).toBeTruthy();
    // The note belongs to the stream, not to the streamer's filters.
    expect(save).not.toHaveBeenCalled();
    expect(await port.notes.load('youtube', 'fixture0001')).toEqual(Ok('past the frozen bridge'));
    // Leaving the field saves at once.
    await userEvent.type(note, ', no boss names');
    await userEvent.tab();
    expect(saveNote).toHaveBeenLastCalledWith(
      'youtube',
      'fixture0001',
      'past the frozen bridge, no boss names',
    );
  });

  it('saves a note still being typed when the panel closes', async () => {
    const { api } = fakeApi();
    const port = panelPort(api);
    const saveNote = vi.spyOn(port.notes, 'save');
    const { unmount } = render(<App port={port} />);
    await screen.findByText('Fixture Quest Part 3');
    const panel = await openTab('フィルター');
    await userEvent.type(await within(panel).findByLabelText('ネタバレ対象'), 'chapter 3');
    unmount();
    expect(saveNote).toHaveBeenCalledWith('youtube', 'fixture0001', 'chapter 3');
    await vi.waitFor(async () =>
      expect(await port.notes.load('youtube', 'fixture0001')).toEqual(Ok('chapter 3')),
    );
  });

  it("starts another stream of the same streamer with the streamer's filters and an empty note", async () => {
    let current: StreamContext = stream;
    const { api, events } = fakeApi({ 'comments/stream': () => Ok({ stream: current }) });
    const port = panelPort(api);
    render(<App port={port} />);
    await screen.findByText('Fixture Quest Part 3');
    let panel = await openTab('フィルター');
    await userEvent.selectOptions(await within(panel).findByLabelText('ネタバレ'), '消す');
    await userEvent.type(within(panel).getByLabelText('ネタバレ対象'), 'past the frozen bridge');
    await userEvent.tab();
    await within(panel).findByText('この配信用に保存しました');

    current = { ...stream, partition: 'fixture0002', title: 'Fixture Quest Part 4' };
    for (const listener of events.activated.listeners) listener();
    expect(await screen.findByText('Fixture Quest Part 4')).toBeTruthy();
    panel = screen.getByRole('tabpanel');
    await vi.waitFor(() =>
      expect((within(panel).getByLabelText('ネタバレ') as HTMLSelectElement).value).toBe('hide'),
    );
    expect((within(panel).getByLabelText('ネタバレ対象') as HTMLTextAreaElement).value).toBe('');
  });

  it('lists the hidden comments newest first and restores one marked fine', async () => {
    const { api, of } = fakeApi();
    render(<App port={panelPort(api)} />);
    await screen.findByText('Fixture Quest Part 3');
    const panel = await openTab('非表示');
    const list = await within(panel).findByRole('list', { name: 'チャットから外したコメント' });
    await vi.waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    const rows = within(list).getAllByRole('listitem');
    // Chat and video comments of the stream together, newest first.
    expect(rows.map((row) => row.querySelector('[data-field="text"]')?.textContent)).toEqual([
      'fixture text h2',
      'fixture text c1',
      'fixture text h1',
    ]);
    const first = rows[2];
    if (!first) throw new Error('row missing');
    expect(first.textContent).toContain('訳:fixture text h1');
    expect(first.textContent).toContain('攻撃的');
    expect(first.textContent).toContain('Clef 87%');
    expect(first.textContent).toContain(
      new Date(AT - 2000).toLocaleTimeString('ja-JP', { hour12: false }),
    );
    expect(rows[0]?.textContent).toContain('スパム');
    expect(rows[1]?.textContent).toContain('ネタバレ');

    await userEvent.click(within(first).getByRole('button', { name: '問題なし' }));
    expect(of('comments/feedback').map((m) => m.payload)).toEqual([
      { site: 'youtube', channel: 'fixture0001', id: 'h1', verdict: 'ok' },
    ]);
    await vi.waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(list.textContent).not.toContain('fixture text h1');
  });

  it('marks a comment confirmed as correct and says when a verdict is saved later', async () => {
    const { api, of } = fakeApi({
      'comments/feedback': () => Ok({ persisted: false }),
    });
    render(<App port={panelPort(api)} />);
    await screen.findByText('Fixture Quest Part 3');
    const panel = await openTab('非表示');
    const list = await within(panel).findByRole('list', { name: 'チャットから外したコメント' });
    await vi.waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    const row = within(list).getAllByRole('listitem')[0];
    if (!row) throw new Error('row missing');
    await userEvent.click(within(row).getByRole('button', { name: '正しい' }));
    expect(of('comments/feedback').map((m) => m.payload)).toEqual([
      { site: 'youtube', channel: 'fixture0001', id: 'h2', verdict: 'correct' },
    ]);
    expect(await within(row).findByText('確認済み')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: '問題なし' })).toBeNull();
    expect(await within(panel).findByText(/あとで保存します/u)).toBeTruthy();
  });

  it('exports the feedback as a JSONL file and revokes the object URL', async () => {
    const { api } = fakeApi();
    const created: Blob[] = [];
    const createObjectURL = vi.fn<(blob: Blob) => string>((blob) => {
      created.push(blob);
      return 'blob:fixture-export';
    });
    const revokeObjectURL = vi.fn<(url: string) => void>();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const clicks: { download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push({ download: this.download, href: this.getAttribute('href') ?? '' });
    });
    render(<App port={panelPort(api)} />);
    await screen.findByText('Fixture Quest Part 3');
    const panel = await openTab('非表示');
    await userEvent.click(within(panel).getByRole('button', { name: '書き出す（JSONL）' }));
    await vi.waitFor(() => expect(clicks).toHaveLength(1));
    expect(clicks[0]?.href).toBe('blob:fixture-export');
    expect(clicks[0]?.download).toMatch(/^comment-feedback-.*\.jsonl$/u);
    expect(await created[0]?.text()).toBe('{"text":"fixture text h1","verdict":"ok"}\n');
    expect(created[0]?.type).toBe('application/jsonl');
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:fixture-export'));
    // The link is not left in the page.
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
  });

  it('clears the feedback only after the viewer confirms, then lists the comments again', async () => {
    let cleared = false;
    const confirmed = hiddenEntry('h3', AT, { category: 'spoiler' });
    const { api, of } = fakeApi({
      'comments/hidden': ({ channel }) =>
        Ok(
          channel === 'fixture0001'
            ? [cleared ? confirmed : { ...confirmed, verdict: 'correct' }]
            : [],
        ),
      'comments/feedback/clear': () => {
        cleared = true;
        return Ok({});
      },
    });
    render(<App port={panelPort(api)} />);
    await screen.findByText('Fixture Quest Part 3');
    const panel = await openTab('非表示');
    expect(await within(panel).findByText('確認済み')).toBeTruthy();
    // The comments removed from the chat, with the reason; 問題なし puts one back (R54).
    expect(within(panel).getByText('チャットから外したコメント（この配信）')).toBeTruthy();
    expect(within(panel).getByText(/「問題なし」でチャットに戻します/u)).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: 'フィードバックを消去' }));
    expect(within(panel).getByText(/すべて消去します/u)).toBeTruthy();
    await userEvent.click(within(panel).getByRole('button', { name: 'やめる' }));
    expect(of('comments/feedback/clear')).toEqual([]);
    await userEvent.click(within(panel).getByRole('button', { name: 'フィードバックを消去' }));
    await userEvent.click(within(panel).getByRole('button', { name: '消去する' }));
    await vi.waitFor(() => expect(of('comments/feedback/clear')).toHaveLength(1));
    expect(await within(panel).findByText('フィードバックを消去しました')).toBeTruthy();
    // The verdicts are gone from the list too: the comment can be judged again.
    await vi.waitFor(() => expect(within(panel).queryByText('確認済み')).toBeNull());
    expect(within(panel).getByRole('button', { name: '正しい' })).toBeTruthy();
  });

  it('reports a failed tab query as a Result and says the stream could not be checked', async () => {
    const { api } = fakeApi();
    const port = panelPort({
      ...api,
      tabs: { ...api.tabs, query: () => Promise.reject(new Error('no window')) },
    });
    expect(await port.stream()).toMatchObject({ ok: false, error: { internalCode: 'ipc_failed' } });
    render(<App port={port} />);
    expect(await screen.findByText('このタブの配信を確認できませんでした。')).toBeTruthy();
  });

  it('explains a tab without a stream', async () => {
    const { api, of } = fakeApi({ 'comments/stream': () => Ok({}) });
    render(<App port={panelPort(api)} />);
    expect(await screen.findByText('このタブには配信がありません')).toBeTruthy();
    const filters = await openTab('フィルター');
    expect(filters.textContent).toContain('配信を開くと');
    const hidden = await openTab('非表示');
    expect(hidden.textContent).toContain('配信を開くと');
    expect(of('comments/hidden')).toEqual([]);
  });

  it('follows tab switches and stream changes while open and removes its listeners when closed', async () => {
    let current: StreamContext | undefined = stream;
    const { api, events, of } = fakeApi({
      'comments/stream': () => Ok(current ? { stream: current } : {}),
    });
    const { unmount } = render(<App port={panelPort(api)} />);
    await screen.findByText('Fixture Quest Part 3');
    expect(events.activated.listeners.size).toBe(1);
    expect(events.updated.listeners.size).toBe(1);
    expect(events.message.listeners.size).toBe(1);

    current = { ...stream, partition: 'fixture0002', title: 'Fixture Quest Part 4' };
    for (const listener of events.activated.listeners) listener();
    expect(await screen.findByText('Fixture Quest Part 4')).toBeTruthy();

    // A page of the shown tab reported its stream (or left it).
    current = undefined;
    for (const listener of events.message.listeners)
      (listener as (message: unknown) => void)({ type: 'comments/stream-changed' });
    expect(await screen.findByText('このタブには配信がありません')).toBeTruthy();
    const asked = of('comments/stream').length;
    // Other messages (content scripts' ingest) and other tabs' loads are ignored.
    for (const listener of events.message.listeners)
      (listener as (message: unknown) => void)({ type: 'comments/ingest', payload: {} });
    for (const listener of events.updated.listeners)
      (listener as (tabId: number, change: { status?: string }) => void)(99, {
        status: 'complete',
      });
    for (const listener of events.updated.listeners)
      (listener as (tabId: number, change: { status?: string }) => void)(7, {
        status: 'loading',
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(of('comments/stream')).toHaveLength(asked);
    for (const listener of events.updated.listeners)
      (listener as (tabId: number, change: { status?: string }) => void)(7, {
        status: 'complete',
      });
    await vi.waitFor(() => expect(of('comments/stream')).toHaveLength(asked + 1));

    unmount();
    expect(events.activated.listeners.size).toBe(0);
    expect(events.updated.listeners.size).toBe(0);
    expect(events.message.listeners.size).toBe(0);
  });

  it('decodes only stream changes among the messages every content script sends (R45)', () => {
    const { api, events } = fakeApi();
    const decode = vi.spyOn(streamChangedMessageSchema, 'safeParse');
    const changed = vi.fn<() => void>();
    const stop = panelPort(api).watch(changed);
    const send = (message: unknown): void => {
      for (const listener of events.message.listeners)
        (listener as (message: unknown) => void)(message);
    };
    // About 20 ingest messages a second reach every extension page.
    send({ type: 'comments/ingest', payload: { comments: [] } });
    send({ type: 'comments/context', payload: { site: 'youtube' } });
    send('comments/stream-changed');
    send(null);
    expect(decode).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    send({ type: 'comments/stream-changed' });
    expect(changed).toHaveBeenCalledOnce();
    // Its type alone is not enough: the message must be one.
    send({ type: 'comments/stream-changed', extra: true });
    expect(changed).toHaveBeenCalledOnce();
    stop();
  });

  it('shows the connection, the model names and whether Clef judges abuse', async () => {
    const { api } = fakeApi();
    render(<App port={panelPort(api)} />);
    await screen.findByText('Fixture Quest Part 3');
    const panel = await openTab('設定');
    expect(await within(panel).findByDisplayValue('http://127.0.0.1:18083')).toBe(
      within(panel).getByLabelText('llama.cpp の接続先'),
    );
    const translate = await within(panel).findByLabelText('翻訳モデル');
    expect((translate as HTMLInputElement).value).toBe('gemma4-e4b');
    expect((within(panel).getByLabelText('Clef モデル') as HTMLInputElement).value).toBe(
      'clef-flash',
    );
    expect(await within(panel).findByText('Clef で判定しています')).toBeTruthy();

    await userEvent.clear(translate);
    await userEvent.type(translate, 'gemma4-e2b');
    await userEvent.click(within(panel).getByRole('button', { name: 'モデル名を保存' }));
    expect(await within(panel).findByText('モデル名を保存しました')).toBeTruthy();
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({
      settings: {
        llamaBaseUrl: 'http://127.0.0.1:18083',
        models: { translate: 'gemma4-e2b', clef: 'clef-flash', asr: 'gemma4-e4b' },
      },
    });
  });

  it('keeps a model name typed before the saved settings load', async () => {
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
    await screen.findByText('Fixture Quest Part 3');
    const panel = await openTab('設定');
    const translate = within(panel).getByLabelText('翻訳モデル');
    await userEvent.type(translate, 'gemma4-e2b');
    await act(async () => {
      release();
      await held;
    });
    const clef = within(panel).getByLabelText('Clef モデル');
    await vi.waitFor(() => expect((clef as HTMLInputElement).value).toBe('clef-flash'));
    expect((translate as HTMLInputElement).value).toBe('gemma4-e2b');
    await userEvent.click(within(panel).getByRole('button', { name: 'モデル名を保存' }));
    expect(await within(panel).findByText('モデル名を保存しました')).toBeTruthy();
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({
      settings: {
        llamaBaseUrl: 'http://127.0.0.1:18083',
        models: { translate: 'gemma4-e2b', clef: 'clef-flash', asr: 'gemma4-e4b' },
      },
    });
  });

  it('shows the stream processing counters when the tab opens and again only on 更新 (R53)', async () => {
    let pending = 4;
    const { api, of } = fakeApi({
      'comments/stats': () =>
        Ok({
          records: 30,
          stored: 12,
          pending,
          dropped: 2,
          unstored: 0,
          failed: 0,
          cached: 5,
          trivial: 9,
          expired: 3,
          clefSkipped: 0,
          judge: 'clef',
          latencyP50Ms: 1234,
        }),
    });
    render(<App port={panelPort(api)} />);
    await screen.findByText('Fixture Quest Part 3');
    const panel = await openTab('設定');
    const counters = within(panel).getByRole('region', { name: '処理の状況' });
    const value = (name: string): string | null | undefined =>
      within(counters).getByText(name).nextElementSibling?.textContent;
    await within(counters).findByText('4 件');
    expect(value('処理待ち')).toBe('4 件');
    expect(value('原文のまま（処理しきれず）')).toBe('5 件');
    expect(value('画面外で未処理')).toBe('12 件');
    expect(value('応答の中央値')).toBe('1.2 秒');
    expect(of('comments/stats')).toHaveLength(1);
    // No polling: only the button asks again.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(of('comments/stats')).toHaveLength(1);
    // Nothing went unstored: no row for it.
    expect(within(counters).queryByText('保存できず')).toBeNull();
    pending = 7;
    await userEvent.click(within(counters).getByRole('button', { name: '更新' }));
    await within(counters).findByText('7 件');
    expect(of('comments/stats')).toHaveLength(2);
  });

  it('shows how many comments could not be stored only when some were not (R55)', async () => {
    const { api } = fakeApi({
      'comments/stats': () =>
        Ok({
          records: 0,
          stored: 0,
          pending: 0,
          dropped: 0,
          unstored: 6,
          failed: 0,
          cached: 0,
          trivial: 0,
          expired: 0,
          clefSkipped: 0,
          judge: 'clef',
        }),
    });
    render(<App port={panelPort(api)} />);
    await screen.findByText('Fixture Quest Part 3');
    const panel = await openTab('設定');
    const counters = within(panel).getByRole('region', { name: '処理の状況' });
    const unstored = await within(counters).findByText('保存できず');
    expect(unstored.nextElementSibling?.textContent).toBe('6 件');
  });

  it('says when no comment of the stream was answered yet', async () => {
    const { api } = fakeApi();
    render(<App port={panelPort(api)} />);
    await screen.findByText('Fixture Quest Part 3');
    const panel = await openTab('設定');
    const counters = within(panel).getByRole('region', { name: '処理の状況' });
    const median = await within(counters).findByText('応答の中央値');
    expect(median.nextElementSibling?.textContent).toBe('まだありません');
  });

  it('says when abuse is judged by the model because Clef is unavailable', async () => {
    const { api } = fakeApi({
      'comments/stats': () =>
        Ok({
          records: 0,
          stored: 0,
          pending: 0,
          dropped: 0,
          unstored: 0,
          failed: 0,
          cached: 0,
          trivial: 0,
          expired: 0,
          clefSkipped: 0,
          judge: 'llm',
          lastError: 'network_failed',
          judgeError: 'clef_unavailable',
        }),
    });
    render(<App port={panelPort(api)} />);
    await screen.findByText('Fixture Quest Part 3');
    const panel = await openTab('設定');
    expect(await within(panel).findByText(/Clef が使えないため/u)).toBeTruthy();
    expect(within(panel).getByText(/llama.cpp に接続できません/u)).toBeTruthy();
    // Why Clef is not used is said once.
    expect(within(panel).queryByText(/Clef の直近の判定に失敗しました/u)).toBeNull();
  });
});
