import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { Ok } from '@chrome-toolbox/contracts';
import {
  ALWAYS_SCRIPT_ID,
  COMMAND_ID,
  createControl,
  MENU_ID,
  PAGE_SCRIPT,
} from '../../src/control.ts';
import { MAX_SELECTION, type PageCommand } from '../../src/protocol.ts';
import { startBackground } from '../../src/runtime.ts';
import { defaultPageSettings, pageSettingsStore, type PageSettings } from '../../src/settings.ts';
import { fakeBackground, fakeChrome } from './chrome.ts';

afterEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

const WIKI = 'https://wiki.fixture.test/*';
const BANK = 'https://bank.fixture.test/*';
const FORUM = 'https://forum.fixture.test/*';
/** A LAN llama.cpp host the options page asked for: no site to translate. */
const LLAMA = 'http://192.168.1.10/*';

const store = () => pageSettingsStore(fakeBrowser.storage.local);
async function savePage(settings: Partial<PageSettings>): Promise<void> {
  expect(await store().save({ ...defaultPageSettings, ...settings })).toMatchObject({ ok: true });
}
async function loadPage(): Promise<PageSettings | undefined> {
  const loaded = await store().load();
  return loaded.ok ? loaded.value : undefined;
}
const toFrame = (tabId: number, payload: PageCommand): unknown[] => [
  tabId,
  { type: 'page/command', payload },
  { frameId: 0 },
];
/** The always script as the background registers it, for `matches`. */
const alwaysScript = (matches: string[]) => ({
  id: ALWAYS_SCRIPT_ID,
  matches,
  js: [PAGE_SCRIPT],
  runAt: 'document_idle',
  allFrames: false,
  persistAcrossSessions: true,
});
/** The options page, an extension page. */
const options: Browser.runtime.MessageSender = {
  url: 'chrome-extension://test-extension-id/options.html',
  origin: 'chrome-extension://test-extension-id',
};
/** The background's message listener, asked as `sender`. */
function background(): {
  ask: (message: unknown, sender: Browser.runtime.MessageSender) => Promise<unknown>;
  stop: () => void;
} {
  const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
  const stop = startBackground();
  const listener = add.mock.calls[0]?.[0];
  return {
    ask: (message, sender) => new Promise((resolve) => listener?.(message, sender, resolve)),
    stop,
  };
}

describe('starting and restoring a page', () => {
  it('refuses to start on an excluded site and injects nothing', async () => {
    await savePage({ never: ['bank.fixture.test'] });
    const chrome = fakeChrome();
    const control = createControl(chrome.api);
    for (const url of ['https://bank.fixture.test/login', 'https://www.bank.fixture.test/'])
      expect(await control.start(3, url)).toMatchObject({
        ok: false,
        error: { internalCode: 'page_excluded' },
      });
    expect(chrome.log).toEqual([]);

    // Another site: the page script goes into the top frame first, then hears the command.
    expect(await control.start(4, 'https://wiki.fixture.test/a')).toEqual(Ok(undefined));
    expect(chrome.log).toEqual(['inject 4', 'send 4 translate']);
    expect(chrome.sent).toEqual([toFrame(4, { action: 'translate' })]);
    // Without a URL the popup could read there is no site to check: Chrome decides (activeTab).
    expect(await control.start(5, undefined)).toEqual(Ok(undefined));
    expect(chrome.log.slice(2)).toEqual(['inject 5', 'send 5 translate']);
  });

  it('reads a stored record that is no page settings as the defaults', async () => {
    await fakeBrowser.storage.local.set({ page: { ...defaultPageSettings, translator: 'other' } });
    const chrome = fakeChrome();
    expect(await createControl(chrome.api).start(3, 'https://bank.fixture.test/')).toEqual(
      Ok(undefined),
    );
    expect(chrome.log).toEqual(['inject 3', 'send 3 translate']);
  });

  it('restores the page, and has nothing to restore where no page script runs', async () => {
    const chrome = fakeChrome();
    const control = createControl(chrome.api);
    expect(await control.restore(3)).toEqual(Ok(undefined));
    // Restoring injects nothing: a page without the script shows no translation.
    expect(chrome.log).toEqual(['send 3 restore']);
    expect(chrome.sent).toEqual([toFrame(3, { action: 'restore' })]);

    chrome.api.tabs.sendMessage = () =>
      Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    expect(await control.restore(4)).toEqual(Ok(undefined));
  });
});

describe('selection', () => {
  it('translates a selection on an excluded site', async () => {
    await savePage({ never: ['bank.fixture.test'] });
    const chrome = fakeChrome();
    expect(await createControl(chrome.api).selection(3, 'rolling backward')).toEqual(Ok(undefined));
    expect(chrome.log).toEqual(['inject 3', 'send 3 selection']);
    expect(chrome.sent).toEqual([toFrame(3, { action: 'selection', text: 'rolling backward' })]);
  });

  it('cuts the menu text to the longest selection without splitting a character', async () => {
    const chrome = fakeChrome();
    const control = createControl(chrome.api);
    expect(await control.selection(3, 'a'.repeat(MAX_SELECTION + 500))).toEqual(Ok(undefined));
    // The emoji takes 2 UTF-16 units across the limit: it goes as a whole, so it is left out.
    expect(await control.selection(3, `${'a'.repeat(MAX_SELECTION - 1)}😀b`)).toEqual(
      Ok(undefined),
    );
    expect(chrome.sent).toEqual([
      toFrame(3, { action: 'selection', text: 'a'.repeat(MAX_SELECTION) }),
      toFrame(3, { action: 'selection', text: 'a'.repeat(MAX_SELECTION - 1) }),
    ]);
  });

  it('reports a page Chrome lets no extension script', async () => {
    const chrome = fakeChrome();
    chrome.api.scripting.executeScript = () =>
      Promise.reject(new Error('Cannot access a chrome:// URL'));
    expect(await createControl(chrome.api).selection(3, 'rolling backward')).toMatchObject({
      ok: false,
      error: { internalCode: 'page_restricted' },
    });
    expect(chrome.sent).toEqual([]);
  });
});

describe('always translated sites', () => {
  it('registers the always script for granted, non-excluded sites only', async () => {
    await savePage({ always: [WIKI, BANK, FORUM], never: ['bank.fixture.test'] });
    // FORUM's permission was never granted (or was withdrawn).
    const chrome = fakeChrome([WIKI, BANK]);
    expect(await createControl(chrome.api).syncAlways()).toEqual(Ok(undefined));
    expect([...chrome.registry.values()]).toEqual([alwaysScript([WIKI])]);
  });

  it('updates the registration when the sites change, and leaves it when they do not', async () => {
    await savePage({ always: [WIKI, FORUM] });
    const chrome = fakeChrome([WIKI]);
    const update = vi.spyOn(chrome.api.scripting, 'updateContentScripts');
    const control = createControl(chrome.api);
    expect(await control.syncAlways()).toEqual(Ok(undefined));
    chrome.granted.add(FORUM);
    expect(await control.syncAlways()).toEqual(Ok(undefined));
    expect([...chrome.registry.values()]).toEqual([alwaysScript([WIKI, FORUM])]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(await control.syncAlways()).toEqual(Ok(undefined));
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('removes the registration when no always site is left', async () => {
    await savePage({ always: [WIKI] });
    const chrome = fakeChrome([WIKI]);
    const control = createControl(chrome.api);
    expect(await control.syncAlways()).toEqual(Ok(undefined));
    expect(chrome.registry.size).toBe(1);
    // The site joined the never list: no site is left.
    await savePage({ always: [WIKI], never: ['fixture.test'] });
    expect(await control.syncAlways()).toEqual(Ok(undefined));
    expect(chrome.registry.size).toBe(0);
    // Nothing registered and nothing to register: nothing to do.
    await savePage({ always: [] });
    expect(await control.syncAlways()).toEqual(Ok(undefined));
    expect(chrome.registry.size).toBe(0);
  });

  it('registers once when several changes ask at the same time', async () => {
    await savePage({ always: [WIKI] });
    const chrome = fakeChrome([WIKI]);
    const register = vi.spyOn(chrome.api.scripting, 'registerContentScripts');
    const control = createControl(chrome.api);
    expect(
      await Promise.all([control.syncAlways(), control.syncAlways(), control.syncAlways()]),
    ).toEqual([Ok(undefined), Ok(undefined), Ok(undefined)]);
    expect(register).toHaveBeenCalledTimes(1);
    expect([...chrome.registry.values()]).toEqual([alwaysScript([WIKI])]);
  });

  it('forgets only the sites whose permission went', async () => {
    await savePage({ always: [WIKI, FORUM], never: ['bank.fixture.test'] });
    const control = createControl(fakeChrome([FORUM]).api);
    expect(await control.forget([WIKI, LLAMA])).toEqual(Ok(undefined));
    expect(await loadPage()).toMatchObject({ always: [FORUM], never: ['bank.fixture.test'] });
  });
});

describe('background wiring', () => {
  it('creates the context menu once on install', async () => {
    const chrome = fakeBackground();
    const stop = startBackground();
    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'install' });
    expect(chrome.menus).toEqual([
      { id: MENU_ID, title: '選択範囲を翻訳', contexts: ['selection'] },
    ]);
    stop();
  });

  it('translates the selection from the context menu and the shortcut, also on an excluded site', async () => {
    await savePage({ never: ['bank.fixture.test'] });
    const chrome = fakeBackground();
    const stop = startBackground();
    const bank = { id: 3, url: 'https://bank.fixture.test/' };
    await chrome.menuClicked.trigger(
      { menuItemId: MENU_ID, selectionText: 'rolling backward' },
      bank,
    );
    await vi.waitFor(() => expect(chrome.log).toEqual(['inject 3', 'send 3 selection']));
    await chrome.command.trigger(COMMAND_ID, bank);
    await vi.waitFor(() => expect(chrome.log).toHaveLength(4));
    expect(chrome.sent).toEqual([
      toFrame(3, { action: 'selection', text: 'rolling backward' }),
      // The shortcut has no text: the page script reads its own selection.
      toFrame(3, { action: 'selection' }),
    ]);
    // Another menu item, another command, or no tab: nothing happens.
    await chrome.menuClicked.trigger({ menuItemId: 'other' }, bank);
    await chrome.command.trigger('other', bank);
    await chrome.command.trigger(COMMAND_ID, undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chrome.log).toHaveLength(4);
    stop();
  });

  it('registers the always sites when the service worker starts and when they change', async () => {
    await savePage({ always: [WIKI] });
    const chrome = fakeBackground([WIKI, FORUM]);
    const stop = startBackground();
    await vi.waitFor(() => expect([...chrome.registry.values()]).toEqual([alwaysScript([WIKI])]));
    await savePage({ always: [WIKI, FORUM] });
    await vi.waitFor(() =>
      expect([...chrome.registry.values()]).toEqual([alwaysScript([WIKI, FORUM])]),
    );
    await savePage({ always: [WIKI, FORUM], never: ['fixture.test'] });
    await vi.waitFor(() => expect(chrome.registry.size).toBe(0));
    stop();
  });

  it('forgets an always site whose permission the user removed', async () => {
    await savePage({ always: [WIKI, FORUM] });
    const chrome = fakeBackground([WIKI, FORUM]);
    const stop = startBackground();
    await vi.waitFor(() =>
      expect([...chrome.registry.values()]).toEqual([alwaysScript([WIKI, FORUM])]),
    );
    chrome.granted.delete(WIKI);
    await chrome.permissionsRemoved.trigger({ origins: [WIKI] });
    await vi.waitFor(async () => expect(await loadPage()).toMatchObject({ always: [FORUM] }));
    await vi.waitFor(() => expect([...chrome.registry.values()]).toEqual([alwaysScript([FORUM])]));
    chrome.granted.delete(FORUM);
    await chrome.permissionsRemoved.trigger({ origins: [FORUM] });
    await vi.waitFor(async () => expect(await loadPage()).toMatchObject({ always: [] }));
    await vi.waitFor(() => expect(chrome.registry.size).toBe(0));
    stop();
  });

  it('adds the site the popup asked for once Chrome grants it, after the popup closed', async () => {
    await savePage({ never: ['wiki.fixture.test', 'bank.fixture.test'] });
    const chrome = fakeBackground();
    const { ask, stop } = background();
    // The popup asks first, then shows Chrome's prompt, which closes the popup (Task 1, Step 0).
    expect(await ask({ type: 'page/always', payload: { pattern: WIKI } }, options)).toEqual(Ok({}));
    expect(await loadPage()).toMatchObject({ always: [] });
    // Another grant, such as a LAN llama.cpp host from the options page, is no site to translate.
    chrome.granted.add(LLAMA);
    await chrome.permissionsAdded.trigger({ origins: [LLAMA] });
    // The viewer allows the site: it joins the always list and leaves the never list.
    chrome.granted.add(WIKI);
    await chrome.permissionsAdded.trigger({ origins: [WIKI] });
    await vi.waitFor(() => expect([...chrome.registry.values()]).toEqual([alwaysScript([WIKI])]));
    expect(await loadPage()).toMatchObject({ always: [WIKI], never: ['bank.fixture.test'] });

    // Once added, the request is done: a later grant of another site adds nothing.
    await savePage({ always: [] });
    chrome.granted.add(FORUM);
    await chrome.permissionsAdded.trigger({ origins: [FORUM, WIKI] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await loadPage()).toMatchObject({ always: [] });
    stop();
  });

  it('adds a site whose permission Chrome already granted at once', async () => {
    const chrome = fakeBackground([WIKI]);
    const { ask, stop } = background();
    expect(await ask({ type: 'page/always', payload: { pattern: WIKI } }, options)).toEqual(Ok({}));
    expect(await loadPage()).toMatchObject({ always: [WIKI] });
    await vi.waitFor(() => expect([...chrome.registry.values()]).toEqual([alwaysScript([WIKI])]));
    stop();
  });

  it.each([
    { name: 'every site', pattern: 'https://*/*' },
    { name: 'subdomains', pattern: 'https://*.fixture.test/*' },
    { name: 'a page', pattern: 'https://wiki.fixture.test/a' },
    { name: 'a browser page', pattern: 'chrome://settings/*' },
  ])('refuses to always translate $name', async ({ pattern }) => {
    const chrome = fakeBackground([pattern]);
    const { ask, stop } = background();
    expect(await ask({ type: 'page/always', payload: { pattern } }, options)).toMatchObject({
      ok: false,
      error: { internalCode: 'input_invalid' },
    });
    await chrome.permissionsAdded.trigger({ origins: [pattern] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await loadPage()).toMatchObject({ always: [] });
    expect(chrome.registry.size).toBe(0);
    stop();
  });

  it('removes its event listeners on cleanup', () => {
    fakeBackground();
    const stop = startBackground();
    const events = [
      fakeBrowser.runtime.onInstalled,
      fakeBrowser.contextMenus.onClicked,
      fakeBrowser.commands.onCommand,
      fakeBrowser.permissions.onAdded,
      fakeBrowser.permissions.onRemoved,
    ];
    for (const event of events) expect(event.hasListeners()).toBe(true);
    stop();
    for (const event of events) expect(event.hasListeners()).toBe(false);
  });
});
