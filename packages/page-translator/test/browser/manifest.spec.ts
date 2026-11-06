import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@chrome-toolbox/extension-core/testing';
import { PAGE_SCRIPT } from '../../src/control.ts';
import { fingerprint, servePage, startTranslation, tabIdOf, type WorkerChrome } from './page.ts';

// What the extension may touch at install, and how it gets into a page later: only when the
// viewer presses the toolbar button (activeTab), into the tab's top frame.

const manifestPath = path.resolve(
  process.env.STARTER_EXTENSION_PATH ?? path.join(import.meta.dirname, '../../dist/chrome-mv3'),
  'manifest.json',
);
const PLAIN = 'https://wiki.fixture.test/plain';
const plainHtml = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Plain fixture</title></head>
  <body>
    <h1>Fixture heading</h1>
    <p>A made-up paragraph about <a href="/next">another page</a> of this fixture.</p>
  </body>
</html>`;

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

  test('the toolbar action injects the page script, which answers ping', async ({
    context,
    serviceWorker,
  }) => {
    await servePage(context, PLAIN, plainHtml);
    const page = await context.newPage();
    await page.goto(PLAIN);
    const before = await fingerprint(page);
    // Pressed twice: the second injection finds the first one's claim and leaves the page to it.
    await startTranslation(context, page);
    await startTranslation(context, page);
    const tabId = await tabIdOf(serviceWorker, page);
    const answer = await serviceWorker.evaluate(
      (tabId) =>
        (globalThis as unknown as { chrome: WorkerChrome }).chrome.tabs.sendMessage(
          tabId,
          { type: 'page/command', payload: { action: 'ping' } },
          { frameId: 0 },
        ),
      tabId,
    );
    expect(answer).toEqual({ ready: true });
    // The page script of this task only answers: the page is as it was.
    expect(await fingerprint(page)).toBe(before);
  });

  test('a tab the toolbar button was not pressed on stays closed to the extension', async ({
    context,
    serviceWorker,
  }) => {
    await servePage(context, PLAIN, plainHtml);
    const page = await context.newPage();
    await page.goto(PLAIN);
    const tabId = await tabIdOf(serviceWorker, page);
    const injected = await serviceWorker.evaluate(
      ({ tabId, file }) =>
        (globalThis as unknown as { chrome: WorkerChrome }).chrome.scripting
          .executeScript({ target: { tabId, frameIds: [0] }, files: [file] })
          .then(
            () => 'injected',
            () => 'refused',
          ),
      { tabId, file: PAGE_SCRIPT },
    );
    expect(injected).toBe('refused');
  });

  test('the popup shows its button when opened in a tab', async ({ context, extensionId }) => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.getByRole('button', { name: 'このページを翻訳' })).toBeVisible();
  });
});
