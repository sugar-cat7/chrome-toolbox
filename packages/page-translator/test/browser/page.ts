// Helpers for the page translator's browser tests: made-up pages served at made-up hosts, the
// toolbar button that lets the extension into a tab, the settings, the stub's record of the
// batches, the page script's progress, and a fingerprint of what a page shows.
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { defaultSettings } from '@chrome-toolbox/extension-core';
import {
  defaultResponder,
  expect,
  triggerAction,
  type LlamaStub,
  type LongTasks,
} from '@chrome-toolbox/extension-core/testing';
import { PAGE_SCRIPT } from '../../src/control.ts';
import {
  PROGRESS_PORT,
  progressSchema,
  type PageCommand,
  type Progress,
} from '../../src/protocol.ts';
import { defaultPageSettings, type PageSettings } from '../../src/settings.ts';

/** The extension APIs the tests call in the service worker, as Chrome exposes them there. */
export type WorkerChrome = {
  tabs: {
    query(info: { active: boolean; lastFocusedWindow: boolean }): Promise<{ id?: number }[]>;
    sendMessage(tabId: number, message: unknown, options: { frameId: number }): Promise<unknown>;
    connect(
      tabId: number,
      info: { name: string; frameId: number },
    ): {
      onMessage: { addListener(listener: (message: unknown) => void): void };
      onDisconnect: { addListener(listener: () => void): void };
      disconnect(): void;
    };
  };
  runtime: { lastError?: { message?: string } };
  scripting: {
    executeScript(injection: {
      target: { tabId: number; frameIds: number[] };
      files: string[];
    }): Promise<unknown>;
  };
  storage: { local: { set(items: Record<string, unknown>): Promise<void> } };
};

/** The unpacked build the browser loads. */
export const EXTENSION_PATH = path.resolve(
  process.env.STARTER_EXTENSION_PATH ?? path.join(import.meta.dirname, '../../dist/chrome-mv3'),
);

/** A llama.cpp address where nothing listens (the discard port). */
export const NO_SERVER = 'http://127.0.0.1:9';

/**
 * Points the extension at the llama.cpp server at `origin`, as the options page does. A page
 * script told to translate asks the background, which would otherwise reach whatever listens on
 * the default address (a real server on a developer's machine).
 */
export const useServer = (serviceWorker: Worker, origin: string): Promise<void> =>
  serviceWorker.evaluate(
    (settings) =>
      (globalThis as unknown as { chrome: WorkerChrome }).chrome.storage.local.set({ settings }),
    { ...defaultSettings, llamaBaseUrl: origin },
  );

/**
 * Saves the page settings (the defaults with `settings` over them), as the options page and the
 * popup do: a page script already running hears the change at once.
 */
export const usePageSettings = (
  serviceWorker: Worker,
  settings: Partial<PageSettings>,
): Promise<void> =>
  serviceWorker.evaluate(
    (page) =>
      (globalThis as unknown as { chrome: WorkerChrome }).chrome.storage.local.set({ page }),
    { ...defaultPageSettings, ...settings },
  );

/** One page batch the stub was asked for: each unit's text (with its markers), model and slot. */
export type AskedBatch = Readonly<{
  texts: readonly string[];
  model: string | undefined;
  slot: number | undefined;
}>;
/**
 * What `recordBatches` keeps: every batch in the order asked, and the most chat completions the
 * stub held at once.
 */
export type Batches = { asked: AskedBatch[]; mostAtOnce: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
/** The units' texts of a batch user turn: its JSON lines (`{"id":1,"text":…}`). */
function unitTexts(user: string): string[] {
  return user
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line): unknown => JSON.parse(line))
    .flatMap((unit) => (isRecord(unit) && typeof unit.text === 'string' ? [unit.text] : []));
}

/**
 * Makes the stub answer as llama.cpp does (`defaultResponder`) after `delayMs`, recording every
 * page batch and the most chat completions it held at once.
 */
export function recordBatches(llama: LlamaStub, delayMs = 0): Batches {
  const batches: Batches = { asked: [], mostAtOnce: 0 };
  let atOnce = 0;
  llama.respond = async (request) => {
    const { chat } = request;
    if (request.path !== '/v1/chat/completions' || chat === undefined)
      return defaultResponder(request);
    const user = chat.messages.find((message) => message.role === 'user')?.content ?? '';
    batches.asked.push({ texts: unitTexts(user), model: chat.model, slot: chat.id_slot });
    atOnce += 1;
    batches.mostAtOnce = Math.max(batches.mostAtOnce, atOnce);
    try {
      if (delayMs > 0) await sleep(delayMs);
      return defaultResponder(request);
    } finally {
      atOnce -= 1;
    }
  };
  return batches;
}

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

/**
 * Loads the unpacked directory again, which reloads the extension (same id): the page scripts
 * already in pages are orphaned, and the tabs' activeTab grants are gone. The new service worker.
 */
export async function reloadExtension(context: BrowserContext): Promise<Worker> {
  const browser = context.browser();
  if (browser === null) throw new Error('the browser is not connected over CDP');
  const session = await browser.newBrowserCDPSession();
  const reloaded = context.waitForEvent('serviceworker');
  await session.send('Extensions.loadUnpacked', { path: EXTENSION_PATH });
  await session.detach();
  return reloaded;
}

/**
 * Checks that the frame's long-task observer is live: a task of the page's own over 50 ms shows
 * up in it.
 */
export async function observerLive(page: Page, longTasks: LongTasks): Promise<void> {
  const seen = (await longTasks(page)).filter((duration) => duration > 50).length;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          const begin = performance.now();
          while (performance.now() - begin < 80);
          resolve();
        }, 0);
      }),
  );
  await expect
    .poll(async () => (await longTasks(page)).filter((duration) => duration > 50).length)
    .toBe(seen + 1);
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

/** Sends the page script in the tab's top frame `command`, as the background does. */
export const tell = (
  serviceWorker: Worker,
  tabId: number,
  command: PageCommand,
): Promise<unknown> =>
  serviceWorker.evaluate(
    ({ tabId, command }) =>
      (globalThis as unknown as { chrome: WorkerChrome }).chrome.tabs.sendMessage(
        tabId,
        { type: 'page/command', payload: command },
        { frameId: 0 },
      ),
    { tabId, command },
  );

/**
 * The page script's progress, as the popup's port first hears it. A tab where no page script
 * takes the port (none injected, or an orphaned one) fails at once with Chrome's reason, rather
 * than waiting for the test's timeout.
 */
export async function progressOf(serviceWorker: Worker, tabId: number): Promise<Progress> {
  const heard = await serviceWorker.evaluate(
    ({ tabId, name }) =>
      new Promise<unknown>((resolve, reject) => {
        const { chrome } = globalThis as unknown as { chrome: WorkerChrome };
        const port = chrome.tabs.connect(tabId, { name, frameId: 0 });
        port.onMessage.addListener((message) => {
          port.disconnect();
          resolve(message);
        });
        // Not called after this side's own `disconnect`, only when the page's end went first.
        port.onDisconnect.addListener(() => {
          const reason = chrome.runtime.lastError?.message ?? 'the page script closed the port';
          reject(new Error(`no progress from tab ${tabId} on ${name}: ${reason}`));
        });
      }),
    { tabId, name: PROGRESS_PORT },
  );
  return progressSchema.parse(heard);
}

/**
 * Waits until the tab's page script has settled every paragraph it found (translated or failed,
 * none waiting or asked for): on a page whose paragraphs are all near the viewport, the whole
 * page. Returns that progress.
 */
export async function untilTranslated(serviceWorker: Worker, tabId: number): Promise<Progress> {
  let last: Progress | undefined;
  await expect
    .poll(
      async () => {
        last = await progressOf(serviceWorker, tabId);
        return (
          last.state === 'on' &&
          last.found > 0 &&
          last.waiting === 0 &&
          last.done + last.failed === last.found
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  if (last === undefined) throw new Error('no progress was read');
  return last;
}

/**
 * Presses the toolbar button on `page` and injects the page script into its top frame, as the
 * background does before it sends a command; nothing is translated yet. Returns the tab's id.
 */
export async function injectPageScript(context: BrowserContext, page: Page): Promise<number> {
  await triggerAction(context, page);
  const serviceWorker = await serviceWorkerOf(context);
  const tabId = await tabIdOf(serviceWorker, page);
  await serviceWorker.evaluate(
    async ({ tabId, file }) => {
      const { chrome } = globalThis as unknown as { chrome: WorkerChrome };
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [file] });
    },
    { tabId, file: PAGE_SCRIPT },
  );
  return tabId;
}

/**
 * Starts translating `page` as the popup's "このページを翻訳" does. The toolbar button is pressed
 * (CDP `Extensions.triggerAction`), which grants `activeTab`; Playwright does not attach to the
 * popup it opens (adoption: Page translator foundation), so the service worker then does what
 * the background's `page/start` does: inject the page script into the top frame and send it the
 * translate command. Returns the tab's id.
 */
export async function startTranslation(context: BrowserContext, page: Page): Promise<number> {
  const tabId = await injectPageScript(context, page);
  await tell(await serviceWorkerOf(context), tabId, { action: 'translate' });
  return tabId;
}

/**
 * What the page shows, one line per node in document order: the whole document (the head, the
 * body and what follows it, such as `<pt-overlay>`) and the open shadow roots in it, each node's
 * type, name, attributes (sorted) and text, indented by depth. Two equal fingerprints mean the
 * same nodes in the same places with the same content.
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
    visit(document.documentElement, 0);
    return lines.join('\n');
  });
}
