import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
import { genrePrompt } from '@chrome-toolbox/extension-core';
import { STREAM_GENRES_KEY } from '../../src/genre.ts';
import { spoilerNoteStore } from '../../src/filters.ts';
import { sidePanelPort, type PanelApi } from '../../src/panel.ts';
import { annotationsMessageSchema, messageType } from '../../src/protocol.ts';
import { startBackground } from '../../src/runtime.ts';

afterEach(() => {
  fakeBrowser.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Sent = { path: string; body: Record<string, unknown> };
/** A request of the genre guess (R63): its grammar allows the genre ids only. */
const isGenreGuess = (sent: Sent): boolean =>
  sent.path === '/v1/chat/completions' && sent.body['grammar'] === genrePrompt({}).grammar;
/** The user turn of a chat request; empty for none. */
const userTurn = (sent: Sent | undefined): string => {
  const messages = sent?.body['messages'];
  return Array.isArray(messages) ? String((messages[1] as { content?: unknown })?.content) : '';
};
/** The comment batch requests among those sent (not the genre guess, not a summary). */
const batches = (sent: readonly Sent[]): Sent[] =>
  sent.filter(
    (s) => s.path === '/v1/chat/completions' && String(s.body['grammar']).includes('code ::='),
  );
/**
 * Fake llama.cpp router: chat translates every translatable comment as `訳:<text>` and calls a
 * "menace" abusive, everything else chatter, and answers a genre guess with `genre`; Clef scores
 * 0.01 (0.95 for a "menace"). Requests other than `/props` wait for `door` (or the door it
 * returns when asked); the first `propsFailures` `/props` requests find the server down.
 */
const stubLlama = (
  door: Promise<void> | (() => Promise<void>) = Promise.resolve(),
  totalSlots = 2,
  {
    propsFailures = 0,
    genre = 'other',
    processing = [],
  }: {
    propsFailures?: number;
    genre?: string;
    /** The slots `/slots` reports processing (none by default). */
    processing?: readonly number[];
  } = {},
): Sent[] => {
  const sent: Sent[] = [];
  let failures = propsFailures;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const path = url.pathname;
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >;
      if (path === '/props') {
        sent.push({ path: `${path}${url.search}`, body });
        failures -= 1;
        if (failures >= 0) throw new TypeError('Failed to fetch');
        return Response.json({ total_slots: totalSlots });
      }
      if (path === '/slots') {
        sent.push({ path: `${path}${url.search}`, body });
        return Response.json(
          Array.from({ length: totalSlots }, (_, id) => ({
            id,
            is_processing: processing.includes(id),
          })),
        );
      }
      sent.push({ path, body });
      await (typeof door === 'function' ? door() : door);
      if (path === '/v1/systemone') {
        const questions = Object.keys(body['questions'] ?? {});
        // A comment about a "menace" is the one Clef finds abusive.
        const noul = String(body['state']).includes('menace') ? 0.95 : 0.01;
        return Response.json({
          answers: Object.fromEntries(questions.map((id) => [id, { type: 'noul', noul }])),
        });
      }
      if (isGenreGuess({ path, body }))
        return Response.json({ choices: [{ message: { content: genre } }] });
      const messages = body['messages'] as { content: string }[];
      const comments = (messages[1]?.content ?? '')
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as { id: number; text: string; translate: boolean });
      // The compact reply: `<id>\t<code>[\t<ja>]\n`, `a` for abusive, `c` for chatter.
      const content = comments
        .map(
          (c) =>
            `${c.id}\t${c.text.includes('menace') ? 'a' : 'c'}${c.translate ? `\t訳:${c.text}` : ''}\n`,
        )
        .join('');
      return Response.json({ choices: [{ message: { content } }] });
    }),
  );
  return sent;
};
const at = Date.now();
const raw = (id: string, text: string) => ({ id, author: 'viewer', text, at });
/** The side panel, an extension page; opened as a tab it also has a tab. */
const panel: Browser.runtime.MessageSender = {
  url: 'chrome-extension://test-extension-id/sidepanel.html',
};

describe('extension runtime wiring', () => {
  it('answers status messages from the background and removes its listener on cleanup', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        new URL(input).pathname === '/health'
          ? Response.json({ status: 'ok' })
          : Response.json({ data: [{ id: 'stub-model' }] }),
      ),
    );
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    expect(listener).toBeTypeOf('function');
    const reply = await new Promise((resolve) => {
      expect(
        listener?.(
          { type: 'llm/status', payload: { baseUrl: 'http://127.0.0.1:18083' } },
          {},
          resolve,
        ),
      ).toBe(true);
    });
    expect(reply).toEqual(Ok({ models: ['stub-model'] }));
    stop();
    expect(fakeBrowser.runtime.onMessage.hasListeners()).toBe(false);
  });

  it('saves the side panel URL in extension storage before asking the background', async () => {
    const send = vi.fn<PanelApi['runtime']['sendMessage']>(async () =>
      Ok({ models: ['stub-model'] }),
    );
    const port = sidePanelPort({
      storage: fakeBrowser.storage,
      permissions: { contains: async () => true, request: async () => false },
      runtime: { sendMessage: send },
    });
    expect(await port.load()).toEqual(Ok('http://127.0.0.1:18083'));
    expect(await port.check('http://127.0.0.1:8081/')).toEqual(Ok({ models: ['stub-model'] }));
    expect(send).toHaveBeenCalledWith({
      type: 'llm/status',
      payload: { baseUrl: 'http://127.0.0.1:8081' },
    });
    expect(await fakeBrowser.storage.local.get('settings')).toEqual({
      settings: {
        llamaBaseUrl: 'http://127.0.0.1:8081',
        models: { translate: 'gemma4-e4b', clef: 'clef-flash', asr: 'gemma4-e4b' },
      },
    });
  });

  it('routes comment ingest from a content frame and sends annotations back to that frame', async () => {
    const sent = stubLlama();
    const deliver = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => listener?.(message, sender, resolve));
    const tab = await fakeBrowser.tabs.create({ url: 'https://www.youtube.com/live_chat?v=x' });
    const ingest = {
      type: 'comments/ingest',
      payload: {
        site: 'youtube',
        channel: 'UC-test',
        // The first has an abuse cue, so Clef judges it (R43).
        comments: [
          raw('1', 'hello there clown'),
          raw('2', 'がんばれ'),
          raw('3', 'lol'),
          raw('4', '🔥'),
        ],
      },
    };

    expect(await ask(ingest, {})).toMatchObject({
      ok: false,
      error: { internalCode: 'input_invalid' },
    });
    const tooLong = { ...ingest.payload, comments: [raw('9', 'x'.repeat(1001))] };
    expect(await ask({ ...ingest, payload: tooLong }, { tab, frameId: 3 })).toMatchObject({
      ok: false,
      error: { internalCode: 'input_invalid' },
    });
    expect(await ask(ingest, { tab, frameId: 3 })).toEqual(Ok({ accepted: 4, dropped: 0 }));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    for (const [tabId, message, options] of deliver.mock.calls) {
      expect([tabId, options]).toEqual([tab.id, { frameId: 3 }]);
      expect(annotationsMessageSchema.safeParse(message).success).toBe(true);
    }
    // The trivial "lol" and the emoji-only comment are answered at once, without a model.
    expect(deliver.mock.calls.map((call) => call[1])).toEqual([
      {
        type: 'comments/annotations',
        payload: [
          { id: '3', translation: '（笑）', category: 'chatter', state: 'done' },
          { id: '4', category: 'chatter', state: 'skipped' },
        ],
      },
      {
        type: 'comments/annotations',
        payload: [
          { id: '1', translation: '訳:hello there clown', category: 'chatter', state: 'done' },
          { id: '2', category: 'chatter', state: 'done' },
        ],
      },
    ]);
    expect(sent.filter((s) => s.path === '/v1/systemone').map((s) => s.body['model'])).toEqual([
      'clef-flash',
    ]);
    expect(sent.find((s) => s.path === '/v1/chat/completions')?.body).toMatchObject({
      model: 'gemma4-e4b',
      id_slot: 1,
    });
    expect(
      await ask({ type: 'comments/stats', payload: { site: 'youtube', channel: 'UC-test' } }, {}),
    ).toEqual(
      Ok({
        records: 4,
        stored: 0,
        pending: 0,
        dropped: 0,
        unstored: 0,
        failed: 0,
        cached: 0,
        trivial: 1,
        expired: 0,
        clefSkipped: 1,
        judge: 'clef',
        // Real time: how long the four comments took to their first annotation.
        latencyP50Ms: expect.any(Number),
      }),
    );
    // The server's slot count is read once per pipeline, with the translation model.
    expect(sent.filter((s) => s.path.startsWith('/props')).map((s) => s.path)).toEqual([
      '/props?model=gemma4-e4b',
    ]);
    // A frame whose chat is not in front sends comments for storing only (R44): no model, no
    // Clef, no annotation.
    const requests = sent.length;
    const background = {
      ...ingest,
      payload: {
        ...ingest.payload,
        process: false,
        comments: [raw('5', 'a menace'), raw('6', 'ok')],
      },
    };
    expect(await ask(background, { tab, frameId: 3 })).toEqual(Ok({ accepted: 2, dropped: 0 }));
    expect(
      await ask({ type: 'comments/stats', payload: { site: 'youtube', channel: 'UC-test' } }, {}),
    ).toMatchObject({ ok: true, value: { records: 6, stored: 2, pending: 0 } });
    expect(sent).toHaveLength(requests);
    expect(deliver).toHaveBeenCalledTimes(2);

    stop();
    expect(fakeBrowser.runtime.onMessage.hasListeners()).toBe(false);
    expect(fakeBrowser.storage.local.onChanged.hasListeners()).toBe(false);
  });

  it('lists hidden comments, restores one marked ok in its frame and exports the saved feedback', async () => {
    stubLlama();
    const deliver = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    let stop = startBackground();
    // The newest background's listener (it is started again below).
    const listener = () => add.mock.calls.at(-1)?.[0];
    const ask = (
      message: unknown,
      sender: Browser.runtime.MessageSender = panel,
    ): Promise<unknown> => new Promise((resolve) => listener()?.(message, sender, resolve));
    const tab = await fakeBrowser.tabs.create({ url: 'https://www.youtube.com/live_chat?v=x' });
    const partition = { site: 'youtube', channel: 'UC-test' } as const;
    await ask(
      {
        type: 'comments/ingest',
        payload: { ...partition, comments: [raw('1', 'you are a menace'), raw('2', 'hello')] },
      },
      { tab, frameId: 3 },
    );
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

    const hidden = {
      id: '1',
      ...partition,
      text: 'you are a menace',
      translation: '訳:you are a menace',
      category: 'abusive',
      abusive: 0.95,
      source: 'clef',
      at,
    };
    expect(await ask({ type: 'comments/hidden', payload: partition })).toEqual(Ok([hidden]));
    // The side panel page opened in a tab (as in a browser test) is still an extension page.
    expect(
      await ask({ type: 'comments/hidden', payload: partition }, { ...panel, tab, frameId: 0 }),
    ).toEqual(Ok([hidden]));
    // A content script (a sender with a web page URL) may not read, judge, export or clear verdicts.
    for (const message of [
      { type: 'comments/hidden', payload: partition },
      { type: 'comments/feedback', payload: { ...partition, id: '1', verdict: 'ok' } },
      { type: 'comments/export', payload: {} },
      { type: 'comments/feedback/clear', payload: {} },
    ])
      for (const sender of [
        { tab, frameId: 3, url: 'https://www.youtube.com/live_chat?v=x' },
        { tab, frameId: 3 },
        { url: 'https://chrome-extension.example/sidepanel.html' },
        { url: 'data:text/html,<p>fixture</p>' },
        { url: 'about:blank' },
        { url: 'chrome-extension://test-extension-id.example/sidepanel.html' },
        { url: 'chrome-extension://other-extension-id/sidepanel.html' },
        // A sandboxed page of this extension has an opaque origin.
        { ...panel, origin: 'null' },
      ])
        expect(await ask(message, sender)).toMatchObject({
          ok: false,
          error: { internalCode: 'sender_forbidden' },
        });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(
      await ask({ type: 'comments/feedback', payload: { ...partition, id: '2', verdict: 'ok' } }),
    ).toMatchObject({ ok: false, error: { internalCode: 'resource_missing' } });
    expect(
      await ask({ type: 'comments/feedback', payload: { ...partition, id: '1', verdict: 'ok' } }),
    ).toEqual(Ok({ persisted: true }));
    expect(deliver).toHaveBeenCalledTimes(2);
    const [tabId, message, options] = deliver.mock.calls[1] ?? [];
    expect([tabId, options]).toEqual([tab.id, { frameId: 3 }]);
    expect(annotationsMessageSchema.parse(message)).toEqual({
      type: 'comments/annotations',
      payload: [
        {
          id: '1',
          translation: '訳:you are a menace',
          category: 'chatter',
          state: 'done',
          override: 'show',
        },
      ],
    });
    expect(await ask({ type: 'comments/hidden', payload: partition })).toEqual(Ok([]));

    // The verdict outlives the service worker: a new one exports it from extension storage.
    stop();
    stop = startBackground();
    const exported = await ask({ type: 'comments/export', payload: {} });
    expect(exported).toMatchObject({ ok: true });
    const { jsonl } = (exported as { value: { jsonl: string } }).value;
    expect(
      jsonl
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([
      {
        text: 'you are a menace',
        translation: '訳:you are a menace',
        category: 'abusive',
        abusive: 0.95,
        source: 'clef',
        verdict: 'ok',
        at: expect.any(Number),
      },
    ]);
    expect(jsonl).not.toContain('viewer');
    expect(JSON.stringify(await fakeBrowser.storage.local.get('feedback'))).not.toContain('viewer');

    // Kept until cleared: clearing empties the export and the stored verdicts, and the hidden
    // list forgets its confirmations.
    await ask(
      {
        type: 'comments/ingest',
        payload: { ...partition, comments: [raw('3', 'what a menace')] },
      },
      { tab, frameId: 3, url: 'https://www.youtube.com/live_chat?v=x' },
    );
    await vi.waitFor(async () =>
      expect(await ask({ type: 'comments/hidden', payload: partition })).toMatchObject({
        value: [{ id: '3' }],
      }),
    );
    expect(
      await ask({
        type: 'comments/feedback',
        payload: { ...partition, id: '3', verdict: 'correct' },
      }),
    ).toEqual(Ok({ persisted: true }));
    expect(await ask({ type: 'comments/hidden', payload: partition })).toMatchObject({
      value: [{ id: '3', verdict: 'correct' }],
    });
    expect(await ask({ type: 'comments/feedback/clear', payload: {} })).toEqual(Ok({}));
    expect(await ask({ type: 'comments/hidden', payload: partition })).toEqual(
      Ok([expect.not.objectContaining({ verdict: expect.anything() })]),
    );
    expect(await ask({ type: 'comments/export', payload: {} })).toEqual(Ok({ jsonl: '' }));
    expect(await fakeBrowser.storage.local.get('feedback')).toEqual({ feedback: [] });
    stop();
  });

  it("forgets every stream's kept genre and choice with the feedback (privacy)", async () => {
    stubLlama();
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const broadcast = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => listener?.(message, sender, resolve));
    const tab = await fakeBrowser.tabs.create({ url: 'https://www.twitch.tv/fixturechannel' });
    await ask(
      {
        type: 'comments/context',
        payload: {
          site: 'twitch',
          partition: 'fixturechannel',
          title: 'Fixture night',
          game: 'just-chatting',
        },
      },
      { tab, frameId: 0, url: 'https://www.twitch.tv/fixturechannel' },
    );
    await ask(
      {
        type: 'comments/genre',
        payload: { site: 'twitch', partition: 'fixturechannel', genre: 'fps' },
      },
      panel,
    );
    expect(await fakeBrowser.storage.local.get(STREAM_GENRES_KEY)).toMatchObject({
      [STREAM_GENRES_KEY]: [{ stream: 'fixturechannel', override: 'fps' }],
    });
    broadcast.mockClear();
    expect(await ask({ type: 'comments/feedback/clear', payload: {} }, panel)).toEqual(Ok({}));
    expect(await fakeBrowser.storage.local.get(STREAM_GENRES_KEY)).toEqual({
      [STREAM_GENRES_KEY]: [],
    });
    expect(broadcast).toHaveBeenCalledWith({ type: 'comments/stream-changed' });
    stop();
  });

  it("badges each tab with its stream's removed comments still waiting for a verdict (R54)", async () => {
    stubLlama();
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (
      message: unknown,
      sender: Browser.runtime.MessageSender = panel,
    ): Promise<unknown> => new Promise((resolve) => listener?.(message, sender, resolve));
    const badge = async (tabId: number | undefined): Promise<string> =>
      fakeBrowser.action.getBadgeText({ tabId });
    const watch = await fakeBrowser.tabs.create({ url: 'https://www.youtube.com/watch?v=x' });
    const twitch = await fakeBrowser.tabs.create({ url: 'https://www.twitch.tv/otherchannel' });
    const video = { site: 'youtube', channel: 'fixtureVid' } as const;
    const other = { site: 'twitch', channel: 'otherchannel' } as const;
    // Each tab's top frame names its stream: the watch page its video's comments.
    await ask(
      { type: 'comments/context', payload: { site: 'youtube', partition: 'fixtureVid#comments' } },
      { tab: watch, frameId: 0 },
    );
    await ask(
      { type: 'comments/context', payload: { site: 'twitch', partition: 'otherchannel' } },
      { tab: twitch, frameId: 0 },
    );
    const ingest = (
      partition: typeof video | typeof other,
      comments: ReturnType<typeof raw>[],
      sender: Browser.runtime.MessageSender,
    ): Promise<unknown> =>
      ask({ type: 'comments/ingest', payload: { ...partition, comments } }, sender);
    // The live chat frame of the watch page removes two comments.
    await ingest(video, [raw('1', 'you are a menace'), raw('2', 'what a menace')], {
      tab: watch,
      frameId: 3,
    });
    await vi.waitFor(async () => expect(await badge(watch.id)).toBe('2'));
    await ingest(other, [raw('3', 'a menace again'), raw('4', 'hello')], {
      tab: twitch,
      frameId: 0,
    });
    await vi.waitFor(async () => expect(await badge(twitch.id)).toBe('1'));
    // Switching tabs shows each tab's own count.
    expect([await badge(watch.id), await badge(twitch.id)]).toEqual(['2', '1']);
    // A verdict takes one off; clearing the feedback puts a confirmed one back.
    await ask({ type: 'comments/feedback', payload: { ...video, id: '1', verdict: 'ok' } });
    expect(await badge(watch.id)).toBe('1');
    await ask({ type: 'comments/feedback', payload: { ...video, id: '2', verdict: 'correct' } });
    expect(await badge(watch.id)).toBe('');
    await ask({ type: 'comments/feedback/clear', payload: {} });
    expect(await badge(watch.id)).toBe('1');
    expect(await badge(twitch.id)).toBe('1');
    // The tab leaves its stream (Twitch's directory): its badge is cleared.
    await ask(
      { type: 'comments/context', payload: { site: 'twitch' } },
      { tab: twitch, frameId: 0 },
    );
    expect(await badge(twitch.id)).toBe('');
    stop();
  });

  it("asks a badged tab's top frame for its stream after each full navigation", async () => {
    stubLlama();
    /** What the tab's top frame answers a ping with; undefined: no content script there. */
    let ping: unknown;
    const pinged: number[] = [];
    // Replaced, not spied: the spy would take the callback overload.
    const toTab = vi.fn<(tabId: number, message: unknown, options?: unknown) => Promise<unknown>>(
      async (tabId, message) => {
        if (messageType(message) !== 'comments/ping') return undefined;
        pinged.push(tabId);
        if (ping === undefined)
          throw new Error('Could not establish connection. Receiving end does not exist.');
        return ping;
      },
    );
    const original = fakeBrowser.tabs.sendMessage;
    Object.assign(fakeBrowser.tabs, { sendMessage: toTab });
    onTestFinished(() => void Object.assign(fakeBrowser.tabs, { sendMessage: original }));
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (
      message: unknown,
      sender: Browser.runtime.MessageSender = panel,
    ): Promise<unknown> => new Promise((resolve) => listener?.(message, sender, resolve));
    const tab = await fakeBrowser.tabs.create({ url: 'https://www.twitch.tv/otherchannel' });
    const other = await fakeBrowser.tabs.create({ url: 'https://example.com/' });
    const badge = async (tabId: number | undefined): Promise<string> =>
      fakeBrowser.action.getBadgeText({ tabId });
    const complete = async (tabId: number | undefined): Promise<void> => {
      await fakeBrowser.tabs.onUpdated.trigger(tabId ?? -1, { status: 'complete' }, tab);
    };
    await ask(
      { type: 'comments/context', payload: { site: 'twitch', partition: 'otherchannel' } },
      { tab, frameId: 0 },
    );
    await ask(
      {
        type: 'comments/ingest',
        payload: { site: 'twitch', channel: 'otherchannel', comments: [raw('1', 'a menace')] },
      },
      { tab, frameId: 0 },
    );
    await vi.waitFor(async () => expect(await badge(tab.id)).toBe('1'));
    // Still loading, or a tab the badge never named: nothing is asked.
    await fakeBrowser.tabs.onUpdated.trigger(tab.id ?? -1, { status: 'loading' }, tab);
    await complete(other.id);
    expect(pinged).toEqual([]);
    // Reloaded on the same channel: its top frame names it again, and the count stays.
    ping = { site: 'twitch', partition: 'otherchannel' };
    await complete(tab.id);
    await vi.waitFor(() => expect(pinged).toEqual([tab.id]));
    expect(await badge(tab.id)).toBe('1');
    // A page with no stream ({}), or none with this extension's content script: empty.
    ping = {};
    await complete(tab.id);
    await vi.waitFor(async () => expect(await badge(tab.id)).toBe(''));
    ping = { site: 'twitch', partition: 'otherchannel' };
    await complete(tab.id);
    await vi.waitFor(async () => expect(await badge(tab.id)).toBe('1'));
    ping = undefined;
    await complete(tab.id);
    await vi.waitFor(async () => expect(await badge(tab.id)).toBe(''));
    stop();
    expect(fakeBrowser.tabs.onUpdated.hasListeners()).toBe(false);

    // A restarted service worker knows no tab, but Chrome kept a badge on one: that tab is asked
    // once it finishes loading, and a tab without a badge is not.
    pinged.length = 0;
    await fakeBrowser.action.setBadgeText({ tabId: tab.id, text: '4' });
    const restarted = startBackground();
    ping = {};
    await complete(other.id);
    await complete(tab.id);
    await vi.waitFor(async () => expect(await badge(tab.id)).toBe(''));
    expect(pinged).toEqual([tab.id]);
    restarted();
  });

  it('keeps processing comments with session-only feedback while the saved verdicts cannot be read', async () => {
    stubLlama();
    const deliver = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    // The first read of a new background is the saved feedback (then the settings): it fails.
    const get = vi
      .spyOn(fakeBrowser.storage.local, 'get')
      .mockRejectedValueOnce(new Error('unreadable'));
    const set = vi.spyOn(fakeBrowser.storage.local, 'set');
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (
      message: unknown,
      sender: Browser.runtime.MessageSender = panel,
    ): Promise<unknown> => new Promise((resolve) => listener?.(message, sender, resolve));
    const tab = await fakeBrowser.tabs.create({ url: 'https://www.youtube.com/live_chat?v=x' });
    const partition = { site: 'youtube', channel: 'UC-test' } as const;
    expect(
      await ask(
        {
          type: 'comments/ingest',
          payload: { ...partition, comments: [raw('1', 'you are a menace')] },
        },
        { tab, frameId: 0 },
      ),
    ).toEqual(Ok({ accepted: 1, dropped: 0 }));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(await ask({ type: 'comments/hidden', payload: partition })).toMatchObject({
      ok: true,
      value: [{ id: '1', category: 'abusive' }],
    });
    expect(await ask({ type: 'comments/stats', payload: partition })).toMatchObject({
      ok: true,
      value: { records: 1, feedbackError: 'storage_failed' },
    });
    // The verdict works for this session; it is saved once the stored ones can be read.
    expect(
      await ask({ type: 'comments/feedback', payload: { ...partition, id: '1', verdict: 'ok' } }),
    ).toEqual(Ok({ persisted: false }));
    expect(deliver).toHaveBeenCalledTimes(2);
    // Nothing was written over the verdicts that could not be read.
    expect(set.mock.calls.some(([items]) => Object.hasOwn(items, 'feedback'))).toBe(false);
    expect(get.mock.calls[0]?.[0]).toBe('feedback');
    // Within 30 s of the failed read the store does not read again.
    expect(get.mock.calls.filter(([keys]) => keys === 'feedback')).toHaveLength(1);
    stop();
  });

  it("registers the stream a page reports and answers the side panel with its tab's stream", async () => {
    const tab = await fakeBrowser.tabs.create({
      url: 'https://www.youtube.com/watch?v=fixture0001',
    });
    const other = await fakeBrowser.tabs.create({ url: 'https://example.com/' });
    // The watch page's top frame answers a ping with the partition it shows; other tabs have
    // no content script. (Replaced, not spied: the spy would take the callback overload.)
    const toTab = vi.fn<(tabId: number, message: unknown, options?: unknown) => Promise<unknown>>(
      async (tabId, message) => {
        if ((message as { type?: string }).type !== 'comments/ping') return undefined;
        if (tabId === tab.id) return { site: 'youtube', partition: 'fixture0001#comments' };
        throw new Error('Could not establish connection. Receiving end does not exist.');
      },
    );
    const original = fakeBrowser.tabs.sendMessage;
    Object.assign(fakeBrowser.tabs, { sendMessage: toTab });
    onTestFinished(() => void Object.assign(fakeBrowser.tabs, { sendMessage: original }));
    const broadcast = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => listener?.(message, sender, resolve));
    const page = { tab, frameId: 0, url: 'https://www.youtube.com/watch?v=fixture0001' };
    const report = {
      type: 'comments/context',
      payload: {
        site: 'youtube',
        partition: 'fixture0001#comments',
        streamer: '@FixtureStreamer',
        title: 'Fixture Quest Part 3',
      },
    };
    const known = {
      site: 'youtube',
      partition: 'fixture0001',
      streamer: '@FixtureStreamer',
      title: 'Fixture Quest Part 3',
    };

    expect(await ask(report, panel)).toMatchObject({
      ok: false,
      error: { internalCode: 'input_invalid' },
    });
    expect(await ask(report, page)).toEqual(Ok({}));
    // Every frame of the tab (the chat iframe knows only the video) learns the streamer, and an
    // open side panel hears that a stream changed.
    expect(toTab).toHaveBeenCalledWith(tab.id, { type: 'comments/stream-info', payload: known });
    expect(broadcast).toHaveBeenCalledWith({ type: 'comments/stream-changed' });
    // Nothing on the page names a genre yet, and no chat asked for the guess: other.
    expect(await ask({ type: 'comments/stream', payload: { tabId: tab.id ?? -1 } }, panel)).toEqual(
      Ok({
        stream: known,
        genre: {
          genre: 'other',
          reason: 'none',
          detected: 'other',
          detectedReason: 'none',
          categories: ['relay', 'privacy', 'sensitive'],
        },
      }),
    );
    expect(toTab).toHaveBeenCalledWith(tab.id, { type: 'comments/ping' }, { frameId: 0 });
    expect(
      await ask({ type: 'comments/stream', payload: { tabId: other.id ?? -1 } }, panel),
    ).toEqual(Ok({}));
    // Only extension pages ask which stream a tab shows.
    expect(
      await ask({ type: 'comments/stream', payload: { tabId: tab.id ?? -1 } }, page),
    ).toMatchObject({ ok: false, error: { internalCode: 'sender_forbidden' } });

    // The chat iframe of the same video reports only its partition: nothing changes, but it
    // is told the streamer.
    broadcast.mockClear();
    toTab.mockClear();
    const iframe = { tab, frameId: 5, url: 'https://www.youtube.com/live_chat?continuation=x' };
    expect(
      await ask(
        { type: 'comments/context', payload: { site: 'youtube', partition: 'fixture0001' } },
        iframe,
      ),
    ).toEqual(Ok({}));
    expect(toTab).toHaveBeenCalledWith(tab.id, { type: 'comments/stream-info', payload: known });
    expect(broadcast).not.toHaveBeenCalled();
    // The top frame left the stream (YouTube home): the side panel hears it.
    expect(await ask({ type: 'comments/context', payload: { site: 'youtube' } }, page)).toEqual(
      Ok({}),
    );
    expect(broadcast).toHaveBeenCalledWith({ type: 'comments/stream-changed' });
    stop();
    expect(fakeBrowser.storage.local.onChanged.hasListeners()).toBe(false);
  });

  it("puts the stream title and the stream's own spoiler note into the batch prompt", async () => {
    const sent = stubLlama();
    const notes = spoilerNoteStore(fakeBrowser.storage.local);
    await notes.save('youtube', 'fixture0001', 'past the frozen bridge');
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => listener?.(message, sender, resolve));
    const tab = await fakeBrowser.tabs.create({
      url: 'https://www.youtube.com/watch?v=fixture0001',
    });
    await ask(
      {
        type: 'comments/context',
        payload: {
          site: 'youtube',
          partition: 'fixture0001#comments',
          streamer: '@FixtureStreamer',
          title: 'Fixture Quest Part 3',
        },
      },
      { tab, frameId: 0, url: 'https://www.youtube.com/watch?v=fixture0001' },
    );
    const iframe = { tab, frameId: 5, url: 'https://www.youtube.com/live_chat?continuation=x' };
    const contexts = (): unknown[] =>
      batches(sent).map(
        (s) => (s.body['messages'] as { content: string }[])[1]?.content.split('\n')[0],
      );
    await ask(
      {
        type: 'comments/ingest',
        payload: { site: 'youtube', channel: 'fixture0001', comments: [raw('1', 'hello')] },
      },
      iframe,
    );
    await vi.waitFor(() => expect(contexts()).toHaveLength(1));
    expect(contexts()[0]).toBe(
      `Stream context: ${JSON.stringify('Title: Fixture Quest Part 3\nSpoiler targets: past the frozen bridge')}`,
    );
    // The side panel saves a new note: the next batch uses it.
    await notes.save('youtube', 'fixture0001', 'past the final boss');
    await ask(
      {
        type: 'comments/ingest',
        payload: { site: 'youtube', channel: 'fixture0001', comments: [raw('2', 'hello again')] },
      },
      iframe,
    );
    await vi.waitFor(() => expect(contexts()).toHaveLength(2));
    expect(contexts()[1]).toBe(
      `Stream context: ${JSON.stringify('Title: Fixture Quest Part 3\nSpoiler targets: past the final boss')}`,
    );
    // Another stream of the same streamer has no note of its own (R30).
    await ask(
      {
        type: 'comments/ingest',
        payload: {
          site: 'youtube',
          channel: 'fixture0002',
          streamer: '@FixtureStreamer',
          title: 'Fixture Quest Part 4',
          comments: [raw('3', 'hello there')],
        },
      },
      iframe,
    );
    await vi.waitFor(() => expect(contexts()).toHaveLength(3));
    expect(contexts()[2]).toBe(`Stream context: ${JSON.stringify('Title: Fixture Quest Part 4')}`);
    stop();
  });

  it('tells a frame that sent comments without the streamer which streamer it is, once', async () => {
    stubLlama();
    const toTab = vi.fn<(tabId: number, message: unknown, options?: unknown) => Promise<unknown>>(
      async () => undefined,
    );
    const original = fakeBrowser.tabs.sendMessage;
    Object.assign(fakeBrowser.tabs, { sendMessage: toTab });
    onTestFinished(() => void Object.assign(fakeBrowser.tabs, { sendMessage: original }));
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => listener?.(message, sender, resolve));
    // The popout was opened first: it knew only its video when it reported.
    const popoutTab = await fakeBrowser.tabs.create({
      url: 'https://www.youtube.com/live_chat?is_popout=1&v=fixture0001',
    });
    const popout = {
      tab: popoutTab,
      frameId: 0,
      url: 'https://www.youtube.com/live_chat?is_popout=1&v=fixture0001',
    };
    await ask(
      { type: 'comments/context', payload: { site: 'youtube', partition: 'fixture0001' } },
      popout,
    );
    // Then the watch page, in another tab, names the streamer (told to its own tab only).
    const watchTab = await fakeBrowser.tabs.create({
      url: 'https://www.youtube.com/watch?v=fixture0001',
    });
    await ask(
      {
        type: 'comments/context',
        payload: {
          site: 'youtube',
          partition: 'fixture0001#comments',
          streamer: '@FixtureStreamer',
          title: 'Fixture Quest Part 3',
        },
      },
      { tab: watchTab, frameId: 0, url: 'https://www.youtube.com/watch?v=fixture0001' },
    );
    const told = (tabId: number | undefined) =>
      toTab.mock.calls.filter(
        ([to, message]) =>
          to === tabId && (message as { type?: string }).type === 'comments/stream-info',
      );
    expect(told(popoutTab.id)).toEqual([]);
    const ingest = (id: string) => ({
      type: 'comments/ingest',
      payload: { site: 'youtube', channel: 'fixture0001', comments: [raw(id, `hello ${id}`)] },
    });
    // The popout's next comments come without the streamer: it is told, in its own frame.
    await ask(ingest('1'), popout);
    expect(told(popoutTab.id)).toEqual([
      [
        popoutTab.id,
        {
          type: 'comments/stream-info',
          payload: {
            site: 'youtube',
            partition: 'fixture0001',
            streamer: '@FixtureStreamer',
            title: 'Fixture Quest Part 3',
          },
        },
        { frameId: 0 },
      ],
    ]);
    // Once: comments sent before the message arrived do not repeat it.
    await ask(ingest('2'), popout);
    expect(told(popoutTab.id)).toHaveLength(1);
    stop();
  });

  it('learns the stream again from the frames after the service worker restarted', async () => {
    // Chrome stops an idle service worker: what the pages reported is gone, the pages are not.
    const sent = stubLlama();
    await spoilerNoteStore(fakeBrowser.storage.local).save(
      'youtube',
      'fixture0001',
      'past the frozen bridge',
    );
    const tab = await fakeBrowser.tabs.create({
      url: 'https://www.youtube.com/watch?v=fixture0001',
    });
    const toTab = vi.fn<(tabId: number, message: unknown, options?: unknown) => Promise<unknown>>(
      async (_tabId, message) =>
        (message as { type?: string }).type === 'comments/ping'
          ? {
              site: 'youtube',
              partition: 'fixture0001#comments',
              streamer: '@FixtureStreamer',
              title: 'Fixture Quest Part 3',
            }
          : undefined,
    );
    const original = fakeBrowser.tabs.sendMessage;
    Object.assign(fakeBrowser.tabs, { sendMessage: toTab });
    onTestFinished(() => void Object.assign(fakeBrowser.tabs, { sendMessage: original }));
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => listener?.(message, sender, resolve));
    // The chat frame sends what it learned with its comments.
    const iframe = { tab, frameId: 5, url: 'https://www.youtube.com/live_chat?continuation=x' };
    await ask(
      {
        type: 'comments/ingest',
        payload: {
          site: 'youtube',
          channel: 'fixture0001',
          streamer: '@FixtureStreamer',
          title: 'Fixture Quest Part 3',
          comments: [raw('1', 'hello')],
        },
      },
      iframe,
    );
    const prompts = (): unknown[] =>
      batches(sent).map(
        (s) => (s.body['messages'] as { content: string }[])[1]?.content.split('\n')[0],
      );
    await vi.waitFor(() => expect(prompts()).toHaveLength(1));
    expect(prompts()[0]).toBe(
      `Stream context: ${JSON.stringify('Title: Fixture Quest Part 3\nSpoiler targets: past the frozen bridge')}`,
    );
    stop();

    // Another restart: the side panel's question alone tells the stream again (the top frame
    // answers the ping with what it shows).
    const again = startBackground();
    const restarted = add.mock.calls.at(-1)?.[0];
    expect(
      await new Promise((resolve) =>
        restarted?.({ type: 'comments/stream', payload: { tabId: tab.id ?? -1 } }, panel, resolve),
      ),
    ).toMatchObject(
      Ok({
        stream: {
          site: 'youtube',
          partition: 'fixture0001',
          streamer: '@FixtureStreamer',
          title: 'Fixture Quest Part 3',
        },
        // With the spoiler note read again (R64).
        genre: { categories: ['spoiler', 'relay', 'privacy', 'sensitive'] },
      }),
    );
    again();
  });

  it('detects the genre from what the page reports and answers the side panel with it (R63)', async () => {
    const sent = stubLlama();
    const tab = await fakeBrowser.tabs.create({
      url: 'https://www.youtube.com/watch?v=fixture0001',
    });
    const shown = {
      site: 'youtube',
      partition: 'fixture0001#comments',
      streamer: '@FixtureStreamer',
      title: '【ホラー】Fixture Haunt',
      game: 'Fixture Haunt',
      rules: '【お約束】\n・ネタバレOKです',
    };
    const toTab = vi.fn<(tabId: number, message: unknown, options?: unknown) => Promise<unknown>>(
      async (_tabId, message) =>
        (message as { type?: string }).type === 'comments/ping' ? shown : undefined,
    );
    const original = fakeBrowser.tabs.sendMessage;
    Object.assign(fakeBrowser.tabs, { sendMessage: toTab });
    onTestFinished(() => void Object.assign(fakeBrowser.tabs, { sendMessage: original }));
    const broadcast = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => listener?.(message, sender, resolve));
    const page = { tab, frameId: 0, url: 'https://www.youtube.com/watch?v=fixture0001' };
    expect(await ask({ type: 'comments/context', payload: shown }, page)).toEqual(Ok({}));
    expect(broadcast).toHaveBeenCalledWith({ type: 'comments/stream-changed' });
    // The title's 【ホラー】 decides; the rules allow spoilers, so only instructions stay of the
    // genre's own categories.
    const horror = {
      genre: 'horror',
      reason: 'title',
      detected: 'horror',
      detectedReason: 'title',
      categories: ['instruction', 'relay', 'privacy', 'sensitive'],
    };
    expect(await ask({ type: 'comments/stream', payload: { tabId: tab.id ?? -1 } }, panel)).toEqual(
      Ok({
        stream: {
          site: 'youtube',
          partition: 'fixture0001',
          streamer: '@FixtureStreamer',
          title: '【ホラー】Fixture Haunt',
        },
        genre: horror,
      }),
    );
    // Pages are never told the genre.
    const told = toTab.mock.calls.filter(
      ([, message]) => (message as { type?: string }).type === 'comments/stream-info',
    );
    expect(told.length).toBeGreaterThan(0);
    expect(JSON.stringify(told)).not.toContain('horror');
    // The batch prompt names the genre and defines its categories.
    const iframe = { tab, frameId: 5, url: 'https://www.youtube.com/live_chat?continuation=x' };
    await ask(
      {
        type: 'comments/ingest',
        payload: { site: 'youtube', channel: 'fixture0001', comments: [raw('1', 'hello')] },
      },
      iframe,
    );
    await vi.waitFor(() => expect(batches(sent)).toHaveLength(1));
    const user = userTurn(batches(sent)[0]);
    expect(user).toContain('Stream genre: horror');
    expect(user).toContain('- n = instruction');
    expect(user).not.toContain('- p = spoiler');
    // The page decided: no guess.
    expect(sent.filter(isGenreGuess)).toEqual([]);
    // The viewer's spoiler note turns spoilers on again (R64).
    await spoilerNoteStore(fakeBrowser.storage.local).save('youtube', 'fixture0001', 'chapter 2');
    expect(
      await ask({ type: 'comments/stream', payload: { tabId: tab.id ?? -1 } }, panel),
    ).toMatchObject(
      Ok({ genre: { categories: ['spoiler', 'instruction', 'relay', 'privacy', 'sensitive'] } }),
    );
    expect(await fakeBrowser.storage.local.get(STREAM_GENRES_KEY)).toEqual({
      [STREAM_GENRES_KEY]: [
        {
          site: 'youtube',
          stream: 'fixture0001',
          genre: 'horror',
          reason: 'title',
          relaxations: ['spoiler'],
          game: 'Fixture Haunt',
        },
      ],
    });
    stop();
  });

  it("guesses an undecided stream's genre once, only while its chat is in front, and keeps it (R44, R63)", async () => {
    const sent = stubLlama(Promise.resolve(), 3, { genre: 'story' });
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const broadcast = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => add.mock.calls.at(-1)?.[0]?.(message, sender, resolve));
    const tab = await fakeBrowser.tabs.create({ url: 'https://www.twitch.tv/fixturechannel' });
    const frame = { tab, frameId: 0, url: 'https://www.twitch.tv/fixturechannel' };
    const report = {
      type: 'comments/context',
      payload: {
        site: 'twitch',
        partition: 'fixturechannel',
        streamer: 'fixturechannel',
        title: 'Fixture night: part 3',
        game: 'fixture-quest',
        tags: ['日本語'],
      },
    };
    await ask(report, frame);
    const ingest = (id: string, process = true) => ({
      type: 'comments/ingest',
      payload: {
        site: 'twitch',
        channel: 'fixturechannel',
        streamer: 'fixturechannel',
        title: 'Fixture night: part 3',
        process,
        comments: [raw(id, `hello ${id}`)],
      },
    });
    // A chat not in front of the viewer is never processed, and asks for no guess (R44).
    await ask(ingest('1', false), frame);
    expect(sent.filter(isGenreGuess)).toEqual([]);
    broadcast.mockClear();
    await ask(ingest('2'), frame);
    await vi.waitFor(() => expect(sent.filter(isGenreGuess)).toHaveLength(1));
    const [guess] = sent.filter(isGenreGuess);
    // On a comment slot (never 0, subtitles keep it), with the translation model.
    expect(guess?.body['model']).toBe('gemma4-e4b');
    expect(guess?.body['id_slot']).toBeGreaterThanOrEqual(1);
    expect(userTurn(guess)).toBe(
      'Title (JSON string): "Fixture night: part 3"\nGame (JSON string or null): "fixture-quest"',
    );
    await vi.waitFor(() =>
      expect(broadcast).toHaveBeenCalledWith({ type: 'comments/stream-changed' }),
    );
    await ask(ingest('3'), frame);
    await vi.waitFor(() => expect(batches(sent).length).toBeGreaterThanOrEqual(2));
    // Once per stream: the next comments ask nothing more, and their prompt has the genre.
    expect(sent.filter(isGenreGuess)).toHaveLength(1);
    expect(userTurn(batches(sent).at(-1))).toContain('Stream genre: story');
    stop();

    // A restarted service worker keeps the guess: no second one.
    const again = startBackground();
    await ask(ingest('4'), frame);
    await vi.waitFor(() => expect(batches(sent).length).toBeGreaterThanOrEqual(3));
    expect(sent.filter(isGenreGuess)).toHaveLength(1);
    expect(userTurn(batches(sent).at(-1))).toContain('Stream genre: story');
    again();
  });

  it('drops a Twitch choice and guess made under another category, and guesses again (R69)', async () => {
    const sent = stubLlama(Promise.resolve(), 3, { genre: 'story' });
    const shown = {
      site: 'twitch',
      partition: 'fixturechannel',
      streamer: 'fixturechannel',
      title: 'Fixture night',
      game: 'phasmophobia',
    };
    const toTab = vi.fn<(tabId: number, message: unknown, options?: unknown) => Promise<unknown>>(
      async (_tabId, message) =>
        (message as { type?: string }).type === 'comments/ping' ? shown : undefined,
    );
    const original = fakeBrowser.tabs.sendMessage;
    Object.assign(fakeBrowser.tabs, { sendMessage: toTab });
    onTestFinished(() => void Object.assign(fakeBrowser.tabs, { sendMessage: original }));
    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => listener?.(message, sender, resolve));
    const tab = await fakeBrowser.tabs.create({ url: 'https://www.twitch.tv/fixturechannel' });
    const frame = { tab, frameId: 0, url: 'https://www.twitch.tv/fixturechannel' };
    const report = (title: string, game: string) =>
      ask({ type: 'comments/context', payload: { ...shown, title, game } }, frame);
    const stream = { type: 'comments/stream', payload: { tabId: tab.id ?? -1 } };
    let comment = 0;
    const ingest = (title: string) => {
      comment += 1;
      return ask(
        {
          type: 'comments/ingest',
          payload: {
            site: 'twitch',
            channel: 'fixturechannel',
            streamer: 'fixturechannel',
            title,
            comments: [raw(String(comment), `hello ${comment}`)],
          },
        },
        frame,
      );
    };
    // Under a horror category the viewer chooses another genre ...
    await report('Fixture night', 'phasmophobia');
    expect(
      await ask(
        {
          type: 'comments/genre',
          payload: { site: 'twitch', partition: 'fixturechannel', genre: 'chat' },
        },
        panel,
      ),
    ).toEqual(Ok({ persisted: true }));
    expect(await ask(stream, panel)).toMatchObject(
      Ok({ genre: { genre: 'chat', reason: 'viewer' } }),
    );
    // ... which no longer applies once the channel streams an FPS.
    Object.assign(shown, { game: 'apex-legends' });
    await report('Fixture night', 'apex-legends');
    expect(await ask(stream, panel)).toMatchObject(
      Ok({
        genre: { genre: 'fps', reason: 'game', categories: expect.arrayContaining(['ghosting']) },
      }),
    );
    // Under a category the table does not list, the stream is guessed once ...
    Object.assign(shown, { title: 'Fixture night: part 1', game: 'fixture-quest' });
    await report('Fixture night: part 1', 'fixture-quest');
    await ingest('Fixture night: part 1');
    await vi.waitFor(() => expect(sent.filter(isGenreGuess)).toHaveLength(1));
    await vi.waitFor(async () =>
      expect(await ask(stream, panel)).toMatchObject(Ok({ genre: { reason: 'guess' } })),
    );
    await ingest('Fixture night: part 1');
    // ... and guessed again for a new title there: the old guess is stale.
    Object.assign(shown, { title: 'Fixture night: part 2' });
    await report('Fixture night: part 2', 'fixture-quest');
    await ingest('Fixture night: part 2');
    await vi.waitFor(() => expect(sent.filter(isGenreGuess)).toHaveLength(2));
    expect(userTurn(sent.filter(isGenreGuess)[1])).toContain('Fixture night: part 2');
    stop();
  });

  it("keeps the viewer's genre for one stream, for extension pages only (R63)", async () => {
    stubLlama();
    const tab = await fakeBrowser.tabs.create({ url: 'https://www.twitch.tv/fixturechannel' });
    const toTab = vi.fn<(tabId: number, message: unknown, options?: unknown) => Promise<unknown>>(
      async (_tabId, message) =>
        (message as { type?: string }).type === 'comments/ping'
          ? {
              site: 'twitch',
              partition: 'fixturechannel',
              streamer: 'fixturechannel',
              title: 'Fixture night',
              game: 'just-chatting',
            }
          : undefined,
    );
    const original = fakeBrowser.tabs.sendMessage;
    Object.assign(fakeBrowser.tabs, { sendMessage: toTab });
    onTestFinished(() => void Object.assign(fakeBrowser.tabs, { sendMessage: original }));
    const broadcast = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => listener?.(message, sender, resolve));
    const stream = { type: 'comments/stream', payload: { tabId: tab.id ?? -1 } };
    expect(await ask(stream, panel)).toMatchObject(
      Ok({ genre: { genre: 'chat', reason: 'game', detected: 'chat', detectedReason: 'game' } }),
    );
    const choose = (genre?: string) => ({
      type: 'comments/genre',
      payload: { site: 'twitch', partition: 'fixturechannel', ...(genre ? { genre } : {}) },
    });
    // A content script may not choose for the viewer.
    expect(
      await ask(choose('fps'), { tab, frameId: 0, url: 'https://www.twitch.tv/fixturechannel' }),
    ).toMatchObject({ ok: false, error: { internalCode: 'sender_forbidden' } });
    expect(await ask(choose('fps'), panel)).toEqual(Ok({ persisted: true }));
    expect(broadcast).toHaveBeenCalledWith({ type: 'comments/stream-changed' });
    expect(await ask(stream, panel)).toEqual(
      Ok({
        stream: {
          site: 'twitch',
          partition: 'fixturechannel',
          streamer: 'fixturechannel',
          title: 'Fixture night',
        },
        genre: {
          genre: 'fps',
          reason: 'viewer',
          detected: 'chat',
          detectedReason: 'game',
          categories: ['instruction', 'relay', 'ghosting', 'privacy', 'sensitive'],
        },
      }),
    );
    // Cleared: detected again.
    expect(await ask(choose(), panel)).toEqual(Ok({ persisted: true }));
    expect(await ask(stream, panel)).toMatchObject(
      Ok({ genre: { genre: 'chat', reason: 'game' } }),
    );
    stop();
  });

  it('uses the model names saved after a settings change', async () => {
    const sent = stubLlama();
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const tab = await fakeBrowser.tabs.create({ url: 'https://www.twitch.tv/test' });
    const ingest = (ids: string[]): Promise<unknown> =>
      new Promise((resolve) =>
        listener?.(
          {
            type: 'comments/ingest',
            payload: {
              site: 'twitch',
              channel: 'test',
              comments: ids.map((id) => raw(id, `hi ${id}`)),
            },
          },
          { tab, frameId: 0 },
          resolve,
        ),
      );
    const chatModels = (): unknown[] =>
      sent.filter((s) => s.path === '/v1/chat/completions').map((s) => s.body['model']);

    await ingest(['a', 'b', 'c']);
    await vi.waitFor(() => expect(chatModels()).toEqual(['gemma4-e4b']));
    await fakeBrowser.storage.local.set({
      settings: {
        llamaBaseUrl: 'http://127.0.0.1:18083',
        models: { translate: 'gemma4-e2b', clef: 'clef-flash', asr: 'gemma4-e4b' },
      },
    });
    await ingest(['d', 'e', 'f']);
    await vi.waitFor(() => expect(chatModels()).toEqual(['gemma4-e4b', 'gemma4-e2b']));
    stop();
  });

  it('judges with Clef while the translate call runs, on separate queues', async () => {
    let open: () => void = () => undefined;
    const sent = stubLlama(
      new Promise((resolve) => {
        open = resolve;
      }),
    );
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const tab = await fakeBrowser.tabs.create({ url: 'https://www.twitch.tv/test' });
    await new Promise((resolve) =>
      listener?.(
        {
          type: 'comments/ingest',
          payload: { site: 'twitch', channel: 'test', comments: [raw('1', 'hello there clown')] },
        },
        { tab, frameId: 0 },
        resolve,
      ),
    );
    await vi.waitFor(() =>
      expect(sent.map((s) => s.path).sort()).toEqual([
        '/props?model=gemma4-e4b',
        '/v1/chat/completions',
        '/v1/systemone',
      ]),
    );
    open();
    stop();
  });

  it('aborts the slot-count request of a pipeline on cleanup', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (input: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            if (new URL(input).pathname !== '/props') return;
            const signal = init?.signal;
            if (signal) signals.push(signal);
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
    );
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const tab = await fakeBrowser.tabs.create({ url: 'https://www.twitch.tv/test' });
    await new Promise((resolve) =>
      listener?.(
        {
          type: 'comments/ingest',
          payload: { site: 'twitch', channel: 'test', comments: [raw('1', 'lol')] },
        },
        { tab, frameId: 0 },
        resolve,
      ),
    );
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(false);
    stop();
    expect(signals[0]?.aborted).toBe(true);
  });

  it.each([
    { totalSlots: 2, inFlight: 1 },
    { totalSlots: 3, inFlight: 2 },
  ])(
    'runs $inFlight comment batches at once when the server reports $totalSlots slots',
    async ({ totalSlots, inFlight }) => {
      let open: () => void = () => undefined;
      const sent = stubLlama(
        new Promise((resolve) => {
          open = resolve;
        }),
        totalSlots,
      );
      vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
      const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
      const stop = startBackground();
      const listener = add.mock.calls[0]?.[0];
      const tab = await fakeBrowser.tabs.create({ url: 'https://www.twitch.tv/test' });
      const ingest = (comments: ReturnType<typeof raw>[]): Promise<unknown> =>
        new Promise((resolve) =>
          listener?.(
            { type: 'comments/ingest', payload: { site: 'twitch', channel: 'test', comments } },
            { tab, frameId: 0 },
            resolve,
          ),
        );
      const chats = (): number[] =>
        sent.filter((s) => s.path === '/v1/chat/completions').map((s) => Number(s.body['id_slot']));
      await ingest([raw('1', 'hello')]);
      // The slot count was asked for before the first batch reached the server.
      await vi.waitFor(() => expect(chats()).toEqual([1]));
      expect(sent.some((s) => s.path.startsWith('/props'))).toBe(true);
      await ingest([raw('2', 'second'), raw('3', 'third')]);
      // With a spare slot the second batch starts while the first is held on slot 1.
      await vi.waitFor(() => expect(chats()).toEqual(inFlight === 2 ? [1, 2] : [1]));
      open();
      await vi.waitFor(() => expect(chats()).toHaveLength(2));
      // Without one it waited for the first batch and then took slot 1 again.
      expect(chats()).toEqual(inFlight === 2 ? [1, 2] : [1, 1]);
      stop();
    },
  );
  it.each([
    { name: 'slot 0 busy', processing: [0], held: [1], slots: [1, 1] },
    { name: 'slot 0 idle', processing: [], held: [1, 2], slots: [1, 2] },
  ])(
    "asks /slots for its translation model's slot 0 before a second batch: $name",
    async ({ processing, held, slots }) => {
      let open: () => void = () => undefined;
      const sent = stubLlama(
        new Promise((resolve) => {
          open = resolve;
        }),
        3,
        { processing },
      );
      vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
      const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
      const stop = startBackground();
      const listener = add.mock.calls[0]?.[0];
      const tab = await fakeBrowser.tabs.create({ url: 'https://www.twitch.tv/test' });
      const ingest = (comments: ReturnType<typeof raw>[]): Promise<unknown> =>
        new Promise((resolve) =>
          listener?.(
            { type: 'comments/ingest', payload: { site: 'twitch', channel: 'test', comments } },
            { tab, frameId: 0 },
            resolve,
          ),
        );
      const chats = (): number[] =>
        sent.filter((s) => s.path === '/v1/chat/completions').map((s) => Number(s.body['id_slot']));
      await ingest([raw('1', 'hello')]);
      await vi.waitFor(() => expect(chats()).toEqual([1]));
      await vi.waitFor(() => expect(sent.some((s) => s.path.startsWith('/props'))).toBe(true));
      // The first batch never asked; the first comment waiting beside it does.
      expect(sent.filter((s) => s.path.startsWith('/slots'))).toEqual([]);
      await ingest([raw('2', 'second')]);
      await vi.waitFor(() =>
        expect(sent.filter((s) => s.path.startsWith('/slots')).map((s) => s.path)).toEqual([
          '/slots?model=gemma4-e4b',
        ]),
      );
      // What runs before the first batch answers: only it while subtitles use slot 0.
      await vi.waitFor(() => expect(chats()).toEqual(held));
      for (let i = 0; i < 50; i += 1) await Promise.resolve();
      expect(chats()).toEqual(held);
      open();
      await vi.waitFor(() => expect(chats()).toHaveLength(2));
      expect(chats()).toEqual(slots);
      stop();
    },
  );
  it('asks for the slot count again after the first answered batch when the first ask failed (R53)', async () => {
    let door = Promise.resolve();
    let open: () => void = () => undefined;
    const sent = stubLlama(() => door, 3, { propsFailures: 1 });
    vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const tab = await fakeBrowser.tabs.create({ url: 'https://www.twitch.tv/test' });
    const ingest = (comments: ReturnType<typeof raw>[]): Promise<unknown> =>
      new Promise((resolve) =>
        listener?.(
          { type: 'comments/ingest', payload: { site: 'twitch', channel: 'test', comments } },
          { tab, frameId: 0 },
          resolve,
        ),
      );
    const props = (): Sent[] => sent.filter((s) => s.path.startsWith('/props'));
    const chats = (): number[] =>
      sent.filter((s) => s.path === '/v1/chat/completions').map((s) => Number(s.body['id_slot']));
    // llama.cpp was down when the pipeline was built: the slot count is unknown.
    await ingest([raw('1', 'hello')]);
    await vi.waitFor(() =>
      expect(props().map((s) => s.path)).toEqual([
        '/props?model=gemma4-e4b',
        '/props?model=gemma4-e4b',
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    door = new Promise((resolve) => {
      open = resolve;
    });
    await ingest([raw('2', 'second')]);
    await ingest([raw('3', 'third')]);
    // The second batch starts on slot 2 while the first is held on slot 1.
    await vi.waitFor(() => expect(chats()).toEqual([1, 1, 2]));
    open();
    // Once known, the count is not asked again.
    await ingest([raw('4', 'fourth')]);
    await vi.waitFor(() => expect(chats()).toHaveLength(4));
    expect(props()).toHaveLength(2);
    stop();
  });

  it('summarizes a channel for extension pages only, on a comment slot with the translation model', async () => {
    const sent = stubLlama();
    const deliver = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => listener?.(message, sender, resolve));
    const tab = await fakeBrowser.tabs.create({ url: 'https://www.youtube.com/live_chat?v=x' });
    const partition = { site: 'youtube', channel: 'UC-test' } as const;
    await ask(
      {
        type: 'comments/ingest',
        payload: { ...partition, comments: [raw('1', 'what game is this'), raw('2', 'がんばれ')] },
      },
      { tab, frameId: 3 },
    );
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const summary = { type: 'comments/summary', payload: { ...partition, windowMinutes: 5 } };
    for (const sender of [
      { tab, frameId: 3, url: 'https://www.youtube.com/live_chat?v=x' },
      { tab, frameId: 3 },
      { ...panel, origin: 'null' },
    ])
      expect(await ask(summary, sender)).toMatchObject({
        ok: false,
        error: { internalCode: 'sender_forbidden' },
      });
    // The stub's reply has no summary lines: the counted parts come back all the same.
    expect(await ask(summary, panel)).toMatchObject({
      ok: true,
      value: { windowMinutes: 5, total: 2, languages: ['ja', 'und-Latn'], topics: [] },
    });
    const asked = sent.filter(
      (s) =>
        s.path === '/v1/chat/completions' && String(s.body['grammar']).startsWith('root ::= topic'),
    );
    expect(asked.map((s) => [s.body['model'], s.body['id_slot'], s.body['max_tokens']])).toEqual([
      ['gemma4-e4b', 1, 256],
    ]);
    stop();
  });

  it('creates no timer for summaries: the side panel asks for each one', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    stubLlama();
    const deliver = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
    const stop = startBackground();
    const listener = add.mock.calls[0]?.[0];
    const ask = (message: unknown, sender: Browser.runtime.MessageSender): Promise<unknown> =>
      new Promise((resolve) => listener?.(message, sender, resolve));
    const tab = await fakeBrowser.tabs.create({ url: 'https://www.youtube.com/live_chat?v=x' });
    await ask(
      {
        type: 'comments/ingest',
        payload: { site: 'youtube', channel: 'UC-test', comments: [raw('1', 'hello there')] },
      },
      { tab, frameId: 3 },
    );
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    for (const windowMinutes of [5, 15, 30])
      expect(
        await ask(
          {
            type: 'comments/summary',
            payload: { site: 'youtube', channel: 'UC-test', windowMinutes },
          },
          panel,
        ),
      ).toMatchObject({ ok: true, value: { windowMinutes, total: 1 } });
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });
});
