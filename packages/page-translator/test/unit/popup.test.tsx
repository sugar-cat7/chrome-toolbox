// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Err, failure, Ok, type Result } from '@chrome-toolbox/contracts';
import { defaultSettings } from '@chrome-toolbox/extension-core';
import { App } from '../../src/entrypoints/popup/App.tsx';
import { popupPort, type PopupApi, type ProgressConnection } from '../../src/popup.ts';
import { PROGRESS_PORT, type Progress } from '../../src/protocol.ts';
import { startBackground } from '../../src/runtime.ts';
import { defaultPageSettings, type PageSettings } from '../../src/settings.ts';
import { fakeBackground, type FakeBackground } from './chrome.ts';

afterEach(() => {
  cleanup();
  // The popup entrypoint unmounts when Chrome closes its document.
  window.dispatchEvent(new Event('pagehide'));
  document.body.replaceChildren();
  fakeBrowser.reset();
  vi.resetModules();
  vi.restoreAllMocks();
});

const PAGE = 'https://wiki.fixture.test/guide';
const SITE = { host: 'wiki.fixture.test', pattern: 'https://wiki.fixture.test/*' } as const;
const TAB = 7;
/** The manifest's own hosts (wxt.config.ts): Chrome refuses to take them back. */
const REQUIRED = ['http://localhost/*', 'http://127.0.0.1/*'];
/** The popup is an extension page: the background answers its routes. */
const POPUP: Browser.runtime.MessageSender = {
  url: 'chrome-extension://test-extension-id/popup.html',
  origin: 'chrome-extension://test-extension-id',
};
/** A tab's progress as the page script sends it; each case changes what it needs. */
const progressOf = (change: Partial<Progress>): Progress => ({
  state: 'on',
  mode: 'replace',
  found: 0,
  done: 0,
  waiting: 0,
  failed: 0,
  tracked: 0,
  cached: 0,
  limit: false,
  ...change,
});

type Listener = (...args: never[]) => void;
/** One port event: the listeners added and not yet removed, and a way to fire it. */
function fakeEvent<L extends Listener>() {
  const listeners = new Set<L>();
  return {
    listeners,
    addListener: (listener: L): void => void listeners.add(listener),
    removeListener: (listener: L): void => void listeners.delete(listener),
  };
}
/** The popup's end of a progress port, and the page script's end that the tests drive. */
function fakeConnection() {
  const onMessage = fakeEvent<(message: unknown) => void>();
  const onDisconnect = fakeEvent<() => void>();
  let open = true;
  const connection: ProgressConnection = {
    onMessage,
    onDisconnect,
    disconnect: () => {
      open = false;
    },
  };
  return {
    connection,
    onMessage,
    onDisconnect,
    isOpen: () => open,
    /** The page script posts `message`. */
    post: (message: unknown): void => {
      for (const listener of [...onMessage.listeners]) listener(message);
    },
    /** The page's end goes away (no page script there, or the page was left). */
    close: (): void => {
      for (const listener of [...onDisconnect.listeners]) listener();
    },
  };
}
type FakeConnection = ReturnType<typeof fakeConnection>;

/** Chrome's prompt for a site's permission, until the viewer answers it. */
type Prompt = { origins: string[]; answer: (granted: boolean) => Promise<void> };

type World = {
  api: PopupApi;
  /**
   * What the popup did, in order: `connect <tab> <port> <frame>`, `send <type>`, `request <origin>`,
   * `remove <origin>`, `write <keys>` (storage) and `options`.
   */
  calls: string[];
  /** The progress ports the popup opened, in order. */
  connections: FakeConnection[];
  prompts: Prompt[];
  /** The background's view of Chrome (fakeBackground): the granted sites, the tab log. */
  chrome: FakeBackground;
};

/**
 * The popup's Chrome: the active tab `TAB` shows `url`; messages go to the real background
 * (startBackground on WXT's fake browser, as a popup sender) unless `answer` replies instead;
 * permission prompts wait for the test to answer them, and a grant reaches the background
 * (`permissions.onAdded`) as Chrome's would.
 */
function world(
  options: Readonly<{
    url?: string | undefined;
    granted?: readonly string[];
    answer?: (message: unknown) => Result<unknown>;
  }> = {},
): World {
  const { granted = [], answer } = options;
  // A tab may have no URL the popup can read: `url: undefined` is not the default page.
  const url = 'url' in options ? options.url : PAGE;
  const chrome = fakeBackground([...REQUIRED, ...granted]);
  const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
  startBackground();
  const background = add.mock.calls[0]?.[0];
  const calls: string[] = [];
  const connections: FakeConnection[] = [];
  const prompts: Prompt[] = [];
  const typeOf = (message: unknown): string =>
    typeof message === 'object' && message !== null && 'type' in message
      ? String(message.type)
      : '?';
  const api: PopupApi = {
    tabs: {
      query: async () => [{ id: TAB, ...(url === undefined ? {} : { url }) }],
      connect: (tabId, info) => {
        calls.push(`connect ${tabId} ${info.name} ${info.frameId}`);
        const connection = fakeConnection();
        connections.push(connection);
        return connection.connection;
      },
    },
    runtime: {
      sendMessage: (message) => {
        calls.push(`send ${typeOf(message)}`);
        if (answer !== undefined) return Promise.resolve(answer(message));
        return new Promise((resolve) => background?.(message, POPUP, resolve));
      },
      openOptionsPage: async () => {
        calls.push('options');
      },
      getManifest: () => ({ manifest_version: 3, host_permissions: REQUIRED }),
    },
    permissions: {
      request: ({ origins }) => {
        calls.push(`request ${origins.join(' ')}`);
        // Chrome answers at once, without a prompt, for sites it grants already.
        if (origins.every((origin) => chrome.granted.has(origin))) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          prompts.push({
            origins,
            answer: async (yes) => {
              if (yes) {
                for (const origin of origins) chrome.granted.add(origin);
                await chrome.permissionsAdded.trigger({ origins });
              }
              resolve(yes);
            },
          });
        });
      },
      remove: async ({ origins }) => {
        calls.push(`remove ${origins.join(' ')}`);
        for (const origin of origins) chrome.granted.delete(origin);
        return true;
      },
    },
    storage: {
      local: {
        get: (key) => fakeBrowser.storage.local.get(key),
        set: (items) => {
          calls.push(`write ${Object.keys(items).join(' ')}`);
          return fakeBrowser.storage.local.set(items);
        },
      },
    },
  };
  return { api, calls, connections, prompts, chrome };
}

const storePage = (change: Partial<PageSettings>): Promise<void> =>
  fakeBrowser.storage.local.set({ page: { ...defaultPageSettings, ...change } });
const storedPage = async (): Promise<unknown> => (await fakeBrowser.storage.local.get('page')).page;

/** Renders the popup for `world`, once it has read the tab and the settings. */
async function openPopup({ api }: World): Promise<void> {
  render(<App port={popupPort(api)} />);
  // The display mode waits for both.
  await waitFor(() => expect(control('置き換え').disabled).toBe(false));
}
/** The one button, switch or radio named `name`. */
const control = (name: string): HTMLInputElement | HTMLButtonElement => {
  const found = (['button', 'switch', 'radio'] as const).flatMap((role) =>
    screen.queryAllByRole(role, { name }),
  );
  const [only] = found;
  if (found.length === 1 && (only instanceof HTMLInputElement || only instanceof HTMLButtonElement))
    return only;
  throw new Error(`expected one control named ${name}, found ${found.length}`);
};
/** The switch or radio named `name`. */
const toggle = (name: string): HTMLInputElement => {
  const found = control(name);
  if (found instanceof HTMLInputElement) return found;
  throw new Error(`${name} is no switch or radio`);
};
const CONTROLS = [
  'このページを翻訳',
  '原文に戻す',
  '置き換え',
  '併記',
  'このサイトは常に翻訳',
  'このサイトでは翻訳しない',
] as const;

describe('popupPort', () => {
  it('reads the tab the toolbar button was pressed on, with the URL activeTab lets it read', async () => {
    const { api } = world();
    expect(await popupPort(api).activeTab()).toEqual(Ok({ id: TAB, url: PAGE }));
    const without = world({ url: undefined });
    expect(await popupPort(without.api).activeTab()).toEqual(Ok({ id: TAB, url: undefined }));
  });

  it('has no tab when the window shows none', async () => {
    const { api } = world();
    const port = popupPort({ ...api, tabs: { ...api.tabs, query: async () => [] } });
    expect(await port.activeTab()).toMatchObject(Err({ internalCode: 'resource_missing' }));
  });

  it('follows the progress of the top frame and lets go of the port', async () => {
    const { api, calls, connections } = world();
    const heard: (Progress | undefined)[] = [];
    const stop = popupPort(api).watch(TAB, (progress) => heard.push(progress));
    expect(calls).toEqual([`connect ${TAB} ${PROGRESS_PORT} 0`]);
    const [connection] = connections;
    connection?.post(progressOf({ found: 3, done: 1 }));
    // Anything else on the port is not progress.
    connection?.post({ found: 'many' });
    expect(heard).toEqual([progressOf({ found: 3, done: 1 })]);
    stop();
    expect(connection?.isOpen()).toBe(false);
    expect(connection?.onMessage.listeners.size).toBe(0);
    expect(connection?.onDisconnect.listeners.size).toBe(0);
  });

  it('has no progress when no page script takes the port, or Chrome refuses it', () => {
    const { api, connections } = world();
    const heard: (Progress | undefined)[] = [];
    popupPort(api).watch(TAB, (progress) => heard.push(progress));
    connections[0]?.close();
    expect(heard).toEqual([undefined]);
    expect(connections[0]?.onMessage.listeners.size).toBe(0);
    const refusing = popupPort({
      ...api,
      tabs: {
        ...api.tabs,
        connect: () => {
          throw new Error('No tab with id: 7.');
        },
      },
    });
    refusing.watch(TAB, (progress) => heard.push(progress));
    expect(heard).toEqual([undefined, undefined]);
  });

  it('turns always off: the site leaves the list and gives its permission back', async () => {
    const { api, calls, chrome } = world({ granted: [SITE.pattern] });
    await storePage({ always: [SITE.pattern, 'https://docs.fixture.test/*'], mode: 'pair' });
    expect(await popupPort(api).setAlways(SITE, false)).toEqual(Ok(undefined));
    expect(await storedPage()).toEqual({
      ...defaultPageSettings,
      always: ['https://docs.fixture.test/*'],
      mode: 'pair',
    });
    expect(calls).toEqual(['write page', `remove ${SITE.pattern}`]);
    expect(chrome.granted.has(SITE.pattern)).toBe(false);
  });

  it.each([
    {
      name: 'the llama.cpp host',
      site: { host: 'llm.fixture.test', pattern: 'http://llm.fixture.test/*' },
      llama: 'http://llm.fixture.test:18083',
    },
    {
      name: 'a host of the manifest',
      site: { host: '127.0.0.1', pattern: 'http://127.0.0.1/*' },
      llama: defaultSettings.llamaBaseUrl,
    },
  ])('keeps the permission of $name when always is turned off', async ({ site, llama }) => {
    const { api, calls } = world({ granted: [site.pattern] });
    await fakeBrowser.storage.local.set({
      settings: { ...defaultSettings, llamaBaseUrl: llama },
    });
    await storePage({ always: [site.pattern] });
    expect(await popupPort(api).setAlways(site, false)).toEqual(Ok(undefined));
    expect(await storedPage()).toEqual(defaultPageSettings);
    expect(calls).toEqual(['write page']);
  });

  it('turns never off for the site and the parent domains that exclude it', async () => {
    const { api } = world();
    await storePage({ never: ['fixture.test', 'wiki.fixture.test', 'bank.example'] });
    expect(await popupPort(api).setNever(SITE, false)).toEqual(Ok(undefined));
    expect(await storedPage()).toEqual({ ...defaultPageSettings, never: ['bank.example'] });
  });

  it('turns never on with the host name as the options page writes it', async () => {
    const { api, calls } = world();
    // `https://wiki.fixture.test./` is the same site, written with the root's dot.
    const dotted = { host: 'wiki.fixture.test.', pattern: 'https://wiki.fixture.test./*' };
    await storePage({ never: ['bank.example'] });
    expect(await popupPort(api).setNever(dotted, true)).toEqual(Ok(undefined));
    expect(await storedPage()).toEqual({
      ...defaultPageSettings,
      never: ['bank.example', 'wiki.fixture.test'],
    });
    // It was no always site: no permission to give back.
    expect(calls).toEqual(['write page']);
  });

  it('reads a stored record that is no page settings as the defaults, as the background does', async () => {
    const { api } = world();
    await fakeBrowser.storage.local.set({ page: { v: 0 } });
    const port = popupPort(api);
    expect(await port.settings.load()).toEqual(Ok(defaultPageSettings));
    expect(await port.setMode('pair')).toEqual(Ok(undefined));
    expect(await storedPage()).toEqual({ ...defaultPageSettings, mode: 'pair' });
  });
});

describe('popup', () => {
  it.each([
    {
      name: '訳している',
      progress: { found: 42, done: 12, failed: 0 },
      text: '翻訳済み 12/42 段落 · 画面外は後回し',
    },
    {
      name: '訳し終えた',
      progress: { found: 42, done: 42, failed: 0 },
      text: '翻訳済み 42/42 段落',
    },
    {
      name: '失敗がある',
      progress: { found: 42, done: 40, failed: 2 },
      text: '翻訳済み 40/42 段落 · 2 段落は原文のまま',
    },
    {
      name: '訳しながら失敗もある',
      progress: { found: 42, done: 12, failed: 2 },
      text: '翻訳済み 12/42 段落 · 画面外は後回し · 2 段落は原文のまま',
    },
    {
      name: '段落が多すぎる',
      progress: { found: 10_000, done: 10_000, limit: true },
      text: '段落が多いため、ここから先は翻訳しません',
    },
    {
      name: '接続できない',
      progress: { notice: 'unreachable' },
      text: 'llama.cpp に接続できません。設定を確認してください。',
    },
    {
      name: 'PLaMo がない',
      progress: { notice: 'plamo_missing' },
      text: 'PLaMo が見つからないため、Gemma で翻訳しています',
    },
  ] as const)('popup shows $name', async ({ progress, text }) => {
    const popup = world();
    await openPopup(popup);
    expect(popup.calls).toEqual([`connect ${TAB} ${PROGRESS_PORT} 0`]);
    act(() => popup.connections[0]?.post(progressOf(progress)));
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it.each([
    { name: 'no page script answers', progress: undefined },
    { name: 'the page is not translated', progress: progressOf({ state: 'idle' }) },
    { name: 'the page was restored', progress: progressOf({ state: 'restored', found: 4 }) },
  ])('shows no progress line when $name', async ({ progress }) => {
    const popup = world();
    await openPopup(popup);
    act(() => {
      if (progress === undefined) popup.connections[0]?.close();
      else popup.connections[0]?.post(progress);
    });
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('disables everything on a restricted page', async () => {
    const popup = world({ url: 'chrome://settings/' });
    render(<App port={popupPort(popup.api)} />);
    expect(await screen.findByText('このページは翻訳できません')).toBeTruthy();
    expect(CONTROLS.filter((name) => !control(name).disabled)).toEqual([]);
    // No page script can run there: the popup neither connects nor asks the background.
    expect(popup.calls).toEqual([]);
  });

  it('disables everything once Chrome refuses to let the extension into the page', async () => {
    const popup = world({ url: 'https://chromewebstore.google.com/detail/x' });
    vi.mocked(fakeBrowser.scripting.executeScript).mockImplementationOnce(() => {
      throw new Error('The extensions gallery cannot be scripted.');
    });
    await openPopup(popup);
    await userEvent.click(control('このページを翻訳'));
    expect(await screen.findByText('このページは翻訳できません')).toBeTruthy();
    expect(CONTROLS.filter((name) => !control(name).disabled)).toEqual([]);
  });

  it('translates the tab, then follows the page script it started', async () => {
    const popup = world();
    await openPopup(popup);
    // No page script ran yet: the first port closes at once.
    act(() => popup.connections[0]?.close());
    await userEvent.click(control('このページを翻訳'));
    await waitFor(() => expect(popup.connections).toHaveLength(2));
    expect(popup.calls).toEqual([
      `connect ${TAB} ${PROGRESS_PORT} 0`,
      'send page/start',
      `connect ${TAB} ${PROGRESS_PORT} 0`,
    ]);
    expect(popup.chrome.log).toEqual([`inject ${TAB}`, `send ${TAB} translate`]);
    act(() => popup.connections[1]?.post(progressOf({ found: 5, done: 1 })));
    expect(await screen.findByText('翻訳済み 1/5 段落 · 画面外は後回し')).toBeTruthy();
    // The background had the tab's URL: activeTab lets the popup read it.
    expect(control('このページを翻訳').disabled).toBe(false);
  });

  it('restores the original text of the tab', async () => {
    const popup = world();
    await openPopup(popup);
    await userEvent.click(control('原文に戻す'));
    await waitFor(() => expect(popup.chrome.log).toEqual([`send ${TAB} restore`]));
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it.each([
    { route: 'page/start', button: 'このページを翻訳', text: '翻訳を始められませんでした' },
    { route: 'page/restore', button: '原文に戻す', text: '原文に戻せませんでした' },
  ])('explains a $route the background cannot do', async ({ button, text }) => {
    const popup = world({ answer: () => Err(failure('ipc_failed')) });
    await openPopup(popup);
    await userEvent.click(control(button));
    expect(await screen.findByText(text)).toBeTruthy();
    // The viewer may try once more.
    expect(control(button).disabled).toBe(false);
  });

  it('asks for the site permission before anything else when always is turned on', async () => {
    const popup = world();
    await storePage({ never: [SITE.host] });
    await openPopup(popup);
    expect(toggle('このサイトでは翻訳しない').checked).toBe(true);
    popup.calls.length = 0;
    // Chrome shows its prompt only during the click: the popup tells the background which site
    // it asks for, then asks Chrome, before it awaits anything.
    fireEvent.click(control('このサイトは常に翻訳'));
    expect(popup.calls).toEqual(['send page/always', `request ${SITE.pattern}`]);
    // The viewer refuses: the site is not added, and the switch stays off.
    await act(() => popup.prompts[0]?.answer(false));
    expect(await screen.findByText('このサイトへのアクセスが許可されませんでした')).toBeTruthy();
    expect(toggle('このサイトは常に翻訳').checked).toBe(false);
    expect(await storedPage()).toEqual({ ...defaultPageSettings, never: [SITE.host] });
  });

  it('leaves the always site to the background once Chrome grants it', async () => {
    const popup = world();
    await storePage({ never: [SITE.host, 'bank.example'] });
    await openPopup(popup);
    // The copy says what always does to the never switch.
    expect(
      screen.getByText(/オンにすると「このサイトでは翻訳しない」はオフになります/u),
    ).toBeTruthy();
    popup.calls.length = 0;
    fireEvent.click(control('このサイトは常に翻訳'));
    // Chrome closes the real popup as it shows the prompt; the background hears the grant
    // (permissions.onAdded), adds the site and takes it off the never list.
    await act(() => popup.prompts[0]?.answer(true));
    await waitFor(async () =>
      expect(await storedPage()).toEqual({
        ...defaultPageSettings,
        always: [SITE.pattern],
        never: ['bank.example'],
      }),
    );
    // The popup wrote nothing itself.
    expect(popup.calls).toEqual(['send page/always', `request ${SITE.pattern}`]);
  });

  it('shows always on at once for a site Chrome already grants', async () => {
    // Chrome shows no prompt for a granted site, so the popup stays open and hears the answer.
    const popup = world({ granted: [SITE.pattern] });
    await storePage({ never: [SITE.host] });
    await openPopup(popup);
    await userEvent.click(control('このサイトは常に翻訳'));
    await waitFor(() => expect(toggle('このサイトは常に翻訳').checked).toBe(true));
    expect(toggle('このサイトでは翻訳しない').checked).toBe(false);
    expect(control('このページを翻訳').disabled).toBe(false);
    expect(popup.prompts).toEqual([]);
    expect(await storedPage()).toEqual({ ...defaultPageSettings, always: [SITE.pattern] });
  });

  it('turning never on removes always and disables translating', async () => {
    const popup = world({ granted: [SITE.pattern] });
    await storePage({ always: [SITE.pattern], mode: 'pair' });
    await openPopup(popup);
    expect(toggle('このサイトは常に翻訳').checked).toBe(true);
    await userEvent.click(control('このサイトでは翻訳しない'));
    expect(await screen.findByText('このサイトは翻訳しない設定です')).toBeTruthy();
    expect(toggle('このサイトでは翻訳しない').checked).toBe(true);
    expect(toggle('このサイトは常に翻訳').checked).toBe(false);
    expect(control('このページを翻訳').disabled).toBe(true);
    expect(await storedPage()).toEqual({
      ...defaultPageSettings,
      mode: 'pair',
      never: [SITE.host],
    });
    expect(popup.calls).toContain(`remove ${SITE.pattern}`);
    expect(popup.chrome.granted.has(SITE.pattern)).toBe(false);
  });

  it('turning never off lets the page be translated again', async () => {
    const popup = world();
    await storePage({ never: [SITE.host] });
    render(<App port={popupPort(popup.api)} />);
    expect(await screen.findByText('このサイトは翻訳しない設定です')).toBeTruthy();
    expect(control('このページを翻訳').disabled).toBe(true);
    await userEvent.click(control('このサイトでは翻訳しない'));
    await waitFor(() => expect(control('このページを翻訳').disabled).toBe(false));
    expect(screen.queryByText('このサイトは翻訳しない設定です')).toBeNull();
    expect(await storedPage()).toEqual(defaultPageSettings);
  });

  it('saves the display mode from the segmented control', async () => {
    const popup = world();
    await storePage({ always: [SITE.pattern] });
    await openPopup(popup);
    expect(toggle('置き換え').checked).toBe(true);
    await userEvent.click(control('併記'));
    await waitFor(async () =>
      expect(await storedPage()).toEqual({
        ...defaultPageSettings,
        mode: 'pair',
        always: [SITE.pattern],
      }),
    );
    expect(toggle('併記').checked).toBe(true);
  });

  it('keeps the site switches off for a tab whose URL it may not read', async () => {
    const popup = world({ url: undefined });
    await openPopup(popup);
    expect(control('このサイトは常に翻訳').disabled).toBe(true);
    expect(control('このサイトでは翻訳しない').disabled).toBe(true);
    await userEvent.click(control('このページを翻訳'));
    // The background lets Chrome decide: a tab without the button's grant refuses the script.
    await waitFor(() =>
      expect(popup.chrome.log).toEqual([`inject ${TAB}`, `send ${TAB} translate`]),
    );
  });

  it('opens the options page from its link', async () => {
    const popup = world();
    await openPopup(popup);
    await userEvent.click(screen.getByRole('link', { name: '設定' }));
    expect(popup.calls).toContain('options');
  });
});

/** Opens the popup entrypoint as Chrome does: its document has the root element. */
async function openEntrypoint(): Promise<void> {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.append(root);
  await act(async () => {
    await import('../../src/entrypoints/popup/main.tsx');
  });
}

describe('popup entrypoint', () => {
  it('runs on the extension APIs: the button starts the tab it was pressed on', async () => {
    await fakeBrowser.windows.create({ focused: true });
    await fakeBrowser.tabs.create({ url: 'https://other.fixture.test/' });
    const tab = await fakeBrowser.tabs.create({ url: PAGE, active: true });
    const received: unknown[] = [];
    fakeBrowser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      received.push(message);
      sendResponse(Ok({}));
      return true;
    });
    await openEntrypoint();
    await waitFor(() => expect(control('このページを翻訳').disabled).toBe(false));
    await userEvent.click(control('このページを翻訳'));
    await waitFor(() =>
      expect(received).toEqual([{ type: 'page/start', payload: { tabId: tab.id, url: PAGE } }]),
    );
  });
});
