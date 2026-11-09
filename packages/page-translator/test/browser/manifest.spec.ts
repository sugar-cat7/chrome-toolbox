import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Worker } from '@playwright/test';
import { expect, test, triggerAction } from '@chrome-toolbox/extension-core/testing';
import { PAGE_SCRIPT } from '../../src/control.ts';
import {
  fingerprint,
  NO_SERVER,
  ping,
  servePage,
  startTranslation,
  tabIdOf,
  useServer,
  type WorkerChrome,
} from './page.ts';

// What the extension may touch at install, and how it gets into a page later: only when the
// viewer presses the toolbar button (activeTab), into the tab's top frame.

const extensionPath = path.resolve(
  process.env.STARTER_EXTENSION_PATH ?? path.join(import.meta.dirname, '../../dist/chrome-mv3'),
);
const manifestPath = path.join(extensionPath, 'manifest.json');
const PLAIN = 'https://wiki.fixture.test/plain';
const plainHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Plain fixture</title></head>
  <body>
    <h1>Fixture heading</h1>
    <p>A made-up paragraph about <a href="/next">another page</a> of this fixture.</p>
  </body>
</html>`;

/** Injects the page script as the background does; `'injected'` or Chrome's refusal. */
const inject = (serviceWorker: Worker, tabId: number): Promise<string> =>
  serviceWorker.evaluate(
    ({ tabId, file }) =>
      (globalThis as unknown as { chrome: WorkerChrome }).chrome.scripting
        .executeScript({ target: { tabId, frameIds: [0] }, files: [file] })
        .then(
          () => 'injected',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
    { tabId, file: PAGE_SCRIPT },
  );

test('the manifest asks for no site access at install', async () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  expect(manifest['permissions']).toEqual(
    expect.arrayContaining(['storage', 'activeTab', 'scripting', 'contextMenus']),
  );
  expect(manifest['permissions']).toHaveLength(4);
  expect(manifest['host_permissions']).toEqual(
    expect.arrayContaining(['http://localhost/*', 'http://127.0.0.1/*']),
  );
  expect(manifest['host_permissions']).toHaveLength(2);
  expect(manifest['optional_host_permissions']).toEqual(['http://*/*', 'https://*/*']);
  expect(manifest).not.toHaveProperty('content_scripts');
  expect(manifest).not.toHaveProperty('side_panel');
  expect(manifest).toMatchObject({
    action: { default_popup: 'popup.html' },
    options_ui: { page: 'options.html', open_in_tab: true },
    commands: {
      'translate-selection': {
        suggested_key: { default: 'Alt+Shift+L' },
        description: '選択範囲を翻訳',
      },
    },
  });
});

test.describe('in a browser', () => {
  test.use({ realVisibility: true });
  // These tests are about getting into pages: what a page script asks to translate fails.
  test.beforeEach(async ({ serviceWorker }) => {
    await useServer(serviceWorker, NO_SERVER);
  });

  test('the toolbar action injects the page script, which answers ping', async ({
    context,
    serviceWorker,
  }) => {
    await servePage(context, PLAIN, plainHtml);
    const page = await context.newPage();
    await page.goto(PLAIN);
    // What the page's own scripts could hear: window messages.
    await page.evaluate(() => {
      const heard: unknown[] = [];
      Object.assign(window, { heard });
      window.addEventListener('message', (event) => heard.push(event.data));
    });
    const before = await fingerprint(page);
    // Pressed twice: the second injection finds the first one's claim and leaves the page to it.
    await startTranslation(context, page);
    await startTranslation(context, page);
    expect(await ping(serviceWorker, await tabIdOf(serviceWorker, page))).toEqual({ ready: true });
    // No server answers here: the page is as it was, and the page script told the page nothing
    // (no window message naming the extension or when it started).
    expect(await fingerprint(page)).toBe(before);
    expect(await page.evaluate(() => Reflect.get(window, 'heard'))).toEqual([]);
  });

  test('page/start from an extension page injects the page script and tells it to translate', async ({
    context,
    serviceWorker,
    extensionId,
  }) => {
    await servePage(context, PLAIN, plainHtml);
    const page = await context.newPage();
    await page.goto(PLAIN);
    const tabId = await tabIdOf(serviceWorker, page);
    await triggerAction(context, page);
    // The popup Playwright cannot reach, opened in a tab: it sends what the popup's button sends.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const reply = await popup.evaluate(
      (tabId) =>
        (
          globalThis as unknown as {
            chrome: { runtime: { sendMessage(message: unknown): Promise<unknown> } };
          }
        ).chrome.runtime.sendMessage({ type: 'page/start', payload: { tabId } }),
      tabId,
    );
    expect(reply).toEqual({ ok: true, value: {} });
    expect(await ping(serviceWorker, tabId)).toEqual({ ready: true });
  });

  test('after the extension reloads, a new page script finds no claim from the old one', async ({
    context,
    serviceWorker,
  }) => {
    await servePage(context, PLAIN, plainHtml);
    const page = await context.newPage();
    await page.goto(PLAIN);
    await startTranslation(context, page);
    const tabId = await tabIdOf(serviceWorker, page);
    expect(await ping(serviceWorker, tabId)).toEqual({ ready: true });
    // Loading the same unpacked directory again reloads the extension (same id): the old page
    // script is orphaned, and the tab's activeTab grant is gone.
    const browser = context.browser();
    if (browser === null) throw new Error('the browser is not connected over CDP');
    const session = await browser.newBrowserCDPSession();
    const reloaded = context.waitForEvent('serviceworker');
    await session.send('Extensions.loadUnpacked', { path: extensionPath });
    await session.detach();
    const worker = await reloaded;
    expect(new URL(worker.url()).host).toBe(new URL(serviceWorker.url()).host);
    expect(await ping(worker, tabId)).toContain('Receiving end does not exist');
    // Pressed again: the new copy runs in a fresh isolated world, claims the page and answers.
    await startTranslation(context, page);
    expect(await ping(worker, tabId)).toEqual({ ready: true });
  });

  test('a tab the toolbar button was not pressed on stays closed to the extension', async ({
    context,
    serviceWorker,
  }) => {
    await servePage(context, PLAIN, plainHtml);
    const page = await context.newPage();
    await page.goto(PLAIN);
    const tabId = await tabIdOf(serviceWorker, page);
    // Chrome refuses for want of host access: the extension has none for this site.
    expect(await inject(serviceWorker, tabId)).toContain('Cannot access contents of the page');
    // The same injection into the same tab works once the button was pressed there (activeTab).
    await triggerAction(context, page);
    expect(await inject(serviceWorker, tabId)).toBe('injected');
  });

  test('the popup shows its button when opened in a tab', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByRole('button', { name: 'このページを翻訳' })).toBeVisible();
  });
});
