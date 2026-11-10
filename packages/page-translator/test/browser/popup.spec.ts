import type { BrowserContext, Page } from '@playwright/test';
import {
  expect,
  STUB_PAGE_PREFIX,
  test,
  triggerAction,
} from '@chrome-toolbox/extension-core/testing';
import { LONG_COUNT, LONG_HEIGHT, LONG_URL, longHtml } from './fixtures/long.ts';
import { fingerprint, servePage, tabIdOf, usePageSettings, useServer } from './page.ts';

// The popup against a tab, as the viewer uses it: the toolbar button grants `activeTab`, then
// 「このページを翻訳」 asks the background (`page/start`), the progress comes over the popup's port
// while it is open, and 「原文に戻す」 restores the page. Playwright does not attach to the popup the
// button opens (Step 0: B), so the same popup page is opened in a window of its own beside the
// tab, which stays visible; the one thing it is told is the tab it was opened for, which the real
// popup reads as the active tab of its window.

test.use({ realVisibility: true });

/**
 * Opens the extension's popup page in a new window, answering its active-tab query with `tab`
 * (the window's own active tab is the popup page itself).
 */
async function openPopup(
  context: BrowserContext,
  extensionId: string,
  tab: Readonly<{ id: number; url: string }>,
): Promise<Page> {
  const browser = context.browser();
  if (browser === null) throw new Error('the browser is not connected over CDP');
  const session = await browser.newBrowserCDPSession();
  const opened = context.waitForEvent('page');
  await session.send('Target.createTarget', { url: 'about:blank', newWindow: true });
  await session.detach();
  const popup = await opened;
  await popup.addInitScript((active) => {
    const { chrome } = globalThis as unknown as {
      chrome: { tabs: { query(info: { active?: boolean; currentWindow?: boolean }): unknown } };
    };
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (info) =>
      info.active === true && info.currentWindow === true ? Promise.resolve([active]) : query(info);
  }, tab);
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return popup;
}

test('the popup translates, restores and shows progress', async ({
  context,
  serviceWorker,
  extensionId,
  llama,
}) => {
  await useServer(serviceWorker, llama.origin);
  // The stub serves no PLaMo: Gemma keeps the progress line to the count alone (no plamo_missing).
  await usePageSettings(serviceWorker, { translator: 'gemma' });
  await servePage(context, LONG_URL, longHtml());
  const page = await context.newPage();
  await page.goto(LONG_URL);
  const before = await fingerprint(page);
  // The toolbar button, pressed on the tab.
  await triggerAction(context, page);
  const tabId = await tabIdOf(serviceWorker, page);
  const popup = await openPopup(context, extensionId, { id: tabId, url: LONG_URL });
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');

  await popup.getByRole('button', { name: 'このページを翻訳' }).click();
  // The paragraphs near the viewport are translated; the rest of the page waits.
  const near = await page.evaluate(
    ({ count, height }) =>
      Array.from({ length: count }, (_, i) => i).filter(
        (i) => i * height < window.innerHeight * 1.5 && (i + 1) * height > -window.innerHeight / 2,
      ).length,
    { count: LONG_COUNT, height: LONG_HEIGHT },
  );
  await expect(popup.locator('output')).toHaveText(
    `翻訳済み ${near}/${LONG_COUNT} 段落 · 画面外は後回し`,
  );
  await expect(page.locator('#p1')).toHaveText(new RegExp(`^${STUB_PAGE_PREFIX}Harbor log 1:`));

  await popup.getByRole('button', { name: '原文に戻す' }).click();
  // The count goes with the translation.
  await expect(popup.locator('output')).toHaveText('');
  await expect.poll(() => fingerprint(page)).toBe(before);
});
