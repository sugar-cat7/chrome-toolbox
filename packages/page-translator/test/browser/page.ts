// Helpers for the page translator's browser tests: made-up pages served at made-up hosts, the
// toolbar button that lets the extension into a tab, and a fingerprint of what a page shows.
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { triggerAction } from '@chrome-toolbox/extension-core/testing';
import { PAGE_SCRIPT } from '../../src/control.ts';

/** The extension APIs the tests call in the service worker, as Chrome exposes them there. */
export type WorkerChrome = {
  tabs: {
    query(info: { active: boolean; lastFocusedWindow: boolean }): Promise<{ id?: number }[]>;
    sendMessage(tabId: number, message: unknown, options: { frameId: number }): Promise<unknown>;
  };
  scripting: {
    executeScript(injection: {
      target: { tabId: number; frameIds: number[] };
      files: string[];
    }): Promise<unknown>;
  };
};

/**
 * Answers requests for `url` (origin and path; any query) with `html`, as the made-up site
 * would. The host is a `*.fixture.test` name, which no network resolves: nothing leaves the test.
 */
export async function servePage(context: BrowserContext, url: string, html: string): Promise<void> {
  const served = new URL(url);
  if (!served.hostname.endsWith('.fixture.test'))
    throw new Error(`a served page needs a *.fixture.test host: ${url}`);
  await context.route(
    (requested) => requested.origin === served.origin && requested.pathname === served.pathname,
    (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }),
  );
}

/** The extension's service worker in `context`. */
async function serviceWorkerOf(context: BrowserContext): Promise<Worker> {
  const own = (worker: Worker): boolean => worker.url().startsWith('chrome-extension://');
  return (
    context.serviceWorkers().find(own) ??
    (await context.waitForEvent('serviceworker', { predicate: own }))
  );
}

/** The id of the tab that shows `page`: it is brought to the front and asked for as the active tab. */
export async function tabIdOf(serviceWorker: Worker, page: Page): Promise<number> {
  await page.bringToFront();
  const tabId = await serviceWorker.evaluate(async () => {
    const { chrome } = globalThis as unknown as { chrome: WorkerChrome };
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id;
  });
  if (tabId === undefined) throw new Error(`no active tab shows ${page.url()}`);
  return tabId;
}

/** The page script's answer to `ping` in the tab's top frame, or the reason there is none. */
export const ping = (serviceWorker: Worker, tabId: number): Promise<unknown> =>
  serviceWorker.evaluate(
    (tabId) =>
      (globalThis as unknown as { chrome: WorkerChrome }).chrome.tabs
        .sendMessage(tabId, { type: 'page/command', payload: { action: 'ping' } }, { frameId: 0 })
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error))),
    tabId,
  );

/**
 * Starts translating `page` as the popup's "このページを翻訳" does. The toolbar button is pressed
 * (CDP `Extensions.triggerAction`), which grants `activeTab`; Playwright does not attach to the
 * popup it opens (adoption: Page translator foundation), so the service worker then does what
 * the background's `page/start` does: inject the page script into the top frame and send it the
 * translate command.
 */
export async function startTranslation(context: BrowserContext, page: Page): Promise<void> {
  await triggerAction(context, page);
  const serviceWorker = await serviceWorkerOf(context);
  const tabId = await tabIdOf(serviceWorker, page);
  await serviceWorker.evaluate(
    async ({ tabId, file }) => {
      const { chrome } = globalThis as unknown as { chrome: WorkerChrome };
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [file] });
      await chrome.tabs.sendMessage(
        tabId,
        { type: 'page/command', payload: { action: 'translate' } },
        { frameId: 0 },
      );
    },
    { tabId, file: PAGE_SCRIPT },
  );
}

/**
 * What the page shows, one line per node in document order: the body and the open shadow roots
 * in it, each node's type, name, attributes (sorted) and text, indented by depth. Two equal
 * fingerprints mean the same nodes in the same places with the same content.
 */
export function fingerprint(page: Page): Promise<string> {
  return page.evaluate(() => {
    const lines: string[] = [];
    const visit = (node: Node, depth: number): void => {
      const attributes =
        node instanceof Element
          ? [...node.attributes]
              .map(({ name, value }) => `${name}=${JSON.stringify(value)}`)
              .sort()
              .join(' ')
          : '';
      const text = node instanceof CharacterData ? JSON.stringify(node.data) : '';
      lines.push(`${'  '.repeat(depth)}${node.nodeType} ${node.nodeName} ${attributes} ${text}`);
      // `shadowRoot` is null for a closed shadow root: only open ones are walked.
      if (node instanceof Element && node.shadowRoot !== null) visit(node.shadowRoot, depth + 1);
      for (const child of node.childNodes) visit(child, depth + 1);
    };
    visit(document.body, 0);
    return lines.join('\n');
  });
}
