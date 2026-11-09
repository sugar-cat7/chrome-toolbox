import type { Page, Worker } from '@playwright/test';
import { expect, test } from '@chrome-toolbox/extension-core/testing';
import { ALWAYS_SCRIPT_ID } from '../../src/control.ts';
import { defaultPageSettings, type PageSettings } from '../../src/settings.ts';
import { NO_SERVER, ping, servePage, tabIdOf, useServer } from './page.ts';

// The background's control in Chrome: the always registration and the never list. Chrome's
// permission prompt cannot be answered from a test, so the always site is 127.0.0.1, which the
// manifest grants at install; a site granted at run time is covered by the unit tests only.

const LOCAL_SITE = 'http://127.0.0.1/*';
const LOCAL = 'http://127.0.0.1/always-fixture';
const PLAIN = 'https://wiki.fixture.test/plain';
const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Control fixture</title></head>
  <body><p>A made-up paragraph for the control fixture.</p></body>
</html>`;

/** What the tests call in the service worker and in an extension page. */
type Chrome = {
  storage: { local: { set(items: Record<string, unknown>): Promise<void> } };
  scripting: {
    getRegisteredContentScripts(filter: { ids: string[] }): Promise<{ matches?: string[] }[]>;
  };
  runtime: { sendMessage(message: unknown): Promise<unknown> };
};

/** Saves the page settings in extension storage, as the options page does. */
const savePage = (serviceWorker: Worker, settings: Partial<PageSettings>): Promise<void> =>
  serviceWorker.evaluate(
    (page) => (globalThis as unknown as { chrome: Chrome }).chrome.storage.local.set({ page }),
    { ...defaultPageSettings, ...settings },
  );
/** The sites the always registration matches, or `null` without one. */
const registered = (serviceWorker: Worker): Promise<string[] | null> =>
  serviceWorker.evaluate(async (id) => {
    const { chrome } = globalThis as unknown as { chrome: Chrome };
    const [script] = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    return script?.matches ?? null;
  }, ALWAYS_SCRIPT_ID);
/** The popup opened in a tab (Playwright does not attach to the real one), to ask the background. */
async function popupOf(
  page: Page,
  extensionId: string,
): Promise<(message: unknown) => Promise<unknown>> {
  const popup = await page.context().newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return (message) =>
    popup.evaluate(
      (message) =>
        (globalThis as unknown as { chrome: Chrome }).chrome.runtime.sendMessage(message),
      message,
    );
}

test.describe('in a browser', () => {
  test.use({ realVisibility: true });
  // These tests are about getting into pages: what a page script asks to translate fails.
  test.beforeEach(async ({ serviceWorker }) => {
    await useServer(serviceWorker, NO_SERVER);
  });

  test('an always site gets the page script on its next load until it is excluded', async ({
    context,
    serviceWorker,
    extensionId,
  }) => {
    await context.route(LOCAL, (route) =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }),
    );
    const page = await context.newPage();
    await page.goto(LOCAL);
    // The popup asks for the site; Chrome already grants it, so it is added at once.
    const ask = await popupOf(page, extensionId);
    expect(await ask({ type: 'page/always', payload: { pattern: LOCAL_SITE } })).toEqual({
      ok: true,
      value: {},
    });
    await expect.poll(() => registered(serviceWorker)).toEqual([LOCAL_SITE]);

    // No button pressed and nothing injected: the registration runs the script on the next load.
    const tabId = await tabIdOf(serviceWorker, page);
    expect(await ping(serviceWorker, tabId)).toContain('Receiving end does not exist');
    await page.reload();
    await expect.poll(() => ping(serviceWorker, tabId)).toEqual({ ready: true });

    // On the never list, the registration goes, and the next load runs no script.
    await savePage(serviceWorker, { always: [LOCAL_SITE], never: ['127.0.0.1'] });
    await expect.poll(() => registered(serviceWorker)).toBeNull();
    await page.reload();
    expect(await ping(serviceWorker, tabId)).toContain('Receiving end does not exist');
  });

  test('page/start refuses an excluded site and leaves it alone', async ({
    context,
    serviceWorker,
    extensionId,
  }) => {
    await servePage(context, PLAIN, html);
    await savePage(serviceWorker, { never: ['fixture.test'] });
    const page = await context.newPage();
    await page.goto(PLAIN);
    const tabId = await tabIdOf(serviceWorker, page);
    const ask = await popupOf(page, extensionId);
    expect(await ask({ type: 'page/start', payload: { tabId, url: PLAIN } })).toMatchObject({
      ok: false,
      error: { internalCode: 'page_excluded' },
    });
    expect(await ping(serviceWorker, tabId)).toContain('Receiving end does not exist');
  });
});
